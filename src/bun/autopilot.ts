/**
 * Milestone Autopilot: work a GitHub milestone to done without being driven.
 *
 * The user's milestone-manager Codex thread (src/bun/codex-thread.ts) decides
 * WHAT: asked which open issues should start next, it answers with up to N
 * issues plus a scope clarification for each (acceptance criteria, in/out of
 * scope, risks). Agetor does the rest: creates and starts a pipeline card per
 * issue (the scope goes into the card's prompt and onto the issue), keeps up
 * to `maxInFlight` cards going, signs finished cards off into Ready to Merge
 * (the merge queue lands them) — except PRs that change sensitive product
 * code (src/shared/risky-paths.ts), which wait in In Review for the user —
 * and, when
 * the milestone has no open issues and nothing in flight, asks the thread for
 * a deep audit. Issues the audit files into the milestone restart the loop;
 * a clean audit ends it.
 *
 * Tracker mode (`roadmap` in the config, src/shared/roadmap.ts): the order
 * comes from a tracker issue's numbered step table instead of the thread. A
 * step starts when its issue is open and every predecessor step's issue is
 * closed as completed; the thread is never asked. With a `milestone` too,
 * only the steps whose issue is in that GitHub milestone are worked, and
 * each of them gets a card in the Backlog up front, started when its step
 * is ready and a slot is free. Without one, the whole roadmap is worked.
 * See `roadmapPass`.
 *
 * Config: `autopilot` preference. State: `autopilot_state` preference.
 */
import type { Task, TaskPrStatus } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { run } from "./github.ts";
import { askThread, taggedJson, type ThreadAnswer } from "./codex-thread.ts";
import { createTaskFromIssue } from "./issue-queue.ts";
import { setMergeQueued } from "./merge-intent.ts";
import { describeRiskyFiles, parseRiskyRules, riskyFiles, RISKY_PATHS_PREF, type RiskyRules } from "../shared/risky-paths.ts";
import { hasConfirmedNoPr, prStatusForTask } from "./pr-watch.ts";
import { onCardRemoved, startTask, subscribeGlobal } from "./orchestrator.ts";
import { holdsAutopilotSlot, neverStarted, PROGRESSING_COLUMNS, waitingOnQuota } from "../shared/autopilot.ts";
import { formatRetryTime, isQuotaPaused } from "./usage-limit.ts";
import { loadRoadmapStates, loadRoadmapTracker } from "./roadmap-fetch.ts";
import {
  parseRoadmap,
  pickRoadmap,
  prIssueMention,
  prIssueMentionLine,
  roadmapFinished,
  roadmapScope,
  roadmapStatus,
  roadmapStepPrompt,
  scopeDrift,
  summarizeRoadmap,
  withRoadmapStepPrompt,
  type PrIssueMentionKind,
  type RoadmapIssueState,
  type RoadmapNeedsUser,
  type RoadmapStatus,
  type RoadmapStepView,
} from "../shared/roadmap.ts";

export const AUTOPILOT_PREF = "autopilot";
export const AUTOPILOT_STATE_PREF = "autopilot_state";
/** The tracker issue the dialog and `agetor roadmap start` offer when none
 *  is configured: the last one saved. */
export const DEFAULT_TRACKER_PREF = "autopilot_default_tracker";
/** Set once the stored config has been read by a build where `milestone`
 *  limits tracker mode (see `normalizeLegacyConfig`). */
const CONFIG_VERSION_PREF = "autopilot_config_version";
/** Cards of Autopilot's whose sign-off the user withdrew (dragged out of
 *  Ready to Merge): a JSON array of card ids. Autopilot never signs such a
 *  card off again. Its own preference, not part of the state, because it is
 *  written from the task PATCH while a pass may hold the state. */
export const HANDS_OFF_PREF = "autopilot_hands_off";
/** Safety net only — passes are driven by board events (startAutopilot). */
const FALLBACK_MS = 15 * 60_000;
/** Columns of a card still being built (Blocked included): such a card
 *  keeps its issue busy, but holds a slot only while it's actually
 *  progressing — see `holdsAutopilotSlot` (src/shared/autopilot.ts). In
 *  Review / Ready to Merge / Done don't. */
export const BUILDING = new Set<Task["column"]>(["backlog", "ready", "running", "blocked"]);
const QUIET_MS = 20 * 60_000;
/** Retry sooner when the thread is just open in Codex Desktop. */
const BUSY_MS = 5 * 60_000;

export interface AutopilotConfig {
  enabled: boolean;
  threadId: string;
  project: string;
  milestone: { number: number; title: string } | null;
  maxInFlight: number;
  pipelineId: string | null;
  /** Tracker mode: the tracker issue (in `project`'s repo) whose step table
   *  gives the order. When set, `threadId` isn't used and `milestone` limits
   *  which steps are worked (null = the whole roadmap). */
  roadmap: { issue: number } | null;
}

export interface AutopilotState {
  phase: "idle" | "running" | "auditing" | "done";
  cards: string[];
  /** Cards left in In Review for the user because their PR changes
   *  sensitive code. */
  held: string[];
  /** Why each held card is held, and for which PR head and rules: a hold is
   *  decided again when the head or the rules change. A card in `held`
   *  without an entry (held by a build before this) is decided again too. */
  holds: Record<string, CardHold>;
  /** Cards whose PR file list couldn't be read (card id → PR number): not
   *  signed off yet, said once, tried again every pass. */
  unread: Record<string, number>;
  audits: number;
  lastAnswer: { at: number; kind: "next" | "audit"; text: string } | null;
  lastError: string | null;
  /** Don't ask the thread again before this unless the board changed. */
  quietUntil: number;
  /** What the board looked like at the last unproductive ask. */
  quietSignature: string;
  /** The thread's Codex account is at its usage limit: don't ask before this
   *  (the parsed reset, or a backoff), whatever the board does. */
  limitedUntil: number;
  /** Issues whose card ended with nothing to build, waiting for the thread's
   *  decision (close / wait / rework). Kept out of the candidates until it
   *  answers; `retryAt` backs the ask off after a busy thread or a malformed
   *  answer. Keyed by issue number. */
  noWork: Record<string, NoWorkPending>;
  /** Issues that wait for other issues to close before Autopilot starts a
   *  card for them again (an empty list: held until you act). */
  waits: Record<string, number[]>;
  /** Issues that already got one rework card — never a second. */
  reworked: number[];
  /** Roadmap mode: the status as of the last pass. */
  roadmap: RoadmapStatus | null;
  /** Roadmap mode: issues whose Autopilot card already finished while the
   *  issue stayed open. Never started again by Autopilot; cleared when the
   *  issue closes. Keyed by issue number. */
  roadmapStuck: Record<string, RoadmapStuck>;
  /** Roadmap mode: steps the owner asked to be done again after a card
   *  finished without closing the issue. The finished cards named here no
   *  longer set off the restart guard; the next card for the step is told
   *  about the earlier PR. Keyed by issue number; goes when the issue closes. */
  roadmapRedo: Record<string, RoadmapRedo>;
  /** Roadmap mode: `[Human]` step issues already announced as ready. */
  notifiedHuman: number[];
  /** Tracker mode with a milestone: the cards made up front in the Backlog
   *  and not started yet — issue number → card id. Such a card holds no slot
   *  and doesn't make its issue busy. An entry goes when its card starts, is
   *  closed, archived or deleted. Kept across milestone changes, so cards
   *  left over from another milestone stay known (and untouched). */
  roadmapBacklog: Record<string, string>;
  updatedAt: number;
}

export interface CardHold {
  pr: number;
  url: string | null;
  headSha: string | null;
  /** `RiskyRules.signature` the hold was decided under. */
  rules: string;
  /** The first few sensitive files, and how many there are. */
  files: string[];
  count: number;
}

export interface RoadmapStuck {
  cardId: string;
  reason: string;
  at: number;
  step?: string;
  /** merged — its PR merged; done — its card is Done without a merged PR;
   *  no-work — its run ended with no commits and no PR. */
  kind?: "merged" | "done" | "no-work";
  pr?: number | null;
  prUrl?: string | null;
  /** The merged PR's description was read (once). */
  bodyRead?: boolean;
  mention?: PrIssueMentionKind;
  /** The PR's words about the issue: untrusted display text. */
  excerpt?: string | null;
  /** `prIssueMentionLine`: the sentence shown to the owner. */
  detail?: string | null;
}

export interface RoadmapRedo {
  /** Finished cards the restart guard ignores from now on. */
  cardIds: string[];
  pr: number | null;
  prUrl: string | null;
  excerpt: string | null;
  at: number;
}

export interface NoWorkPending {
  cardId: string;
  title: string;
  /** The card's final handoff, as sent to the thread. */
  handoff: string;
  retryAt: number;
}

export function parseConfig(raw: string | null | undefined): AutopilotConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const m = o.milestone as { number?: unknown; title?: unknown } | null | undefined;
  const r = o.roadmap as { issue?: unknown } | null | undefined;
  return {
    enabled: o.enabled === true,
    threadId: typeof o.threadId === "string" ? o.threadId : "",
    project: typeof o.project === "string" ? o.project : "",
    milestone: m && typeof m.number === "number" && typeof m.title === "string" ? { number: m.number, title: m.title } : null,
    maxInFlight: typeof o.maxInFlight === "number" && o.maxInFlight >= 1 ? Math.min(10, Math.floor(o.maxInFlight)) : 5,
    pipelineId: typeof o.pipelineId === "string" && o.pipelineId ? o.pipelineId : null,
    roadmap: typeof r?.issue === "number" && Number.isInteger(r.issue) && r.issue > 0 ? { issue: r.issue } : null,
  };
}

