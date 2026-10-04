import { createContext, useContext } from "react";
import type { LeaseStatus, Task } from "../../shared/types.ts";

/** Latest lease-watcher statuses (src/bun/lease-watch.ts), provided once by
 *  App.tsx so cards read them without threading a prop through every column
 *  (and through `Column`'s memo comparator). */
export const LeaseContext = createContext<LeaseStatus[]>([]);

export interface TaskLeaseInfo {
  /** Labels of the leases this card's worktree holds — one badge each. */
  holds: string[];
  /** For a Blocked card: each of its project's leases it doesn't hold, and
   *  who has it, so the user can tell when a retry would get through. */
  waiting: { label: string; heldBy: string | null; free: boolean }[];
}

const trimSlash = (p: string) => p.replace(/\/+$/, "");

export function leaseInfoForTask(task: Task, leases: LeaseStatus[]): TaskLeaseInfo {
  const holds = leases.filter((l) => l.held && l.holderTaskId === task.id).map((l) => l.label);
  const waiting =
    task.column === "blocked"
      ? leases
          .filter((l) => trimSlash(l.project) === trimSlash(task.workdir) && l.holderTaskId !== task.id)
          .map((l) => ({
            label: l.label,
            heldBy: l.held ? (l.holderTitle ?? l.owner ?? "another checkout") : null,
            free: !l.held,
          }))
      : [];
  return { holds, waiting };
}

export function useTaskLeaseInfo(task: Task): TaskLeaseInfo {
  return leaseInfoForTask(task, useContext(LeaseContext));
}
