/**
 * What the pipeline run view shows that the run state doesn't say outright:
 * how many executions were recorded and where the run looped, one tile per
 * step, which recovery controls a run in this state has and what each is
 * called, and what is known about checks. Pure: the callers pass the card's
 * state (card-state.ts) and `now`, so the view and the board card can't
 * disagree about the same task.
 */
import type { CheckLedgerEntry, PipelineBlock, PipelineBlockKind, PipelineGraph, PipelineRunState, PipelineRunStatus, PipelineStepRecord, Task, TaskPrStatus } from "../../shared/types.ts";
import { effectiveStepCap, isFollowUpStepId } from "../../shared/pipeline.ts";
import { waitingInQueue } from "../../shared/block-wait.ts";
import { causeOf } from "./board-health.ts";
import { CARD_STATE_ICON, clockTime, stepOrder, type CardAction, type CardState, type CardStateIcon, type CardStateTone } from "./card-state.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameIn = (graph: PipelineGraph | null, stepId: string | null | undefined) => (stepId ? (graph?.steps.find((s) => s.id === stepId)?.name ?? stepId) : "step");

// ── Executions ────────────────────────────────────────────────────────────

export interface ExecutionLoop {
  /** The record that handed back. */
  seq: number;
  fromStepId: string;
  /** A step that already had a record when this one handed off to it. */
  toStepId: string;
}

export interface ExecutionSummary {
  /** `run.history.length`: every execution the run recorded, loops included. */
  recorded: number;
  /** "6 executions recorded". Never a fraction of the graph's step count. */
  label: string;
  /** Records per step id. */
  byStep: Map<string, number>;
  loops: ExecutionLoop[];
  /** Several executions at once (a fan-out): no linear numbering applies. */
  parallel: boolean;
  /** "step cap 28 of 28": executions started, of the run's allowance. */
  cap: { used: number; max: number; label: string };
}

export function executionSummary(run: PipelineRunState): ExecutionSummary {
  const byStep = new Map<string, number>();
  const firstSeq = new Map<string, number>();
  for (const r of run.history) {
    byStep.set(r.stepId, (byStep.get(r.stepId) ?? 0) + 1);
    if (!firstSeq.has(r.stepId) || r.seq < firstSeq.get(r.stepId)!) firstSeq.set(r.stepId, r.seq);
  }
  const loops: ExecutionLoop[] = [];
  for (const r of run.history) {
    for (const to of new Set(r.nextStepIds)) {
      const first = firstSeq.get(to);
      if (first != null && first <= r.seq) loops.push({ seq: r.seq, fromStepId: r.stepId, toStepId: to });
    }
  }
  const max = effectiveStepCap(run);
  return {
    recorded: run.history.length,
    label: `${plural(run.history.length, "execution")} recorded`,
    byStep,
    loops,
    parallel: run.active.length > 1,
    cap: { used: run.stepCount, max, label: `step cap ${run.stepCount} of ${max}` },
  };
}

/** A step's nth record, for one record: "round 2" of Build. */
export function roundOf(run: PipelineRunState, record: Pick<PipelineStepRecord, "seq" | "stepId">): number {
  return run.history.filter((r) => r.stepId === record.stepId && r.seq <= record.seq).length;
}

/** Any execution's step task is running, or blocked on a question it asked:
 *  what Stop can stop. A run can be blocked on one branch and executing on
 *  another, so this is not `run.status === "running"`. */
export function hasLiveExecution(steps: Task[], run: Pick<PipelineRunState, "active"> | null): boolean {
  if (!run) return false;
  return run.active.some((entry) => {
    const stepTask = steps.find((t) => t.id === entry.taskId);
    if (!stepTask) return false;
    if (stepTask.column === "running") return true;
    return stepTask.column === "blocked" && stepTask.pendingInteractionCount > 0;
  });
}

// ── Step tiles ────────────────────────────────────────────────────────────

export interface StepTile {
  id: string;
  name: string;
  /** The agent profile's id, for the caller to name. */
  profileId: string | null;
  tone: CardStateTone;
  icon: CardStateIcon;
  /** The tile's state strip. The current step's is the card state's label. */
  label: string;
  current: boolean;
  executions: number;
  /** "3 executions recorded", "1 execution", "Not run yet". */
  countLabel: string;
  /** The step task to open: the active execution's, else the latest record's. */
  taskId: string | null;
}

