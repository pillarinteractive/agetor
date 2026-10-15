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
import { createHash, randomUUID } from "node:crypto";
import { recordActivity } from "./activity.ts";
import { syncBaseNote } from "./sync-base.ts";
import { logBlockResolution, logBlocks, newBlocks } from "./block-log.ts";
import { isMergeQueued } from "./merge-intent.ts";
import { currentSlots, slotDecision, slotUse } from "./step-slots.ts";
import { reserveRunner, releaseUnspawnedRunner } from './dispatch-claims.ts';
import { reconcileCardInputs } from './queue-validation.ts';
import { isPriority, priorityFirst } from "./priority.ts";
import { awaitsFor, listAwaits, resourceBlockedAwaits } from "./awaits.ts";
import {HEAVY_INSTRUCTIONS,managedPillarRoot} from './heavy-jobs.ts';
import { classifyFailure, formatRetryTime, harnessQuotaNotice, isQuotaPaused, nextRetryAt, TRANSIENT_RETRY_MAX, type FailureClass } from "./usage-limit.ts";
import { fallbackAfterLimit, fallbackForStep, familyOf, noteQuotaLimit, type QuotaFallback } from "./quota-fallback.ts";
import { getDiscoveredEfforts } from "./agent-discovery.ts";
import { listLeases } from "./lease-watch.ts";
import { invalidatePrStatus, issueNumberForTask, ownFailures, prBase, prStatusForTask } from "./pr-watch.ts";
import { baseBranchFor } from "./base-branch.ts";
import { run as runCommand } from "./github.ts";
import { waitingOnQuota } from "../shared/autopilot.ts";
import {
  followUpIssue, followUpKey, NO_COUNTERS, OWNER_HOLDS_PREF, parseOwnerHoldsMode, RESOLUTION, RESOLVING_PREFIX, resolveOwnerHold, SELF_CLEARING, stepRole,
  unresolvedItems, type OwnerHoldAction, type OwnerHoldKind,
} from "../shared/owner-holds.ts";
import { decisionPolicyForProject, PIPELINE_DECISIONS_PREF, plannerDecisionInstructions } from "../shared/pipeline-decisions.ts";
import { buildSettled, noChangeReviewNote, reviewSettled, type HeadAt } from "../shared/no-change-loop.ts";
import { buildFindingsNote, closeOutReviewNote, dueForCloseOut, markClosed, missingClassSearch, openFindings, recordReview, repeatedOpen, reviewFindingsNote } from "../shared/finding-ledger.ts";
import {
  PIPELINE_GATES_PREF, gateUnmatchedLine, initialPublishState, parsePipelineGate, publishBlockMessage, publishGateOn, publishStepOf, publishVisitOver,
  unmatchedGateRefs, type GateUnmatched, type PipelineGateName,
} from "../shared/publish.ts";
import { composedHandoff, exhaustedHandoff, gateFailureLine, gateVerdict, type CheckResult } from "../shared/checks.ts";
import { recordWaivedChecks, runStepChecks } from "./check-runner.ts";
import { stepPreload } from "./preload.ts";
import { appendFeedback, readFeedback, readPosition, voidStepEvidence } from "./position.ts";
import {
  applicableFeedback, forwardPath, positionLine, renderOwnerFeedback, stepsFrom, validateFeedbackNote,
  type PipelinePositionView, type PipelineReopenResult, type PipelineResume, type PipelineSteerResult, type Position,
} from "../shared/position.ts";
import {
  BLOCK_WAIT_PREF,
  classifyBlock,
  escalationLine,
  fmtSpan,
  issueRef,
  NO_DEADLINE,
  parseBlockWaitConfig,
  planWait,
  triedLine,
  waitHasTrigger,
  waitsOnIssue,
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
  composeCheckFeedback,
  composeHandoffReminder,
  composeLimitResumeNote,
  composeOwnerHoldAnswer,
  composeStepPrompt,
  parseStepPromptOrder,
  STEP_PROMPT_ORDER_PREF,
  type StepPromptExtras,
  deriveRunStatus,
  effectiveStepCap,
  exhaustedEdge,
  FOLLOW_UP_STEP_PREFIX,
  incomingSteps,
  isFollowUpStepId,
  normalizeHandoff,
  reviewedPipelineShape,
  reviewApprovalMatches,
  reviewRequiresRepair,
  outgoingSteps,
  capWrapUpStep,
  capWrapUpSection,
  renderHandoffFile,
  renderReportFile,
  resolveNextSteps,
  resolveStartStep,
  stepGate,
  stepNameById,
  stepReportFromMessages,
  validatePipelineGraph,
  updatedPipelineGates,
  updatedPipelineInstructions,
  type StepGate,
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
  PipelinePublishState,
  PipelineBlockWait,
  PipelineGraph,
  PipelineJoinArrival,
  PipelineRunSnapshot,
  PipelineRunState,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepRecord,
  PipelineStepReport,
  StepCheck,
  Task,
  TaskPrStatus,
  TaskReference,
} from "../shared/types.ts";
import { defaultModeFor, supportedEfforts } from "../shared/types.ts";

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
// that send/relaunch finishes so a second recovery cannot slip into the gap.
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
/** Step-cap extensions an unattended run grants itself before it waits for a
 *  person: a 14-step run goes to 28, then stops. Of 285 runs to date, 18
 *  reached 14 steps and 2 went past 28; every extended run that ended, ended
 *  done. One extension covers the long review cycles without funding a loop. */
export const AUTO_CAP_EXTENSIONS = 1;
const autoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const launchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const launchRecoveriesInFlight = new Set<string>();

function armLaunchRetryTimer(parentId: string, taskId: string, at: number, fireAt = at): void {
  const key = `${parentId}:${taskId}`;
  const existing = launchRetryTimers.get(key);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    if (launchRetryTimers.get(key) !== handle) return;
    launchRetryTimers.delete(key);
    void fireLaunchRetry(parentId, taskId, at);
  }, Math.max(0, fireAt - Date.now()));
  handle.unref?.();
  launchRetryTimers.set(key, handle);
}

function scheduleLaunchRetry(parentId: string, run: PipelineRunState, taskId: string, stepId: string, reason: string): void {
  const previous = run.launchRetries?.[taskId];
  if (previous?.at != null) return;
  const attempt = (previous?.attempt ?? 0) + 1;
  const at = nextRetryAt('transient', attempt, null, Date.now());
  (run.launchRetries ??= {})[taskId] = { stepId, kind: 'transient', attempt, at, reason: reason.slice(0, 300) };
  const name = run.snapshot ? stepNameById(run.snapshot.graph, stepId) : stepId;
  recordActivity(parentId, { kind: 'step', tone: at == null ? 'danger' : 'warning', text: at == null
    ? `${name} could not launch again — left for you after ${TRANSIENT_RETRY_MAX} automatic retries`
    : `${name} ${reason} — retrying its existing child automatically at ${formatRetryTime(at)} (${attempt} of ${TRANSIENT_RETRY_MAX})` });
  if (at != null) armLaunchRetryTimer(parentId, taskId, at);
}

/** A launch retry belongs to one child, not to the most recently failed
 * step name on its parent. The ordinary start path retains exact run and
 * owner guards, and every sibling keeps its own schedule or hold. */
export async function fireLaunchRetry(parentId: string, taskId: string, at: number): Promise<boolean> {
  const key = `${parentId}:${taskId}`;
  const go = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId), run = parent?.pipelineRun, retry = run?.launchRetries?.[taskId];
    if (!parent || !run || !retry || retry.at !== at || launchRecoveriesInFlight.has(key)) return false;
    run.launchRetries![taskId] = { ...retry, at: null };
    persist(parentId, run, { preserveStatus: true });
    const child = tasks.get(taskId), block = run.blocked.find(b => b.taskId === taskId);
    if (parent.archivedAt != null || run.status !== 'blocked' || !child || child.archivedAt != null
      || isTaskRunLive(taskId) || listPendingForTask(taskId).length > 0
      || !run.active.some(a => a.taskId === taskId && a.stepId === retry.stepId)
      || block?.kind !== 'step-failed' || !isDatabaseBusy(block.message) && !/ never started$/.test(block.message)) return false;
    launchRecoveriesInFlight.add(key);
    return true;
  }).catch(() => false);
  if (!go) return false;
  try {
    const result = await retryPipelineStep(parentId, { taskId }).catch((error: unknown) => ({ error: String(error) }));
    return !('error' in result);
  } finally { launchRecoveriesInFlight.delete(key); }
}

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

/** Pause before a step restarts on its backup harness after a usage limit. */
const QUOTA_FALLBACK_DELAY_MS = 3_000;

/** A step's launch settings on its quota backup. A backup of the same kind
 *  changes only the harness. One of another kind (Codex steps on DeepSeek
 *  through Claude Code) runs the rule's model, keeps the step's effort where
 *  that kind accepts it, and runs in that kind's default mode: mode ids do
 *  not mean the same across kinds (Codex "ask" is read-only, Claude Code
 *  "ask" prompts for every change and would stall an unattended step). */
export function launchOnFallback(
  fallback: QuotaFallback,
  step: { model: string | null; effort: string | null; mode: string | null },
): { agent: string; model: string | null; effort: string | null; mode: string | null } {
  if (!fallback.model) return { agent: fallback.harness, ...step };
  const kind = harnesses.get(fallback.harness)!.kind;
  const model = fallback.model;
  const efforts = supportedEfforts(kind, model, getDiscoveredEfforts(kind, model, fallback.harness));
  const accepted = (e: string | null | undefined): e is string => !!e && efforts.some((o) => o.id === e);
  // A hop of a profile's chain runs with that profile's own effort and mode
  // where the step's do not apply.
  const effort = accepted(step.effort) ? step.effort : accepted(fallback.profile?.effort) ? fallback.profile!.effort! : defaultEffortFor(kind, model, fallback.harness);
  return { agent: fallback.harness, model, effort, mode: fallback.profile?.mode ?? defaultModeFor(kind) };
}

/** For a Review step, the model family that built the head it reviews (the
 *  last Build execution as it actually ran, on a backup included): a Review
 *  never falls back onto that family. Null for any other step. */
export function familyToExclude(run: PipelineRunState, stepId: string): string | null {
  if (!run.snapshot) return null;
  const graph = run.snapshot.graph;
  if (stepRole(stepNameById(graph, stepId), stepId) !== "review") return null;
  const build = run.history.findLast((h) => stepRole(stepNameById(graph, h.stepId), h.stepId) === "build");
  const task = build ? tasks.get(build.taskId) : null;
  return task ? familyOf(task.agent, task.model) : null;
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
  if (kind === "quota") {
    // Quota fallback (quota-fallback.ts): remember the limit, and when a
    // backup harness is configured start the step again on it now instead of
    // waiting for the reset. A fresh launch, not a resume: the cut-off
    // session belongs to the limited provider.
    const limited = tasks.get(run.active.find((a) => a.stepId === stepId)?.taskId ?? "");
    if (limited) {
      noteQuotaLimit(limited.agent, failure?.resetAt ?? null, now);
      const fallback = fallbackAfterLimit(limited.agent, limited.agentProfile ?? null, { excludeFamily: familyToExclude(run, stepId), now });
      if (fallback) {
        const backup = fallback.harness;
        tasks.update(limited.id, launchOnFallback(fallback, limited));
        const at = now + QUOTA_FALLBACK_DELAY_MS;
        run.autoRetry = { stepId, kind, attempt: 1, at, reason };
        recordActivity(parentId, {
          kind: "step",
          text: `${stepName} hit a usage limit (${reason}) — starting it again on ${harnesses.get(backup)?.label ?? backup}`,
          tone: "info",
        });
        armAutoRetryTimer(parentId, at);
        return;
      }
    }
  }
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
    if (t.archivedAt != null || t.pipelineParentId) continue;
    if (r?.at != null) {
      armAutoRetryTimer(t.id, r.at, Math.max(r.at, now + 30_000));
      n++;
    }
    if (t.pipelineRun?.status === 'cancelled') continue;
    for (const [taskId, retry] of Object.entries(t.pipelineRun?.launchRetries ?? {})) {
      if (retry.at == null) continue;
      armLaunchRetryTimer(t.id, taskId, retry.at, Math.max(retry.at, now + 30_000));
      n++;
    }
  }
  return n;
}

/** Stop every in-memory retry timer (core shutdown); the schedule stays
 *  persisted for the next boot. */
export function stopPipelineAutoRetryTimers(): void {
  for (const h of autoRetryTimers.values()) clearTimeout(h);
  autoRetryTimers.clear();
  for (const h of launchRetryTimers.values()) clearTimeout(h);
  launchRetryTimers.clear();
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
        text: ladderApplies(run)
          ? `${RESOLVING_PREFIX}: ${stepName} stopped on something it says only you could settle (${verdict.why}) — Agetor answers it instead`
          : verdict.category === "owner"
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
    // No owner holds: what clears by itself is never given up.
    endless: ladderApplies(run),
  });
  run.wait = wait;
  if (wait.state === "escalated") {
    recordActivity(parentId, {
      kind: "step",
      text: ladderApplies(run)
        ? `${RESOLVING_PREFIX}: ${stepName} ${wait.escalation} (${triedLine(wait, now)}) — Agetor takes it from here. It says: ${wait.reason}`
        : `${stepName} ${wait.escalation} — left for you (${triedLine(wait, now)}). It says: ${wait.reason}`,
      tone: "danger",
    });
    return "escalated";
  }
  const line = waitLine(stepName, wait, now, waitTrigger(parent, wait));
  recordActivity(parentId, {
    kind: "step",
    // "retrying automatically": what the velocity ledger reads as a wait
    // that isn't the owner's (src/shared/velocity.ts).
    text: `${line.replace(" — retrying ", " — retrying automatically ").replace(" — resumes when ", " — resumes automatically when ")} (${verdict.why})`,
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
  if(w.category==='resource') {
    const commands=resourceBlockedAwaits(parent,w.taskId,listAwaits());
    if(commands.length) {
      // Await notifications own this transition. A timed retry would spend an
      // attempt while the same command waits, or race its completion message.
      return {state:'holding',text:commands.some(a=>!a.finished)?'the registered background commands have not finished':'the registered background results await their completion notification'};
    }
  }
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
/** When each closed-out card last looked at its follow-up issue. */
const lastCloseoutCheck = new Map<string, number>();

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
        endless: w.endless === true,
      }),
      endless: w.endless === true && w.attempt + 1 > w.max,
    };
  }).catch(() => null);
  if (!go) return false;

  let sent: Awaited<ReturnType<typeof sendInput>>;
  try {
    sent = await sendInput(go.runId, go.note);
  } catch (err) {
    sent = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const count = go.endless ? `automatic re-check ${go.attempt}` : `automatic retry ${go.attempt} of ${go.max}`;
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
    if (w.closeout) {
      // Closed out on a follow-up issue: resumed only when it is closed,
      // never on the timer (which only re-checks).
      const due = w.at != null && now >= w.at;
      if (!w.ref) {
        // Its issue could not be filed: the ladder files it again.
        if (due) {
          await runExclusive(t.id, async () => {
            const run = tasks.get(t.id)?.pipelineRun;
            if (run?.wait?.closeout && !run.wait.ref) {
              delete run.wait;
              persist(t.id, run);
            }
          }).catch(() => undefined);
        }
        continue;
      }
      const trigger = due || (now - (lastCloseoutCheck.get(t.id) ?? 0) >= TRIGGER_MIN_GAP_MS) ? await waitTriggerState(t, w, now) : null;
      if (trigger) lastCloseoutCheck.set(t.id, now);
      if (trigger?.state === "cleared" && !quotaHold) {
        if (await resumeClosedOut(t.id, trigger.text, now)) resumed++;
      } else if (due) {
        await runExclusive(t.id, async () => {
          const run = tasks.get(t.id)?.pipelineRun;
          if (run?.wait?.closeout && run.wait.state === "waiting") {
            run.wait = { ...run.wait, at: now + config.longBackoffMin * 60_000 };
            persist(t.id, run);
          }
        }).catch(() => undefined);
      }
      continue;
    }
    if (now >= w.deadline) {
      await escalateWait(t.id, `still waiting on ${w.what} after ${fmtSpan(now - w.since)}`, now);
      continue;
    }
    const trigger = await waitTriggerState(t, w, now);
    // A wait on a numbered issue or PR has no timer (`planWait`); an entry
    // parked by an older build may still carry one, which is ignored.
    const due = w.at != null && now >= w.at && !waitsOnIssue(w);
    const lastTried = w.tried[w.tried.length - 1]?.at ?? 0;
    const triggered = trigger.state === "cleared" && now - lastTried >= TRIGGER_MIN_GAP_MS;
    if (!due && !triggered) continue;
    if (trigger.state === "holding") {
      // The timer came due, but what it waits on is known not to have
      // changed: look again later, without spending a resume.
      const backoff = config.backoffMin[w.category];
      const again = now + (w.endless && w.attempt >= w.max ? config.longBackoffMin : (backoff[Math.min(w.attempt, backoff.length - 1)] ?? 15)) * 60_000;
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
  lastCloseoutCheck.clear();
  blockWaitDeps.leases = () => listLeases();
  blockWaitDeps.pr = (taskId) => prStatusForTask(taskId);
  blockWaitDeps.refState = githubRefState;
  blockWaitDeps.rng = Math.random;
}

// ---------------------------------------------------------------------------
// No owner holds (src/shared/owner-holds.ts, docs/plans/no-owner-holds.md)
// ---------------------------------------------------------------------------

/**
 * Every stop of an unattended run that used to wait for the owner — a
 * blocked handoff the owner had to answer, a queue wait that escalated, a
 * step with no handoff after its reminder and retries, a failure whose
 * retries are spent, a failed check gate after its fresh session, the step
 * cap after its wrap-up, a used-up corrective route, a profile or join that
 * cannot launch, an Agetor-run Finish that stopped, a question a step asked —
 * is found by one pass (`resolveOwnerHolds`), decided by the pure ladder
 * (`resolveOwnerHold`) and carried out here. The sites that record those
 * stops are unchanged: they still record the block (and the block log still
 * logs it); the ladder then resolves it, and says which rung did in the log.
 *
 * Only for unattended runs (`snapshot.decisionPolicy`), only while
 * `owner_holds` is "resolve" (read at every decision), and never for a run
 * the user stopped (`ladder.userStop`, set by Stop, cleared when a person
 * starts a step again). Persisted on the run (`run.ladder`): the counters
 * are written before each action, so a restart resumes at the same rung and
 * no rung repeats for the same step execution.
 */
const ownerHoldsMode = () => parseOwnerHoldsMode(preferences.get(OWNER_HOLDS_PREF));

/** The ladder applies to this run now. */
function ladderApplies(run: PipelineRunState): boolean {
  return !!run.snapshot?.decisionPolicy && run.ladder?.userStop == null && ownerHoldsMode() === "resolve";
}

// ── The no-change Build ↔ Review loop guard ──────────────────────────────

/** The head a step left behind — replaceable in tests (no git). */
export const loopGuardDeps = {
  readHead: async (checkout: string): Promise<HeadAt> => {
    const rev = async (what: string) => {
      const r = await runCommand(["git", "rev-parse", "--verify", "--quiet", what], checkout, 30_000, process.env).catch(() => null);
      return r && r.ok && r.stdout.trim() ? r.stdout.trim() : null;
    };
    const head = await rev("HEAD");
    return { head, tree: head ? await rev("HEAD^{tree}") : null };
  },
};

const parentForGuard = (parentId: string, parent: Task): Task => tasks.get(parentId) ?? parent;

/**
 * Called as a Build or Review execution settles with its route decided, in
 * an unattended run whose owner holds are resolved. Keeps `run.noChangeLoop`
 * (persisted with the run by the caller) and acts on it: on the second
 * round in a row in which Build left the head Review sent back unchanged,
 * the next Review carries a runner-written section (`noChangeReviewNote`,
 * read by `launchStep`); a Review that then sends that same head back to
 * Build has its Build launch turned into the step-cap wrap-up through the
 * terminal step (`run.capWrapUp.closeout`): published unapproved, issues
 * filed for what is open, nothing merged or approved.
 */
async function guardNoChangeLoop(
  parent: Task,
  run: PipelineRunState,
  stepName: string,
  stepId: string,
  resolved: ReturnType<typeof resolveNextSteps>,
): Promise<void> {
  const role = stepRole(stepName, stepId);
  if (role !== "build" && role !== "review") return;
  if (!ladderApplies(run) || !run.snapshot) {
    delete run.noChangeLoop;
    return;
  }
  const graph = run.snapshot.graph;
  const checkout = parent.worktreePath ?? parent.workdir;
  const at = checkout ? await loopGuardDeps.readHead(checkout).catch(() => ({ head: null, tree: null })) : { head: null, tree: null };
  const now = Date.now();
  const short = (at.head ?? at.tree ?? "").slice(0, 8);
  if (role === "build") {
    const r = buildSettled(run.noChangeLoop, at, now);
    if (r.state) run.noChangeLoop = r.state;
    else delete run.noChangeLoop;
    if (r.action === "instruct") {
      recordActivity(parent.id, {
        kind: "step", tone: "warning",
        text: `${RESOLVING_PREFIX}Build made no change ${r.state!.rounds} times in a row on ${short} — telling Review to stop returning findings Build cannot fix`,
      });
    }
    return;
  }
  const buildIds = resolved.kind === "steps"
    ? resolved.stepIds.filter((id) => stepRole(stepNameById(graph, id), id) === "build")
    : [];
  const r = reviewSettled(run.noChangeLoop, at, buildIds.length > 0, now);
  if (r.state) run.noChangeLoop = r.state;
  else delete run.noChangeLoop;
  if (r.action !== "wrap-up") return;
  if (run.capWrapUp || !capWrapUpStep(graph)) {
    recordActivity(parent.id, {
      kind: "step", tone: "warning",
      text: `${RESOLVING_PREFIX}Review sent unchanged ${short} back to Build again after being told; the run's wrap-up is already used — the step cap ends it`,
    });
    return;
  }
  const why = `Build made no change ${r.state!.rounds} times for the same findings on ${short}, and Review sent it back again after being told what Build cannot fix`;
  run.capWrapUp = { at: now, fromStepId: buildIds[0]!, closeout: { issues: [], why } };
  recordActivity(parent.id, {
    kind: "step", tone: "warning",
    text: `${RESOLVING_PREFIX}Review sent unchanged ${short} back to Build a third time — finishing through ${capWrapUpStep(graph)!.name}: published as not approved, one issue per unresolved finding, nothing merged`,
  });
}

export const ROUNDS_PREF = "pipeline_rounds";

/** `pipeline_rounds`: the profile (name or id) a Build escalates to when a
 *  finding comes back, and the effort of a re-review. Defaults: "Builder",
 *  "medium"; {"enabled": false} turns both off (the ledger, the Class
 *  search gate and the close-out stay). */
export function parseRoundsPolicy(raw: string | null | undefined): { escalateProfile: string | null; reviewEffort: string | null } {
  const fallback = { escalateProfile: "Builder", reviewEffort: "medium" };
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
    if (v.enabled === false) return { escalateProfile: null, reviewEffort: null };
    return {
      escalateProfile: typeof v.escalateProfile === "string" ? v.escalateProfile.trim() || null : fallback.escalateProfile,
      reviewEffort: typeof v.reviewEffort === "string" ? v.reviewEffort.trim() || null : fallback.reviewEffort,
    };
  } catch {
    return fallback;
  }
}

