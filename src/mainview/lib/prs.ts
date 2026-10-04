import { createContext, useContext } from "react";
import type { TaskPrStatus } from "../../shared/types.ts";

/** Every watched task's pull request (src/bun/pr-watch.ts), keyed by task
 *  id — provided once by App.tsx so cards read it without prop threading. */
export const PrContext = createContext<ReadonlyMap<string, TaskPrStatus>>(new Map());

export function useTaskPr(taskId: string): TaskPrStatus | null {
  return useContext(PrContext).get(taskId) ?? null;
}

/** Badge text, tone and tooltip for a PR. */
export function prBadge(pr: TaskPrStatus): { text: string; tone: "success" | "danger" | "warning" | "muted" | "merged"; title: string } {
  const base = `PR #${pr.number}`;
  if (pr.state === "merged") return { text: `${base} merged`, tone: "merged", title: `${base} was merged` };
  if (pr.state === "closed") return { text: `${base} closed`, tone: "muted", title: `${base} was closed without merging` };
  const threads = pr.unresolvedThreads > 0 ? ` · ${pr.unresolvedThreads} 💬` : "";
  const threadsTitle = pr.unresolvedThreads > 0 ? `; ${pr.unresolvedThreads} unresolved review thread(s)` : "";
  if (pr.checks === "failure") {
    // Same rule as pr-watch.ts ownFailures: inherited and rollup checks aren't the PR's.
    const own = pr.failingChecks.filter((c) => !c.alsoOnBase && c.name !== "required");
    const baseName = pr.baseRef ?? "the base branch";
    if (own.length === 0) {
      return {
        text: `${base} ✗ CI (also on ${pr.baseRef ?? "base"})${threads}`,
        tone: "warning",
        title: `CI failing, but the same checks fail on ${baseName}, so not this PR's doing: ${pr.failingChecks.map((c) => c.name).join(", ")}${threadsTitle}`,
      };
    }
    return {
      text: `${base} ✗ CI${threads}`,
      tone: "danger",
      title: `CI failing: ${own.map((c) => c.name).join(", ")}${threadsTitle}`,
    };
  }
  if (pr.checks === "pending") return { text: `${base} …${threads}`, tone: "warning", title: `Checks running${threadsTitle}` };
  if (pr.checks === "success") return { text: `${base} ✓${threads}`, tone: threads ? "warning" : "success", title: `Checks passed${threadsTitle}` };
  return { text: `${base}${pr.draft ? " draft" : ""}${threads}`, tone: threads ? "warning" : "muted", title: `No checks reported${threadsTitle}` };
}