export interface StepTiles {
  tiles: StepTile[];
  /** Follow-up steps run after the pipeline; they are not part of its graph. */
  followUps: StepTile[];
  parallel: boolean;
}

const tile = (tone: CardStateTone, label: string) => ({ tone, label, icon: CARD_STATE_ICON[tone] });

/** A step that is not the card's own current step: what its latest record,
 *  or its live execution, says. */
function tileState(run: PipelineRunState, stepId: string, steps: Task[], task: Task): { tone: CardStateTone; label: string; icon: CardStateIcon } {
  const active = run.active.find((a) => a.stepId === stepId);
  if (active) {
    const block = run.blocked.find((b) => b.stepId === stepId || (b.taskId != null && b.taskId === active.taskId));
    if (block?.kind === "await") return tile("waiting", causeOf(block, task) === "ci" ? "Waiting on CI" : "Waiting on command");
    if (block?.kind === "slot-wait") return tile("queued", "Queued");
    if (block) return tile("needs", "Blocked");
    const stepTask = steps.find((t) => t.id === active.taskId);
    if (stepTask?.column === "blocked") return tile("needs", "Blocked");
    if (stepTask?.column === "review") return tile("needs", "Awaiting advance");
    if (stepTask?.column === "running") return tile("working", "Working");
    return tile("queued", "Starting");
  }
  if (run.blocked.some((b) => b.stepId === stepId && b.kind === "slot-wait")) return tile("queued", "Queued");
  const latest = [...run.history].filter((r) => r.stepId === stepId).sort((a, b) => b.seq - a.seq)[0];
  switch (latest?.outcome) {
    case "succeeded":
      // Green with a check, not the pulse: it handed off, it is not executing.
      return { tone: "working", label: "Handed off", icon: "check" };
    case "advanced-manually":
      return tile("queued", "Advanced manually");
    case "failed":
      return tile("failed", "Failed");
    case "cancelled":
      return tile("queued", "Stopped");
    default:
      return tile("queued", latest ? "No outcome recorded" : "Not started");
  }
}

/**
 * One tile per step of the graph, in the board strip's order, and the
 * follow-up steps apart. The tile of the step the card is on wears the
 * card's own state; with several executions at once each active step is
 * current and reads from its own execution.
 */
export function stepTiles(run: PipelineRunState | null, graph: PipelineGraph | null, steps: Task[], task: Task, state: CardState): StepTiles {
  if (!graph) return { tiles: [], followUps: [], parallel: false };
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const counts = run ? executionSummary(run).byStep : new Map<string, number>();
  const activeIds = new Set(run?.active.map((a) => a.stepId) ?? []);
  const make = (id: string): StepTile => {
    const step = byId.get(id)!;
    const executions = counts.get(id) ?? 0;
    const own = state.step?.id === id;
    const current = own || activeIds.has(id);
    const look = own ? { tone: state.state, label: state.label, icon: state.icon } : run ? tileState(run, id, steps, task) : tile("queued", "Not started");
    const active = run?.active.find((a) => a.stepId === id);
    const latest = run ? [...run.history].filter((r) => r.stepId === id).sort((a, b) => b.seq - a.seq)[0] : undefined;
    return {
      id,
      name: step.name,
      profileId: step.agentProfileId,
      ...look,
      current,
      executions,
      countLabel: executions === 0 ? "Not run yet" : executions === 1 ? "1 execution" : `${executions} executions recorded`,
      taskId: active?.taskId ?? latest?.taskId ?? null,
    };
  };
  const order = stepOrder(graph);
  return {
    tiles: order.map(make),
    followUps: graph.steps.filter((s) => isFollowUpStepId(s.id)).map((s) => make(s.id)),
    parallel: (run?.active.length ?? 0) > 1,
  };
}

// ── Recovery controls ─────────────────────────────────────────────────────

/** Statuses from which a run can be restarted from its start step,
 *  discarding the prior history — mirrors the server's own gate. */
export const RESTARTABLE_STATUSES: PipelineRunStatus[] = ["done", "cancelled", "blocked"];

/** Block kinds Retry can re-attempt — everything except a missing/invalid
 *  handoff, which Retry can't fix (re-running the same step reproduces the
 *  same non-handoff, or the same malformed one) — those need Advance. */