export function readState(): AutopilotState {
  try {
    const v = JSON.parse(preferences.get(AUTOPILOT_STATE_PREF) ?? "{}") as Partial<AutopilotState>;
    return {
      phase: v.phase ?? "idle",
      cards: Array.isArray(v.cards) ? v.cards : [],
      held: Array.isArray(v.held) ? v.held : [],
      holds: v.holds && typeof v.holds === "object" ? v.holds : {},
      unread: v.unread && typeof v.unread === "object" ? v.unread : {},
      audits: typeof v.audits === "number" ? v.audits : 0,
      lastAnswer: v.lastAnswer ?? null,
      lastError: v.lastError ?? null,
      quietUntil: v.quietUntil ?? 0,
      quietSignature: v.quietSignature ?? "",
      limitedUntil: typeof v.limitedUntil === "number" ? v.limitedUntil : 0,
      noWork: v.noWork && typeof v.noWork === "object" ? v.noWork : {},
      waits: v.waits && typeof v.waits === "object" ? v.waits : {},
      reworked: Array.isArray(v.reworked) ? v.reworked : [],
      roadmap: v.roadmap && typeof v.roadmap === "object" ? v.roadmap : null,
      roadmapStuck: v.roadmapStuck && typeof v.roadmapStuck === "object" ? v.roadmapStuck : {},
      roadmapRedo: v.roadmapRedo && typeof v.roadmapRedo === "object" ? v.roadmapRedo : {},
      notifiedHuman: Array.isArray(v.notifiedHuman) ? v.notifiedHuman : [],
      roadmapBacklog: v.roadmapBacklog && typeof v.roadmapBacklog === "object" ? v.roadmapBacklog : {},
      updatedAt: v.updatedAt ?? 0,
    };
  } catch {
    return { phase: "idle", cards: [], held: [], holds: {}, unread: {}, audits: 0, lastAnswer: null, lastError: null, quietUntil: 0, quietSignature: "", limitedUntil: 0, noWork: {}, waits: {}, reworked: [], roadmap: null, roadmapStuck: {}, roadmapRedo: {}, notifiedHuman: [], roadmapBacklog: {}, updatedAt: 0 };
  }
}

function writeState(s: AutopilotState): void {
  preferences.set(AUTOPILOT_STATE_PREF, JSON.stringify({ ...s, updatedAt: Date.now() }));
}

/** Bumped whenever `PUT /autopilot` begins a fresh run (and resets the
 *  state). A pass that started before then is working an older run. */
let runEpoch = 0;
/** The epoch and project of the pass at work. */
let passRun: { epoch: number; project: string } | null = null;

/** The run was changed, or paused, while this pass was at work: it should
 *  stop making and starting cards. */
function passOutdated(): boolean {
  if (!passRun) return false;
  return passRun.epoch !== runEpoch || !parseConfig(preferences.get(AUTOPILOT_PREF)).enabled;
}

/**
 * Save a pass's state. If a fresh run began meanwhile, its reset state
 * stands (phase, status, errors) and only what the pass did to cards is
 * carried over — a pass that outlived its run must not mark the new one
 * "done" or bring the old status back.
 */
function savePassState(state: AutopilotState): void {
  if (!passRun || passRun.epoch === runEpoch) return writeState(state);
  const fresh = readState();
  const sameProject = parseConfig(preferences.get(AUTOPILOT_PREF)).project === passRun.project;
  writeState({ ...fresh, cards: state.cards, roadmapBacklog: sameProject ? state.roadmapBacklog : fresh.roadmapBacklog });
}

/** Issue number from a card's issue URL. */
function issueOf(t: Task): number | null {
  const m = t.issueUrl?.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

const trimDir = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const sameDir = (a: string | null | undefined, b: string) => !!a && trimDir(a) === trimDir(b);

/** The never-started backlog cards Autopilot made in tracker mode, by issue. */
function unstartedBacklog(state: AutopilotState, all: Task[]): Map<number, Task> {
  const out = new Map<number, Task>();
  for (const [key, id] of Object.entries(state.roadmapBacklog)) {
    const t = all.find((x) => x.id === id);
    if (t && neverStarted(t)) out.set(Number(key), t);
  }
  return out;
}

/** Live = not archived and not Done. */
const live = (t: Task) => t.archivedAt == null && t.column !== "done";

export interface NextPick {
  number: number;
  scope: string;
}

/** Keep only picks that are open, not already being worked, unique, and within
 *  the free slots. Pure; exported for tests. */
export function acceptPicks(picks: unknown, open: Set<number>, busy: Set<number>, free: number): NextPick[] {
  if (!Array.isArray(picks)) return [];
  const out: NextPick[] = [];
  for (const p of picks) {
    const n = Number((p as { number?: unknown })?.number);
    const scope = String((p as { scope?: unknown })?.scope ?? "").trim();
    if (!Number.isInteger(n) || !open.has(n) || busy.has(n) || out.some((x) => x.number === n)) continue;
    out.push({ number: n, scope });
    if (out.length >= free) break;
  }
  return out;
}

export function nextPrompt(milestone: string, candidates: { number: number; title: string }[], inFlight: { number: number; title: string }[], free: number): string {
  const list = (xs: { number: number; title: string }[]) => (xs.length ? xs.map((x) => `- #${x.number} ${x.title}`).join("\n") : "- (none)");
  return [
    `[Agetor Autopilot] Milestone "${milestone}".`,
    "",
    "Open issues nobody is working on yet:",
    list(candidates),
    "",
    "Being worked on right now (each by its own agent, on its own branch):",
    list(inFlight),
    "",
    `Pick ${free} issue(s) to start now, in the order they should go — fewer only when an issue truly can't start yet (it depends on unfinished work, would edit the same files as work in progress, or needs a product decision from the user); name each one you hold back and why. Prefer what unblocks other work.`,
    "For each pick, clarify its scope for the implementing agent: acceptance criteria, what is in and out of scope, risks, likely files, and how to verify. Don't change any code or GitHub state for this request.",
    "",
    'End your reply with exactly one block: <next-issues>[{"number": 123, "scope": "markdown"}]</next-issues> — an empty list if nothing should start now.',
  ].join("\n");
}

export function auditPrompt(milestone: string): string {
  return [
    `[Agetor Autopilot] Every issue in milestone "${milestone}" is closed and its work merged into develop.`,
    "",
    "Do a deep audit. Don't take the issues being resolved at face value: rescan the code on the latest origin/develop, confirm each issue in this milestone is really resolved, check our tests correctly cover the scenarios, and look for new issues we introduced.",
    `For every real problem you find, file a GitHub issue in milestone "${milestone}" (gh issue create --milestone ...) with evidence and acceptance criteria. Don't fix anything yourself.`,
    "",
    'End your reply with exactly one block: <audit>{"clean": true|false, "filed": [issue numbers], "summary": "markdown"}</audit>',
  ].join("\n");
}

/** Issues labelled this start only once they're the last open issue(s) in
 *  the milestone, e.g. a launch-candidate qualification pass. */
export const RUN_LAST_LABEL = "run-last";

/** Which open issues may start now: `run-last` ones only when nothing else
 *  is open. Pure; exported for tests. */
export function startable<T extends { labels?: { name: string }[] }>(open: T[]): T[] {
  const last = (i: T) => (i.labels ?? []).some((l) => l.name === RUN_LAST_LABEL);
  const rest = open.filter((i) => !last(i));
  return rest.length > 0 ? rest : open;
}

async function milestoneIssues(cfg: AutopilotConfig): Promise<{ number: number; title: string; labels?: { name: string }[] }[] | null> {
  const r = await run(
    ["gh", "issue", "list", "--milestone", cfg.milestone!.title, "--state", "open", "--limit", "300", "--json", "number,title,labels"],
    cfg.project,
    60_000,
    process.env,
  );
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout || "[]") as { number: number; title: string; labels?: { name: string }[] }[];
  } catch {
    return null;
  }
}

// ── Sign-off ─────────────────────────────────────────────────────────────