/** The escalation profile as a snapshot, kept on the run once taken so every
 *  later escalated Build of the run uses the same one. */
function escalationProfile(run: PipelineRunState, nameOrId: string | null): AgentProfileSnapshot | null {
  if (!nameOrId || !run.snapshot) return null;
  const kept = Object.values(run.snapshot.profiles).find((p) => p.id === nameOrId || p.name === nameOrId);
  if (kept) return kept;
  const live = agentProfiles.get(nameOrId) ?? agentProfiles.list().find((p) => p.name === nameOrId) ?? null;
  const harness = live ? harnesses.getByIdOrKind(live.harness) : null;
  if (!live || !harness || !harness.enabled) return null;
  const snap = snapshotFromProfile(live, { kind: harness.kind, label: harness.label }, Date.now());
  run.snapshot.profiles[snap.id] = snap;
  return snap;
}

/** Git reads for the re-review packet — replaceable in tests. */
export const packetDeps = {
  git: async (args: string[], cwd: string): Promise<string | null> => {
    const r = await runCommand(["git", ...args], cwd, 60_000, process.env).catch(() => null);
    return r && r.ok ? r.stdout : null;
  },
};

const PACKET_INLINE = 30_000;

/** The change since `lastSha` without what a merge of the base brought in:
 *  the reviewed head is merged (in a scratch tree, nothing written to the
 *  branch) with the base commit HEAD now contains, and HEAD is diffed against
 *  that, so develop's own hunks cancel out. */
export async function cleanDelta(checkout: string, lastSha: string, base: string): Promise<{ diff: string; stat: string; note: string } | null> {
  const git = packetDeps.git;
  const head = (await git(["rev-parse", "HEAD"], checkout))?.trim();
  if (!head) return null;
  if (head === lastSha) return { diff: "", stat: "", note: "HEAD is the head last reviewed: no change since." };
  const newBase = (await git(["merge-base", "HEAD", base], checkout))?.trim();
  const oldBase = (await git(["merge-base", lastSha, base], checkout))?.trim();
  let from = lastSha;
  let note = `Changes from the last reviewed head ${lastSha.slice(0, 8)} to ${head.slice(0, 8)}.`;
  if (newBase && oldBase && newBase !== oldBase) {
    const tree = (await git(["merge-tree", "--write-tree", lastSha, newBase], checkout))?.split("\n")[0]?.trim();
    if (tree && /^[0-9a-f]{40,64}$/.test(tree)) {
      from = tree;
      note += ` ${base} was merged in since; its own changes are left out (the reviewed head merged with ${newBase.slice(0, 8)} is the starting point), so what remains is Build's work and its conflict resolutions.`;
    } else {
      note += ` ${base} was merged in since (${oldBase.slice(0, 8)} → ${newBase.slice(0, 8)}) and that merge conflicted, so some lines below came from ${base}: check \`git log --merges ${lastSha.slice(0, 8)}..HEAD\`.`;
    }
  }
  const stat = (await git(["diff", "--stat", from, "HEAD"], checkout)) ?? "";
  let diff = (await git(["diff", "--function-context", from, "HEAD"], checkout)) ?? "";
  if (diff.length > PACKET_INLINE) diff = (await git(["diff", "-U5", from, "HEAD"], checkout)) ?? diff;
  return { diff, stat, note };
}

/** The runner's rounds section for a Build or Review launch. */
async function roundsSection(
  parent: Task,
  run: PipelineRunState,
  role: string,
  escalated: boolean,
  lastReview: PipelineStepRecord | null,
  runDir: string,
  seq: number,
): Promise<string | null> {
  const parts: string[] = [];
  const checkout = parent.worktreePath ?? parent.workdir;
  const base = `origin/${baseBranchFor(parent.id) ?? "develop"}`;
  if (role === "build") {
    const note = buildFindingsNote(run.findings, escalated);
    if (note) parts.push(note);
    const lastBuild = run.history.findLast((h) => stepRole(stepNameById(run.snapshot!.graph, h.stepId), h.stepId) === "build" && h.handoff);
    if (run.classSearchReturned != null && lastBuild?.seq === run.classSearchReturned) {
      parts.push("Agetor returned your previous handoff because its `Class search:` section was missing or incomplete for the open findings above. Add it, with a command and a hit count per ID.");
    }
    if (escalated && lastBuild?.handoff) {
      parts.push(`## What the last Build did (execution ${lastBuild.seq})\n${lastBuild.handoff.summary}`);
      const reviewed = run.history.findLast((h) => h.handoff?.reviewApproval?.headSha && h.seq < lastBuild.seq)?.handoff?.reviewApproval?.headSha;
      if (reviewed && checkout) {
        const d = await cleanDelta(checkout, reviewed, base);
        if (d?.diff) parts.push(packetDiff("Its change", d, runDir, seq));
      }
    }
  } else if (role === "review") {
    const closing = run.findingCloseOut && !run.findingCloseOut.wrapped
      ? Object.entries(run.findings ?? {}).filter(([, f]) => f.state === "closed").map(([id, f]) => ({ id, text: f.text, issue: f.issue ?? null }))
      : [];
    if (closing.length > 0 && openFindings(run.findings).length === 0) parts.push(closeOutReviewNote(closing));
    const note = reviewFindingsNote(run.findings);
    if (note) parts.push(note);
    const lastSha = lastReview?.handoff?.reviewApproval?.headSha;
    if (lastSha && checkout) {
      const d = await cleanDelta(checkout, lastSha, base);
      if (d) parts.push(packetDiff("## Re-review packet: the delta since your last review", d, runDir, seq,
        "Review this delta, the open findings and Build's Class search lines. New findings on code you already reviewed are follow-ups unless the delta, a conflict resolution or a merged upstream change introduced them (cite which), or they are an unmet mandatory requirement or a security, privacy or data-loss defect."));
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

function packetDiff(title: string, d: { diff: string; stat: string; note: string }, runDir: string, seq: number, lead = ""): string {
  const head = [title, lead, d.note, d.stat ? "```\n" + d.stat.trim() + "\n```" : ""].filter(Boolean).join("\n\n");
  if (!d.diff) return head;
  if (d.diff.length <= PACKET_INLINE) return `${head}\n\n\`\`\`diff\n${d.diff.trim()}\n\`\`\``;
  const file = join(runDir, `delta-${(Date.now()).toString(36)}-${seq}.diff`);
  try {
    writeFileSync(file, d.diff);
    return `${head}\n\nThe diff is ${Math.round(d.diff.length / 1000)} KB: read it from \`${file}\`.`;
  } catch {
    return `${head}\n\n\`\`\`diff\n${d.diff.slice(0, PACKET_INLINE)}\n\`\`\`\n(cut at ${PACKET_INLINE} characters)`;
  }
}

/** What the run does with Review's findings as it settles (an unattended
 *  run only; src/shared/finding-ledger.ts): record them, close out the ones
 *  that came back twice, and decide where the work goes. Returns the route,
 *  changed or not. */
export async function settleReviewFindings(
  parent: Task,
  run: PipelineRunState,
  stepName: string,
  entry: { stepId: string; seq: number },
  handoff: Handoff,
  resolved: { kind: "steps"; stepIds: string[] } | { kind: "terminal" },
): Promise<{ kind: "steps"; stepIds: string[] } | { kind: "terminal" }> {
  if (!run.snapshot || stepRole(stepName, entry.stepId) !== "review" || !ladderApplies(run)) return resolved;
  const graph = run.snapshot.graph;
  const approval = handoff.reviewApproval;
  const findings = approval?.verdict === "approved" ? [] : approval?.findings ?? [];
  if (!approval) return resolved;
  run.findings = recordReview(run.findings, entry.seq, findings);
  const due = dueForCloseOut(run.findings);
  for (const [id, f] of due) {
    const filed = await findingDeps.fileFollowup(parent, id, f).catch(() => null);
    run.findings = markClosed(run.findings, id, filed);
    recordActivity(parent.id, { kind: "step", tone: "warning",
      text: `${RESOLVING_PREFIX}Finding ${id} came back after ${f.repeat} fixes — closed out of this card${filed ? ` as #${filed.number}` : ""} instead of another Build` });
  }
  if (resolved.kind !== "steps") return resolved;
  const toBuild = resolved.stepIds.some((id) => stepRole(stepNameById(graph, id), id) === "build");
  if (!toBuild || openFindings(run.findings).length > 0) return resolved;
  // Only closed findings stand between this work and approval.
  const closed = Object.values(run.findings ?? {}).some((f) => f.state === "closed");
  if (!closed) return resolved;
  if (!run.findingCloseOut) {
    run.findingCloseOut = { at: Date.now(), wrapped: false };
    recordActivity(parent.id, { kind: "step", tone: "info",
      text: `${RESOLVING_PREFIX}Only closed-out findings remain — Review decides the verdict once more instead of another Build` });
    return { kind: "steps", stepIds: [entry.stepId] };
  }
  if (run.findingCloseOut.wrapped || run.capWrapUp || !capWrapUpStep(graph)) return resolved;
  run.findingCloseOut = { ...run.findingCloseOut, wrapped: true };
  const why = "Review returned work whose only open findings were closed out after two fixes each";
  run.capWrapUp = { at: Date.now(), fromStepId: resolved.stepIds[0]!, closeout: { issues: [], why } };
  recordActivity(parent.id, { kind: "step", tone: "warning",
    text: `${RESOLVING_PREFIX}Review kept closed-out findings as blockers — finishing through ${capWrapUpStep(graph)!.name}: published as not approved, nothing merged` });
  return resolved;
}

/** A Build that addresses findings must list a Class search line for each
 *  open one. One miss is sent back to the same Build; a second goes on to
 *  Review, which checks it. */
export async function classSearchReturn(
  run: PipelineRunState,
  stepName: string,
  entry: { stepId: string; seq: number; taskId: string; startedAt: number; turnStartedAt?: number | null; endedAt?: number | null },
  handoff: Handoff,
): Promise<string[] | null> {
  if (stepRole(stepName, entry.stepId) !== "build" || !ladderApplies(run)) return null;
  const required = openFindings(run.findings).map(([id]) => id);
  if (required.length === 0 || run.classSearchReturned === entry.seq) return null;
  const report = findingDeps.report(entry);
  const missing = missingClassSearch([handoff.summary, handoff.reason, report].join("\n"), required);
  return missing.length > 0 ? missing : null;
}

/** GitHub and transcript reads for the findings rules — replaceable in tests. */
export const findingDeps: {
  fileFollowup: (parent: Task, id: string, f: import("../shared/finding-ledger.ts").LedgerFinding) => Promise<{ number: number; url: string } | null>;
  report: (entry: { taskId: string; startedAt: number; turnStartedAt?: number | null; endedAt?: number | null }) => string;
} = {
  async fileFollowup(parent, id, f) {
    const dir = parent.worktreePath ?? parent.workdir;
    if (!dir) return null;
    const issue = parent.issueUrl ? `#${/\/issues\/(\d+)/.exec(parent.issueUrl)?.[1] ?? ""}` : "this card";
    const r = await ownerHoldDeps.fileIssue({
      dir,
      key: `finding-closeout:${parent.id}:${id}`,
      title: `Bug (from ${issue}): ${f.text.replace(/\s+/g, " ").slice(0, 110)}`,
      body: [
        `Review finding **${id}** on ${issue} came back after ${f.repeat} fix attempts (the last on the escalation profile), so Agetor took it off that card instead of a further Build (finding close-out, owner decision 2026-10-14).`,
        "",
        "Finding as Review last wrote it:",
        "",
        f.text,
        "",
        `Raised by Review executions ${f.raised.join(", ")} of the card's run. The card's handoffs and Build's Class search lines are in its run folder.`,
        "",
        "Reproduce it with a failing test first, fix the root cause, and close with `Fixes`.",
      ].join("\n"),
      labels: ["bug", "follow-up"],
    });
    return "error" in r ? null : { number: r.number, url: r.url };
  },
  report: (entry) => stepFinalReport(entry.taskId, entry.startedAt, entry.turnStartedAt ?? null, { endedAt: entry.endedAt ?? undefined })?.body ?? "",
};

/**
 * A Build that Finish sent back (CI failed on the published head, typically a
 * runner or network fault) and that ended without changing anything goes
 * straight back to Finish: Review's approval names that exact head, so a
 * second Review of it reviews nothing. Once per approval: if Finish sends the
 * same head back again, the next Build goes to Review as usual, so a failure
 * Build cannot fix still meets Review and the no-change guard.
 */
export async function skipReviewOfApprovedHead(
  parent: Task,
  run: PipelineRunState,
  stepName: string,
  entry: { stepId: string; seq: number },
  resolved: { kind: "steps"; stepIds: string[] },
): Promise<{ kind: "steps"; stepIds: string[] }> {
  if (!run.snapshot || stepRole(stepName, entry.stepId) !== "build" || resolved.stepIds.length !== 1) return resolved;
  const graph = run.snapshot.graph;
  if (stepRole(stepNameById(graph, resolved.stepIds[0]!), resolved.stepIds[0]!) !== "review") return resolved;
  const finish = publishStepFor(parent, run);
  if (!finish || !parent.issueUrl) return resolved;
  const before = run.history.filter((h) => h.seq < entry.seq);
  if (before.at(-1)?.stepId !== finish.id) return resolved;
  const lastReview = before.findLast((h) => stepRole(stepNameById(graph, h.stepId), h.stepId) === "review" && h.handoff);
  if (!lastReview?.handoff) return resolved;
  const since = before.filter((h) => h.seq > lastReview.seq);
  if (since.some((h) => stepRole(stepNameById(graph, h.stepId), h.stepId) === "build" && (h.nextStepIds ?? []).includes(finish.id))) return resolved;
  const checkout = parent.worktreePath ?? parent.workdir;
  const at = checkout ? await loopGuardDeps.readHead(checkout).catch(() => ({ head: null, tree: null })) : { head: null, tree: null };
  if (!at.head || !reviewApprovalMatches(lastReview.handoff, parent.issueUrl, at.head)) return resolved;
  recordActivity(parent.id, {
    kind: "step", tone: "info",
    text: `${stepName} changed nothing after ${finish.name} found a failure; Review already approved ${at.head.slice(0, 8)} — back to ${finish.name} without another Review`,
  });
  return { kind: "steps", stepIds: [finish.id] };
}

/** What the ladder reads from and does to the rest of the core — replaceable
 *  in tests (no GitHub, no tmux). */
export const ownerHoldDeps: {
  fileIssue: (input: { dir: string; key: string; title: string; body: string; labels?: string[] }) => Promise<{ number: number; url: string; reused: boolean } | { error: string }>;
  answerInteraction: (req: ReturnType<typeof listPendingForTask>[number], note: string) => Promise<boolean>;
  hasCommits: (parent: Task) => Promise<boolean>;
  pending: (taskId: string) => ReturnType<typeof listPendingForTask>;
  /** Archive the attempt and reset the worktree to the base
   *  (owner-hold-io.ts `restartFromBase`). */
  restartFromBase: (input: import("./owner-hold-io.ts").CapRestartInput) => Promise<import("./owner-hold-io.ts").CapRestartResult>;
} = {
  fileIssue: async (input) => (await import("./owner-hold-io.ts")).fileOwnerHoldIssue(input),
  answerInteraction: async (req, note) => (await import("./owner-hold-io.ts")).answerPendingInteraction(req, note),
  hasCommits: async (parent) => (await import("./owner-hold-io.ts")).hasCommittedWork(parent),
  pending: (taskId) => listPendingForTask(taskId),
  restartFromBase: async (input) => (await import("./owner-hold-io.ts")).restartFromBase(input),
};

/** The questions the ladder answers by itself: AskUserQuestion (dismissed,
 *  the answer sent as a message) and an fx permission request (declined).
 *  A scraped REPL prompt (a login, a trust or model dialog) is left alone:
 *  what pressing Escape on it does is not known. */
const answerable = (xs: ReturnType<typeof listPendingForTask>) => xs.filter((r) => r.kind !== "tmux_prompt");

/** Questions one step execution may have answered for it automatically. */
const MAX_AUTO_ANSWERED_QUESTIONS = 3;

interface OwnerHold {
  block: PipelineBlock;
  kind: OwnerHoldKind;
  /** The step execution the rung counters are kept for. */
  key: string;
  stepId: string;
  stepName: string;
  taskId: string | null;
  seq: number | null;
  handoff: Handoff | null;
}

const isAutoBlock = (b: PipelineBlock) => b.kind === "slot-wait" || b.kind === "await" || b.inputRetry != null;
/** Blocks that record a Stop someone pressed, or a card someone archived. */
const STOPPED_RE = /was stopped — retry it or advance past it|the pipeline run was stopped|is archived/;

function holdKindOf(b: PipelineBlock, record: PipelineStepRecord | undefined): OwnerHoldKind | null {
  switch (b.kind) {
    case "step-blocked":
      if (!b.taskId) return /\(run by Agetor\) needs you/.test(b.message) ? "publish" : /would take ".*" again/.test(b.message) ? "edge-limit" : "failed";
      if (/already taken that route|no permitted corrective route/.test(b.message)) return "edge-limit";
      if (/is waiting for you$/.test(b.message) || record?.responseKind === "user-ask") return "question";
      return "blocked";
    case "handoff-missing":
    case "handoff-invalid":
      return "no-handoff";
    case "step-failed":
      return "failed";
    case "check-failed":
      return "checks";
    case "step-cap":
      return "step-cap";
    case "profile-missing":
      return "profile-missing";
    case "join-incomplete":
      return "join-incomplete";
    default:
      return null;
  }
}

/**
 * The stop of `run` that would wait for the owner, if there is one and
 * nothing automatic has it: no retry or launch retry pending, no execution
 * live, mid-reminder or mid-checks, and not the wait queue's (a queue entry
 * that escalated is the ladder's). A Stop the user pressed is never one.
 * Exported for tests.
 */
export function ownerHoldOf(run: PipelineRunState): OwnerHold | null {
  if (run.status !== "blocked" || !run.snapshot) return null;
  if (run.autoRetry?.at != null) return null;
  if (Object.values(run.launchRetries ?? {}).some((r) => r.at != null)) return null;
  if (run.active.some((a) => isTaskRunLive(a.taskId) || remindersInFlight.has(a.taskId) || checksInFlight.has(a.taskId))) return null;
  const queued = run.wait && run.wait.state !== "escalated" ? run.wait : null;
  const graph = run.snapshot.graph;
  for (const b of run.blocked) {
    if (isAutoBlock(b) || !b.stepId) continue;
    if (STOPPED_RE.test(b.message)) return null;
    // The queue's: its own execution, or the run-level stop it closed out on.
    if (queued && (b.taskId ? b.taskId === queued.taskId : queued.closeout && queued.taskId === "" && queued.stepId === b.stepId)) continue;
    const active = b.taskId ? run.active.find((a) => a.taskId === b.taskId) : undefined;
    if (b.taskId && !active) continue;
    const record = active ? run.history.find((h) => h.taskId === active.taskId && h.seq === active.seq) : undefined;
    if (record?.outcome === "cancelled") return null;
    const kind = holdKindOf(b, record);
    if (!kind) continue;
    return {
      block: b,
      kind,
      key: active ? `${active.taskId}#${active.seq}` : `${b.kind}@${b.stepId}`,
      stepId: b.stepId,
      stepName: stepNameById(graph, b.stepId),
      taskId: b.taskId,
      seq: active?.seq ?? null,
      handoff: record?.handoff ?? null,
    };
  }
  return null;
}

const sameHold = (run: PipelineRunState | null | undefined, hold: OwnerHold): boolean => {
  const now = run ? ownerHoldOf(run) : null;
  return !!now && now.key === hold.key && now.block.kind === hold.block.kind && now.block.message === hold.block.message;
};

function ladderOf(run: PipelineRunState): NonNullable<PipelineRunState["ladder"]> {
  return (run.ladder ??= { steps: {}, reroutes: 0 });
}

function bump(run: PipelineRunState, key: string, rung: "answers" | "fresh" | "reroutes" | "interactions"): void {
  const l = ladderOf(run);
  const c = (l.steps[key] ??= { answers: 0, fresh: 0, reroutes: 0 });
  c[rung] = (c[rung] ?? 0) + 1;
  if (rung === "reroutes") l.reroutes += 1;
  delete l.resolving;
}

function say(parentId: string, text: string, tone: "info" | "warning" | "muted" = "info"): void {
  recordActivity(parentId, { kind: "step", text: `${RESOLVING_PREFIX}: ${text}`, tone });
}

function logResolution(parentId: string, hold: OwnerHold, action: Exclude<OwnerHoldAction, "park">): void {
  const parent = tasks.get(parentId);
  if (!parent) return;
  logBlockResolution({
    taskId: parentId,
    title: parent.title,
    pipeline: parent.pipelineRun?.pipelineName ?? "",
    step: hold.stepName,
    kind: hold.block.kind,
    message: hold.block.message.slice(0, 500),
    resolution: RESOLUTION[action],
  });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The outgoing contract of `stepId`, for a note into its session. */
function noteShape(graph: PipelineGraph, stepId: string) {
  const step = graph.steps.find((s) => s.id === stepId);
  return {
    outgoing: outgoingSteps(graph, stepId).map((o) => ({ name: o.step.name, label: o.edge.label })),
    transition: step?.transition ?? ("choose" as const),
    canFinish: step?.canFinish === true,
  };
}

/** Send `note` into a stopped step's own session; on failure start the step
 *  again (the same step task). Outside the lock. */
async function sendOrRestart(parentId: string, hold: OwnerHold, note: string): Promise<"sent" | "restarted" | "failed"> {
  const runId = hold.taskId ? tasks.get(hold.taskId)?.runId : null;
  if (hold.taskId && runId) {
    const pending = answerable(ownerHoldDeps.pending(hold.taskId));
    if (pending.length > 0) {
      let all = true;
      for (const req of pending) all = (await ownerHoldDeps.answerInteraction(req, note).catch(() => false)) && all;
      if (all) return "sent";
    } else {
      let sent: Awaited<ReturnType<typeof sendInput>>;
      try {
        sent = await sendInput(runId, note);
      } catch (err) {
        sent = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (sent.delivered) return "sent";
      if (sent.withheld && sent.savedToBacklog) {
        try {
          const item = tasks.get(hold.taskId)?.backlog.find((b) => b.text === note);
          if (item) backlog.remove(hold.taskId, item.id);
        } catch {
          // best-effort
        }
      }
    }
  }
  const r = await retryPipelineStep(parentId, hold.taskId ? { taskId: hold.taskId } : undefined).catch((e: unknown) => ({ error: String(e) }));
  return "error" in r ? "failed" : "restarted";
}

/** Rung 1: the same step, in its own session, with the answer. */
async function ladderAnswer(parentId: string, hold: OwnerHold, why: string): Promise<boolean> {
  const note = await runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    if (!run?.snapshot || !sameHold(run, hold)) return null;
    bump(run, hold.key, "answers");
    if (run.wait && (run.wait.taskId === hold.taskId || run.wait.state === "escalated")) delete run.wait;
    persist(parentId, run);
    return composeOwnerHoldAnswer({
      stepName: hold.stepName,
      reason: hold.handoff?.reason?.trim() || hold.block.message,
      questions: hold.handoff?.openQuestions ?? [],
      asked: hold.kind === "question",
      hardStop: hold.handoff?.hardStop ?? null,
      ...noteShape(run.snapshot.graph, hold.stepId),
    });
  }).catch(() => null);
  if (!note) return false;
  logResolution(parentId, hold, "answer");
  const how = await sendOrRestart(parentId, hold, note);
  if (how === "restarted") {
    await runExclusive(parentId, async () => {
      const run = tasks.get(parentId)?.pipelineRun;
      if (run) {
        bump(run, hold.key, "fresh");
        persist(parentId, run, { preserveStatus: true });
      }
    }).catch(() => undefined);
  }
  say(
    parentId,
    how === "sent"
      ? `told ${hold.stepName} in its own session that nobody will answer — it takes the recommended option as provisional, files a follow-up and continues (${why})`
      : how === "restarted"
        ? `${hold.stepName}'s session could not take the answer, so the step was started again (${why})`
        : `${hold.stepName} could not be resumed (${why}); the next rung follows`,
    how === "failed" ? "warning" : "info",
  );
  return true;
}

/** Rung 2: one fresh session of the same step. */
async function ladderFresh(parentId: string, hold: OwnerHold, why: string): Promise<boolean> {
  const go = await runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    if (!run || !sameHold(run, hold)) return false;
    bump(run, hold.key, "fresh");
    if (run.wait && (run.wait.taskId === hold.taskId || run.wait.state === "escalated")) delete run.wait;
    persist(parentId, run);
    return true;
  }).catch(() => false);
  if (!go) return false;
  logResolution(parentId, hold, "fresh");
  const r = await retryPipelineStep(parentId, hold.taskId ? { taskId: hold.taskId, checksFirst: hold.kind === "checks" } : undefined).catch((e: unknown) => ({ error: String(e) }));
  say(
    parentId,
    "error" in r
      ? `${hold.stepName} could not be started again (${r.error.slice(0, 160)}); the next rung follows`
      : `started ${hold.stepName} again in a fresh session (${why})`,
    "error" in r ? "warning" : "info",
  );
  return true;
}

/** Take the stopped execution (or run-level stop) out of the run, so the
 *  run can move on from another step. Under the lock. */
async function setAsideHold(parentId: string, run: PipelineRunState, hold: OwnerHold, why: string): Promise<void> {
  if (hold.taskId) {
    const a = run.active.find((x) => x.taskId === hold.taskId);
    run.active = run.active.filter((x) => x.taskId !== hold.taskId);
    removeBlockedFor(run, hold.taskId);
    const record = a ? run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq) : undefined;
    if (record && record.outcome === null) {
      record.endedAt = Date.now();
      freezeStepReport(record);
      record.outcome = "failed";
    }
    cancelPendingForTask(hold.taskId, why);
    const archived = await archiveTask(hold.taskId, { force: true, stopRun: true, fromPipeline: true });
    if ("error" in archived) console.warn(`[agetor] pipeline ${parentId}: failed to retire step task ${hold.taskId}:`, archived.error);
  } else {
    run.blocked = run.blocked.filter((b) => b !== hold.block && !(b.taskId === null && b.kind === hold.block.kind && b.stepId === hold.stepId));
    if (hold.kind === "publish") delete run.publish;
  }
  if (run.wait && (run.wait.taskId === (hold.taskId ?? "") || run.wait.state === "escalated")) delete run.wait;
}

/** The handoff a stopped step is taken to have given when the ladder moves
 *  the run on without it. */
function ladderHandoff(run: PipelineRunState, hold: OwnerHold, summary: string, reason: string, next: string | null): Handoff {
  const purpose = hold.handoff?.purpose || [...run.history].reverse().find((h) => h.handoff?.purpose)?.handoff?.purpose || "";
  return normalizeHandoff({
    schemaVersion: 1,
    purpose,
    summary,
    reason,
    next,
    artifacts: hold.handoff?.artifacts ?? [],
    openQuestions: [],
    status: "done",
  });
}

/** Rung 2: a Review or Finish that cannot proceed sends its reason to Build. */
async function ladderReroute(parentId: string, hold: OwnerHold, toStepId: string, why: string): Promise<boolean> {
  const done = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    const run = parent?.pipelineRun;
    if (!parent || !run?.snapshot || parent.archivedAt != null || !sameHold(run, hold)) return null;
    const to = run.snapshot.graph.steps.find((s) => s.id === toStepId);
    if (!to) return null;
    bump(run, hold.key, "reroutes");
    const stated = (hold.handoff?.reason?.trim() || hold.block.message).slice(0, 2000);
    const questions = (hold.handoff?.openQuestions ?? []).filter((q) => q.trim());
    const handoff = ladderHandoff(
      run,
      hold,
      `${hold.stepName} could not proceed, and nobody will answer (the card runs unattended), so Agetor sent the work back to ${to.name}.\n` +
        `${hold.stepName} said: ${stated}` +
        (questions.length ? `\nIts open questions: ${questions.join("; ")}` : ""),
      `Do what ${to.name} can do about this: fix what can be fixed in the worktree (merge a diverged remote branch into this one, never force-push; ` +
        `use your edit tool where a command was refused); for each open question take the recommended option as provisional, record it as provisional and file or reuse one follow-up issue; ` +
        `then hand off as usual so the run continues.`,
      to.name,
    );
    await setAsideHold(parentId, run, hold, `${hold.stepName} sent back to ${to.name} (no owner holds)`);
    await launchTarget(parent, run, to, [{ stepId: hold.stepId, seq: hold.seq ?? 0, handoff }]);
    checkJoinIncomplete(run);
    persist(parentId, run);
    return to.name;
  }).catch(() => null);
  if (!done) return false;
  logResolution(parentId, hold, "reroute");
  say(parentId, `${hold.stepName} could not proceed — sent its reason back to ${done}, the step that can act on it (${why})`, "warning");
  return true;
}