export const RETRY_BLOCK_KINDS: PipelineBlockKind[] = ["step-failed", "step-blocked", "step-cap", "profile-missing", "join-incomplete", "check-failed"];

/** Block kinds Advance can resolve by manually picking (or skipping) the
 *  next step(s) — a missing/invalid handoff, an incomplete join the user
 *  wants to force past, a step reported as blocked, or (for a task-level
 *  block, `taskId != null`) a step that was stopped. */
export const ADVANCE_BLOCK_KINDS: PipelineBlockKind[] = ["handoff-missing", "handoff-invalid", "join-incomplete", "step-blocked", "step-failed", "check-failed"];

/** One button of the state band. All of a run's recovery lives there; Retry
 *  appears once however many places could have offered it. */
export type BandAction =
  /** `POST /tasks/:id/pipeline/retry`. The label says which of its uses this is. */
  | { kind: "retry"; id: "retry" | "resume" | "recheck" | "extend-cap" | "retry-now"; label: string; title: string; stepTaskId: string | null }
  | { kind: "stop"; label: string; title: string }
  /** Open a step task's panel (a question to answer, a quiet agent). */
  | { kind: "open-step"; label: string; title: string; taskId: string | null }
  /** The board card's own button, handled as the board handles it. */
  | { kind: "card"; action: CardAction; label: string; title: string };

export interface AdvanceTarget {
  key: string;
  /** The execution to advance from; null for a run-level block. */
  fromTaskId: string | null;
  stepName: string;
  /** Why it can be advanced: it is blocked, or it finished and waits for a choice. */
  why: string;
}

export interface RecoveryControls {
  primary: BandAction | null;
  secondary: BandAction[];
  /** Under "Advanced run controls" only, each behind its own confirmation. */
  restart: boolean;
  advance: AdvanceTarget[];
  /** A sentence for the band when its buttons need one. */
  hint: string | null;
}

const NONE: RecoveryControls = { primary: null, secondary: [], restart: false, advance: [], hint: null };

/** An active execution whose step task finished (column `review`) while the
 *  pipeline has not moved past it, and that no block already covers. */
export function awaitingAdvance(run: PipelineRunState, steps: Task[]): { taskId: string; stepId: string }[] {
  return run.active.flatMap((active) => {
    const stepTask = steps.find((t) => t.id === active.taskId);
    if (!stepTask || stepTask.column !== "review") return [];
    if (run.blocked.some((b) => b.taskId != null && b.taskId === active.taskId)) return [];
    return [{ taskId: active.taskId, stepId: active.stepId }];
  });
}

const advanceable = (b: PipelineBlock) => ADVANCE_BLOCK_KINDS.includes(b.kind) && (b.kind !== "step-failed" || b.taskId != null);

/**
 * The controls a run in this state has. The primary follows the card's own
 * button (`state.action`); retrying appears once, named for what it does
 * here: Retry, Resume (a stopped run), Recheck now (a held input), Extend
 * cap. Nothing in the band skips a blocker, advances a step or merges:
 * Restart and Advance are separate, under Advanced, each asking first.
 */
