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
import { preferences, tasks, isSqliteBusy } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { run } from "./github.ts";
import { classifyRefsVerdict, parseRefsClosePref, REFS_CLOSE_PREF, refsCloseMarker, releaseGateBody, releaseGateCloseComment, releaseGateTitle, type RefsCloseDecision, type RefsClosePolicy } from "../shared/refs-close.ts";
import { decisionPolicyForProject, PIPELINE_DECISIONS_PREF } from "../shared/pipeline-decisions.ts";
import { askThread, taggedJson, type ThreadAnswer } from "./codex-thread.ts";
import { createTaskFromIssue } from "./issue-queue.ts";
import { setMergeQueued } from "./merge-intent.ts";
import { noteOwnerSignOff, noteRunReopened, reworkHeld, reworkHoldMark } from "./merge-rework.ts";
import { describeRiskyFiles, parseRiskyRules, riskyFiles, RISKY_PATHS_PREF, type RiskyRules } from "../shared/risky-paths.ts";
import { hasConfirmedNoPr, prStatusForTask } from "./pr-watch.ts";
import { onCardRemoved, startTask, subscribeGlobal, isTaskRunLive } from "./orchestrator.ts";
import { runnerUse, activeCardOwners } from './dispatch-claims.ts';
import { beginQueueCycle, completeQueueCycle, restoredQueueDelay } from './queue-cycle.ts';
import { currentSlots } from './step-slots.ts';
import {reviewApprovalMatches} from '../shared/pipeline.ts';
import {approvedHeadFor} from '../shared/publish.ts';
import { freezeCardInputs, queueValidator } from './queue-validation.ts';
import type { CanonicalQueue } from '../shared/canonical-roadmap.ts';
import { holdsAutopilotSlot, neverStarted, PROGRESSING_COLUMNS, signOffMarkLapsed, waitingOnQuota, type SignOffMark } from "../shared/autopilot.ts";
import { formatRetryTime, isQuotaPaused } from "./usage-limit.ts";
import { listLeases } from "./lease-watch.ts";
import { blockedCardLine } from "../shared/block-reason.ts";
import { loadCanonicalQueue, loadRoadmapStates, loadRoadmapTracker } from "./roadmap-fetch.ts";
import { recordVelocityPass, type VelocityPassInput } from "./roadmap-velocity.ts";
import { BUG_LANE_PREF, bugCardPrompt, parseBugLane, pickBugs, type BugIssue, type BugLaneConfig } from "../shared/bug-lane.ts";
import {
  currentRoadmapStatus,
  displayText,
  MAX_SCOPE_MILESTONES,
  nextMilestoneText,
  normalizeMilestones,
  offerPending,
  parseRoadmap,
  pickRoadmap,
  prIssueMention,
  prIssueMentionLine,
  roadmapContinuation,
  roadmapFinished,
  roadmapScope,
  roadmapStatus,
  roadmapStepPrompt,
  scopeDrift,
  scopeLabel,
  scopeMilestones,
  summarizeRoadmap,
  withRoadmapStepPrompt,
  type PrIssueMentionKind,
  type RoadmapBlockedCard,
  type RoadmapContinued,
  type RoadmapIssueState,
  type RoadmapMilestone,
  type RoadmapNeedsUser,
  type RoadmapNextMilestone,
  type RoadmapOfferDismissal,
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
/** What each of those marks is about (`SignOffMark`, by card id): the run
 *  and the head at the time. A mark does not outlive that run — a new run of
 *  the card that finishes at a new head is signed off like any other. Beside
 *  the list, not in it, so a build that only knows the list still reads it. */
export const HANDS_OFF_MARKS_PREF = "autopilot_hands_off_marks";
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
  /** The first milestone in scope (the only one in thread-driven mode);
   *  always `milestones[0] ?? null`. */
  milestone: { number: number; title: string } | null;
  /** Tracker mode: the milestones whose steps are worked, in the order they
   *  were added (empty = the whole roadmap). A config saved with only
   *  `milestone` reads as that one milestone. */
  milestones: { number: number; title: string }[];
  maxInFlight: number;
  pipelineId: string | null;
  /** Tracker mode: the tracker issue (in `project`'s repo) whose step table
   *  gives the order. When set, `threadId` isn't used and `milestones`
   *  limits which steps are worked. */
  roadmap: { issue: number } | null;
  /** Tracker mode with a milestone scope: when the scope can no longer fill
   *  its slots, add the next milestone without asking. */
  autoContinue: boolean;
  /** Explicit project authorization for newly finished reviewed pipelines. */
  autoMergePipelines?:boolean;
  autoMergeSince?:number;
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
  /** The owner's "not now" to the next-milestone offer (which milestone, at
   *  which stage): the offer comes back only at a later stage. */
  roadmapOffer: RoadmapOfferDismissal | null;
  /** Milestones whose offer was announced with a native notification. */
  notifiedOffer: number[];
  /** The milestones this run continued into (the last few), latest last. */
  roadmapContinued: RoadmapContinued[];
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
  /** The release-gate rule's judgement of the PR's `Refs` verdict
   *  (src/shared/refs-close.ts), made once when the rule applies. */
  gate?: { decision: RefsCloseDecision; why: string; items: string[]; line: string | null } | null;
  /** The release-gate follow-up filed (or found) for this step. */
  gateFollowup?: { number: number; url: string } | null;
  /** A follow-up create was attempted; search before creating again. */
  gatePending?: boolean;
  /** The last GitHub failure of the rule, the failures in a row, and when
   *  it may try again. */
  gateError?: string | null;
  gateFailures?: number;
  gateRetryAt?: number;
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
  const r = o.roadmap as { issue?: unknown } | null | undefined;
  // The scope is a list; a config that names one `milestone` is that list.
  const milestones = r?.issue===639 ? [] : normalizeMilestones(o.milestones, o.milestone);
  return {
    enabled: o.enabled === true,
    threadId: typeof o.threadId === "string" ? o.threadId : "",
    project: typeof o.project === "string" ? o.project : "",
    milestone: milestones[0] ?? null,
    milestones,
    maxInFlight: typeof o.maxInFlight === "number" && o.maxInFlight >= 1 ? Math.min(10, Math.floor(o.maxInFlight)) : 5,
    pipelineId: typeof o.pipelineId === "string" && o.pipelineId ? o.pipelineId : null,
    roadmap: typeof r?.issue === "number" && Number.isInteger(r.issue) && r.issue > 0 ? { issue: r.issue } : null,
    autoContinue: o.autoContinue === true,
    ...(o.autoMergePipelines===true&&typeof o.autoMergeSince==='number'&&Number.isFinite(o.autoMergeSince)&&o.autoMergeSince>0?{autoMergePipelines:true,autoMergeSince:o.autoMergeSince}:{}),
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
      roadmapOffer: v.roadmapOffer && typeof v.roadmapOffer === "object" && typeof v.roadmapOffer.milestone === "number" ? v.roadmapOffer : null,
      notifiedOffer: Array.isArray(v.notifiedOffer) ? v.notifiedOffer : [],
      roadmapContinued: Array.isArray(v.roadmapContinued) ? v.roadmapContinued : [],
      roadmapBacklog: v.roadmapBacklog && typeof v.roadmapBacklog === "object" ? v.roadmapBacklog : {},
      updatedAt: v.updatedAt ?? 0,
    };
  } catch {
    return { phase: "idle", cards: [], held: [], holds: {}, unread: {}, audits: 0, lastAnswer: null, lastError: null, quietUntil: 0, quietSignature: "", limitedUntil: 0, noWork: {}, waits: {}, reworked: [], roadmap: null, roadmapStuck: {}, roadmapRedo: {}, notifiedHuman: [], roadmapOffer: null, notifiedOffer: [], roadmapContinued: [], roadmapBacklog: {}, updatedAt: 0 };
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
function savePassState(state: AutopilotState, pass=passRun): void {
  if (!pass || pass.epoch === runEpoch) return writeState(state);
  const fresh = readState();
  const sameProject = parseConfig(preferences.get(AUTOPILOT_PREF)).project === pass.project;
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

function readHandsOffMarks(): Record<string, SignOffMark> {
  try {
    const v = JSON.parse(preferences.get(HANDS_OFF_MARKS_PREF) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, SignOffMark> = {};
    for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      out[id] = {
        run: typeof m.run === "number" && Number.isFinite(m.run) ? m.run : null,
        head: typeof m.head === "string" && m.head ? m.head : null,
        ...(m.reopened === true ? { reopened: true } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeHandsOffMarks(marks: Record<string, SignOffMark>): void {
  preferences.set(HANDS_OFF_MARKS_PREF, JSON.stringify(marks));
}

/** The card's run and its pull request's head as they are now. */
function signOffMarkNow(taskId: string): SignOffMark {
  return { run: tasks.get(taskId)?.pipelineRun?.startedAt ?? null, head: prStatusForTask(taskId)?.headSha ?? null };
}

/**
 * The user dragged a card out of Ready to Merge (the task PATCH withdrew its
 * sign-off). If it is one of Autopilot's, it is theirs from here on:
 * Autopilot doesn't sign it off again, whatever its PR looks like later —
 * for as long as that is the same run of the card. The mark records the run
 * and the head it is about (`HANDS_OFF_MARKS_PREF`).
 */
export function noteSignOffWithdrawn(taskId: string): void {
  const cfg=parseConfig(preferences.get(AUTOPILOT_PREF)),task=tasks.get(taskId);
  if (!readState().cards.includes(taskId)&&!(cfg.autoMergePipelines&&task?.pipelineId&&sameDir(task.workdir,cfg.project))) return;
  const cur = readHandsOff();
  if (!cur.includes(taskId)) preferences.set(HANDS_OFF_PREF, JSON.stringify([...cur, taskId].slice(-500)));
  writeHandsOffMarks({ ...readHandsOffMarks(), [taskId]: signOffMarkNow(taskId) });
}

/** The owner sent a card's run back through its steps (restart from a step,
 *  rewind, feedback): a sign-off taken back before that was about the run as
 *  it stood, and lapses once the redone run finishes at a new head. */
export function noteOwnerReopenedRun(taskId: string): void {
  const marks = readHandsOffMarks();
  if (marks[taskId] && !marks[taskId]!.reopened) writeHandsOffMarks({ ...marks, [taskId]: { ...marks[taskId]!, reopened: true } });
  noteRunReopened(taskId);
}

/** Every mark that keeps Autopilot off this card, with what each is about.
 *  A mark from a build that did not record it is given the card's run and
 *  head as they are now: it then lapses with the next run, not with this one. */
function handsOffMarksFor(taskId: string): SignOffMark[] {
  const out: SignOffMark[] = [];
  if (readHandsOff().includes(taskId)) {
    const marks = readHandsOffMarks();
    if (!marks[taskId] || marks[taskId]!.run == null || !marks[taskId]!.head) {
      const now = signOffMarkNow(taskId);
      marks[taskId] = { ...marks[taskId], run: marks[taskId]?.run ?? now.run, head: marks[taskId]?.head ?? now.head };
      writeHandsOffMarks(marks);
      // Recorded only now: about this run, so it holds for this pass.
      out.push({ run: null, head: null });
    } else {
      out.push(marks[taskId]!);
    }
  }
  const held = reworkHoldMark(taskId, tasks.get(taskId)?.pipelineRun?.startedAt ?? null);
  if (held) out.push(held);
  return out;
}

/** Forget every mark on a card whose marks have all lapsed. */
function releaseHandsOff(taskId: string): void {
  const cur = readHandsOff();
  if (cur.includes(taskId)) preferences.set(HANDS_OFF_PREF, JSON.stringify(cur.filter((id) => id !== taskId)));
  const marks = readHandsOffMarks();
  if (marks[taskId]) {
    delete marks[taskId];
    writeHandsOffMarks(marks);
  }
  // The merge queue's hold with its spent fix rounds: a new run starts afresh.
  noteOwnerSignOff(taskId);
}

export interface SignOffDeps {
  prStatus(taskId: string): TaskPrStatus | null;
  /** Every file the PR changes; null when the list couldn't be read. */
  prFiles(t: Task, pr: number): Promise<string[] | null>;
  rules(): RiskyRules;
  handsOff(): ReadonlySet<string>;
  /** What each mark keeping Autopilot off this card is about (the user took
   *  its sign-off back; the merge queue held it). Without this, or with no
   *  mark to judge, a hands-off card is never signed off. */
  handsOffMarks?(taskId: string): SignOffMark[];
  /** Forget those marks: the run they were about has been replaced. */
  releaseHandsOff?(taskId: string): void;
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
 * - A card the user took back from Ready to Merge, or the merge queue held
 *   for them, is not signed off again — for that run of the card. Such a
 *   mark is about one run at one head (`signOffMarkLapsed`): when a new run
 *   of the card, or that run reopened by the owner, finishes at another
 *   head, the mark is forgotten and the card is judged like any other.
 * - A card they moved out of In Review is no longer held.
 *
 * Mutates `state`. Exported for tests.
 */
export function reviewedPillarPipeline(t:Task,cfg:AutopilotConfig,pr:TaskPrStatus|null):boolean {
  const run=t.pipelineRun,graph=run?.snapshot?.graph;
  if(!cfg.autoMergePipelines||!cfg.autoMergeSince||cfg.roadmap?.issue!==639||!sameDir(t.workdir,cfg.project)
    ||!t.pipelineId||t.pipelineParentId||!run||run.status!=='done'||(run.endedAt??0)<cfg.autoMergeSince
    ||!/^https:\/\/github\.com\/pillar-interactive\/pillar\/issues\/\d+\/?$/i.test(t.issueUrl??'')
    ||!/^https:\/\/github\.com\/pillar-interactive\/pillar\/pull\/\d+\/?$/i.test(t.prUrl??'')
    // A draft is not a reason to hold an approved card: Build opens the PR as a draft so CI runs during
    // Review, and the merge queue marks it ready (merge-queue.ts `mark-ready`).
    ||pr?.url!==t.prUrl||pr.state!=='open'||pr.baseRef!=='develop'||!pr.headSha)return false;
  const review=graph?.steps.find(s=>s.name==='Review'),finish=graph?.steps.find(s=>s.name==='Finish');
  const profile=review?.agentProfileId?run.snapshot?.profiles[review.agentProfileId]:null;
  if(!review||!finish||profile?.model!=='gpt-6.1-sol')return false;
  const lastReview=run.history.filter(h=>h.stepId===review.id).at(-1),last=run.history.at(-1);
  return lastReview?.outcome==='succeeded'&&lastReview.handoff?.status==='done'
    // An Agetor-run Finish may have merged the base into the approved head
    // (the change's own diff unchanged): the approval is of the head it carried over.
    &&reviewApprovalMatches(lastReview.handoff,t.issueUrl!,approvedHeadFor(run.publish,pr.headSha))
    &&lastReview.handoff.openQuestions.length===0&&lastReview===run.history.at(-2)
    &&lastReview.nextStepIds.includes(finish.id)&&last?.stepId===finish.id&&last.outcome==='succeeded'
    &&last.handoff?.status==='done'&&last.handoff.openQuestions.length===0&&last.handoff.artifacts.includes(t.prUrl!);
}
export async function signOffPass(state: AutopilotState, mine: Task[], deps: SignOffDeps, cfg?:AutopilotConfig): Promise<void> {
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
    if (t.column !== "review" || t.pipelineRun?.status !== "done") continue;
    const pr = deps.prStatus(t.id);
    if (handsOff.has(t.id)) {
      const marks = deps.handsOffMarks?.(t.id) ?? [];
      const now = { run: t.pipelineRun.startedAt ?? null, done: true, head: pr?.state === "open" ? (pr.headSha ?? null) : null };
      if (marks.length === 0 || !marks.every((m) => signOffMarkLapsed(m, now))) continue;
      deps.releaseHandsOff?.(t.id);
      deps.activity(t.id, "Autopilot: this card's sign-off was taken back during an earlier run; a new run has finished at a new head, so it is judged again like any other card", "info");
    }
    if (pr?.state !== "open") continue;
    const authorized=!!cfg&&reviewedPillarPipeline(t,cfg,pr);
    if(cfg?.autoMergePipelines&&cfg.roadmap?.issue===639&&sameDir(t.workdir,cfg.project)&&!authorized)continue;
    const hold = state.holds[t.id];
    if (!authorized&&wasHeld && hold && hold.pr === pr.number && hold.headSha != null && hold.headSha === pr.headSha && hold.rules === rules.signature) continue;

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
    if (risky.length > 0&&!authorized) {
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
  // …and cards the merge queue handed back after their fix rounds ran out.
  handsOff: () => new Set([...readHandsOff(), ...reworkHeld()]),
  handsOffMarks: handsOffMarksFor,
  releaseHandsOff,
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
  loadQueue?(project:string,issue:number):Promise<(CanonicalQueue & {states:Map<number,RoadmapIssueState>;body:string;url:string|null})|{error:string}>;
  runnerFree?():number;
  cardFree?():number;
  validator?(project:string,tracker:number,queue:CanonicalQueue,issue:number,cardId?:string):()=>Promise<string|null>;
  freeze?(project:string,tracker:number,queue:CanonicalQueue,issue:number,taskId:string):void;
  loadTracker(project: string, issue: number): Promise<{ body: string; url: string | null } | { error: string }>;
  loadStates(project: string, numbers: number[]): Promise<Map<number, RoadmapIssueState> | { error: string }>;
  aheadCount: NoWorkDeps["aheadCount"];
  hasNoPr: NoWorkDeps["hasNoPr"];
  /** The card's merged PR, if it has one. */
  mergedPr(t: Task): number | null;
  /** A PR's description; null when it couldn't be read. */
  prBody(t: Task, pr: number): Promise<string | null>;
  /** The release-gate rule's GitHub effects (owner decision 2026-10-14);
   *  without it a pass never closes an issue. */
  refsClose?: RefsCloseDeps;
  /** Cards whose sign-off the user withdrew. */
  handsOff(): ReadonlySet<string>;
  quotaPaused(t: Pick<Task, "pipelineRun">): boolean;
  /** Labels of the project's watched leases (for the wait queue's lines). */
  leaseLabels?(project: string): string[];
  pipelineId(cfg: AutopilotConfig): string | null;
  /** The bug lane (src/shared/bug-lane.ts): its settings and the open
   *  issues with its label, or null when the lane is off. */
  bugs?(project: string): Promise<{ config: BugLaneConfig; open: BugIssue[] } | { error: string } | null>;
  /** Create a card for the issue and start it. */
  startCard(input: { dir: string; number: number; pipelineId: string; extraPrompt: string;validate?:()=>Promise<string|null>;onCreated?:(task:Task)=>void }): Promise<{ task: Task } | { error: string }>;
  /** Create a card for the issue in the Backlog, not started. */
  createBacklogCard(input: { dir: string; number: number; pipelineId: string; extraPrompt: string }): Promise<{ task: Task } | { error: string }>;
  /** Start a backlog card made earlier, with its step section rewritten. */
  startExisting(input: { task: Task; stepPrompt: string;validate?:()=>Promise<string|null> }): Promise<{ ok: true } | { error: string }>;
  moveToDone(t: Task): void;
  /** Persist the state mid-pass (after each card made or started, so a core
   *  that stops half way still knows its cards). */
  save(state: AutopilotState): void;
  /** The run was changed or paused while this pass was at work: make and
   *  start nothing more. */
  outdated(): boolean;
  /** Save the scope the pass arrived at (a finished milestone dropped, the
   *  next one added); false when the run was changed meanwhile and nothing
   *  was saved. */
  setScope(milestones: RoadmapMilestone[]): boolean;
  /** A native notification; false when there's no host to show it. */
  notify(n: { title: string; body: string }): boolean;
  activity(taskId: string, text: string, tone: "info" | "warning" | "muted"): void;
  /** Ask for another pass in `delayMs`. */
  recheck(delayMs: number): void;
  /** Record the pass in the velocity ledger (src/bun/roadmap-velocity.ts):
   *  newly completed steps, a sample of the slots, the roadmap's snapshot.
   *  Best-effort; a pass works the same without it. */
  velocity?(input: VelocityPassInput): void;
  now(): number;
}

/** What the release-gate rule needs: whether it applies to the project, and
 *  the three GitHub calls. Every call reports failure instead of throwing. */
export interface RefsCloseDeps {
  /** The rule's settings, or null when it doesn't apply (the project isn't
   *  `agent-followups` in `pipeline_decisions`, or `refs_close` is off). */
  policy(project: string): RefsClosePolicy | null;
  /** An open or closed issue whose body carries `marker`. */
  findFollowup(project: string, marker: string): Promise<{ number: number; url: string } | null | { error: string }>;
  createFollowup(project: string, input: { title: string; body: string; milestone: string | null; label: string | null }): Promise<{ number: number; url: string } | { error: string }>;
  closeIssue(project: string, issue: number, comment: string): Promise<{ ok: true } | { error: string }>;
}

/** The rule's GitHub retries: 5 min, doubling, at most 6 h. */
const GATE_BACKOFF_MS = 5 * 60_000;
const GATE_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/**
 * The release-gate rule (owner decision 2026-10-14) for one stuck step whose
 * PR merged with a `Refs #N` verdict: when every item still listed is human
 * approval or external evidence, file one release-gate follow-up (found by
 * its marker if it exists), close #N as completed with a comment linking
 * both, and say so on the card. True when #N was closed. Any GitHub failure
 * leaves the stuck entry, notes the error once and backs off.
 */
async function releaseGateStep(cfg: AutopilotConfig, policy: RefsClosePolicy, n: number, title: string, entry: RoadmapStuck, gh: RefsCloseDeps, deps: RoadmapDeps, save: () => void): Promise<boolean> {
  const gate = entry.gate;
  if (!gate || gate.decision !== "close" || entry.pr == null) return false;
  if (entry.gateRetryAt && deps.now() < entry.gateRetryAt) return false;
  const pr = entry.pr;
  const fail = (what: string, error: string) => {
    const failures = (entry.gateFailures ?? 0) + 1;
    const message = `${what}: ${error}`.slice(0, 300);
    if (entry.gateError !== message) deps.activity(entry.cardId, `Autopilot: the release-gate rule couldn't finish #${n} — ${message}. Leaving it for you; retrying later`, "warning");
    Object.assign(entry, { gateError: message, gateFailures: failures, gateRetryAt: deps.now() + Math.min(GATE_BACKOFF_MS * 2 ** (failures - 1), GATE_BACKOFF_MAX_MS) });
    return false;
  };
  let followup = entry.gateFollowup ?? null;
  if (!followup) {
    const found = await gh.findFollowup(cfg.project, refsCloseMarker(n)).catch((e: unknown) => ({ error: String(e) }));
    if (found && "error" in found) return fail("searching for its follow-up failed", found.error);
    followup = found;
  }
  if (!followup) {
    entry.gatePending = true;
    save(); // a durable claim before the remote create
    const verdict = { ...gate, engineering: [], unmatched: [] };
    const made = await gh.createFollowup(cfg.project, {
      title: releaseGateTitle(n, title),
      body: releaseGateBody({ issue: n, pr, prUrl: entry.prUrl ?? null, verdict }),
      milestone: policy.milestone,
      label: policy.label,
    }).catch((e: unknown) => ({ error: String(e) }));
    if ("error" in made) return fail("filing its release-gate follow-up failed", made.error);
    followup = made;
  }
  entry.gateFollowup = followup;
  entry.gatePending = false;
  save();
  const closed = await gh.closeIssue(cfg.project, n, releaseGateCloseComment({ pr, prUrl: entry.prUrl ?? null, followup })).catch((e: unknown) => ({ error: String(e) }));
  if ("error" in closed) return fail(`closing it failed (follow-up #${followup.number} is filed)`, closed.error);
  deps.activity(
    entry.cardId,
    `Autopilot: closed #${n} under the owner's release-gate rule of 2026-10-14 — PR #${pr}'s “Refs” verdict lists only approval or evidence (${gate.items.join("; ")}). Follow-up #${followup.number} tracks it; reopen #${n} if any item is engineering`,
    "info",
  );
  return true;
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
  const fail = (error: string) => {
    state.lastError = error;
  };
  const fullQueue=tracker===639;
  const canonical=fullQueue&&deps.loadQueue ? await deps.loadQueue(cfg.project,tracker) : null;
  if(canonical&&'error'in canonical)return fail(canonical.error);
  const queue=canonical&&'parsed'in canonical?canonical:null;
  const doc = queue ?? await deps.loadTracker(cfg.project, tracker);
  if ("error" in doc) return fail(doc.error);
  const parsed = queue?.parsed ?? parseRoadmap(doc.body);
  if (parsed.error) {
    // Nothing starts from a roadmap that can't be read.
    state.roadmap = summarizeRoadmap({ issue: tracker, url: doc.url, parsed, views: [], busy: new Set(), needsUser: new Map(), now: deps.now() });
    return fail(`roadmap #${tracker}: ${parsed.error}`);
  }
  const states = queue?.states ?? await deps.loadStates(cfg.project, parsed.steps.map((s) => s.issue));
  if ("error" in states) return fail(states.error);
  const views = roadmapStatus(parsed, states);
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
  // The release-gate rule (owner decision 2026-10-14): a merged PR whose
  // `Refs` verdict lists only approval or evidence closes its step here. A
  // closed step counts as settling for the rest of this pass (nothing starts
  // for it; the next pass reads it closed).
  const gatePolicy = deps.refsClose?.policy(cfg.project) ?? null;
  if (deps.refsClose && gatePolicy && gatePolicy.mode !== "off") {
    for (const [key, entry] of Object.entries(state.roadmapStuck)) {
      const n = Number(key);
      if (entry.pr == null || (entry.kind !== "merged" && entry.kind !== "done")) continue;
      if (entry.gate === undefined) {
        const card = all.find((x) => x.id === entry.cardId) ?? own.find((x) => x.id === entry.cardId);
        if (!card) continue; // can't read the PR without its card; the owner decides
        const body = await deps.prBody(card, entry.pr);
        if (body == null) continue; // read again next pass
        const v = classifyRefsVerdict(body, n);
        entry.gate = { decision: v.decision, why: v.why, items: v.items, line: v.line };
        if (v.decision === "keep") deps.activity(entry.cardId, `Autopilot: the release-gate rule leaves #${n} for you — ${v.why}`, "muted");
      }
      if (await releaseGateStep(cfg, gatePolicy, n, openByIssue.get(n)?.title ?? "", entry, deps.refsClose, deps, () => deps.save(state))) {
        delete state.roadmapStuck[key];
        settling.add(n);
      }
    }
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

  // The scope: steps whose issue is in one of the chosen GitHub milestones.
  // Steps outside it still gate readiness; this run just never starts them.
  const wanted = fullQueue ? [] : scopeMilestones(cfg);
  const stepSets = new Map<number, Set<string>>();
  const stepsOf = (m: RoadmapMilestone) => stepSets.get(m.number) ?? stepSets.set(m.number, roadmapScope(parsed.steps, states, m)).get(m.number)!;
  const scopeOf = (list: RoadmapMilestone[]) => ({ milestones: list.map((m) => ({ number: m.number, title: m.title, total: stepsOf(m).size })), steps: new Set(list.flatMap((m) => [...stepsOf(m)])) });
  const finishedIn = (steps: ReadonlySet<string>) => roadmapFinished(parsed, views.filter((v) => steps.has(v.step)));
  let scope = wanted.length > 0 ? scopeOf(wanted) : null;
  if (scope && scope.steps.size === 0) {
    state.roadmap = summarizeRoadmap({ issue: tracker, url: doc.url, parsed, views, scope, busy: busyIssues, needsUser: stuck, held: heldForUser, now: deps.now() });
    state.phase = "idle";
    return fail(
      `no step of roadmap #${tracker} has its issue in ${wanted.length === 1 ? `milestone "${wanted[0]!.title}"` : `milestones ${wanted.map((m) => `"${m.title}"`).join(", ")}`} — check the issues' milestone on GitHub, or choose All milestones`,
    );
  }

  // What follows the scope. A finished milestone leaves the scope while
  // another is still being worked; once the scope can no longer fill its
  // slots the next milestone is offered to the owner — or, with "always
  // continue", added here and now. Adding never replaces: what is left of
  // the current milestones keeps running.
  let next: RoadmapNextMilestone | null = null;
  // Started cards that stopped on a block, by issue: parked in the
  // blocked-step wait queue (retried by itself — in flight, but filling no
  // slot) or the owner's.
  const leaseLabels = deps.leaseLabels?.(cfg.project) ?? [];
  const blockedCards = new Map<number, RoadmapBlockedCard>();
  for (const t of all) {
    if (t.pipelineParentId || !live(t) || exempt.has(t.id) || !sameDir(t.workdir, cfg.project)) continue;
    const n = issueOf(t);
    const b = n != null && !blockedCards.has(n) ? blockedCardLine(t, deps.now(), leaseLabels) : null;
    if (n != null && b) blockedCards.set(n, { taskId: t.id, ...b });
  }
  const parked = new Set([...blockedCards].filter(([, b]) => b.queued).map(([n]) => n));
  const offerFor = (list: RoadmapMilestone[], sc: { steps: ReadonlySet<string> }, busyNow: ReadonlySet<number> = busyIssues) =>
    roadmapContinuation({ views, states, milestones: list, steps: sc.steps, busy: busyNow, exclude: new Set([...stuck.keys(), ...settling]), parked, maxInFlight: cfg.maxInFlight, finished: finishedIn(sc.steps), dismissal: state.roadmapOffer });
  if (scope) {
    let active = wanted.filter((m) => stepsOf(m).size > 0 && !finishedIn(stepsOf(m)));
    let list = active.length > 0 ? active : wanted;
    scope = scopeOf(list);
    next = offerFor(list, scope);
    for (let i = 0; cfg.autoContinue && next?.reason && active.length < MAX_SCOPE_MILESTONES && i < 4 && !deps.outdated(); i++) {
      const m = { number: next.number, title: next.title };
      const from = next;
      active = [...active, m];
      list = active;
      scope = scopeOf(list);
      state.roadmapContinued = [...state.roadmapContinued, { ...m, stage: from.stage, at: deps.now(), by: "auto" as const }].slice(-10);
      deps.notify({
        title: "Roadmap: continued into the next milestone",
        body: `${m.title} — ${from.steps} step${from.steps === 1 ? "" : "s"} added to the Backlog (${from.current} ${from.reason === "finished" ? "finished" : from.reason === "nothing-left" ? "had nothing left to start" : from.reason === "blocked" ? "had nothing that could start yet" : `had ${from.left} left to start`})`,
      });
      next = offerFor(list, scope);
    }
    const key = (xs: RoadmapMilestone[]) => xs.map((m) => m.number).join(",");
    if (key(list) !== key(wanted)) deps.setScope(list);
  }
  const scoped = scope ? views.filter((v) => scope!.steps.has(v.step)) : views;

  let free = fullQueue ? Math.min(deps.cardFree?.()??cfg.maxInFlight-Math.max(ownLive,inFlight.length),deps.runnerFree?.()??Infinity)
    : cfg.maxInFlight - Math.max(ownLive, inFlight.length);
  // The started live card of each issue, for the status' links.
  const liveCards = new Map<number, string>();
  for (const t of all) {
    const n = t.pipelineParentId || !live(t) || exempt.has(t.id) || !sameDir(t.workdir, cfg.project) ? null : issueOf(t);
    if (n != null && !liveCards.has(n)) liveCards.set(n, t.id);
  }
  const picks = pickRoadmap(scoped, { busy: busyIssues, exclude: new Set([...stuck.keys(), ...settling]), free:fullQueue?scoped.length:free });
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
  const startedIds = new Map<number, string>();

  const bugsNeedYou: RoadmapStatus["needsUser"] = [];
  // The bug lane: open `bug` issues outside the roadmap start first, a few
  // at a time (src/shared/bug-lane.ts). They take slots the roadmap would.
  if (fullQueue && deps.bugs && pipelineId && !quotaWait && free > 0 && !deps.outdated()) {
    const found = await deps.bugs(cfg.project);
    if (found && "error" in found) error = `bug lane: ${found.error}`;
    else if (found) {
      const projectCards = all.filter((t) => !t.pipelineParentId && t.archivedAt == null && sameDir(t.workdir, cfg.project));
      // A card whose run has finished takes no lane slot, wherever it sits.
      const finished = (t: Task) => !live(t) || t.pipelineRun?.status === "done";
      const cards = projectCards.flatMap((t) => { const n = issueOf(t); return n == null ? [] : [{ issue: n, live: !finished(t) }]; });
      const roadmapIssues = new Set(views.map((v) => v.issue));
      const pick = pickBugs({ open: found.open, config: found.config, roadmap: roadmapIssues, cards, free });
      // Autopilot's cards outside the roadmap (the bug lane's) that finished
      // without a PR and whose issue has since closed are done.
      const settled = projectCards.filter((t) => {
        const n = issueOf(t);
        return n != null && state.cards.includes(t.id) && t.column === "review" && finished(t) && !t.prUrl
          && !roadmapIssues.has(n) && !found.open.some((b) => b.number === n);
      });
      if (settled.length > 0) {
        const st = await deps.loadStates(cfg.project, settled.map((t) => issueOf(t)!)).catch(() => null);
        for (const t of settled) {
          const issue = st && !("error" in st) ? st.get(issueOf(t)!) : null;
          if (issue?.state !== "CLOSED") continue;
          deps.moveToDone(t);
          deps.activity(t.id, `Autopilot: #${issueOf(t)} is closed and this card finished without a PR — moved it to Done`, "info");
        }
      }
      // A bug whose card finished without a PR while the issue stays open —
      // typically "already fixed on develop" — is the owner's to settle.
      for (const bug of found.open) {
        if (roadmapIssues.has(bug.number)) continue;
        const t = projectCards.find((c) => issueOf(c) === bug.number && finished(c) && !c.prUrl);
        if (!t || !deps.hasNoPr(t) || (await deps.aheadCount(t).catch(() => 1)) !== 0) continue;
        const last = t.pipelineRun?.history.at(-1)?.handoff?.summary ?? "";
        bugsNeedYou.push({ step: "bug", issue: bug.number, title: bug.title, url: t.issueUrl ?? null, kind: "stuck" as const,
          reason: "its bug card finished without a change or PR, and the issue is still open — close it or reopen the work",
          pr: null, prUrl: null, detail: last ? displayText(last, 300) : null, taskId: t.id });
      }
      for (const bug of pick.start) {
        if (deps.outdated() || (deps.runnerFree?.() ?? Infinity) <= 0 || (deps.cardFree?.() ?? Infinity) <= 0) break;
        const r = await deps.startCard({ dir: cfg.project, number: bug.number, pipelineId, extraPrompt: bugCardPrompt(bug, found.config.label) });
        if ("error" in r) {
          error ??= `bug #${bug.number}: ${r.error}`;
          continue;
        }
        free -= 1;
        state.cards.push(r.task.id);
        deps.save(state);
        deps.activity(r.task.id, `Autopilot started this for bug #${bug.number}, ahead of roadmap cards (bug lane: at most ${found.config.max} at once)`, "info");
      }
    }
  }

  if (picks.start.length > 0 && !quotaWait) {
    if (!pipelineId) error = noPipeline;
    else {
      for (const v of picks.start) {
        if (deps.outdated()) break;
        if(started.size>=free || (fullQueue&&((deps.runnerFree?.()??Infinity)<=0||(deps.cardFree?.()??Infinity)<=0)))break;
        const basePrompt = roadmapStepPrompt(tracker, v, parsed.steps, { prior: priorOf(v.issue) });
        const dispatchRecord=queue?.records.find(r=>r.issue===v.issue);
        const stepPrompt=queue?`${basePrompt}\n\nDispatch graph ${queue.version}; owning contract revision ${dispatchRecord?.updatedAt}; SHA-256 ${dispatchRecord?.bodyHash}. The attached earlier issue snapshot is historical if it differs. Current controlling contract at dispatch:\n\n${states.get(v.issue)?.body??''}`:basePrompt;
        const card = backlog.get(v.issue);
        const validate=queue&&deps.validator?deps.validator(cfg.project,tracker,queue,v.issue,card?.id):undefined;
        if(validate){const reason=await validate();if(reason){error??=`step ${v.step} (#${v.issue}): ${reason}`;continue;}}
        let id: string;
        if (card) {
          if(queue)deps.freeze?.(cfg.project,tracker,queue,v.issue,card.id);
          const r = await deps.startExisting({ task: card, stepPrompt,validate });
          if ("error" in r) {
            // Still in the backlog, still in the ledger: the next pass tries again.
            error = `step ${v.step} (#${v.issue}): ${r.error}`;
            continue;
          }
          id = card.id;
          backlog.delete(v.issue);
          delete state.roadmapBacklog[String(v.issue)];
        } else {
          const r = await deps.startCard({ dir: cfg.project, number: v.issue, pipelineId, extraPrompt: stepPrompt,validate,onCreated:queue?(t)=>deps.freeze?.(cfg.project,tracker,queue,v.issue,t.id):undefined });
          if ("error" in r) {
            error = `step ${v.step} (#${v.issue}): ${r.error}`;
            continue;
          }
          id = r.task.id;
        }
        started.add(v.issue);
        startedIds.set(v.issue, id);
        state.cards.push(id);
        deps.save(state);
        deps.activity(id, `Autopilot started this as step ${v.step} of roadmap #${tracker}${state.roadmapRedo[String(v.issue)] ? " — again, at your request" : ""}`, "info");
      }
    }
  }

  // Backlog cards up front: with a milestone, every open step in it that has
  // no live card gets one, not started — the owner's steps too. Idempotent:
  // a step added to the milestone later gets its card on the next pass.
  if (scope || fullQueue) {
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
    if (missing.length > BACKLOG_PER_PASS && !fullQueue) deps.recheck(5_000);
  }

  // The offer as it stands after this pass's starts.
  if (scope) {
    next = offerFor(scope.milestones, scope, new Set([...busyIssues, ...started]));
    // A "not now" belongs to the milestone it was said to.
    if (state.roadmapOffer && state.roadmapOffer.milestone !== next?.number) state.roadmapOffer = null;
    if (cfg.autoContinue) {
      // This pass's starts made it due: the next pass adds the milestone.
      if (next?.reason && scope.milestones.length < MAX_SCOPE_MILESTONES && !deps.outdated()) deps.recheck(5_000);
    } else if (offerPending(next) && !state.notifiedOffer.includes(next.number)) {
      // Asked once per milestone, with a native notification; the board's
      // popup and `agetor roadmap status` carry it from the status.
      if (deps.notify({ title: "Roadmap: start the next milestone?", body: nextMilestoneText(next).question })) state.notifiedOffer = [...state.notifiedOffer, next.number].slice(-50);
    }
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
    cards: new Map([...liveCards, ...startedIds]),
    blocked: blockedCards,
    nextMilestone: next,
    continued: state.roadmapContinued.slice(-3),
    now: deps.now(),
  });
  if(fullQueue) {
    status.projectWide=true;
    const measured=runnerUse(isTaskRunLive),slots=currentSlots();
    status.runners={used:measured.total,max:slots.max,heavy:measured.heavy,heavyMax:slots.heavy.max};
  }
  if (!status.idleReason && quotaWait && picks.start.length > 0) status.idleReason = "Holding new starts while a card waits for a usage limit to reset";
  // The table's milestone column and GitHub disagreeing is worth knowing: a
  // step the table puts in this milestone isn't worked unless its issue is.
  if (scope) {
    const single = scope.milestones.length === 1;
    const reported = new Set<string>();
    for (const m of scope.milestones) {
      for (const s of scopeDrift(parsed.steps, states, m)) {
        if (reported.has(s.step)) continue;
        reported.add(s.step);
        const inIt = scope.steps.has(s.step);
        const gh = states.get(s.issue)?.milestone?.title;
        status.problems = [
          ...status.problems,
          {
            kind: "milestone-mismatch",
            step: s.step,
            message: inIt
              ? `step ${s.step} (#${s.issue}) is in ${single || !gh ? "this milestone" : `milestone "${gh}"`} on GitHub, but the table says ${s.milestone || "none"} — it is worked`
              : `step ${s.step} (#${s.issue}): the table says ${s.milestone}, but its issue isn't in ${single ? "this milestone" : "that milestone"} on GitHub — it is not worked`,
          },
        ];
      }
    }
  }
  if (bugsNeedYou.length > 0) status.needsUser = [...status.needsUser, ...bugsNeedYou];
  state.roadmap = status;
  state.lastError = error ?? (queue?.errors.length ? queue.errors.join('; ') : null);

  // Velocity: what completed, and how full the slots are right now.
  if (deps.velocity) {
    const exclude = new Set([...stuck.keys(), ...settling]);
    const agentOpen = scoped.filter((v) => isOpenStep(v) && !v.human);
    const startedNow = (v: RoadmapStepView) => busyIssues.has(v.issue) || started.has(v.issue);
    const readyLeft = agentOpen.filter((v) => v.status === "ready" && !startedNow(v) && !exclude.has(v.issue)).length;
    const used = Math.min(cfg.maxInFlight, Math.max(ownLive, inFlight.length) + started.size);
    const holding = !!quotaWait && picks.start.length > 0;
    const liveTasks = new Map<number, Task>();
    for (const [n, id] of liveCards) {
      const t = all.find((x) => x.id === id);
      if (t && openByIssue.has(n) && !neverStarted(t)) liveTasks.set(n, t);
    }
    try {
      deps.velocity({
        tracker,
        project: cfg.project,
        now: deps.now(),
        maxInFlight: cfg.maxInFlight,
        steps: views.map((v) => ({
          step: v.step,
          issue: v.issue,
          title: displayText(v.title, 100),
          stage: v.milestone.trim(),
          human: v.human,
          preds: v.predecessors,
          status: v.status === "complete" ? "complete" : v.status === "declined" ? "declined" : "open",
          closedAt: states.get(v.issue)?.closedAt ?? null,
        })),
        scope: scope ? { label: scopeLabel(scope.milestones), steps: [...scope.steps] } : null,
        sample: {
          max: cfg.maxInFlight,
          used,
          // Idle slots, and nothing in scope that could fill them.
          blocked: used < cfg.maxInFlight && readyLeft === 0 && !holding && agentOpen.some((v) => !startedNow(v)),
          quota: holding,
          ready: readyLeft,
          held: heldForUser.size + stuck.size + status.humanReady.length,
        },
        live: liveTasks,
        held: new Set(heldForUser.keys()),
        quota: new Set([...liveTasks].filter(([, t]) => waitingOnQuota(t.pipelineRun) || deps.quotaPaused(t)).map(([n]) => n)),
        stuck: new Map(Object.entries(state.roadmapStuck).map(([k, v]) => [Number(k), { at: v.at, cardId: v.cardId ?? null }])),
      });
    } catch {
      // the ledger is a convenience, never a reason for a pass to fail
    }
  }

  // One notification per `[Human]` step, the first time it's ready.
  for (const h of status.humanReady) {
    if (state.notifiedHuman.includes(h.issue)) continue;
    if (deps.notify({ title: "Roadmap: a step needs you", body: `Step ${h.step} · #${h.issue} ${h.title}` })) state.notifiedHuman.push(h.issue);
  }

  // Every milestone in scope is finished: done — unless a milestone follows
  // and the owner hasn't answered the offer yet.
  if (roadmapFinished(parsed, scoped)) {
    state.phase = offerPending(next) ? "idle" : "done";
    if (offerPending(next)) status.idleReason = `Waiting for your answer: ${nextMilestoneText(next).question}`;
  }
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

// ── Continuing into the next milestone ───────────────────────────────────

export type RoadmapContinueAction = "accept" | "always" | "dismiss";

/**
 * The owner's answer to the next-milestone offer in the last pass's status
 * (`state.roadmap.nextMilestone`):
 *
 *   accept  — add that milestone to the scope. Nothing is replaced: what is
 *             left of the current milestones keeps running, and the next
 *             pass makes the new milestone's Backlog cards. Also allowed
 *             before the offer is due (an explicit request).
 *   always  — accept, and from now on continue without asking
 *             (`autoContinue`). With nothing on offer it sets the flag only.
 *   dismiss — "not now": the offer comes back only at a later stage (nothing
 *             left to start, then the scope finished).
 *
 * Mutates `state` and returns the config to save. Pure but for that;
 * exported for tests.
 */
export function continueRoadmap(
  cfg: AutopilotConfig,
  state: AutopilotState,
  action: RoadmapContinueAction,
  now: number,
): { ok: true; config: AutopilotConfig; message: string } | { error: string } {
  if (!cfg.roadmap || !cfg.project) return { error: "Autopilot isn't working a roadmap" };
  if (action !== "accept" && action !== "always" && action !== "dismiss") return { error: `unknown action "${String(action)}" — accept, always or dismiss` };
  const list = scopeMilestones(cfg);
  const offer = currentRoadmapStatus(cfg, state.roadmap)?.nextMilestone ?? null;
  if (action === "always" && !offer?.reason) {
    return {
      ok: true,
      config: { ...cfg, autoContinue: true },
      message: list.length === 0 ? "Always continue is on — it only matters with a milestone scope (the whole roadmap is in scope now)" : "Always continue is on: Autopilot adds the next milestone by itself once this one can no longer fill its slots",
    };
  }
  if (!offer) return { error: list.length === 0 ? "the whole roadmap is in scope — no milestone follows it" : "no milestone follows the scope (or the first pass hasn't finished yet)" };
  if (action === "dismiss") {
    if (!offer.reason) return { error: `${offer.title} isn't on offer yet` };
    state.roadmapOffer = { milestone: offer.number, reason: offer.reason, at: now };
    state.roadmap = { ...state.roadmap!, nextMilestone: { ...offer, dismissedAt: now } };
    const again = offer.reason === "finished" ? "not asked again — agetor roadmap continue starts it" : offer.reason === "nothing-left" ? `asked again when ${offer.current} is finished` : `asked again when ${offer.current} has nothing left to start`;
    return { ok: true, config: cfg, message: `Not now: ${offer.title} stays out of the scope (${again})` };
  }
  if (list.some((m) => m.number === offer.number)) return { error: `${offer.title} is already in scope` };
  if (list.length >= MAX_SCOPE_MILESTONES) return { error: `the scope already holds ${list.length} milestones` };
  const milestones = [...list, { number: offer.number, title: offer.title }];
  state.roadmapContinued = [...state.roadmapContinued, { number: offer.number, title: offer.title, stage: offer.stage, at: now, by: "you" as const }].slice(-10);
  state.roadmapOffer = null;
  // A finished run has something to do again.
  if (state.phase === "done") state.phase = "idle";
  // The last pass's status stays the board's until the next pass rewrites
  // it (the cards keep their lines meanwhile): it now belongs to the wider
  // scope, with the offer answered.
  const before = state.roadmap!;
  state.roadmap = {
    ...before,
    nextMilestone: null,
    scope: before.scope ? { ...before.scope, milestones: [...(before.scope.milestones?.length ? before.scope.milestones : [{ number: before.scope.number, title: before.scope.title, total: before.counts.total }]), { number: offer.number, title: offer.title, total: offer.steps }] } : before.scope,
  };
  const can = offer.agentSteps === 0 ? "all of them yours to do" : offer.startable > 0 ? `${offer.startable} can start now` : `none can start yet — waiting on ${offer.waitingOn ?? "unfinished steps"}`;
  return {
    ok: true,
    config: { ...cfg, milestones, milestone: milestones[0]!, autoContinue: action === "always" ? true : cfg.autoContinue },
    message: `${offer.title} is in scope with ${scopeLabel(list)}: ${offer.steps} step${offer.steps === 1 ? "" : "s"} get a Backlog card (${can})${action === "always" ? ". Always continue is on" : ""}`,
  };
}

/**
 * `POST /autopilot/roadmap/continue`: apply the owner's answer between
 * passes (a pass at work holds its own copy of the state and the scope),
 * save, and ask for a pass. Not a fresh run: holds, cards and the ledger
 * stay as they are.
 */
export async function applyRoadmapContinue(action: RoadmapContinueAction): Promise<{ ok: true; message: string } | { error: string }> {
  for (let i = 0; busy && i < 240; i++) await new Promise((r) => setTimeout(r, 500));
  if (busy) return { error: "Autopilot is in the middle of a long pass — try again in a minute" };
  busy = true;
  try {
    normalizeLegacyConfig();
    const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
    const state = readState();
    const r = continueRoadmap(cfg, state, action, Date.now());
    if ("error" in r) return r;
    preferences.set(AUTOPILOT_PREF, JSON.stringify(r.config));
    writeState(state);
    return { ok: true, message: r.message };
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
  loadQueue:loadCanonicalQueue,
  runnerFree:()=>Math.max(0,currentSlots().max-runnerUse(isTaskRunLive).total),
  cardFree:()=>Math.max(0,Math.min(parseConfig(preferences.get(AUTOPILOT_PREF)).maxInFlight,currentSlots().max)-activeCardOwners(isTaskRunLive).size),
  validator:queueValidator,
  freeze:freezeCardInputs,
  loadTracker: loadRoadmapTracker,
  loadStates: loadRoadmapStates,
  async bugs(project) {
    const config = parseBugLane(preferences.get(BUG_LANE_PREF));
    if (!config) return null;
    const r = await run(["gh", "issue", "list", "--state", "open", "--label", config.label, "--json", "number,title,labels", "--limit", "100"], project, 30_000, process.env);
    if (!r.ok) return { error: (r.stderr || r.stdout || "gh issue list failed").trim().slice(-200) };
    try {
      const open = (JSON.parse(r.stdout) as { number: number; title: string; labels: { name: string }[] }[])
        .map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name) }));
      return { config, open };
    } catch {
      return { error: "gh issue list returned unreadable JSON" };
    }
  },
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
  refsClose: {
    policy(project) {
      if (decisionPolicyForProject(preferences.get(PIPELINE_DECISIONS_PREF), project) !== "agent-followups") return null;
      const p = parseRefsClosePref(preferences.get(REFS_CLOSE_PREF));
      return p.mode === "off" ? null : p;
    },
    async findFollowup(project, marker) {
      const needle = marker.replace(/^<!--\s*|\s*-->$/g, "");
      const r = await run(["gh", "issue", "list", "--state", "all", "--search", `"${needle}" in:body`, "--json", "number,url,body", "--limit", "10"], project, 30_000, process.env);
      if (!r.ok) return { error: (r.stderr || r.stdout || "gh issue list failed").trim().slice(-200) };
      try {
        const hit = (JSON.parse(r.stdout) as { number: number; url: string; body?: string }[]).find((x) => (x.body ?? "").includes(marker));
        return hit ? { number: hit.number, url: hit.url } : null;
      } catch {
        return { error: "gh issue list returned unreadable JSON" };
      }
    },
    async createFollowup(project, input) {
      const create = (label: string | null) =>
        run(["gh", "issue", "create", "--title", input.title, "--body", input.body, ...(label ? ["--label", label] : []), ...(input.milestone ? ["--milestone", input.milestone] : [])], project, 30_000, process.env);
      let r = await create(input.label);
      if (!r.ok && input.label) r = await create(null); // a label the repository lacks
      if (!r.ok) return { error: (r.stderr || r.stdout || "gh issue create failed").trim().slice(-200) };
      const url = r.stdout.trim().split(/\s+/).find((w) => /\/issues\/\d+$/.test(w)) ?? "";
      const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
      return Number.isSafeInteger(number) && number > 0 ? { number, url } : { error: `gh issue create printed no issue URL: ${r.stdout.trim().slice(0, 120)}` };
    },
    async closeIssue(project, issue, comment) {
      const r = await run(["gh", "issue", "close", String(issue), "--reason", "completed", "--comment", comment], project, 30_000, process.env);
      return r.ok ? { ok: true } : { error: (r.stderr || r.stdout || "gh issue close failed").trim().slice(-200) };
    },
  },
  handsOff: () => new Set(readHandsOff()),
  quotaPaused: quotaPausedCard,
  leaseLabels: (project) => listLeases().filter((l) => sameDir(l.project, project)).map((l) => l.label),
  pipelineId: (cfg) => cfg.pipelineId ?? preferences.get("default_pipeline") ?? null,
  async startCard(input) {
    const r = await createTaskFromIssue({ ...input, allowAfterDone: true });
    return "error" in r ? { error: r.error } : { task: r.task };
  },
  async createBacklogCard(input) {
    const r = await createTaskFromIssue({ ...input, start: false, allowAfterDone: true });
    return "error" in r ? { error: r.error } : { task: r.task };
  },
  async startExisting({ task, stepPrompt,validate }) {
    // The step section was written when the card was made; say what holds now.
    const fresh = tasks.get(task.id);
    if (!fresh || fresh.archivedAt != null) return { error: "its backlog card is gone" };
    tasks.update(task.id, { prompt: withRoadmapStepPrompt(fresh.prompt, stepPrompt) });
    const r = await startTask(task.id,{validate});
    return "error" in r ? { error: `its backlog card didn't start: ${r.error}` } : { ok: true };
  },
  moveToDone: (t) => void tasks.update(t.id, { column: "done" }),
  save: (state) => savePassState(state),
  outdated: () => passOutdated(),
  setScope(milestones) {
    // Only the scope: whatever else was saved meanwhile (the slot count, a
    // pause) stands. A run that was changed meanwhile isn't this pass's.
    if (passRun && passRun.epoch !== runEpoch) return false;
    const cur = parseConfig(preferences.get(AUTOPILOT_PREF));
    preferences.set(AUTOPILOT_PREF, JSON.stringify({ ...cur, milestones, milestone: milestones[0] ?? null }));
    return true;
  },
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
  velocity: (input) => void recordVelocityPass(input),
  now: () => Date.now(),
};

let busy = false;

/** One pass. Exported for tests and the "run now" button. */
export async function autopilotTick(): Promise<void> {
  const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
  if ((!cfg.enabled&&!cfg.autoMergePipelines) || !cfg.project || busy) return;
  // Tracker mode needs neither a milestone nor the thread.
  if (!cfg.roadmap && (!cfg.threadId || !cfg.milestone)) return;
  const cycle=cfg.enabled&&cfg.roadmap?.issue===639?beginQueueCycle(cfg.project,639):null;
  if(cfg.enabled&&cfg.roadmap?.issue===639&&!cycle)return;
  busy = true;
  passRun = { epoch: runEpoch, project: cfg.project };
  const state = readState();
  const cardsBefore=state.cards.length;
  try {
    // A finished milestone stays finished until the user restarts Autopilot.
    if (state.phase === "done"&&!cfg.roadmap) return;
    if (state.phase === "idle") state.phase = "running";
    const all = tasks.listLive();
    const mine = state.cards.map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t && t.archivedAt == null);
    state.cards = mine.map((t) => t.id);

    // Sign finished cards off: Ready to Merge, unless the PR changes
    // sensitive code. Forget the withdrawn sign-offs of cards that are gone.
    const withdrawn = readHandsOff();
    const stillThere = withdrawn.filter((id) => all.some((t) => t.id === id && t.archivedAt == null && t.column !== "done"));
    if (stillThere.length !== withdrawn.length) preferences.set(HANDS_OFF_PREF, JSON.stringify(stillThere));
    const marks = readHandsOffMarks();
    const keptMarks = Object.fromEntries(Object.entries(marks).filter(([id]) => stillThere.includes(id)));
    if (Object.keys(keptMarks).length !== Object.keys(marks).length) writeHandsOffMarks(keptMarks);
    const reviewed=cfg.autoMergePipelines?all.filter(t=>reviewedPillarPipeline(t,cfg,SIGN_OFF_DEPS.prStatus(t.id))):[];
    await signOffPass(state,[...new Map([...mine,...reviewed].map(t=>[t.id,t])).values()],SIGN_OFF_DEPS,cfg);
    if(!cfg.enabled)return; // lifecycle sign-off never enables new admissions

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
    // Cleanup cannot depend on a final write succeeding. A bounded busy
    // failure retains durable wake intent, not a permanently busy process.
    const finishingPass=passRun;passRun = null;
    busy = false;
    let saveError:unknown=null;
    try{savePassState(state,finishingPass);}catch(error){saveError=error;}
    if(cycle) {
      let outcome:'error'|'progress'|'full'|'empty'=state.lastError||saveError?'error':state.cards.length>cardsBefore?'progress':'empty';
      try{if(outcome==='empty'&&(ROADMAP_DEPS.runnerFree?.()??0)<=0)outcome='full';}catch(error){if(!isSqliteBusy(error))saveError??=error;outcome='error';}
      let delay=30_000;
      try{delay=completeQueueCycle(cycle,outcome);}catch(error){if(!isSqliteBusy(error))throw error;}
      ROADMAP_DEPS.recheck(saveError?30_000:delay);
    }
    if(saveError&&!isSqliteBusy(saveError))throw saveError;
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
  // The scope is `milestones`. A patch that names only `milestone` (the
  // dialog's one choice, `agetor roadmap start --milestone`, an older
  // client) sets the scope to that one milestone.
  const scopePatch =
    "milestones" in body
      ? (() => {
          const list = normalizeMilestones(body.milestones);
          return { milestones: list, milestone: list[0] ?? null };
        })()
      : "milestone" in body
        ? { milestones: [] }
        : {};
  const mergePolicy=body.autoMergePipelines===true?{autoMergePipelines:true,autoMergeSince:cur.autoMergePipelines?cur.autoMergeSince:Date.now()}
    :body.autoMergePipelines===false?{autoMergePipelines:false,autoMergeSince:undefined}: {autoMergePipelines:cur.autoMergePipelines,autoMergeSince:cur.autoMergeSince};
  const next = parseConfig(JSON.stringify({ ...cur, ...body, ...scopePatch,...mergePolicy }));
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
  const scopeKey = (c: AutopilotConfig) => c.milestones.map((m) => m.number).join(",");
  const milestoneChanged = scopeKey(cur) !== scopeKey(next);
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
        // A scope chosen by hand starts the next-milestone question over.
        ...(roadmapChanged || scopeChanged ? { roadmapOffer: null, notifiedOffer: [], roadmapContinued: [] } : {}),
        // The ledger is keyed by issue number, which means another issue in
        // another project.
        ...(projectChanged ? { roadmapBacklog: {} } : {}),
      }),
    );
  } else if (next.autoContinue && !cur.autoContinue) {
    // "Always continue" switched on for a run that finished with a
    // milestone still to follow: it has something to do again.
    const s = readState();
    if (s.phase === "done" && currentRoadmapStatus(next, s.roadmap)?.nextMilestone) preferences.set(AUTOPILOT_STATE_PREF, JSON.stringify({ ...s, phase: "idle" }));
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
    if (cfg.milestone) preferences.set(AUTOPILOT_PREF, JSON.stringify({ ...cfg, milestone: null, milestones: [] }));
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
    try{const s=readState();s.lastError=(e as Error).message;writeState(s);}catch(error){if(!isSqliteBusy(error))throw error;}
    if(isSqliteBusy(e))requestAutopilotPass(30_000);
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
  if (e.kind === "pipeline") return e.status === "blocked" || e.status === 'done' || e.status === 'cancelled';
  if(e.kind==='run-status')return e.status==='succeeded'||e.status==='failed'||e.status==='cancelled';
  if (e.kind !== "column" || !e.column) return false;
  return e.column === "done" || (!!e.prev && BUILDING.has(e.prev) && !PROGRESSING_COLUMNS.has(e.column));
}

export function startAutopilot(): void {
  if (loop) return;
  normalizeLegacyConfig();
  const enabled = () => parseConfig(preferences.get(AUTOPILOT_PREF)).enabled;
  subscribeGlobal((e) => {
    if (freesSlot(e as never) && enabled()) requestAutopilotPass();
    if(e.kind==='pipeline'&&e.status==='done'&&parseConfig(preferences.get(AUTOPILOT_PREF)).autoMergePipelines)requestAutopilotPass();
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
  requestAutopilotPass(Math.min(30_000,restoredQueueDelay()));
}
