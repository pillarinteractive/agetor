/**
 * One plain sentence per card — what it's doing, or what it's waiting on —
 * and, when it's the user's move, why and which button settles it. Derived
 * from the task, its pipeline run, its PR (src/bun/pr-watch.ts) and any lease
 * it holds or waits on (src/bun/lease-watch.ts). Feeds the card's status line
 * and the board's "Needs you" bar.
 */
import type { PipelineRunState, Task, TaskPrStatus } from "../../shared/types.ts";
import { currentRoadmapStatus, offerPending, type RoadmapCardInfo, type RoadmapNextMilestone, type RoadmapStatus, type RoadmapStepLinks } from "../../shared/roadmap.ts";
import { neverStarted } from "../../shared/autopilot.ts";
import { blockReasonLine, handoffHeadline } from "../../shared/pipeline.ts";
import type { TaskLeaseInfo } from "./leases.ts";
import { ordinal } from "../../shared/block-reason.ts";
import { shortCardName } from "./card-names.ts";
import { escalatedWait, escalationLine, issueRef, waitingInQueue, waitLine } from "../../shared/block-wait.ts";

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

export const stepName = (run: PipelineRunState, stepId: string | null | undefined) =>
  run.snapshot?.graph.steps.find((s) => s.id === stepId)?.name ?? stepId ?? "a step";

export function latestRecord(run: PipelineRunState, taskId: string | null | undefined) {
  let best: PipelineRunState["history"][number] | null = null;
  for (const r of run.history) if (r.taskId === taskId && (!best || r.seq > best.seq)) best = r;
  return best;
}

/** Which of an open PR's situations {@link prPhrase} described. */
export type PrPhraseKind = "update-branch" | "ci-failed" | "base-failing" | "review-comments" | "checks-running" | "no-checks" | "review-pr";

/** An open PR in one sentence, outside Ready to Merge. */
export function prPhrase(pr: TaskPrStatus): { kind: PrPhraseKind; text: string; tone: CardStatus["tone"]; needsYou: CardStatus["needsYou"] } {
  const behind = (pr.behindBy ?? 0) > 0;
  // Same rule as pr-watch.ts ownFailures: inherited, rollup, and (when behind)
  // already-fixed-on-base failures aren't the PR's.
  const own = pr.failingChecks.filter((c) => !c.alsoOnBase && c.name !== "required" && !(behind && c.passesOnBase));
  if (pr.checks === "failure" && own.length === 0 && behind && pr.failingChecks.some((c) => c.passesOnBase)) {
    return {
      kind: "update-branch",
      text: `PR #${pr.number}: behind ${pr.baseRef ?? "base"}, which fixed its failing checks — update the branch`,
      tone: "warning",
      needsYou: { reason: `PR #${pr.number} needs its branch updated`, action: "open", actionLabel: "Open" },
    };
  }
  if (pr.checks === "failure" && own.length > 0) {
    return {
      kind: "ci-failed",
      text: `PR #${pr.number}: CI failing (${own.map((c) => c.name).slice(0, 2).join(", ")})`,
      tone: "danger",
      needsYou: { reason: `PR #${pr.number} CI failing`, action: "open", actionLabel: "Fix CI" },
    };
  }
  if (pr.checks === "failure") {
    return {
      kind: "base-failing",
      text: `PR #${pr.number}: waiting on ${pr.baseRef ?? "base"} (same checks fail there)`,
      tone: "warning",
      needsYou: null,
    };
  }
  if (pr.unresolvedThreads > 0) {
    return {
      kind: "review-comments",
      text: `PR #${pr.number}: ${pr.unresolvedThreads} review comment${pr.unresolvedThreads === 1 ? "" : "s"} to address`,
      tone: "warning",
      needsYou: { reason: `PR #${pr.number} has review comments`, action: "open", actionLabel: "Address" },
    };
  }
  if (pr.checks === "pending") return { kind: "checks-running", text: `PR #${pr.number}: checks running`, tone: "info", needsYou: null };
  // No check has reported: that is not a pass, so it doesn't read as one.
  if (pr.checks === "none") {
    return {
      kind: "no-checks",
      text: `PR #${pr.number}: no checks reported — review it`,
      tone: "warning",
      needsYou: { reason: `PR #${pr.number} has no checks to go by`, action: "open-pr", actionLabel: "Review PR" },
    };
  }
  return {
    kind: "review-pr",
    text: `PR #${pr.number}: checks pass — review and sign off`,
    tone: "success",
    needsYou: { reason: `PR #${pr.number} ready for your review`, action: "open-pr", actionLabel: "Review PR" },
  };
}

