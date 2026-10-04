/**
 * One plain sentence per card — what it's doing, or what it's waiting on —
 * and, when it's the user's move, why and which button settles it. Derived
 * from the task, its pipeline run, its PR (src/bun/pr-watch.ts) and any lease
 * it holds or waits on (src/bun/lease-watch.ts). Feeds the card's status line
 * and the board's "Needs you" bar.
 */
import type { PipelineRunState, Task, TaskPrStatus } from "../../shared/types.ts";
import { handoffHeadline } from "../../shared/pipeline.ts";
import type { TaskLeaseInfo } from "./leases.ts";

export type NeedsYouAction = "open" | "retry" | "open-pr";

export interface CardStatus {
  /** The status line under the card's title. */
  line: string;
  tone: "muted" | "info" | "warning" | "danger" | "success";
  /** Set when the next move is the user's. */
  needsYou: { reason: string; action: NeedsYouAction; actionLabel: string } | null;
}

export function formatAge(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

const stepName = (run: PipelineRunState, stepId: string | null | undefined) =>
  run.snapshot?.graph.steps.find((s) => s.id === stepId)?.name ?? stepId ?? "a step";

function latestRecord(run: PipelineRunState, taskId: string | null | undefined) {
  let best: PipelineRunState["history"][number] | null = null;
  for (const r of run.history) if (r.taskId === taskId && (!best || r.seq > best.seq)) best = r;
  return best;
}

function prPhrase(pr: TaskPrStatus): { text: string; tone: CardStatus["tone"]; needsYou: CardStatus["needsYou"] } {
  const own = pr.failingChecks.filter((c) => !c.alsoOnBase && c.name !== "required");
  if (pr.checks === "failure" && own.length > 0) {
    return {
      text: `PR #${pr.number}: CI failing (${own.map((c) => c.name).slice(0, 2).join(", ")})`,
      tone: "danger",
      needsYou: { reason: `PR #${pr.number} CI failing`, action: "open", actionLabel: "Fix CI" },
    };
  }
  if (pr.checks === "failure") {
    return {
      text: `PR #${pr.number}: waiting on ${pr.baseRef ?? "base"} (same checks fail there)`,
      tone: "warning",
      needsYou: null,
    };
  }
  if (pr.unresolvedThreads > 0) {
    return {
      text: `PR #${pr.number}: ${pr.unresolvedThreads} review comment${pr.unresolvedThreads === 1 ? "" : "s"} to address`,
      tone: "warning",
      needsYou: { reason: `PR #${pr.number} has review comments`, action: "open", actionLabel: "Address" },
    };
  }
  if (pr.checks === "pending") return { text: `PR #${pr.number}: checks running`, tone: "info", needsYou: null };
  return {
    text: `PR #${pr.number}: ready to merge`,
    tone: "success",
    needsYou: { reason: `PR #${pr.number} ready to merge`, action: "open-pr", actionLabel: "Open PR" },
  };
}

export function cardStatus(
  task: Task,
  ctx: { pr: TaskPrStatus | null; lease: TaskLeaseInfo; now: number },
): CardStatus {
  const { pr, lease, now } = ctx;
  const asked = (task.pendingInteractionCount ?? 0) > 0;
  if (asked) {
    return {
      line: "Asked you a question",
      tone: "warning",
      needsYou: { reason: "asked a question", action: "open", actionLabel: "Answer" },
    };
  }
  if (pr?.state === "merged") return { line: `PR #${pr.number} merged`, tone: "success", needsYou: null };

  const run = task.pipelineRun ?? null;
  if (run) {
    if (run.status === "running") {
      const now_ = run.active
        .map((a) => {
          const rec = latestRecord(run, a.taskId);
          return `${stepName(run, a.stepId)}${rec ? ` · ${formatAge(now - rec.startedAt)}` : ""}`;
        })
        .join(" + ");
      const holds = lease.holds.length ? ` · holds ${lease.holds.join(", ")}` : "";
      return { line: `${now_ || "Starting"}${holds}`, tone: "info", needsYou: null };
    }

    if (run.status === "blocked") {
      const waiting = lease.waiting.find((w) => !w.free);
      if (waiting) {
        return { line: `Waiting for ${waiting.label} (held by ${waiting.heldBy})`, tone: "warning", needsYou: null };
      }
      const freed = lease.waiting.find((w) => w.free);
      const block = run.blocked[0];
      const step = stepName(run, block?.stepId);
      if (freed) {
        return {
          line: `${step} blocked — ${freed.label} is free now`,
          tone: "warning",
          needsYou: { reason: `${freed.label} is free — retry ${step}`, action: "retry", actionLabel: "Retry" },
        };
      }
      const why = handoffHeadline(latestRecord(run, block?.taskId)?.handoff) || block?.message || "blocked";
      const retryable = block && ["step-failed", "step-cap"].includes(block.kind);
      return {
        line: `${step} blocked: ${why}`,
        tone: "danger",
        needsYou: {
          reason: `${step} blocked`,
          action: retryable ? "retry" : "open",
          actionLabel: retryable ? "Retry" : "Open",
        },
      };
    }

    if (run.status === "cancelled") {
      return { line: `Stopped at ${stepName(run, run.active[0]?.stepId)}`, tone: "muted", needsYou: null };
    }

    // Finished: lead with the PR when there is one, else the result.
    const ends = run.history.filter((r) => r.handoff && r.nextStepIds.length === 0).sort((a, b) => b.seq - a.seq);
    const headline = handoffHeadline(ends[0]?.handoff);
    if (pr && pr.state === "open") {
      const p = prPhrase(pr);
      return { line: p.text, tone: p.tone, needsYou: task.column === "done" ? null : p.needsYou };
    }
    if (task.column === "done") return { line: headline || "Done", tone: "muted", needsYou: null };
    return {
      line: headline ? `Finished: ${headline}` : "Finished",
      tone: "success",
      needsYou: { reason: "finished — review the result", action: "open", actionLabel: "Review" },
    };
  }

  // A single-agent task.
  if (task.column === "running") {
    const todos = task.todoProgress && task.todoProgress.total > 0 ? ` · ${task.todoProgress.completed}/${task.todoProgress.total} todos` : "";
    return { line: `Working${todos}`, tone: "info", needsYou: null };
  }
  if (task.column === "blocked") {
    return { line: "Stopped — needs you", tone: "danger", needsYou: { reason: "stopped", action: "open", actionLabel: "Open" } };
  }
  if (pr && pr.state === "open") {
    const p = prPhrase(pr);
    return { line: p.text, tone: p.tone, needsYou: task.column === "done" ? null : p.needsYou };
  }
  if (task.column === "review") {
    return { line: "Finished — ready for review", tone: "success", needsYou: { reason: "finished", action: "open", actionLabel: "Review" } };
  }
  if (task.column === "done") return { line: "Done", tone: "muted", needsYou: null };
  return { line: task.column === "ready" ? "Ready to run" : "In backlog", tone: "muted", needsYou: null };
}

const NEEDS_YOU_ORDER: Record<NeedsYouAction, number> = { open: 1, retry: 0, "open-pr": 2 };

/** The cards waiting on the user, most urgent first: questions, then
 *  blocks/retries, then PR work, then results to review. */
export function needsYouList(items: { task: Task; status: CardStatus }[]): { task: Task; status: CardStatus }[] {
  const rank = (s: CardStatus) =>
    s.needsYou?.reason === "asked a question" ? 0 : s.line.includes("blocked") || s.needsYou?.action === "retry" ? 1 : s.needsYou?.reason.startsWith("PR #") ? 2 : 3;
  return items
    .filter((i) => i.status.needsYou && i.task.archivedAt == null && !i.task.pipelineParentId)
    .sort((a, b) => rank(a.status) - rank(b.status) || NEEDS_YOU_ORDER[a.status.needsYou!.action] - NEEDS_YOU_ORDER[b.status.needsYou!.action] || b.task.updatedAt - a.task.updatedAt);
}
