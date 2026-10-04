import { createContext, useContext } from "react";
import type { LeaseStatus, Task } from "../../shared/types.ts";

/** Latest lease-watcher statuses (src/bun/lease-watch.ts), provided once by
 *  App.tsx so cards read them without threading a prop through every column
 *  (and through `Column`'s memo comparator). */
export const LeaseContext = createContext<LeaseStatus[]>([]);

export interface TaskLeaseInfo {
  /** Labels of the leases this card's worktree holds — one badge each. */
  holds: string[];
  /** For a Blocked card whose block says it's waiting on a lease: that lease,
   *  who has it, and the card's place in its queue (1 = next). A card blocked
   *  for any other reason gets none, even when the lab is busy. */
  waiting: { label: string; heldBy: string | null; free: boolean; position: number; queueLength: number }[];
}

export function leaseInfoForTask(task: Task, leases: LeaseStatus[]): TaskLeaseInfo {
  const holds = leases.filter((l) => l.held && l.holderTaskId === task.id).map((l) => l.label);
  const waiting =
    task.column === "blocked"
      ? leases.flatMap((l) => {
          const i = (l.queue ?? []).findIndex((q) => q.taskId === task.id);
          // A failing probe with no known holder knows nothing — never claim
          // the resource is free on its say-so.
          if (i < 0 || l.holderTaskId === task.id || (!l.held && l.error)) return [];
          return [{
            label: l.label,
            heldBy: l.held ? (l.holderTitle ?? l.owner ?? "another checkout") : null,
            free: !l.held,
            position: i + 1,
            queueLength: l.queue!.length,
          }];
        })
      : [];
  return { holds, waiting };
}

export function useTaskLeaseInfo(task: Task): TaskLeaseInfo {
  return leaseInfoForTask(task, useContext(LeaseContext));
}