/** How long a running card's agents have said nothing, once that's past
 *  {@link QUIET_AFTER_MS} — or null. A live lab/E2E run reporting progress
 *  isn't quiet: a long test command legitimately produces no transcript. */
export const QUIET_AFTER_MS = 20 * 60_000;
export function quietFor(task: Task, ctx: { now: number; progressActive?: boolean }): string | null {
  if (ctx.progressActive || task.lastActivityAt == null) return null;
  const ms = ctx.now - task.lastActivityAt;
  return ms >= QUIET_AFTER_MS ? formatAge(ms) : null;
}

/** Which part of merging {@link mergePhrase} described. */
export type MergePhraseKind = "opening-pr" | "pr-closed" | "draft" | "updating-branch" | "fixing-ci" | "base-failing" | "addressing-review" | "merging" | "waiting-ci";

/** A Ready to Merge card in one sentence: the part of merging it is on. */
export function mergePhrase(pr: TaskPrStatus | null): CardStatus & { kind: MergePhraseKind } {
  if (!pr) return { kind: "opening-pr", line: "Opening a PR so it can merge", tone: "info", needsYou: null };
  const n = `PR #${pr.number}`;
  if (pr.state === "closed") {
    return { kind: "pr-closed", line: `${n} was closed — can't merge`, tone: "danger", needsYou: { reason: `${n} was closed`, action: "open", actionLabel: "Open" } };
  }
  if (pr.draft) return { kind: "draft", line: `${n} is a draft — can't merge`, tone: "warning", needsYou: { reason: `${n} is a draft`, action: "open-pr", actionLabel: "Open PR" } };
  if ((pr.behindBy ?? 0) > 0) return { kind: "updating-branch", line: `${n}: updating from ${pr.baseRef ?? "base"}, then merging`, tone: "info", needsYou: null };
  if (pr.checks === "failure") {
    const p = prPhrase(pr);
    return p.needsYou
      ? { kind: "fixing-ci", line: `${n}: CI failing — fixing before merge`, tone: "warning", needsYou: null }
      : { kind: "base-failing", line: `${n}: waiting on ${pr.baseRef ?? "base"} (same checks fail there)`, tone: "warning", needsYou: null };
  }
  if (pr.unresolvedThreads > 0) return { kind: "addressing-review", line: `${n}: addressing review comments, then merging`, tone: "info", needsYou: null };
  if (pr.checks === "success") return { kind: "merging", line: `${n}: green — merging`, tone: "success", needsYou: null };
  return { kind: "waiting-ci", line: `${n}: merges when checks pass`, tone: "info", needsYou: null };
}

/** A PR closed without merging, on a card that is not in Ready to Merge or
 *  Done: the card has no live PR, which is not the same as never having one. */
export function closedPrStatus(pr: TaskPrStatus): CardStatus {
  const n = `PR #${pr.number}`;
  return { line: `${n} was closed without merging`, tone: "warning", needsYou: { reason: `${n} was closed without merging`, action: "open", actionLabel: "Open" } };
}