/** Rung 2 for what clears by itself: back in the queue, never escalated. */
async function ladderWait(parentId: string, hold: OwnerHold, category: BlockWaitCategory, now: number): Promise<boolean> {
  const config = blockWaitConfig();
  const w = await runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    if (!run?.wait || run.wait.state !== "escalated" || !sameHold(run, hold)) return null;
    const { escalatedAt: _a, escalation: _b, ...rest } = run.wait;
    run.wait = { ...rest, category, state: "waiting", endless: true, deadline: NO_DEADLINE, at: now + config.longBackoffMin * 60_000 };
    delete ladderOf(run).resolving;
    persist(parentId, run);
    return run.wait;
  }).catch(() => null);
  if (!w) return false;
  logResolution(parentId, hold, "wait");
  say(parentId, `${hold.stepName} keeps waiting on ${w.what} — it clears by itself, so it is re-checked every ${fmtSpan(config.longBackoffMin * 60_000)} and never left for you`);
  return true;
}

/** Rung 3: one follow-up issue per unresolved item, then the wrap-up
 *  through Finish (committed work) or a dependency wait on the issue. */
async function ladderClose(parentId: string, hold: OwnerHold, mode: "publish" | "depend", why: string, now: number): Promise<boolean> {
  const parent = tasks.get(parentId);
  const run0 = parent?.pipelineRun;
  if (!parent || !run0?.snapshot) return false;
  const counters = run0.ladder?.steps[hold.key] ?? NO_COUNTERS;
  const tried = [
    ...(counters.answers ? [`answered ${hold.stepName} in its own session`] : []),
    ...(counters.reroutes ? ["sent the work back to Build"] : []),
    ...(counters.fresh ? [`started ${hold.stepName} again in a fresh session`] : []),
    ...(run0.wait?.tried.length ? [`resumed it ${run0.wait.tried.length} time(s) from the wait queue`] : []),
  ];
  const reason = hold.handoff?.reason?.trim() || hold.block.message;
  const items = unresolvedItems({ openQuestions: hold.handoff?.openQuestions ?? [], reason, fallback: hold.block.message });
  const hardStop = hold.handoff?.hardStop ?? null;
  const issues: number[] = [];
  let failure: string | null = null;
  for (const item of items) {
    const key = followUpKey({ source: parent.issueUrl ?? parentId, step: hold.stepName, question: item.question }, sha256);
    const { title, body } = followUpIssue({
      key, cardTitle: parent.title, cardId: parentId, step: hold.stepName, item, reason, hardStop, tried,
      issueUrl: parent.issueUrl ?? null, prUrl: parent.prUrl ?? null, close: mode,
    });
    const filed = await ownerHoldDeps.fileIssue({ dir: parent.workdir, key, title, body }).catch((e: unknown) => ({ error: String(e) }));
    if ("error" in filed) failure = filed.error;
    else if (!issues.includes(filed.number)) issues.push(filed.number);
  }
  const config = blockWaitConfig();
  const done = await runExclusive(parentId, async () => {
    const p = tasks.get(parentId);
    const run = p?.pipelineRun;
    if (!p || !run?.snapshot || p.archivedAt != null || !sameHold(run, hold)) return null;
    const l = ladderOf(run);
    delete l.resolving;
    if (issues.length === 0) {
      // GitHub did not take the issue: try again later — still nobody's hold.
      run.wait = {
        stepId: hold.stepId, taskId: hold.taskId ?? "", category: "environment", source: "signal", what: "GitHub", ref: null,
        reason: `could not file the follow-up issue: ${(failure ?? "unknown error").slice(0, 160)}`, state: "waiting", since: now, attempt: 0, max: 0,
        at: now + 15 * 60_000, deadline: NO_DEADLINE, tried: [], endless: true, closeout: true,
      };
      persist(parentId, run);
      return "retry" as const;
    }
    l.closed = { at: now, mode, issues };
    const terminal = mode === "publish" ? capWrapUpStep(run.snapshot.graph) : null;
    if (terminal) {
      run.capWrapUp = { at: now, fromStepId: hold.stepId, closeout: { issues, why } };
      const handoff = ladderHandoff(
        run,
        hold,
        `${hold.stepName} stopped on something nobody will answer (${why}). Agetor filed ${issues.map((n) => `#${n}`).join(", ")} for the owner and closes the run out here.\n${hold.stepName} said: ${reason.slice(0, 1500)}`,
        `Publish what is committed and finish the run (see the wrap-up section): the pull request says the head is not approved when it is not, and references ${issues.map((n) => `#${n}`).join(", ")}.`,
        terminal.name,
      );
      await setAsideHold(parentId, run, hold, "closed out without the owner");
      // Nothing else of the run carries on: the wrap-up is its last step.
      await retireActiveExecutions(parentId, run, "closed out without the owner");
      run.blocked = [];
      run.joins = {};
      delete run.wait;
      delete run.autoRetry;
      delete run.launchRetries;
      delete run.publish;
      await launchTarget(p, run, terminal, [{ stepId: hold.stepId, seq: hold.seq ?? 0, handoff }]);
      checkJoinIncomplete(run);
      persist(parentId, run);
      return terminal.name;
    }
    l.closed = { at: now, mode: "depend", issues };
    run.wait = {
      stepId: hold.stepId, taskId: hold.taskId ?? "", category: "dependency", source: "signal", what: `#${issues[0]}`, ref: `#${issues[0]}`,
      reason: (hold.handoff?.reason?.trim() || hold.block.message).split("\n")[0]!.slice(0, 240) || "no reason given",
      state: "waiting", since: now, attempt: 0, max: 0, at: now + config.longBackoffMin * 60_000, deadline: NO_DEADLINE, tried: [], endless: true, closeout: true,
    };
    persist(parentId, run);
    return "depend" as const;
  }).catch(() => null);
  if (!done) return false;
  if (done === "retry") {
    say(parentId, `${hold.stepName} is closed out without you, but its follow-up issue could not be filed (${(failure ?? "").slice(0, 120)}) — trying again in 15 minutes`, "warning");
    return true;
  }
  const list = issues.map((n) => `#${n}`).join(", ");
  logResolution(parentId, hold, done === "depend" ? "close-depend" : "close-publish");
  say(
    parentId,
    done === "depend"
      ? `${hold.stepName} stopped (${why}). Filed ${list} for the owner; the card waits on ${`#${issues[0]}`} and resumes by itself when it is closed`
      : `${hold.stepName} stopped (${why}). Filed ${list} for the owner and closing the run out through ${done}: it publishes what is committed (not approved unless reviewed) and merges nothing`,
    "warning",
  );
  return true;
}

/** The one restart from the base is still there for this card: not used by
 *  this run (nor carried over from the run it restarted), or used only as
 *  far as the reset (the restart itself still to start); and the card has
 *  a branch of its own in a worktree of its own. A branch the card was
 *  pinned to (a PR's head, `branchSource: "existing"`) is never deleted. */
function capRestartAvailable(parent: Task, run: PipelineRunState): boolean {
  if (run.capRestart && run.capRestart.state !== "reset") return false;
  return parent.isolation === "worktree" && !!parent.worktreePath && !!parent.branch && parent.branchSource !== "existing";
}

/**
 * The step cap hit again after the wrap-up (`restart-from-base`): archive
 * the attempt on origin, close its PR, delete its remote branch, reset the
 * worktree to the current base (owner-hold-io.ts `restartFromBase`), and
 * start the run again from scratch — once. `run.capRestart` is written
 * before git is touched and carried onto the restarted run, so neither a
 * core restart nor a second cap hit does it again: a refusal or failure,
 * and the second cap hit, close out on an issue (`close-depend`).
 */
async function ladderRestartFromBase(parentId: string, hold: OwnerHold, why: string, now: number): Promise<boolean> {
  const go = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    const run = parent?.pipelineRun;
    if (!parent || !run?.snapshot || parent.archivedAt != null || !ladderApplies(run) || !sameHold(run, hold)) return null;
    if (!capRestartAvailable(parent, run)) return null;
    delete ladderOf(run).resolving;
    const resumed = run.capRestart?.state === "reset";
    if (!resumed) run.capRestart = { at: now, state: "pending" };
    persist(parentId, run, { preserveStatus: true });
    return { parent, resumed };
  }).catch(() => null);
  if (!go) return false;
  const { parent } = go;
  const failed = async (note: string): Promise<boolean> => {
    await runExclusive(parentId, async () => {
      const run = tasks.get(parentId)?.pipelineRun;
      if (!run) return;
      run.capRestart = { ...(run.capRestart ?? { at: now }), state: "failed", note: note.slice(0, 500) };
      persist(parentId, run, { preserveStatus: true });
    }).catch(() => undefined);
    say(parentId, `the step cap was hit again after the wrap-up, but the card could not be restarted from its base: ${note.slice(0, 240)}`, "warning");
    return ladderClose(parentId, hold, "depend", `${why.split(";")[0]}; the restart from the base was refused: ${note.slice(0, 200)}`, now);
  };

  if (!go.resumed) {
    const r = await ownerHoldDeps.restartFromBase({
      worktree: parent.worktreePath!,
      dir: parent.workdir,
      branch: parent.branch!,
      slug: (await import("./owner-hold-io.ts")).capRestartSlug(issueNumberForTask(parent), parent.branch!),
      base: baseBranchFor(parent.id),
    }).catch((e: unknown) => ({ ok: false as const, why: String(e), archive: [], closedPr: null }));
    if (!r.ok) {
      await runExclusive(parentId, async () => {
        const run = tasks.get(parentId)?.pipelineRun;
        if (!run) return;
        run.capRestart = { at: now, state: "failed", ...(r.archive.length ? { archive: r.archive } : {}), ...(r.closedPr ? { closedPr: r.closedPr } : {}) };
        persist(parentId, run, { preserveStatus: true });
      }).catch(() => undefined);
      return failed(r.why);
    }
    await runExclusive(parentId, async () => {
      const p = tasks.get(parentId);
      const run = p?.pipelineRun;
      if (!p || !run) return;
      // Steps copy the parent's base: the new attempt is measured from the
      // base it starts on, and its PR is a new one.
      tasks.update(parentId, { baseRef: r.baseSha, prUrl: null });
      invalidatePrStatus(parentId);
      run.capRestart = {
        at: now, state: "reset", base: r.base, archive: r.archive,
        ...(r.closedPr ? { closedPr: r.closedPr } : {}), ...(r.note ? { note: r.note } : {}),
      };
      persist(parentId, run, { preserveStatus: true });
    }).catch(() => undefined);
  }

  const record = tasks.get(parentId)?.pipelineRun?.capRestart;
  if (!record || record.state !== "reset") return false;
  const carried = { ...record, state: "started" as const };
  const started = await startPipelineRun(tasks.get(parentId) ?? parent, {
    restart: true,
    fromScratch: true,
    carry: { capRestart: carried },
    // A Stop pressed meanwhile is never undone.
    validate: async () => {
      const run = tasks.get(parentId)?.pipelineRun;
      return run && ladderApplies(run) ? null : "the run was stopped";
    },
  }).catch((e: unknown) => ({ error: String(e) }));
  if ("error" in started) {
    // The attempt is archived and the worktree is on the base: the next pass
    // starts the run (`state: "reset"`), unless it was stopped.
    say(parentId, `the attempt is archived and the worktree is on ${record.base ?? "the base"}, but the run could not start yet (${started.error.slice(0, 160)}); it starts on the next pass`, "warning");
    return true;
  }
  logResolution(parentId, hold, "restart-from-base");
  const refs = (record.archive ?? []).map((a) => `${a.ref} (${a.sha.slice(0, 12)})`).join(" and ");
  say(
    parentId,
    `the step cap was hit again after the wrap-up, so the card restarted once from the current ${record.base ?? "base"}: ` +
      `the old attempt is archived on origin at ${refs || "(no ref)"}` +
      (record.closedPr ? `, PR #${record.closedPr} was closed with a comment saying so` : "") +
      `, the remote branch was deleted and the worktree reset to origin/${record.base ?? "base"}. A second cap hit files an issue and waits` +
      (record.note ? ` (${record.note})` : ""),
    "warning",
  );
  return true;
}

/** A closed-out card's follow-up issue was closed: a new allowance, and the
 *  stopped step resumes (or the run-level stop is retried). */
async function resumeClosedOut(parentId: string, cleared: string, now: number): Promise<boolean> {
  const go = await runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    const w = run?.wait;
    if (!run || !w?.closeout || w.state !== "waiting") return null;
    const userStop = run.ladder?.userStop;
    run.ladder = { steps: {}, reroutes: 0, ...(userStop != null ? { userStop } : {}) };
    if (w.taskId) {
      // The queue's ordinary resume, with what changed.
      const { closeout: _closeout, ...rest } = w;
      run.wait = { ...rest, attempt: 0, max: 1, endless: true };
      persist(parentId, run);
      return "step" as const;
    }
    delete run.wait;
    persist(parentId, run);
    return "run" as const;
  }).catch(() => null);
  if (!go) return false;
  recordActivity(parentId, { kind: "step", text: `${cleared} — resuming the card`, tone: "info" });
  if (go === "step") return resumeBlockedStep(parentId, cleared, `${cleared} (read its resolution with \`gh issue view\` and its comments, and act on it)`, now);
  const r = await retryPipelineStep(parentId).catch((e: unknown) => ({ error: String(e) }));
  return !("error" in r);
}

/** Questions a step of an unattended run asked while working: answered
 *  automatically (dismissed, never approved) with the rung-1 message. */
async function answerAskedQuestions(parentId: string): Promise<boolean> {
  const go = await runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    if (!run?.snapshot || (run.status !== "running" && run.status !== "blocked") || !ladderApplies(run)) return null;
    for (const a of run.active) {
      const pending = answerable(ownerHoldDeps.pending(a.taskId));
      if (pending.length === 0) continue;
      const key = `${a.taskId}#${a.seq}`;
      const n = run.ladder?.steps[key]?.interactions ?? 0;
      const stepName = stepNameById(run.snapshot.graph, a.stepId);
      if (n >= MAX_AUTO_ANSWERED_QUESTIONS) {
        // It keeps asking: no more answers. Its turn ends on the question,
        // and the ladder takes it from there.
        cancelPendingForTask(a.taskId, "unattended run: nobody will answer (owner_holds)");
        return { stepName, pending: [], note: "", cancelled: true };
      }
      bump(run, key, "interactions");
      persist(parentId, run, { preserveStatus: true });
      const record = run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq);
      const questions = pending.flatMap((p) => (p.kind === "ask_questions" ? p.questions.map((q) => q.question) : []));
      return {
        stepName,
        pending,
        cancelled: false,
        note: composeOwnerHoldAnswer({
          stepName, reason: record?.handoff?.reason || "you asked a question", questions, asked: true, ...noteShape(run.snapshot.graph, a.stepId),
        }),
      };
    }
    return null;
  }).catch(() => null);
  if (!go) return false;
  if (go.cancelled) {
    say(parentId, `${go.stepName} keeps asking questions nobody will answer — no more answers; the ladder takes it from here`, "warning");
    return true;
  }
  let all = true;
  for (const req of go.pending) all = (await ownerHoldDeps.answerInteraction(req, go.note).catch(() => false)) && all;
  say(parentId, all ? `${go.stepName} asked a question nobody will answer — answered it: take the recommended option as provisional and continue` : `${go.stepName} asked a question; the automatic answer could not be delivered`, all ? "info" : "warning");
  return true;
}

const ladderInFlight = new Set<string>();

/** One card: questions first, then its stop, if any. `busy`: the machine
 *  has no room for another step now (slots, a usage limit) — a rung that
 *  would start one waits for the next pass. */
