/**
 * The pipeline runner (T3, `docs/plans/pipelines.md` §3/§4). Turns a
 * {@link Pipeline} template into a running, hidden graph of **step tasks**
 * sharing the pipeline task's (the "parent"'s) worktree: `startPipelineRun`
 * launches the graph's start step, a `subscribeGlobal` listener registered
 * by `initPipelineRunner` watches every step task's settle/column events and
 * advances the graph — parsing each step's `<handoff>` (`src/shared/
 * pipeline.ts`), resolving fan-out/fan-in per the graph's edges, and either
 * launching the next step(s), recording the run done, or blocking with a
 * reason a human (or a retry) can act on. `advancePipeline`/
 * `retryPipelineStep`/`cancelPipelineRun` are the three manual interventions
 * `server.ts`'s routes expose; `cascadePipelineDelete`/`cascadePipelineArchive`
 * back `orchestrator.ts`'s `deleteTask`/`archiveTask` cascades (D1/D9);
 * `reconcilePipelineRuns` is the boot-time (or test-time) self-heal for a
 * step settle the runner's listener missed entirely (M16).
 *
 * This module and `orchestrator.ts` reference each other's exports (the
 * runner needs `subscribeGlobal`/`startTask`/`cancelRun`/`deleteTask`/
 * `archiveTask`/`defaultEffortFor`/`isTaskRunLive`/`pipelineUpdateColumn`;
 * `orchestrator.ts`'s `startTaskInner`/`deleteTask`/`archiveTask`/
 * `createTask` need `startPipelineRun`/`cascadePipelineDelete`/
 * `cascadePipelineArchive`/`withPipelineLock`/`initialPipelineRunState`) — a
 * static import cycle, but a safe one: every cross-reference on both sides
 * is used inside a function body, never at module top-level, so by the time
 * either side's code actually runs both modules have finished evaluating.
 * `initPipelineRunner` itself is never auto-invoked at module load (unlike,
 * say, `wireInteractionBroadcast()` in orchestrator.ts) — `index.ts`/
 * `headless.ts` call it explicitly, once, right before `reconcileOrphans()`.
 */
import { randomUUID } from "node:crypto";
import { recordActivity } from "./activity.ts";
import { syncBaseNote } from "./sync-base.ts";
import { logBlocks, newBlocks } from "./block-log.ts";
import { isMergeQueued } from "./merge-intent.ts";
import { currentSlots, slotDecision, slotUse } from "./step-slots.ts";
import { reserveRunner, releaseUnspawnedRunner } from './dispatch-claims.ts';
import { reconcileCardInputs } from './queue-validation.ts';
import { isPriority, priorityFirst } from "./priority.ts";
import { awaitsFor } from "./awaits.ts";
import { classifyFailure, formatRetryTime, harnessQuotaNotice, isQuotaPaused, nextRetryAt, TRANSIENT_RETRY_MAX, type FailureClass } from "./usage-limit.ts";
import { listLeases } from "./lease-watch.ts";
import { ownFailures, prStatusForTask } from "./pr-watch.ts";
import { run as runCommand } from "./github.ts";
import { waitingOnQuota } from "../shared/autopilot.ts";
import { decisionPolicyForProject, PIPELINE_DECISIONS_PREF, plannerDecisionInstructions } from "../shared/pipeline-decisions.ts";
import {
  BLOCK_WAIT_PREF,
  classifyBlock,
  escalationLine,
  fmtSpan,
  issueRef,
  parseBlockWaitConfig,
  planWait,
  triedLine,
  waitHasTrigger,
  waitLine,
  type BlockSignals,
  type BlockVerdict,
  type WaitingRow,
} from "../shared/block-wait.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentProfiles, backlog, dataDir, db, harnesses, pipelines, preferences, runs, tasks } from "./db.ts";
import {
  appendRunStatusLine,
  archiveTask,
  cancelRun,
  defaultEffortFor,
  deleteTask,
  isHeldByBackgroundAgents,
  isTaskRunCancelling,
  isTaskRunLive,
  pipelineUpdateColumn,
  publishGlobalEvent,
  sendInput,
  startTask,
  subscribeGlobal,
} from "./orchestrator.ts";
import { cancelPendingForTask, listPendingForTask } from "./interactions.ts";
import { prepareWorkdir } from "./worktree.ts";
import { composeLaunchPrompt, snapshotFromProfile } from "../shared/agent-profile.ts";
import {
  parseHandoff,
  blockedHandoffChoosesNext,
  classifyStepResponse,
  composeBlockedResumeNote,
  composeHandoffReminder,
  composeLimitResumeNote,
  composeStepPrompt,
  deriveRunStatus,
  effectiveStepCap,
  FOLLOW_UP_STEP_PREFIX,
  incomingSteps,
  isFollowUpStepId,
  normalizeHandoff,
  outgoingSteps,
  renderHandoffFile,
  renderReportFile,
  resolveNextSteps,
  resolveStartStep,
  stepNameById,
  stepReportFromMessages,
  validatePipelineGraph,
  updatedPipelineInstructions,
} from "../shared/pipeline.ts";
import { promptByteOverage } from "../shared/prompt-limits.ts";
import { appendReferences } from "../shared/refs.ts";
import type {
  AgentProfileSnapshot,
  ColumnId,
  GlobalEvent,
  Handoff,
  BlockWaitCategory,
  LeaseStatus,
  Pipeline,
  PipelineActiveStep,
  PipelineBlock,
  PipelineBlockWait,
  PipelineGraph,
  PipelineJoinArrival,
  PipelineRunSnapshot,
  PipelineRunState,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepRecord,
  PipelineStepReport,
  Task,
  TaskPrStatus,
  TaskReference,
} from "../shared/types.ts";

/** `dataDir/pipeline-runs/<parentId>` — where every step's handoff JSON
 *  (see D10) is written, and what `cascadePipelineDelete` removes wholesale. */
export function pipelineRunsDir(parentId: string): string {
  return join(dataDir, "pipeline-runs", parentId);
}

/** True for a hidden step task (`pipelineParentId` set) — the board, CLI
 *  `ls`/TUI, and every "can this be deleted/archived on its own?" guard use
 *  this to tell a step row apart from an ordinary (including pipeline
 *  parent) task. */
export function isPipelineStepTask(t: Task): boolean {
  return t.pipelineParentId != null;
}

/** Fresh, never-run state for a task just bound to `p` (`createTask`'s
 *  `pipelineId` path) — idle, no snapshot until the first Run. */
export function initialPipelineRunState(p: Pipeline): PipelineRunState {
  return {
    pipelineId: p.id,
    pipelineName: p.name,
    snapshot: null,
    status: "idle",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: null,
    endedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Per-parent serialization
// ---------------------------------------------------------------------------

/**
 * Every mutation of a given parent's `pipelineRun` — a manual route call
 * (`startPipelineRun`/`advancePipeline`/`retryPipelineStep`/
 * `cancelPipelineRun`) or an async settle/column event for one of its step
 * tasks — is serialized through this per-parent chain, so two events for
 * sibling steps (a fan-out's two branches settling moments apart) or a
 * manual advance racing a settle can never read-modify-write the same
 * `pipelineRun` JSON blob concurrently. `fn`'s return value (and any thrown
 * error) propagates to the caller unchanged; the chain itself never breaks
 * on a rejection — the next queued `fn` still runs.
 */
const parentChains = new Map<string, Promise<unknown>>();
// Recovery deliberately sends outside the parent lock. Keep its claim until
// that send/relaunch finishes so instruction edits cannot slip into the gap.
const recoveriesInFlight = new Set<string>();
function runExclusive<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (parentChains.get(parentId) ?? Promise.resolve()) as Promise<unknown>;
  const chained = prev.then(fn, fn);
  const guard = chained.then(() => {}, () => {});
  parentChains.set(parentId, guard);
  guard.finally(() => {
    if (parentChains.get(parentId) === guard) parentChains.delete(parentId);
  });
  return chained;
}

/**
 * Exported alias of the per-parent serialization above (M7) — `orchestrator.ts`'s
 * `deleteTask`/`archiveTask` run their pipeline cascades (`cascadePipelineDelete`/
 * `cascadePipelineArchive`) through this so a cascade can never interleave
 * with an in-flight settle/manual-route mutation for the same parent.
 */
export function withPipelineLock<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  return runExclusive(parentId, fn);
}

/**
 * Parent ids whose delete cascade (`cascadePipelineDelete`) has started —
 * set FIRST, before any step is torn down (M7). `launchStep` re-checks this
 * (and that the parent row still exists) right before inserting a new step
 * row, and again right after `startTask` returns, so a launch that raced a
 * delete can't leave an orphaned step task (or a freshly-spawned agent)
 * behind. Never cleared — parent ids are uuids and never reused, so this is
 * bounded by "how many pipeline tasks this process has ever deleted", not
 * unbounded churn.
 */
export const tombstonedPipelineParents = new Set<string>();

// ---------------------------------------------------------------------------
// Pure-ish helpers over a live (mutable, in-memory) PipelineRunState
// ---------------------------------------------------------------------------

/** Replace any existing blocked entry for `entry.taskId` (there's at most
 *  one at a time per execution) and push `entry`. A run-level block
 *  (`taskId: null` — `step-cap`/`profile-missing`/`join-incomplete`, or a
 *  run-level `step-failed` hold) is deduped by `(kind, stepId)` instead
 *  (M-C5): the same pending launch re-recorded by a second settle, retry, or
 *  reconcile pass replaces the earlier entry in place rather than stacking a
 *  duplicate the UI would list twice and `retryPendingBlocks` would
 *  re-launch twice. */
function upsertBlocked(run: PipelineRunState, entry: PipelineBlock): void {
  if (entry.taskId !== null) {
    run.blocked = run.blocked.filter((b) => b.taskId !== entry.taskId);
  } else {
    run.blocked = run.blocked.filter((b) => !(b.taskId === null && b.kind === entry.kind && b.stepId === entry.stepId));
  }
  run.blocked.push(entry);
}

function removeBlockedFor(run: PipelineRunState, taskId: string): void {
  run.blocked = run.blocked.filter((b) => b.taskId !== taskId);
}

/**
 * A follow-up started on a blocked run is the user moving past the block
 * (Finish stopped on a failing test → "Open PR" with instructions to fix it):
 * every block from an earlier execution is set aside — dropped from
 * `blocked`, and its stopped execution from `active` — so the run reads as
 * running (then done/blocked on the follow-up's own outcome) instead of
 * staying "blocked" on a step nobody is waiting for. The blocked step's
 * history record keeps its outcome. Returns the set-aside step names.
 * Exported for tests.
 */
export function supersedeBlocksBefore(run: PipelineRunState, seq: number): string[] {
  const seqOf = new Map(run.active.map((a) => [a.taskId, a.seq]));
  const stale = run.blocked.filter((b) => b.taskId === null || (seqOf.get(b.taskId) ?? -1) < seq);
  if (stale.length === 0) return [];
  const staleTasks = new Set(stale.map((b) => b.taskId).filter((id): id is string => id !== null));
  run.blocked = run.blocked.filter((b) => !stale.includes(b));
  run.active = run.active.filter((a) => !staleTasks.has(a.taskId) || isTaskRunLive(a.taskId));
  // A join-incomplete block's pending arrivals are what it was waiting on.
  for (const b of stale) if (b.taskId === null && b.stepId) delete run.joins[b.stepId];
  const graph = run.snapshot?.graph;
  return stale.map((b) => (graph && b.stepId ? stepNameById(graph, b.stepId) : (b.stepId ?? "a step")));
}

/**
 * Automatic retry of a step that stopped for a reason no person needs to
 * decide on, so an unattended board keeps going overnight:
 *
 * - `quota` — the account hit its usage limit (src/bun/usage-limit.ts has the
 *   exact claude/codex messages). The card waits for the limit to reset: the
 *   retry fires at the parsed reset time plus a margin, or with a 15 → 30 →
 *   60 minute backoff when no time was given, and never gives up.
 * - `transient` — the session crashed or was lost, an API overload/5xx, a
 *   launch flake ("claude session JSONL never appeared"). Up to
 *   {@link TRANSIENT_RETRY_MAX} retries, 1 → 5 → 15 → 30 minutes apart; after
 *   that the block stays for a person.
 *
 * The schedule is persisted on the run (`run.autoRetry`) and re-armed after a
 * core restart (`rearmPipelineAutoRetries`). A step that hands off "blocked"
 * for a real reason, a step-cap/profile-missing/merge-conflict block, or a
 * Stop the user pressed never comes through here. Callers persist `run`.
 */
export { TRANSIENT_RETRY_MAX };
const autoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The last few status/stderr/assistant rows of a turn — what a usage-limit
 *  or API error left — for `classifyFailure`. */
function failureTextFrom(events: MainStreamEvent[], max = 12): string {
  return events
    .filter((e) => e.stream === "status" || e.stream === "stderr" || e.stream === "assistant")
    .slice(-max)
    .map((e) => e.data.slice(0, 1_000))
    .join("\n");
}

/** Usage-limit evidence in a turn that ended normally (claude's mid-turn
 *  grace window makes the agent stop and hand off "blocked"): only claude's
 *  own notices (status rows), never the agent's prose. */
function quotaNoticeFrom(events: MainStreamEvent[]): FailureClass | null {
  // Claude's notices are status rows. Codex reports a limit as the message
  // of a `turn.failed` / `error` event, which lands on stderr
  // (src/bun/codex-tmux.ts): those rows count only when the row IS the
  // limit message (`harnessQuotaNotice`), since codex's stderr also carries
  // log lines that quote the agent's own commands.
  const status = events.filter((e) => e.stream === "status" || (e.stream === "stderr" && harnessQuotaNotice(e.data))).map((e) => e.data);
  // The limit reset later in the same turn ("Your claude.ai usage limit has
  // reset…", "[Earlier usage-limit notes no longer apply…]"): the block, if
  // any, is about something else.
  const lastQuota = status.findLastIndex((l) => classifyFailure(l)?.kind === "quota");
  const lastReset = status.findLastIndex((l) => /usage limit has reset|usage-limit notes no longer apply/i.test(l));
  if (lastQuota < 0 || lastReset > lastQuota) return null;
  return classifyFailure(status.slice(Math.max(0, lastQuota - 5), lastQuota + 1).join("\n"));
}

function scheduleAutoRetry(
  parentId: string,
  run: PipelineRunState,
  stepId: string,
  failure: FailureClass | null,
  why: string,
  opts?: {
    /** Continue the step's own session instead of relaunching it (quota only). */
    resume?: "handoff" | "cut-off";
    /** The step(s) the unfinished work would otherwise have gone to. */
    insteadOf?: string[];
  },
  now = Date.now(),
): void {
  const kind = failure?.kind ?? "transient";
  const prev = run.autoRetry;
  // Already pending for this step: a second settle of the same turn (the
  // column and run-status events both land) mustn't count another attempt.
  if (prev && prev.stepId === stepId && prev.kind === kind && prev.at != null) return;
  const attempt = prev && prev.stepId === stepId && prev.kind === kind ? prev.attempt + 1 : 1;
  const stepName = run.snapshot ? stepNameById(run.snapshot.graph, stepId) : stepId;
  const reason = (failure?.detail ?? why).slice(0, 300);
  const at = nextRetryAt(kind, attempt, failure?.resetAt ?? null, now);
  const resume = kind === "quota" ? opts?.resume : undefined;
  run.autoRetry = { stepId, kind, attempt, at, reason, ...(resume ? { resume } : {}) };
  if (at == null) {
    recordActivity(parentId, { kind: "step", text: `${stepName} ${why} again — left for you after ${TRANSIENT_RETRY_MAX} automatic retries`, tone: "danger" });
    return;
  }
  const when = formatRetryTime(at, now);
  const noTime = failure?.resetAt ? "" : ` (no reset time given; attempt ${attempt})`;
  const instead = opts?.insteadOf?.length ? ` instead of handing unfinished work to ${opts.insteadOf.join(", ")}` : "";
  recordActivity(parentId, kind === "quota"
    ? resume
      ? {
        kind: "step",
        text: `${stepName} stopped at its usage limit before finishing — resuming it at ${when}${instead}${noTime}`,
        tone: "info",
      }
      : {
        kind: "step",
        text: `${stepName} is waiting on a usage limit (${reason}) — retrying automatically at ${when}${noTime}`,
        tone: "info",
      }
    : { kind: "step", text: `${stepName} ${why} — retrying automatically at ${when} (${attempt} of ${TRANSIENT_RETRY_MAX})`, tone: "warning" });
  armAutoRetryTimer(parentId, at);
}

/** Arm the retry stored as `at`, firing at `fireAt` (later than `at` only on
 *  a boot re-arm). The callback identity-checks itself and `at`. */
function armAutoRetryTimer(parentId: string, at: number, fireAt = at): void {
  const existing = autoRetryTimers.get(parentId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    if (autoRetryTimers.get(parentId) !== handle) return;
    autoRetryTimers.delete(parentId);
    void fireAutoRetry(parentId, at);
  }, Math.max(0, fireAt - Date.now()));
  handle.unref?.();
  autoRetryTimers.set(parentId, handle);
}

/** Fire the retry armed for `at`, if the run is still parked on that step —
 *  nobody retried, advanced, stopped or archived it in the meantime, and
 *  claude didn't already continue the turn itself at the reset. Exported for
 *  tests. */
export async function fireAutoRetry(parentId: string, at: number): Promise<boolean> {
  const go = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    const run = parent?.pipelineRun;
    const r = run?.autoRetry;
    if (!parent || !run || !r || r.at !== at || recoveriesInFlight.has(parentId)) return null;
    run.autoRetry = { ...r, at: null };
    // Consuming a timer is bookkeeping, not a worker start. In particular,
    // a cancelled/orphaned execution has no block; deriving its status here
    // would label it running and make the eligibility check skip recovery.
    persist(parentId, run, { preserveStatus: true });
    if (parent.archivedAt != null || (run.status !== "blocked" && run.status !== "cancelled")) return null;
    const target = run.active.find((a) => a.stepId === r.stepId && !isTaskRunLive(a.taskId));
    if (!target) return null;
    recoveriesInFlight.add(parentId);
    return { taskId: target.taskId, stepId: r.stepId, resume: r.kind === "quota" ? r.resume : undefined };
  }).catch(() => null);
  if (!go) return false;
  try {
    if (go.resume && (await resumeStepAfterLimit(parentId, go.taskId, go.stepId, go.resume))) return true;
    // A timer belongs to this execution only. Sibling approvals, resource
    // waits and pending capped launches need their own disposition.
    const result = await retryPipelineStep(parentId, { taskId: go.taskId }).catch((e: unknown) => ({ error: String(e) }));
    if ("error" in result) {
      recordActivity(parentId, { kind: "step", text: `The automatic retry didn't start: ${result.error}`, tone: "warning" });
      return false;
    }
    return true;
  } finally {
    recoveriesInFlight.delete(parentId);
  }
}

/**
 * Continue a step that a usage limit stopped part-way, in its own session:
 * a follow-up turn carrying {@link composeLimitResumeNote} (claude: pasted
 * into the live session, or `--resume` when it's gone; codex and the other
 * one-shot harnesses: a fresh turn resuming the same thread) — the same
 * `sendInput` path the await wake-up and the handoff reminder use. The
 * step task going back to `running` clears its block and re-opens its
 * history record (`handleColumnChange`); the turn then settles like any
 * other, so a still-unfinished step blocks again rather than advancing.
 * Sent with no lock held (L-R7). False when the note couldn't be delivered —
 * the caller falls back to relaunching the step.
 */