export function recoveryControls(task: Task, steps: Task[], state: CardState): RecoveryControls {
  const run = task.pipelineRun ?? null;
  if (task.archivedAt != null) return NONE;
  const a = state.action;
  const card = (action: CardAction, title: string): BandAction => ({ kind: "card", action, label: action.label, title });
  if (!run || (run.status === "idle" && run.history.length === 0)) {
    return { ...NONE, primary: a?.kind === "run" ? card(a, "Start this pipeline from its first step") : null };
  }
  const graph = run.snapshot?.graph ?? null;
  const step = state.step?.id ? state.step.name : "step";
  const cap = effectiveStepCap(run);
  const blocked = run.status === "blocked";
  const cancelled = run.status === "cancelled";

  let primary: BandAction | null = null;
  const secondary: BandAction[] = [];
  let hint: string | null = null;
  let retried: string | null = null;

  const retry = (id: Extract<BandAction, { kind: "retry" }>["id"], label: string, title: string, stepTaskId: string | null): BandAction => {
    retried = stepTaskId ?? "";
    return { kind: "retry", id, label, title, stepTaskId };
  };

  switch (a?.kind) {
    case "retry":
      primary = cancelled
        ? retry("resume", a.label, `Continues ${step} where it was stopped. It does not restart the pipeline.`, a.stepTaskId)
        : state.kind === "step-cap"
          ? retry("extend-cap", "Extend cap", `Continues ${step} with another step allowance (now step cap ${run.stepCount} of ${cap}). It does not restart the pipeline.`, a.stepTaskId)
          : retry("retry", a.label, `Runs ${step} again in place. It does not restart the pipeline.`, a.stepTaskId);
      break;
    case "open": {
      const asking = steps.find((t) => (t.pendingInteractionCount ?? 0) > 0);
      const current = state.step?.id ? (run.active.find((x) => x.stepId === state.step!.id)?.taskId ?? [...run.history].filter((r) => r.stepId === state.step!.id).sort((x, y) => y.seq - x.seq)[0]?.taskId ?? null) : null;
      const taskId = asking?.id ?? current;
      primary = { kind: "open-step", label: a.label === "Open" ? `Open ${step}` : a.label, title: taskId ? `Opens ${step}'s panel` : "Opens the task's details", taskId };
      break;
    }
    case "inspect":
      // On the board this opens the inspector. Here the hold is on the page already.
      break;
    case "run":
    case "view-pr":
    case "fix-ci":
    case "open-dependency":
      primary = card(
        a,
        a.kind === "fix-ci"
          ? "Starts a follow-up step on the failing checks. It does not merge."
          : a.kind === "open-dependency"
            ? "Opens the task this one waits on"
            : a.kind === "run"
              ? "Start this pipeline"
              : "Opens the pull request",
      );
      break;
  }

  // Trying the stopped step now, where the card's own button is something else.
  if ((blocked || cancelled) && retried == null) {
    const held = run.blocked.find((b) => b.inputRetry != null);
    const scheduled = waitingInQueue(run) || run.autoRetry?.at != null;
    const retryable = run.blocked.find((b) => RETRY_BLOCK_KINDS.includes(b.kind));
    let now: BandAction | null = null;
    if (held && !scheduled) {
      now = retry(
        "recheck",
        "Recheck now",
        `Checks ${nameIn(graph, held.stepId)}'s input now instead of at ${clockTime(held.inputRetry!.at)}. This is the retry request: it also retries any other blocked execution of this run. It does not skip the input or restart the pipeline.`,
        null,
      );
    } else if (cancelled) {
      now = retry("resume", `Resume ${step}`, `Continues ${step} where it was stopped. It does not restart the pipeline.`, null);
    } else if (scheduled) {
      now = retry("retry-now", `Retry ${step} now`, `Tries ${step} now instead of waiting for the scheduled retry. It does not restart the pipeline.`, null);
    } else if (retryable) {
      now = retry("retry", `Retry ${nameIn(graph, retryable.stepId)}`, `Runs ${nameIn(graph, retryable.stepId)} again in place. It does not restart the pipeline.`, retryable.taskId);
    }
    if (now) {
      if (primary) secondary.push(now);
      else primary = now;
    }
  }

  // The other blocked executions of a fan-out, each by name.
  if (blocked && retried != null) {
    const seen = new Set<string>([retried]);
    const first = run.blocked.find((b) => RETRY_BLOCK_KINDS.includes(b.kind));
    // A retry without an execution id is the server's own pick: the first block.
    if (retried === "" && first?.taskId) seen.add(first.taskId);
    for (const b of run.blocked) {
      if (!RETRY_BLOCK_KINDS.includes(b.kind) || b.taskId == null || seen.has(b.taskId)) continue;
      seen.add(b.taskId);
      const name = nameIn(graph, b.stepId);
      secondary.push({ kind: "retry", id: "retry", label: `Retry ${name}`, title: `Runs ${name} again in place. It does not restart the pipeline.`, stepTaskId: b.taskId });
    }
  }

  if (hasLiveExecution(steps, run)) secondary.push({ kind: "stop", label: "Stop", title: "Stops the executing step. The run can be resumed from where it stopped." });

  const advance: AdvanceTarget[] = [
    ...run.blocked.filter(advanceable).map((b, i) => ({
      key: `block:${i}:${b.taskId ?? b.stepId ?? "run"}`,
      fromTaskId: b.taskId,
      stepName: nameIn(graph, b.stepId),
      why: b.kind === "handoff-missing" || b.kind === "handoff-invalid" ? "finished without a usable handoff" : b.kind === "join-incomplete" ? "its join is incomplete" : b.kind === "step-failed" ? "failed" : b.kind === "check-failed" ? "did not pass its checks (advancing records them as waived)" : "reported it is blocked",
    })),
    ...awaitingAdvance(run, steps).map((x) => ({ key: `review:${x.taskId}`, fromTaskId: x.taskId, stepName: nameIn(graph, x.stepId), why: "finished and waits for the next step to be chosen" })),
  ];
  if (blocked && retried == null && advance.length > 0) hint = "Retry cannot fix this stop. Advance… is under Advanced run controls.";
  else if (awaitingAdvance(run, steps).length > 0) hint = "A step finished and waits for the next step to be chosen: Advance… is under Advanced run controls.";

  return { primary, secondary, restart: RESTARTABLE_STATUSES.includes(run.status), advance, hint };
}

