/**
 * What a board card shows: its current state (a colour family, a label and
 * an icon), the pipeline step it is on, the strip of steps, one line of
 * reason, and the one button for the user's next move. Three things stay
 * apart on purpose: the column is the workflow status, the step is where the
 * pipeline is, and the state is what is happening right now. The state is
 * read from the run, the PR and the leases, never from the column alone.
 *
 * Precedence follows `cardStatus` (card-status.ts), whose sentences this
 * reuses; the blocked branches lean on the wait queue's own helpers
 * (src/shared/block-wait.ts) and on `causeOf` (board-health.ts). Pure: the
 * caller passes `now`.
 */
import type { PipelineBlock, PipelineRunState, Task, TaskPrStatus } from "../../shared/types.ts";
import type { RoadmapCardInfo } from "../../shared/roadmap.ts";
import { neverStarted } from "../../shared/autopilot.ts";
import { blockReasonLine, effectiveStepCap, handoffHeadline, isFollowUpStepId, resolveStartStep } from "../../shared/pipeline.ts";
import { escalatedWait, escalationLine, issueRef, queuedWait, waitingInQueue, waitLine } from "../../shared/block-wait.ts";
import { ordinal } from "../../shared/block-reason.ts";
import type { TaskLeaseInfo } from "./leases.ts";
import { causeOf, WAIT_CAUSE_ORDER, type WaitCause } from "./board-health.ts";
import { latestRecord, mergePhrase, prPhrase, quietFor, stepName, type MergePhraseKind } from "./card-status.ts";
import { shortCardName } from "./card-names.ts";

/** The colour family. Blue is a wait that ends by itself; amber is the owner's move. */
export type CardStateTone = "working" | "waiting" | "needs" | "failed" | "merged" | "queued";

export type CardStateIcon = "activity" | "clock" | "alert" | "x" | "merge" | "dashed";

export const CARD_STATE_ICON: Record<CardStateTone, CardStateIcon> = {
  working: "activity",
  waiting: "clock",
  needs: "alert",
  failed: "x",
  merged: "merge",
  queued: "dashed",
};

export type CardStateKind =
  | "needs-input"
  | "merged"
  | "merge-train"
  | "dependency"
  | MergePhraseKind
  | "queued"
  | "working"
  | "awaiting"
  | "quiet"
  | "auto-retry"
  | "step-cap"
  | "needs-you"
  | "failed"
  | "stopped"
  | "ci-failed"
  | "review-pr"
  | "review-comments"
  | "update-branch"
  | "no-pr"
  | "review"
  | "done"
  | "no-activity"
  | "archived";

/** The card's one button. `retry` resumes the step that stopped, in place;
 *  restarting the whole pipeline is a different action and is never on the
 *  card (the inspector has it, behind its confirmation). */
export type CardAction =
  | { kind: "open"; label: string }
  | { kind: "run"; label: string }
  | { kind: "retry"; label: string; stepTaskId: string | null }
  | { kind: "inspect"; label: string }
  | { kind: "view-pr"; label: string; url: string }
  | { kind: "fix-ci"; label: string }
  | { kind: "open-dependency"; label: string; taskId: string };

export interface CardStripSegment {
  id: string;
  name: string;
  status: "done" | "current" | "todo";
}

export interface CardStep {
  /** Null when the run is over ("Complete"). */
  id: string | null;
  name: string;
  /** The step's nth execution in this run, when it has looped (2 or more). */
  round: number | null;
}

export interface CardState {
  kind: CardStateKind;
  state: CardStateTone;
  label: string;
  icon: CardStateIcon;
  reason: string;
  /** Null for a card without a started pipeline run. */
  step: CardStep | null;
  /** Null without a run snapshot (a single-agent task, a run not started). */
  strip: CardStripSegment[] | null;
  /** How long the active step has run, or a parked step has waited. */
  elapsedMs: number | null;
  action: CardAction | null;
}