async function resumeStepAfterLimit(parentId: string, taskId: string, stepId: string, how: "handoff" | "cut-off"): Promise<boolean> {
  const graph = tasks.get(parentId)?.pipelineRun?.snapshot?.graph;
  const step = graph?.steps.find((s) => s.id === stepId);
  const runId = tasks.get(taskId)?.runId;
  if (!graph || !step || !runId) return false;
  const note = composeLimitResumeNote({
    stepName: step.name,
    handedOffBlocked: how === "handoff",
    outgoing: outgoingSteps(graph, stepId).map((o) => ({ name: o.step.name, label: o.edge.label })),
    transition: step.transition,
    canFinish: step.canFinish === true,
  });
  let sent: Awaited<ReturnType<typeof sendInput>>;
  try {
    sent = await sendInput(runId, note);
  } catch (err) {
    sent = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (sent.delivered) {
    recordActivity(parentId, {
      kind: "step",
      text: `${step.name}'s usage limit has reset — resumed it in the same session to finish its work before handing off`,
      tone: "info",
    });
    return true;
  }
  // A claude modal-guard withhold parks the note in the step's backlog tray:
  // take it back out, the relaunch below replaces it.
  if (sent.withheld && sent.savedToBacklog) {
    try {
      const item = tasks.get(taskId)?.backlog.find((b) => b.text === note);
      if (item) backlog.remove(taskId, item.id);
    } catch {
      // best-effort
    }
  }
  recordActivity(parentId, {
    kind: "step",
    text: `Couldn't resume ${step.name} in its own session (${sent.reason.slice(0, 120)}) — starting the step again instead`,
    tone: "warning",
  });
  return false;
}

/** Re-arm every persisted automatic retry after a core restart (a timer never
 *  survives one). One that came due while the core was down fires shortly. */
export function rearmPipelineAutoRetries(now = Date.now()): number {
  let n = 0;
  for (const t of tasks.listLive()) {
    const r = t.pipelineRun?.autoRetry;
    if (t.archivedAt != null || t.pipelineParentId || !r || r.at == null) continue;
    armAutoRetryTimer(t.id, r.at, Math.max(r.at, now + 30_000));
    n++;
  }
  return n;
}

/** Stop every in-memory retry timer (core shutdown); the schedule stays
 *  persisted for the next boot. */
export function stopPipelineAutoRetryTimers(): void {
  for (const h of autoRetryTimers.values()) clearTimeout(h);
  autoRetryTimers.clear();
}

// ---------------------------------------------------------------------------
// The blocked-step wait queue
// ---------------------------------------------------------------------------

/**
 * A step that hands off `blocked` with nowhere to route the work used to sit
 * for a person whatever it was blocked on. Now the block is classified
 * (`classifyBlock`, src/shared/block-wait.ts) and, when it is something that
 * clears by itself — a shared resource that is busy, another change that
 * has to land, a transient failure, or nothing recognisable — the run is
 * parked in the queue (`run.wait`) and the SAME step is resumed in its own
 * session when what it waits on changes or on a backoff, a bounded number
 * of times; then it goes to the owner with what was tried. Anything that
 * asks the owner something never enters the queue.
 *
 * The run stays `blocked` while it waits, so it holds no Autopilot slot and
 * no step slot, and its issue stays busy (no second card). Nothing here
 * launches a different step.
 *
 * The queue is the persisted `run.wait` of every blocked run; there are no
 * timers. `releaseBlockWaits` (every {@link BLOCK_WAIT_TICK_MS}) reads it,
 * so a core restart loses nothing.
 */
const BLOCK_WAIT_TICK_MS = 30_000;
/** A resume set off by a watcher (the lease freed) never follows the last
 *  resume of the same card sooner than this: a watcher that says "free"
 *  while the step keeps finding it busy must not burn the attempts in
 *  minutes. */
const TRIGGER_MIN_GAP_MS = 5 * 60_000;
/** After resuming one card for a lease, give it this long to take the lease
 *  before the next in line is resumed (as the lab queue always did). */
const LEASE_RESUME_GAP_MS = 5 * 60_000;
/** A resume that was recorded but never started (the core died between the
 *  two) goes back in the queue after this long. */
const STRANDED_RESUME_MS = 10 * 60_000;
const REF_STATE_TTL_MS = 2 * 60_000;

export type RefState = "open" | "closed" | "unknown";

/** Whether issue or PR `n` of the repository at `project` is still open.
 *  One `gh api` call (an issue lookup answers for a PR too). */
async function githubRefState(project: string, n: number): Promise<RefState> {
  const r = await runCommand(["gh", "api", `repos/{owner}/{repo}/issues/${n}`, "--jq", ".state"], project, 30_000, process.env).catch(() => null);
  const state = r?.ok ? r.stdout.trim().toLowerCase() : "";
  return state === "open" ? "open" : state === "closed" ? "closed" : "unknown";
}

/** What the queue reads from the rest of the core — replaceable in tests. */
export const blockWaitDeps: {
  leases: () => LeaseStatus[];
  pr: (taskId: string) => TaskPrStatus | null;
  refState: (project: string, n: number) => Promise<RefState>;
  rng: () => number;
} = {
  leases: () => listLeases(),
  pr: (taskId) => prStatusForTask(taskId),
  refState: githubRefState,
  rng: Math.random,
};

const sameProject = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
const blockWaitConfig = () => parseBlockWaitConfig(preferences.get(BLOCK_WAIT_PREF));

function leasesOf(parent: Task): LeaseStatus[] {
  return blockWaitDeps.leases().filter((l) => sameProject(l.project, parent.workdir));
}

/** A check of the card's PR that fails on its base branch too, and none of
 *  its own. */
function baseCiRed(pr: TaskPrStatus | null): { baseRef: string } | null {
  if (!pr || pr.state !== "open" || pr.checks !== "failure") return null;
  return pr.failingChecks.some((c) => c.alsoOnBase) && ownFailures(pr).length === 0 ? { baseRef: pr.baseRef ?? "the base branch" } : null;
}

function blockSignalsFor(parent: Task): BlockSignals {
  return {
    leases: leasesOf(parent).map((l) => ({ label: l.label, held: l.held, heldByOther: l.held && l.holderTaskId !== parent.id, error: l.error != null })),
    baseCiRed: baseCiRed(blockWaitDeps.pr(parent.id)),
  };
}

const waitTrigger = (parent: Task, w: PipelineBlockWait) => waitHasTrigger(w, leasesOf(parent).map((l) => l.label));

/**
 * A step handed off `blocked` and the run is held on it: decide whether it
 * is the owner's or the queue's, and park it. `prev` is this execution's
 * queue entry when the queue had resumed it. Mutates `run`; the caller
 * persists. Returns what it decided.
 */
function scheduleBlockWait(
  parentId: string,
  parent: Task,
  run: PipelineRunState,
  active: PipelineActiveStep,
  handoff: Handoff,
  stepName: string,
  now = Date.now(),
): BlockVerdict["category"] | "escalated" {
  const config = blockWaitConfig();
  const prev = run.wait && run.wait.taskId === active.taskId ? run.wait : null;
  // One entry per run: a second step blocking beside a parked one is left
  // for the owner rather than replacing it.
  const taken = run.wait != null && run.wait.taskId !== active.taskId && run.wait.state !== "escalated";
  const verdict = classifyBlock(handoff, blockSignalsFor(parent), { declaredOutranksQuestions: config.declaredOutranksQuestions });
  if (verdict.category === "owner" || !config.enabled || taken) {
    if (prev) {
      delete run.wait;
      recordActivity(parentId, {
        kind: "step",
        text:
          verdict.category === "owner"
            ? `${stepName} now waits on you (${verdict.why}) — its automatic retries have stopped${prev.attempt ? ` after ${prev.attempt}` : ""}`
            : `${stepName} is still blocked — left for you`,
        tone: "warning",
      });
    }
    return "owner";
  }
  const category: BlockWaitCategory = verdict.category;
  const wait = planWait({
    stepId: active.stepId,
    taskId: active.taskId,
    verdict: { ...verdict, category },
    reason: handoff.reason.trim() || handoff.summary,
    prev,
    config,
    now,
    rng: blockWaitDeps.rng,
  });
  run.wait = wait;
  if (wait.state === "escalated") {
    recordActivity(parentId, {
      kind: "step",
      text: `${stepName} ${wait.escalation} — left for you (${triedLine(wait, now)}). It says: ${wait.reason}`,
      tone: "danger",
    });
    return "escalated";
  }
  const line = waitLine(stepName, wait, now, waitTrigger(parent, wait));
  recordActivity(parentId, {
    kind: "step",
    // "retrying automatically": what the velocity ledger reads as a wait
    // that isn't the owner's (src/shared/velocity.ts).
    text: `${line.replace(" — retrying ", " — retrying automatically ")} (${verdict.why})`,
    tone: "info",
  });
  return category;
}

/** Give a parked run to the owner: out of time. */
async function escalateWait(parentId: string, why: string, now: number): Promise<void> {
  await runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    const w = run?.wait;
    if (!run || !w || w.state !== "waiting") return;
    run.wait = { ...w, state: "escalated", at: null, escalatedAt: now, escalation: why };
    persist(parentId, run);
    const stepName = run.snapshot ? stepNameById(run.snapshot.graph, w.stepId) : w.stepId;
    recordActivity(parentId, { kind: "step", text: `${stepName} ${why} — left for you (${triedLine(w, now)}). It says: ${w.reason}`, tone: "danger" });
  }).catch(() => undefined);
}

const refStates = new Map<string, { at: number; state: RefState }>();
async function refStateCached(project: string, n: number, now: number): Promise<RefState> {
  const key = `${project.replace(/\/+$/, "")}#${n}`;
  const hit = refStates.get(key);
  if (hit && now - hit.at < REF_STATE_TTL_MS) return hit.state;
  const state = await blockWaitDeps.refState(project, n).catch(() => "unknown" as const);
  refStates.set(key, { at: now, state });
  return state;
}

/**
 * What the watchers say about the thing a parked run waits on:
 *   cleared — it changed (the lease is free, #n closed, the base's checks
 *             no longer fail): resume now;
 *   holding — it is known to be unchanged: resuming would be wasted;
 *   unknown — nothing watches it (or the watcher failed): the timer decides.
 */
async function waitTriggerState(parent: Task, w: PipelineBlockWait, now: number): Promise<{ state: "cleared" | "holding" | "unknown"; text: string }> {
  if (w.category === "resource" && w.ref) {
    const lease = leasesOf(parent).find((l) => l.label.toLowerCase() === w.ref!.toLowerCase());
    if (!lease || lease.error) return { state: "unknown", text: "" };
    if (lease.held && lease.holderTaskId !== parent.id) return { state: "holding", text: `the ${lease.label} is still held${lease.holderTitle ? ` by "${lease.holderTitle}"` : ""}` };
    return { state: "cleared", text: `the ${lease.label} is free` };
  }
  if (w.category === "dependency" && w.ref === "base-ci") {
    const pr = blockWaitDeps.pr(parent.id);
    if (!pr) return { state: "unknown", text: "" };
    return baseCiRed(pr) ? { state: "holding", text: `the same checks still fail on ${pr.baseRef ?? "the base branch"}` } : { state: "cleared", text: `the checks that failed on ${pr.baseRef ?? "the base branch"} no longer fail there` };
  }
  const n = w.category === "dependency" ? issueRef(w.ref) : null;
  if (n != null) {
    const state = await refStateCached(parent.workdir, n, now);
    if (state === "closed") return { state: "cleared", text: `#${n} is closed` };
    return state === "open" ? { state: "holding", text: `#${n} is still open` } : { state: "unknown", text: "" };
  }
  return { state: "unknown", text: "" };
}

const lastLeaseResumeAt = new Map<string, number>();

/**
 * Resume the parked step of `parentId` in its own session with a note
 * (`composeBlockedResumeNote`): check whether the block has cleared, finish
 * if so, else say what it waits on. Counts an attempt. When the note can't
 * be delivered the step is started again instead — still the same step. Sent
 * with no lock held (L-R7). Exported for tests.
 */
export async function resumeBlockedStep(parentId: string, trigger: string, cleared: string | null, now = Date.now()): Promise<boolean> {
  const go = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    const run = parent?.pipelineRun;
    const w = run?.wait;
    if (!parent || !run || !w || w.state !== "waiting" || parent.archivedAt != null || run.status !== "blocked") return null;
    const graph = run.snapshot?.graph;
    const step = graph?.steps.find((s) => s.id === w.stepId);
    const target = run.active.find((a) => a.taskId === w.taskId);
    const runId = tasks.get(w.taskId)?.runId;
    if (!graph || !step || !target || !runId || isTaskRunLive(w.taskId)) return null;
    run.wait = { ...w, state: "resuming", attempt: w.attempt + 1, at: null, tried: [...w.tried, { at: now, trigger }].slice(-12) };
    persist(parentId, run);
    return {
      taskId: w.taskId,
      runId,
      stepName: step.name,
      attempt: w.attempt + 1,
      max: w.max,
      note: composeBlockedResumeNote({
        stepName: step.name,
        reason: w.reason,
        cleared,
        attempt: w.attempt + 1,
        max: w.max,
        outgoing: outgoingSteps(graph, w.stepId).map((o) => ({ name: o.step.name, label: o.edge.label })),
        transition: step.transition,
        canFinish: step.canFinish === true,
      }),
    };
  }).catch(() => null);
  if (!go) return false;

  let sent: Awaited<ReturnType<typeof sendInput>>;
  try {
    sent = await sendInput(go.runId, go.note);
  } catch (err) {
    sent = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const count = `automatic retry ${go.attempt} of ${go.max}`;
  if (sent.delivered) {
    recordActivity(parentId, {
      kind: "step",
      text: `Resumed ${go.stepName} in its own session to check its block${cleared ? ` — ${cleared}` : ""} (${count})`,
      tone: "info",
    });
    return true;
  }
  if (sent.withheld && sent.savedToBacklog) {
    try {
      const item = tasks.get(go.taskId)?.backlog.find((b) => b.text === go.note);
      if (item) backlog.remove(go.taskId, item.id);
    } catch {
      // best-effort
    }
  }
  const relaunched = await retryPipelineStep(parentId, { taskId: go.taskId }).catch((e: unknown) => ({ error: String(e) }));
  if (!("error" in relaunched)) {
    recordActivity(parentId, {
      kind: "step",
      text: `Couldn't resume ${go.stepName} in its own session (${sent.reason.slice(0, 120)}) — started the step again instead (${count})`,
      tone: "warning",
    });
    return true;
  }
  // Neither worked: back in the queue, the attempt spent.
  await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    const run = parent?.pipelineRun;
    const w = run?.wait;
    if (!parent || !run || !w || w.state !== "resuming") return;
    const handoff = run.history.find((h) => h.taskId === w.taskId && h.seq === run.active.find((a) => a.taskId === w.taskId)?.seq)?.handoff;
    const active = run.active.find((a) => a.taskId === w.taskId);
    if (!handoff || !active) {
      delete run.wait;
    } else {
      scheduleBlockWait(parentId, parent, run, active, handoff, go.stepName);
    }
    persist(parentId, run);
  }).catch(() => undefined);
  recordActivity(parentId, { kind: "step", text: `The automatic retry of ${go.stepName} didn't start: ${relaunched.error}`, tone: "warning" });
  return false;
}

/**
 * One pass of the wait queue. For each parked run, oldest first (priority
 * cards ahead): past its deadline → the owner's; what it waits on has
 * changed, or its timer is due and nothing says it is unchanged → resume
 * its step. Bounded: at most `maxPerPass` resumes a pass, none while any
 * card waits on a usage limit (a resume would only hit it), none over the
 * step-slot limits, one card per freed lease at a time. Exported for tests.
 */
export async function releaseBlockWaits(now = Date.now()): Promise<number> {
  const config = blockWaitConfig();
  const live = tasks.listLive().filter((t) => t.archivedAt == null);
  const parked = live.filter((t) => !t.pipelineParentId && t.pipelineRun?.status === "blocked" && t.pipelineRun.wait != null);
  if (parked.length === 0) return 0;

  // A resume the core recorded but never sent: back in the queue.
  for (const t of parked) {
    const w = t.pipelineRun!.wait!;
    const lastTried = w.tried[w.tried.length - 1]?.at ?? w.since;
    if (w.state !== "resuming" || isTaskRunLive(w.taskId) || now - lastTried < STRANDED_RESUME_MS) continue;
    if (t.pipelineRun!.autoRetry?.at != null) continue; // the retry machinery has it
    await runExclusive(t.id, async () => {
      const run = tasks.get(t.id)?.pipelineRun;
      if (!run?.wait || run.wait.state !== "resuming" || !run.blocked.some((b) => b.taskId === run.wait!.taskId && b.kind === "step-blocked")) return;
      run.wait = { ...run.wait, state: "waiting", at: now };
      persist(t.id, run);
    }).catch(() => undefined);
  }

  const waiting = priorityFirst(
    parked.filter((t) => tasks.get(t.id)?.pipelineRun?.wait?.state === "waiting").sort((a, b) => a.pipelineRun!.wait!.since - b.pipelineRun!.wait!.since),
    (t) => t.id,
  );
  const quotaHold = live.some((t) => waitingOnQuota(t.pipelineRun) || (t.pipelineRun?.active ?? []).some((a) => isQuotaPaused(a.taskId)));
  let resumed = 0;
  for (const t of waiting) {
    const w = tasks.get(t.id)?.pipelineRun?.wait;
    if (!w || w.state !== "waiting") continue;
    if (now >= w.deadline) {
      await escalateWait(t.id, `still waiting on ${w.what} after ${fmtSpan(now - w.since)}`, now);
      continue;
    }
    const trigger = await waitTriggerState(t, w, now);
    const due = w.at != null && now >= w.at;
    const lastTried = w.tried[w.tried.length - 1]?.at ?? 0;
    const triggered = trigger.state === "cleared" && now - lastTried >= TRIGGER_MIN_GAP_MS;
    if (!due && !triggered) continue;
    if (trigger.state === "holding") {
      // The timer came due, but what it waits on is known not to have
      // changed: look again later, without spending a resume.
      const backoff = config.backoffMin[w.category];
      const again = now + (backoff[Math.min(w.attempt, backoff.length - 1)] ?? 15) * 60_000;
      await runExclusive(t.id, async () => {
        const run = tasks.get(t.id)?.pipelineRun;
        if (!run?.wait || run.wait.state !== "waiting") return;
        run.wait = { ...run.wait, at: Math.min(again, run.wait.deadline) };
        persist(t.id, run);
      }).catch(() => undefined);
      continue;
    }
    if (quotaHold || resumed >= config.maxPerPass) continue;
    const leaseKey = w.category === "resource" && w.ref ? `${t.workdir.replace(/\/+$/, "")}\0${w.ref.toLowerCase()}` : null;
    if (leaseKey && now - (lastLeaseResumeAt.get(leaseKey) ?? 0) < LEASE_RESUME_GAP_MS) continue;
    if (!isPriority(t.id)) {
      const slots = currentSlots();
      const stepName = t.pipelineRun?.snapshot ? stepNameById(t.pipelineRun.snapshot.graph, w.stepId) : "";
      if (!slotDecision(stepName, slotUse(isTaskRunLive, slots), slots).ok) continue;
    }
    const cleared = trigger.state === "cleared" ? trigger.text : null;
    if (await resumeBlockedStep(t.id, cleared ?? "its retry time came", cleared, now)) {
      resumed++;
      if (leaseKey) lastLeaseResumeAt.set(leaseKey, now);
    }
  }
  return resumed;
}

/** Every run the queue holds or has given up, for `GET /waiting` and
 *  `agetor waiting`: parked and resuming first (oldest first), then the
 *  escalated ones. */
export function listBlockWaits(now = Date.now()): WaitingRow[] {
  const rows: WaitingRow[] = [];
  for (const t of tasks.listLive()) {
    const run = t.pipelineRun;
    const w = run?.wait;
    if (!run || !w || t.archivedAt != null || t.pipelineParentId) continue;
    if (w.state !== "resuming" && run.status !== "blocked") continue;
    const step = run.snapshot ? stepNameById(run.snapshot.graph, w.stepId) : w.stepId;
    const triggered = waitTrigger(t, w);
    rows.push({
      taskId: t.id,
      title: t.title,
      step,
      category: w.category,
      source: w.source,
      what: w.what,
      ref: w.ref,
      reason: w.reason,
      state: w.state,
      since: w.since,
      attempt: w.attempt,
      max: w.max,
      nextAt: w.state === "waiting" ? w.at : null,
      deadline: w.deadline,
      triggered,
      tried: w.tried,
      escalation: w.escalation ?? null,
      line: w.state === "escalated" ? escalationLine(step, w, now).line : waitLine(step, w, now, triggered),
    });
  }
  const rank = (r: WaitingRow) => (r.state === "escalated" ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || a.since - b.since);
}

/** Test hook. */
export function resetBlockWaitsForTests(): void {
  refStates.clear();
  lastLeaseResumeAt.clear();
  blockWaitDeps.leases = () => listLeases();
  blockWaitDeps.pr = (taskId) => prStatusForTask(taskId);
  blockWaitDeps.refState = githubRefState;
  blockWaitDeps.rng = Math.random;
}

/** When each queued step started waiting (`<parentId>:<stepId>`) — slots go
 *  to the longest-waiting first. In memory: after a restart the order is
 *  rebuilt from the first pass. */
const slotWaitSince = new Map<string, number>();

/** Launch queued steps while slots are free, longest-waiting first. Each
 *  launch re-checks the slots itself (a heavy step may still have to wait
 *  while a light one behind it goes). Exported for tests. */
export async function releaseSlotWaits(now = Date.now()): Promise<number> {
  const waiting: { parentId: string; stepId: string; since: number }[] = [];
  for (const t of tasks.listLive()) {
    if (t.archivedAt != null || !t.pipelineRun || ['cancelled','done','idle'].includes(t.pipelineRun.status)) continue;
    for (const b of t.pipelineRun.blocked) {
      const inputDue = b.kind === 'step-blocked' && b.taskId === null && b.pending && b.inputRetry && b.inputRetry.at <= now;
      if ((b.kind !== "slot-wait" && !inputDue) || !b.stepId) continue;
      const key = `${t.id}:${b.stepId}`;
      if (!slotWaitSince.has(key)) slotWaitSince.set(key, Date.now());
      waiting.push({ parentId: t.id, stepId: b.stepId, since: slotWaitSince.get(key)! });
    }
  }
  waiting.sort((a, b) => a.since - b.since);
  let launched = 0;
  // Priority cards first, and they don't wait for a free slot.
  for (const w of priorityFirst(waiting, (x) => x.parentId)) {
    const slots = currentSlots();
    const urgent = isPriority(w.parentId);
    if (!urgent && slotUse(isTaskRunLive, slots).total >= slots.max) break;
    const ok = await runExclusive(w.parentId, async () => {
      const parent = tasks.get(w.parentId);
      const run = parent?.pipelineRun;
      if (!parent || !run || parent.archivedAt != null || ['cancelled','done','idle'].includes(run.status)) return false;
      const block = run.blocked.find((b) => b.stepId === w.stepId && (b.kind === "slot-wait"
        || b.kind === 'step-blocked' && b.taskId === null && b.inputRetry && b.inputRetry.at <= now));
      const step = run.snapshot?.graph.steps.find((s) => s.id === w.stepId);
      if (!block?.pending || !step) return false;
      // Still over a limit for this step (e.g. the verification slot)? Leave it queued.
      if (!urgent && !slotDecision(step.name, slotUse(isTaskRunLive, slots), slots).ok) return false;
      run.blocked = run.blocked.filter((b) => b !== block);
      const previous = block.pending.arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
      const r = await launchTarget(parent, run, step, previous, { inputRetryAttempt: block.inputRetry?.attempt });
      persist(w.parentId, run);
      return r.ok;
    }).catch(() => false);
    if (ok) launched++;
  }
  return launched;
}

/** Turns that ended but were never settled — the run-status event was lost
 *  (a restart or a stalled app mid-turn) — leave a step "running" forever.
 *  A step whose task finished its turn (In Review), isn't live, has no block
 *  and no settled outcome, and has been quiet a while, is settled now.
 *  Pure selection; exported for tests. */
export function unsettledSteps(list: Task[], isLive: (taskId: string) => boolean, now: number, quietMs = 5 * 60_000): { taskId: string; runId: string }[] {
  const out: { taskId: string; runId: string }[] = [];
  for (const parent of list) {
    const run = parent.pipelineRun;
    if (!run || parent.archivedAt != null) continue;
    for (const a of run.active) {
      const step = list.find((t) => t.id === a.taskId);
      if (!step?.runId || step.column !== "review" || isLive(a.taskId)) continue;
      if (run.blocked.some((b) => b.taskId === a.taskId)) continue;
      const entry = run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq);
      if (!entry || entry.outcome != null) continue;
      if (now - step.updatedAt < quietMs) continue;
      out.push({ taskId: a.taskId, runId: step.runId });
    }
  }
  return out;
}