async function resolveOwnerHoldOf(parentId: string, now: number, busy: (stepName: string) => boolean): Promise<boolean> {
  if (await answerAskedQuestions(parentId)) return true;
  const seen = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    const run = parent?.pipelineRun;
    if (!parent || !run?.snapshot || parent.archivedAt != null || !ladderApplies(run)) return null;
    const hold = ownerHoldOf(run);
    if (!hold) {
      if (run.ladder?.resolving) {
        delete run.ladder.resolving;
        persist(parentId, run, { preserveStatus: true });
      }
      return null;
    }
    const graph = run.snapshot.graph;
    const role = stepRole(hold.stepName, hold.stepId);
    const build = graph.steps.find((s) => s.id !== hold.stepId && stepRole(s.name, s.id) === "build" && !isFollowUpStepId(s.id));
    const config = blockWaitConfig();
    const w = run.wait;
    const external = w?.state === "escalated" && (w.taskId === (hold.taskId ?? "")) && config.enabled && SELF_CLEARING.includes(w.category) ? w.category : null;
    return {
      parent,
      hold,
      input: {
        mode: "resolve" as const,
        unattended: true,
        userStopped: false,
        kind: hold.kind,
        role,
        hasSession: !!hold.taskId && !!tasks.get(hold.taskId)?.runId,
        hardStop: hold.handoff?.hardStop ?? null,
        external,
        counters: run.ladder?.steps[hold.key] ?? NO_COUNTERS,
        runReroutes: run.ladder?.reroutes ?? 0,
        rerouteTo: build && !exhaustedEdge(graph, run.history, hold.stepId, [build.id]) ? build.id : null,
        closed: run.ladder?.closed != null,
        wrapUpAvailable: capWrapUpStep(graph) != null && run.capWrapUp == null,
        wrapUpUsed: run.capWrapUp != null,
        capRestartAvailable: capRestartAvailable(parent, run),
      },
      startStepName: resolveStartStep(graph)?.name ?? hold.stepName,
    };
  }).catch(() => null);
  if (!seen) return false;
  const hasCommits = await ownerHoldDeps.hasCommits(seen.parent).catch(() => false);
  const decision = resolveOwnerHold({ ...seen.input, hasCommits });
  // Resuming or restarting a step takes a slot like any other start. A
  // restart from the base waits for its start step's slot before touching
  // git (a restart cannot queue for one).
  if ((decision.action === "answer" || decision.action === "fresh") && !isPriority(parentId) && busy(seen.hold.stepName)) return false;
  if (decision.action === "restart-from-base" && busy(seen.startStepName)) return false;
  switch (decision.action) {
    case "park":
      return false;
    case "answer":
      return ladderAnswer(parentId, seen.hold, decision.why);
    case "fresh":
      return ladderFresh(parentId, seen.hold, decision.why);
    case "reroute":
      return ladderReroute(parentId, seen.hold, decision.to, decision.why);
    case "wait":
      return ladderWait(parentId, seen.hold, decision.category, now);
    case "restart-from-base":
      return ladderRestartFromBase(parentId, seen.hold, decision.why, now);
    case "close-publish":
      return ladderClose(parentId, seen.hold, "publish", decision.why, now);
    case "close-depend":
      return ladderClose(parentId, seen.hold, "depend", decision.why, now);
  }
}

/**
 * One pass of the ladder over every unattended card: a question a step asked
 * is answered; a stop that would wait for the owner gets its next rung. One
 * action per card a pass; a card being acted on is skipped. Exported for
 * tests; the slot scheduler runs it every {@link BLOCK_WAIT_TICK_MS}, and a
 * new stop sets it off sooner (`kickOwnerHolds`).
 */
export async function resolveOwnerHolds(now = Date.now()): Promise<number> {
  if (ownerHoldsMode() === "park") return 0;
  const config = blockWaitConfig();
  const live = tasks.listLive().filter((t) => t.archivedAt == null);
  const quotaHold = live.some((t) => waitingOnQuota(t.pipelineRun) || (t.pipelineRun?.active ?? []).some((a) => isQuotaPaused(a.taskId)));
  const busy = (stepName: string) => {
    if (quotaHold) return true;
    const slots = currentSlots();
    return !slotDecision(stepName, slotUse(isTaskRunLive, slots), slots).ok;
  };
  let acted = 0;
  // Oldest stop first, priority cards ahead; at most `maxPerPass` actions a
  // pass, as the wait queue resumes (a board full of stops after an
  // upgrade is worked through a few at a time).
  const cards = priorityFirst(
    live.filter((t) => !t.pipelineParentId && t.pipelineRun?.snapshot?.decisionPolicy)
      .sort((a, b) => (a.pipelineRun?.ladder?.resolving?.since ?? 0) - (b.pipelineRun?.ladder?.resolving?.since ?? 0)),
    (t) => t.id,
  );
  for (const t of cards) {
    if (acted >= config.maxPerPass) break;
    if (ladderInFlight.has(t.id) || recoveriesInFlight.has(t.id)) continue;
    ladderInFlight.add(t.id);
    try {
      if (await resolveOwnerHoldOf(t.id, now, busy)) acted++;
    } catch (err) {
      console.warn(`[agetor] owner-hold ladder failed for ${t.id}:`, err);
    } finally {
      ladderInFlight.delete(t.id);
    }
  }
  return acted;
}

let ownerHoldKick: ReturnType<typeof setTimeout> | null = null;
/** A new stop on an unattended card: decide within seconds rather than at
 *  the next tick. Only once the scheduler runs (never in tests). */
function kickOwnerHolds(): void {
  if (!slotLoop || ownerHoldKick) return;
  ownerHoldKick = setTimeout(() => {
    ownerHoldKick = null;
    void resolveOwnerHolds().catch(() => 0);
  }, 2_000);
  ownerHoldKick.unref?.();
}

/** When each queued step started waiting (`<parentId>:<stepId>`) — slots go
 *  to the longest-waiting first. In memory: after a restart the order is
 *  rebuilt from the first pass. */
const slotWaitSince = new Map<string, number>();

/** Retire only an undelivered formatting note superseded by the child's
 * exact newer run. That turn owns settlement, including any real hold. */