// ── Checks ────────────────────────────────────────────────────────────────

export type CheckStatus = "passing" | "failing" | "running" | "none" | "unavailable";

/** One observation of checks. Every source fills the same row, so a later
 *  per-step check record can be listed beside these. */
export interface CheckRow {
  /** `step-check`: one check of one evaluation of a step's gate, from the
   *  run's check ledger (src/bun/check-runner.ts). */
  source: "current-head" | "step-wait" | "activity" | "step-check";
  status: CheckStatus;
  /** "CI passed", "Checks failing: unit, e2e-web". */
  text: string;
  /** When it was observed; null when the source doesn't record it. */
  observedAt: number | null;
  /** The head commit it was observed on; null when the source doesn't record it. */
  head: string | null;
  /** Whether this row speaks for the pull request's current head. */
  currentHead: boolean;
  /** "as of 3:04 PM on abc1234", "recorded, head not recorded". */
  qualifier: string;
  /** The step that was executing when it was recorded, when one was. */
  duringStepId: string | null;
  url: string | null;
}

export interface ChecksEvidence {
  /** The current head's row, when a pull request is known. */
  current: CheckRow | null;
  /** Everything else, newest first. */
  recorded: CheckRow[];
  /** One sentence on what the rows can and cannot show. */
  note: string;
}

export interface CheckActivityEntry {
  ts: number;
  kind: string;
  text: string;
  tone: string;
  url?: string;
}

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * What is known about checks, honestly: the current head only from the PR
 * watcher's last look (`TaskPrStatus`), and earlier results only as the
 * events they were — a live CI wait, or a `ci` entry of the activity
 * timeline. Those carry no head commit, so none of them is ever presented
 * as the current head's result.
 */
