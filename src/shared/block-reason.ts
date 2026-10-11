/**
 * Why a blocked pipeline card is blocked, in one place for the board's status
 * line, the suggestions engine and the lease queue — so a card waiting on
 * the lab and a card blocked on something else never get the same label.
 */
import type { Task } from "./types.ts";
import { blockReasonLine } from "./pipeline.ts";
import { escalatedWait, escalationLine, waitHasTrigger, waitingInQueue, waitLine } from "./block-wait.ts";

export interface BlockInfo {
  /** The blocked step's task, when there is one. */
  stepTaskId: string | null;
  stepName: string;
  /** Everything the step said about the block: the runner's message plus the
   *  handoff's summary, reason and open questions. */
  text: string;
  questions: string[];
  /** When the step stopped (its record's end), else the card's last update. */
  blockedAt: number;
}

export function blockInfo(task: Task): BlockInfo | null {
  const run = task.pipelineRun;
  const block = run?.status === "blocked" ? run.blocked[0] : undefined;
  if (!run || !block) return null;
  const record = [...run.history].reverse().find((r) => r.taskId === block.taskId) ?? null;
  const h = record?.handoff;
  const stepName = run.snapshot?.graph.steps.find((s) => s.id === block.stepId)?.name ?? block.stepId ?? "a step";
  const text = [block.message, h?.summary, h?.reason, ...(h?.openQuestions ?? [])].filter(Boolean).join("\n");
  return {
    stepTaskId: block.taskId,
    stepName,
    text,
    questions: h?.openQuestions ?? [],
    blockedAt: record?.endedAt ?? task.updatedAt,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the block text say the step is waiting on this lease? Matches the
 *  lease's own label ("lab") as a word, or the generic lease words. */
export function blockMentionsLease(text: string, label: string): boolean {
  return new RegExp(`\\blease\\b|\\bplab\\b|held by|\\b${escapeRe(label)}\\b`, "i").test(text);
}

/** Blocked top-level cards of `project` waiting on the lease called `label`,
 *  longest-waiting first — the order the lab queue retries them in. */
export function leaseQueue(list: Task[], lease: { project: string; label: string }): { task: Task; since: number }[] {
  const trim = (p: string) => p.replace(/\/+$/, "");
  return list
    .filter((t) => t.archivedAt == null && !t.pipelineParentId && trim(t.workdir) === trim(lease.project))
    .flatMap((t) => {
      const b = blockInfo(t);
      return b && blockMentionsLease(b.text, lease.label) ? [{ task: t, since: b.blockedAt }] : [];
    })
    .sort((a, b) => a.since - b.since);
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/**
 * Where a started card that stopped on a block stands, in one line: parked
 * in the blocked-step wait queue (`queued` — what it waits on and when it is
 * retried), or the owner's (why, and for a block the queue gave up on, what
 * was tried). Null when the card isn't blocked. `leaseLabels`: the watched
 * leases of its project. Pure.
 */
export function blockedCardLine(task: Task, now: number, leaseLabels: string[] = []): { queued: boolean; line: string } | null {
  const run = task.pipelineRun;
  if ((task.pendingInteractionCount ?? 0) > 0) return { queued: false, line: "asked you a question" };
  if (!run || run.status !== "blocked") return null;
  const nameOf = (stepId: string | null | undefined) => run.snapshot?.graph.steps.find((s) => s.id === stepId)?.name ?? stepId ?? "a step";
  if (waitingInQueue(run)) return { queued: true, line: waitLine(nameOf(run.wait!.stepId), run.wait!, now, waitHasTrigger(run.wait!, leaseLabels)) };
  const gaveUp = escalatedWait(run);
  if (gaveUp) return { queued: false, line: escalationLine(nameOf(gaveUp.stepId), gaveUp, now).reason };
  // A pending automatic retry (usage limit, transient failure) isn't the owner's.
  if (run.autoRetry?.at != null) return null;
  const block = run.blocked[0];
  const handoff = [...run.history].reverse().find((r) => r.taskId === block?.taskId)?.handoff;
  const question = handoff?.openQuestions?.find((q) => q.trim());
  const why = blockReasonLine(handoff, block?.message) || "blocked";
  return { queued: false, line: question ? `${nameOf(block?.stepId)} asks: ${question}` : `${nameOf(block?.stepId)} stopped: ${why}` };
}