function retireStaleQueuedReminder(parentId: string, run: PipelineRunState, taskId: string): ReturnType<typeof runs.get> {
  const active = run.active.find(a => a.taskId === taskId);
  const history = active && run.history.find(h => h.taskId === taskId && h.seq === active.seq);
  const reminder = history?.reminder;
  const block = run.blocked.find(b => b.taskId === taskId && b.kind === 'slot-wait');
  const child = tasks.get(taskId);
  if (!block || !history || !reminder || reminder.delivered || !reminder.runId || !child?.runId
    || child.runId === reminder.runId || child.archivedAt != null) return null;
  const newer = runs.get(child.runId), original = runs.get(reminder.runId);
  if (!newer || !original || newer.taskId !== taskId || newer.startedAt < original.startedAt) return null;
  run.blocked = run.blocked.filter(b => b !== block);
  delete history.reminder;
  history.turnStartedAt = newer.startedAt;
  persist(parentId, run);
  return newer;
}

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
    const ok = await runExclusive(w.parentId, async () => {
      const parent = tasks.get(w.parentId);
      const run = parent?.pipelineRun;
      if (!parent || !run || parent.archivedAt != null || ['cancelled','done','idle'].includes(run.status)) return false;
      const block = run.blocked.find((b) => b.stepId === w.stepId && (b.kind === "slot-wait"
        || b.kind === 'step-blocked' && b.taskId === null && b.inputRetry && b.inputRetry.at <= now));
      const step = run.snapshot?.graph.steps.find((s) => s.id === w.stepId);
      if (!block || !step) return false;
      if (block.taskId) {
        const newer = retireStaleQueuedReminder(parent.id, run, block.taskId);
        if (newer) {
          const status = newer.status;
          return status === 'running' ? false : { taskId: newer.taskId, runId: newer.id, status };
        }
      }
      // Still over a limit for this step (e.g. the verification slot)? Leave it queued.
      if (!urgent && !slotDecision(step.name, slotUse(isTaskRunLive, slots), slots).ok) return false;
      if (block.taskId) {
        const active = run.active.find(a => a.taskId === block.taskId && a.stepId === w.stepId);
        const child = tasks.get(block.taskId);
        if (!active || !child || child.archivedAt != null || isTaskRunLive(child.id)
          || listPendingForTask(child.id).length > 0) return false;
        const historyEntry = run.history.find(h => h.taskId === child.id && h.seq === active.seq);
        const reminder = historyEntry?.reminder;
        // Retry only the undelivered formatting note, not the work that
        // already completed. A newer turn owns its own settle/continuation.
        if (reminder && !reminder.delivered) {
          if (!reminder.runId || child.runId !== reminder.runId) return false;
          run.blocked = run.blocked.filter(b => b !== block);
          return attemptHandoffReminderOrBlock({ parentId: parent.id, run, taskId: child.id,
            runId: reminder.runId, activeEntry: active, historyEntry, graph: run.snapshot!.graph,
            stepName: step.name, reason: reminder.reason, detail: reminder.detail,
            baseMessage: block.message.replace(/ \(automatic reminder could not be sent:.*\)$/s, '') }) ?? false;
        }
        const result = await performPipelineRetry(parent, run, child.id);
        return !('error' in result);
      }
      if (!block.pending) return false;
      run.blocked = run.blocked.filter((b) => b !== block);
      const previous = block.pending.arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
      const r = await launchTarget(parent, run, step, previous, { inputRetryAttempt: block.inputRetry?.attempt });
      persist(w.parentId, run);
      return r.ok;
    }).catch(() => false);
    if (typeof ok === 'object') {
      if ('status' in ok) {
        await handleRunStatus(ok.taskId, ok.runId, ok.status);
        continue;
      }
      // sendInput must stay outside the parent lock.
      await deliverHandoffReminder(ok);
      const history = tasks.get(ok.parentId)?.pipelineRun?.history.find(h => h.taskId === ok.taskId && h.seq === ok.seq);
      if (history?.reminder?.delivered) launched++;
    } else if (ok) launched++;
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
  // No owner holds: every stop that would wait for the owner gets its next
  // rung. Persisted on the runs, like the queue.
  setInterval(() => void resolveOwnerHolds().catch(() => 0), BLOCK_WAIT_TICK_MS).unref?.();
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
  if (run.wait?.closeout && run.wait.taskId === "") {
    // A run-level close-out has no execution: it lasts while its stop does.
    const w = run.wait;
    if (!run.blocked.some((b) => b.taskId === null && b.stepId === w.stepId && !isAutoBlock(b))) delete run.wait;
  } else if (run.wait) {
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
  // No owner holds: a stop the ladder will take reads as being resolved,
  // not as needing the owner, from the moment it is recorded.
  if (run.ladder?.resolving && run.status !== "blocked") delete run.ladder.resolving;
  if (run.status === "blocked" && run.snapshot?.decisionPolicy && run.ladder?.userStop == null && !run.ladder?.resolving) {
    const hold = ownerHoldOf(run);
    if (hold && ladderApplies(run)) {
      ladderOf(run).resolving = { since: Date.now(), note: `${hold.stepName}: ${hold.handoff?.reason?.trim() || hold.block.message}`.split("\n")[0]!.slice(0, 240) };
      kickOwnerHolds();
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
// ---------------------------------------------------------------------------
// Finish run by Agetor (src/shared/publish.ts, src/bun/publish-step.ts)
// ---------------------------------------------------------------------------

/** Whether the `pipeline_gates` preference names this card's pipeline (and,
 *  during the trial, the card) for `gate` right now. */
function gatePref(gate: PipelineGateName, parent: Pick<Task, "id" | "pipelineId">, run: Pick<PipelineRunState, "pipelineName">): boolean {
  const name = (parent.pipelineId ? pipelines.get(parent.pipelineId)?.name : null) ?? run.pipelineName;
  return publishGateOn(parsePipelineGate(preferences.get(PIPELINE_GATES_PREF), gate), { id: parent.id, pipelineId: parent.pipelineId ?? null, pipelineName: name });
}

/** What `pipeline_gates` names that is not there — a pipeline that is no
 *  pipeline's id or exact name, a card id no task has — or null when every
 *  entry matches. Such an entry switches nothing on, and says so wherever
 *  gates are adopted. */
export function pipelineGatesUnmatched(): GateUnmatched | null {
  const raw = preferences.get(PIPELINE_GATES_PREF);
  if (!raw || raw.trim() === "{}") return null;
  const known = pipelines.list().map((p) => ({ id: p.id, name: p.name }));
  // A card whose template was deleted still runs under the name its run
  // froze (`gatePref`): that name is not "nothing".
  known.push(...tasks.pipelinesOutside(new Set(known.map((p) => p.id))));
  const found = unmatchedGateRefs(raw, { pipelines: known, hasCard: (id) => !!tasks.get(id) });
  return found.pipelines.length > 0 || found.cards.length > 0 ? found : null;
}

export function publishGatePref(parent: Pick<Task, "id" | "pipelineId">, run: Pick<PipelineRunState, "pipelineName">): boolean {
  return gatePref("publish", parent, run);
}

/** The gate `step` is judged by for this card, or null. As with `publish`,
 *  two things must hold: the run adopted the `steps` gate (`snapshot.gates`,
 *  at run start or by an explicit refresh — never by itself) and the
 *  preference still names the card, so taking a card or a pipeline out of
 *  `pipeline_gates` works at once: its steps advance on their handoffs again
 *  from the next turn that ends. */
export function stepGateFor(parent: Pick<Task, "id" | "pipelineId">, run: PipelineRunState, step: PipelineStep): StepGate | null {
  const gate = stepGate(run.snapshot, step, run.history);
  return gate && gatePref("steps", parent, run) ? gate : null;
}

/** The step Agetor runs for this card, or null. Two things must hold: the
 *  run adopted the gate (`snapshot.gates`, set at run start or by an explicit
 *  refresh — never by itself) and the preference still names the card, so
 *  taking a card or a pipeline out of `pipeline_gates` works at once. */
export function publishStepFor(parent: Pick<Task, "id" | "pipelineId">, run: PipelineRunState): PipelineStep | null {
  const step = publishStepOf(run.snapshot);
  return step && publishGatePref(parent, run) ? step : null;
}

/** Called when a card's Finish is put on hold for Agetor: the publish loop
 *  (src/bun/publish-step.ts) sets it to take a first look at once instead of
 *  on its next minute. A hook because that module imports this one. */
export const publishHooks = { held: (_parentId: string): void => {} };

/** What a launch of `step` is under the gate: `hold` — Agetor runs it, no
 *  step task; `write` — the visit's one agent turn; null — an ordinary launch. */
function publishDispatch(parent: Task, run: PipelineRunState, step: PipelineStep): "hold" | "write" | null {
  if (publishStepFor(parent, run)?.id !== step.id) return null;
  const p = run.publish;
  if (!p || publishVisitOver(p, step.id, run.active.map((a) => a.seq))) return "hold";
  if (p.state === "agent") return null;
  return p.state === "write" ? "write" : "hold";
}

/** Park a launch of the publish step as a run-level `await` block: the run
 *  reads as running and waiting, no step task exists, no slot is taken and
 *  no step is counted. `pending` keeps the arrivals for the writer's launch. */
function holdForPublish(parent: Task, run: PipelineRunState, step: PipelineStep, arrivals: PipelineJoinArrival[]): void {
  if (!run.publish || publishVisitOver(run.publish, step.id, run.active.map((a) => a.seq))) {
    run.publish = initialPublishState(step.id, Date.now());
    recordActivity(parent.id, { kind: "step", text: `${step.name} is run by Agetor for this card: it verifies the approved head, pushes once and waits for CI itself`, tone: "info" });
  } else {
    // Re-entered by a Retry after Agetor stopped for the owner: the action
    // that kept failing gets a fresh set of attempts.
    run.publish.tries = 0;
  }
  run.blocked = run.blocked.filter((b) => !(b.taskId === null && b.stepId === step.id));
  run.blocked.push({ taskId: null, stepId: step.id, kind: "await", message: publishBlockMessage(step.name, run.publish), pending: { stepId: step.id, arrivals } });
  persist(parent.id, run);
  publishHooks.held(parent.id);
}

/** The held publish visit of `parentId`, read fresh — or why there is none. */
function heldPublish(parentId: string): { parent: Task; run: PipelineRunState; step: PipelineStep; block: PipelineBlock } | { error: string } {
  const parent = tasks.get(parentId);
  const run = parent?.pipelineRun;
  if (!parent || !run?.snapshot || tombstonedPipelineParents.has(parentId) || parent.archivedAt != null) return { error: "the card is gone or archived" };
  const p = run.publish;
  const step = p ? run.snapshot.graph.steps.find((s) => s.id === p.stepId) : undefined;
  const block = p ? run.blocked.find((b) => b.taskId === null && b.stepId === p.stepId && b.kind === "await" && b.pending) : undefined;
  if (!p || !step || !block || p.state === "write" || p.state === "agent") return { error: "Finish is not held by Agetor" };
  return { parent, run, step, block };
}

/**
 * Change the held publish visit's state under the card's lock. `expect` is
 * the state the caller observed: if the visit moved on meanwhile (a Retry, a
 * restart, another pass) nothing is written. Returns the stored state.
 */
export function updatePublish(
  parentId: string,
  expect: Pick<PipelinePublishState, "state" | "stateSince">,
  next: PipelinePublishState,
): Promise<PipelinePublishState | null> {
  return runExclusive(parentId, async () => {
    const held = heldPublish(parentId);
    if ("error" in held) return null;
    const p = held.run.publish!;
    if (p.state !== expect.state || p.stateSince !== expect.stateSince) return null;
    held.run.publish = next;
    held.block.message = publishBlockMessage(held.step.name, next);
    persist(parentId, held.run);
    return next;
  });
}

/** A hidden, never-started step row for a Finish visit Agetor ended itself
 *  (it sent the card back to Build): the history record needs a task, and
 *  the card's step strip opens it to show what was found. */
function insertPublishRecordTask(parent: Task, run: PipelineRunState, step: PipelineStep, text: string): string {
  const profile = step.agentProfileId ? run.snapshot?.profiles[step.agentProfileId] : undefined;
  const id = randomUUID();
  const now = Date.now();
  tasks.insert({
    id, title: `${run.pipelineName} · ${step.name}`, prompt: text, column: "done",
    agent: profile?.harness ?? parent.agent, workdir: parent.workdir, isolation: parent.isolation, taskType: parent.taskType,
    branch: parent.branch, branchSource: parent.branchSource, worktreePath: parent.worktreePath, baseRef: parent.baseRef,
    prUrl: null, issueUrl: null, mode: profile?.mode ?? parent.mode, model: profile?.model ?? parent.model,
    effort: profile?.effort ?? parent.effort, fast: profile?.fast ?? false, maxMode: profile?.maxMode ?? false,
    agentProfileId: profile?.id ?? null, agentProfile: profile ?? null, references: [], backlog: [], draft: null, plans: [],
    todoProgress: null, runId: null, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    pipelineId: null, pipelineRun: null, pipelineParentId: parent.id, pipelineStepId: step.id,
    createdAt: now, updatedAt: now, archivedAt: null,
  });
  return id;
}

/**
 * End the held publish visit by sending the card to another step (Build, on
 * the "verification failed" edge) with `handoff` as Finish's own. Agetor ran
 * the visit, so its record is written here: one execution in the step count
 * and in the edge's `maxTraversals`, exactly what an agent's Finish costs.
 */
export function routeFromPublish(
  parentId: string,
  input: { toStepId: string; handoff: Handoff; activity: string },
): Promise<{ ok: true } | { error: string }> {
  return runExclusive(parentId, async () => {
    const held = heldPublish(parentId);
    if ("error" in held) return held;
    const { parent, run, step, block } = held;
    const graph = run.snapshot!.graph;
    const target = graph.steps.find((s) => s.id === input.toStepId);
    if (!target) return { error: `unknown step id "${input.toStepId}"` };
    const handoff = normalizeHandoff(input.handoff);
    const spent = exhaustedEdge(graph, run.history, step.id, [target.id]);
    if (spent) {
      // The same limit an agent's choice of this edge meets (`settleStepRun`).
      const label = spent.edge.label.trim() || target.name;
      run.blocked = run.blocked.filter((b) => b !== block);
      upsertBlocked(run, {
        taskId: null, stepId: step.id, kind: "step-blocked", pending: block.pending,
        message: `${step.name} (run by Agetor) would take "${label}" again, but this run has already taken that route ${spent.taken} of ${spent.edge.maxTraversals} times — ${handoff.purpose}. Take the card over, or take it out of pipeline_gates and Retry to have its agent run ${step.name}`,
      });
      recordActivity(parentId, { kind: "step", tone: "warning", text: `${step.name} → ${target.name} ("${label}") reached its limit of ${spent.edge.maxTraversals} — waiting for you` });
      persist(parentId, run);
      return { error: "the route back has reached its limit" };
    }
    const seq = ++run.stepCount;
    const now = Date.now();
    const taskId = insertPublishRecordTask(parent, run, step, `${step.name} was run by Agetor, not by an agent.\n\n${handoff.purpose}\n\n${handoff.summary}`);
    run.history.push({
      seq, stepId: step.id, taskId, startedAt: run.publish!.since, endedAt: now, outcome: "succeeded",
      handoff, nextStepIds: [target.id], responseKind: "handoff",
    });
    run.blocked = run.blocked.filter((b) => b !== block);
    delete run.publish;
    recordActivity(parentId, { kind: "step", text: input.activity, tone: "warning" });
    await launchTarget(parent, run, target, [{ stepId: step.id, seq, handoff }]);
    persist(parentId, run);
    return { ok: true as const };
  });
}

/**
 * End the held part of the publish visit by launching the step's agent:
 * `write` — CI is green, one turn to write the PR description (`brief`
 * replaces the step's instructions); `agent` — Agetor cannot run this visit
 * and the agent runs Finish as before.
 */
export function launchPublishAgent(
  parentId: string,
  input: { mode: "write" | "agent"; brief?: string; activity: string },
): Promise<{ ok: true } | { error: string }> {
  return runExclusive(parentId, async () => {
    const held = heldPublish(parentId);
    if ("error" in held) return held;
    const { parent, run, step, block } = held;
    const now = Date.now();
    run.publish = { ...run.publish!, state: input.mode, stateSince: now, tries: 0, note: input.activity, ...(input.brief ? { brief: input.brief } : {}) };
    run.blocked = run.blocked.filter((b) => b !== block);
    recordActivity(parentId, { kind: "step", text: input.activity, tone: input.mode === "write" ? "success" : "muted" });
    const previous = (block.pending?.arrivals ?? []).map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
    await launchTarget(parent, run, step, previous);
    persist(parentId, run);
    return { ok: true as const };
  });
}

/** Stop the held publish visit for the owner: the hold becomes an ordinary
 *  blocked launch of the step, and a Retry resumes the visit where it was. */
export function stopPublishForOwner(parentId: string, why: string): Promise<boolean> {
  return runExclusive(parentId, async () => {
    const held = heldPublish(parentId);
    if ("error" in held) return false;
    const { run, step, block } = held;
    run.blocked = run.blocked.filter((b) => b !== block);
    upsertBlocked(run, { taskId: null, stepId: step.id, kind: "step-blocked", message: `${step.name} (run by Agetor) needs you: ${why}. Retry resumes it where it stopped`, pending: block.pending });
    run.publish = { ...run.publish!, note: why };
    recordActivity(parentId, { kind: "step", text: `${step.name} (run by Agetor) stopped for you: ${why}`, tone: "danger" });
    persist(parentId, run);
    return true;
  });
}

/**
 * Adopt (or drop) check gates on a run from the `pipeline_gates` preference
 * as it stands now — the explicit refresh a running card needs: gates change
 * behaviour, so saving a pipeline or the preference alone never changes a run
 * that has started. Takes effect at the step's next launch; a step in
 * mid-turn is not switched.
 */
export function adoptPipelineGates(parentId: string): Promise<PipelineGateAdoption | { error: string; status: 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const adopted = await adoptPipelineGatesLocked(parentId);
    if ("error" in adopted) return adopted;
    // An entry of the preference that matches nothing gates nothing: say so
    // on the card that was asked about, and in the answer.
    const unmatched = pipelineGatesUnmatched();
    if (!unmatched) return adopted;
    const parent = tasks.get(parentId);
    const mine = parent?.pipelineId ? pipelines.get(parent.pipelineId) : null;
    const line = gateUnmatchedLine(unmatched)!;
    const said = `${line}.${mine ? ` This card's pipeline is ${JSON.stringify(mine.name)} (id ${mine.id}).` : ""}`;
    if (gateUnmatchedSaid.get(parentId) !== said) {
      gateUnmatchedSaid.set(parentId, said);
      recordActivity(parentId, { kind: "auto", tone: "warning", text: said });
      console.warn(`[agetor] ${line}`);
    }
    return { ...adopted, unmatched };
  });
}

/** What {@link adoptPipelineGates} answers. `unmatched` is only there when
 *  `pipeline_gates` names a pipeline or a card that does not exist. */
export interface PipelineGateAdoption {
  publish: boolean;
  steps: boolean;
  changed: boolean;
  unmatched?: GateUnmatched;
}

/** The last "names what is not there" line said on each card: once per
 *  wording, not once per refresh. */
const gateUnmatchedSaid = new Map<string, string>();

async function adoptPipelineGatesLocked(parentId: string): Promise<{ publish: boolean; steps: boolean; changed: boolean } | { error: string; status: 404 | 409 }> {
  {
    const parent = tasks.get(parentId);
    if (!parent?.pipelineId || tombstonedPipelineParents.has(parentId)) return { error: "not a pipeline task", status: 404 as const };
    if (parent.archivedAt != null) return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
    const run = parent.pipelineRun;
    if (!run?.snapshot) return { error: "pipeline has never run — it takes the gates when it starts", status: 409 as const };
    const publish = publishGatePref(parent, run) && !!reviewedPipelineShape(run.snapshot.graph);
    const steps = gatePref("steps", parent, run);
    const had = { publish: run.snapshot.gates?.publish === true, steps: run.snapshot.gates?.steps === true };
    // With the `steps` gate the run also takes each step's goal, checks and
    // turn allowance from the template as they stand now (never its text).
    const template = steps ? pipelines.get(parent.pipelineId)?.graph : undefined;
    const graph = template ? updatedPipelineGates(run.snapshot.graph, template) : run.snapshot.graph;
    if (publish === had.publish && steps === had.steps && graph === run.snapshot.graph) return { publish, steps, changed: false };
    const { gates: _dropped, ...rest } = run.snapshot;
    const gates = { ...(publish ? { publish: true as const } : {}), ...(steps ? { steps: true as const } : {}) };
    run.snapshot = { ...rest, graph, ...(publish || steps ? { gates } : {}) };
    if (publish !== had.publish) {
      recordActivity(parentId, {
        kind: "auto", tone: "info",
        text: publish
          ? "Check gates adopted: Finish is run by Agetor from its next launch (pipeline_gates)"
          : "Check gates dropped: Finish is run by its agent again from its next launch",
      });
    }
    if (steps !== had.steps || graph !== rest.graph) {
      const gated = graph.steps.filter((st) => stepGate({ graph, gates }, st)).map((st) => st.name);
      recordActivity(parentId, {
        kind: "auto", tone: "info",
        text: steps
          ? `Check gates adopted: ${gated.join(", ") || "no step"} advance${gated.length === 1 ? "s" : ""} on checks Agetor runs, from the next launch (pipeline_gates)`
          : "Check gates dropped: steps advance on their handoffs again",
      });
    }
    persist(parentId, run, { preserveStatus: true });
    return { publish, steps, changed: true };
  }
}

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

  // Finish run by Agetor (`pipeline_gates`): no step task while it verifies,
  // pushes and waits — the launch is parked and src/bun/publish-step.ts
  // carries the visit. Its one agent turn (`write`) comes back through here.
  const publishing = publishDispatch(parent, run, step);
  if (publishing === "hold") {
    holdForPublish(parent, run, step, pendingArrivals);
    return { ok: false };
  }
  const publishBrief = publishing === "write" ? run.publish?.brief : undefined;

  // The step cap stops a run that goes round in circles. On an unattended
  // board the first hit extends the allowance by itself (the same
  // extension a person's Retry grants); a run that uses those up as well is
  // the loop the cap exists for, and waits for someone.
  if (
    run.stepCount >= effectiveStepCap(run) &&
    snapshot.decisionPolicy &&
    (run.capExtensions ?? 0) < AUTO_CAP_EXTENSIONS
  ) {
    const before = effectiveStepCap(run);
    run.capExtensions = (run.capExtensions ?? 0) + 1;
    recordActivity(parent.id, {
      kind: "step",
      text: `Reached the ${before}-step cap — continuing automatically up to ${effectiveStepCap(run)} (${run.capExtensions} of ${AUTO_CAP_EXTENSIONS} automatic extensions)`,
      tone: "warning",
    });
  }
  // Out of extensions, an unattended run is finished once through its
  // terminal step, which files issues for what is unresolved, instead of
  // waiting for someone (`run.capWrapUp`). The mark has no `seq` until that
  // step's task exists, so a wrap-up that queued for a slot or threw before
  // the insert comes back through here and is let past the cap again.
  let wrapUp = false;
  if (
    (run.stepCount >= effectiveStepCap(run) || run.capWrapUp?.closeout != null) &&
    snapshot.decisionPolicy &&
    run.capWrapUp?.seq === undefined
  ) {
    const terminal = capWrapUpStep(snapshot.graph);
    const mine = !run.capWrapUp || step.id === terminal?.id || step.id === run.capWrapUp.fromStepId;
    if (terminal && mine && !run.active.some((a) => a.stepId === terminal.id)) {
      if (!run.capWrapUp) {
        run.capWrapUp = { at: Date.now(), fromStepId: step.id };
        recordActivity(parent.id, {
          kind: "step",
          text: `Reached the ${effectiveStepCap(run)}-step cap — finishing through ${terminal.name} and filing issues for what is unresolved`,
          tone: "warning",
        });
      }
      step = terminal;
      wrapUp = true;
    }
  }
  if (!wrapUp && run.stepCount >= effectiveStepCap(run)) {
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
  const stepProfile = step.agentProfileId ? snapshot.profiles[step.agentProfileId] : undefined;
  if (!stepProfile) {
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
  // Review rounds (src/shared/finding-ledger.ts, `pipeline_rounds`): a Build
  // whose findings came back runs on the escalation profile; a re-review
  // runs at the lighter effort.
  const rounds = parseRoundsPolicy(preferences.get(ROUNDS_PREF));
  const roundRole = publishBrief || wrapUp || !ladderApplies(run) ? null : stepRole(step.name, step.id);
  const escalated = roundRole === "build" && repeatedOpen(run.findings).length > 0 ? escalationProfile(run, rounds.escalateProfile) : null;
  const profile = escalated ?? stepProfile;
  if (escalated) {
    recordActivity(parent.id, { kind: "step", tone: "info",
      text: `${step.name} runs on ${escalated.name} (${escalated.model ?? "default model"}) — ${repeatedOpen(run.findings).map(([id]) => id).join(", ")} came back after a fix` });
  }
  const lastReview = roundRole === "review" ? run.history.findLast((h) => h.stepId === step.id && h.handoff?.reviewApproval) : undefined;
  const reReview = !!lastReview && !!rounds.reviewEffort;

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
  const reservation=reserveRunner(childId,step.name,isTaskRunLive,parent.id);
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

  const stepChecks = publishBrief || wrapUp ? null : stepGateFor(parent, run, step);
  // What Agetor reads for the step at launch (`pipeline_gates`' `preload`):
  // the file map and the code it points at, the branch's diff, Review's
  // bundle. Never for the writer of an Agetor-run Finish or the wrap-up, and
  // never a reason for a launch to fail: unreadable means none.
  const preload = publishBrief || wrapUp || !gatePref("preload", parent, run) ? null
    : await stepPreload({ parent, graph: snapshot.graph, step, history: run.history, stepNumber: seq }).catch(() => null);
  if (preload?.bundlePath) handoffRefs.push({ path: preload.bundlePath, isDirectory: false });
  const composeArgs = {
    pipelineName: run.pipelineName,
    // The writer's turn of an Agetor-run Finish: the brief is its whole job.
    step: publishBrief ? { ...step, instructions: publishBrief } : step,
    stepIndex: seq,
    // The wrap-up execution is the one step past the cap.
    stepCap: Math.max(effectiveStepCap(run), seq),
    goal: parent.prompt,
    previous: previousWithFiles,
    outgoing,
    transition: step.transition,
    subagentProfiles,
    subagentCap: step.subagents.cap,
    parentHarnessKind: profile.harnessKind,
    parallelSiblings,
    // What the step will be judged by (`pipeline_gates`), so its agent knows.
    // Not the writer of an Agetor-run Finish or a wrap-up at the cap: neither
    // is gated when its turn ends.
    gate: stepChecks ? { goal: stepChecks.goal, checks: stepChecks.checks, issueUrl: parent.issueUrl } : null,
  };
  // M10: step tasks carry the parent's own references plus every handoff
  // file this launch just wrote.
  const references: TaskReference[] = [...(parent.references ?? []), ...handoffRefs];

  const syncNote = publishBrief ? null : await syncBaseNote(parent, step.name).catch(() => null);
  const roundsNote = roundRole ? await roundsSection(parent, run, roundRole, !!escalated, lastReview ?? null, runDir, seq).catch(() => null) : null;
  const manuallyRouted = previous.some((p) => run.history.some((h) => h.seq === p.seq && h.stepId === p.stepId && h.outcome === "advanced-manually"));
  const managedRoot=managedPillarRoot(parent.worktreePath??parent.workdir);
  const approvalNote=step.name==='Review'
    ? `Automatic sign-off requires explicit independent approval of this exact head and all issue acceptance. Map every acceptance criterion to checked evidence in your summary. In the handoff add "reviewApproval":{"verdict":"approved"|"changes-requested","headSha":"<full 40-character git rev-parse HEAD>","issueUrl":${JSON.stringify(parent.issueUrl??'')},"acceptanceComplete":true|false,"findings":[]}. Only use approved/true/empty findings when all required criteria are met and no finding remains. Otherwise record all findings, set changes-requested/false and choose Build. A succeeded/done review turn or Finish choice is not approval.`
    :step.name==='Finish'&&!publishBrief?`Publish only the exact independently approved head: do not merge, rebase or amend the branch in this step (GitHub CI already tests the pull request merged with its base). A change to reviewed code or a different head requires Build/Review again; passing verification alone is not independent approval.`:'';
  // The owner's notes for a run they reopened (`steerPipelineRun`): carried
  // by this step and the steps after it until each has finished once since.
  // Never by the writer of an Agetor-run Finish or the wrap-up, whose turn
  // must not change the head. A run with no note has no such section.
  const ownerNotes = publishBrief || wrapUp ? [] : applicableFeedback(
    readFeedback(parent.id, run), forwardPath(snapshot.graph, run.history) ?? [], run.history, step.id);
  // The runner's own sections. `composeStepPrompt` places them: what is the
  // same for every card first, this visit's own last (`pipeline_prompt_order`
  // = `legacy` puts them back where they were, around the pipeline's text).
  const extras: StepPromptExtras = {
    // A base branch that moved ahead gets merged in before this step verifies
    // (`pipeline_sync_base`, src/bun/sync-base.ts). Never for the writer of an
    // Agetor-run Finish: the head is published, and merging is the one thing
    // its turn must not do.
    syncNote,
    feedback: renderOwnerFeedback(ownerNotes, { stepId: step.id, nameOf: (id) => stepNameById(snapshot.graph, id) }),
    decisions: snapshot.decisionPolicy ? plannerDecisionInstructions(parent.id, snapshot.capturedAt, snapshot.decisionPolicy) : null,
    routing: [
      manuallyRouted
        ? "This step was explicitly selected by manual Advance. The preceding verdict and findings are preserved for you to address. This routing decision is not approval of the change and grants no additional permissions."
        : null,
      // Build left the head unchanged twice (src/shared/no-change-loop.ts).
      !wrapUp && run.noChangeLoop?.instructedAt != null && run.noChangeLoop.wrappedAt == null && stepRole(step.name, step.id) === "review" && ladderApplies(run)
        ? noChangeReviewNote(run.noChangeLoop.rounds)
        : null,
      roundsNote,
    ].filter(Boolean).join("\n\n") || null,
    machineCapacity: managedRoot ? `## Machine test capacity\n${HEAVY_INSTRUCTIONS}` : null,
    approvalNote: managedRoot ? approvalNote : null,
    // Last, so nothing after it reads as taking the wrap-up back.
    wrapUp: wrapUp ? capWrapUpSection({ stepCap: effectiveStepCap(run), issueUrl: parent.issueUrl, prUrl: parent.prUrl, closeout: run.capWrapUp?.closeout ?? null }) : null,
    inputNote: inputReconciliation.note ?? null,
  };
  const order = parseStepPromptOrder(preferences.get(STEP_PROMPT_ORDER_PREF));
  let composed = composeStepPrompt({ ...composeArgs, inlineHandoff: true, preload: preload?.inline, extras, order });
  // m12/D10: measure the SAME wrapping `startTaskInner` will actually launch
  // with — `composeLaunchPrompt` (the profile's instructions/skills
  // preamble) then `appendReferences` (the references block) — not the raw
  // step prompt on its own, since either wrapper can push a borderline
  // prompt over gemini's argv cap even when the unwrapped text doesn't.
  if (profile.harnessKind === "gemini") {
    const fullPrompt = appendReferences(composeLaunchPrompt(profile, composed), references);
    if (promptByteOverage("gemini", fullPrompt)) {
      // Nothing is inlined for a harness with a short prompt: not the
      // handoffs, and not what was pre-loaded — only where the files are.
      composed = composeStepPrompt({ ...composeArgs, inlineHandoff: false, preload: preload?.reference, extras, order });
    }
  }

  const now = Date.now();
  const effort = (reReview ? rounds.reviewEffort : null) ?? profile.effort ?? defaultEffortFor(profile.harnessKind, profile.model, profile.harness);
  // While the profile's harness is at a known usage limit, start on its
  // configured backup (quota-fallback.ts); otherwise this is the profile's.
  const fallback = fallbackForStep(profile.harness, profile, { excludeFamily: familyToExclude(run, step.id), now });
  const launch = fallback
    ? launchOnFallback(fallback, { model: profile.model, effort, mode: profile.mode })
    : { agent: profile.harness, model: profile.model, effort, mode: profile.mode };
  tasks.insert({
    id: childId,
    title: `${run.pipelineName} · ${step.name}`,
    prompt: composed,
    column: "ready",
    agent: launch.agent,
    workdir: parent.workdir,
    isolation: parent.isolation,
    taskType: parent.taskType,
    branch: parent.branch,
    branchSource: parent.branchSource,
    worktreePath: parent.worktreePath,
    baseRef: parent.baseRef,
    prUrl: null,
    issueUrl: null,
    mode: launch.mode,
    model: launch.model,
    effort: launch.effort,
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
  run.history.push({
    seq, stepId: step.id, taskId: childId, startedAt: now, endedAt: null, outcome: null, handoff: null, nextStepIds: [],
    // Launched under the gate, with the roster in its prompt: only such a
    // visit is judged by checks when its turn ends.
    ...(stepChecks ? { gate: { state: "working" as const, turns: 0, max: stepChecks.maxTurns, failed: [], at: now } } : {}),
  });
  // The agent execution an Agetor-run Finish visit ends in (`publishVisitOver`).
  if (run.publish && run.publish.stepId === step.id && (run.publish.state === "write" || run.publish.state === "agent") && run.publish.seq === undefined) {
    run.publish.seq = seq;
  }
  if (wrapUp && run.capWrapUp) run.capWrapUp.seq = seq;
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
    recordLaunchRefusal(parent.id, run, childId, step.id, started.error);
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
      recordLaunchRefusal(parent.id, run, inserted.taskId, step.id, `step "${step.name}" failed to launch: ${message}`);
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

/** Admission is a queue wait, not a failed execution or an owner question. */
function isCapacityRefusal(error: string): boolean {
  return /^(?:step "[^"]+" failed to launch: )?waiting for (?:a |a verification )slot\b|^runner reservation retains a detached command$/i.test(error);
}
function isDatabaseBusy(error: string): boolean {
  return /database (?:is )?locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error);
}
function recordLaunchRefusal(parentId: string, run: PipelineRunState, taskId: string, stepId: string, message: string): void {
  upsertBlocked(run, { taskId, stepId, kind: isCapacityRefusal(message) ? 'slot-wait' : 'step-failed', message });
  if (isDatabaseBusy(message) && run.snapshot?.decisionPolicy && !isTaskRunLive(taskId)) {
    scheduleLaunchRetry(parentId, run, taskId, stepId, 'could not acquire the database writer');
  }
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
  let queued = 0;
  for (const t of targets) {
    run.blocked = run.blocked.filter((b) => b.taskId !== t.taskId);
    adoptDeferredInstructions(run, t);
    const started = await startTask(t.taskId).catch((error:unknown)=>({error:error instanceof Error?error.message:String(error)}));
    if ("error" in started) {
      // L-R2: `startTask`'s own double-start guards ("task is already
      // starting" — a spawn claim still held, e.g. the bounded-pending
      // window; "task already running" — an `active` handle that landed
      // between our `isTaskRunLive` filter above and this call) mean the
      // execution IS live, not broken — treat exactly like the live-skip
      // above (no block, left alone) rather than recording a step-failed
      // block against a turn that's actually in flight.
      if (isStartTaskLiveRefusal(started.error)) continue;
      if (isCapacityRefusal(started.error)) queued++;
      recordLaunchRefusal(parent.id,run,t.taskId,t.stepId,started.error);
    } else {
      if (run.launchRetries) delete run.launchRetries[t.taskId];
      if (!first) first = { runId: started.runId, ...(started.pending ? { pending: true as const } : {}) };
    }
  }
  checkJoinIncomplete(run);
  persist(parent.id, run);
  // Queued is not failed: the step starts by itself when a place frees.
  return first ?? { error: queued > 0 ? "queued for a free slot — the step starts by itself" : "retry failed for every blocked step" };
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
  opts?: { restart?: boolean; fromScratch?: boolean; validate?:()=>Promise<string|null>; carry?: Pick<PipelineRunState, "capRestart"> },
): Promise<{ runId: string; pending?: true; resumed?: PipelineResume } | { error: string }> {
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
      // Check gates are captured like the decision policy: a run keeps the
      // loop it started with until an explicit refresh (`adoptPipelineGates`).
      if (reviewedPipelineShape(snapshot.graph) && publishGatePref(fresh, { pipelineName: pipeline.name })) snapshot.gates = { publish: true };
      if (gatePref("steps", fresh, { pipelineName: pipeline.name })) snapshot.gates = { ...snapshot.gates, steps: true };
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

    const firstStep = resolveStartStep(snapshot.graph);
    if (!firstStep) return { error: "pipeline has no resolvable start step" };
    // A restart of a gated run resumes at the first step whose gate is not
    // satisfied now, instead of repeating Understand and Build over work
    // that is still in the worktree (`readPosition`; Stage 3 of
    // docs/plans/check-gated-pipeline.md). From the beginning stays one
    // explicit flag away (`fromScratch`), and is what an ungated run, a run
    // with no history, or a position on the start step gets — unchanged.
    let resume: { step: PipelineStep; position: Extract<Position, { kind: "step" }> } | null = null;
    if (opts?.restart && !opts.fromScratch && run.snapshot && run.history.length > 0 && gatedNow(fresh, snapshot, pipeline?.name ?? run.pipelineName)) {
      const position = await readPosition({ parent: fresh, run, snapshot, publishOn: publishGatePref(fresh, { pipelineName: pipeline?.name ?? run.pipelineName }) });
      if (position.kind === "complete") {
        return { error: `${positionLine(position, (id) => stepNameById(snapshot.graph, id))} — rewind to a step to redo it, or restart from the beginning` };
      }
      const step = position.kind === "step" ? snapshot.graph.steps.find((s) => s.id === position.stepId) : undefined;
      if (position.kind === "step" && step && step.id !== firstStep.id) resume = { step, position };
    }
    const startStep = resume?.step ?? firstStep;
    // Book global ownership before awaited preparation, for manual/API
    // starts as well as Autopilot. The first child atomically takes over.
    const booking=reserveRunner(fresh.id,startStep.name,isTaskRunLive,fresh.id);
    if('error'in booking) {
      // A fresh manual/API start queues without preparing a worktree or
      // starting an agent. Existing/restarted executions retain their state.
      if(!opts?.restart&&run.history.length===0&&run.active.length===0) {
        run={pipelineId:fresh.pipelineId,pipelineName:pipeline?.name??run.pipelineName,snapshot,status:'running',active:[],joins:{},blocked:[{taskId:null,stepId:startStep.id,kind:'slot-wait',message:`${startStep.name} is ${booking.error}`,pending:{stepId:startStep.id,arrivals:[]}}],history:[],stepCount:0,startedAt:Date.now(),endedAt:null};
        persist(fresh.id,run,{preserveStatus:true});return {runId:'',pending:true as const};
      }
      return booking;
    }
    try {

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
    if (resume) {
      // Resumed: the run, its history and its ledger are kept. Only what
      // was still under way is stopped, and the run is reopened at the
      // position with the handoff of the step before it.
      const stopped = await retireActiveExecutions(fresh.id, run, "pipeline restarted");
      reopenRunState(run, snapshot, forwardPath(snapshot.graph, run.history) ?? [], resume.step.id);
      run.pipelineName = pipeline?.name ?? run.pipelineName;
      const names = (ids: string[]) => ids.map((id) => stepNameById(snapshot.graph, id)).join(", ");
      recordActivity(fresh.id, {
        kind: "step", tone: "info",
        text: `Restarted. ${positionLine(resume.position, (id) => stepNameById(snapshot.graph, id))}.` +
          (stopped.length > 0 ? ` Stopped: ${names(stopped)}.` : "") + " History is kept; a restart from the beginning is a separate, explicit choice.",
      });
      persist(parentRow.id, run, { preserveStatus: true });
      parentRow = tasks.get(parentRow.id) ?? parentRow;
      const result = await launchTarget(parentRow, run, resume.step, resume.position.arrivals, { skipWorktreeRefresh: true });
      checkJoinIncomplete(run);
      persist(parentRow.id, run);
      const resumed: PipelineResume = {
        stepId: resume.step.id, stepName: resume.step.name, why: resume.position.why,
        kept: resume.position.satisfied.map((k) => ({ stepId: k.stepId, stepName: stepNameById(snapshot.graph, k.stepId) })),
      };
      if (!result.ok) {
        // Queued for a slot, or held for Agetor to run (Finish): under way.
        if (run.blocked.some((b) => b.stepId === resume!.step.id && (b.kind === "slot-wait" || b.kind === "await"))) return { runId: "", pending: true as const, resumed };
        return { error: `pipeline could not resume at ${resume.step.name} — see the run's blocked step for details` };
      }
      return { runId: result.runId, ...(result.pending ? { pending: true as const } : {}), resumed };
    }
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
      // The ladder's restart from the base (`restart-from-base`) is once per
      // card run: the restarted run carries the record.
      ...(opts?.carry?.capRestart ? { capRestart: opts.carry.capRestart } : {}),
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
    }finally{releaseUnspawnedRunner(fresh.id);}
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
            b.kind === "check-failed" ||
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

    // Advancing past a gate the step did not pass is a waiver, and is
    // recorded as one: a waived check never reads as a pass.
    const waivedStep = graph.steps.find((s) => s.id === activeEntry.stepId);
    const waivedGate = waivedStep && run.blocked.some((b) => b.taskId === targetTaskId && b.kind === "check-failed") ? stepGate(run.snapshot, waivedStep, run.history) : null;
    if (waivedStep && waivedGate && historyEntry?.gate?.failed.length) {
      recordWaivedChecks({ parent, run, step: waivedStep, seq: activeEntry.seq, checks: waivedGate.checks, ids: historyEntry.gate.failed });
      recordActivity(parentId, { kind: "step", tone: "warning", text: `Advanced past ${waivedStep.name}'s failing checks (${historyEntry.gate.failed.join(", ")}) — recorded as waived` });
    }

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

/** The generated `## Your step` section of a step prompt, as
 *  `composeStepPrompt` writes it for `instructions`. */
function stepSection(instructions: string): string {
  return `\n\n## Your step\n\n${instructions.trim() ? instructions : "(no additional instructions)"}\n\n`;
}

/** `prompt` with its `## Your step` section swapped from `before` to `after`,
 *  or null when that section is not there exactly once — a hand-edited or
 *  ambiguous prompt is left for its owner rather than guessed at. */
function withStepInstructions(prompt: string, before: string, after: string): string | null {
  const needle = stepSection(before);
  const at = prompt.indexOf(needle);
  if (at < 0 || at !== prompt.lastIndexOf(needle)) return null;
  return prompt.replace(needle, () => stepSection(after));
}

/** A Retry re-launches the execution's existing prompt. If an instruction
 *  refresh left that prompt alone because the step was live, bring it up to
 *  the snapshot's text now. The caller persists `run`. */
function adoptDeferredInstructions(run: PipelineRunState, active: PipelineActiveStep): void {
  const stale = active.staleInstructions;
  if (stale === undefined) return;
  delete active.staleInstructions;
  const step = run.snapshot?.graph.steps.find((s) => s.id === active.stepId);
  const child = tasks.get(active.taskId);
  if (!step || !child || stale === step.instructions) return;
  const prompt = withStepInstructions(child.prompt, stale, step.instructions);
  if (prompt !== null) tasks.update(child.id, { prompt });
}

/** What an instruction refresh did to one run: `stepIds` changed in the
 *  snapshot, `unmatched` are the run's steps the template no longer has, and
 *  `skippedPrompts` are the step TASK ids whose stopped prompt could not be
 *  rewritten (see {@link refreshPipelineInstructions}). */
export interface PipelineInstructionRefresh {
  stepIds: string[];
  unmatched: string[];
  skippedPrompts: string[];
}

/** Adopt a template's instruction edits without restarting the run, in any
 * state: the snapshot takes the template's text for every step both have, so
 * every later launch uses it. No agent is launched or interrupted, no
 * verdict, hold, wait or count is touched, and topology/profiles/caps stay
 * the run's own. A step task that is not executing has its generated
 * `## Your step` section rewritten so its Retry runs the new text; a live
 * one keeps its prompt (the agent already has it) and is rewritten at its
 * next Retry. Only what cannot be done is refused: no pipeline, archived, no
 * snapshot, no or invalid template — and a revision the caller named that no
 * longer matches. A hand-edited step prompt is skipped and reported. */
export async function refreshPipelineInstructions(
  parentId: string,
  opts?: { expectedCapturedAt?: number; expectedTemplateUpdatedAt?: number },
): Promise<({ task: Task } & PipelineInstructionRefresh) | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent?.pipelineId || tombstonedPipelineParents.has(parentId)) {
      return { error: "not a pipeline task", status: 404 as const };
    }
    if (parent.archivedAt != null) {
      return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
    }
    const run = parent.pipelineRun;
    if (!run?.snapshot) {
      return { error: "pipeline has never run — it takes the template's instructions when it starts", status: 409 as const };
    }
    const template = pipelines.get(parent.pipelineId);
    if (!template) return { error: "pipeline template no longer exists", status: 404 as const };
    // Optimistic concurrency for a caller that showed someone a diff first;
    // a caller that names no revision just applies the template as it is.
    if ((opts?.expectedCapturedAt !== undefined && run.snapshot.capturedAt !== opts.expectedCapturedAt) ||
        (opts?.expectedTemplateUpdatedAt !== undefined && template.updatedAt !== opts.expectedTemplateUpdatedAt)) {
      return { error: "run or template changed — inspect the current instructions before refreshing", status: 409 as const };
    }
    const validated = validatePipelineGraph(template.graph);
    if (!validated.ok) return { error: `pipeline graph is invalid: ${validated.error}`, status: 400 as const };
    const updated = updatedPipelineInstructions(run.snapshot.graph, validated.graph);
    if (updated.stepIds.length === 0) return { task: parent, stepIds: [], unmatched: updated.unmatched, skippedPrompts: [] };

    // A retry re-launches the existing step task's prompt, so refresh its
    // generated instruction section too, preserving its goal/reports. A live
    // execution's prompt is already with the agent: remember the text it
    // carries and leave it until that execution is next launched.
    const promptUpdates: { taskId: string; prompt: string }[] = [];
    const skippedPrompts: string[] = [];
    const liveStepIds = new Set<string>();
    const active = run.active.map((a): PipelineActiveStep => {
      const { staleInstructions, ...entry } = a;
      const after = updated.graph.steps.find((s) => s.id === a.stepId);
      const carried = staleInstructions ?? run.snapshot!.graph.steps.find((s) => s.id === a.stepId)?.instructions;
      if (!after || carried === undefined || carried === after.instructions) return entry;
      if (isTaskRunLive(a.taskId) || isTaskRunCancelling(a.taskId) || remindersInFlight.has(a.taskId)) {
        liveStepIds.add(a.stepId);
        return { ...entry, staleInstructions: carried };
      }
      const child = tasks.get(a.taskId);
      const prompt = child ? withStepInstructions(child.prompt, carried, after.instructions) : null;
      if (prompt !== null) promptUpdates.push({ taskId: a.taskId, prompt });
      else if (child) skippedPrompts.push(a.taskId);
      return entry;
    });
    const now = Math.max(Date.now(), run.snapshot.capturedAt + 1);
    const auditPath = join(pipelineRunsDir(parentId), `instruction-update-${randomUUID()}.json`);
    mkdirSync(pipelineRunsDir(parentId), { recursive: true });
    writeFileSync(auditPath, JSON.stringify({
      updatedAt: now, templateUpdatedAt: template.updatedAt, previousCapturedAt: run.snapshot.capturedAt,
      steps: updated.stepIds.map((id) => ({ id,
        before: run.snapshot!.graph.steps.find((s) => s.id === id)!.instructions,
        after: updated.graph.steps.find((s) => s.id === id)!.instructions,
      })),
      unmatched: updated.unmatched, liveStepIds: [...liveStepIds], skippedPrompts,
    }, null, 2));
    const snapshot = { ...run.snapshot, graph: updated.graph, capturedAt: now };
    db.transaction(() => {
      for (const update of promptUpdates) tasks.update(update.taskId, { prompt: update.prompt });
      tasks.setPipelineRun(parentId, { ...run, active, snapshot });
    })();
    const names = (ids: Iterable<string>) => [...ids].map((id) => stepNameById(updated.graph, id)).join(", ");
    recordActivity(parentId, { kind: "auto", tone: "info",
      text: `Updated instructions from template for ${names(updated.stepIds)}; history and holds preserved.` +
        (liveStepIds.size > 0 ? ` Still running on the earlier text, picking the new one up at the next launch: ${names(liveStepIds)}.` : "") +
        (skippedPrompts.length > 0 ? ` ${skippedPrompts.length} stopped step prompt(s) were edited by hand and kept as they are.` : "") +
        (updated.unmatched.length > 0 ? ` Not in the template, left unchanged: ${names(updated.unmatched)}.` : "") +
        ` Audit: ${auditPath}` });
    publishGlobalEvent({ kind: "pipeline", taskId: parentId, status: run.status,
      activeStepIds: run.active.map((a) => a.stepId), stepCount: run.stepCount, ts: now });
    return { task: tasks.get(parentId)!, stepIds: updated.stepIds, unmatched: updated.unmatched, skippedPrompts };
  });
}

/** One run's outcome in {@link refreshPipelineRuns}. */
export interface PipelineRunRefreshResult extends PipelineInstructionRefresh {
  taskId: string;
  error?: string;
  /** Only when the refresh asked for gates (`adoptPipelineGates`). */
  gates?: PipelineGateAdoption | { error: string };
  /** Only when the refresh asked for gates and the run has them: where the
   *  run stands now — the step a restart would resume at and what it would
   *  keep (`positionLine`). The refresh itself launches nothing. */
  position?: string;
}

/** Push a template's current instructions into every unarchived, unfinished
 * run of it (running, blocked or cancelled) — a never-started card snapshots
 * the template when it starts and a finished one has nothing left to launch.
 * Each run is refreshed under its own lock, side by side, so a run busy
 * launching a step delays only itself; one run's failure is that run's
 * `error` and never the others'. */
export async function refreshPipelineRuns(pipelineId: string, opts?: { gates?: boolean }): Promise<PipelineRunRefreshResult[]> {
  // `gates`: also adopt check gates from `pipeline_gates` as it stands now —
  // the explicit request a started run needs before its loop changes. A
  // finished run is included for that alone (a fix round re-enters it).
  const targets = tasks.list({ archived: "none" }).filter((t) => t.pipelineId === pipelineId && !isPipelineStepTask(t) &&
    t.pipelineRun?.snapshot != null &&
    (t.pipelineRun.status === "running" || t.pipelineRun.status === "blocked" || t.pipelineRun.status === "cancelled" ||
      (opts?.gates === true && t.pipelineRun.status === "done")));
  return Promise.all(targets.map(async (t): Promise<PipelineRunRefreshResult> => {
    const failed = (error: string) => {
      recordActivity(t.id, { kind: "auto", tone: "warning", text: `Could not update instructions from template: ${error}` });
      return { taskId: t.id, stepIds: [], unmatched: [], skippedPrompts: [], error };
    };
    try {
      let gates: PipelineRunRefreshResult["gates"];
      if (opts?.gates) {
        const adopted = await adoptPipelineGates(t.id);
        gates = "error" in adopted ? { error: adopted.error } : adopted;
        const at = await pipelinePosition(t.id).catch(() => null);
        const position = at && !("error" in at) && at.line ? { position: at.line } : {};
        if (t.pipelineRun?.status === "done") return { taskId: t.id, stepIds: [], unmatched: [], skippedPrompts: [], gates, ...position };
        const result = await refreshPipelineInstructions(t.id);
        if ("error" in result) return { ...failed(result.error), gates, ...position };
        return { taskId: t.id, stepIds: result.stepIds, unmatched: result.unmatched, skippedPrompts: result.skippedPrompts, gates, ...position };
      }
      const result = await refreshPipelineInstructions(t.id);
      if ("error" in result) return failed(result.error);
      return { taskId: t.id, stepIds: result.stepIds, unmatched: result.unmatched, skippedPrompts: result.skippedPrompts };
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
  }));
}

// Adoptions started by a template edit and not yet finished.
const adoptionsInFlight = new Set<Promise<unknown>>();

/** Start {@link refreshPipelineRuns} for an edited template and return at
 * once: the edit's response must not wait behind a run that holds its lock
 * while a step launches. */
export function adoptPipelineInstructions(pipelineId: string): void {
  const adoption = refreshPipelineRuns(pipelineId).catch((e: unknown) => {
    console.warn(`[agetor] pipeline ${pipelineId}: adopting edited instructions failed:`, e);
  });
  adoptionsInFlight.add(adoption);
  void adoption.finally(() => adoptionsInFlight.delete(adoption));
}

/** Resolves once every adoption started so far has finished. */
export async function pipelineAdoptionsSettled(): Promise<void> {
  while (adoptionsInFlight.size > 0) await Promise.all(adoptionsInFlight);
}

/** Retry currently blocked executions and pending launches. Never starts a
 * duplicate of a live step; requires a blocked or cancelled run. */
export async function retryPipelineStep(
  parentId: string,
  opts?: { taskId?: string; checksFirst?: boolean },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  let followUps: SettleFollowUp[] = [];
  const result = await runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;
    if (run.status !== "blocked" && run.status !== "cancelled") {
      return { error: "pipeline is not blocked or cancelled", status: 409 as const };
    }
    // The owner's Retry of a step stopped on its checks: the checks are run
    // first, and the step gets a turn only if one still fails.
    if (opts?.checksFirst) {
      const rechecked = await recheckStoppedGates(parent, run, opts.taskId);
      if (rechecked) {
        followUps = rechecked;
        return { task: tasks.get(parentId)! };
      }
    }
    const result = await performPipelineRetry(parent, run, opts?.taskId);
    if ("error" in result) return { error: result.error, status: 409 as const };
    return { task: tasks.get(parentId)! };
  });
  // The checks run with the lock released, as at any turn's end.
  for (const f of followUps) await afterSettle(f);
  return followUps.length > 0 && !("error" in result) ? { task: tasks.get(parentId) ?? result.task } : result;
}