export interface CardStateContext {
  pr: TaskPrStatus | null;
  lease: TaskLeaseInfo;
  now: number;
  progressActive?: boolean;
  roadmap?: RoadmapCardInfo | null;
}

/** "PR #12: checks running" → "Checks running": the card's id row already names the PR. */
function sansPr(line: string): string {
  const rest = line.replace(/^PR #\d+: /, "");
  return rest === line ? line : rest.charAt(0).toUpperCase() + rest.slice(1);
}

const clockTime = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * The pipeline's steps as equal segments, ordered from the start step along
 * the edges (steps the walk doesn't reach keep their array order, at the
 * end). Follow-up steps are not part of the pipeline and get no segment. A
 * segment is done only when it comes before the current step and has a
 * succeeded execution: after a loop back, the steps ahead are to do again.
 */
export function stepStrip(run: PipelineRunState, currentStepId: string | null): CardStripSegment[] | null {
  const graph = run.snapshot?.graph;
  if (!graph) return null;
  const steps = graph.steps.filter((s) => !isFollowUpStepId(s.id));
  if (steps.length === 0) return null;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const order: string[] = [];
  const seen = new Set<string>();
  const start = resolveStartStep(graph);
  const queue = start && byId.has(start.id) ? [start.id] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of graph.edges) if (e.from === id && byId.has(e.to) && !seen.has(e.to)) queue.push(e.to);
  }
  for (const s of steps) if (!seen.has(s.id)) order.push(s.id);
  const succeeded = new Set(run.history.filter((r) => r.outcome === "succeeded").map((r) => r.stepId));
  const at = currentStepId == null ? -1 : order.indexOf(currentStepId);
  return order.map((id, i) => ({
    id,
    name: byId.get(id)!.name,
    status: i === at ? "current" : succeeded.has(id) && (at < 0 || i < at) ? "done" : "todo",
  }));
}

function stepOf(run: PipelineRunState, stepId: string | null | undefined): CardStep | null {
  if (!stepId) return null;
  const rounds = run.history.filter((r) => r.stepId === stepId).length;
  return { id: stepId, name: stepName(run, stepId), round: rounds > 1 ? rounds : null };
}

/** The block that says most about why the card stopped: the most actionable
 *  cause first, as the board's grouping ranks them. */
function topBlock(run: PipelineRunState, task: Task): { block: PipelineBlock; cause: WaitCause } | null {
  return (
    run.blocked
      .map((block) => ({ block, cause: causeOf(block, task) }))
      .sort((a, b) => WAIT_CAUSE_ORDER.indexOf(a.cause) - WAIT_CAUSE_ORDER.indexOf(b.cause))[0] ?? null
  );
}

const MERGE_LABEL: Record<MergePhraseKind, { state: CardStateTone; label: string }> = {
  "opening-pr": { state: "waiting", label: "Opening PR" },
  "pr-closed": { state: "needs", label: "PR closed" },
  draft: { state: "needs", label: "Draft PR" },
  "updating-branch": { state: "waiting", label: "Updating branch" },
  "fixing-ci": { state: "waiting", label: "Fixing CI" },
  "base-failing": { state: "waiting", label: "Waiting on base" },
  "addressing-review": { state: "waiting", label: "Addressing review" },
  merging: { state: "waiting", label: "Merging" },
  "waiting-ci": { state: "waiting", label: "Waiting on CI" },
};