export async function recoverUnsettledSteps(now = Date.now()): Promise<number> {
  // Steps blocked for a missing/invalid handoff whose runs DO hold a valid
  // one (the reply landed in a sibling run): unblock and settle them.
  let recovered = 0;
  for (const parent of tasks.listLive()) {
    const run = parent.pipelineRun;
    if (!run || parent.archivedAt != null) continue;
    for (const b of run.blocked) {
      if (!b.taskId || (b.kind !== "handoff-missing" && b.kind !== "handoff-invalid")) continue;
      const active = run.active.find((a) => a.taskId === b.taskId);
      const step = tasks.get(b.taskId);
      if (!active || !step?.runId || isTaskRunLive(b.taskId)) continue;
      const entry = run.history.find((h) => h.taskId === b.taskId && h.seq === active.seq);
      if (!parseHandoff(executionAssistantText(b.taskId, step.runId, entry?.startedAt ?? null, entry?.turnStartedAt ?? null)).ok) continue;
      await runExclusive(parent.id, async () => {
        const fresh = tasks.get(parent.id)?.pipelineRun;
        if (!fresh) return;
        fresh.blocked = fresh.blocked.filter((x) => !(x.taskId === b.taskId && x.kind === b.kind));
        persist(parent.id, fresh);
      });
      recordActivity(parent.id, { kind: "auto", text: "A step's valid handoff was missed (it landed in a sibling run) — picking it up now", tone: "muted" });
      await handleRunStatus(b.taskId, step.runId, "succeeded");
      recovered++;
    }
  }
  const found = unsettledSteps(tasks.listLive(), isTaskRunLive, now).filter((s) => !remindersInFlight.has(s.taskId));
  for (const s of found) {
    const parentId = tasks.get(s.taskId)?.pipelineParentId;
    if (parentId) recordActivity(parentId, { kind: "auto", text: "A step's finished turn was never picked up — picking it up now", tone: "muted" });
    await handleRunStatus(s.taskId, s.runId, "succeeded");
  }
  return found.length + recovered;
}

/** Pipeline step tasks whose session must not keep running: the step is no
 *  longer active in its pipeline (it handed off, was superseded, or the run
 *  ended) — yet its Claude REPL can wake on its own (Claude Code resumes a
 *  turn when the usage limit resets, or after a background command
 *  finishes) and keep editing the shared worktree next to the step that
 *  replaced it. `sessionNames` are Agetor's live tmux sessions. Steps
 *  created in the last minute are left alone (a launch in flight). Pure;
 *  exported for tests. */
export function inactiveStepSessions(list: Task[], sessionNames: Set<string>, now: number, sessionNameOf: (id: string) => string): string[] {
  const out: string[] = [];
  const byId = new Map(list.map((t) => [t.id, t]));
  for (const t of list) {
    if (!t.pipelineParentId || !sessionNames.has(sessionNameOf(t.id))) continue;
    if (now - t.createdAt < 60_000) continue;
    const run = byId.get(t.pipelineParentId)?.pipelineRun;
    const active = !!run && (run.active.some((a) => a.taskId === t.id) || run.blocked.some((b) => b.taskId === t.id));
    if (!active) out.push(t.id);
  }
  return out;
}

/** The rows `inactiveStepSessions` can act on, read without parsing the
 *  whole table: every step row (archived or not) that has a live session,
 *  plus those steps' parents. `inactiveStepSessions` skips every other step
 *  (no session) and only looks a parent up by a step's `pipelineParentId`,
 *  so it decides exactly as it would over `tasks.list()`. Exported for
 *  tests. */
export function stepSessionRows(sessionNames: Set<string>, sessionNameOf: (id: string) => string): Task[] {
  const steps = tasks.stepIds().filter((s) => sessionNames.has(sessionNameOf(s.id)));
  if (steps.length === 0) return [];
  return tasks.listByIds([...new Set(steps.flatMap((s) => [s.id, s.parentId]))]);
}

export async function reapInactiveStepSessions(now = Date.now()): Promise<number> {
  const { sessionNameFor, dropSession } = await import("./claude-tmux.ts");
  const ls = Bun.spawnSync(["tmux", "-L", "agetor", "ls", "-F", "#{session_name}"], { stdout: "pipe", stderr: "ignore" });
  if (ls.exitCode !== 0) return 0;
  const names = new Set(ls.stdout.toString().split("\n").filter(Boolean));
  const stale = inactiveStepSessions(stepSessionRows(names, sessionNameFor), names, now, sessionNameFor);
  for (const id of stale) {
    await dropSession(id).catch(() => undefined);
    const parentId = tasks.get(id)?.pipelineParentId;
    if (parentId) recordActivity(parentId, { kind: "auto", text: "Closed a finished step's agent session so it can't keep working in the worktree", tone: "muted" });
  }
  return stale.length;
}

let slotLoop: ReturnType<typeof setInterval> | null = null;

/** Start the slot scheduler. Idempotent; the timer is unref'd. */
export function startSlotScheduler(): void {
  if (slotLoop) return;
  slotLoop = setInterval(() => void releaseSlotWaits().catch(() => undefined), 10_000);
  slotLoop.unref?.();
  setInterval(() => void recoverUnsettledSteps().catch(() => 0), 5 * 60_000).unref?.();
  setInterval(() => void reapInactiveStepSessions().catch(() => 0), 60_000).unref?.();
  // The blocked-step wait queue: persisted on the runs, so the first pass
  // after a restart picks up where the last one left off.
  setInterval(() => void releaseBlockWaits().catch(() => 0), BLOCK_WAIT_TICK_MS).unref?.();
}

function noteSuperseded(parentId: string, steps: string[], by: string): void {
  if (steps.length === 0) return;
  recordActivity(parentId, {
    kind: "step",
    text: `${steps.join(", ")} block set aside — ${by} took over`,
    tone: "muted",
  });
}

/** Add-or-replace a join arrival by `fromStepId` (m10) — a source step that
 *  hands off to the same join twice (a retry, a cycle revisiting the same
 *  join in a later generation while an earlier arrival was never cleared,
 *  …) must overwrite its previous arrival rather than duplicate it, since
 *  "one arrival per distinct incoming source" is exactly what the
 *  join-complete check (`incoming.every((i) => arrivedIds.has(...))`) counts
 *  on. */
function addJoinArrival(existing: PipelineJoinArrival[], entry: PipelineJoinArrival): PipelineJoinArrival[] {
  return [...existing.filter((a) => a.fromStepId !== entry.fromStepId), entry];
}

/** After every settle/advance, decide whether any `join: "all"` step is
 *  stuck forever: no execution is left active, but a partial arrival set is
 *  still sitting in `run.joins`. Idempotent — never adds a second entry for
 *  the same join step. */
function checkJoinIncomplete(run: PipelineRunState): void {
  if (run.active.length > 0 || !run.snapshot) return;
  const graph = run.snapshot.graph;
  for (const [stepId, joinState] of Object.entries(run.joins)) {
    if (joinState.arrivals.length === 0) continue;
    if (run.blocked.some((b) => b.stepId === stepId && b.kind === "join-incomplete")) continue;
    const stepName = stepNameById(graph, stepId);
    const incoming = incomingSteps(graph, stepId);
    const arrivedIds = new Set(joinState.arrivals.map((a) => a.fromStepId));
    const missing = incoming
      .filter((i) => !arrivedIds.has(i.step.id))
      .map((i) => i.step.name);
    run.blocked.push({
      taskId: null,
      stepId,
      kind: "join-incomplete",
      message: missing.length > 0
        ? `step "${stepName}" is waiting on: ${missing.join(", ")} (no path there arrived)`
        : `step "${stepName}" never received all its incoming handoffs`,
      // M2: a manual advance/retry can re-launch this join with exactly the
      // arrivals it already has.
      pending: { stepId, arrivals: joinState.arrivals },
    });
  }
}

/**
 * Persist `run` onto the parent task row, recompute its `status` (unless
 * `preserveStatus` — see `deriveRunStatus`'s doc for why a "cancelled, but
 * kept `active` for retry" state can't be re-derived), mirror the parent's
 * board column, and broadcast the `"pipeline"` GlobalEvent (D12) — UNLESS
 * the parent is archived (m8): an archived task is frozen everywhere else
 * (no board card, no live column), so a background settle must still update
 * the stored run state (reconcile, history, retries all read it) without
 * mirroring a column or firing an event nobody should react to. The single
 * choke point every mutator below ends on.
 */
function persist(parentId: string, run: PipelineRunState, opts?: { preserveStatus?: boolean }): void {
  if (!opts?.preserveStatus) run.status = deriveRunStatus(run);
  if (run.status === "done" || run.status === "cancelled") {
    if (run.endedAt === null) run.endedAt = Date.now();
  } else {
    run.endedAt = null;
  }
  // L-R4: the status this parent's row held BEFORE this write — the column
  // below is mirrored only on an actual status TRANSITION, never on every
  // persist. A user who parked a `done`/`cancelled` pipeline card somewhere
  // else on the board (Done, say) must not have an unrelated persist (a
  // join bookkeeping write, a reminder stamp, a reconcile pass) snap the
  // card back to `review`/`ready`. `server.ts` separately 409s a column
  // PATCH on a parent whose run is live; both guards stay.
  const previousRun = tasks.get(parentId)?.pipelineRun ?? null;
  const previousStatus = previousRun?.status ?? null;
  // The wait queue's entry belongs to one blocked execution. Once that
  // execution is gone (it finished, was advanced past or superseded) the
  // entry goes with it; and when its block is gone while the queue wasn't
  // the one resuming it, a person took the step up — Retry, a message to
  // the step, an answer — which always wins over the queue.
  if (run.wait) {
    const w = run.wait;
    const stillActive = run.active.some((a) => a.taskId === w.taskId);
    const stillBlocked = run.blocked.some((b) => b.taskId === w.taskId);
    const otherBlock = run.blocked.find((b) => b.taskId === w.taskId && b.kind !== "step-blocked");
    if (!stillActive) {
      delete run.wait;
    } else if (w.state === "resuming" && otherBlock && run.autoRetry?.at == null) {
      // The resumed turn ended some other way (no handoff, a failure the
      // retries gave up on): an ordinary block, for the owner.
      delete run.wait;
    } else if (w.state !== "resuming" && !stillBlocked) {
      delete run.wait;
      if (w.state === "waiting") {
        recordActivity(parentId, {
          kind: "step",
          text: `${run.snapshot ? stepNameById(run.snapshot.graph, w.stepId) : "The step"} was resumed outside the wait queue — its automatic retries are cancelled`,
          tone: "muted",
        });
      }
    }
  }
  tasks.setPipelineRun(parentId, run);
  const parent = tasks.get(parentId);
  // Every new block goes in the block log (src/bun/block-log.ts).
  const fresh = newBlocks(previousRun?.blocked ?? [], run.blocked).filter((b) => b.kind !== "slot-wait" && b.kind !== "await");
  if (fresh.length && parent) {
    logBlocks(
      fresh.map((b) => ({
        taskId: parentId,
        title: parent.title,
        pipeline: run.pipelineName,
        step: run.snapshot && b.stepId ? stepNameById(run.snapshot.graph, b.stepId) : (b.stepId ?? "?"),
        kind: b.kind,
        message: b.message.slice(0, 500),
      })),
    );
  }
  if (parent?.archivedAt != null) return; // m8
  const columnFor: Partial<Record<PipelineRunStatus, ColumnId>> = {
    running: "running",
    blocked: "blocked",
    done: "review",
    cancelled: "ready",
  };
  // A signed-off card (Ready to Merge) comes back there when a fix-up run
  // finishes, not to In Review (src/bun/merge-intent.ts).
  const nextColumn = run.status === "done" && isMergeQueued(parentId) ? "merge" : columnFor[run.status];
  if (nextColumn && parent && parent.column !== nextColumn && previousStatus !== run.status) {
    pipelineUpdateColumn(parentId, null, nextColumn);
  }
  publishGlobalEvent({
    kind: "pipeline",
    taskId: parentId,
    status: run.status,
    activeStepIds: run.active.map((a) => a.stepId),
    stepCount: run.stepCount,
    ts: Date.now(),
  } satisfies GlobalEvent);
}

/**
 * Force `run.status = "cancelled"` and persist it that way — UNLESS
 * something is still genuinely blocked (Minor 6), in which case persisting
 * normally (letting `deriveRunStatus` recompute) keeps that blocked reason
 * visible instead of silently overwriting it with a bare, unexplained
 * "cancelled" — `deriveRunStatus` already treats `blocked` as
 * higher-priority than `cancelled`/`idle`, so this is a no-op change in
 * outcome for the "nothing blocked" case and a strict improvement for the
 * "something's blocked" one. Shared by `cancelPipelineRun` and
 * `handleRunStatus`'s cancelled/orphaned-with-nothing-else-live branch —
 * and, transitively, `reconcilePipelineRuns`, which drives missed settles
 * through that same `handleRunStatus` path at boot.
 */
function finalizeCancelled(parentId: string, run: PipelineRunState): void {
  if (run.blocked.length === 0) {
    run.status = "cancelled";
    persist(parentId, run, { preserveStatus: true });
  } else {
    persist(parentId, run);
  }
}

/**
 * Whether `run` is already mid a DELIBERATE whole-run stop as far as
 * `excludeTaskId`'s own execution is concerned — either `run.status` was
 * already forced to `"cancelled"` (`cancelPipelineRun` does this via
 * `finalizeCancelled` BEFORE any live sibling's own settle event reaches
 * this module, per Major 1 round 3's doc on `handleRunStatus`'s
 * cancelled/orphaned branch), or every OTHER still-live sibling is itself
 * mid-cancellation (`isTaskRunCancelling` — e.g. each active execution was
 * cancelled individually rather than through the pipeline-level cancel
 * route, so none of them is a normally-running sibling worth waiting on).
 * Shared by the cancelled/orphaned settle branch below and the succeeded
 * branch's handoff-reminder gate (round 4, Major 2): a step that finished
 * with a bad/ambiguous handoff while the whole run is being torn down must
 * not have its one automatic reminder revive the run back into `running`.
 */
function isDeliberateWholeRunStop(run: PipelineRunState, excludeTaskId: string): boolean {
  if (run.status === "cancelled") return true;
  const stillLiveSiblings = run.active.filter((a) => a.taskId !== excludeTaskId && isTaskRunLive(a.taskId));
  return stillLiveSiblings.length > 0 && stillLiveSiblings.every((a) => isTaskRunCancelling(a.taskId));
}

/** Re-read a FRESH copy of the parent's run from the DB and record a
 *  `step-failed` block for `taskId`'s active execution with `err`'s message
 *  (M16) — the fallback every event handler below reaches for when its own
 *  body throws partway through mutating an in-memory `run` that was never
 *  persisted. Deliberately re-fetches rather than trusting whatever the
 *  caller's own (possibly half-mutated) `run` variable holds, since that
 *  object was never written to the DB if the throw happened before its own
 *  `persist()` call — the actual DB row is untouched, so reading fresh here
 *  can't double-apply a partial mutation. A no-op when the parent, its run,
 *  or this specific active entry no longer exist. */
function persistReconcileFailure(parentId: string, taskId: string, err: unknown): void {
  try {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineRun) return;
    const run = parent.pipelineRun;
    const activeEntry = run.active.find((a) => a.taskId === taskId);
    if (!activeEntry) return;
    const message = err instanceof Error ? err.message : String(err);
    upsertBlocked(run, {
      taskId,
      stepId: activeEntry.stepId,
      kind: "step-failed",
      message: `internal error while processing this step: ${message}`,
    });
    checkJoinIncomplete(run);
    persist(parentId, run);
  } catch {
    // Best-effort — if even this fails, the step just stays `active` with
    // no block until the next event or `reconcilePipelineRuns` sweep.
  }
}

/** A run's MAIN-stream rows (`subagentId == null`) in id order, loaded ONCE
 *  per settle (L-R6) — both derivations below read from this one array
 *  instead of each re-fetching the whole `run_events` table for the run.
 *  `runs.events` has no stream filter (db.ts isn't this module's to change;
 *  a `stream IN (…)` variant there would be the real fix), so the filter is
 *  applied here, after the single load. */
type MainStreamEvent = { stream: string; data: string };
function mainStreamEventsForRun(runId: string, bounds?: { throughEventId?: number; throughTs?: number }): MainStreamEvent[] {
  return runs.events(runId, bounds).filter((e) => e.subagentId == null);
}

/** Concatenate the `assistant` rows of {@link mainStreamEventsForRun}'s
 *  output — the text `parseHandoff` scans for the step's trailing
 *  `<handoff>` block. */
function assistantTextFrom(events: MainStreamEvent[]): string {
  return events
    .filter((e) => e.stream === "assistant")
    .map((e) => e.data)
    .join("\n");
}

/** The reply text to look for this execution's handoff in. Normally the
 *  settling run's own text; when that has no handoff block, every run of the
 *  step task since the execution started, oldest first — a reminder can be
 *  delivered into a run that gets split or duplicated, and the agent's valid
 *  handoff then sits in a sibling run (#416: the reply landed in one run, the
 *  settle read an empty twin and blocked an approved Review). The parser
 *  takes the LAST block, so a later reply still wins.
 *
 *  Only the turn being judged counts. A step is often sent back into its
 *  own session after it already wrote a handoff — resumed when a usage limit
 *  resets, reminded, resumed by the wait queue, retried, messaged from its
 *  panel — and each of those starts a new run. `turnStartedAt`
 *  ({@link PipelineStepRecord.turnStartedAt}) is where the newest such turn
 *  began: runs before it are left out, so a turn that ends without a
 *  handoff reads as "no handoff", not as the stale one from before it was
 *  re-entered. Exported for tests. */
export function executionAssistantText(taskId: string, runId: string, since: number | null, turnStartedAt: number | null = null): string {
  const own = assistantTextFrom(mainStreamEventsForRun(runId));
  if (own.includes("<handoff>") || since == null) return own;
  const from = Math.max(since - 1_000, turnStartedAt ?? 0);
  const siblings = runs
    .listForTask(taskId)
    .filter((r) => r.startedAt >= from)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (siblings.length < 2) return own;
  return siblings.map((r) => assistantTextFrom(mainStreamEventsForRun(r.id))).filter(Boolean).join("\n");
}

/**
 * A step execution's final report, read from its recorded turns: the
 * assistant messages of the newest run (since the execution started) that
 * holds a valid handoff, up to and including that message, plus the split
 * {@link stepReportFromMessages} makes of it. This is what the next step is
 * given in full and what `agetor pipeline handoff` prints — the handoff JSON
 * kept on the run's history is only the block at its end. Null when no run
 * of the step holds a handoff (it failed without a report, or its
 * events are gone). Explicit manual routing may opt into raw output when
 * there is no valid handoff; that output is context, never a verdict.
 * Exported for tests.
 */
export function stepFinalReport(
  taskId: string,
  since: number | null,
  turnStartedAt: number | null = null,
  opts?: { includeUnstructured?: boolean; endedAt?: number | null; throughEventId?: number },
): { body: string; final: string; handoff: Handoff | null; messages: string[] } | null {
  const from = Math.max(since == null ? 0 : since - 1_000, turnStartedAt ?? 0);
  const candidates = runs
    .listForTask(taskId)
    .filter((r) => r.startedAt >= from && (opts?.endedAt == null || r.startedAt <= opts.endedAt))
    .sort((a, b) => b.startedAt - a.startedAt);
  const messagesFor = (runId: string) => mainStreamEventsForRun(runId,
    { throughEventId: opts?.throughEventId, throughTs: opts?.throughEventId != null ? undefined : opts?.endedAt ?? undefined })
    .filter((e) => e.stream === "assistant")
    .map((e) => e.data);
  for (const r of candidates) {
    const messages = messagesFor(r.id);
    const report = stepReportFromMessages(messages);
    if (report) return { ...report, messages: messages.slice(0, messages.lastIndexOf(report.final) + 1) };
  }
  if (opts?.includeUnstructured) {
    // Keep all assistant output from this execution's current turn, including
    // split-run siblings. The same lower bound above excludes old verdicts.
    const messages = candidates.slice().reverse().flatMap((r) => messagesFor(r.id).filter((m) => m.trim()));
    if (messages.length > 0) {
      const final = messages.join("\n\n");
      return { body: `The stopped turn produced no valid handoff. This raw output is findings/context, not approval.\n\n${final}`,
        final, handoff: null, messages };
    }
  }
  return null;
}

/** Freeze the event boundary, including same-millisecond and same-run later
 * messages. The report remains in the event log; no duplicate blob or DB
 * migration is needed. Old completed records use their endedAt as fallback. */
function freezeStepReport(record: PipelineStepRecord): void {
  if (record.reportThroughEventId != null) return;
  const from = Math.max(record.startedAt - 1_000, record.turnStartedAt ?? 0);
  const row = db.query<{ id: number | null }, [string, number]>(
    "SELECT MAX(e.id) AS id FROM run_events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=? AND r.started_at>=? AND e.subagent_id IS NULL",
  ).get(record.taskId, from);
  record.reportThroughEventId = row?.id ?? 0;
}

/** One row per step execution of a pipeline task's run, oldest first, with
 *  its handoff and its full final report text — `GET
 *  /tasks/:id/pipeline/reports`, `agetor pipeline handoff`. `seq` narrows it
 *  to one execution. Null for a task that isn't a pipeline task. */
export function pipelineStepReports(parentId: string, seq?: number): PipelineStepReport[] | null {
  const parent = tasks.get(parentId);
  if (!parent?.pipelineId) return null;
  const run = parent.pipelineRun;
  if (!run) return [];
  return run.history
    .filter((h) => seq == null || h.seq === seq)
    .sort((a, b) => a.seq - b.seq)
    .map((h) => {
      const report = stepFinalReport(h.taskId, h.startedAt, h.turnStartedAt ?? null,
        { includeUnstructured: h.outcome === "advanced-manually", endedAt: h.endedAt, throughEventId: h.reportThroughEventId });
      return {
        seq: h.seq,
        stepId: h.stepId,
        stepName: run.snapshot ? stepNameById(run.snapshot.graph, h.stepId) : h.stepId,
        taskId: h.taskId,
        outcome: h.outcome,
        responseKind: h.responseKind ?? null,
        startedAt: h.startedAt,
        endedAt: h.endedAt,
        handoff: h.handoff,
        report: report?.final ?? null,
      };
    });
}

/** Best-effort "why did it fail" tail for a `step-failed` blocked message —
 *  the last main-stream `status`/`stderr` row, capped so one giant stack
 *  trace doesn't blow up the blocked entry's `message`. `null` when the run
 *  has nothing of the sort (rare, but cheap to tolerate). */
function lastStatusLineFrom(events: MainStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.stream !== "status" && e.stream !== "stderr") continue;
    return e.data.length > 240 ? `${e.data.slice(0, 240)}…` : e.data;
  }
  return null;
}

