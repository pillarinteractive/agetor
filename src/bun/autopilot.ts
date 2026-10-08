/**
 * Milestone Autopilot: work a GitHub milestone to done without being driven.
 *
 * The user's milestone-manager Codex thread (src/bun/codex-thread.ts) decides
 * WHAT: asked which open issues should start next, it answers with up to N
 * issues plus a scope clarification for each (acceptance criteria, in/out of
 * scope, risks). Agetor does the rest: creates and starts a pipeline card per
 * issue (the scope goes into the card's prompt and onto the issue), keeps up
 * to `maxInFlight` cards going, signs finished cards off into Ready to Merge
 * (the merge queue lands them) — except PRs touching billing, auth,
 * migrations or the schema, which wait in In Review for the user — and, when
 * the milestone has no open issues and nothing in flight, asks the thread for
 * a deep audit. Issues the audit files into the milestone restart the loop;
 * a clean audit ends it.
 *
 * Config: `autopilot` preference. State: `autopilot_state` preference.
 */
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { run } from "./github.ts";
import { askThread, taggedJson, type ThreadAnswer } from "./codex-thread.ts";
import { createTaskFromIssue } from "./issue-queue.ts";
import { setMergeQueued } from "./merge-intent.ts";
import { hasConfirmedNoPr, prStatusForTask } from "./pr-watch.ts";
import { onCardRemoved, subscribeGlobal } from "./orchestrator.ts";
import { holdsAutopilotSlot, PROGRESSING_COLUMNS, waitingOnQuota } from "../shared/autopilot.ts";
import { formatRetryTime, isQuotaPaused } from "./usage-limit.ts";

export const AUTOPILOT_PREF = "autopilot";
export const AUTOPILOT_STATE_PREF = "autopilot_state";
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
}

export interface AutopilotState {
  phase: "idle" | "running" | "auditing" | "done";
  cards: string[];
  held: string[];
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
  updatedAt: number;
}

export interface NoWorkPending {
  cardId: string;
  title: string;
  /** The card's final handoff, as sent to the thread. */
  handoff: string;
  retryAt: number;
}

const RISKY = /(billing|stripe|checkout|subscription|auth|clerk|session|permission|migrations?\/|drizzle\/|db\/schema|schema\.ts)/i;

export function parseConfig(raw: string | null | undefined): AutopilotConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const m = o.milestone as { number?: unknown; title?: unknown } | null | undefined;
  return {
    enabled: o.enabled === true,
    threadId: typeof o.threadId === "string" ? o.threadId : "",
    project: typeof o.project === "string" ? o.project : "",
    milestone: m && typeof m.number === "number" && typeof m.title === "string" ? { number: m.number, title: m.title } : null,
    maxInFlight: typeof o.maxInFlight === "number" && o.maxInFlight >= 1 ? Math.min(10, Math.floor(o.maxInFlight)) : 5,
    pipelineId: typeof o.pipelineId === "string" && o.pipelineId ? o.pipelineId : null,
  };
}

export function readState(): AutopilotState {
  try {
    const v = JSON.parse(preferences.get(AUTOPILOT_STATE_PREF) ?? "{}") as Partial<AutopilotState>;
    return {
      phase: v.phase ?? "idle",
      cards: Array.isArray(v.cards) ? v.cards : [],
      held: Array.isArray(v.held) ? v.held : [],
      audits: typeof v.audits === "number" ? v.audits : 0,
      lastAnswer: v.lastAnswer ?? null,
      lastError: v.lastError ?? null,
      quietUntil: v.quietUntil ?? 0,
      quietSignature: v.quietSignature ?? "",
      limitedUntil: typeof v.limitedUntil === "number" ? v.limitedUntil : 0,
      noWork: v.noWork && typeof v.noWork === "object" ? v.noWork : {},
      waits: v.waits && typeof v.waits === "object" ? v.waits : {},
      reworked: Array.isArray(v.reworked) ? v.reworked : [],
      updatedAt: v.updatedAt ?? 0,
    };
  } catch {
    return { phase: "idle", cards: [], held: [], audits: 0, lastAnswer: null, lastError: null, quietUntil: 0, quietSignature: "", limitedUntil: 0, noWork: {}, waits: {}, reworked: [], updatedAt: 0 };
  }
}

function writeState(s: AutopilotState): void {
  preferences.set(AUTOPILOT_STATE_PREF, JSON.stringify({ ...s, updatedAt: Date.now() }));
}

/** Issue number from a card's issue URL. */
function issueOf(t: Task): number | null {
  const m = t.issueUrl?.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
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

async function prTouchesRisky(t: Task, number: number): Promise<boolean> {
  const r = await run(["gh", "pr", "view", String(number), "--json", "files", "-q", ".files[].path"], t.workdir, 30_000, process.env);
  return !r.ok || (r.stdout ?? "").split("\n").some((p) => RISKY.test(p));
}

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
): SlotCounts {
  const cards = all.filter((t) => !t.pipelineParentId && t.archivedAt == null);
  const busyIssues = new Set(cards.filter(live).map(issueOf).filter((n): n is number => n != null));
  const holding = cards.filter((t) => holdsAutopilotSlot(t, quotaPaused));
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

let busy = false;

/** One pass. Exported for tests and the "run now" button. */
export async function autopilotTick(): Promise<void> {
  const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
  if (!cfg.enabled || !cfg.threadId || !cfg.project || !cfg.milestone || busy) return;
  busy = true;
  const state = readState();
  try {
    // A finished milestone stays finished until the user restarts Autopilot.
    if (state.phase === "done") return;
    if (state.phase === "idle") state.phase = "running";
    const all = tasks.list();
    const mine = state.cards.map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t && t.archivedAt == null);
    state.cards = mine.map((t) => t.id);

    // Sign finished cards off: Ready to Merge, unless the PR touches risky code.
    for (const t of mine) {
      if (t.column !== "review" || t.pipelineRun?.status !== "done" || state.held.includes(t.id)) continue;
      const pr = prStatusForTask(t.id);
      if (pr?.state !== "open") continue;
      if (await prTouchesRisky(t, pr.number)) {
        state.held.push(t.id);
        recordActivity(t.id, { kind: "auto", text: `Autopilot: PR #${pr.number} touches billing/auth/migrations/schema — left in In Review for you to sign off`, tone: "warning" });
        continue;
      }
      setMergeQueued(t.id, true);
      tasks.update(t.id, { column: "merge" });
      recordActivity(t.id, { kind: "auto", text: `Autopilot: signed off PR #${pr.number} for merging`, tone: "info" });
    }

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
    const { busyIssues, inFlight, ownLive, ownUnfinished, quotaWait } = slotCounts(all, mine, open, quotaPausedCard);
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
    writeState(state);
    busy = false;
  }
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
  requestAutopilotPass(30_000);
}