export function cardState(task: Task, ctx: CardStateContext): CardState {
  const { pr, lease, now } = ctx;
  // A pipeline card nothing has run yet has no run to describe.
  const run = task.pipelineRun && !(task.pipelineRun.status === "idle" && task.pipelineRun.history.length === 0) ? task.pipelineRun : null;
  const prUrl = pr?.url ?? task.prUrl ?? null;
  const viewPr = (label: string): CardAction | null => (prUrl ? { kind: "view-pr", label, url: prUrl } : null);
  const open = (label = "Open"): CardAction => ({ kind: "open", label });

  let step: CardStep | null = null;
  const make = (
    state: CardStateTone,
    kind: CardStateKind,
    label: string,
    reason: string,
    action: CardAction | null = null,
    elapsedMs: number | null = null,
  ): CardState => ({
    kind,
    state,
    label,
    icon: CARD_STATE_ICON[state],
    reason,
    step,
    strip: run ? stepStrip(run, step?.id ?? null) : null,
    elapsedMs,
    action,
  });

  // The step the run is on, before any state is decided: every card of a
  // started run shows it, whatever else is true of the card.
  if (run) {
    if (run.status === "done") step = { id: null, name: "Complete", round: null };
    else {
      const parked = queuedWait(run) ?? escalatedWait(run);
      const stopped = run.status === "cancelled" ? [...run.history].sort((a, b) => b.seq - a.seq).find((r) => r.outcome === "cancelled") : undefined;
      step = stepOf(
        run,
        run.active[0]?.stepId ?? parked?.stepId ?? (run.autoRetry?.at != null ? run.autoRetry.stepId : null) ?? topBlock(run, task)?.block.stepId ?? stopped?.stepId,
      );
    }
  }

  if (task.archivedAt != null) return make("queued", "archived", "Archived", "Archived — unarchive it to work on it again");

  const asked = task.pendingInteractionCount ?? 0;
  if (asked > 0) {
    return make("needs", "needs-input", "Needs input", asked === 1 ? "Asked you a question" : `Asked you ${asked} questions`, open(asked > 1 ? `Answer (${asked})` : "Answer"));
  }
  if (pr?.state === "merged") return make("merged", "merged", "Merged", `PR #${pr.number} merged${pr.baseRef ? ` into ${pr.baseRef}` : ""}`);
  // Merge trains (src/bun/merge-train.ts): the original PR is closed, not merged.
  if (task.mergeTrain?.state === "merged") return make("merged", "merged", "Merged", `Merged in merge train #${task.mergeTrain.pr}`);
  if (task.mergeTrain?.state === "riding" && task.column === "merge") {
    return make("waiting", "merge-train", "In merge train", `Train #${task.mergeTrain.pr} merges with the others when its CI passes`, {
      kind: "view-pr",
      label: "Inspect PR",
      url: task.mergeTrain.url,
    });
  }

  // Waiting on other cards (src/bun/dependencies.ts): it moves on by itself
  // when they land. A running card keeps its live state.
  const waitingOn = (task.blockedBy ?? []).filter((d) => !d.satisfied);
  if (waitingOn.length > 0 && task.column !== "running" && task.column !== "done") {
    const names = waitingOn.map((d) => d.ref ?? shortCardName(d.title)).join(", ");
    const detail = waitingOn.length === 1 ? ` · ${waitingOn[0]!.detail}` : "";
    return make("queued", "dependency", "Dependency", `Waiting on ${names}${detail}`, { kind: "open-dependency", label: "Open dependency", taskId: waitingOn[0]!.taskId });
  }

  // Ready to Merge: Agetor works the PR to green and merges it
  // (src/bun/merge-queue.ts). The state is the part it is on.
  if (task.column === "merge") {
    const m = mergePhrase(pr);
    const { state, label } = MERGE_LABEL[m.kind];
    const action = m.kind === "pr-closed" ? open() : m.kind === "draft" ? (viewPr("Open PR") ?? open()) : viewPr("Inspect PR");
    return make(state, m.kind, label, sansPr(m.line), action);
  }

  // A roadmap step's card waiting in the backlog: what the roadmap says it waits on.
  if (ctx.roadmap && neverStarted(task)) return make("queued", "queued", "Queued", ctx.roadmap.line, { kind: "run", label: "Run" });

  if (run) {
    if (run.status === "running") {
      const holds = lease.holds.length ? ` · holds ${lease.holds.join(", ")}` : "";
      // Steps queued for a free slot (src/bun/step-slots.ts): nothing is executing.
      const queued = run.blocked.filter((b) => b.kind === "slot-wait");
      if (queued.length > 0 && run.active.length === 0) {
        step = stepOf(run, queued[0]!.stepId);
        return make("queued", "queued", "Queued", "Starts when a slot frees up");
      }
      // Every active step is parked on a long command (src/bun/awaits.ts).
      const awaiting = run.blocked.filter((b) => b.kind === "await");
      if (awaiting.length > 0 && awaiting.length === run.active.length) {
        const what = awaiting.map((b) => b.message.match(/waiting on (.*?) — /)?.[1] ?? "a long command").join(", ");
        const onCi = awaiting.some((b) => causeOf(b, task) === "ci");
        return make("waiting", "awaiting", onCi ? "Waiting on CI" : "Waiting on command", `Resumes when ${what} finishes${holds}`, onCi ? viewPr("Inspect CI") : null);
      }
      if (run.active.length === 0) return make("queued", "queued", "Queued", "No step is running yet");
      const started = run.active.map((a) => latestRecord(run, a.taskId)?.startedAt).filter((t): t is number => t != null);
      const elapsedMs = started.length > 0 ? Math.max(0, now - Math.max(...started)) : null;
      const quiet = quietFor(task, ctx);
      if (quiet) return make("needs", "quiet", "Quiet", `${step?.name ?? "The agent"} has said nothing for ${quiet}${holds}`, open("Check"), elapsedMs);
      const resumed = queuedWait(run);
      const wrapUp = run.capWrapUp && (run.capWrapUp.seq == null || run.active.some((a) => a.seq === run.capWrapUp!.seq));
      const others = run.active.slice(1).map((a) => stepName(run, a.stepId));
      const doing = wrapUp
        ? "Wrapping up: the run reached its step cap"
        : resumed?.state === "resuming"
          ? "Resumed to check whether its block has cleared"
          : started.length === 0
            ? "Step is starting"
            : others.length > 0
              ? `Agents are working (also ${others.join(", ")})`
              : "Agent is working";
      return make("working", "working", "Working", `${doing}${holds}`, null, elapsedMs);
    }

    if (run.status === "blocked") {
      const inLine = (w: { position: number; queueLength: number }) => (w.queueLength > 1 ? `, ${ordinal(w.position)} of ${w.queueLength} in line` : "");
      // Parked in the blocked-step wait queue: retried by itself.
      const parked = waitingInQueue(run) ? run.wait! : null;
      if (parked) {
        const name = stepName(run, parked.stepId);
        const onLease = parked.category === "resource" && parked.ref != null ? lease.waiting.find((w) => w.label.toLowerCase() === parked.ref!.toLowerCase()) : undefined;
        const line = waitLine(name, parked, now, onLease != null || (parked.category === "dependency" && (parked.ref === "base-ci" || issueRef(parked.ref) != null)));
        const held = onLease && !onLease.free ? ` (held by ${onLease.heldBy}${inLine(onLease)})` : "";
        const reason = (held ? line.replace(" — retrying ", `${held} — retrying `) : line).replace(`${name} `, "");
        const waited = Math.max(0, now - parked.since);
        if (parked.category === "dependency") {
          // The card it waits on, when the board knows it as one of this card's dependencies.
          const dep = (task.blockedBy ?? []).find((d) => d.ref != null && d.ref === parked.ref);
          return make(
            "queued",
            "dependency",
            "Dependency",
            reason.charAt(0).toUpperCase() + reason.slice(1),
            dep ? { kind: "open-dependency", label: "Open dependency", taskId: dep.taskId } : { kind: "inspect", label: "Inspect retry" },
            waited,
          );
        }
        return make("waiting", "auto-retry", "Auto retry", reason.charAt(0).toUpperCase() + reason.slice(1), { kind: "inspect", label: "Inspect retry" }, waited);
      }
      // The queue gave it up: the owner's now, with what was tried.
      const gaveUp = escalatedWait(run);
      if (gaveUp) return make("needs", "needs-you", "Needs you", escalationLine(stepName(run, gaveUp.stepId), gaveUp, now).line, open());
      // A watched lease another checkout holds: the lease watcher retries
      // the first in line when it frees (src/bun/lease-watch.ts).
      const waiting = lease.waiting.find((w) => !w.free);
      if (waiting) {
        return make("waiting", "auto-retry", "Auto retry", `Waiting for ${waiting.label} (held by ${waiting.heldBy}${inLine(waiting)})`, { kind: "inspect", label: "Inspect retry" });
      }
      // A usage-limit reset or a transient-failure backoff (src/bun/pipeline-runner.ts `scheduleAutoRetry`).
      const retry = run.autoRetry;
      if (retry?.at != null) {
        const reason = retry.kind === "quota" ? `Waiting for the usage limit to reset · retries at ${clockTime(retry.at)}` : `Failed · retries at ${clockTime(retry.at)} · attempt ${retry.attempt}`;
        return make("waiting", "auto-retry", "Auto retry", reason, { kind: "inspect", label: "Inspect retry" });
      }
      // A launch held for an input that is not there yet: re-checked on a timer.
      const held = run.blocked.find((b) => b.inputRetry != null);
      if (held) {
        step = stepOf(run, held.stepId) ?? step;
        const why = blockReasonLine(null, held.message, 90) || "Waiting for an input";
        return make("waiting", "auto-retry", "Auto retry", `${why} · re-checks at ${clockTime(held.inputRetry!.at)} · attempt ${held.inputRetry!.attempt}`, { kind: "inspect", label: "Inspect retry" });
      }
      const top = topBlock(run, task);
      const block = top?.block;
      const name = stepName(run, block?.stepId);
      const retryStep = (verb = "Retry"): CardAction => ({ kind: "retry", label: `${verb} ${name}`, stepTaskId: block?.taskId ?? null });
      const freed = lease.waiting.find((w) => w.free);
      // Someone ahead in line gets the free lease first.
      if (freed && freed.position > 1) return make("waiting", "auto-retry", "Auto retry", `Waiting for ${freed.label}${inLine(freed)}`, { kind: "inspect", label: "Inspect retry" });
      if (freed) return make("needs", "needs-you", "Needs you", `${freed.label} is free now`, retryStep());
      if (block?.kind === "step-cap") {
        return make("needs", "step-cap", "Step cap", `Reached the ${effectiveStepCap(run)}-step cap`, retryStep());
      }
      const handoff = latestRecord(run, block?.taskId)?.handoff;
      const why = blockReasonLine(handoff, block?.message) || "Blocked";
      if (block?.kind === "profile-missing" || top?.cause === "failed") return make("failed", "failed", "Failed", why, retryStep());
      // A usage limit with no retry scheduled waits on the owner like any other stop.
      if (top?.cause === "limit") return make("needs", "needs-you", "Needs you", why, retryStep());
      const question = handoff?.openQuestions?.find((q) => q.trim());
      return make("needs", "needs-you", "Needs you", question ? `Asks: ${question}` : why, open());
    }

    if (run.status === "cancelled") {
      const stoppedTask = run.active[0]?.taskId ?? null;
      return make("queued", "stopped", "Stopped", step ? `Stopped at ${step.name}` : "Stopped", {
        kind: "retry",
        label: step ? `Resume ${step.name}` : "Resume step",
        stepTaskId: stoppedTask,
      });
    }

    // Finished: lead with the PR when there is one, else the result.
    const ends = run.history.filter((r) => r.handoff && r.nextStepIds.length === 0).sort((a, b) => b.seq - a.seq);
    const headline = handoffHeadline(ends[0]?.handoff);
    if (pr?.state === "open") return fromPr(pr, run.status === "done");
    if (task.column === "done") return make("queued", "done", "Done", headline || "Done");
    if (pr?.state === "closed") return make("needs", "pr-closed", "PR closed", `PR #${pr.number} was closed without merging`, viewPr("Inspect PR") ?? open());
    return make("needs", "no-pr", "No PR yet", headline || "Finished, but no PR yet", open());
  }

  // A single-agent task.
  if (task.column === "running") {
    const todos = task.todoProgress && task.todoProgress.total > 0 ? ` · ${task.todoProgress.completed}/${task.todoProgress.total} todos` : "";
    const quiet = quietFor(task, ctx);
    if (quiet) return make("needs", "quiet", "Quiet", `The agent has said nothing for ${quiet}${todos}`, open("Check"));
    // The column alone doesn't say an agent is executing; its activity does.
    if (task.lastActivityAt != null || ctx.progressActive) return make("working", "working", "Working", `Agent is working${todos}`);
    return make("queued", "no-activity", "No activity yet", "In Running, but the agent has reported nothing yet");
  }
  if (task.column === "blocked") return make("needs", "needs-you", "Needs you", "Stopped — open it to see why", open("Review"));
  if (pr?.state === "open") return fromPr(pr, false);
  if (pr?.state === "closed" && task.column !== "done") {
    return make("needs", "pr-closed", "PR closed", `PR #${pr.number} was closed without merging`, viewPr("Inspect PR") ?? open());
  }
  if (task.column === "review") return make("needs", "review", "Review", "Finished — ready for review", open("Review"));
  if (task.column === "done") return make("queued", "done", "Done", "Done");
  const fresh = neverStarted(task) && !task.hasOpenableRun;
  return make("queued", "queued", "Queued", task.column === "ready" ? "Ready to run" : fresh ? "In backlog — not started" : "In backlog", fresh ? { kind: "run", label: "Run" } : null);

  /** An open PR on a card outside Ready to Merge. `canFix`: the card is a
   *  finished pipeline, the only thing the fix-CI follow-up runs on. */
  function fromPr(open_: TaskPrStatus, canFix: boolean): CardState {
    const p = prPhrase(open_);
    const text = sansPr(p.text);
    // In Done the owner has already closed the card out: say what the PR
    // is doing, ask for nothing.
    const done = task.column === "done";
    switch (p.kind) {
      case "ci-failed":
        return make("failed", "ci-failed", "CI failed", text, done ? null : canFix ? { kind: "fix-ci", label: "Fix CI" } : open());
      case "base-failing":
        return make("waiting", "base-failing", "Waiting on base", text, viewPr("Inspect PR"));
      case "checks-running":
        return make("waiting", "waiting-ci", "Waiting on CI", text, viewPr("Inspect CI"));
      case "update-branch":
        return done ? make("queued", "done", "Done", text) : make("needs", "update-branch", "Update branch", text, open());
      case "review-comments":
        return done ? make("queued", "done", "Done", text) : make("needs", "review-comments", "Review comments", text, open());
      default:
        return done ? make("queued", "done", "Done", text) : make("needs", "review-pr", "Review PR", text, viewPr("Review PR") ?? open());
    }
  }
}

/** A column's one-line summary of its cards' states: "2 working · 1 needs you". */
export function columnSummary(states: Pick<CardState, "state">[]): string {
  const count = (tone: CardStateTone) => states.filter((s) => s.state === tone).length;
  const part = (n: number, one: string, many = one) => (n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  return [
    part(count("needs"), "needs you", "need you"),
    part(count("failed"), "failed"),
    part(count("working"), "working"),
    part(count("waiting"), "waiting"),
    part(count("queued"), "queued"),
    part(count("merged"), "merged"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "2m", "1h 5m"; under a minute reads "<1m". */
export function formatElapsed(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}