/** Copy for a step task's own `blocked`-column transition, keyed on the
 *  orchestrator's `column` event `reason`. Only `api-error`/`session-died`/
 *  `unknown-command` (and `undefined`) ever reach the `blocked` column
 *  today (L-R5) — an `approval` reason exists on the event type but no
 *  orchestrator path emits it with `blocked`; a pending question/permission
 *  card is surfaced by the settle path's `user-ask` classification instead,
 *  so there's deliberately no `approval` case here. */
function reasonMessage(reason: string | undefined, stepName: string): string {
  switch (reason) {
    case "api-error":
      return `step "${stepName}" hit an API error`;
    case "session-died":
      return `step "${stepName}" session ended unexpectedly`;
    case "unknown-command":
      return `step "${stepName}" hit an unknown command error`;
    default:
      return `step "${stepName}" is blocked`;
  }
}

// ---------------------------------------------------------------------------
// Snapshot capture (D8)
// ---------------------------------------------------------------------------

/**
 * Freeze `graph` plus every agent profile any step (or any step's
 * `subagents.profileIds`) references, at `now`. Fails — refusing to start
 * the run at all, per D8/Done-criteria #7 — when any step has no
 * `agentProfileId`, a referenced profile no longer exists, or that
 * profile's own harness no longer resolves. `graph` is expected to already
 * be the NORMALIZED output of {@link validatePipelineGraph} (Major 5) — the
 * caller runs that validation, since it also needs to decide what to do
 * with an invalid stored graph before ever reaching this far.
 */
function buildSnapshot(
  graph: PipelineGraph,
  maxSteps: number,
  now: number,
): { snapshot: PipelineRunSnapshot } | { error: string } {
  const neededIds = new Set<string>();
  for (const step of graph.steps) {
    if (!step.agentProfileId) return { error: `step "${step.name}" has no agent` };
    neededIds.add(step.agentProfileId);
    for (const id of step.subagents.profileIds) neededIds.add(id);
  }
  const profiles: Record<string, AgentProfileSnapshot> = {};
  for (const id of neededIds) {
    const profile = agentProfiles.get(id);
    if (!profile) {
      const owner = graph.steps.find((s) => s.agentProfileId === id)?.name;
      return {
        error: owner
          ? `agent "${id}" for step "${owner}" no longer exists`
          : `agent "${id}" (a step's delegation list) no longer exists`,
      };
    }
    const harness = harnesses.getByIdOrKind(profile.harness);
    if (!harness) return { error: `harness for agent "${profile.name}" no longer exists` };
    profiles[id] = snapshotFromProfile(profile, { kind: harness.kind, label: harness.label }, now);
  }
  return {
    snapshot: { graph, maxSteps, profiles, capturedAt: now },
  };
}

// ---------------------------------------------------------------------------
// Worktree upkeep (M6)
// ---------------------------------------------------------------------------

/** Re-materialize (or verify) the parent's shared worktree and persist any
 *  branch/worktreePath change onto its row. Shared by every manual entry
 *  point that might act on a parent whose worktree has gone stale (removed
 *  on disk, source repo moved) since the run last touched it. */
async function refreshParentWorktree(parent: Task, run: PipelineRunState): Promise<{ parent: Task } | { error: string }> {
  // M-R6: while ANY execution of this run is genuinely live (a fan-out
  // sibling mid-turn, a spawn still settling, a held step), `prepareWorkdir`
  // must not run against the shared worktree — its reuse branch runs `git
  // symbolic-ref`/`git checkout` in the directory an agent is actively
  // writing to, and its materialize branch would `git worktree add` on top
  // of it. Only VERIFY the worktree is still on disk in that case; the
  // full (re-)materialization is reserved for a run with nothing live.
  const anyLive = run.active.some((a) => isTaskRunLive(a.taskId));
  if (anyLive) {
    if (parent.isolation === "worktree" && (!parent.worktreePath || !existsSync(parent.worktreePath))) {
      return { error: "the pipeline's worktree is missing while a step is still running — stop the run and retry" };
    }
    return { parent };
  }
  const prepared = await prepareWorkdir(parent, {
    takenBranches: new Set(
      tasks.branchRows().filter((t) => t.id !== parent.id).map((t) => t.branch),
    ),
  });
  if ("error" in prepared) return { error: prepared.error };
  // Only write the row when something actually changed — an unconditional
  // `tasks.update` bumps `updated_at` on every refresh, which re-renders the
  // board card for a no-op and defeats `reconcileById`'s identity
  // preservation in the webview (same rationale as the watermark columns).
  if (parent.branch === prepared.branch && parent.worktreePath === prepared.worktreePath) {
    return { parent };
  }
  const updated = tasks.update(parent.id, { branch: prepared.branch, worktreePath: prepared.worktreePath }) ?? parent;
  return { parent: updated };
}

/** Copy the parent's current `branch`/`worktreePath` onto every step row
 *  still `active` in `run`, so each step's own `startTask` → `prepareWorkdir`
 *  reuse-check sees the up-to-date path instead of whatever it was inserted
 *  with (M6). No-op for a row already in sync. */
function propagateWorktreeToActiveSteps(parent: Task, run: PipelineRunState): void {
  for (const a of run.active) {
    const step = tasks.get(a.taskId);
    if (step && (step.worktreePath !== parent.worktreePath || step.branch !== parent.branch)) {
      tasks.update(a.taskId, { worktreePath: parent.worktreePath, branch: parent.branch });
    }
  }
}

// ---------------------------------------------------------------------------
// Launching a step
// ---------------------------------------------------------------------------

type LaunchResult = { ok: true; runId: string; pending?: true } | { ok: false };

/** Record a retryable run-level hold for `step` instead of launching it —
 *  used whenever the pipeline's parent task turns out to be archived (Major
 *  2): the settle/advance that would otherwise launch this step still has
 *  to land somewhere persistable, but must never insert a new step task or
 *  touch the parent's worktree while it's archived. `pending` carries
 *  `previous`'s arrivals so a later Retry (once the task is unarchived)
 *  re-attempts the exact same launch. Note `pending.stepId` (throughout this
 *  module) is always set — every call site that builds a `pending` block
 *  names the step the retry should re-launch; nothing ever constructs one
 *  without it. */
function holdForArchivedParent(
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
): void {
  upsertBlocked(run, {
    taskId: null,
    stepId: step.id,
    kind: "step-failed",
    message: `step "${step.name}" is ready to launch, but the pipeline task is archived — unarchive it and retry`,
    pending: {
      stepId: step.id,
      arrivals: previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff })),
    },
  });
}

/**
 * Launch one step execution: re-verifies the shared worktree (M6), writes
 * every non-null `previous` handoff to `pipelineRunsDir(parent.id)` (via
 * {@link renderHandoffFile}, which wraps the JSON with the untrusted-content
 * warning), composes the step's prompt (D10 — `composeStepPrompt`, which
 * enforces its own 16 KB inline-handoff budget; re-composed with
 * `inlineHandoff: false` on top of that if the gemini argv cap would
 * otherwise be blown once wrapped for launch), inserts the hidden step task
 * (frozen profile fields copied straight from the snapshot — this task will
 * never go through `effectiveAgentProfile`'s "live" branch, see the guard
 * added there), records it in `run.active`/`run.history`, persists, and
 * calls the ordinary `startTask` on it. A worktree failure, step-cap, or
 * profile-missing failure (the latter only reachable if a profile vanished
 * between snapshot capture and this specific launch — buildSnapshot already
 * checked every step up front) records a blocked entry instead of ever
 * calling `startTask`; the worktree/step-cap/profile-missing blocks all
 * carry `pending` (M2) so a later Retry/Advance can re-attempt the exact
 * same launch. `opts.batchSiblingStepIds` (m9) names every OTHER step being
 * launched in the same fan-out batch as this one — passed by the caller
 * up front, before any of them have actually landed in `run.active` yet, so
 * every prompt in the batch sees the full sibling set instead of only
 * whichever ones happened to launch earlier in the loop. `opts.
 * skipWorktreeRefresh` (Minor 15) lets a caller that already refreshed the
 * parent's worktree ONCE for a whole batch of targets (a fan-out settle, or
 * `advancePipeline`'s own up-front refresh) skip this function's own
 * redundant per-call refresh — `parent` is then trusted to already be
 * current. Mutates `run` and calls `persist` itself — callers don't need to
 * persist again around this (though doing so is harmless/idempotent).
 */
async function launchStep(
  parent: Task,
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
  opts?: { batchSiblingStepIds?: string[]; skipWorktreeRefresh?: boolean; ignoreSlots?: boolean; inputRetryAttempt?: number },
): Promise<LaunchResult> {
  const snapshot = run.snapshot;
  if (!snapshot) {
    upsertBlocked(run, { taskId: null, stepId: step.id, kind: "profile-missing", message: "pipeline run has no snapshot" });
    persist(parent.id, run);
    return { ok: false };
  }

  const pendingArrivals: PipelineJoinArrival[] = previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff }));

  // Minor 7 / Major 2: check the parent still exists, isn't mid-delete, and
  // isn't archived BEFORE touching its worktree at all — a delete cascade or
  // an archive that raced this launch through the same per-parent lock (or,
  // belt-and-braces, landed outside it) must never have a step inserted, or
  // the worktree refreshed, behind its back.
  const currentParent = tasks.get(parent.id);
  if (tombstonedPipelineParents.has(parent.id) || !currentParent) {
    return { ok: false };
  }
  if (currentParent.archivedAt != null) {
    holdForArchivedParent(run, step, previous);
    persist(parent.id, run);
    return { ok: false };
  }
  parent = currentParent;

  // M6: re-verify the shared worktree right before materializing a new step
  // row against it — a run that's been sitting blocked for a while may have
  // had its worktree cleaned up out from under it.
  if (!opts?.skipWorktreeRefresh) {
    const prepared = await refreshParentWorktree(parent, run);
    if ("error" in prepared) {
      upsertBlocked(run, {
        taskId: null,
        stepId: step.id,
        kind: "step-failed",
        message: `could not prepare the pipeline's worktree: ${prepared.error}`,
        pending: { stepId: step.id, arrivals: pendingArrivals },
      });
      persist(parent.id, run);
      return { ok: false };
    }
    parent = prepared.parent;
  }

  if (run.stepCount >= effectiveStepCap(run)) {
    upsertBlocked(run, {
      taskId: null,
      stepId: step.id,
      kind: "step-cap",
      message: `reached the ${effectiveStepCap(run)}-step cap for this run — retry to keep going, or stop here`,
      pending: { stepId: step.id, arrivals: pendingArrivals },
    });
    persist(parent.id, run);
    return { ok: false };
  }
  const profile = step.agentProfileId ? snapshot.profiles[step.agentProfileId] : undefined;
  if (!profile) {
    upsertBlocked(run, {
      taskId: null,
      stepId: step.id,
      kind: "profile-missing",
      message: `step "${step.name}" has no agent`,
      pending: { stepId: step.id, arrivals: pendingArrivals },
    });
    persist(parent.id, run);
    return { ok: false };
  }

  // Step slots (src/bun/step-slots.ts): too many agents at once starve the
  // machine. Over the limit, the step queues — a `slot-wait` block that the
  // slot scheduler (`releaseSlotWaits`) launches when a slot frees.
  if (!opts?.ignoreSlots && !isPriority(parent.id)) {
    const slots = currentSlots();
    const decision = slotDecision(step.name, slotUse(isTaskRunLive, slots), slots);
    if (!decision.ok) {
      upsertBlocked(run, {
        taskId: null,
        stepId: step.id,
        kind: "slot-wait",
        message: `${step.name} is ${decision.why}`,
        pending: { stepId: step.id, arrivals: pendingArrivals },
      });
      slotWaitSince.set(`${parent.id}:${step.id}`, slotWaitSince.get(`${parent.id}:${step.id}`) ?? Date.now());
      persist(parent.id, run);
      return { ok: false };
    }
  }
  slotWaitSince.delete(`${parent.id}:${step.id}`);

  const statusBeforeInputs=tasks.get(parent.id)?.pipelineRun?.status;
  const inputReconciliation=await reconcileCardInputs(parent.id);
  const afterInputs=tasks.get(parent.id);
  if(!afterInputs||afterInputs.archivedAt!=null||afterInputs.pipelineRun?.status==='cancelled'&&statusBeforeInputs!=='cancelled'||tombstonedPipelineParents.has(parent.id))return {ok:false};
  if(inputReconciliation.hold) {
    const attempt=Math.min(32,(opts?.inputRetryAttempt??0)+1);
    const delay=Math.min(300_000,30_000*2**Math.min(4,attempt-1));
    upsertBlocked(run,{taskId:null,stepId:step.id,kind:'step-blocked',message:inputReconciliation.hold,pending:{stepId:step.id,arrivals:pendingArrivals},inputRetry:{at:Date.now()+delay,attempt}});
    persist(parent.id,run);return {ok:false};
  }

  // Reserve before syncBaseNote or any other awaited preparation. Priority
  // changes queue order, never the global runner or verification cap.
  const childId = randomUUID();
  const reservation=reserveRunner(childId,step.name,isTaskRunLive);
  if('error' in reservation) {
    upsertBlocked(run,{taskId:null,stepId:step.id,kind:'slot-wait',message:`${step.name} is ${reservation.error}`,pending:{stepId:step.id,arrivals:pendingArrivals}});
    persist(parent.id,run);return {ok:false};
  }
  try {

  const seq = ++run.stepCount;

  const runDir = pipelineRunsDir(parent.id);
  mkdirSync(runDir, { recursive: true });
  const previousWithFiles: {
    stepName: string;
    handoff: Handoff | null;
    filePath: string | null;
    report: { body: string; filePath: string | null } | null;
  }[] = [];
  const handoffRefs: TaskReference[] = [];
  // The step(s) this one is entered from hand over their whole final report,
  // not just the handoff block: a reviewer's findings (file:line, the failing
  // case, the suggested fix) are in the message body, and the handoff's
  // summary is a line apiece. A follow-up gets every earlier handoff as
  // background — only the newest of those carries its report.
  const reportSeqs = new Set(isFollowUpStepId(step.id) ? previous.slice(-1).map((p) => p.seq) : previous.map((p) => p.seq));
  // M-R8: handoff files are namespaced by run GENERATION (`run.startedAt`,
  // base36 — set once per fresh run/restart, never per retry) so a restart's
  // seq 1..N never overwrites the replaced run's files, which the archived
  // old step rows' `references` still point at. Derived from an existing
  // field on purpose — no `PipelineRunState` schema change, nothing for the
  // sanitizer to learn.
  const generation = (run.startedAt ?? 0).toString(36);
  const written: string[] = [];
  try {
    for (const p of previous) {
      const fromStep = snapshot.graph.steps.find((s) => s.id === p.stepId);
      const stepName = fromStep?.name ?? p.stepId;
      let filePath: string | null = null;
      if (p.handoff) {
        filePath = join(runDir, `handoff-${generation}-${seq}-from-${p.seq}.json`);
        writeFileSync(filePath, renderHandoffFile({ fromStepName: stepName, seq: p.seq, handoff: p.handoff }));
        written.push(filePath);
        handoffRefs.push({ path: filePath, isDirectory: false });
      }
      let report: { body: string; filePath: string | null } | null = null;
      const sender = reportSeqs.has(p.seq)
        ? run.history.find((h) => h.seq === p.seq && h.stepId === p.stepId &&
          (h.outcome === "succeeded" || h.outcome === "advanced-manually"))
        : undefined;
      const full = sender ? stepFinalReport(sender.taskId, sender.startedAt, sender.turnStartedAt ?? null,
        { includeUnstructured: sender.outcome === "advanced-manually", endedAt: sender.endedAt, throughEventId: sender.reportThroughEventId }) : null;
      if (full && full.body.trim().length > 0) {
        // Keyed by the SENDER's execution, so every step it hands to (a
        // fan-out, a retried launch) names the same file; never part of
        // `written` — a failed launch must not delete a sibling's copy.
        let reportPath: string | null = join(runDir, `report-${generation}-${p.seq}.md`);
        try {
          writeFileSync(reportPath, renderReportFile({ fromStepName: stepName, seq: p.seq, messages: full.messages,
            hasValidHandoff: full.handoff !== null }));
          handoffRefs.push({ path: reportPath, isDirectory: false });
        } catch {
          reportPath = null; // the inline copy still goes out
        }
        report = { body: full.body, filePath: reportPath };
      }
      previousWithFiles.push({ stepName, handoff: p.handoff, filePath, report });
    }
  } catch (err) {
    // L-R3: a write that fails partway is a PRE-insert throw — `launchTarget`
    // rolls `run.stepCount` back, so this `seq` is about to be reused by the
    // retry; a stale half-set of files under it must not survive. Remove
    // whatever this launch already wrote (best-effort), then let the throw
    // reach `launchTarget`.
    for (const f of written) {
      try {
        rmSync(f, { force: true });
      } catch {
        // best-effort
      }
    }
    throw err;
  }

  const outgoing = outgoingSteps(snapshot.graph, step.id).map((o) => ({ name: o.step.name, label: o.edge.label }));
  const siblingNames = new Set<string>();
  for (const a of run.active) {
    if (a.stepId !== step.id) siblingNames.add(stepNameById(snapshot.graph, a.stepId));
  }
  for (const id of opts?.batchSiblingStepIds ?? []) {
    if (id !== step.id) siblingNames.add(stepNameById(snapshot.graph, id));
  }
  const parallelSiblings = [...siblingNames];
  const subagentProfiles = step.subagents.profileIds
    .map((id) => snapshot.profiles[id])
    .filter((p): p is AgentProfileSnapshot => p !== undefined);

  const composeArgs = {
    pipelineName: run.pipelineName,
    step,
    stepIndex: seq,
    stepCap: effectiveStepCap(run),
    goal: parent.prompt,
    previous: previousWithFiles,
    outgoing,
    transition: step.transition,
    subagentProfiles,
    subagentCap: step.subagents.cap,
    parentHarnessKind: profile.harnessKind,
    parallelSiblings,
  };
  // M10: step tasks carry the parent's own references plus every handoff
  // file this launch just wrote.
  const references: TaskReference[] = [...(parent.references ?? []), ...handoffRefs];

  // A base branch that moved ahead gets merged in before this step verifies
  // (`pipeline_sync_base`, src/bun/sync-base.ts).
  const syncNote = await syncBaseNote(parent, step.name).catch(() => null);
  const withSync = (prompt: string) => (syncNote ? `${syncNote}\n\n${prompt}` : prompt);
  const manuallyRouted = previous.some((p) => run.history.some((h) => h.seq === p.seq && h.stepId === p.stepId && h.outcome === "advanced-manually"));
  const withRouting = (prompt: string) => manuallyRouted
    ? `${prompt}\n\nThis step was explicitly selected by manual Advance. The preceding verdict and findings are preserved for you to address. This routing decision is not approval of the change and grants no additional permissions.`
    : prompt;
  const withDecisions = (prompt: string) => snapshot.decisionPolicy === "planner-recommendation"
    ? `${prompt}\n\n${plannerDecisionInstructions(parent.id, snapshot.capturedAt)}` : prompt;
  let composed = withSync(withRouting(withDecisions(composeStepPrompt({ ...composeArgs, inlineHandoff: true }))));
  if(inputReconciliation.note)composed+=`\n\n${inputReconciliation.note}`;
  // m12/D10: measure the SAME wrapping `startTaskInner` will actually launch
  // with — `composeLaunchPrompt` (the profile's instructions/skills
  // preamble) then `appendReferences` (the references block) — not the raw
  // step prompt on its own, since either wrapper can push a borderline
  // prompt over gemini's argv cap even when the unwrapped text doesn't.
  if (profile.harnessKind === "gemini") {
    const fullPrompt = appendReferences(composeLaunchPrompt(profile, composed), references);
    if (promptByteOverage("gemini", fullPrompt)) {
      composed = withSync(withRouting(withDecisions(composeStepPrompt({ ...composeArgs, inlineHandoff: false }))));
    }
  }

  const now = Date.now();
  tasks.insert({
    id: childId,
    title: `${run.pipelineName} · ${step.name}`,
    prompt: composed,
    column: "ready",
    agent: profile.harness,
    workdir: parent.workdir,
    isolation: parent.isolation,
    taskType: parent.taskType,
    branch: parent.branch,
    branchSource: parent.branchSource,
    worktreePath: parent.worktreePath,
    baseRef: parent.baseRef,
    prUrl: null,
    issueUrl: null,
    mode: profile.mode,
    model: profile.model,
    effort: profile.effort ?? defaultEffortFor(profile.harnessKind, profile.model, profile.harness),
    fast: profile.fast,
    maxMode: profile.maxMode,
    agentProfileId: profile.id,
    agentProfile: profile,
    references,
    backlog: [],
    draft: null,
    plans: [],
    todoProgress: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    pipelineId: null,
    pipelineRun: null,
    pipelineParentId: parent.id,
    pipelineStepId: step.id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });

  run.active.push({ stepId: step.id, taskId: childId, seq });
  run.history.push({ seq, stepId: step.id, taskId: childId, startedAt: now, endedAt: null, outcome: null, handoff: null, nextStepIds: [] });
  persist(parent.id, run);

  const started = await startTask(childId);

  // M7: the parent may have been deleted WHILE `startTask` was in flight
  // (an unlocked, very-slow spawn racing a delete that queued behind this
  // same launch — belt-and-braces on top of the pre-insert check above).
  if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
    if (!("error" in started)) await deleteTask(childId, { fromPipeline: true });
    return { ok: false };
  }

  if ("error" in started) {
    upsertBlocked(run, { taskId: childId, stepId: step.id, kind: "step-failed", message: started.error });
    persist(parent.id, run);
    return { ok: false };
  }
  return { ok: true, runId: started.runId, ...(started.pending ? { pending: true as const } : {}) };
  } finally {releaseUnspawnedRunner(childId);}
}

/**
 * `launchStep` wrapped so a throw from the launch itself can never abort the
 * rest of a multi-target batch (Minor 14) — used by every loop that can
 * resolve to more than one next step from a single settle or manual advance
 * (a `transition: "all"` fan-out, several hand-picked `advancePipeline`
 * targets, or a join that just completed alongside other targets in the
 * same batch), and by `retryPendingBlocks` (Minor 7) for the exact same
 * throw-safety. Distinguishes WHERE the throw landed (Minor 6): if
 * `launchStep` had already inserted the step task (visible as a new entry
 * in `run.active` for `step.id` that wasn't there before this call), the
 * block is recorded against THAT task (`taskId: <inserted>`, no `pending`)
 * so Retry re-runs the already-inserted execution in place instead of
 * inserting a duplicate one on top of it; a throw before the insert instead
 * keeps the old run-level `pending` block (Retry re-attempts the same
 * launch from scratch), and — since `launchStep` bumps `run.stepCount`
 * before it ever reaches the insert — rolls that increment back so a
 * pre-insert throw can never leave the step-cap accounting inflated by a
 * step that was never actually created. Returns `launchStep`'s own result
 * on success (used by `retryPendingBlocks` to report the first successful
 * launch); most callers discard it, same as calling `launchStep` directly
 * in a loop.
 */