/**
 * The owner's Retry on a gated run (design §7): for every step that stopped
 * with `check-failed`, judge the turn it ended on again by checks run NOW
 * — the same settle that judged it the first time. They pass (the owner
 * fixed the worktree, GitHub answers again): the run moves on with what the
 * step handed off, and no turn is spent. One still fails: the step gets a
 * check-feedback turn with the output, under a new allowance. Returns null
 * — the ordinary retry applies — when the run is stopped on anything else,
 * the stopped visit was not launched under the gate, or the card has since
 * been taken out of `pipeline_gates`.
 */
async function recheckStoppedGates(parent: Task, run: PipelineRunState, onlyTaskId?: string): Promise<SettleFollowUp[] | null> {
  if (tombstonedPipelineParents.has(parent.id) || parent.archivedAt != null || !run.snapshot) return null;
  const stops = run.blocked.filter((b) => b.kind === "check-failed" && b.taskId && (!onlyTaskId || b.taskId === onlyTaskId));
  if (stops.length === 0 || (!onlyTaskId && stops.length !== run.blocked.length)) return null;
  const targets: { taskId: string; runId: string }[] = [];
  for (const b of stops) {
    const active = run.active.find((a) => a.taskId === b.taskId);
    const record = active && run.history.find((h) => h.taskId === active.taskId && h.seq === active.seq);
    const step = active && run.snapshot.graph.steps.find((s) => s.id === active.stepId);
    const runId = active ? tasks.get(active.taskId)?.runId : null;
    if (!active || !record?.gate || !step || !runId || isTaskRunLive(active.taskId) || !stepGateFor(parent, run, step)) return null;
    targets.push({ taskId: active.taskId, runId });
  }
  run.blocked = run.blocked.filter((b) => !(b.kind === "check-failed" && targets.some((t) => t.taskId === b.taskId)));
  recordActivity(parent.id, { kind: "step", tone: "info", text: "Retry: running the stopped step's checks again before giving it a turn" });
  persist(parent.id, run);
  const out: SettleFollowUp[] = [];
  for (const t of targets) {
    const follow = await settleStepRun(parent.id, t.taskId, t.runId, "succeeded");
    if (follow) out.push(follow);
  }
  return out;
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

/** How many executions one rework round needs room for: Build, Review, Finish. */
const REWORK_ROUND_STEPS = 3;

/**
 * Send a FINISHED run back through one of its own steps: a problem found
 * after the pipeline ended (the merge queue saw CI fail, or the PR conflict
 * with its base) re-enters the run at Build, so the fix is reviewed and
 * published by Finish like any other change — where a follow-up
 * (`runPipelineFollowUp`) would append a one-off step that pushes unreviewed.
 *
 * `stepId` is a step of the run's frozen graph; nothing is added to the
 * snapshot, so the step runs on the prompts and agents the run started with
 * and its outgoing edges carry the run on (Build → Review → Finish). The
 * step is handed `handoff` as if `fromStepId` had just sent it — exactly how
 * Finish's own "verification failed" reaches Build. That arrival carries
 * `seq: 0`, which no execution has: it names no history record, so no step's
 * final report is attached to it (Finish's last report said the opposite),
 * and it survives a queued launch (`pending.arrivals`) unchanged.
 *
 * Only a `done` run is re-entered: a blocked or running one is still the
 * pipeline's own to finish. The step cap is raised just enough for one round
 * (as a follow-up raises it for its one step); the caller bounds how many
 * rounds a card gets. Returns the task; whether the run actually left `done`
 * is the caller's to read from it (a launch queued for a slot has).
 */
export async function reworkPipelineRun(
  parentId: string,
  input: { stepId: string; fromStepId: string; handoff: Handoff },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (tombstonedPipelineParents.has(parentId)) return { error: "pipeline task no longer exists", status: 404 as const };
    if (parent.archivedAt != null) return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
    const run = parent.pipelineRun;
    if (!run || !run.snapshot) return { error: "pipeline has never run", status: 409 as const };
    if (run.status !== "done" || run.active.length > 0 || run.blocked.length > 0) {
      return { error: "a run is sent back through its steps only once it has finished", status: 409 as const };
    }
    const graph = run.snapshot.graph;
    const step = graph.steps.find((s) => s.id === input.stepId);
    if (!step) return { error: `unknown step id "${input.stepId}"`, status: 400 as const };
    if (!graph.steps.some((s) => s.id === input.fromStepId)) return { error: `unknown step id "${input.fromStepId}"`, status: 400 as const };

    const ext = Math.max(0, Math.trunc(run.capExtensions ?? 0));
    if (run.stepCount + REWORK_ROUND_STEPS > effectiveStepCap(run)) {
      run.snapshot = { ...run.snapshot, maxSteps: Math.ceil((run.stepCount + REWORK_ROUND_STEPS) / (1 + ext)) };
    }
    const launched = await launchTarget(parent, run, step, [{ stepId: input.fromStepId, seq: 0, handoff: normalizeHandoff(input.handoff) }]);
    persist(parentId, run);
    if (!launched.ok && run.active.every((a) => a.stepId !== step.id)) {
      const block = run.blocked.find((b) => b.stepId === step.id);
      // Queued for a slot: it starts by itself — not an error.
      if (block?.kind !== "slot-wait") {
        return { error: block?.message ?? `${step.name} could not start`, status: 409 as const };
      }
    }
    return { task: tasks.get(parentId)! };
  });
}

// ---------------------------------------------------------------------------
// Position, rewind and feedback (Stage 3 of docs/plans/check-gated-pipeline.md;
// the walk is src/shared/position.ts, the reads are src/bun/position.ts)
// ---------------------------------------------------------------------------

/** Whether a run with this snapshot is gated for the card now: it adopted a
 *  gate and `pipeline_gates` still names the card. Position, rewind and
 *  feedback are for such runs only; every other run behaves as it did. */
function gatedNow(parent: Pick<Task, "id" | "pipelineId">, snapshot: Pick<PipelineRunSnapshot, "gates">, pipelineName: string): boolean {
  return (snapshot.gates?.steps === true && gatePref("steps", parent, { pipelineName })) ||
    (snapshot.gates?.publish === true && publishGatePref(parent, { pipelineName }));
}

/**
 * Stop and retire every execution still under way, for a run that is about
 * to be reopened at another step: its pending questions are cancelled, its
 * session is stopped and its step row archived (the path a restart takes for
 * the rows it replaces), and its record ends as `cancelled`. The records
 * stay in the history. Returns the step ids stopped. The caller persists.
 */
async function retireActiveExecutions(parentId: string, run: PipelineRunState, why: string): Promise<string[]> {
  const stopped: string[] = [];
  const retired = [...run.active];
  // Out of `active` first: a settle that the stop sets off must find nothing
  // of this execution left to decide.
  run.active = [];
  for (const a of retired) {
    stopped.push(a.stepId);
    const record = run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq);
    if (record && record.outcome === null) {
      record.endedAt = Date.now();
      freezeStepReport(record);
      record.outcome = "cancelled";
    }
    checksInFlight.delete(a.taskId);
    deferredSettles.delete(a.taskId);
    cancelPendingForTask(a.taskId, why);
    const archived = await archiveTask(a.taskId, { force: true, stopRun: true, fromPipeline: true });
    if ("error" in archived) console.warn(`[agetor] pipeline ${parentId}: failed to retire step task ${a.taskId}:`, archived.error);
  }
  return [...new Set(stopped)];
}

/**
 * Put a run back to "about to launch `stepId`": nothing active, blocked,
 * waiting or scheduled; no held Agetor-run Finish (it verifies the head
 * again from the start); the wrap-up mark cleared; and room under the step
 * cap for the steps from `stepId` to the end of the path — raised just
 * enough, as a fix round and a follow-up raise it, because the owner asked
 * for these steps. History, step count and generation are untouched.
 */
function reopenRunState(run: PipelineRunState, snapshot: PipelineRunSnapshot, path: readonly PipelineStep[], stepId: string): void {
  run.active = [];
  run.blocked = [];
  run.joins = {};
  delete run.wait;
  delete run.autoRetry;
  delete run.launchRetries;
  delete run.capWrapUp;
  delete run.publish;
  // A person reopened the run: the no-owner-holds ladder starts over.
  delete run.ladder;
  delete run.noChangeLoop;
  run.snapshot = snapshot;
  run.status = "running";
  run.endedAt = null;
  const needed = Math.max(1, stepsFrom(path, stepId).length);
  const ext = Math.max(0, Math.trunc(run.capExtensions ?? 0));
  if (run.stepCount + needed > effectiveStepCap(run)) {
    run.snapshot = { ...snapshot, maxSteps: Math.ceil((run.stepCount + needed) / (1 + ext)) };
  }
}

/** Commits on the card's branch that the remote does not have, as this
 *  machine last fetched it (nothing is fetched): a rewind leaves them where
 *  they are, and says so. */
