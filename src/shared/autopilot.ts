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

/**
 * A card nothing has run yet: in Backlog (or Ready), with no run and an idle
 * pipeline. Tracker mode makes such a card for every open step of the
 * milestone up front; until it starts it holds no slot and its issue isn't
 * being worked.
 */
export function neverStarted(t: Pick<Task, "column" | "archivedAt" | "pipelineRun"> & { runId?: string | null }): boolean {
  if (t.archivedAt != null || (t.column !== "backlog" && t.column !== "ready") || t.runId) return false;
  const run = t.pipelineRun;
  return !run || (run.status === "idle" && run.history.length === 0 && run.active.length === 0);
}

export type AutopilotMode = "tracker-milestone" | "tracker" | "milestone" | "none";

/** What Autopilot works from: a tracker's order (within a milestone, or the
 *  whole roadmap), or a milestone driven by the Codex thread. */
export function autopilotMode(c: { roadmap: { issue: number } | null; milestone: { title: string } | null }): AutopilotMode {
  if (c.roadmap && c.roadmap.issue > 0) return c.milestone ? "tracker-milestone" : "tracker";
  return c.milestone ? "milestone" : "none";
}

/** The rocket button's tooltip. */
export function autopilotLabel(c: { enabled: boolean; roadmap: { issue: number } | null; milestone: { title: string } | null } | null | undefined): string {
  if (!c) return "Autopilot";
  const mode = autopilotMode(c);
  const what =
    mode === "tracker-milestone"
      ? `Autopilot — milestone "${c.milestone!.title}", in the order of tracker #${c.roadmap!.issue}`
      : mode === "tracker"
        ? `Autopilot — the whole roadmap of tracker #${c.roadmap!.issue}`
        : mode === "milestone"
          ? `Milestone Autopilot — "${c.milestone!.title}", driven by the Codex thread`
          : "Autopilot — not set up";
  return mode === "none" ? what : `${what}${c.enabled ? "" : " (paused)"}`;
}