async function launchTarget(
  parent: Task,
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
  opts?: { batchSiblingStepIds?: string[]; skipWorktreeRefresh?: boolean; inputRetryAttempt?: number },
): Promise<LaunchResult> {
  const activeIdsBefore = new Set(run.active.map((a) => a.taskId));
  const stepCountBefore = run.stepCount;
  try {
    return await launchStep(parent, run, step, previous, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const inserted = run.active.find((a) => a.stepId === step.id && !activeIdsBefore.has(a.taskId));
    if (inserted) {
      upsertBlocked(run, {
        taskId: inserted.taskId,
        stepId: step.id,
        kind: "step-failed",
        message: `step "${step.name}" failed to launch: ${message}`,
      });
    } else {
      if (run.stepCount > stepCountBefore) run.stepCount = stepCountBefore;
      upsertBlocked(run, {
        taskId: null,
        stepId: step.id,
        kind: "step-failed",
        message: `step "${step.name}" failed to launch: ${message}`,
        pending: {
          stepId: step.id,
          arrivals: previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff })),
        },
      });
    }
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Retry (shared by startPipelineRun's "retry a blocked/cancelled run" branch
// and retryPipelineStep)
// ---------------------------------------------------------------------------

/** `startTask`'s two "this task is busy" refusals (L-R2) — its own
 *  double-start guards, not failures: a retry that hits either must skip
 *  the execution as live rather than block on it. Matched on the exact
 *  strings `startTask` returns. */
function isStartTaskLiveRefusal(error: string): boolean {
  return error === "task is already starting" || error === "task already running";
}

async function retryActiveExecutions(
  parent: Task,
  run: PipelineRunState,
  onlyTaskId?: string,
): Promise<{ runId: string; pending?: true } | { error: string }> {
  const targets = run.active.filter((a) => {
    // M5: never re-`startTask` an execution whose task is genuinely still
    // live (a fan-out with one branch blocked and another still mid-turn,
    // or a spawn still settling) — `isTaskRunLive` is the authoritative
    // "is this actually busy right now" check, not `column === "running"`,
    // which can lag a beat behind a just-started/just-settled spawn.
    if (isTaskRunLive(a.taskId)) return false;
    if (onlyTaskId) return a.taskId === onlyTaskId;
    // Minor 9: an un-targeted, RUN-LEVEL retry (no `onlyTaskId`) only
    // touches an execution that's actually stuck — one carrying its own
    // blocked entry, or whose latest history outcome recorded a failure or
    // a cancellation — never one quietly sitting in `review` awaiting a
    // human's manual Advance decision (no block, no failed/cancelled
    // outcome — there's nothing broken to retry). A specific `onlyTaskId`
    // retry (the per-step Retry button) is unaffected by this and still
    // fires on the named execution unconditionally, as before.
    if (run.blocked.some((b) => b.taskId === a.taskId)) return true;
    const historyEntry = run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq);
    return historyEntry?.outcome === "failed" || historyEntry?.outcome === "cancelled";
  });
  if (targets.length === 0) return { error: "nothing to retry" };

  let first: { runId: string; pending?: true } | null = null;
  for (const t of targets) {
    run.blocked = run.blocked.filter((b) => b.taskId !== t.taskId);
    const started = await startTask(t.taskId);
    if ("error" in started) {
      // L-R2: `startTask`'s own double-start guards ("task is already
      // starting" — a spawn claim still held, e.g. the bounded-pending
      // window; "task already running" — an `active` handle that landed
      // between our `isTaskRunLive` filter above and this call) mean the
      // execution IS live, not broken — treat exactly like the live-skip
      // above (no block, left alone) rather than recording a step-failed
      // block against a turn that's actually in flight.
      if (isStartTaskLiveRefusal(started.error)) continue;
      upsertBlocked(run, { taskId: t.taskId, stepId: t.stepId, kind: "step-failed", message: started.error });
    } else if (!first) {
      first = { runId: started.runId, ...(started.pending ? { pending: true as const } : {}) };
    }
  }
  checkJoinIncomplete(run);
  persist(parent.id, run);
  return first ?? { error: "retry failed for every blocked step" };
}

/** Re-attempt every run-level `pending` block (`step-cap`/`profile-missing`/
 *  a worktree failure/`join-incomplete`) — M2's "dead-end" recovery: a block
 *  with nothing in `run.active` to retry via `retryActiveExecutions` would
 *  otherwise have no way forward at all besides a full restart. A `step-cap`
 *  block's retry first extends the run's allowance (`run.capExtensions`);
 *  a `join-incomplete` block's retry drops the now-redundant `run.joins`
 *  entry (the pending arrivals travel with the block itself) before
 *  re-launching. Returns the first successful launch's result, or `null`
 *  when there was nothing pending (or every pending launch itself re-blocked).
 *  Never persists itself — callers persist once after, alongside whatever
 *  else they touched. */
async function retryPendingBlocks(
  parent: Task,
  run: PipelineRunState,
): Promise<{ runId: string; pending?: true } | null> {
  const pendingBlocks = run.blocked.filter((b) => b.taskId === null && b.pending);
  let first: { runId: string; pending?: true } | null = null;
  // Minor 10: extend the cap ONCE per retry call, not once per pending
  // `step-cap` block found — the formula stays `maxSteps * (1 +
  // capExtensions)` either way, but a run that somehow queued more than one
  // `step-cap` block must not have this single Retry click silently apply
  // several extensions at once.
  let capExtended = false;
  for (const block of pendingBlocks) {
    const pending = block.pending;
    if (!pending) continue;
    if (block.kind === "step-cap" && !capExtended) {
      run.capExtensions = (run.capExtensions ?? 0) + 1;
      capExtended = true;
    }
    run.blocked = run.blocked.filter((b) => b !== block);
    if (block.kind === "join-incomplete") delete run.joins[pending.stepId];
    const step = run.snapshot?.graph.steps.find((s) => s.id === pending.stepId);
    if (!step) {
      // Nit: never silently drop a pending block whose step vanished from
      // the frozen snapshot (shouldn't normally happen — the snapshot is
      // captured once at first Run — but a corrupted/hand-edited row must
      // not lose the block outright with no trace left for a human to act
      // on) — re-record it, profile-missing-style, instead.
      upsertBlocked(run, {
        taskId: null,
        stepId: pending.stepId,
        kind: "profile-missing",
        message: `step "${pending.stepId}" no longer exists in this run's snapshot`,
        pending,
      });
      continue;
    }
    const previous = pending.arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
    // Minor 15: `parent` here was already freshly refreshed once by this
    // call's sole caller, `performPipelineRetry` — skip `launchStep`'s own
    // redundant per-call refresh. Minor 7: go through `launchTarget`, not
    // `launchStep` directly, so a throw here is caught into a retryable
    // block instead of aborting the rest of this pending-block sweep.
    const launched = await launchTarget(parent, run, step, previous, { skipWorktreeRefresh: true });
    if (launched.ok && !first) first = { runId: launched.runId, ...(launched.pending ? { pending: true as const } : {}) };
  }
  return first;
}

/**
 * Shared retry path for `startPipelineRun`'s "blocked/cancelled" branch and
 * `retryPipelineStep`: refuses an archived parent (M6), re-verifies the
 * shared worktree and propagates it onto every still-active step row, then
 * retries whatever's retryable — active executions first, and (unless a
 * specific `onlyTaskId` was given, which can only ever name an active
 * execution) every run-level pending block too (M2). Never starts a fresh
 * run — a blocked/cancelled pipeline is retried, not restarted.
 */
async function performPipelineRetry(
  parent: Task,
  run: PipelineRunState,
  onlyTaskId?: string,
): Promise<{ runId: string; pending?: true } | { error: string }> {
  // Minor 5: a delete cascade tombstones the parent (and removes its row)
  // before tearing down any step task — a retry racing in through this same
  // per-parent lock must bail before ever touching the worktree.
  if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
    return { error: "pipeline task no longer exists" };
  }
  if (parent.archivedAt != null) {
    return { error: "pipeline task is archived — unarchive it first" };
  }
  const refreshed = await refreshParentWorktree(parent, run);
  if ("error" in refreshed) return { error: refreshed.error };
  const parentRow = refreshed.parent;
  propagateWorktreeToActiveSteps(parentRow, run);

  const activeResult = await retryActiveExecutions(parentRow, run, onlyTaskId);
  let result: { runId: string; pending?: true } | null = "error" in activeResult ? null : activeResult;

  if (!onlyTaskId) {
    // Nit: `retryPendingBlocks` can mutate `run` (clear/re-add blocks,
    // drop/re-add `run.joins` entries) even when it returns `null` — always
    // persist afterward rather than the old `pendingResult ||
    // pendingResult === null` check, which was vacuously true either way.
    const pendingResult = await retryPendingBlocks(parentRow, run);
    checkJoinIncomplete(run);
    persist(parentRow.id, run);
    if (pendingResult && !result) result = pendingResult;
  }

  if (!result) {
    return "error" in activeResult ? { error: activeResult.error } : { error: "nothing to retry" };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API — manual route entry points
// ---------------------------------------------------------------------------

/**
 * Run (or retry) a pipeline task. Called from `orchestrator.ts`'s
 * `startTaskInner` whenever `task.pipelineId` is set — the parent never
 * spawns an agent of its own, so this bypasses every harness/worktree/
 * prompt pre-flight `startTaskInner` normally runs (each hidden step task
 * gets its own, via the ordinary `startTask` call inside `launchStep`).
 *
 * A `blocked`/`cancelled` run is always retried in place (`performPipelineRetry`
 * — never a fresh run, M2); a `done` run refuses unless `opts.restart` is
 * set (the `POST /tasks/:id/pipeline/restart` route's explicit opt-in),
 * since re-running a finished pipeline from scratch is destructive to its
 * history and should never happen from a plain Run click.
 */
export async function startPipelineRun(
  parent: Task,
  opts?: { restart?: boolean; validate?:()=>Promise<string|null> },
): Promise<{ runId: string; pending?: true } | { error: string }> {
  return runExclusive(parent.id, async () => {
    // Minor 5: a delete cascade tombstones the parent (and removes its row)
    // before tearing down any step task — a start/restart racing in through
    // this same per-parent lock must bail before touching the worktree.
    if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
      return { error: "pipeline task no longer exists" };
    }
    const fresh = tasks.get(parent.id) ?? parent;
    if (!fresh.pipelineId) return { error: "not a pipeline task" };
    if (fresh.archivedAt != null) return { error: "pipeline task is archived — unarchive it first" };

    let run: PipelineRunState = fresh.pipelineRun ?? {
      pipelineId: fresh.pipelineId,
      pipelineName: fresh.title,
      snapshot: null,
      status: "idle",
      active: [],
      joins: {},
      blocked: [],
      history: [],
      stepCount: 0,
      startedAt: null,
      endedAt: null,
    };

    if (run.status === "running") return { error: "pipeline is already running" };

    // Major 3 / Minor 3: `restart` means "fresh run from the start step,"
    // for ANY non-running status — blocked, cancelled, done, or even idle (a
    // harmless no-op request in that last case, since idle already falls
    // through to the very same fresh-run code below with nothing to
    // cancel). This used to only take effect for `done`; a restart requested
    // on a blocked/cancelled run fell into the M2 retry-in-place branch
    // below instead and silently became a retry, not a restart. Whatever's
    // still genuinely live from the run being replaced is cancelled further
    // down — only once the fresh run has been validated as startable
    // (Minor 3: a restart that turns out to fail — invalid graph, missing
    // profile, worktree failure — must never have killed the still-live
    // executions it would have replaced).
    if (!opts?.restart) {
      if (run.status === "blocked" || run.status === "cancelled") {
        // M2: absent an explicit restart, blocked/cancelled is ALWAYS a
        // retry-in-place, whether or not anything is currently sitting in
        // `run.active` — a run-level pending block (step-cap,
        // profile-missing, join-incomplete) with zero active executions used
        // to fall through to the "fresh run" branch below, silently
        // discarding history and re-snapshotting from scratch.
        return performPipelineRetry(fresh, run);
      } else if (run.status === "done") {
        return { error: "pipeline already finished — restart it explicitly" };
      }
    }

    // Fresh run (idle, or an explicit restart of any other status):
    // re-resolve the pipeline and (re-)snapshot it. Major 5: the stored
    // graph must be validated (and normalized) before it's ever captured
    // onto a run's frozen snapshot — an edited-in-place or otherwise
    // corrupted graph must fail the run start with a clear error instead of
    // reaching `buildSnapshot`/the runner with malformed shape.
    const pipeline = pipelines.get(fresh.pipelineId);
    let snapshot: PipelineRunSnapshot;
    if (pipeline) {
      const validated = validatePipelineGraph(pipeline.graph);
      if (!validated.ok) return { error: `pipeline graph is invalid: ${validated.error}` };
      const built = buildSnapshot(validated.graph, pipeline.maxSteps, Date.now());
      if ("error" in built) return { error: built.error };
      snapshot = built.snapshot;
      const decisionPolicy = decisionPolicyForProject(preferences.get(PIPELINE_DECISIONS_PREF), fresh.workdir);
      if (decisionPolicy) snapshot.decisionPolicy = decisionPolicy;
    } else if (run.snapshot) {
      // The pipeline row itself is gone (deleted) — the only graph left to
      // run is the one already frozen on this task's previous snapshot.
      // Validate that too: it was built from a real pipeline once, but
      // nothing stops a hand-edited DB row (or a future schema slip) from
      // having corrupted it since.
      const validated = validatePipelineGraph(run.snapshot.graph);
      if (!validated.ok) return { error: `pipeline graph is invalid: ${validated.error}` };
      snapshot = { ...run.snapshot, graph: validated.graph };
    } else {
      return { error: "pipeline no longer exists, and this task has never run it" };
    }

    const startStep = resolveStartStep(snapshot.graph);
    if (!startStep) return { error: "pipeline has no resolvable start step" };

    // Materialize the shared worktree ONCE, here — every step task inserted
    // below copies `branch`/`worktreePath`/`baseRef` straight from the
    // parent, so `prepareWorkdir` on each step hits the reuse branch with no
    // further git calls (D2). `launchStep` re-verifies this itself too
    // (M6), but doing it up front also lets us flip the parent to `running`
    // before the first step lands.
    // `run` here is still the run being REPLACED (or the idle placeholder):
    // its `active` list is what `refreshParentWorktree` consults to decide
    // whether anything live forbids a full `prepareWorkdir` (M-R6) — a
    // restart with a step mid-turn only verifies the worktree, and that
    // step is stopped further down before anything new launches into it.
    const prepared = await refreshParentWorktree(fresh, run);
    if ("error" in prepared) return { error: prepared.error };
    let parentRow = prepared.parent;
    if(opts?.validate) {const error=await opts.validate();if(error)return {error};}

    // Minor 3: only now — graph validated, snapshot built, start step
    // resolved, worktree prepared, so this restart is known startable —
    // stop and retire whatever the run being replaced left behind.
    // M-R8: EVERY step row of the replaced run is archived (not just the
    // still-live ones cancelled), via the same force/stopRun/fromPipeline
    // path `cascadePipelineArchive` uses — `stopRun` covers a live handle
    // AND a held step — after resolving its pending interactions, so an old
    // step's stale ask card can't keep feeding the parent's "waiting on
    // you" count, and the old rows drop out of the board/run view's
    // non-archived step listings. Their run/event history and handoff files
    // survive (archive, not delete); a later delete cascade removes all of
    // it. The explicit `cancelRun` on `restartTargets` is folded into this
    // — `archiveTask({stopRun})` is exactly the Stop button's own path.
    if (opts?.restart) {
      for (const step of tasks.list()) {
        if (step.pipelineParentId !== fresh.id || step.archivedAt != null) continue;
        cancelPendingForTask(step.id, "pipeline restarted");
        const archived = await archiveTask(step.id, { force: true, stopRun: true, fromPipeline: true });
        if ("error" in archived) {
          console.warn(`[agetor] pipeline restart: failed to archive replaced step task ${step.id}:`, archived.error);
        }
      }
    }

    run = {
      pipelineId: fresh.pipelineId,
      pipelineName: pipeline?.name ?? run.pipelineName,
      snapshot,
      status: "running",
      active: [],
      joins: {},
      blocked: [],
      history: [],
      stepCount: 0,
      startedAt: Date.now(),
      endedAt: null,
    };

    // M-R4: persist the fresh run BEFORE launching anything — `persist`'s
    // own idle/done/blocked/cancelled → running transition is what mirrors
    // the parent's column to `running` (L-R4: only on a status change), so
    // the column and the stored run can never disagree, and a launch that
    // throws below lands its block on a run that already exists in the DB.
    persist(parentRow.id, run, { preserveStatus: true });
    parentRow = tasks.get(parentRow.id) ?? parentRow;

    // Through `launchTarget`, not `launchStep` directly (M-R4): a throw
    // from the start step's own launch (an unwritable run dir, a DB error
    // on the insert) becomes a retryable pending block — with `stepCount`
    // rolled back for a pre-insert throw — instead of escaping this route
    // with the parent already flipped to `running` and no block to explain
    // it.
    const result = await launchTarget(parentRow, run, startStep, [], { skipWorktreeRefresh: true });
    checkJoinIncomplete(run);
    persist(parentRow.id, run);
    if (!result.ok) {
      // Queued for a free slot (src/bun/step-slots.ts): started, just not yet.
      if (run.blocked.some((b) => b.kind === "slot-wait" && b.stepId === startStep.id)) {
        return { runId: "", pending: true as const };
      }
      return { error: "pipeline failed to start — see the run's blocked step for details" };
    }
    return { runId: result.runId, ...(result.pending ? { pending: true as const } : {}) };
  });
}

/**
 * Manually resolve whatever a pipeline run is currently waiting on: the
 * execution named by `opts.fromTaskId`, else the sole blocked-on-handoff
 * execution (`handoff-missing`/`handoff-invalid`, or a step that reported
 * `status:"blocked"` in its own handoff — M1), else the sole
 * `join-incomplete` run-level block (launches that join step now, with
 * whatever handoffs arrived), else the sole active execution sitting in
 * `review` — 409 otherwise. `opts.nextStepIds: null` ends that path
 * (terminal); a non-null array launches each named step (joins bypassed —
 * a manual advance into a join step runs it with whatever arrived).
 *
 * Refuses (409) an archived parent (M6) and a target execution whose task
 * still has a genuinely live run (M4 — `isTaskRunLive`, not `column`): you
 * can't hand-pick the next step for a turn that hasn't actually finished.
 */