export function cardStatus(
  task: Task,
  ctx: {
    pr: TaskPrStatus | null;
    lease: TaskLeaseInfo;
    now: number;
    progressActive?: boolean;
    /** What Autopilot's roadmap says about this card while it waits in the
     *  backlog, never started (src/shared/roadmap.ts `roadmapCardLine`). */
    roadmap?: RoadmapCardInfo | null;
  },
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
  // Merge trains (src/bun/merge-train.ts): the original PR is closed, not
  // merged — say where it went.
  if (task.mergeTrain?.state === "merged") return { line: `Merged in merge train #${task.mergeTrain.pr}`, tone: "success", needsYou: null };
  if (task.mergeTrain?.state === "riding" && task.column === "merge") {
    return { line: `In merge train #${task.mergeTrain.pr} — merges with the others when its CI passes`, tone: "info", needsYou: null };
  }

  // Waiting on other cards (src/bun/dependencies.ts): that's the whole story
  // until they land — the card moves on by itself then. A running card keeps
  // its live line (the chip still shows the dependency).
  const waitingOn = (task.blockedBy ?? []).filter((d) => !d.satisfied);
  if (waitingOn.length && task.column !== "running" && task.column !== "done") {
    const names = waitingOn.map((d) => d.ref ?? shortCardName(d.title)).join(", ");
    const detail = waitingOn.length === 1 ? ` · ${waitingOn[0]!.detail}` : "";
    return { line: `Waiting on ${names}${detail}`, tone: "warning", needsYou: null };
  }

  // Ready to Merge: signed off — Agetor is working the PR to green and will
  // merge it (src/bun/merge-queue.ts). Say which part it's on.
  if (task.column === "merge") {
    const m = mergePhrase(pr);
    return { line: m.line, tone: m.tone, needsYou: m.needsYou };
  }

  // A roadmap step's card waiting in the backlog: its step and what it waits
  // on. The owner's ready steps are in the Needs you strip already (by
  // step, with the issue link), so the card doesn't ask twice.
  if (ctx.roadmap && neverStarted(task)) return { line: ctx.roadmap.line, tone: ctx.roadmap.tone, needsYou: null };

  // A pipeline card nothing has run yet has no run to describe.
  const run = task.pipelineRun && !(task.pipelineRun.status === "idle" && task.pipelineRun.history.length === 0) ? task.pipelineRun : null;
  if (run) {
    if (run.status === "running") {
      const quiet = quietFor(task, ctx);
      const now_ = run.active
        .map((a) => {
          const rec = latestRecord(run, a.taskId);
          // "Review step running · started just now" — a bare step name ("Review")
          // reads like the board's In Review column.
          if (!rec) return `${stepName(run, a.stepId)} step starting`;
          const age = formatAge(now - rec.startedAt);
          return `${stepName(run, a.stepId)} step running · ${age === "just now" ? "started just now" : age}`;
        })
        .join(" + ");
      const holds = lease.holds.length ? ` · holds ${lease.holds.join(", ")}` : "";
      // Steps queued for a free slot (src/bun/step-slots.ts).
      const queued = run.blocked.filter((b) => b.kind === "slot-wait").map((b) => stepName(run, b.stepId));
      if (queued.length && run.active.length === 0) {
        return { line: `${queued.join(" + ")} queued — starts when a slot frees up`, tone: "muted", needsYou: null };
      }
      // Steps parked on a long command (src/bun/awaits.ts) — woken when it exits.
      const awaiting = run.blocked.filter((b) => b.kind === "await");
      if (awaiting.length && awaiting.length === run.active.length) {
        const what = awaiting.map((b) => b.message.match(/waiting on (.*?) — /)?.[1] ?? "a long command").join(", ");
        return { line: `${awaiting.map((b) => stepName(run, b.stepId)).join(" + ")} waiting on ${what}${holds}`, tone: "info", needsYou: null };
      }
      if (quiet) {
        const step = stepName(run, run.active[0]?.stepId);
        return {
          line: `${now_ || "Starting"}${holds} · quiet ${quiet}`,
          tone: "warning",
          needsYou: { reason: `${step} has been quiet for ${quiet}`, action: "open", actionLabel: "Check" },
        };
      }
      return { line: `${now_ || "Starting"}${holds}`, tone: "info", needsYou: null };
    }

    if (run.status === "blocked") {
      const waiting = lease.waiting.find((w) => !w.free);
      const inLine = (w: { position: number; queueLength: number }) =>
        w.queueLength > 1 ? `, ${ordinal(w.position)} of ${w.queueLength} in line` : "";
      // Parked in the blocked-step wait queue (src/shared/block-wait.ts): it
      // is retried by itself — what it waits on, when, and which attempt.
      const parked = waitingInQueue(run) ? run.wait! : null;
      if (parked) {
        const name = stepName(run, parked.stepId);
        const onLease = parked.category === "resource" && parked.ref != null ? lease.waiting.find((w) => w.label.toLowerCase() === parked.ref!.toLowerCase()) : undefined;
        const line = waitLine(name, parked, now, onLease != null || (parked.category === "dependency" && (parked.ref === "base-ci" || issueRef(parked.ref) != null)));
        const held = onLease && !onLease.free ? ` (held by ${onLease.heldBy}${inLine(onLease)})` : "";
        return { line: held ? line.replace(" — retrying ", `${held} — retrying `) : line, tone: "muted", needsYou: null };
      }
      // The queue gave it up: the owner's now, with what was tried.
      const gaveUp = escalatedWait(run);
      if (gaveUp) {
        const e = escalationLine(stepName(run, gaveUp.stepId), gaveUp, now);
        return { line: e.line, tone: "danger", needsYou: { reason: e.reason, action: "open", actionLabel: "Open" } };
      }
      if (waiting) {
        return {
          line: `Waiting for ${waiting.label} (held by ${waiting.heldBy}${inLine(waiting)})`,
          tone: "warning",
          needsYou: null,
        };
      }
      // An automatic retry is pending (src/bun/pipeline-runner.ts
      // `scheduleAutoRetry`): a usage-limit reset or a transient-failure
      // backoff. Nothing for the user to do.
      const retry = run.autoRetry;
      if (retry?.at != null) {
        const at = new Date(retry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const name = stepName(run, retry.stepId);
        return retry.kind === "quota"
          ? { line: `${name} waiting for the usage limit to reset · retries at ${at}`, tone: "muted", needsYou: null }
          : { line: `${name} failed · retrying automatically at ${at} (attempt ${retry.attempt})`, tone: "warning", needsYou: null };
      }
      const freed = lease.waiting.find((w) => w.free);
      const block = run.blocked[0];
      const step = stepName(run, block?.stepId);
      if (freed && freed.position > 1) {
        // Someone ahead in line gets the free lease first.
        return { line: `Waiting for ${freed.label}${inLine(freed)}`, tone: "warning", needsYou: null };
      }
      if (freed) {
        return {
          line: `${step} blocked — ${freed.label} is free now`,
          tone: "warning",
          needsYou: { reason: `${freed.label} is free — retry ${step}`, action: "retry", actionLabel: "Retry" },
        };
      }
      // Why it stopped (its handoff's reason), and what it's asking, if anything.
      const handoff = latestRecord(run, block?.taskId)?.handoff;
      const why = blockReasonLine(handoff, block?.message) || "blocked";
      const question = handoff?.openQuestions?.find((q) => q.trim());
      const retryable = block && ["step-failed", "step-cap"].includes(block.kind);
      return {
        line: `${step} stopped: ${why}`,
        tone: "danger",
        needsYou: {
          reason: question ? `${step} asks: ${question}` : `${step} stopped`,
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
    if (pr?.state === "closed") return closedPrStatus(pr);
    // In Review is for a PR; a finished run without one needs one first.
    return {
      line: headline ? `No PR yet — ${headline}` : "Finished, but no PR yet",
      tone: "warning",
      needsYou: { reason: "finished without a PR — open one to review", action: "open", actionLabel: "Open" },
    };
  }

  // A single-agent task.
  if (task.column === "running") {
    const todos = task.todoProgress && task.todoProgress.total > 0 ? ` · ${task.todoProgress.completed}/${task.todoProgress.total} todos` : "";
    const quiet = quietFor(task, ctx);
    if (quiet) {
      return {
        line: `Working${todos} · quiet ${quiet}`,
        tone: "warning",
        needsYou: { reason: `quiet for ${quiet}`, action: "open", actionLabel: "Check" },
      };
    }
    return { line: `Working${todos}`, tone: "info", needsYou: null };
  }
  if (task.column === "blocked") {
    return { line: "Stopped — needs you", tone: "danger", needsYou: { reason: "stopped", action: "open", actionLabel: "Open" } };
  }
  if (pr && pr.state === "open") {
    const p = prPhrase(pr);
    return { line: p.text, tone: p.tone, needsYou: task.column === "done" ? null : p.needsYou };
  }
  if (pr?.state === "closed" && task.column !== "done") return closedPrStatus(pr);
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

/** The part of Autopilot's config that says which run a status belongs to. */
type RoadmapConfigRef = { roadmap: { issue: number } | null; milestone?: { number: number } | null; milestones?: { number: number }[] | null };

/** A Needs-you entry for a roadmap step waiting on the user
 *  (src/shared/roadmap.ts):
 *  human — the owner's own step, ready: open its issue.
 *  stuck — its card finished and the issue is still open: open the PR, then
 *          close the issue as completed or have the step done again.
 *  held  — its card waits in In Review for sign-off: open the PR or the card.
 *  `reason` and `detail` may quote a PR description: plain text, rendered
 *  as text. */
export interface RoadmapNeedsYou {
  key: string;
  kind: "human" | "stuck" | "held";
  step: string;
  issue: number;
  title: string;
  reason: string;
  /** What the PR said about the issue, or the files holding the card. */
  detail: string | null;
  /** The step's issue. */
  url: string | null;
  pr: number | null;
  prUrl: string | null;
  /** The card concerned, when there is one. */
  taskId: string | null;
}

/** Roadmap steps waiting on the user while Autopilot runs a roadmap: steps
 *  Autopilot won't start again and cards held for sign-off first, then the
 *  owner's ready `[Human]` steps. */
export function roadmapNeedsYou(
  autopilot: { config: RoadmapConfigRef & { enabled: boolean }; state: { roadmap?: RoadmapStatus | null } } | null | undefined,
): RoadmapNeedsYou[] {
  const status = autopilot ? currentRoadmapStatus(autopilot.config, autopilot.state.roadmap) : null;
  if (!autopilot?.config.enabled || !status) return [];
  return [
    ...status.needsUser.map((s) => {
      const kind = s.kind === "held" ? ("held" as const) : ("stuck" as const);
      return {
        key: `${kind}:${s.issue}`,
        kind,
        step: s.step,
        issue: s.issue,
        title: `Step ${s.step} · #${s.issue} ${s.title}`,
        reason: s.reason,
        detail: s.detail ?? null,
        url: s.url,
        pr: s.pr ?? null,
        prUrl: s.prUrl ?? null,
        taskId: s.taskId ?? null,
      };
    }),
    ...status.humanReady.map((s) => ({
      key: `human:${s.issue}`,
      kind: "human" as const,
      step: s.step,
      issue: s.issue,
      title: `Step ${s.step} · #${s.issue} ${s.title}`,
      reason: "ready for you — only you can do this step",
      detail: null,
      url: s.url,
      pr: null,
      prUrl: null,
      taskId: null,
    })),
  ];
}

/** The roadmap's word on each never-started backlog card, by card id — for
 *  the cards' status lines. Shown while paused too: the cards are still
 *  there, and the line is as of the last pass. */
export function roadmapCardInfo(
  autopilot: { config: RoadmapConfigRef; state: { roadmap?: RoadmapStatus | null } } | null | undefined,
): Map<string, RoadmapCardInfo> {
  const status = autopilot ? currentRoadmapStatus(autopilot.config, autopilot.state.roadmap) : null;
  return new Map((status?.cards ?? []).map((c) => [c.taskId, c]));
}

/** What each roadmap step's card waits on and blocks, by card id — for the
 *  board's blocker lines (src/mainview/lib/blocker-lines.ts). Steps without
 *  a card have no entry. */
export function roadmapLinkInfo(
  autopilot: { config: RoadmapConfigRef; state: { roadmap?: RoadmapStatus | null } } | null | undefined,
): Map<string, RoadmapStepLinks> {
  const status = autopilot ? currentRoadmapStatus(autopilot.config, autopilot.state.roadmap) : null;
  const out = new Map<string, RoadmapStepLinks>();
  for (const l of status?.links ?? []) if (l.taskId) out.set(l.taskId, l);
  return out;
}

/** The next-milestone offer the board should ask about now: Autopilot is
 *  on, the offer is due, the owner hasn't said "not now" to it, and
 *  continuing isn't automatic. */
export function roadmapOffer(
  autopilot: { config: RoadmapConfigRef & { enabled: boolean; autoContinue?: boolean }; state: { roadmap?: RoadmapStatus | null } } | null | undefined,
): RoadmapNextMilestone | null {
  if (!autopilot?.config.enabled || autopilot.config.autoContinue) return null;
  const next = currentRoadmapStatus(autopilot.config, autopilot.state.roadmap)?.nextMilestone;
  return offerPending(next) ? next : null;
}