async function unpushedCommits(parent: Task): Promise<{ count: number | null; head: string | null; remoteHead: string | null }> {
  const checkout = parent.worktreePath ?? parent.workdir;
  const git = async (args: string[]) => {
    const r = await runCommand(["git", ...args], checkout, 30_000, process.env).catch(() => null);
    return r && r.ok ? r.stdout.trim() : null;
  };
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  const remoteHead = parent.branch ? await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${parent.branch}`]) : null;
  // Never published: everything the base (as last fetched) does not have.
  const base = remoteHead ? null : await prBase(checkout).catch(() => null);
  const baseTip = base ? await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]) : null;
  const since = remoteHead ?? baseTip ?? parent.baseRef ?? null;
  const n = head && since ? await git(["rev-list", "--count", `${since}..HEAD`]) : null;
  return { count: n !== null && /^\d+$/.test(n) ? Number(n) : null, head, remoteHead };
}

/** Read where a gated run stands (`GET /tasks/:id/pipeline/position`).
 *  Judged with the run's own snapshot; a restart judges with the template as
 *  it then is. Starts nothing and writes nothing. */
export async function pipelinePosition(parentId: string): Promise<PipelinePositionView | { error: string; status: 404 | 409 }> {
  const parent = tasks.get(parentId);
  if (!parent?.pipelineId || tombstonedPipelineParents.has(parentId)) return { error: "not a pipeline task", status: 404 as const };
  const run = parent.pipelineRun;
  if (!run?.snapshot) return { error: "pipeline has never run", status: 409 as const };
  const snapshot = run.snapshot;
  if (!gatedNow(parent, snapshot, run.pipelineName)) return { gated: false, position: null, line: null, steps: [] };
  const position = await readPosition({ parent, run, snapshot, publishOn: publishGatePref(parent, run) });
  const path = forwardPath(snapshot.graph, run.history) ?? [];
  const done = (id: string) => run.history.some((h) => h.stepId === id && (h.outcome === "succeeded" || h.outcome === "advanced-manually") && h.handoff);
  return {
    gated: true, position, line: positionLine(position, (id) => stepNameById(snapshot.graph, id)),
    // A step can be reopened when the step before it has finished once.
    steps: path.map((s, i) => ({ id: s.id, name: s.name, reached: i === 0 || done(path[i - 1]!.id) })),
  };
}

type ReopenTarget = { parent: Task; run: PipelineRunState; snapshot: PipelineRunSnapshot; step: PipelineStep; path: PipelineStep[]; arrivals: { stepId: string; seq: number; handoff: Handoff | null }[] };

/** The checks every reopen makes, and what the reopened step is handed: the
 *  newest finished visit of the step before it on the path. */
function reopenTarget(parentId: string, stepId: unknown, what: string): ReopenTarget | { error: string; status: 400 | 404 | 409 } {
  const parent = tasks.get(parentId);
  if (!parent?.pipelineId || tombstonedPipelineParents.has(parentId)) return { error: "not a pipeline task", status: 404 as const };
  if (parent.archivedAt != null) return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
  const run = parent.pipelineRun;
  if (!run?.snapshot) return { error: "pipeline has never run", status: 409 as const };
  const snapshot = run.snapshot;
  if (!gatedNow(parent, snapshot, run.pipelineName)) {
    return { error: `${what} is for a run with check gates (pipeline_gates), and this card's run has none — use Retry, Advance or Restart`, status: 409 as const };
  }
  if (typeof stepId !== "string" || !stepId.trim()) return { error: "stepId (a step of the run) is required", status: 400 as const };
  const step = snapshot.graph.steps.find((s) => s.id === stepId);
  if (!step) return { error: `unknown step id "${stepId}"`, status: 400 as const };
  const path = forwardPath(snapshot.graph, run.history);
  if (!path) return { error: "this pipeline is not one path with loops (a step fans out or joins): its position is not defined", status: 409 as const };
  const at = path.findIndex((s) => s.id === step.id);
  if (at === -1) return { error: `${step.name} is not on this run's path (${path.map((s) => s.name).join(" → ")})`, status: 400 as const };
  const arrivals: ReopenTarget["arrivals"] = [];
  if (at > 0) {
    const before = path[at - 1]!;
    const sender = run.history.filter((h) => h.stepId === before.id && (h.outcome === "succeeded" || h.outcome === "advanced-manually") && h.handoff).sort((a, b) => b.seq - a.seq)[0];
    if (!sender) return { error: `${step.name} has not been reached in this run: ${before.name} has no finished visit to hand it`, status: 409 as const };
    arrivals.push({ stepId: before.id, seq: sender.seq, handoff: sender.handoff });
  }
  return { parent, run, snapshot, step, path, arrivals };
}

/** Stop what is under way and launch `t.step`. The caller holds the lock.
 *  `record` writes what the reopen is on record for (void lines, a note)
 *  once the worktree is known to be usable and before anything is stopped:
 *  when it throws, nothing has changed. */
async function reopenRunAt(t: ReopenTarget, why: string, record: () => void): Promise<{ stopped: string[] } | { error: string; status: 409 }> {
  const prepared = await refreshParentWorktree(t.parent, t.run);
  if ("error" in prepared) return { error: `could not prepare the pipeline's worktree, so nothing was changed: ${prepared.error}`, status: 409 as const };
  try {
    record();
  } catch (e) {
    return { error: `it could not be recorded beside the run, so nothing was changed: ${e instanceof Error ? e.message : String(e)}`, status: 409 as const };
  }
  const stopped = await retireActiveExecutions(t.parent.id, t.run, why);
  reopenRunState(t.run, t.snapshot, t.path, t.step.id);
  persist(t.parent.id, t.run, { preserveStatus: true });
  await launchTarget(tasks.get(t.parent.id) ?? prepared.parent, t.run, t.step, t.arrivals, { skipWorktreeRefresh: true });
  checkJoinIncomplete(t.run);
  persist(t.parent.id, t.run);
  return { stopped: stopped.map((id) => stepNameById(t.snapshot.graph, id)) };
}

/**
 * Rewind a gated run to `stepId` (`POST /tasks/:id/pipeline/rewind`): the
 * gate evidence of that step and of every step after it is voided in the
 * ledger (lines appended; nothing is deleted), a Finish that Agetor is
 * holding is dropped, whatever is running is stopped, and the step is
 * launched with the handoff of the step before it. The history is kept.
 * Git is not touched: no reset, no branch change, nothing on the remote —
 * the commits stay, and `unpushed` says how many the remote does not have.
 */
export async function rewindPipelineRun(parentId: string, input: { stepId: unknown }): Promise<PipelineReopenResult | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const t = reopenTarget(parentId, input.stepId, "Rewind");
    if ("error" in t) return t;
    let voided: PipelineStep[] = [];
    const reopened = await reopenRunAt(t, "pipeline rewound", () => {
      voided = voidStepEvidence({ parent: t.parent, run: t.run, snapshot: t.snapshot, fromStepId: t.step.id, why: `rewound to ${t.step.name} by the owner` });
    });
    if ("error" in reopened) return reopened;
    const unpushed = await unpushedCommits(t.parent);
    recordActivity(parentId, {
      kind: "step", tone: "warning",
      text: `Rewound to ${t.step.name}: the results of ${voided.map((s) => s.name).join(", ")} are void and each runs again.` +
        (reopened.stopped.length > 0 ? ` Stopped: ${reopened.stopped.join(", ")}.` : "") +
        ` History is kept and git is untouched${unpushed.count ? ` (${unpushed.count} commit${unpushed.count === 1 ? "" : "s"} not on the remote stay where they are)` : ""}.`,
    });
    return { task: tasks.get(parentId)!, stepId: t.step.id, stepName: t.step.name, voided: voided.map((s) => s.name), stopped: reopened.stopped, unpushed };
  });
}

/**
 * Steer a gated run with the owner's feedback (`POST
 * /tasks/:id/pipeline/feedback`): the note is recorded beside the run, the
 * run is reopened from `fromStepId`, and that step's next prompt carries the
 * note — as does each later step's, until it has finished once since
 * (`applicableFeedback`). With `invalidate` the evidence of those steps is
 * voided as a rewind voids it. Without it nothing is voided: the steps run
 * once more as a refinement of work whose results stand. Git is not touched.
 */
export async function steerPipelineRun(
  parentId: string,
  input: { fromStepId: unknown; note: unknown; invalidate?: unknown },
): Promise<PipelineSteerResult | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const note = validateFeedbackNote(input.note);
    if (!note.ok) return { error: note.error, status: 400 as const };
    if (input.invalidate !== undefined && typeof input.invalidate !== "boolean") return { error: "invalidate must be true or false when given", status: 400 as const };
    const invalidate = input.invalidate === true;
    const t = reopenTarget(parentId, input.fromStepId, "Feedback to a step");
    if ("error" in t) return t;
    let voided: PipelineStep[] = [];
    let feedbackId = "";
    const reopened = await reopenRunAt(t, "pipeline reopened with feedback", () => {
      // The void lines first: a note without them is still a valid refinement.
      if (invalidate) voided = voidStepEvidence({ parent: t.parent, run: t.run, snapshot: t.snapshot, fromStepId: t.step.id, why: `voided with the owner's feedback to ${t.step.name}` });
      feedbackId = appendFeedback(parentId, t.run, { fromStepId: t.step.id, note: note.note, invalidate }).id;
    });
    if ("error" in reopened) return reopened;
    const unpushed = await unpushedCommits(t.parent);
    const later = stepsFrom(t.path, t.step.id).slice(1).map((s) => s.name);
    recordActivity(parentId, {
      kind: "step", tone: "warning",
      text: `Feedback sent to ${t.step.name}${later.length > 0 ? ` (and passed on to ${later.join(", ")})` : ""}: ${note.note.replace(/\s+/g, " ").slice(0, 200)}${note.note.length > 200 ? "…" : ""} — ` +
        (invalidate ? `the results of ${voided.map((s) => s.name).join(", ")} are void and each runs again.` : "a refinement: earlier results stand, and each of those steps runs once more.") +
        (reopened.stopped.length > 0 ? ` Stopped: ${reopened.stopped.join(", ")}.` : ""),
    });
    return {
      task: tasks.get(parentId)!, stepId: t.step.id, stepName: t.step.name, voided: voided.map((s) => s.name), stopped: reopened.stopped, unpushed,
      feedbackId, invalidated: invalidate,
    };
  });
}

/**
 * Stop every currently-running active execution (D9: "Stop on the parent
 * cancels every active execution and returns the parent to ready … active
 * set kept so Run retries them"). 409 when nothing is actually live
 * (M5 — `isTaskRunLive`, not `column`).
 */
/**
 * A card whose pull request was merged while its run was parked (blocked,
 * waiting, or stopped at a cap) has nothing left to do: finish the run so
 * the card can move to Done. A step still executing is left alone; the PR
 * watcher asks again on its next tick. Returns whether the run is now done.
 */