export async function advancePipeline(
  parentId: string,
  opts: { nextStepIds: string[] | null; handoff?: Partial<Handoff>; fromTaskId?: string },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    // Minor 5: a delete cascade tombstones the parent before tearing down
    // any step task — an advance racing in through this same per-parent
    // lock must bail before ever touching the worktree.
    if (tombstonedPipelineParents.has(parentId)) {
      return { error: "pipeline task no longer exists", status: 404 as const };
    }
    if (parent.archivedAt != null) {
      return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
    }
    if (!parent.pipelineRun || !parent.pipelineRun.snapshot) {
      return { error: "pipeline has never run", status: 409 as const };
    }
    const run: PipelineRunState = parent.pipelineRun;
    const graph = run.snapshot!.graph;

    const refreshed = await refreshParentWorktree(parent, run);
    if ("error" in refreshed) return { error: refreshed.error, status: 409 as const };
    let parentRow = refreshed.parent;
    propagateWorktreeToActiveSteps(parentRow, run);

    let targetTaskId: string | null = null;
    let joinStepId: string | null = null;

    if (opts.fromTaskId) {
      if (!run.active.some((a) => a.taskId === opts.fromTaskId)) {
        return { error: "no active execution for that task", status: 400 as const };
      }
      targetTaskId = opts.fromTaskId;
    } else {
      // M1: a step that reported `status:"blocked"` in its own (otherwise
      // valid) handoff is recorded as a `step-blocked` entry WITH a taskId —
      // fold it into the same auto-detect set as an unparsable handoff, so
      // a lone blocked-on-handoff execution resolves the same way regardless
      // of which of the three reasons produced it. Minor 8: a task-level
      // `step-failed` block (a step that failed its own turn, was stopped
      // while a fan-out sibling kept going, or hit a post-insert launch
      // throw) is folded in too, but ONLY once its task genuinely isn't
      // live any more — a `step-failed` block can in principle name a task
      // whose replacement turn is already running again (Retry re-sends,
      // the block just hasn't been cleared yet), and hand-picking a next
      // step for THAT would race the same turn `advancePipeline`'s own M4
      // check below refuses for an explicit `fromTaskId`.
      const handoffBlocks = run.blocked.filter(
        (b) =>
          b.taskId !== null &&
          (b.kind === "handoff-missing" ||
            b.kind === "handoff-invalid" ||
            b.kind === "step-blocked" ||
            (b.kind === "step-failed" && !isTaskRunLive(b.taskId))),
      );
      const joinBlocks = run.blocked.filter((b) => b.taskId === null && b.kind === "join-incomplete");
      if (handoffBlocks.length === 1 && joinBlocks.length === 0) {
        targetTaskId = handoffBlocks[0]!.taskId;
      } else if (joinBlocks.length === 1 && handoffBlocks.length === 0) {
        joinStepId = joinBlocks[0]!.stepId;
      } else {
        const reviewCandidates = run.active.filter((a) => tasks.get(a.taskId)?.column === "review");
        if (reviewCandidates.length === 1) {
          targetTaskId = reviewCandidates[0]!.taskId;
        } else {
          return { error: "nothing to advance — specify fromTaskId", status: 409 as const };
        }
      }
    }

    if (joinStepId) {
      // M3: `nextStepIds: null` drops the partial join outright — it never
      // arrives, this path is over, and the run's status/blocked state is
      // simply recomputed (which may surface a DIFFERENT, still-pending
      // join elsewhere, or resolve the whole run to `done`). A non-null
      // list launches each named step; only the one that IS the join step
      // itself gets the accumulated arrivals as `previous` — any other
      // step named alongside it is an arbitrary manual choice unrelated to
      // this join and starts with no prior context.
      if (opts.nextStepIds !== null) {
        for (const id of opts.nextStepIds) {
          if (!graph.steps.some((s) => s.id === id)) return { error: `unknown step id "${id}"`, status: 400 as const };
        }
      }
      const arrivals = run.joins[joinStepId]?.arrivals ?? [];
      delete run.joins[joinStepId];
      run.blocked = run.blocked.filter((b) => !(b.stepId === joinStepId && b.kind === "join-incomplete"));

      const joinTargets = opts.nextStepIds === null ? [] : [...new Set(opts.nextStepIds)];
      for (const nid of joinTargets) {
        const targetStep = graph.steps.find((s) => s.id === nid);
        if (!targetStep) continue;
        const previous = nid === joinStepId
          ? arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }))
          : [];
        // Minor 14/15: `launchTarget` catches a per-target throw into a
        // retryable block instead of aborting the rest of the batch;
        // `parentRow` was already freshly refreshed once, above, for this
        // whole call — skip `launchStep`'s own redundant per-call refresh.
        await launchTarget(parentRow, run, targetStep, previous, {
          batchSiblingStepIds: joinTargets,
          skipWorktreeRefresh: true,
        });
      }

      checkJoinIncomplete(run);
      persist(parentId, run);
      return { task: tasks.get(parentId)! };
    }

    if (!targetTaskId) return { error: "nothing to advance", status: 409 as const };
    const activeEntry = run.active.find((a) => a.taskId === targetTaskId);
    if (!activeEntry) return { error: "no active execution for that task", status: 400 as const };

    // M4: refuse to hand-pick a next step for a turn that's still actually
    // in flight — `isTaskRunLive`, not the (laggier) task column.
    if (isTaskRunLive(targetTaskId)) {
      return { error: "step is still running — stop it before advancing", status: 409 as const };
    }

    if (opts.nextStepIds !== null) {
      for (const id of opts.nextStepIds) {
        if (!graph.steps.some((s) => s.id === id)) return { error: `unknown step id "${id}"`, status: 400 as const };
      }
    }
    const nextStepIds = opts.nextStepIds === null ? [] : [...new Set(opts.nextStepIds)];

    // m13: a manual-advance handoff goes through the SAME normalize/cap
    // pipeline a parsed one does (`normalizeHandoff`); `next` defaults to
    // the target step's NAME (matching what `resolveNextSteps` itself
    // matches against), not its id — an explicit `opts.handoff.next` still
    // wins when given.
    const fallbackNextName = nextStepIds.length === 1 ? stepNameById(graph, nextStepIds[0]!) : null;
    const historyEntry = run.history.find((h) => h.taskId === targetTaskId && h.seq === activeEntry.seq);
    // Routing by hand must not erase the findings Build is being sent to fix,
    // or turn the reviewer's blocked verdict into an approval. Explicit
    // replacement fields still win, including intentional empty values.
    const handoffInput: Record<string, unknown> = {
      ...(historyEntry?.handoff ?? { status: "blocked", reason: "manually advanced; previous turn had no valid handoff" }),
      next: fallbackNextName,
      ...opts.handoff,
    };
    if (!(typeof handoffInput.next === "string" && handoffInput.next.trim().length > 0)) {
      handoffInput.next = fallbackNextName;
    }
    const handoff = normalizeHandoff(handoffInput);

    run.active = run.active.filter((a) => a.taskId !== targetTaskId);
    removeBlockedFor(run, targetTaskId);
    if (historyEntry) {
      historyEntry.endedAt = Date.now();
      freezeStepReport(historyEntry);
      historyEntry.outcome = "advanced-manually";
      historyEntry.handoff = handoff;
      historyEntry.nextStepIds = nextStepIds;
    }
    pipelineUpdateColumn(targetTaskId, tasks.get(targetTaskId)?.runId ?? null, "done");

    // m9: every target launched in THIS batch counts as a parallel sibling
    // of every other one — computed up front so the first step launched
    // sees the last one too, not just whichever already landed in
    // `run.active` by the time its own turn in the loop comes up.
    for (const nid of nextStepIds) {
      const targetStep = graph.steps.find((s) => s.id === nid);
      if (!targetStep) continue;
      if (targetStep.join === "all") {
        const arrivals = addJoinArrival(run.joins[nid]?.arrivals ?? [], { fromStepId: activeEntry.stepId, seq: activeEntry.seq, handoff });
        const incoming = incomingSteps(graph, nid);
        const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
        const complete = incoming.every((i) => arrivedIds.has(i.step.id));
        if (complete) {
          delete run.joins[nid];
          await launchTarget(
            parentRow,
            run,
            targetStep,
            arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })),
            { batchSiblingStepIds: nextStepIds, skipWorktreeRefresh: true },
          );
        } else {
          run.joins[nid] = { arrivals };
        }
      } else {
        await launchTarget(
          parentRow,
          run,
          targetStep,
          [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff }],
          { batchSiblingStepIds: nextStepIds, skipWorktreeRefresh: true },
        );
      }
    }

    checkJoinIncomplete(run);
    persist(parentId, run);
    return { task: tasks.get(parentId)! };
  });
}

/** Explicitly adopt a template's instruction edits without restarting the
 * run. No agent is launched, no verdict/hold is cleared, and profiles/caps
 * stay frozen. The caller names both revisions it inspected. */
export async function refreshPipelineInstructions(
  parentId: string,
  opts: { expectedCapturedAt: number; expectedTemplateUpdatedAt: number },
): Promise<{ task: Task; stepIds: string[] } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent?.pipelineId || tombstonedPipelineParents.has(parentId)) {
      return { error: "not a pipeline task", status: 404 as const };
    }
    const run = parent.pipelineRun;
    if (parent.archivedAt != null || !run?.snapshot || !["blocked", "cancelled"].includes(run.status)) {
      return { error: "instructions can only be refreshed on a blocked or cancelled, unarchived run", status: 409 as const };
    }
    if (recoveriesInFlight.has(parentId)) {
      return { error: "automatic recovery is still in flight — instructions were not changed", status: 409 as const };
    }
    if (run.active.some((a) => isTaskRunLive(a.taskId) || isTaskRunCancelling(a.taskId) || remindersInFlight.has(a.taskId))) {
      return { error: "a pipeline execution is still live — instructions were not changed", status: 409 as const };
    }
    if (run.autoRetry?.at != null || run.wait || run.active.some((a) => listPendingForTask(a.taskId).length > 0)) {
      return { error: "recovery or an interaction is pending — resolve that hold before refreshing instructions", status: 409 as const };
    }
    const template = pipelines.get(parent.pipelineId);
    if (!template) return { error: "pipeline template no longer exists", status: 404 as const };
    if (run.snapshot.capturedAt !== opts.expectedCapturedAt || template.updatedAt !== opts.expectedTemplateUpdatedAt) {
      return { error: "run or template changed — inspect the current instructions before refreshing", status: 409 as const };
    }
    const validated = validatePipelineGraph(template.graph);
    if (!validated.ok) return { error: `pipeline graph is invalid: ${validated.error}`, status: 400 as const };
    const updated = updatedPipelineInstructions(run.snapshot.graph, validated.graph);
    if ("error" in updated) return { error: updated.error, status: 409 as const };
    if (updated.stepIds.length === 0) return { task: parent, stepIds: [] };

    // A retry re-launches the existing step task's prompt. Refresh that
    // generated instruction section too, preserving its goal/reports and
    // refusing a hand-edited or ambiguous prompt instead of guessing.
    const promptUpdates: { taskId: string; prompt: string }[] = [];
    for (const active of run.active.filter((a) => updated.stepIds.includes(a.stepId))) {
      const child = tasks.get(active.taskId);
      const before = run.snapshot.graph.steps.find((s) => s.id === active.stepId)!;
      const after = updated.graph.steps.find((s) => s.id === active.stepId)!;
      const needle = `\n\n## Your step\n\n${before.instructions.trim() ? before.instructions : "(no additional instructions)"}\n\n`;
      if (!child || !child.prompt.includes(needle) || child.prompt.indexOf(needle) !== child.prompt.lastIndexOf(needle)) {
        return { error: "step prompt was changed or is ambiguous — instructions were not changed", status: 409 as const };
      }
      const replacement = `\n\n## Your step\n\n${after.instructions.trim() ? after.instructions : "(no additional instructions)"}\n\n`;
      promptUpdates.push({ taskId: child.id, prompt: child.prompt.replace(needle, () => replacement) });
    }
    const now = Math.max(Date.now(), run.snapshot.capturedAt + 1);
    const auditPath = join(pipelineRunsDir(parentId), `instruction-update-${randomUUID()}.json`);
    mkdirSync(pipelineRunsDir(parentId), { recursive: true });
    writeFileSync(auditPath, JSON.stringify({
      updatedAt: now, templateUpdatedAt: template.updatedAt, previousCapturedAt: run.snapshot.capturedAt,
      steps: updated.stepIds.map((id) => ({ id,
        before: run.snapshot!.graph.steps.find((s) => s.id === id)!.instructions,
        after: updated.graph.steps.find((s) => s.id === id)!.instructions,
      })),
    }, null, 2));
    const snapshot = { ...run.snapshot, graph: updated.graph, capturedAt: now };
    db.transaction(() => {
      for (const update of promptUpdates) tasks.update(update.taskId, { prompt: update.prompt });
      tasks.setPipelineRun(parentId, { ...run, snapshot });
    })();
    recordActivity(parentId, { kind: "auto", tone: "info",
      text: `Updated instructions from template for ${updated.stepIds.map((id) => stepNameById(updated.graph, id)).join(", ")}; history and holds preserved. Audit: ${auditPath}` });
    publishGlobalEvent({ kind: "pipeline", taskId: parentId, status: run.status,
      activeStepIds: run.active.map((a) => a.stepId), stepCount: run.stepCount, ts: now });
    return { task: tasks.get(parentId)!, stepIds: updated.stepIds };
  });
}

/** Retry currently blocked executions and pending launches. Never starts a
 * duplicate of a live step; requires a blocked or cancelled run. */
export async function retryPipelineStep(
  parentId: string,
  opts?: { taskId?: string },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;
    if (run.status !== "blocked" && run.status !== "cancelled") {
      return { error: "pipeline is not blocked or cancelled", status: 409 as const };
    }
    const result = await performPipelineRetry(parent, run, opts?.taskId);
    if ("error" in result) return { error: result.error, status: 409 as const };
    return { task: tasks.get(parentId)! };
  });
}

/**
 * Run a follow-up on a finished pipeline: one more step — "Open PR", "Run VM
 * tests", "Explain …", or anything the user asks — in the same worktree, with
 * every earlier handoff as context. The step is appended to the run's frozen
 * graph (with no edges, so it ends the run again) and its agent to the
 * snapshot's profiles; it then launches, settles and hands off exactly like a
 * graph step, so the card goes Running → Review with the follow-up's handoff
 * as the run's newest result. The run's step cap is raised just enough to fit
 * it — the user asked for this step explicitly.
 */
export async function runPipelineFollowUp(
  parentId: string,
  input: { profileId: string; name: string; instructions: string },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (tombstonedPipelineParents.has(parentId)) return { error: "pipeline task no longer exists", status: 404 as const };
    if (parent.archivedAt != null) {
      return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
    }
    const run = parent.pipelineRun;
    if (!run || !run.snapshot) return { error: "pipeline has never run", status: 409 as const };
    // A blocked run whose executions have all stopped can take one too (e.g.
    // "Fix CI" while an "Open PR" step sits blocked); once it launches, the
    // earlier blocks are set aside (`supersedeBlocksBefore`).
    const idleBlocked = run.status === "blocked" && run.active.every((a) => !isTaskRunLive(a.taskId));
    if (run.status !== "done" && !idleBlocked) {
      return { error: "follow-ups run once the pipeline has finished or stopped on a block", status: 409 as const };
    }
    const name = input.name.trim();
    const instructions = input.instructions.trim();
    if (!name) return { error: "name required", status: 400 as const };
    if (!instructions) return { error: "instructions required", status: 400 as const };

    const profile = agentProfiles.get(input.profileId);
    if (!profile) return { error: "agent not found", status: 400 as const };
    const harness = harnesses.getByIdOrKind(profile.harness);
    if (!harness) return { error: `harness for agent "${profile.name}" no longer exists`, status: 400 as const };

    const graph = run.snapshot.graph;
    const count = graph.steps.filter((s) => isFollowUpStepId(s.id)).length;
    const right = graph.steps.reduce((x, s) => Math.max(x, s.position.x), 0);
    const step: PipelineStep = {
      id: `${FOLLOW_UP_STEP_PREFIX}${count + 1}`,
      name,
      instructions,
      agentProfileId: profile.id,
      position: { x: right + 300, y: count * 120 },
      subagents: { profileIds: [], cap: null },
      transition: "choose",
      join: "any",
    };
    run.snapshot = {
      ...run.snapshot,
      graph: { ...graph, steps: [...graph.steps, step] },
      profiles: {
        ...run.snapshot.profiles,
        [profile.id]: snapshotFromProfile(profile, { kind: harness.kind, label: harness.label }, Date.now()),
      },
    };
    const ext = Math.max(0, Math.trunc(run.capExtensions ?? 0));
    if (run.stepCount >= effectiveStepCap(run)) {
      run.snapshot.maxSteps = Math.ceil((run.stepCount + 1) / (1 + ext));
    }

    const previous = run.history
      .filter((r) => r.handoff != null)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ stepId: r.stepId, seq: r.seq, handoff: r.handoff }));
    const launched = await launchTarget(parent, run, step, previous);
    const mine = run.active.find((a) => a.stepId === step.id);
    if (launched.ok && mine) noteSuperseded(parentId, supersedeBlocksBefore(run, mine.seq), name);
    persist(parentId, run);
    if (!launched.ok && run.active.every((a) => a.stepId !== step.id)) {
      const block = run.blocked.find((b) => b.stepId === step.id);
      // Queued for a slot: it starts by itself — not an error.
      if (block?.kind !== "slot-wait") {
        return { error: block?.message ?? "follow-up could not start", status: 409 as const };
      }
    }
    return { task: tasks.get(parentId)! };
  });
}

/**
 * Stop every currently-running active execution (D9: "Stop on the parent
 * cancels every active execution and returns the parent to ready … active
 * set kept so Run retries them"). 409 when nothing is actually live
 * (M5 — `isTaskRunLive`, not `column`).
 */
export async function cancelPipelineRun(parentId: string): Promise<{ task: Task } | { error: string; status: 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;

    const runningTargets = run.active.filter((a) => isTaskRunLive(a.taskId));
    // Stop on a card that's only waiting for an automatic retry cancels the
    // retry; the step stays blocked for the user.
    if (runningTargets.length === 0 && (run.autoRetry?.at != null || run.wait?.state === "waiting")) {
      if (run.autoRetry?.at != null) run.autoRetry = { ...run.autoRetry, at: null };
      // Out of the wait queue too: the block stays, for the user.
      if (run.wait?.state === "waiting") delete run.wait;
      persist(parentId, run);
      recordActivity(parentId, { kind: "step", text: "Automatic retry cancelled — left for you", tone: "muted" });
      return { task: tasks.get(parentId)! };
    }
    if (runningTargets.length === 0) return { error: "pipeline is not running", status: 409 as const };
    // A Stop also cancels any automatic retry that was pending.
    if (run.autoRetry?.at != null) run.autoRetry = { ...run.autoRetry, at: null };

    for (const t of runningTargets) {
      const runId = tasks.get(t.taskId)?.runId;
      if (runId) await cancelRun(runId);
    }

    finalizeCancelled(parentId, run);
    return { task: tasks.get(parentId)! };
  });
}

// ---------------------------------------------------------------------------
// Cascades (orchestrator.ts's deleteTask/archiveTask call into these)
// ---------------------------------------------------------------------------

/** Delete every step task of pipeline task `parentId`, then remove its
 *  `pipeline-runs` directory (handoff JSON files). Best-effort per step —
 *  `deleteTask` itself already swallows teardown errors internally.
 *  Tombstones `parentId` FIRST (M7) so any launch still in flight (racing
 *  in via the same `withPipelineLock`-serialized chain, or — belt-and-braces
 *  — landing outside it) bails instead of inserting a step behind this
 *  cascade's back. */
