/**
 * Which cards hold a Milestone Autopilot slot. Shared by the core
 * (src/bun/autopilot.ts) and the Autopilot dialog's in-flight count. Pure.
 */
import type { PipelineRunState, Task } from "./types.ts";

/** Columns where a card is still being built. In Review / Ready to Merge /
 *  Done don't hold a slot, and neither does Blocked. */
export const PROGRESSING_COLUMNS = new Set<Task["column"]>(["backlog", "ready", "running"]);

/** Waiting for a usage limit to reset before an automatic retry
 *  (src/bun/pipeline-runner.ts `scheduleAutoRetry`). */
export function waitingOnQuota(run: PipelineRunState | null | undefined): boolean {
  return !!run && run.status === "blocked" && run.autoRetry?.kind === "quota" && run.autoRetry.at != null;
}

/**
 * A card holds a slot only while it is actually progressing: in Backlog /
 * Ready / Running, its pipeline run isn't blocked (which includes waiting on
 * a usage-limit reset), and nothing is waiting on the user (a question or
 * permission card). `quotaPaused` optionally reports a live session paused
 * mid-turn on a usage limit (the core knows; the webview doesn't).
 */
export function holdsAutopilotSlot(
  t: Pick<Task, "column" | "archivedAt" | "pipelineRun" | "pendingInteractionCount">,
  quotaPaused?: (t: Pick<Task, "pipelineRun">) => boolean,
): boolean {
  if (t.archivedAt != null || !PROGRESSING_COLUMNS.has(t.column)) return false;
  if (t.pipelineRun?.status === "blocked" || waitingOnQuota(t.pipelineRun)) return false;
  if ((t.pendingInteractionCount ?? 0) > 0) return false;
  return !quotaPaused?.(t);
}