export async function settleMergedRun(parentId: string, prNumber: number | null): Promise<boolean> {
  return runExclusive(parentId, async () => {
    const run = tasks.get(parentId)?.pipelineRun;
    if (!run) return false;
    if (run.status === "done") return true;
    if (run.status === "cancelled" || run.active.length > 0) return false;
    run.status = "done";
    run.blocked = [];
    delete run.wait;
    run.endedAt = Date.now();
    persist(parentId, run);
    recordActivity(parentId, { kind: "step", text: `${prNumber != null ? `PR #${prNumber}` : "Its pull request"} was merged while the run was parked; the run is finished`, tone: "success" });
    return true;
  }).catch(() => false);
}

export async function cancelPipelineRun(parentId: string): Promise<{ task: Task } | { error: string; status: 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;

    const runningTargets = run.active.filter((a) => isTaskRunLive(a.taskId));
    // A Stop the user pressed: the no-owner-holds ladder leaves the run
    // alone until a person starts a step of it again.
    const markStopped = () => {
      const l = ladderOf(run);
      l.userStop = Date.now();
      delete l.resolving;
    };
    const hadLaunchRetry = Object.values(run.launchRetries ?? {}).some(r => r.at != null);
    for (const retry of Object.values(run.launchRetries ?? {})) retry.at = null;
    if (runningTargets.length === 0 && run.blocked.some(b => b.kind === 'slot-wait')) {
      if (run.autoRetry?.at != null) run.autoRetry = { ...run.autoRetry, at: null };
      run.status = 'cancelled';
      markStopped();
      persist(parentId, run, { preserveStatus: true });
      recordActivity(parentId, { kind: 'step', text: 'Queued execution cancelled — left for you', tone: 'muted' });
      return { task: tasks.get(parentId)! };
    }
    // Stop on a card that's only waiting for an automatic retry cancels the
    // retry; the step stays blocked for the user.
    if (runningTargets.length === 0 && (hadLaunchRetry || run.autoRetry?.at != null || run.wait?.state === "waiting")) {
      if (run.autoRetry?.at != null) run.autoRetry = { ...run.autoRetry, at: null };
      // Out of the wait queue too: the block stays, for the user.
      if (run.wait?.state === "waiting") delete run.wait;
      markStopped();
      persist(parentId, run);
      recordActivity(parentId, { kind: "step", text: "Automatic retry cancelled — left for you", tone: "muted" });
      return { task: tasks.get(parentId)! };
    }
    // Stop on a card the no-owner-holds ladder is resolving: it is left
    // alone from now on, for the user.
    if (runningTargets.length === 0 && run.status === "blocked" && run.ladder?.resolving) {
      markStopped();
      persist(parentId, run);
      recordActivity(parentId, { kind: "step", text: "Stopped — Agetor will not resolve this stop by itself; left for you", tone: "muted" });
      return { task: tasks.get(parentId)! };
    }
    if (runningTargets.length === 0) return { error: "pipeline is not running", status: 409 as const };
    // A Stop also cancels any automatic retry that was pending.
    if (run.autoRetry?.at != null) run.autoRetry = { ...run.autoRetry, at: null };
    markStopped();

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
 * it to stamp the outcome: a delivered reminder consumes the one allowed
 * reminder; a capacity refusal records an undelivered note for the slot
 * loop; other refusals keep their ordinary blocked disposition.
 */
interface PendingReminder {
  kind?: "reminder";
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

/**
 * A gated step's turn ended and its checks have to be run (src/bun/
 * check-runner.ts). Like the reminder's send, that happens with the
 * per-parent lock RELEASED — a command check may take minutes, and Stop,
 * Retry and every other card-level route must not queue behind it. The
 * locked settle body marks the execution (`checksInFlight`), hands this
 * back, and is entered again with the results ({@link evaluatePendingChecks}):
 * it re-derives the turn's classification, which is the same for the same
 * turn, and this time decides.
 */
interface PendingChecks {
  kind: "checks";
  parentId: string;
  taskId: string;
  runId: string;
  seq: number;
  stepId: string;
  checks: StepCheck[];
  /** The handoff of the turn being judged; null when it wrote none. */
  handoff: Handoff | null;
  /** The turn the checks are for (`PipelineStepRecord.turnStartedAt`). */
  turnStartedAt: number | null;
}

/** A failed check's feedback, to be sent into the step's own session once
 *  the lock is released ({@link deliverCheckFeedback}). */
interface PendingFeedback {
  kind: "feedback";
  parentId: string;
  taskId: string;
  runId: string;
  seq: number;
  stepId: string;
  stepName: string;
  text: string;
  /** This feedback turn, from 1, of `max`. */
  turn: number;
  max: number;
  failed: string[];
  /** What the gate found, for the block if the feedback cannot be sent. */
  found: string;
}

type SettleFollowUp = PendingReminder | PendingChecks | PendingFeedback;

/** What the checks came to for a settle entered again with them. */
type GateResults = ({ results: CheckResult[] } | { error: string }) & { turnStartedAt: number | null };

/** Step task ids whose checks are being run outside the lock, with the turn
 *  they are for. A second settle of that same turn (its `review` column
 *  event and its `run-status` event both reach the settle body) is dropped;
 *  one for another turn is kept in `deferredSettles`. */
const checksInFlight = new Map<string, number | null>();

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
 *  - Already reminded once for this execution (`reminder.delivered` true,
 *    for ANY reason — one delivered reminder max per execution) blocks immediately,
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
 *  - Otherwise: hand the send back to the caller. A reminder recorded with
 *    `delivered: true` consumes that allowance. A capacity refusal records
 *    `false` for later delivery; other failed/withheld sends record nothing
 *    there and retain their ordinary block and failure message.
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

  if (historyEntry?.reminder?.delivered) {
    // Already reminded once for this execution (retries don't reset it —
    // see `PipelineStepReminder`'s doc) — a second bad response blocks
    // instead of reminding again.
    upsertBlocked(run, {
      taskId,
      stepId: activeEntry.stepId,
      kind: blockKind,
      message: `still no valid handoff after one reminder — ${baseMessage}`,
    });
    // Nothing here needs a person: the step simply ended without saying
    // what happens next. On an unattended board, start it again (bounded,
    // with backoff) before leaving the block for someone.
    if (run.snapshot?.decisionPolicy) {
      scheduleAutoRetry(parentId, run, activeEntry.stepId, null, "ended without a handoff");
    }
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
    settleDeferred(p.parentId, p.taskId, p.seq);
  }
}

async function deliverHandoffReminderInner(p: PendingReminder): Promise<void> {
  // A resumed Claude turn can start between preparation and delivery.
  // Its exact current receipt owns the continuation; a stale reminder
  // neither sends to it nor turns a refused no-growth replay into a block.
  const newerActive=()=>{
    const step=tasks.get(p.taskId),current=step?.runId?runs.get(step.runId):null;
    return !!step?.runId&&step.runId!==p.runId&&(isTaskRunLive(p.taskId)||current?.status==='running'||current?.status==='orphaned');
  };
  if(newerActive()) {
    await runExclusive(p.parentId,async()=>{remindersInFlight.delete(p.taskId);});
    return;
  }
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

      // Capacity refusals queue the undelivered note. Other refusals keep
      // their ordinary block and do not consume the reminder allowance.
      // Only if this execution is still the active one —
      // a Retry/Advance that landed while the send was in flight already
      // decided its fate.
      const stillActive = run.active.some((a) => a.taskId === p.taskId && a.seq === p.seq);
      if (!stillActive||newerActive()) return;
      const queued = !sent.withheld && isCapacityRefusal(sent.reason);
      if (queued && historyEntry) {
        historyEntry.reminder = { at: Date.now(), reason: p.reason, runId: p.runId, detail: p.detail, delivered: false };
      } else if (historyEntry?.reminder && !historyEntry.reminder.delivered) {
        delete historyEntry.reminder;
      }
      upsertBlocked(run, {
        taskId: p.taskId,
        stepId: p.stepId,
        kind: queued ? 'slot-wait' : reminderBlockKind(p.reason),
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
  /** The results of the checks an earlier pass of this same settle asked for. */
  checked?: GateResults,
): Promise<SettleFollowUp | null> {
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
    // Its checks are being run outside the lock: the pass that comes back
    // with their results decides. Results for a turn that is no longer the
    // one on record are dropped, and this pass asks again.
    const turnNow = historyEntry?.turnStartedAt ?? null;
    if (checksInFlight.has(taskId) && !checked) {
      if (checksInFlight.get(taskId) !== turnNow) deferredSettles.set(taskId, { runId, status });
      return null;
    }
    if (checked && isTaskRunLive(taskId)) return null;
    const judged = checked && checked.turnStartedAt === turnNow ? checked : null;

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
      // A completed turn proves this exact child's launch succeeded.
      // Its sibling's technical retry budget/schedule remains untouched.
      if (run.launchRetries) delete run.launchRetries[taskId];
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

      // The step's gate (`pipeline_gates`, src/shared/checks.ts): with one,
      // the step is finished when its required checks pass, not when its
      // handoff says so. Never for the writer of an Agetor-run Finish (CI
      // already decided that visit) or the wrap-up at the step cap (it
      // publishes what there is).
      // Only a visit that was launched under the gate (`gate` on its record):
      // adopting gates never switches a step that is already under way.
      const stepObj = graph.steps.find((s) => s.id === activeEntry.stepId);
      const gate = stepObj && historyEntry?.gate && run.publish?.seq !== activeEntry.seq && run.capWrapUp?.seq !== activeEntry.seq
        ? stepGateFor(parent, run, stepObj) : null;
      /**
       * Judge the turn by the gate. `return`: the settle ends here — with the
       * checks to run, the feedback to send, or a block already recorded.
       * `pass`: every required check is met. `fresh`: still failing after
       * the visit's feedback turns; the visit ends and the step gets its one
       * fresh session, with `handoff` (the failures) as its arrival.
       */
      const judgeGate = (handoff: Handoff | null):
        | { kind: "return"; value: SettleFollowUp | null }
        | { kind: "pass"; passed: string[] }
        | { kind: "fresh"; handoff: Handoff } => {
        const g = gate!;
        // This turn was already judged and is the owner's (the column and
        // run-status events both settle one turn); a Retry clears the block.
        if (run.blocked.some((b) => b.taskId === taskId && b.kind === "check-failed")) return { kind: "return", value: null };
        const prior = historyEntry?.gate;
        if (!judged) {
          checksInFlight.set(taskId, turnNow);
          if (historyEntry) {
            historyEntry.gate = {
              state: "checking", turns: prior?.turns ?? 0,
              // Sent back in by the owner after a stop: a new allowance.
              max: prior?.state === "owner" ? prior.turns + g.maxTurns : (prior?.max ?? g.maxTurns),
              failed: prior?.failed ?? [], at: Date.now(),
            };
          }
          persist(parentId, run);
          return { kind: "return", value: { kind: "checks", parentId, taskId, runId, seq: activeEntry.seq, stepId: activeEntry.stepId, checks: g.checks, handoff, turnStartedAt: turnNow } };
        }
        const turns = prior?.turns ?? 0;
        const max = prior?.max ?? g.maxTurns;
        const setGate = (state: NonNullable<PipelineStepRecord["gate"]>["state"], failed: string[]) => {
          if (historyEntry) historyEntry.gate = { state, turns, max, failed, at: Date.now() };
        };
        const forOwner = (message: string, failed: string[]): { kind: "return"; value: null } => {
          upsertBlocked(run, { taskId, stepId: activeEntry.stepId, kind: "check-failed", message });
          setGate("owner", failed);
          // What the step said stays readable (and is what Advance passes on).
          if (historyEntry && handoff) historyEntry.handoff = handoff;
          recordActivity(parentId, { kind: "step", tone: "danger", text: message });
          checkJoinIncomplete(run);
          persist(parentId, run);
          return { kind: "return", value: null };
        };
        if ("error" in judged) {
          return forOwner(`step "${stepName}" finished, but its checks could not be run: ${judged.error} — Retry runs them again`, prior?.failed ?? []);
        }
        const verdict = gateVerdict(judged.results);
        if (verdict.state === "pass") {
          setGate("passed", []);
          return { kind: "pass", passed: judged.results.filter((r) => r.check.required).map((r) => r.check.id) };
        }
        const failedIds = [...verdict.failed, ...verdict.unmet].map((r) => r.check.id);
        const found = gateFailureLine(verdict);
        // Nothing failed, but a required check could not be evaluated (git or
        // GitHub did not answer, a required check is still running): not the
        // step's to fix, so no turn is spent on it.
        if (verdict.state === "halt") {
          return forOwner(`step "${stepName}" finished, but a required check could not be evaluated: ${found} — nothing was sent back to the step; Retry runs the checks again (and gives the step a turn only if one then fails), Advance moves on without them`, failedIds);
        }
        if (turns < max) {
          // The same refusals as the handoff reminder: never send into a run
          // that is gone, archived or being stopped.
          const parentFresh = tasks.get(parentId);
          const skip = tombstonedPipelineParents.has(parentId) || !parentFresh ? "the pipeline task no longer exists"
            : parentFresh.archivedAt != null ? "the pipeline task is archived"
            : tasks.get(taskId)?.archivedAt != null ? "the step task is archived"
            : isDeliberateWholeRunStop(run, taskId) ? "the pipeline run is stopping" : null;
          if (skip) return forOwner(`step "${stepName}" finished with required checks failing: ${found} (not sent back to the step — ${skip})`, failedIds);
          remindersInFlight.add(taskId);
          setGate("checking", failedIds);
          checkJoinIncomplete(run);
          persist(parentId, run);
          return {
            kind: "return",
            value: {
              kind: "feedback", parentId, taskId, runId, seq: activeEntry.seq, stepId: activeEntry.stepId, stepName, turn: turns + 1, max, failed: failedIds, found,
              text: composeCheckFeedback({
                stepName, goal: g.goal, turn: turns + 1, maxTurns: max, failed: verdict.failed, unmet: verdict.unmet, hadHandoff: handoff !== null,
                outgoing: outgoingSteps(graph, activeEntry.stepId).map((o) => ({ name: o.step.name, label: o.edge.label })),
                transition: stepObj?.transition ?? "choose", canFinish: stepObj?.canFinish === true,
              }),
            },
          };
        }
        // Out of turns. One fresh session of the same step, with the failures
        // as its arrival — unless this visit is that fresh session.
        const previousVisit = run.history.filter((h) => h.stepId === activeEntry.stepId && h.seq < activeEntry.seq).sort((a, b) => b.seq - a.seq)[0];
        if (previousVisit?.gate?.state !== "exhausted") {
          setGate("exhausted", failedIds);
          return { kind: "fresh", handoff: normalizeHandoff(exhaustedHandoff({ stepName, turns, failed: verdict.failed, unmet: verdict.unmet, lastWords: handoff?.summary || assistantText })) };
        }
        return forOwner(
          `step "${stepName}" still fails its required checks after ${turns} feedback turn${turns === 1 ? "" : "s"} and one fresh session: ${found} — fix it in the worktree and Retry, or Advance past the checks`,
          failedIds,
        );
      };
      /** Set when the gate, not the step's handoff, decides what is passed on. */
      let composed: Handoff | null = null;
      let freshSession: Handoff | null = null;
      let gateJudged = false;

      // A handoff still missing after the one reminder: the checks decide.
      // When they pass and there is one way forward, the run advances with a
      // handoff Agetor composes from the step's last words; it is never the
      // owner's problem that a step forgot the block. (A Review cannot pass
      // this way: without a handoff there is no verdict to check.)
      if (gate && (classified.kind === "handoff-missing" || classified.kind === "handoff-invalid") && historyEntry?.reminder?.delivered) {
        const outcome = judgeGate(null);
        if (outcome.kind === "return") return outcome.value;
        gateJudged = true;
        if (outcome.kind === "fresh") {
          freshSession = outcome.handoff;
        } else {
          const said = stepFinalReport(taskId, historyEntry.startedAt, null, { includeUnstructured: true });
          const draft = composedHandoff({ stepName, next: null, passed: outcome.passed, finalMessage: said?.messages.slice(-2).join("\n\n") ?? assistantText });
          const route = resolveNextSteps(graph, activeEntry.stepId, draft);
          if (route.kind === "steps" || route.kind === "terminal") {
            composed = normalizeHandoff({ ...draft, next: route.kind === "steps" && route.stepIds.length === 1 ? stepNameById(graph, route.stepIds[0]!) : null });
            if (historyEntry.gate) historyEntry.gate.composed = true;
            recordActivity(parentId, {
              kind: "step", tone: "warning",
              text: `${stepName} ended without a handoff, also after its reminder; its required checks pass (${outcome.passed.join(", ")}) — moving on with a handoff composed by Agetor`,
            });
          }
          // Several ways forward and no handoff to choose one: as before.
        }
      }

      if (!composed && !freshSession && (classified.kind === "handoff-missing" || classified.kind === "handoff-invalid")) {
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

      if (classified.kind === "user-ask" && !composed && !freshSession) {
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

      if (classified.kind !== "handoff" && !blockedButRouted && !composed && !freshSession) {
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

      // A step that handed off: its required checks have to pass before the
      // handoff is passed on. One that fails goes back to this same step.
      if (gate && !gateJudged) {
        const outcome = judgeGate(classified.handoff!);
        if (outcome.kind === "return") return outcome.value;
        if (outcome.kind === "fresh") freshSession = outcome.handoff;
      }
      // What is passed on: the step's handoff; the one Agetor composed for a
      // step that wrote none; or the failures, to the step's fresh session.
      const parsedHandoff = freshSession ?? composed ?? classified.handoff!;
      let resolved = freshSession ? { kind: "steps" as const, stepIds: [activeEntry.stepId] } : resolveNextSteps(graph, activeEntry.stepId, parsedHandoff);
      // The writer of an Agetor-run Finish only writes: the visit's outcome
      // was decided by Agetor (CI is green), so its turn ends the step
      // whatever `next` says.
      if (run.publish?.state === "write" && run.publish.seq === activeEntry.seq && resolved.kind !== "terminal") {
        if (parsedHandoff.next?.trim()) {
          recordActivity(parentId, { kind: "step", tone: "muted", text: `${stepName} named "${parsedHandoff.next}" as the next step — ignored: Agetor ran this ${stepName} and its checks passed` });
        }
        resolved = { kind: "terminal" };
      }
      if(!freshSession&&stepName==='Review'&&managedPillarRoot(parent.worktreePath??parent.workdir)&&reviewRequiresRepair(parsedHandoff)) {
        const repair=outgoingSteps(graph,activeEntry.stepId).find(o=>o.step.name==='Build'&&/^(?:changes requested|needs work|fix|repair|rework)$/i.test(o.edge.label.trim()));
        // A completed review can describe downstream owner-only evidence.
        // Do not turn that completed verdict into an execution hold. The
        // original verdict/findings stay in history; only the corrective
        // graph edge changes. Explicit questions/waits and blocked verdicts
        // still require their normal disposition.
        const corrective=repair?{...parsedHandoff,next:repair.step.id}:null;
        const completedRepair=parsedHandoff.status==='done'&&graph.steps.find(s=>s.id===activeEntry.stepId)?.transition==='choose'
          &&!parsedHandoff.waitingOn&&!parsedHandoff.openQuestions.some(q=>q.trim());
        if(corrective&&(completedRepair||blockedHandoffChoosesNext(graph,activeEntry.stepId,corrective))) {
          resolved=resolveNextSteps(graph,activeEntry.stepId,corrective);
          recordActivity(parentId,{kind:'step',text:'Review has unresolved findings or incomplete acceptance — routing the preserved findings to Build',tone:'warning'});
        }else {
          if(historyEntry)historyEntry.handoff=parsedHandoff;
          upsertBlocked(run,{taskId,stepId:activeEntry.stepId,kind:'step-blocked',message:'Review requires repair; no permitted corrective route can be followed'});
          checkJoinIncomplete(run);persist(parentId,run);return null;
        }
      }
      // Review's findings, by stable ID (src/shared/finding-ledger.ts): one
      // that came back twice leaves the card; a Build that skipped its Class
      // search goes back to itself once before any Review runs.
      if (!freshSession && (resolved.kind === "steps" || resolved.kind === "terminal")) {
        resolved = await settleReviewFindings(parentForGuard(parentId, parent), run, stepName, activeEntry, parsedHandoff, resolved);
      }
      if (!freshSession && resolved.kind === "steps" && historyEntry) {
        const missing = await classSearchReturn(run, stepName,
          { stepId: activeEntry.stepId, seq: activeEntry.seq, taskId, startedAt: historyEntry.startedAt, turnStartedAt: historyEntry.turnStartedAt ?? null, endedAt: Date.now() },
          parsedHandoff);
        if (missing) {
          run.classSearchReturned = activeEntry.seq;
          resolved = { kind: "steps", stepIds: [activeEntry.stepId] };
          recordActivity(parentId, { kind: "step", tone: "warning",
            text: `${stepName} handed off without a Class search line for ${missing.join(", ")} — back to ${stepName} once before Review` });
        }
      }
      // A Build sent back by a failed publication that changed nothing: the
      // head Review approved is still the head, so it returns to Finish.
      if (!freshSession && resolved.kind === "steps") {
        resolved = await skipReviewOfApprovedHead(parentForGuard(parentId, parent), run, stepName, activeEntry, resolved);
      }
      if (!freshSession && (resolved.kind === "ambiguous" || resolved.kind === "unknown")) {
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

      // An edge with `maxTraversals` is a bounded corrective loop (Finish →
      // Build after a CI failure). Once the run has taken it that often, the
      // step's choice is kept in history and the run waits for a person, who
      // can Advance it by hand; it is never routed onward or retried here.
      if (resolved.kind === "steps" && !freshSession) {
        const spent = exhaustedEdge(graph, run.history, activeEntry.stepId, resolved.stepIds);
        if (spent) {
          if (historyEntry) historyEntry.handoff = parsedHandoff;
          const label = spent.edge.label.trim() || stepNameById(graph, spent.edge.to);
          upsertBlocked(run, {
            taskId,
            stepId: activeEntry.stepId,
            kind: "step-blocked",
            message: `step "${stepName}" chose "${label}" again, but this run has already taken that route ${spent.taken} of ${spent.edge.maxTraversals} times — decide whether to continue (Advance to ${stepNameById(graph, spent.edge.to)}) or take the card over`,
          });
          recordActivity(parentId, { kind: "step", tone: "warning",
            text: `${stepName} → ${stepNameById(graph, spent.edge.to)} ("${label}") reached its limit of ${spent.edge.maxTraversals} — waiting for you` });
          checkJoinIncomplete(run);
          persist(parentId, run);
          return null;
        }
      }

      // A Build that keeps leaving the head Review sent back unchanged
      // (src/shared/no-change-loop.ts): tell the next Review, then wrap up.
      if (!freshSession) await guardNoChangeLoop(parentForGuard(parentId, parent), run, stepName, activeEntry.stepId, resolved);

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
        // A visit ended for a fresh session did not pass its gate.
        historyEntry.outcome = freshSession ? "failed" : "succeeded";
        historyEntry.handoff = parsedHandoff;
        historyEntry.nextStepIds = nextStepIds;
      }
      pipelineUpdateColumn(taskId, runId, "done");
      if (freshSession) {
        recordActivity(parentId, {
          kind: "step", tone: "warning",
          text: `${stepName} still fails its required checks after ${historyEntry?.gate?.turns ?? 0} feedback turn(s) (${(historyEntry?.gate?.failed ?? []).join(", ")}) — starting it once more in a fresh session, with the failures as its arrival`,
        });
      }

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
          if (targetStep.join === "all" && !freshSession) {
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
        if (targetStep.join === "all" && !freshSession) {
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
  await afterSettle(pending);
}

/** Carry out what a settle left to do once its lock is released: run the
 *  step's checks and enter the settle again with them, or send a reminder or
 *  a check's feedback into the step's session. */
async function afterSettle(first: SettleFollowUp | null): Promise<void> {
  let next = first;
  // One evaluation leads to at most one send. It is asked for again only
  // when the turn it judged was replaced meanwhile; the bound is a backstop.
  for (let i = 0; next && i < 4; i++) {
    if (next.kind === "checks") {
      next = await evaluatePendingChecks(next);
    } else if (next.kind === "feedback") {
      await deliverCheckFeedback(next);
      return;
    } else {
      await deliverHandoffReminder(next);
      return;
    }
  }
  if (next?.kind === "checks") checksInFlight.delete(next.taskId);
}

/** A settle that arrived while this execution's checks or a send were in
 *  flight, for a turn that has really ended: settle it now. */
function settleDeferred(parentId: string, taskId: string, seq: number): void {
  const deferred = deferredSettles.get(taskId);
  deferredSettles.delete(taskId);
  const step = tasks.get(taskId);
  if (deferred && step?.column === "review" && !isTaskRunLive(taskId)) {
    const entry = tasks.get(parentId)?.pipelineRun?.history.find((h) => h.taskId === taskId && h.seq === seq);
    if (entry && entry.outcome == null && step.runId === deferred.runId) void handleRunStatus(taskId, deferred.runId, deferred.status);
  }
}

/** Run the checks a settle asked for, with no lock held, and enter that
 *  settle again with what they came to. */
async function evaluatePendingChecks(p: PendingChecks): Promise<SettleFollowUp | null> {
  let outcome: GateResults;
  try {
    const parent = tasks.get(p.parentId);
    const run = parent?.pipelineRun;
    const step = run?.snapshot?.graph.steps.find((s) => s.id === p.stepId);
    if (!parent || !run || !step || tombstonedPipelineParents.has(p.parentId)) {
      checksInFlight.delete(p.taskId);
      return null;
    }
    outcome = { results: await runStepChecks({ parent, run, step, seq: p.seq, checks: p.checks, handoff: p.handoff }), turnStartedAt: p.turnStartedAt };
  } catch (err) {
    outcome = { error: err instanceof Error ? err.message : String(err), turnStartedAt: p.turnStartedAt };
  }
  // The mark is cleared under the lock, right before the settle that uses
  // the results — which may set it again, when it has to ask once more.
  const next = await runExclusive(p.parentId, async () => {
    checksInFlight.delete(p.taskId);
    return settleStepRun(p.parentId, p.taskId, p.runId, "succeeded", outcome);
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed settling task ${p.taskId} with its check results:`, err);
    checksInFlight.delete(p.taskId);
    return null;
  });
  // A send that follows settles what was deferred itself, once it is done.
  if (!next) settleDeferred(p.parentId, p.taskId, p.seq);
  return next;
}

/**
 * Send a failed check's feedback into the step's own session, with no lock
 * held (L-R7), then stamp the outcome: delivered — the visit has spent one of
 * its feedback turns and the step is working again; the turn settles through
 * the same settle path and its checks are run again. When the message cannot
 * be delivered the step is started again instead (the same step task, as the
 * wait queue does), which also spends the turn; when that fails too, the
 * failure is the owner's.
 */
async function deliverCheckFeedback(p: PendingFeedback): Promise<void> {
  try {
    await deliverCheckFeedbackInner(p);
  } finally {
    settleDeferred(p.parentId, p.taskId, p.seq);
  }
}

async function deliverCheckFeedbackInner(p: PendingFeedback): Promise<void> {
  const newerActive = () => {
    const step = tasks.get(p.taskId), current = step?.runId ? runs.get(step.runId) : null;
    return !!step?.runId && step.runId !== p.runId && (isTaskRunLive(p.taskId) || current?.status === "running" || current?.status === "orphaned");
  };
  if (newerActive()) {
    await runExclusive(p.parentId, async () => { remindersInFlight.delete(p.taskId); });
    return;
  }
  let sent: Awaited<ReturnType<typeof sendInput>>;
  try {
    sent = await sendInput(p.runId, p.text);
  } catch (err) {
    sent = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const count = `check-feedback turn ${p.turn} of ${p.max}`;
  /** Stamp the spent turn on the visit, under the lock. */
  const spend = (run: PipelineRunState) => {
    const h = run.history.find((x) => x.taskId === p.taskId && x.seq === p.seq);
    if (h) h.gate = { state: "feedback", turns: p.turn, max: p.max, failed: p.failed, at: Date.now() };
  };
  const restart = await runExclusive(p.parentId, async () => {
    remindersInFlight.delete(p.taskId);
    try {
      const parent = tasks.get(p.parentId);
      const run = parent?.pipelineRun;
      if (!parent || !run) return false;
      if (sent.delivered) {
        spend(run);
        appendRunStatusLine(p.taskId, p.runId, `required checks failed (${p.failed.join(", ")}) — sent back to this step: ${count}`);
        recordActivity(p.parentId, { kind: "step", tone: "warning", text: `${p.stepName} did not pass its checks (${p.found}) — sent back to ${p.stepName} in its own session (${count})` });
        checkJoinIncomplete(run);
        persist(p.parentId, run);
        return false;
      }
      if (sent.withheld && sent.savedToBacklog) {
        try {
          const item = tasks.get(p.taskId)?.backlog.find((b) => b.text === p.text);
          if (item) backlog.remove(p.taskId, item.id);
        } catch {
          // best-effort
        }
      }
      // A Retry or Advance that landed while the send was in flight already
      // decided this execution's fate.
      return run.active.some((a) => a.taskId === p.taskId && a.seq === p.seq) && !newerActive();
    } catch (err) {
      persistReconcileFailure(p.parentId, p.taskId, err);
      return false;
    }
  }).catch(() => false);
  if (!restart || sent.delivered) return;

  const why = sent.reason.slice(0, 160);
  const relaunched = await retryPipelineStep(p.parentId, { taskId: p.taskId }).catch((e: unknown) => ({ error: String(e) }));
  await runExclusive(p.parentId, async () => {
    const parent = tasks.get(p.parentId);
    const run = parent?.pipelineRun;
    if (!parent || !run || !run.active.some((a) => a.taskId === p.taskId && a.seq === p.seq)) return;
    const queued = "error" in relaunched && run.blocked.some((b) => b.taskId === p.taskId && b.kind === "slot-wait");
    if (!("error" in relaunched) || queued) {
      // Started again (or queued for a slot and started by itself): the turn is spent.
      spend(run);
      recordActivity(p.parentId, { kind: "step", tone: "warning", text: `${p.stepName} did not pass its checks (${p.found}); the feedback could not be sent into its session (${why}) — ${queued ? "queued to start" : "started"} the step again instead (${count})` });
    } else {
      upsertBlocked(run, {
        taskId: p.taskId, stepId: p.stepId, kind: "check-failed",
        message: `step "${p.stepName}" finished with required checks failing: ${p.found} — it could not be sent back to the step (${why}; restart: ${relaunched.error.slice(0, 160)})`,
      });
      const h = run.history.find((x) => x.taskId === p.taskId && x.seq === p.seq);
      if (h?.gate) h.gate = { ...h.gate, state: "owner", failed: p.failed, at: Date.now() };
    }
    checkJoinIncomplete(run);
    persist(p.parentId, run);
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed stamping check feedback for task ${p.taskId}:`, err);
  });
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

  let pending: SettleFollowUp | null = null;
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
        // A step running again after a Stop: a person started it (nothing
        // automatic resumes a stopped run), so the ladder may act again.
        if (run.ladder?.userStop != null) {
          delete run.ladder.userStop;
          changed = true;
        }
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
        if (checksInFlight.has(taskId)) return;
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
  await afterSettle(pending);
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
  const child = tasks.get(taskId);
  if (!child || child.archivedAt != null || isTaskRunLive(taskId) || listPendingForTask(taskId).length > 0
    || isDeliberateWholeRunStop(run, taskId)) return;
  const existing = run.blocked.find(b => b.taskId === taskId);
  // A missing run row does not invalidate another recorded reason for a
  // hold (configuration errors, owner questions, or queued admission).
  if (existing && (existing.kind !== 'step-failed'
    || !/ never started$/.test(existing.message) && !isDatabaseBusy(existing.message))) return;
  const stepName = run.snapshot ? stepNameById(run.snapshot.graph, entry.stepId) : entry.stepId;
  upsertBlocked(run, { taskId, stepId: entry.stepId, kind: "step-failed", message: `step "${stepName}" never started` });
  const h = run.history.find((x) => x.taskId === taskId && x.seq === entry.seq);
  if (h) {
    h.endedAt = Date.now();
    freezeStepReport(h);
    h.outcome = "failed";
  }
  // This is an interrupted child launch, not a planner question. Preserve
  // a pending/exhausted/cancelled retry record across repeated boot sweeps.
  if (run.snapshot?.decisionPolicy && !run.autoRetry && !run.launchRetries?.[taskId]) {
    scheduleLaunchRetry(parentId, run, taskId, entry.stepId, 'was interrupted before its worker started');
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
    // Earlier builds stored admission refusals as permanent failures.
    // Reclassify only those exact technical reasons on opted-in runs;
    // never revive a cancelled retry, owner hold, or live execution.
    await runExclusive(parent.id, async () => {
      const fresh = tasks.get(parent.id);
      const run = fresh?.pipelineRun;
      if (!fresh || !run || fresh.archivedAt != null || !['running', 'blocked'].includes(run.status)) return;
      for (const active of run.active) retireStaleQueuedReminder(parent.id, run, active.taskId);
      if (!run.snapshot?.decisionPolicy || run.autoRetry?.at === null) return;
      let changed = false;
      for (const block of run.blocked) {
        if (block.kind !== 'step-failed' || !block.taskId || !block.stepId) continue;
        const child = tasks.get(block.taskId);
        if (!child || child.archivedAt != null || isTaskRunLive(child.id) || listPendingForTask(child.id).length > 0
          || !run.active.some(a => a.taskId === child.id && a.stepId === block.stepId)) continue;
        if (isCapacityRefusal(block.message)) {
          block.kind = 'slot-wait';
          changed = true;
        } else if (isDatabaseBusy(block.message) && !run.autoRetry && !run.launchRetries?.[child.id]) {
          scheduleLaunchRetry(parent.id, run, child.id, block.stepId, 'could not acquire the database writer');
          changed = true;
        }
      }
      if (changed) persist(parent.id, run);
    });
    const activeSnapshot = parent.pipelineRun!.active.slice();
    for (const a of activeSnapshot) {
      if (isTaskRunLive(a.taskId)) continue;
      // A queued child (including an undelivered formatting reminder) is
      // owned by the slot loop, not by another boot-time settle.
      if (tasks.get(parent.id)?.pipelineRun?.blocked.some(b => b.taskId === a.taskId && b.kind === 'slot-wait')) continue;
      try {
        const stepRuns = runs.listForTask(a.taskId);
        const latest = stepRuns[0] ?? null;
        if (!latest) {
          await runExclusive(parent.id, async () => markStepNeverStarted(parent.id, a.taskId));
          count++;
        } else if (latest.status !== "running") {
          // Not awaited: settling a step that finished while the core was
          // down runs its gate checks (ai-check, tests) — 30 s or more each.
          // Awaited one by one they held the API, and the window, for
          // minutes (seen 2026-10-14). The per-card lock keeps this card's
          // later work behind it.
          void handleRunStatus(a.taskId, latest.id, latest.status).catch((err) =>
            runExclusive(parent.id, async () => persistReconcileFailure(parent.id, a.taskId, err)).catch(() => {}));
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
  deliverHandoffReminder,
};