export async function cascadePipelineDelete(parentId: string): Promise<void> {
  tombstonedPipelineParents.add(parentId);
  try {
    // Every step row — archived ones included (`tasks.list()` carries
    // archived rows; don't depend on `stepsForParent`'s own filtering, which
    // may exclude them — a restart archives the replaced run's steps, M-R8).
    for (const step of tasks.list()) {
      if (step.pipelineParentId !== parentId) continue;
      await deleteTask(step.id, { fromPipeline: true });
    }
  } catch (err) {
    // M-R7: the parent row still exists — a tombstone left behind here would
    // make it permanently un-runnable ("pipeline task no longer exists")
    // while its card is still on the board. Undo it and let the caller's
    // own throw surface; the user can simply retry the delete.
    tombstonedPipelineParents.delete(parentId);
    throw err;
  }
  try {
    rmSync(pipelineRunsDir(parentId), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[agetor] failed to remove pipeline run dir for ${parentId}:`, e);
  }
}

/** Archive every not-yet-archived step task of pipeline task `parentId`.
 *  Best-effort — a step that refuses to archive (logged) doesn't block the
 *  rest, or the parent's own subsequent archive. */
export async function cascadePipelineArchive(parentId: string): Promise<void> {
  for (const step of tasks.stepsForParent(parentId)) {
    if (step.archivedAt != null) continue;
    const result = await archiveTask(step.id, { force: true, stopRun: true, fromPipeline: true });
    if ("error" in result) {
      console.warn(`[agetor] failed to archive pipeline step task ${step.id}:`, result.error);
    }
  }
}

// ---------------------------------------------------------------------------
// Settle/column event handling
// ---------------------------------------------------------------------------

/** Count of pending interactions registered against THIS settled run only,
 *  not the whole task. `countPendingForTask` would include stale/unrelated
 *  entries from an earlier run of the same step (a retry, or — in tests — a
 *  fixture registered under a synthetic runId and never cleared), which
 *  would misclassify a valid handoff as `user-ask` forever since nothing
 *  ever removes those leftovers. Scoping to `runId` means only an
 *  interaction actually raised by the run that just settled can suppress
 *  its handoff classification. */
function pendingInteractionsForRun(taskId: string, runId: string): number {
  return listPendingForTask(taskId).filter((r) => r.runId === runId).length;
}

/** Reasons `attemptHandoffReminderOrBlock` can be asked to send the one
 *  automatic reminder for — mirrors {@link PipelineStepReminder}'s own
 *  `reason` union. */
type HandoffReminderReason = "handoff-missing" | "handoff-invalid" | "handoff-next-unknown";

/** The status line appended to the step's run (and broadcast live via
 *  {@link appendRunStatusLine}) once a reminder is actually delivered — one
 *  per {@link HandoffReminderReason}. */
function reminderSentStatusLine(reason: HandoffReminderReason): string {
  switch (reason) {
    case "handoff-missing":
      return "handoff missing — sent one automatic reminder; the next reply must contain the <handoff> block";
    case "handoff-invalid":
      return "handoff invalid — sent one automatic reminder; the next reply must contain a valid <handoff> block";
    case "handoff-next-unknown":
      return "handoff next-step unclear — sent one automatic reminder; the next reply must name exactly one outgoing step";
  }
}

/** The `PipelineBlock.kind` a reminder-eligible response falls back to
 *  whenever no reminder actually goes out (never attempted, already used
 *  once, or delivery failed). `"handoff-next-unknown"` isn't itself a block
 *  kind — a `next` that didn't resolve to a real outgoing step is really a
 *  malformed/ambiguous handoff — so it maps onto `"handoff-invalid"`, the
 *  same kind `resolveNextSteps`'s ambiguous/unknown outcomes blocked with
 *  before this reminder existed (round 4, Low finding). */
function reminderBlockKind(reason: HandoffReminderReason): "handoff-missing" | "handoff-invalid" {
  return reason === "handoff-missing" ? "handoff-missing" : "handoff-invalid";
}

/**
 * A reminder the locked settle body decided to send but deliberately did
 * NOT send under the per-parent lock (L-R7): `sendInput` can hold for
 * several seconds (a claude paste awaits its outcome, bounded by a 5 s
 * race; a one-shot harness's spawn is raced against
 * `SPAWN_RESPONSE_BUDGET_MS`), and every other settle/route mutation for
 * the same parent would otherwise queue behind it. The locked body records
 * the intent in-memory (`remindersInFlight`), persists the run with the
 * execution still active and unblocked, and hands this back;
 * {@link deliverHandoffReminder} then sends OUTSIDE the lock and re-acquires
 * it to stamp the outcome — `reminder` on the history entry only when
 * `sendInput` reports `delivered: true` (the "record only delivered"
 * contract is unchanged), an ordinary block otherwise.
 */
interface PendingReminder {
  parentId: string;
  taskId: string;
  runId: string;
  seq: number;
  stepId: string;
  reason: HandoffReminderReason;
  detail: string;
  baseMessage: string;
  reminderText: string;
}

/** Step task ids whose one automatic reminder is mid-send outside the lock.
 *  A second settle for the same execution arriving in that window — the
 *  `review` column event and the `run-status` event for ONE turn both reach
 *  the settle body, see `handleColumnChange` — must not classify and send
 *  again: the in-flight reminder owns this execution's next state. Cleared
 *  by `deliverHandoffReminder` once it re-acquires the lock. */
const remindersInFlight = new Set<string>();
/** A turn that ended while its reminder was still mid-send (a fast reply can
 *  finish before `sendInput` returns): settled once the send completes,
 *  instead of being dropped. */
const deferredSettles = new Map<string, { runId: string; status: "succeeded" | "failed" | "cancelled" | "orphaned" }>();

/**
 * Decide whether the single automatic handoff-format reminder for `taskId`'s
 * just-succeeded (but not yet resolvable) execution should go out, falling
 * back to an ordinary retryable block whenever a reminder either isn't
 * warranted right now or has already been used. Runs UNDER the per-parent
 * lock and never sends itself (L-R7) — it returns a {@link PendingReminder}
 * for the caller to deliver once the lock is released, or `null` when it
 * recorded a block instead. Handles its own `checkJoinIncomplete` +
 * `persist` on every path.
 *
 * Order of checks (round 4 review fixes):
 *  - Already reminded once for this execution (`historyEntry.reminder` set,
 *    for ANY reason — one reminder max per execution) blocks immediately,
 *    ahead of every other check below: there's nothing left to attempt.
 *  - Major 1: re-reads the parent AND the step task fresh — the copies
 *    `settleStepRun` captured at the top of its turn can be stale, since
 *    an `archiveTask`/delete cascade races in through this exact same
 *    per-parent lock (`archiveTask` sets `archivedAt` on the parent row
 *    BEFORE it ever acquires the lock, per `persist`'s "m8" doc). A
 *    tombstoned/missing/archived parent, or an archived step task, must
 *    never reach `sendInput` — it falls straight to the ordinary block.
 *  - Major 2: `isDeliberateWholeRunStop` — a step that finished with a bad
 *    handoff while the whole run is being torn down (`cancelPipelineRun`,
 *    or every other live sibling already mid-cancellation) must not have
 *    the reminder revive the run back into `running`.
 *  - Otherwise: hand the send back to the caller. Medium 3 — the reminder
 *    is recorded onto `historyEntry.reminder` ONLY when `sendInput` reports
 *    `delivered: true` (see `deliverHandoffReminder`); a failed/withheld
 *    send records NOTHING there, so the NEXT settle may still try once, and
 *    folds the failure reason into the ordinary block's message instead.
 */
function attemptHandoffReminderOrBlock(input: {
  parentId: string;
  run: PipelineRunState;
  taskId: string;
  runId: string;
  activeEntry: PipelineActiveStep;
  historyEntry: PipelineStepRecord | undefined;
  graph: PipelineGraph;
  stepName: string;
  reason: HandoffReminderReason;
  detail: string;
  baseMessage: string;
}): PendingReminder | null {
  const { parentId, run, taskId, runId, activeEntry, historyEntry, graph, stepName, reason, detail, baseMessage } = input;
  const blockKind = reminderBlockKind(reason);

  if (historyEntry?.reminder) {
    // Already reminded once for this execution (retries don't reset it —
    // see `PipelineStepReminder`'s doc) — a second bad response blocks
    // instead of reminding again.
    upsertBlocked(run, {
      taskId,
      stepId: activeEntry.stepId,
      kind: blockKind,
      message: `still no valid handoff after one reminder — ${baseMessage}`,
    });
    checkJoinIncomplete(run);
    persist(parentId, run);
    return null;
  }

  // Major 1: re-read fresh — see this function's doc for why the top-of-turn
  // copies can be stale.
  const parentFresh = tasks.get(parentId);
  const parentGone = tombstonedPipelineParents.has(parentId) || !parentFresh;
  const parentArchived = !parentGone && parentFresh!.archivedAt != null;
  const stepFresh = tasks.get(taskId);
  const stepArchived = stepFresh != null && stepFresh.archivedAt != null;
  // Major 2: never revive a run that's already being deliberately stopped.
  const deliberateStop = isDeliberateWholeRunStop(run, taskId);

  const skipReason = parentGone
    ? "the pipeline task no longer exists"
    : parentArchived
      ? "the pipeline task is archived"
      : stepArchived
        ? "the step task is archived"
        : deliberateStop
          ? "the pipeline run is stopping"
          : null;

  if (skipReason) {
    upsertBlocked(run, {
      taskId,
      stepId: activeEntry.stepId,
      kind: blockKind,
      message: `${baseMessage} (automatic reminder skipped — ${skipReason})`,
    });
    checkJoinIncomplete(run);
    persist(parentId, run);
    return null;
  }

  const stepObj = graph.steps.find((s) => s.id === activeEntry.stepId);
  const outgoing = outgoingSteps(graph, activeEntry.stepId).map((o) => ({ name: o.step.name, label: o.edge.label }));
  const transition = stepObj?.transition ?? "choose";
  const reminderText = composeHandoffReminder({ stepName, reason, detail, outgoing, transition, canFinish: stepObj?.canFinish === true });

  // No block recorded — the execution stays `active`; the send itself
  // happens once the caller has released the lock (L-R7).
  remindersInFlight.add(taskId);
  checkJoinIncomplete(run);
  persist(parentId, run);
  return {
    parentId,
    taskId,
    runId,
    seq: activeEntry.seq,
    stepId: activeEntry.stepId,
    reason,
    detail,
    baseMessage,
    reminderText,
  };
}

/**
 * Second half of the reminder (L-R7): send `p.reminderText` as an ordinary
 * follow-up turn on the step's own run with NO lock held, then re-acquire
 * the per-parent lock to stamp the outcome. `sendInput` folds into the live
 * session (claude) or spawns a fresh turn (codex/cursor/gemini/fx) — either
 * way it settles through the same settle path again, which is what carries
 * the execution to its next classification once the reminder turn
 * finishes. Nothing here revives an execution that was retried/advanced
 * while the send was in flight: a delivered reminder is still stamped on
 * its history entry (it's a fact), but a failed send only records its block
 * if the execution is still the active one.
 */
async function deliverHandoffReminder(p: PendingReminder): Promise<void> {
  try {
    await deliverHandoffReminderInner(p);
  } finally {
    // The reply to the reminder may already have finished while it was being
    // sent — settle it now rather than leave the step running forever.
    // Only when the step is idle again — the reply really finished. A step
    // still working on the reminder settles through its own run-status event.
    const deferred = deferredSettles.get(p.taskId);
    deferredSettles.delete(p.taskId);
    const step = tasks.get(p.taskId);
    if (deferred && step?.column === "review" && !isTaskRunLive(p.taskId)) {
      const entry = tasks.get(p.parentId)?.pipelineRun?.history.find((h) => h.taskId === p.taskId && h.seq === p.seq);
      if (entry?.reminder && entry.outcome == null) void handleRunStatus(p.taskId, deferred.runId, deferred.status);
    }
  }
}

async function deliverHandoffReminderInner(p: PendingReminder): Promise<void> {
  let sent: Awaited<ReturnType<typeof sendInput>>;
  try {
    sent = await sendInput(p.runId, p.reminderText);
  } catch (err) {
    sent = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await runExclusive(p.parentId, async () => {
    remindersInFlight.delete(p.taskId);
    try {
      const parent = tasks.get(p.parentId);
      if (!parent || !parent.pipelineRun) return;
      const run = parent.pipelineRun;
      const historyEntry = run.history.find((h) => h.taskId === p.taskId && h.seq === p.seq);

      if (sent.delivered) {
        if (historyEntry) {
          historyEntry.reminder = {
            at: Date.now(),
            reason: p.reason,
            // The run this reminder actually landed on — for claude, the
            // SAME run that just settled (a fold-while-busy paste into the
            // still-live session); for the one-shot harnesses
            // (codex/cursor/gemini/fx) a FRESH run row `sendInput` minted,
            // which may itself already be busy again by the time anything
            // reads this back (Medium 5).
            runId: sent.runId,
            detail: p.detail,
            delivered: true,
          };
        }
        appendRunStatusLine(p.taskId, p.runId, reminderSentStatusLine(p.reason));
        checkJoinIncomplete(run);
        persist(p.parentId, run);
        return;
      }

      // Medium 3: a claude modal-guard withhold stashes the (undelivered)
      // reminder text into the step task's own backlog tray — remove it
      // right away so the tray doesn't silently fill with machine-generated
      // text the user never typed. Best-effort: a lookup/remove failure here
      // must never block recording the ordinary blocked-path outcome below.
      if (sent.withheld && sent.savedToBacklog) {
        try {
          const stashed = tasks.get(p.taskId);
          const item = stashed?.backlog.find((b) => b.text === p.reminderText);
          if (item) backlog.remove(p.taskId, item.id);
        } catch (err) {
          console.warn(`[agetor] pipeline runner: failed to remove stashed reminder draft for task ${p.taskId}:`, err);
        }
      }

      // Could not deliver the reminder — fall straight through to the
      // ordinary blocked path, folding the send failure into the message so
      // a human can see why no reminder went out. Medium 3: nothing is
      // recorded onto `historyEntry.reminder` here, so the NEXT settle may
      // still try once. Only if this execution is still the active one —
      // a Retry/Advance that landed while the send was in flight already
      // decided its fate.
      const stillActive = run.active.some((a) => a.taskId === p.taskId && a.seq === p.seq);
      if (!stillActive) return;
      upsertBlocked(run, {
        taskId: p.taskId,
        stepId: p.stepId,
        kind: reminderBlockKind(p.reason),
        message: `${p.baseMessage} (automatic reminder could not be sent: ${sent.reason})`,
      });
      checkJoinIncomplete(run);
      persist(p.parentId, run);
    } catch (err) {
      persistReconcileFailure(p.parentId, p.taskId, err);
    }
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed stamping reminder outcome for task ${p.taskId}:`, err);
  });
}

/** Record a retryable run-level hold for `step` instead of launching it —
 *  the whole-run-stop twin of {@link holdForArchivedParent} (M-R2): a step
 *  that finished cleanly (valid handoff, resolvable next steps) AFTER the
 *  user pressed Stop on the whole pipeline must have its outcome recorded,
 *  but must never launch the next step into a run that's being torn down.
 *  The hold carries the exact launch so a later Retry continues from here. */
function holdForStoppedRun(
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
): void {
  upsertBlocked(run, {
    taskId: null,
    stepId: step.id,
    kind: "step-failed",
    message: `step "${step.name}" is ready to launch, but the pipeline run was stopped — retry to continue`,
    pending: {
      stepId: step.id,
      arrivals: previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff })),
    },
  });
}

/**
 * The settle body — ONE implementation for every way a step execution's
 * terminal outcome reaches this module: the orchestrator's `run-status`
 * event (`handleRunStatus`), a step task's own `ready`/`review` column
 * transition re-read against its latest run row (`handleColumnChange`,
 * H1b/M-R3), and the boot-time missed-settle sweep (`reconcilePipelineRuns`,
 * via `handleRunStatus`). MUST be called under `runExclusive(parentId)`.
 * Returns a {@link PendingReminder} the caller delivers once it has released
 * the lock (L-R7), else `null`. Idempotent against the same settle arriving
 * twice (a `review` column event and its `run-status` twin): a succeeded
 * execution that already advanced is no longer `active`; a failed/
 * cancelled one already carries its `outcome`; a reminder mid-send owns its
 * execution (`remindersInFlight`); a held step just stays held.
 */
async function settleStepRun(
  parentId: string,
  taskId: string,
  runId: string,
  status: "succeeded" | "failed" | "cancelled" | "orphaned",
): Promise<PendingReminder | null> {
  try {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineRun || !parent.pipelineRun.snapshot) return null;
    const run = parent.pipelineRun;
    const activeIdx = run.active.findIndex((a) => a.taskId === taskId);
    if (activeIdx === -1) return null;
    const activeEntry = run.active[activeIdx]!;
    const graph = run.snapshot!.graph;
    const stepName = stepNameById(graph, activeEntry.stepId);
    const historyEntry = run.history.find((h) => h.taskId === taskId && h.seq === activeEntry.seq);

    // An automatic reminder for this very execution is mid-send outside the
    // lock — its outcome (stamp, or block) is what decides this execution's
    // next state, not a second classification of the same turn.
    if (remindersInFlight.has(taskId)) {
      deferredSettles.set(taskId, { runId, status });
      return null;
    }

    if (status === "succeeded") {
      // One-shot handoff reminder (owner request, `docs/plans/pipelines.md`):
      // `classifyStepResponse` is the single decision point for what this
      // execution's final response actually was. It's called on EVERY
      // settle (not just this succeeded branch — see the failed/cancelled
      // branches below) so `historyEntry.responseKind` always reflects the
      // outcome, even for a settle that never reaches the reminder logic.
      // L-R6: the run's main-stream rows are loaded ONCE here.
      // Only this turn's text: a handoff from before the step was re-entered
      // (a usage-limit resume, a reminder, a retry…) is void.
      const assistantText = executionAssistantText(taskId, runId, historyEntry?.startedAt ?? null, historyEntry?.turnStartedAt ?? null);
      const pendingInteractions = pendingInteractionsForRun(taskId, runId);
      const classified = classifyStepResponse({ runStatus: status, assistantText, pendingInteractions });
      if (historyEntry) historyEntry.responseKind = classified.kind;
      // The step got through: its automatic-retry count starts over.
      if (classified.kind === "handoff" && run.autoRetry?.stepId === activeEntry.stepId) delete run.autoRetry;

      // M-R3: the turn succeeded but the step task is HELD — background
      // subagents it spawned are still running, and the orchestrator has
      // parked the card in `running` rather than advancing it. That's not a
      // settled step: record what the response classified as and keep the
      // execution active, unblocked. `maybeReleaseHeldTask`'s release
      // (column → `review`) re-enters this body through
      // `handleColumnChange`'s `review` branch once the last helper
      // finishes, and THAT settle advances the graph.
      if (isHeldByBackgroundAgents(taskId)) {
        persist(parentId, run);
        return null;
      }

      // The step handed a long command to agetor-await and ended its turn to
      // wait (src/bun/awaits.ts): park it — the await watcher wakes it with
      // the result — instead of nagging it for a handoff.
      if (classified.kind === "handoff-missing" && parent?.worktreePath) {
        const out = awaitsFor(parent.worktreePath, historyEntry?.startedAt ?? 0);
        if (out.length) {
          upsertBlocked(run, {
            taskId,
            stepId: activeEntry.stepId,
            kind: "await",
            message: `${stepName} is waiting on ${out.map((a) => `"${a.label}"`).join(", ")} — wakes when it finishes`,
          });
          persist(parentId, run);
          return null;
        }
      }

      if (classified.kind === "handoff-missing" || classified.kind === "handoff-invalid") {
        // Not blocked yet — attempt the ONE automatic reminder as an
        // ordinary follow-up turn on the step's own run, rather than
        // blocking the run over a step that may simply have forgotten the
        // handoff format. See `attemptHandoffReminderOrBlock` for the
        // round-4 review-fix conditions (archived/tombstoned parent or
        // step, a run that's being deliberately stopped, already reminded)
        // that instead fall straight to an ordinary block; the send itself
        // happens outside the lock (`deliverHandoffReminder`).
        const reason = classified.kind;
        const baseMessage = reason === "handoff-missing"
          ? `step "${stepName}" finished but never emitted a <handoff> block`
          : `step "${stepName}" emitted a <handoff> block agetor couldn't parse: ${classified.error}`;
        const detail = classified.error ?? (reason === "handoff-missing"
          ? "no <handoff> block was found"
          : "the handoff JSON could not be parsed");
        return attemptHandoffReminderOrBlock({
          parentId, run, taskId, runId, activeEntry, historyEntry, graph, stepName, reason, detail, baseMessage,
        });
      }

      if (classified.kind === "user-ask") {
        // Medium 4: the step's task already reflects a pending interaction
        // through the ordinary interactions/column machinery — but a
        // pending card must still surface as a retryable block on the
        // RUN, not just on the task, so `deriveRunStatus` reads `blocked`
        // (not a silent `running` with an execution nothing will ever
        // advance on its own) until the user answers. The "running"-column
        // handler already clears ANY block naming this task the moment the
        // step task genuinely runs again (m11) — including this one —
        // which is what happens once the user answers the card and the
        // step's own turn resumes.
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-blocked",
          message: `step "${stepName}" is waiting for you`,
        });
        // It asked the user something: never the queue's to retry.
        if (run.wait?.taskId === taskId) delete run.wait;
        checkJoinIncomplete(run);
        persist(parentId, run);
        return null;
      }

      // M1: a step can emit a perfectly valid handoff and still report it
      // could not finish (`status:"blocked"`) — record it on the history
      // entry (so the blocked reason and the step's own summary/artifacts
      // are visible), but do NOT resolve/advance: the execution stays in
      // `run.active` exactly like an unresolved handoff, waiting on a
      // Retry (re-run the step) or a manual Advance.
      // …unless it also chose where the work goes next ("verification
      // failed" → Fix): the step routed it, so follow that choice instead of
      // stopping the run on a person.
      // The exceptions are narrow (`blockedHandoffChoosesNext`): the step had
      // a real choice of next step and made one. A step with a single way
      // forward did not choose it — the contract dictates its `next` — so
      // its "blocked" keeps the run here; and a turn that ran into a usage
      // limit is never routed anywhere, whatever it wrote: it is resumed
      // when the limit resets.
      const blockedHandoff = classified.kind === "handoff-blocked" ? classified.handoff! : null;
      // Claude's usage-limit grace window told the agent to stop and say so.
      const limitNotice = blockedHandoff ? quotaNoticeFrom(mainStreamEventsForRun(runId)) : null;
      const blockedButRouted = !!blockedHandoff && !limitNotice && blockedHandoffChoosesNext(graph, activeEntry.stepId, blockedHandoff);
      if (blockedButRouted) {
        recordActivity(parentId, {
          kind: "step",
          text: `${stepName} reported a problem and handed it to "${blockedHandoff!.next}" — following its choice`,
          tone: "warning",
        });
      }
      if (blockedHandoff && !blockedButRouted) {
        const handoff = blockedHandoff;
        const oq = handoff.openQuestions.length > 0
          ? ` (open questions: ${handoff.openQuestions.join("; ")})`
          : "";
        const reasonText = handoff.reason.trim().length > 0 ? handoff.reason : "no reason given";
        // Where the unfinished work would have gone had `next` been followed.
        const wouldGoTo = resolveNextSteps(graph, activeEntry.stepId, handoff);
        const insteadOf = handoff.next?.trim() && wouldGoTo.kind === "steps" ? wouldGoTo.stepIds.map((id) => stepNameById(graph, id)) : [];
        // The column and run-status events both settle one turn: say it once.
        const alreadyHeld = run.blocked.some((b) => b.taskId === taskId && b.kind === "step-blocked");
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-blocked",
          message: limitNotice
            ? `step "${stepName}" stopped at its usage limit before finishing — it resumes here when the limit resets: ${reasonText}`
            : `step "${stepName}" reported it is blocked: ${reasonText}${oq}`,
        });
        if (historyEntry) historyEntry.handoff = handoff;
        if (limitNotice) {
          // Not a decision for the user: continue the same session once the
          // limit resets (claude may also continue the turn by itself at
          // the reset; the retry then finds the step running and stands
          // down).
          scheduleAutoRetry(parentId, run, activeEntry.stepId, limitNotice, "hit a usage limit", { resume: "handoff", insteadOf });
        } else if (!alreadyHeld) {
          // Whose move is it? Something that clears by itself parks the run
          // in the wait queue and this same step is resumed later; anything
          // that asks the owner stays here for them.
          const decided = scheduleBlockWait(parentId, parent, run, activeEntry, handoff, stepName);
          if (decided === "owner" && insteadOf.length > 0) {
            recordActivity(parentId, {
              kind: "step",
              text: `${stepName} handed off "blocked" with its work unfinished — holding the run on ${stepName} instead of starting ${insteadOf.join(", ")}`,
              tone: "warning",
            });
          }
        }
        checkJoinIncomplete(run);
        persist(parentId, run);
        return null;
      }

      if (classified.kind !== "handoff" && !blockedButRouted) {
        // Defensive: `classifyStepResponse` only returns "error"/
        // "cancelled" for the failed/cancelled/orphaned run statuses,
        // never for "succeeded" — this can't actually be reached, but
        // stay exhaustive rather than fall into `resolveNextSteps` with a
        // null handoff.
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-failed",
          message: `step "${stepName}" finished with an unexpected response`,
        });
        checkJoinIncomplete(run);
        persist(parentId, run);
        return null;
      }

      const parsedHandoff = classified.handoff!;
      const resolved = resolveNextSteps(graph, activeEntry.stepId, parsedHandoff);
      if (resolved.kind === "ambiguous" || resolved.kind === "unknown") {
        // Low: a parsed handoff whose `next` didn't resolve to a real
        // outgoing step is a malformed handoff, not a valid one — override
        // the `"handoff"` stamp `classifyStepResponse` gave this execution
        // above (it can't have known about the graph). Gets the same one
        // automatic reminder as handoff-missing/invalid (round 4).
        if (historyEntry) historyEntry.responseKind = "handoff-invalid";
        const candidates = resolved.candidates.join(", ") || "(no outgoing steps)";
        const baseMessage = resolved.kind === "ambiguous"
          ? `step "${stepName}" finished but didn't say which step comes next — choices: ${candidates}`
          : `step "${stepName}" asked for step "${resolved.next}", which doesn't match any of: ${candidates}`;
        return attemptHandoffReminderOrBlock({
          parentId,
          run,
          taskId,
          runId,
          activeEntry,
          historyEntry,
          graph,
          stepName,
          reason: "handoff-next-unknown",
          detail: `choose exactly one of: ${candidates}`,
          baseMessage,
        });
      }

      // M-R2: decided BEFORE this execution is removed from `active` —
      // `isDeliberateWholeRunStop` counts the OTHER live siblings, so the
      // answer is the same either way, but `run.status === "cancelled"` on
      // entry is the load-bearing half: `cancelPipelineRun` forces it via
      // `finalizeCancelled` before any sibling's own settle can land here.
      const wholeRunStop = run.status === "cancelled" || isDeliberateWholeRunStop(run, taskId);

      // Resolved (terminal or a real set of next steps) — this execution is
      // done. Remove it, mark history, move the step task to `done`.
      run.active.splice(activeIdx, 1);
      removeBlockedFor(run, taskId);
      const nextStepIds = resolved.kind === "steps" ? resolved.stepIds : [];
      if (historyEntry) {
        historyEntry.endedAt = Date.now();
        freezeStepReport(historyEntry);
        historyEntry.outcome = "succeeded";
        historyEntry.handoff = parsedHandoff;
        historyEntry.nextStepIds = nextStepIds;
      }
      pipelineUpdateColumn(taskId, runId, "done");

      if (wholeRunStop) {
        // M-R2: a step that finished cleanly AFTER the user stopped the
        // whole run — its own settle raced the Stop — must never launch its
        // successors into a run being torn down (which would silently
        // revive the run back to `running`). Its outcome is recorded above
        // exactly as a normal success; every resolved next step becomes a
        // run-level pending hold (a completed join launches as one hold
        // carrying its full arrival set; an incomplete join just keeps its
        // arrival in `run.joins` for whatever the retry of its other
        // sources brings), and the run finalizes as stopped. Retry picks the
        // holds back up via `retryPendingBlocks`.
        for (const nid of nextStepIds) {
          const targetStep = graph.steps.find((s) => s.id === nid);
          if (!targetStep) continue;
          if (targetStep.join === "all") {
            const arrivals = addJoinArrival(run.joins[nid]?.arrivals ?? [], {
              fromStepId: activeEntry.stepId,
              seq: activeEntry.seq,
              handoff: parsedHandoff,
            });
            const incoming = incomingSteps(graph, nid);
            const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
            if (incoming.every((i) => arrivedIds.has(i.step.id))) {
              delete run.joins[nid];
              holdForStoppedRun(run, targetStep, arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })));
            } else {
              run.joins[nid] = { arrivals };
            }
          } else {
            holdForStoppedRun(run, targetStep, [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff: parsedHandoff }]);
          }
        }
        finalizeCancelled(parentId, run);
        return null;
      }

      // Major 2: re-read the parent fresh — it may have been archived
      // between this settle firing and this handler acquiring the
      // per-parent lock (an `archiveTask` cascade races through the same
      // lock, but sets `archivedAt` on the row BEFORE it ever acquires
      // it). An archived parent must never have this settle spawn a new
      // step task or touch its worktree — every resolved next step is
      // recorded as a retryable pending hold instead of launched.
      const parentForLaunch = tasks.get(parentId) ?? parent;
      const parentArchived = parentForLaunch.archivedAt != null;
      // Minor 5: same tombstone/existence guard as every other locked body
      // that refreshes the worktree — a delete cascade racing in through
      // this same per-parent lock must never have this settle's batch
      // refresh touch the worktree (`launchStep`/`launchTarget` below
      // still bail on this independently, this just skips the redundant
      // refresh call).
      const parentGone = tombstonedPipelineParents.has(parentId) || !tasks.get(parentId);
      // Minor 15: refresh the shared worktree ONCE for this whole batch (a
      // fan-out can resolve several next steps from one settle) instead of
      // once per `launchStep` call — a failed batch refresh here just
      // falls back to `launchStep`'s own per-call refresh (and its own
      // per-target error handling) for every target in the loop below.
      let batchParent = parentForLaunch;
      let worktreeReady = false;
      if (!parentArchived && !parentGone && nextStepIds.length > 0) {
        const refreshedBatch = await refreshParentWorktree(parentForLaunch, run);
        if (!("error" in refreshedBatch)) {
          batchParent = refreshedBatch.parent;
          worktreeReady = true;
        }
      }

      for (const nid of nextStepIds) {
        const targetStep = graph.steps.find((s) => s.id === nid);
        if (!targetStep) continue;
        if (targetStep.join === "all") {
          const arrivals = addJoinArrival(run.joins[nid]?.arrivals ?? [], {
            fromStepId: activeEntry.stepId,
            seq: activeEntry.seq,
            handoff: parsedHandoff,
          });
          const incoming = incomingSteps(graph, nid);
          const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
          const complete = incoming.every((i) => arrivedIds.has(i.step.id));
          if (complete) {
            delete run.joins[nid];
            const previousArr = arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
            if (parentArchived) {
              holdForArchivedParent(run, targetStep, previousArr);
            } else {
              // Minor 14: a per-target throw is caught and recorded as its
              // own retryable block instead of aborting the rest of this
              // fan-out batch.
              await launchTarget(batchParent, run, targetStep, previousArr, {
                batchSiblingStepIds: nextStepIds,
                skipWorktreeRefresh: worktreeReady,
              });
            }
          } else {
            run.joins[nid] = { arrivals };
          }
        } else {
          const previousArr = [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff: parsedHandoff }];
          if (parentArchived) {
            holdForArchivedParent(run, targetStep, previousArr);
          } else {
            await launchTarget(batchParent, run, targetStep, previousArr, {
              batchSiblingStepIds: nextStepIds,
              skipWorktreeRefresh: worktreeReady,
            });
          }
        }
      }

      checkJoinIncomplete(run);
      persist(parentId, run);
      return null;
    }

    // failed / cancelled / orphaned: an execution whose history entry
    // already carries an outcome was settled by an earlier arrival of this
    // same event (the `ready` column event and the `run-status` event for
    // one turn both land here — H1b) — nothing left to record. A retry
    // resets `outcome` to `null` through the `running` column branch before
    // the next settle, so this never masks a genuinely new outcome.
    if (historyEntry && historyEntry.outcome !== null) return null;

    if (status === "failed") {
      if (historyEntry) {
        historyEntry.responseKind = classifyStepResponse({
          runStatus: status,
          assistantText: "",
          pendingInteractions: pendingInteractionsForRun(taskId, runId),
        }).kind;
      }
      const events = mainStreamEventsForRun(runId);
      const tail = lastStatusLineFrom(events);
      const failure = classifyFailure(failureTextFrom(events));
      upsertBlocked(run, {
        taskId,
        stepId: activeEntry.stepId,
        kind: "step-failed",
        message: failure?.kind === "quota"
          ? `step "${stepName}" hit a usage limit — ${failure.detail}`
          : tail ? `step "${stepName}" failed — ${tail}` : `step "${stepName}" failed`,
      });
      if (historyEntry) {
        historyEntry.endedAt = Date.now();
        freezeStepReport(historyEntry);
        historyEntry.outcome = "failed";
      }
      const why = failure ? `failed (${failure.detail.slice(0, 80)})` : tail ? `crashed (${tail.slice(0, 80)})` : "crashed";
      // A limit that cut the turn off after it had started working (any tool
      // call) continues that session at the reset; one hit before any work
      // just relaunches, as does every other failure.
      const midWork = failure?.kind === "quota" && events.some((e) => e.stream === "tool_use");
      scheduleAutoRetry(parentId, run, activeEntry.stepId, failure, why, midWork ? { resume: "cut-off" } : undefined);
      // A turn the wait queue resumed crashed: the retry above carries it
      // (the entry keeps its attempts); once that gives up, so does the queue.
      if (run.wait?.taskId === taskId && run.autoRetry?.at == null) delete run.wait;
      persist(parentId, run);
      return null;
    }

    // cancelled / orphaned: clean up any blocked entry for this execution,
    // keep it in `active` (retry finds it there), and mark its history
    // outcome. M5: whether this also forces the WHOLE run to `cancelled`
    // (and the parent back to `ready`) depends on whether any OTHER
    // execution is still genuinely live — a Stop pressed from this one
    // step's own panel (a fan-out sibling keeps running) must not cancel
    // the run out from under the sibling; only the "nothing else is live"
    // case (including `cancelPipelineRun`'s own already-set status,
    // idempotently reaffirmed here) collapses the whole run.
    removeBlockedFor(run, taskId);
    // A Stop (or a lost session) ends the queue's hold on this execution.
    if (run.wait?.taskId === taskId) delete run.wait;
    if (historyEntry) {
      historyEntry.endedAt = Date.now();
      freezeStepReport(historyEntry);
      historyEntry.outcome = "cancelled";
      historyEntry.responseKind = classifyStepResponse({
        runStatus: status,
        assistantText: "",
        pendingInteractions: pendingInteractionsForRun(taskId, runId),
      }).kind;
    }
    const stillLiveSiblings = run.active.filter((a) => a.taskId !== taskId && isTaskRunLive(a.taskId));
    // Major 1 (round 3): a WHOLE-pipeline Stop on a fan-out must end
    // `cancelled`, not `blocked` — `cancelPipelineRun` sends the cancel
    // signal to every live sibling and forces `run.status = "cancelled"`
    // (via `finalizeCancelled`) BEFORE any of those siblings' own settle
    // events actually arrive here, so `run.status === "cancelled"` on
    // entry is the signal that THIS settle is part of a deliberate
    // whole-run stop, not an isolated one-step Stop. The same holds when
    // every other still-live sibling is itself mid-cancellation
    // (`isTaskRunCancelling`) — e.g. each active execution was cancelled
    // individually rather than through `cancelPipelineRun` — since none of
    // them is a normally-running sibling this execution would otherwise
    // need to wait on. `isDeliberateWholeRunStop` is the shared detector
    // (round 4, Major 2 also gates the succeeded branch's handoff-reminder
    // send on it; M-R2 gates its launch on it too).
    const deliberateWholeRunStop = isDeliberateWholeRunStop(run, taskId);
    if (stillLiveSiblings.length > 0 && !deliberateWholeRunStop) {
      // Major 1: this execution stopped (or orphaned) but a SIBLING is
      // still genuinely running normally — the whole run must not
      // silently read as `running` with a dead-end execution sitting in
      // `active` with no block to surface it (`deriveRunStatus` would
      // otherwise see `blocked.length === 0` and `active.length > 0` and
      // call it `running`, forever, since nothing is ever going to
      // advance this execution on its own again). Record a retryable
      // block for it now, so `deriveRunStatus` reads `blocked`
      // immediately — and still reads `blocked` once the sibling finishes
      // too, since this block is still sitting there.
      upsertBlocked(run, {
        taskId,
        stepId: activeEntry.stepId,
        kind: "step-failed",
        message: `step "${stepName}" was stopped — retry it or advance past it`,
      });
      persist(parentId, run);
    } else {
      // Either nothing else is live, or every other live sibling is also
      // being deliberately stopped as part of the same whole-run Stop —
      // either way this settle must never add a "was stopped" block of
      // its own; `finalizeCancelled` (idempotent) is the whole story.
      // Orphaned (the session was lost, e.g. across a restart) isn't a Stop
      // anyone pressed.
      if (status === "orphaned" && !deliberateWholeRunStop) {
        scheduleAutoRetry(parentId, run, activeEntry.stepId, null, "lost its session");
      }
      finalizeCancelled(parentId, run);
    }
  } catch (err) {
    persistReconcileFailure(parentId, taskId, err);
  }
  return null;
}