export function checksEvidence(input: {
  pr: TaskPrStatus | null; run: PipelineRunState | null; activity: CheckActivityEntry[] | null; task: Task; now: number;
  /** The run's check ledger, oldest first; null or absent when there is none. */
  ledger?: CheckLedgerEntry[] | null;
}): ChecksEvidence {
  const { pr, run, activity, task, now } = input;
  const during = (ts: number): string | null => run?.history.find((r) => r.startedAt <= ts && ts <= (r.endedAt ?? now))?.stepId ?? null;

  let current: CheckRow | null = null;
  if (pr) {
    const own = pr.failingChecks.filter((c) => !c.alsoOnBase).map((c) => c.name);
    const inherited = pr.failingChecks.filter((c) => c.alsoOnBase).map((c) => c.name);
    const status: CheckStatus = pr.checks === "success" ? "passing" : pr.checks === "failure" ? "failing" : pr.checks === "pending" ? "running" : "none";
    const text =
      status === "passing"
        ? "Checks passing"
        : status === "running"
          ? "Checks running"
          : status === "none"
            ? "No checks reported"
            : [own.length ? `Checks failing: ${own.join(", ")}` : "Checks failing", inherited.length ? `also failing on ${pr.baseRef ?? "the base"}: ${inherited.join(", ")}` : null].filter(Boolean).join(" · ");
    current = {
      source: "current-head",
      status,
      text: pr.state === "open" ? text : `${text} (pull request ${pr.state})`,
      observedAt: pr.checkedAt,
      head: pr.headSha,
      currentHead: true,
      qualifier: `as of ${clockTime(pr.checkedAt)} on ${pr.headSha ? shortSha(pr.headSha) : "a head the watcher did not record"}`,
      duringStepId: null,
      url: pr.url,
    };
  }

  const recorded: CheckRow[] = [];
  for (const b of run?.blocked ?? []) {
    if (b.kind !== "await" || causeOf(b, task) !== "ci") continue;
    recorded.push({
      source: "step-wait",
      status: "running",
      text: `Waiting on ${b.message.match(/waiting on (.*?) — /)?.[1] ?? "CI"}`,
      observedAt: null,
      head: null,
      currentHead: false,
      qualifier: "a step is waiting on this now; head not recorded",
      duringStepId: b.stepId,
      url: null,
    });
  }
  for (const e of activity ?? []) {
    if (e.kind !== "ci") continue;
    recorded.push({
      source: "activity",
      status: /passed/i.test(e.text) ? "passing" : "failing",
      text: e.text,
      observedAt: e.ts,
      head: null,
      currentHead: false,
      qualifier: "recorded, head not recorded",
      duringStepId: during(e.ts),
      url: e.url ?? null,
    });
  }
  // A gated step's own checks, as Agetor ran them: each row names the head
  // it was computed for, so it is never read as another head's result.
  const ledger = input.ledger ?? [];
  for (const e of ledger) recorded.push(stepCheckRow(e, pr));
  recorded.sort((x, y) => (y.observedAt ?? now) - (x.observedAt ?? now));

  const stepChecks = ledger.length > 0 ? " Step checks are the ones Agetor ran when a step's turn ended, each for the head it names; they are not CI." : "";
  if (stepChecks) {
    const base = !pr
      ? "No pull request is known for this task, so the current head's CI checks are unavailable."
      : "Only the first row speaks for the pull request's current head.";
    return { current, recorded, note: `${base}${stepChecks}` };
  }
  const note = !pr
    ? "No pull request is known for this task, so the current head's checks are unavailable. Recorded events below are history, not a current result."
    : recorded.some((r) => r.status === "passing" && r.source === "activity")
      ? "A recorded pass is history: it does not show that the current head passes. Only the first row speaks for the current head."
      : "Only the first row speaks for the current head. No check record is kept per step.";
  return { current, recorded, note };
}

const STEP_CHECK_WORD: Record<CheckLedgerEntry["outcome"], string> = {
  pass: "passed", fail: "failed", skip: "not run", waived: "waived by the owner", halt: "could not be evaluated", void: "no longer stands",
};

/** One ledger line as a row of the Checks tab. */
export function stepCheckRow(e: CheckLedgerEntry, pr: Pick<TaskPrStatus, "headSha"> | null): CheckRow {
  const status: CheckStatus = e.outcome === "pass" || (e.outcome === "skip" && e.satisfied) ? "passing" : e.outcome === "fail" ? "failing" : e.outcome === "halt" ? "unavailable" : "none";
  const head = e.key.head;
  return {
    source: "step-check",
    status,
    text: `${e.checkId}: ${e.outcome === "skip" && e.satisfied ? "passed earlier, unchanged" : STEP_CHECK_WORD[e.outcome]}${e.detail ? ` — ${e.detail}` : ""}`,
    observedAt: e.at,
    head,
    // Agetor's own check of that commit; whether it is the PR's head is said, never assumed.
    currentHead: false,
    qualifier: [
      `${e.stepName} #${e.seq}, evaluation ${e.turn}`,
      head ? `on ${shortSha(head)}${pr?.headSha ? (pr.headSha === head ? " (the pull request's head)" : " (not the pull request's head)") : ""}` : "head not read",
      e.required ? null : "optional",
    ].filter(Boolean).join(" · "),
    duringStepId: e.stepId,
    url: null,
  };
}

// ── Words ─────────────────────────────────────────────────────────────────

/** "42s", "12m 40s", "3h 18m", "2d 4h". An execution's elapsed time, which
 *  can include waits. */
export function formatSpan(ms: number): string {
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A record's outcome in the view's words. A handoff is not a merge. */
export function outcomeLabel(record: Pick<PipelineStepRecord, "outcome" | "nextStepIds">, graph: PipelineGraph | null): string {
  switch (record.outcome) {
    case "succeeded":
      return record.nextStepIds.length > 0 ? `Handed off to ${[...new Set(record.nextStepIds)].map((id) => nameIn(graph, id)).join(", ")}` : "Handed off · end of pipeline";
    case "advanced-manually":
      return "Advanced manually";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    default:
      return "No outcome yet";
  }
}
