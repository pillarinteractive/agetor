import { useContext } from "react";
import type { Task } from "../../shared/types.ts";
import { cardState, columnSummary, type CardState } from "./card-state.ts";
import { LeaseContext, leaseInfoForTask } from "./leases.ts";
import { PrContext } from "./prs.ts";
import { ProgressContext, RoadmapCardsContext } from "./progress.ts";

/** A card's state from the board's shared contexts (PRs, leases, live
 *  progress, the roadmap), as of this render. */
export function useCardState(task: Task): CardState {
  const leases = useContext(LeaseContext);
  const prs = useContext(PrContext);
  const progress = useContext(ProgressContext);
  const roadmap = useContext(RoadmapCardsContext);
  return cardState(task, {
    pr: prs.get(task.id) ?? null,
    lease: leaseInfoForTask(task, leases),
    now: Date.now(),
    progressActive: progress.some((p) => p.taskId === task.id && p.active),
    roadmap: roadmap.get(task.id) ?? null,
  });
}

/** A column's summary line: its cards counted by state. */
export function useColumnSummary(tasks: Task[]): string {
  const leases = useContext(LeaseContext);
  const prs = useContext(PrContext);
  const progress = useContext(ProgressContext);
  const roadmap = useContext(RoadmapCardsContext);
  const now = Date.now();
  return columnSummary(
    tasks.map((task) =>
      cardState(task, {
        pr: prs.get(task.id) ?? null,
        lease: leaseInfoForTask(task, leases),
        now,
        progressActive: progress.some((p) => p.taskId === task.id && p.active),
        roadmap: roadmap.get(task.id) ?? null,
      }),
    ),
  );
}