async function handleRunStatus(
  taskId: string,
  runId: string,
  status: "succeeded" | "failed" | "cancelled" | "orphaned",
): Promise<void> {
  const task = tasks.get(taskId);
  const parentId = task?.pipelineParentId;
  if (!task || !parentId) return;
  // L-R1: a delete cascade already owns this parent — nothing here may
  // touch its run (or its worktree) again.
  if (tombstonedPipelineParents.has(parentId)) return;

  const pending = await runExclusive(parentId, () => settleStepRun(parentId, taskId, runId, status)).catch((err) => {
    console.warn(`[agetor] pipeline runner failed handling run-status for task ${taskId}:`, err);
    return null;
  });
  // L-R7: the reminder's send happens with the lock RELEASED.
  if (pending) await deliverHandoffReminder(pending);
}

type ColumnGlobalEvent = Extract<GlobalEvent, { kind: "column" }>;

async function handleColumnChange(
  taskId: string,
  column: ColumnId,
  reason: ColumnGlobalEvent["reason"],
  /** The run the transition belongs to — for `running`, the turn that starts. */
  eventRunId: string | null = null,
): Promise<void> {
  // "pipeline"-reasoned transitions are the runner's OWN column writes
  // (`pipelineUpdateColumn`) — reprocessing them here would be at best
  // redundant, at worst a feedback loop.
  if (reason === "pipeline") return;
  const task = tasks.get(taskId);
  const parentId = task?.pipelineParentId;
  if (!task || !parentId) return;
  // L-R1: same bail as `handleRunStatus`.
  if (tombstonedPipelineParents.has(parentId)) return;

  let pending: PendingReminder | null = null;
  await runExclusive(parentId, async () => {
    try {
      // Major 2: re-read the parent fresh (same rationale as
      // `settleStepRun`) — an archive can race this event through the
      // same per-parent lock. The `blocked`/`running` branches only ever
      // record/clear a block or reset a history entry, so an archived
      // parent still gets its state recorded correctly with no extra
      // guard; the `ready`/`review` branches route into `settleStepRun`,
      // which carries its own archived/tombstoned guards.
      const parent = tasks.get(parentId);
      if (!parent || !parent.pipelineRun) return;
      const run = parent.pipelineRun;
      const activeEntry = run.active.find((a) => a.taskId === taskId);
      if (!activeEntry) return;

      if (column === "blocked") {
        const stepName = run.snapshot ? stepNameById(run.snapshot.graph, activeEntry.stepId) : activeEntry.stepId;
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-blocked",
          message: reasonMessage(reason, stepName),
        });
        persist(parentId, run);
      } else if (column === "running") {
        // m11: a step task genuinely running again (a manual resend from
        // its own panel, or a retry) clears ANY block that named it —
        // not just a column-reasoned `step-blocked` one, since a
        // handoff-missing/invalid/step-cap-adjacent block naming this task
        // is equally stale the moment it's actually running again — and
        // resets its history record's outcome/endedAt/responseKind (Low,
        // round 4: `responseKind` is stamped fresh by the next settle's own
        // `classifyStepResponse` call — a stale value from the PREVIOUS
        // attempt must not linger and read as this attempt's outcome) so it
        // reads as in-flight, not as whatever it last settled as.
        const beforeLen = run.blocked.length;
        run.blocked = run.blocked.filter((b) => b.taskId !== taskId);
        let changed = run.blocked.length !== beforeLen;
        // A real new worker supersedes this execution's earlier timer. If
        // that turn reaches an owner hold, the old timer must not answer it
        // by restarting the execution. Retain the bounded attempt count.
        if (run.autoRetry?.stepId === activeEntry.stepId && run.autoRetry.at != null) {
          run.autoRetry = { ...run.autoRetry, at: null };
          changed = true;
        }
        // A follow-up running again (resumed by a message) has taken over
        // from any earlier block, same as when it launched.
        if (isFollowUpStepId(activeEntry.stepId)) {
          const set = supersedeBlocksBefore(run, activeEntry.seq);
          if (set.length) {
            noteSuperseded(parentId, set, run.snapshot ? stepNameById(run.snapshot.graph, activeEntry.stepId) : "a follow-up");
            changed = true;
          }
        }
        const historyEntry = run.history.find((h) => h.taskId === taskId && h.seq === activeEntry.seq);
        if (historyEntry && (historyEntry.outcome !== null || historyEntry.endedAt !== null || (historyEntry.responseKind ?? null) !== null)) {
          historyEntry.outcome = null;
          historyEntry.endedAt = null;
          delete historyEntry.reportThroughEventId;
          historyEntry.responseKind = null;
          changed = true;
        }
        // A new turn of this step starts here (its launch; or it was idle
        // and something sent it back in — a usage-limit resume, the handoff
        // reminder, the wait queue, an await wake-up, a Retry, a message
        // from its panel): from now on only this turn's reply is judged
        // (`executionAssistantText`), and a "blocked" handoff an earlier
        // turn left on the record is void, as the resume notes tell the
        // agent. The same run carrying on (an answered prompt) is not a new
        // turn: its start doesn't move.
        const turnStart = (eventRunId ? runs.get(eventRunId)?.startedAt : null) ?? runs.listForTask(taskId)[0]?.startedAt ?? null;
        if (historyEntry && turnStart != null && turnStart > (historyEntry.turnStartedAt ?? 0)) {
          historyEntry.turnStartedAt = turnStart;
          historyEntry.handoff = null;
          changed = true;
        }
        if (changed) persist(parentId, run);
      } else if (column === "ready" || column === "review") {
        // H1b (`ready`) / M-R3 (`review`): belt-and-braces settle off the
        // step task's own column transition, so an execution never sits
        // `running` on a settle whose `run-status` event this listener
        // never saw (or that fired before anything was listening). `ready`
        // is where a failed/cancelled/orphaned run lands its task (the done
        // handler, `consumePendingCancel`, the bounded-spawn continuation,
        // boot reconciliation); `review` is where a succeeded run lands it
        // — including `maybeReleaseHeldTask`'s release of a step held by
        // background subagents, which is the ONLY settle a held execution
        // ever gets (its `run-status` event arrived while it was still held
        // and deliberately left it active). The latest run row is the
        // ground truth; the settle body itself is idempotent against the
        // same outcome arriving twice.
        if (isTaskRunLive(taskId)) return;
        if (remindersInFlight.has(taskId)) return;
        const historyEntry = run.history.find((h) => h.taskId === taskId && h.seq === activeEntry.seq);
        if (historyEntry && historyEntry.outcome !== null) return;
        const latest = runs.listForTask(taskId)[0];
        if (!latest || latest.status === "running") return;
        if (column === "review" ? latest.status !== "succeeded" : latest.status === "succeeded") return;
        pending = await settleStepRun(parentId, taskId, latest.id, latest.status);
      }
    } catch (err) {
      persistReconcileFailure(parentId, taskId, err);
    }
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed handling column change for task ${taskId}:`, err);
  });
  // L-R7: the reminder's send happens with the lock RELEASED.
  if (pending) await deliverHandoffReminder(pending);
}

// ---------------------------------------------------------------------------
// Boot-time (or test-time) self-heal for a missed settle (M16)
// ---------------------------------------------------------------------------

/** Record `taskId`'s active execution as failed with "step never started" —
 *  used by {@link reconcilePipelineRuns} for an active entry whose task has
 *  no run row at all (the insert landed but `startTask` itself never
 *  actually produced a run, e.g. a crash between the two). */
function markStepNeverStarted(parentId: string, taskId: string): void {
  const parent = tasks.get(parentId);
  if (!parent || !parent.pipelineRun) return;
  const run = parent.pipelineRun;
  const idx = run.active.findIndex((a) => a.taskId === taskId);
  if (idx === -1) return;
  const entry = run.active[idx]!;
  const stepName = run.snapshot ? stepNameById(run.snapshot.graph, entry.stepId) : entry.stepId;
  upsertBlocked(run, { taskId, stepId: entry.stepId, kind: "step-failed", message: `step "${stepName}" never started` });
  const h = run.history.find((x) => x.taskId === taskId && x.seq === entry.seq);
  if (h) {
    h.endedAt = Date.now();
    freezeStepReport(h);
    h.outcome = "failed";
  }
  checkJoinIncomplete(run);
  persist(parentId, run);
}

/**
 * Self-heal pass for a step settle the runner's `subscribeGlobal` listener
 * never saw — the boot-time case (`index.ts`/`headless.ts` call this right
 * after `reconcileOrphans()`, per the module doc) where `reconcileOrphans`
 * itself already re-emitted `run-status`/`column` events for anything it
 * touched (so most cases are already handled by the time this runs), plus
 * any edge case where a step's run genuinely resolved with nobody listening
 * (e.g. in tests, or a process crash between the run settling and this
 * runner's own handler completing).
 *
 * For every non-archived pipeline parent whose run is `running` (or
 * `blocked` with at least one still-`active` execution), walks every active
 * entry: skips it if `isTaskRunLive` says it's genuinely still busy;
 * otherwise reads that step task's latest run row and feeds it through the
 * exact same settle path `handleRunStatus` uses for a live event
 * (`succeeded`/`failed`/`cancelled`/`orphaned`), or — no run row at all —
 * marks it `step-failed` "never started". Each entry's own handling is
 * wrapped so a throw records a `step-failed` block (via
 * `persistReconcileFailure`) instead of silently leaving that one execution
 * stuck forever while the rest of the sweep continues. Returns how many
 * entries this pass actually reconciled.
 */
export async function reconcilePipelineRuns(): Promise<number> {
  let count = 0;
  const parents = tasks.listLive().filter((t) => {
    if (t.pipelineId == null || t.pipelineParentId != null || t.archivedAt != null || !t.pipelineRun) return false;
    const status = t.pipelineRun.status;
    return status === "running" || status === "blocked";
  });

  for (const parent of parents) {
    const activeSnapshot = parent.pipelineRun!.active.slice();
    for (const a of activeSnapshot) {
      if (isTaskRunLive(a.taskId)) continue;
      try {
        const stepRuns = runs.listForTask(a.taskId);
        const latest = stepRuns[0] ?? null;
        if (!latest) {
          await runExclusive(parent.id, async () => markStepNeverStarted(parent.id, a.taskId));
          count++;
        } else if (latest.status !== "running") {
          await handleRunStatus(a.taskId, latest.id, latest.status);
          count++;
        }
      } catch (err) {
        await runExclusive(parent.id, async () => persistReconcileFailure(parent.id, a.taskId, err)).catch(() => {});
      }
    }
    // A run left "blocked" on an earlier step after a follow-up took over —
    // live now, or already finished (state from before follow-ups superseded
    // blocks).
    await runExclusive(parent.id, async () => {
      const run = tasks.get(parent.id)?.pipelineRun;
      if (!run || run.blocked.length === 0) return;
      const live = run.active.filter((a) => isFollowUpStepId(a.stepId) && isTaskRunLive(a.taskId)).map((a) => ({ stepId: a.stepId, seq: a.seq }));
      const finished = run.history.filter((h) => isFollowUpStepId(h.stepId) && h.outcome === "succeeded").map((h) => ({ stepId: h.stepId, seq: h.seq }));
      const latest = [...live, ...finished].sort((x, y) => y.seq - x.seq)[0];
      if (!latest) return;
      const set = supersedeBlocksBefore(run, latest.seq);
      if (set.length === 0) return;
      noteSuperseded(parent.id, set, run.snapshot ? stepNameById(run.snapshot.graph, latest.stepId) : "a follow-up");
      persist(parent.id, run);
      count++;
    }).catch(() => {});
  }
  return count;
}

let runnerInitialized = false;

/** Test-only kill switch for the subscribed listener below — lets a test
 *  simulate a step settle the runner's listener never saw at all (M16: "a
 *  process crash between the run settling and this runner's own handler
 *  completing", or simply this process never having been subscribed for
 *  that event), so `reconcilePipelineRuns` has something real to catch.
 *  Defaults to enabled; production code never touches this. */
let listenerEnabled = true;

/**
 * Subscribe the runner to the orchestrator's global lifecycle stream.
 * Idempotent — safe to call more than once (a second call is a no-op).
 * `index.ts`/`headless.ts` call this once, at boot, immediately BEFORE
 * `reconcileOrphans()` — so a step task's own boot-time orphan→ready
 * transition (fired by `reconcileOrphans` as an ordinary `run-status`
 * "orphaned" event) reaches this listener and flips its pipeline parent
 * back to `ready`/`cancelled`-with-retry, the same as a live cancellation.
 */
export function initPipelineRunner(): void {
  if (runnerInitialized) return;
  runnerInitialized = true;
  subscribeGlobal((e: GlobalEvent) => {
    if (!listenerEnabled) return;
    if (e.kind === "run-status") {
      void handleRunStatus(e.taskId, e.runId, e.status);
    } else if (e.kind === "column") {
      void handleColumnChange(e.taskId, e.column, e.reason, e.runId);
    }
  });
}

/** Test-only seam (`pipeline-runner.test.ts`) — see `listenerEnabled`'s doc
 *  above and `handleRunStatus`'s own doc for why a test needs to call it
 *  directly to simulate a missed settle. Never imported outside this
 *  module's own test file. */
export const __forTest = {
  setListenerEnabled(enabled: boolean): void {
    listenerEnabled = enabled;
  },
  handleRunStatus,
  handleColumnChange,
};