/** The cards whose sign-off the user withdrew. */
export function readHandsOff(): string[] {
  try {
    const v = JSON.parse(preferences.get(HANDS_OFF_PREF) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The user dragged a card out of Ready to Merge (the task PATCH withdrew its
 * sign-off). If it is one of Autopilot's, it is theirs from here on:
 * Autopilot doesn't sign it off again, whatever its PR looks like later.
 */
export function noteSignOffWithdrawn(taskId: string): void {
  if (!readState().cards.includes(taskId)) return;
  const cur = readHandsOff();
  if (!cur.includes(taskId)) preferences.set(HANDS_OFF_PREF, JSON.stringify([...cur, taskId].slice(-500)));
}

export interface SignOffDeps {
  prStatus(taskId: string): TaskPrStatus | null;
  /** Every file the PR changes; null when the list couldn't be read. */
  prFiles(t: Task, pr: number): Promise<string[] | null>;
  rules(): RiskyRules;
  handsOff(): ReadonlySet<string>;
  /** Move the card to Ready to Merge. */
  signOff(t: Task): void;
  activity(taskId: string, text: string, tone: "info" | "warning" | "muted"): void;
}

/**
 * Sign Autopilot's finished cards off: each one in In Review with a finished
 * run and an open PR goes to Ready to Merge — unless its PR changes
 * sensitive code (src/shared/risky-paths.ts), which holds it in In Review
 * for the user and says which files.
 *
 * - A hold is decided again when the PR's head or the rules change (and once
 *   for a card held by an older build, which recorded neither): a hold that
 *   no longer applies is released and the card signed off.
 * - A file list that can't be read is not "risky": the card stays where it
 *   is for this pass, with one note, and is looked at again on the next.
 * - A card the user took back from Ready to Merge is never signed off again,
 *   and one they moved out of In Review is no longer held.
 *
 * Mutates `state`. Exported for tests.
 */
export async function signOffPass(state: AutopilotState, mine: Task[], deps: SignOffDeps): Promise<void> {
  const rules = deps.rules();
  const handsOff = deps.handsOff();
  const ids = new Set(mine.map((t) => t.id));
  const release = (id: string) => {
    state.held = state.held.filter((x) => x !== id);
    delete state.holds[id];
  };
  for (const id of [...state.held, ...Object.keys(state.holds)]) if (!ids.has(id)) release(id);
  for (const id of Object.keys(state.unread)) if (!ids.has(id)) delete state.unread[id];

  for (const t of mine) {
    const wasHeld = state.held.includes(t.id);
    // Signed off or finished by the user: no longer waiting in In Review.
    if (wasHeld && (t.column === "merge" || t.column === "done")) release(t.id);
    if (t.column !== "review" || t.pipelineRun?.status !== "done" || handsOff.has(t.id)) continue;
    const pr = deps.prStatus(t.id);
    if (pr?.state !== "open") continue;
    const hold = state.holds[t.id];
    if (wasHeld && hold && hold.pr === pr.number && hold.headSha != null && hold.headSha === pr.headSha && hold.rules === rules.signature) continue;

    const files = await deps.prFiles(t, pr.number);
    if (files == null) {
      // Unknown isn't risky. A card already held stays held until its files
      // can be read; any other waits a pass, and says so once.
      if (!wasHeld && state.unread[t.id] !== pr.number) {
        state.unread[t.id] = pr.number;
        deps.activity(t.id, `Autopilot: couldn't read which files PR #${pr.number} changes — not signed off yet, checking again on the next pass`, "muted");
      }
      continue;
    }
    delete state.unread[t.id];
    const risky = riskyFiles(files, rules);
    if (risky.length > 0) {
      const next: CardHold = { pr: pr.number, url: pr.url ?? null, headSha: pr.headSha ?? null, rules: rules.signature, files: risky.slice(0, 5), count: risky.length };
      const changed = !wasHeld || !hold || hold.count !== next.count || hold.files.join("\n") !== next.files.join("\n");
      if (!wasHeld) state.held.push(t.id);
      state.holds[t.id] = next;
      if (changed) deps.activity(t.id, `Autopilot: PR #${pr.number} changes sensitive code (${describeRiskyFiles(risky)}) — left in In Review for you to sign off`, "warning");
      continue;
    }
    if (wasHeld) {
      release(t.id);
      deps.activity(t.id, `Autopilot: PR #${pr.number} changes no sensitive code under the current rules — the hold is lifted`, "info");
    }
    deps.signOff(t);
    deps.activity(t.id, `Autopilot: signed off PR #${pr.number} for merging`, "info");
  }
}

const SIGN_OFF_DEPS: SignOffDeps = {
  prStatus: (id) => prStatusForTask(id),
  async prFiles(t, pr) {
    // Every page: `gh pr view --json files` stops at 100 files.
    const r = await run(["gh", "api", "--paginate", `repos/{owner}/{repo}/pulls/${pr}/files?per_page=100`, "-q", ".[].filename"], t.workdir, 60_000, process.env);
    if (!r.ok) return null;
    const files = (r.stdout ?? "").split("\n").map((p) => p.trim()).filter(Boolean);
    return files.length > 0 ? files : null;
  },
  rules: () => parseRiskyRules(preferences.get(RISKY_PATHS_PREF)),
  handsOff: () => new Set(readHandsOff()),
  signOff(t) {
    setMergeQueued(t.id, true);
    tasks.update(t.id, { column: "merge" });
  },
  activity: (taskId, text, tone) => recordActivity(taskId, { kind: "auto", text, tone }),
};

/** A card whose live step session is paused mid-turn on a claude usage
 *  limit ("continuing automatically at …"). */
function quotaPausedCard(t: Pick<Task, "pipelineRun">): boolean {
  return !!t.pipelineRun?.active.some((a) => isQuotaPaused(a.taskId));
}

export interface SlotCounts {
  /** Issues with a live card (any column but Done) — never started twice. */
  busyIssues: Set<number>;
  /** Open milestone issues whose card holds a slot. */
  inFlight: { number: number; title: string }[];
  /** Autopilot's own cards that hold a slot. */
  ownLive: number;
  ownUnfinished: number;
  /** Some card is waiting for a usage limit to reset. */
  quotaWait: boolean;
}

/** What holds a slot right now. A card holds one only while it's progressing
 *  (`holdsAutopilotSlot`): stopped, blocked, waiting on the user or on a
 *  usage-limit reset, it doesn't — but its issue stays busy, so a second card
 *  is never started for it. Pure; exported for tests. */
export function slotCounts<T extends { number: number; title: string }>(
  all: Task[],
  mine: Task[],
  open: T[],
  quotaPaused: (t: Pick<Task, "pipelineRun">) => boolean = () => false,
  opts: {
    /** Count only cards of this project: issue numbers mean nothing across
     *  repositories. */
    project?: string;
    /** Cards that hold no slot whatever their column (the never-started
     *  backlog cards of tracker mode). */
    noSlot?: ReadonlySet<string>;
    /** Cards that don't make their issue busy either. */
    notBusy?: ReadonlySet<string>;
  } = {},
): SlotCounts {
  const cards = all.filter((t) => !t.pipelineParentId && t.archivedAt == null && (!opts.project || sameDir(t.workdir, opts.project)));
  const busyIssues = new Set(cards.filter((t) => live(t) && !opts.notBusy?.has(t.id)).map(issueOf).filter((n): n is number => n != null));
  const holding = cards.filter((t) => !opts.noSlot?.has(t.id) && holdsAutopilotSlot(t, quotaPaused));
  const holdingIssues = new Set(holding.map(issueOf).filter((n): n is number => n != null));
  return {
    busyIssues,
    inFlight: open.filter((i) => holdingIssues.has(i.number)),
    ownLive: mine.filter((t) => holdsAutopilotSlot(t, quotaPaused)).length,
    ownUnfinished: mine.filter(live).length,
    quotaWait: cards.some((t) => BUILDING.has(t.column) && (waitingOnQuota(t.pipelineRun) || quotaPaused(t))),
  };
}

/** The thread answered with a usage limit: wait for the reset quietly — a
 *  note in `lastError` once, no re-ask every pass. */
function waitForThreadLimit(state: AutopilotState, until: number): void {
  state.limitedUntil = until;
  state.lastError = `Codex usage limit reached — Autopilot asks again at ${formatRetryTime(until)}`;
}

// ── Cards that end with nothing to build ─────────────────────────────────
// A PR that merged with "Refs #N" leaves issue N open (some acceptance is
// owned elsewhere). Autopilot picks it again, Understand finds nothing to
// build and ends the run with no commits and no PR — and the loop repeats
// (#405, #407). Such a card is closed and the milestone thread decides what
// happens to the issue.

export type NoWorkDecision =
  | { action: "close"; comment: string }
  | { action: "wait"; blockedBy: number[] }
  | { action: "rework"; scope: string };

/** The thread's `<no-work>` answer, or null when it's malformed. A close must
 *  name the owning issues/PRs (`#123`). Pure; exported for tests. */
export function parseNoWorkDecision(text: string): NoWorkDecision | null {
  const v = taggedJson<Record<string, unknown>>(text, "no-work");
  if (!v || typeof v !== "object") return null;
  if (v.action === "close" && typeof v.comment === "string" && /#\d+/.test(v.comment)) return { action: "close", comment: v.comment.trim() };
  if (v.action === "wait" && Array.isArray(v.blockedBy)) {
    const blockedBy = v.blockedBy.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return blockedBy.length ? { action: "wait", blockedBy } : null;
  }
  if (v.action === "rework" && typeof v.scope === "string" && v.scope.trim()) return { action: "rework", scope: v.scope.trim() };
  return null;
}

/** The card's final handoff — summary, reason, open questions. Pure. */
export function finalHandoffText(t: Task): string {
  const h = [...(t.pipelineRun?.history ?? [])].reverse().find((r) => r.handoff)?.handoff;
  if (!h) return "(the card left no handoff)";
  return [
    `Summary: ${h.summary || "(none)"}`,
    `Reason: ${h.reason || "(none)"}`,
    `Open questions: ${h.openQuestions.length ? h.openQuestions.map((q) => `\n- ${q}`).join("") : "(none)"}`,
  ].join("\n");
}

export function noWorkPrompt(milestone: string, issue: { number: number; title: string }, handoff: string, reworked: boolean): string {
  return [
    `[Agetor Autopilot] Milestone "${milestone}": the card for #${issue.number} ${issue.title} found nothing to build. Its pipeline ended with no commits beyond its base and no PR, yet the issue is still open — usually because a PR merged with "Refs #${issue.number}" while some acceptance is owned elsewhere.`,
    "",
    "The card's final handoff:",
    handoff,
    "",
    "Decide what happens to the issue. Don't change any code or GitHub state for this request.",
    `- close: every remaining acceptance item is owned by other named issues or PRs, or is out of this milestone. Agetor closes the issue with your comment, which must name the owning issues and PRs (#123).`,
    "- wait: real work remains in this issue, but only after the named open issues close. Agetor won't start it before then.",
    reworked
      ? `- (rework isn't available: #${issue.number} already had a rework card that also found nothing.)`
      : "- rework: the card missed real work in this issue. Give the scope for one new card.",
    "",
    'End your reply with exactly one block: <no-work>{"action": "close", "comment": "markdown"}</no-work>, <no-work>{"action": "wait", "blockedBy": [123]}</no-work>' +
      (reworked ? "." : ', or <no-work>{"action": "rework", "scope": "markdown"}</no-work>.'),
  ].join("\n");
}

export interface NoWorkDeps {
  /** Commits on the card's branch beyond its base; null when unknown. */
  aheadCount(t: Task): Promise<number | null>;
  /** The card has no PR (the PR watcher looked and found none). */
  hasNoPr(t: Task): boolean;
  ask(prompt: string, cwd: string, threadId: string): Promise<ThreadAnswer>;
  gh(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr?: string }>;
  startCard(input: { dir: string; number: number; scope: string }): Promise<{ task: Task } | { error: string }>;
  moveToDone(t: Task): void;
  activity(taskId: string, text: string, tone: "info" | "warning" | "muted"): void;
  now(): number;
}

/** An Autopilot card whose run is done, with no PR and no commits beyond its
 *  base — the same `git rev-list --count base..HEAD` check pr-watch.ts
 *  `maybeOpenMissingPr` makes before opening a missing PR. */
export async function isNoWorkCard(t: Task, deps: Pick<NoWorkDeps, "aheadCount" | "hasNoPr">): Promise<boolean> {
  if (t.archivedAt != null || t.column === "done" || t.column === "merge" || t.pipelineRun?.status !== "done") return false;
  if (t.prUrl || !deps.hasNoPr(t)) return false;
  return (await deps.aheadCount(t)) === 0;
}

/**
 * Detect no-work cards (close them, queue their issue for a decision), ask
 * the thread about each queued issue, apply the answers, and release waits
 * whose blockers have closed. Returns the issues to keep out of the
 * candidates. Mutates `state`. Exported for tests.
 */
export async function processNoWork(
  cfg: AutopilotConfig,
  state: AutopilotState,
  mine: Task[],
  open: { number: number; title: string }[],
  deps: NoWorkDeps,
): Promise<Set<number>> {
  const title = (n: number) => open.find((i) => i.number === n)?.title ?? `#${n}`;
  for (const t of mine) {
    const n = issueOf(t);
    if (n == null || !(await isNoWorkCard(t, deps))) continue;
    deps.moveToDone(t);
    deps.activity(t.id, "Autopilot: nothing to build — no commits and no PR. Closed the card and asked the milestone thread what to do with the issue", "info");
    state.noWork[String(n)] = { cardId: t.id, title: t.title, handoff: finalHandoffText(t), retryAt: 0 };
  }

  for (const [key, p] of Object.entries(state.noWork)) {
    const n = Number(key);
    if (!open.some((i) => i.number === n)) {
      delete state.noWork[key]; // closed meanwhile
      continue;
    }
    if (p.retryAt > deps.now() || deps.now() < state.limitedUntil) continue;
    const reworked = state.reworked.includes(n);
    const a = await deps.ask(noWorkPrompt(cfg.milestone!.title, { number: n, title: title(n) }, p.handoff, reworked), cfg.project, cfg.threadId);
    if (!a.ok) {
      if (a.limitedUntil) {
        waitForThreadLimit(state, a.limitedUntil);
        break;
      }
      p.retryAt = deps.now() + (a.busy ? BUSY_MS : QUIET_MS);
      state.lastError = a.busy ? a.error! : `#${n} (nothing to build): ${a.error}`;
      continue;
    }
    state.lastAnswer = { at: deps.now(), kind: "next", text: a.text.slice(-6000) };
    let d = parseNoWorkDecision(a.text);
    if (!d) {
      p.retryAt = deps.now() + QUIET_MS;
      state.lastError = `#${n}: the thread's answer had no valid <no-work> block — asking again later`;
      continue;
    }
    if (d.action === "rework" && reworked) {
      deps.activity(p.cardId, `Autopilot: #${n} already had a rework card that found nothing — not starting another. It waits for you`, "warning");
      d = { action: "wait", blockedBy: [] };
    }
    if (d.action === "close") {
      const r = await deps.gh(["issue", "close", String(n), "--comment", d.comment], cfg.project);
      if (!r.ok) {
        p.retryAt = deps.now() + QUIET_MS;
        state.lastError = `#${n}: couldn't close the issue: ${(r.stderr ?? r.stdout).slice(-300)}`;
        continue;
      }
      deps.activity(p.cardId, `Autopilot: closed #${n} on the milestone thread's word — ${d.comment.slice(0, 300)}`, "info");
    } else if (d.action === "wait") {
      state.waits[key] = d.blockedBy;
      if (d.blockedBy.length) deps.activity(p.cardId, `Autopilot: #${n} waits until ${d.blockedBy.map((b) => `#${b}`).join(", ")} close`, "info");
    } else {
      const r = await deps.startCard({ dir: cfg.project, number: n, scope: d.scope });
      if ("error" in r) {
        p.retryAt = deps.now() + QUIET_MS;
        state.lastError = `#${n}: couldn't start the rework card: ${r.error}`;
        continue;
      }
      state.reworked.push(n);
      state.cards.push(r.task.id);
      deps.activity(r.task.id, `Autopilot started this as a rework of #${n}: the last card found nothing to build, and the milestone thread says it missed real work`, "info");
    }
    delete state.noWork[key];
    state.lastError = null;
  }

  // Release waits whose blockers have all closed (an empty list holds).
  const openSet = new Set(open.map((i) => i.number));
  for (const [key, blockers] of Object.entries(state.waits)) {
    if (!openSet.has(Number(key))) {
      delete state.waits[key];
      continue;
    }
    if (!blockers.length) continue;
    let allClosed = true;
    for (const b of blockers) {
      if (openSet.has(b)) {
        allClosed = false;
        break;
      }
      const r = await deps.gh(["issue", "view", String(b), "--json", "state", "-q", ".state"], cfg.project);
      if (!r.ok || r.stdout.trim().toUpperCase() !== "CLOSED") {
        allClosed = false;
        break;
      }
    }
    if (allClosed) delete state.waits[key];
  }

  return new Set([...Object.keys(state.noWork), ...Object.keys(state.waits)].map(Number));
}

const NO_WORK_DEPS: NoWorkDeps = {
  async aheadCount(t) {
    if (!t.worktreePath || !t.baseRef) return null;
    const r = await run(["git", "rev-list", "--count", `${t.baseRef}..HEAD`], t.worktreePath, 30_000, process.env);
    const n = Number(r.stdout?.trim());
    return r.ok && Number.isInteger(n) ? n : null;
  },
  hasNoPr: (t) => hasConfirmedNoPr(t.id) && prStatusForTask(t.id) == null,
  ask: (prompt, cwd, threadId) => askThread({ threadId, cwd, prompt }),
  gh: (args, cwd) => run(["gh", ...args], cwd, 60_000, process.env),
  async startCard({ dir, number, scope }) {
    const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
    const pipelineId = cfg.pipelineId ?? preferences.get("default_pipeline") ?? null;
    if (!pipelineId) return { error: "no pipeline to run issues with (set default_pipeline)" };
    const r = await createTaskFromIssue({ dir, number, pipelineId, extraPrompt: `## Rework scope from the milestone manager\n\n${scope}`, allowAfterDone: true });
    return "error" in r ? { error: r.error } : { task: r.task };
  },
  moveToDone: (t) => void tasks.update(t.id, { column: "done" }),
  activity: (taskId, text, tone) => recordActivity(taskId, { kind: "auto", text, tone }),
  now: () => Date.now(),
};

// ── Roadmap mode ─────────────────────────────────────────────────────────

/** A card that just reached Done may still be having its issue closed (the
 *  PR watcher does that when the PR merges): give it this long before
 *  calling the issue stuck. */
const SETTLE_MS = 3 * 60_000;
/** GitHub changes no board event reports (the owner closing a `[Human]`
 *  step) are picked up by polling. */
const ROADMAP_POLL_MS = 5 * 60_000;

/** How many backlog cards one pass makes at most (each reads its issue
 *  thread from GitHub); the next pass makes the rest. */
const BACKLOG_PER_PASS = 60;

export interface RoadmapDeps {
  loadTracker(project: string, issue: number): Promise<{ body: string; url: string | null } | { error: string }>;
  loadStates(project: string, numbers: number[]): Promise<Map<number, RoadmapIssueState> | { error: string }>;
  aheadCount: NoWorkDeps["aheadCount"];
  hasNoPr: NoWorkDeps["hasNoPr"];
  /** The card's merged PR, if it has one. */
  mergedPr(t: Task): number | null;
  /** A PR's description; null when it couldn't be read. */
  prBody(t: Task, pr: number): Promise<string | null>;
  /** Cards whose sign-off the user withdrew. */
  handsOff(): ReadonlySet<string>;
  quotaPaused(t: Pick<Task, "pipelineRun">): boolean;
  pipelineId(cfg: AutopilotConfig): string | null;
  /** Create a card for the issue and start it. */
  startCard(input: { dir: string; number: number; pipelineId: string; extraPrompt: string }): Promise<{ task: Task } | { error: string }>;
  /** Create a card for the issue in the Backlog, not started. */
  createBacklogCard(input: { dir: string; number: number; pipelineId: string; extraPrompt: string }): Promise<{ task: Task } | { error: string }>;
  /** Start a backlog card made earlier, with its step section rewritten. */
  startExisting(input: { task: Task; stepPrompt: string }): Promise<{ ok: true } | { error: string }>;
  moveToDone(t: Task): void;
  /** Persist the state mid-pass (after each card made or started, so a core
   *  that stops half way still knows its cards). */
  save(state: AutopilotState): void;
  /** The run was changed or paused while this pass was at work: make and
   *  start nothing more. */
  outdated(): boolean;
  /** A native notification; false when there's no host to show it. */
  notify(n: { title: string; body: string }): boolean;
  activity(taskId: string, text: string, tone: "info" | "warning" | "muted"): void;
  /** Ask for another pass in `delayMs`. */
  recheck(delayMs: number): void;
  now(): number;
}

const isOpenStep = (v: RoadmapStepView) => v.status !== "complete" && v.status !== "declined";

/** "a.ts, b.ts and 4 more" from a hold (which keeps the first few names). */
function holdFilesText(hold: CardHold, max = 3): string {
  const shown = hold.files.slice(0, max).join(", ");
  return hold.count > max ? `${shown} and ${hold.count - max} more` : shown;
}

/**
 * One tracker pass: read the tracker and every step's issue; with a
 * milestone, keep to the steps whose issue is in it and make a Backlog card
 * for each open one that has none; start the ready agent steps that fit the
 * free slots (the step's backlog card when it has one, else a new card);
 * announce newly ready `[Human]` steps; record the status. Never asks the
 * thread. Mutates `state`. Exported for tests.
 */
export async function roadmapPass(cfg: AutopilotConfig, state: AutopilotState, all: Task[], mine: Task[], deps: RoadmapDeps): Promise<void> {
  const tracker = cfg.roadmap!.issue;
  const milestone = cfg.milestone;
  const fail = (error: string) => {
    state.lastError = error;
  };
  const doc = await deps.loadTracker(cfg.project, tracker);
  if ("error" in doc) return fail(doc.error);
  const parsed = parseRoadmap(doc.body);
  if (parsed.error) {
    // Nothing starts from a roadmap that can't be read.
    state.roadmap = summarizeRoadmap({ issue: tracker, url: doc.url, parsed, views: [], busy: new Set(), needsUser: new Map(), now: deps.now() });
    return fail(`roadmap #${tracker}: ${parsed.error}`);
  }
  const states = await deps.loadStates(cfg.project, parsed.steps.map((s) => s.issue));
  if ("error" in states) return fail(states.error);
  const views = roadmapStatus(parsed, states);
  // The scope: steps whose issue is in the chosen GitHub milestone. Steps
  // outside it still gate readiness; this run just never starts them.
  const scope = milestone ? { milestone, steps: roadmapScope(parsed.steps, states, milestone) } : null;
  const scoped = scope ? views.filter((v) => scope.steps.has(v.step)) : views;
  const viewByIssue = new Map(views.map((v) => [v.issue, v]));
  const openSteps = views.filter(isOpenStep);
  const openByIssue = new Map(openSteps.map((v) => [v.issue, v]));

  // The backlog ledger: cards made up front that haven't started. One that a
  // person started is an ordinary card from then on (an agent step's is
  // followed like any card Autopilot started; the owner's is theirs alone).
  // One whose issue closed before it started is closed too.
  const own = [...mine];
  const closedNow = new Set<string>();
  const backlog = new Map<number, Task>();
  for (const [key, id] of Object.entries(state.roadmapBacklog)) {
    const n = Number(key);
    const t = all.find((x) => x.id === id);
    const v = viewByIssue.get(n);
    if (!t || t.archivedAt != null || t.column === "done") {
      delete state.roadmapBacklog[key];
    } else if (!neverStarted(t)) {
      delete state.roadmapBacklog[key];
      if (v && !v.human && !state.cards.includes(id)) {
        state.cards.push(id);
        own.push(t);
        deps.activity(id, `Autopilot: step ${v.step} was started by hand — following it from here`, "muted");
      }
    } else if (v && !isOpenStep(v)) {
      deps.moveToDone(t);
      deps.activity(id, `Autopilot: #${n} was closed (${v.status === "complete" ? "completed" : "not planned"}) before this card started — moved it to Done`, "info");
      closedNow.add(id);
      delete state.roadmapBacklog[key];
    } else {
      backlog.set(n, t);
    }
  }

  // Restart guard: an Autopilot card for a step already finished, yet the
  // step's issue is still open (the PR said "Refs", closing failed, or the
  // run found nothing to build). Starting another card would loop, so the
  // step waits for the user instead.
  const settling = new Set<number>();
  for (const key of Object.keys(state.roadmapRedo)) {
    if (!openByIssue.has(Number(key))) delete state.roadmapRedo[key]; // closed since
  }
  for (const t of own) {
    const n = issueOf(t);
    if (n == null || !openByIssue.has(n)) continue;
    // The owner asked for this step to be done again: its finished card no
    // longer stands in the way.
    if (state.roadmapRedo[String(n)]?.cardIds.includes(t.id)) continue;
    let reason: string | null = null;
    let kind: RoadmapStuck["kind"] = "done";
    let pr: number | null = null;
    if (t.column === "done") {
      if (deps.now() - t.updatedAt < SETTLE_MS) {
        settling.add(n);
        continue;
      }
      pr = deps.mergedPr(t);
      if (pr != null) kind = "merged";
      reason = pr != null ? `PR #${pr} merged but the issue is still open — close it or reopen the work` : "its card is Done but the issue is still open — close it or reopen the work";
    } else if (await isNoWorkCard(t, deps)) {
      kind = "no-work";
      reason = "its card found nothing to build (no commits, no PR) but the issue is still open — close it or reopen the work";
    }
    if (!reason) continue;
    const key = String(n);
    const step = openByIssue.get(n)!.step;
    const prev = state.roadmapStuck[key];
    const sameCard = prev?.cardId === t.id;
    const entry: RoadmapStuck = {
      ...(sameCard && prev.pr === pr ? prev : {}),
      cardId: t.id,
      reason,
      at: prev?.at ?? deps.now(),
      step,
      kind,
      pr,
      prUrl: pr != null ? (t.prUrl ?? null) : null,
    };
    // Why the issue is still open: what the merged PR said about it. Read
    // once and kept; text from GitHub, shown and never acted on.
    let learned = false;
    if (pr != null && !entry.bodyRead) {
      const body = await deps.prBody(t, pr);
      if (body != null) {
        const m = prIssueMention(body, n);
        Object.assign(entry, { bodyRead: true, mention: m.kind, excerpt: m.excerpt, detail: prIssueMentionLine(pr, n, m) });
        learned = true;
      }
    }
    if (!sameCard) {
      deps.activity(t.id, `Autopilot: step ${step} (#${n}) — ${reason}${entry.detail ? `. ${entry.detail}` : ""}. Not starting another card for it`, "warning");
    } else if (learned && entry.detail) {
      deps.activity(t.id, `Autopilot: step ${step} (#${n}) is still open — ${entry.detail}`, "warning");
    }
    state.roadmapStuck[key] = entry;
  }
  for (const key of Object.keys(state.roadmapStuck)) {
    if (!openByIssue.has(Number(key))) delete state.roadmapStuck[key]; // closed since
  }
  if (settling.size > 0) deps.recheck(60_000);
  const stuck = new Map<number, RoadmapNeedsUser>(
    Object.entries(state.roadmapStuck).map(([k, v]) => [Number(k), { reason: v.reason, pr: v.pr ?? null, prUrl: v.prUrl ?? null, detail: v.detail ?? null, taskId: v.cardId }]),
  );

  // Cards waiting in In Review for the owner: held because their PR changes
  // sensitive code, or taken back from Ready to Merge. Their steps are still
  // in flight (the issue stays busy), but nothing moves until the owner acts.
  const handsOff = deps.handsOff();
  const heldForUser = new Map<number, RoadmapNeedsUser>();
  for (const t of own) {
    const n = issueOf(t);
    if (n == null || !openByIssue.has(n) || t.column !== "review" || t.archivedAt != null) continue;
    const hold = state.holds[t.id];
    if (state.held.includes(t.id)) {
      heldForUser.set(n, {
        reason: hold ? `PR #${hold.pr} changes sensitive code — held in In Review for your sign-off` : "its PR is held in In Review for your sign-off",
        pr: hold?.pr ?? null,
        prUrl: hold?.url ?? t.prUrl ?? null,
        detail: hold ? holdFilesText(hold) : null,
        taskId: t.id,
      });
    } else if (handsOff.has(t.id)) {
      heldForUser.set(n, { reason: "you took it back from Ready to Merge — it waits in In Review for your sign-off", pr: null, prUrl: t.prUrl ?? null, detail: null, taskId: t.id });
    }
  }

  // Slots and busy issues, among this project's cards. Every unstarted
  // backlog card in the ledger is left out — also one left over from another
  // milestone — and so is one just closed above.
  const exempt = new Set([...unstartedBacklog(state, all).values()].map((t) => t.id).concat([...closedNow]));
  const open = openSteps.map((v) => ({ number: v.issue, title: v.title }));
  const { busyIssues, inFlight, ownLive, quotaWait } = slotCounts(all, own, open, deps.quotaPaused, { project: cfg.project, noSlot: exempt, notBusy: exempt });

  if (scope && scoped.length === 0) {
    state.roadmap = summarizeRoadmap({ issue: tracker, url: doc.url, parsed, views, scope, busy: busyIssues, needsUser: stuck, held: heldForUser, now: deps.now() });
    state.phase = "idle";
    return fail(`no step of roadmap #${tracker} has its issue in milestone "${milestone!.title}" — check the issues' milestone on GitHub, or choose All milestones`);
  }

  const free = cfg.maxInFlight - Math.max(ownLive, inFlight.length);
  const picks = pickRoadmap(scoped, { busy: busyIssues, exclude: new Set([...stuck.keys(), ...settling]), free });
  const pipelineId = deps.pipelineId(cfg);
  // A step being done again tells its new card about the earlier PR.
  const priorOf = (issue: number) => {
    const r = state.roadmapRedo[String(issue)];
    return r ? { pr: r.pr, url: r.prUrl, excerpt: r.excerpt } : null;
  };
  const noPipeline = "no pipeline to run issues with (set default_pipeline)";

  // A card waiting for a usage limit to reset frees its slot, but starting
  // another now would only run into the same limit (as in milestone mode).
  let error: string | null = null;
  const started = new Set<number>();
  if (picks.start.length > 0 && !quotaWait) {
    if (!pipelineId) error = noPipeline;
    else {
      for (const v of picks.start) {
        if (deps.outdated()) break;
        const stepPrompt = roadmapStepPrompt(tracker, v, parsed.steps, { prior: priorOf(v.issue) });
        const card = backlog.get(v.issue);
        let id: string;
        if (card) {
          const r = await deps.startExisting({ task: card, stepPrompt });
          if ("error" in r) {
            // Still in the backlog, still in the ledger: the next pass tries again.
            error = `step ${v.step} (#${v.issue}): ${r.error}`;
            continue;
          }
          id = card.id;
          backlog.delete(v.issue);
          delete state.roadmapBacklog[String(v.issue)];
        } else {
          const r = await deps.startCard({ dir: cfg.project, number: v.issue, pipelineId, extraPrompt: stepPrompt });
          if ("error" in r) {
            error = `step ${v.step} (#${v.issue}): ${r.error}`;
            continue;
          }
          id = r.task.id;
        }
        started.add(v.issue);
        state.cards.push(id);
        deps.save(state);
        deps.activity(id, `Autopilot started this as step ${v.step} of roadmap #${tracker}${state.roadmapRedo[String(v.issue)] ? " — again, at your request" : ""}`, "info");
      }
    }
  }

  // Backlog cards up front: with a milestone, every open step in it that has
  // no live card gets one, not started — the owner's steps too. Idempotent:
  // a step added to the milestone later gets its card on the next pass.
  if (scope) {
    const missing = scoped.filter((v) => isOpenStep(v) && !busyIssues.has(v.issue) && !started.has(v.issue) && !backlog.has(v.issue) && !stuck.has(v.issue) && !settling.has(v.issue));
    if (missing.length > 0 && !pipelineId) error ??= noPipeline;
    let failures = 0;
    for (const v of pipelineId ? missing.slice(0, BACKLOG_PER_PASS) : []) {
      // Paused, or pointed at another milestone, while the cards were being
      // made: the rest aren't this run's to make.
      if (deps.outdated()) break;
      const r = await deps.createBacklogCard({ dir: cfg.project, number: v.issue, pipelineId: pipelineId!, extraPrompt: roadmapStepPrompt(tracker, v, parsed.steps, { pending: v.waitingOn, prior: priorOf(v.issue) }) });
      if ("error" in r) {
        error ??= `step ${v.step} (#${v.issue}): no backlog card — ${r.error}`;
        if (++failures >= 3) break; // GitHub is probably unreachable: the next pass tries again
        continue;
      }
      state.roadmapBacklog[String(v.issue)] = r.task.id;
      backlog.set(v.issue, r.task);
      deps.save(state);
      deps.activity(
        r.task.id,
        v.human
          ? `Autopilot added this to the backlog: step ${v.step} of roadmap #${tracker} is yours to do — Autopilot never starts it`
          : `Autopilot added this to the backlog as step ${v.step} of roadmap #${tracker} — it starts when its predecessor steps are complete and a slot is free`,
        "muted",
      );
    }
    if (missing.length > BACKLOG_PER_PASS) deps.recheck(5_000);
  }

  const status = summarizeRoadmap({
    issue: tracker,
    url: doc.url,
    parsed,
    views,
    scope,
    busy: new Set([...busyIssues, ...started]),
    backlog: new Map([...backlog].map(([n, t]) => [n, t.id])),
    needsUser: stuck,
    held: heldForUser,
    now: deps.now(),
  });
  if (!status.idleReason && quotaWait && picks.start.length > 0) status.idleReason = "Holding new starts while a card waits for a usage limit to reset";
  // The table's milestone column and GitHub disagreeing is worth knowing: a
  // step the table puts in this milestone isn't worked unless its issue is.
  if (scope) {
    for (const s of scopeDrift(parsed.steps, states, scope.milestone)) {
      const inIt = scope.steps.has(s.step);
      status.problems = [
        ...status.problems,
        {
          kind: "milestone-mismatch",
          step: s.step,
          message: inIt
            ? `step ${s.step} (#${s.issue}) is in this milestone on GitHub, but the table says ${s.milestone || "none"} — it is worked`
            : `step ${s.step} (#${s.issue}): the table says ${s.milestone}, but its issue isn't in this milestone on GitHub — it is not worked`,
        },
      ];
    }
  }
  state.roadmap = status;
  state.lastError = error;

  // One notification per `[Human]` step, the first time it's ready.
  for (const h of status.humanReady) {
    if (state.notifiedHuman.includes(h.issue)) continue;
    if (deps.notify({ title: "Roadmap: a step needs you", body: `Step ${h.step} · #${h.issue} ${h.title}` })) state.notifiedHuman.push(h.issue);
  }

  if (roadmapFinished(parsed, scoped)) state.phase = "done";
  // A step whose card waits in In Review for the owner is in flight, yet
  // nothing is running because of it.
  else state.phase = status.counts.inFlight - (status.counts.held ?? 0) === 0 && started.size === 0 ? "idle" : "running";
}

// ── Resolving a step that finished without closing its issue ─────────────

export type RoadmapResolveAction = "close" | "redo";

export interface ResolveDeps {
  loadStates: RoadmapDeps["loadStates"];
  gh(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr?: string }>;
  task(id: string): Task | null;
  moveToDone(t: Task): void;
  activity(taskId: string, text: string, tone: "info" | "warning" | "muted"): void;
  now(): number;
}

/**
 * The owner's answer to a step in `roadmapStuck` (its card finished, the
 * issue is still open):
 *
 *   close — close the issue as completed, with a comment saying the owner
 *           accepted the step from Agetor. Successors start on the next pass.
 *   redo  — let Autopilot start a fresh card for the step; the finished card
 *           stops setting off the restart guard and the new card is told
 *           about the earlier PR.
 *
 * Only ever called for the owner's explicit request (the Needs-you button,
 * `agetor roadmap resolve`) — never by a pass. Everything is checked again
 * here: the entry must still be there and the issue still open. Mutates
 * `state`; the caller saves it and asks for a pass. Exported for tests.
 */
export async function resolveRoadmapStep(
  cfg: AutopilotConfig,
  state: AutopilotState,
  input: { issue: number; action: RoadmapResolveAction },
  deps: ResolveDeps,
): Promise<{ ok: true; message: string } | { error: string }> {
  const { issue, action } = input;
  if (!cfg.roadmap || !cfg.project) return { error: "Autopilot isn't working a roadmap" };
  if (!Number.isInteger(issue) || issue <= 0) return { error: "which issue? give its number" };
  if (action !== "close" && action !== "redo") return { error: `unknown action "${String(action)}" — close or redo` };
  const key = String(issue);
  const entry = state.roadmapStuck[key];
  if (!entry) return { error: `#${issue} isn't a step waiting on you any more — nothing to resolve` };
  const states = await deps.loadStates(cfg.project, [issue]);
  if ("error" in states) return { error: `couldn't check #${issue} on GitHub: ${states.error}` };
  const st = states.get(issue);
  if (!st) return { error: `couldn't read the state of #${issue} on GitHub` };
  if (st.state !== "OPEN") {
    delete state.roadmapStuck[key];
    return { error: `#${issue} is already closed — nothing to resolve` };
  }
  const step = entry.step ?? state.roadmap?.needsUser.find((u) => u.issue === issue)?.step ?? null;
  // The last pass's status says it needs you; it doesn't any more.
  const settled = () => {
    delete state.roadmapStuck[key];
    if (state.roadmap) state.roadmap = { ...state.roadmap, needsUser: state.roadmap.needsUser.filter((u) => u.issue !== issue || u.kind === "held") };
  };
  const stepName = step ? `step ${step}` : "this step";
  const card = deps.task(entry.cardId);

  if (action === "close") {
    const comment =
      `Closed by the owner from Agetor: ${stepName} of roadmap #${cfg.roadmap.issue} accepted as complete` +
      (entry.pr != null ? `; PR #${entry.pr} merged.` : ".");
    const r = await deps.gh(["issue", "close", String(issue), "--reason", "completed", "--comment", comment], cfg.project);
    if (!r.ok) return { error: `couldn't close #${issue}: ${(r.stderr || r.stdout || "gh failed").trim().slice(-300)}` };
    settled();
    delete state.roadmapRedo[key];
    if (card) deps.activity(card.id, `Closed #${issue} as completed at your request — ${stepName} accepted as complete`, "info");
    return { ok: true, message: `Closed #${issue} as completed — the steps that waited on ${stepName} can start` };
  }

  // A card that found nothing to build still sits on the board and keeps the
  // issue busy: it is finished, so it goes to Done.
  if (card && card.archivedAt == null && card.column !== "done") {
    if (entry.kind !== "no-work") return { error: `the card for #${issue} is still on the board — finish or archive it first` };
    deps.moveToDone(card);
  }
  const before = state.roadmapRedo[key];
  state.roadmapRedo[key] = {
    cardIds: [...new Set([...(before?.cardIds ?? []), entry.cardId])],
    pr: entry.pr ?? null,
    prUrl: entry.prUrl ?? null,
    excerpt: entry.excerpt ?? null,
    at: deps.now(),
  };
  settled();
  if (card) deps.activity(card.id, `Autopilot: ${stepName} (#${issue}) will be done again at your request — a fresh card starts when a slot is free`, "info");
  return { ok: true, message: `Autopilot starts a fresh card for ${stepName} (#${issue}) when a slot is free` };
}

const RESOLVE_DEPS: ResolveDeps = {
  loadStates: loadRoadmapStates,
  gh: (args, cwd) => run(["gh", ...args], cwd, 60_000, process.env),
  task: (id) => tasks.get(id) ?? null,
  moveToDone: (t) => void tasks.update(t.id, { column: "done" }),
  activity(taskId, text, tone) {
    try {
      recordActivity(taskId, { kind: "auto", text, tone });
    } catch {
      // the card is gone
    }
  },
  now: () => Date.now(),
};

/**
 * `POST /autopilot/roadmap/resolve`: apply the owner's answer between
 * passes (a pass at work holds its own copy of the state and would write
 * over this), save, and ask for a pass.
 */
export async function applyRoadmapResolve(input: { issue: number; action: RoadmapResolveAction }, deps: ResolveDeps = RESOLVE_DEPS): Promise<{ ok: true; message: string } | { error: string }> {
  for (let i = 0; busy && i < 240; i++) await new Promise((r) => setTimeout(r, 500));
  if (busy) return { error: "Autopilot is in the middle of a long pass — try again in a minute" };
  busy = true;
  try {
    const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
    const state = readState();
    const r = await resolveRoadmapStep(cfg, state, input, deps);
    writeState(state);
    return r;
  } finally {
    busy = false;
    requestAutopilotPass(0);
  }
}

let notifier: ((n: { title: string; body: string }) => void) | null = null;

/** The host's native notifications (the API server has them; a headless
 *  daemon doesn't). */
export function setAutopilotNotifier(fn: ((n: { title: string; body: string }) => void) | null): void {
  notifier = fn;
}

let recheckTimer: ReturnType<typeof setTimeout> | null = null;

/** Exported for tests, which swap the GitHub reads. */
export const ROADMAP_DEPS: RoadmapDeps = {
  loadTracker: loadRoadmapTracker,
  loadStates: loadRoadmapStates,
  aheadCount: (t) => NO_WORK_DEPS.aheadCount(t),
  hasNoPr: (t) => NO_WORK_DEPS.hasNoPr(t),
  mergedPr: (t) => {
    const pr = prStatusForTask(t.id);
    return pr?.state === "merged" ? pr.number : null;
  },
  async prBody(t, pr) {
    const r = await run(["gh", "pr", "view", String(pr), "--json", "body", "-q", ".body"], t.workdir, 30_000, process.env);
    return r.ok ? (r.stdout ?? "") : null;
  },
  handsOff: () => new Set(readHandsOff()),
  quotaPaused: quotaPausedCard,
  pipelineId: (cfg) => cfg.pipelineId ?? preferences.get("default_pipeline") ?? null,
  async startCard(input) {
    const r = await createTaskFromIssue({ ...input, allowAfterDone: true });
    return "error" in r ? { error: r.error } : { task: r.task };
  },
  async createBacklogCard(input) {
    const r = await createTaskFromIssue({ ...input, start: false, allowAfterDone: true });
    return "error" in r ? { error: r.error } : { task: r.task };
  },
  async startExisting({ task, stepPrompt }) {
    // The step section was written when the card was made; say what holds now.
    const fresh = tasks.get(task.id);
    if (!fresh || fresh.archivedAt != null) return { error: "its backlog card is gone" };
    tasks.update(task.id, { prompt: withRoadmapStepPrompt(fresh.prompt, stepPrompt) });
    const r = await startTask(task.id);
    return "error" in r ? { error: `its backlog card didn't start: ${r.error}` } : { ok: true };
  },
  moveToDone: (t) => void tasks.update(t.id, { column: "done" }),
  save: (state) => savePassState(state),
  outdated: () => passOutdated(),
  notify(n) {
    if (!notifier) return false;
    try {
      notifier(n);
      return true;
    } catch {
      return false;
    }
  },
  activity: (taskId, text, tone) => recordActivity(taskId, { kind: "auto", text, tone }),
  recheck(delayMs) {
    if (recheckTimer) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      requestAutopilotPass(0);
    }, delayMs);
    recheckTimer.unref?.();
  },
  now: () => Date.now(),
};

let busy = false;

/** One pass. Exported for tests and the "run now" button. */
export async function autopilotTick(): Promise<void> {
  const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
  if (!cfg.enabled || !cfg.project || busy) return;
  // Tracker mode needs neither a milestone nor the thread.
  if (!cfg.roadmap && (!cfg.threadId || !cfg.milestone)) return;
  busy = true;
  passRun = { epoch: runEpoch, project: cfg.project };
  const state = readState();
  try {
    // A finished milestone stays finished until the user restarts Autopilot.
    if (state.phase === "done") return;
    if (state.phase === "idle") state.phase = "running";
    const all = tasks.listLive();
    const mine = state.cards.map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t && t.archivedAt == null);
    state.cards = mine.map((t) => t.id);

    // Sign finished cards off: Ready to Merge, unless the PR changes
    // sensitive code. Forget the withdrawn sign-offs of cards that are gone.
    const withdrawn = readHandsOff();
    const stillThere = withdrawn.filter((id) => all.some((t) => t.id === id && t.archivedAt == null && t.column !== "done"));
    if (stillThere.length !== withdrawn.length) preferences.set(HANDS_OFF_PREF, JSON.stringify(stillThere));
    await signOffPass(state, mine, SIGN_OFF_DEPS);

    if (cfg.roadmap) {
      await roadmapPass(cfg, state, all, mine, ROADMAP_DEPS);
      return;
    }
    if (!cfg.milestone) return;

    const open = await milestoneIssues(cfg);
    if (!open) {
      state.lastError = "couldn't list the milestone's issues";
      return;
    }
    const openSet = new Set(open.map((i) => i.number));
    // Cards that ended with nothing to build: close them and let the thread
    // decide about their issues; issues still deciding or waiting on others
    // aren't candidates.
    const parked = await processNoWork(cfg, state, mine, open, NO_WORK_DEPS);
    // Backlog cards a tracker run left unstarted hold no slot here either
    // (their issues stay busy: the thread isn't offered them).
    const leftover = new Set([...unstartedBacklog(state, all).values()].map((t) => t.id));
    const { busyIssues, inFlight, ownLive, ownUnfinished, quotaWait } = slotCounts(all, mine, open, quotaPausedCard, { noSlot: leftover });
    const candidates = startable(open).filter((i) => !busyIssues.has(i.number) && !parked.has(i.number));

    // Back off after an ask that started nothing, until the board changes.
    const signature = `${candidates.map((i) => i.number).join(",")}|${inFlight.map((i) => i.number).join(",")}|${ownLive}`;
    if (Date.now() < state.quietUntil && signature === state.quietSignature) return;

    if (candidates.length === 0 && ownUnfinished === 0 && busyIssues.size === 0 && !open.some((i) => parked.has(i.number))) {
      if (Date.now() < state.limitedUntil) return;
      // Nothing left: audit (once per emptying), then done unless it filed more.
      state.phase = "auditing";
      writeState(state);
      const a = await askThread({ threadId: cfg.threadId, cwd: cfg.project, prompt: auditPrompt(cfg.milestone.title), timeoutMs: 90 * 60_000 });
      if (!a.ok && a.limitedUntil) {
        state.phase = "running";
        return waitForThreadLimit(state, a.limitedUntil);
      }
      state.limitedUntil = 0;
      state.audits++;
      if (!a.ok) {
        state.lastError = a.busy ? a.error! : `audit: ${a.error}`;
        state.phase = "running";
        state.quietUntil = Date.now() + (a.busy ? BUSY_MS : QUIET_MS);
        state.quietSignature = signature;
        return;
      }
      state.lastAnswer = { at: Date.now(), kind: "audit", text: a.text.slice(-6000) };
      const after = await milestoneIssues(cfg);
      state.phase = after && after.length > 0 ? "running" : "done";
      state.lastError = null;
      return;
    }

    // A card waiting for a usage limit to reset frees its slot, but starting
    // another card now would only run into the same limit: hold new starts
    // until the waiting cards resume.
    if (quotaWait) return;
    if (Date.now() < state.limitedUntil) return;
    const free = cfg.maxInFlight - Math.max(ownLive, inFlight.length);
    if (free <= 0 || candidates.length === 0) return;
    const answer = await askThread({
      threadId: cfg.threadId,
      cwd: cfg.project,
      prompt: nextPrompt(cfg.milestone.title, candidates, inFlight, free),
    });
    if (!answer.ok) {
      if (answer.limitedUntil) return waitForThreadLimit(state, answer.limitedUntil);
      state.lastError = answer.busy ? answer.error! : `next issue: ${answer.error}`;
      state.quietUntil = Date.now() + (answer.busy ? BUSY_MS : QUIET_MS);
      state.quietSignature = signature;
      return;
    }
    state.limitedUntil = 0;
    state.lastAnswer = { at: Date.now(), kind: "next", text: answer.text.slice(-6000) };
    const picks = acceptPicks(taggedJson(answer.text, "next-issues"), openSet, busyIssues, free);
    const pipelineId = cfg.pipelineId ?? preferences.get("default_pipeline") ?? null;
    if (!pipelineId) {
      state.lastError = "no pipeline to run issues with (set default_pipeline)";
      return;
    }
    for (const p of picks) {
      const scope = p.scope ? `## Scope from the milestone manager\n\n${p.scope}` : undefined;
      const r = await createTaskFromIssue({ dir: cfg.project, number: p.number, pipelineId, extraPrompt: scope, allowAfterDone: true });
      if ("error" in r) {
        state.lastError = `#${p.number}: ${r.error}`;
        continue;
      }
      state.cards.push(r.task.id);
      recordActivity(r.task.id, { kind: "auto", text: `Autopilot started this for milestone "${cfg.milestone.title}"`, tone: "info" });
      if (p.scope) {
        await run(
          ["gh", "issue", "comment", String(p.number), "--body", `**Scope** (milestone manager, via Agetor Autopilot):\n\n${p.scope}`],
          cfg.project,
          30_000,
          process.env,
        );
      }
    }
    if (picks.length === 0) {
      state.lastError = "the thread picked nothing to start now — see its answer";
      state.quietUntil = Date.now() + QUIET_MS;
      state.quietSignature = signature;
    } else {
      state.lastError = null;
    }
  } finally {
    savePassState(state);
    passRun = null;
    busy = false;
  }
}

// ── Config (GET/PUT /autopilot) ──────────────────────────────────────────

/** The tracker issue offered when none is configured. */
export function readDefaultTracker(): number | null {
  const n = Number(preferences.get(DEFAULT_TRACKER_PREF));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function autopilotSnapshot(): { config: AutopilotConfig; state: AutopilotState; defaultTracker: number | null } {
  normalizeLegacyConfig();
  return { config: parseConfig(preferences.get(AUTOPILOT_PREF)), state: readState(), defaultTracker: readDefaultTracker() };
}

/**
 * Merge `body` into the config. Enabling, changing the milestone, the
 * tracker or the project, or `restart: true` begins a fresh run. A tracker
 * that is set is remembered as the default; `defaultTracker` (a number, or
 * null to forget it) sets the default alone. Doesn't run a pass.
 */
export function applyAutopilotPatch(body: Record<string, unknown>): AutopilotConfig {
  normalizeLegacyConfig();
  preferences.set(CONFIG_VERSION_PREF, "2"); // what is saved from here on is saved by this build
  const cur = parseConfig(preferences.get(AUTOPILOT_PREF));
  const next = parseConfig(JSON.stringify({ ...cur, ...body }));
  preferences.set(AUTOPILOT_PREF, JSON.stringify(next));
  if (typeof body.defaultTracker === "number" && Number.isInteger(body.defaultTracker) && body.defaultTracker > 0) {
    preferences.set(DEFAULT_TRACKER_PREF, String(body.defaultTracker));
  } else if (body.defaultTracker === null) {
    preferences.set(DEFAULT_TRACKER_PREF, "");
  }
  if (next.roadmap && "roadmap" in body) preferences.set(DEFAULT_TRACKER_PREF, String(next.roadmap.issue));

  // A different tracker (or project) drops the old one's status, its restart
  // guard and its announced human steps; a different milestone under the
  // same tracker drops the status only (it counts the old scope). Backlog
  // cards already made are never touched here — they stay where they are.
  const projectChanged = cur.project !== next.project;
  const milestoneChanged = (cur.milestone?.number ?? null) !== (next.milestone?.number ?? null);
  const roadmapChanged = (cur.roadmap?.issue ?? null) !== (next.roadmap?.issue ?? null) || (!!next.roadmap && projectChanged);
  const scopeChanged = !!next.roadmap && milestoneChanged;
  if (body.restart === true || roadmapChanged || scopeChanged || (next.enabled && (!cur.enabled || milestoneChanged))) {
    runEpoch++;
    const s = readState();
    preferences.set(
      AUTOPILOT_STATE_PREF,
      JSON.stringify({
        ...s,
        phase: "idle",
        held: [],
        holds: {},
        unread: {},
        lastError: null,
        quietUntil: 0,
        quietSignature: "",
        ...(roadmapChanged ? { roadmap: null, roadmapStuck: {}, roadmapRedo: {}, notifiedHuman: [] } : scopeChanged ? { roadmap: null } : {}),
        // The ledger is keyed by issue number, which means another issue in
        // another project.
        ...(projectChanged ? { roadmapBacklog: {} } : {}),
      }),
    );
  }
  return next;
}

/**
 * Once, on the first start of a build where `milestone` limits tracker mode:
 * a config saved before that could hold a tracker AND a milestone left over
 * from an earlier thread-driven run, which was ignored then. Reading it as a
 * scope now would quietly narrow a run that works the whole roadmap, so the
 * leftover milestone is dropped. The tracker in use also becomes the default
 * tracker when there is none. Runs when the core starts and before the
 * config is read or changed through the API; a board that never had
 * Autopilot set up has nothing to decide (the first save marks it).
 * Exported for tests.
 */
export function normalizeLegacyConfig(): void {
  if (preferences.get(CONFIG_VERSION_PREF) === "2") return;
  const raw = preferences.get(AUTOPILOT_PREF);
  if (!raw) return;
  const cfg = parseConfig(raw);
  if (cfg.roadmap) {
    if (cfg.milestone) preferences.set(AUTOPILOT_PREF, JSON.stringify({ ...cfg, milestone: null }));
    if (readDefaultTracker() == null) preferences.set(DEFAULT_TRACKER_PREF, String(cfg.roadmap.issue));
  }
  preferences.set(CONFIG_VERSION_PREF, "2");
}

let loop: ReturnType<typeof setInterval> | null = null;
let pending = false;
let debounce: ReturnType<typeof setTimeout> | null = null;

async function runPass(): Promise<void> {
  try {
    await autopilotTick();
  } catch (e) {
    const s = readState();
    s.lastError = (e as Error).message;
    writeState(s);
  }
  // Events that arrived during a (long) thread request get one more pass.
  if (pending) {
    pending = false;
    requestAutopilotPass();
  }
}

/** Run a pass soon (coalescing bursts of events); if one is running, run
 *  exactly one more after it. */
export function requestAutopilotPass(delayMs = 3_000): void {
  if (busy) {
    pending = true;
    return;
  }
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void runPass();
  }, delayMs);
  debounce.unref?.();
}

/** Whether a board event can free a slot (or finish the milestone). Pure. */
export function freesSlot(e: { kind: string; column?: Task["column"]; prev?: Task["column"] | null; status?: string }): boolean {
  // A pipeline run that stops on a block (a question, a failure, a usage
  // limit) stops holding its slot.
  if (e.kind === "pipeline") return e.status === "blocked";
  if (e.kind !== "column" || !e.column) return false;
  return e.column === "done" || (!!e.prev && BUILDING.has(e.prev) && !PROGRESSING_COLUMNS.has(e.column));
}

export function startAutopilot(): void {
  if (loop) return;
  normalizeLegacyConfig();
  const enabled = () => parseConfig(preferences.get(AUTOPILOT_PREF)).enabled;
  subscribeGlobal((e) => {
    if (freesSlot(e as never) && enabled()) requestAutopilotPass();
  });
  // Deleting or archiving a card can free a slot too.
  onCardRemoved(() => {
    if (enabled()) requestAutopilotPass();
  });
  loop = setInterval(() => void runPass(), FALLBACK_MS);
  loop.unref?.();
  setInterval(() => {
    if (enabled() && parseConfig(preferences.get(AUTOPILOT_PREF)).roadmap) void runPass();
  }, ROADMAP_POLL_MS).unref?.();
  requestAutopilotPass(30_000);
}
