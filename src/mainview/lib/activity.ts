import { useEffect, useState } from "react";
import { api } from "./api";

export type ActivityEntry = Awaited<ReturnType<typeof api.getActivity>>[number];

/**
 * A card's activity timeline, newest first (src/bun/activity.ts): steps
 * starting, handing off and blocking; the PR opening, CI going red or green,
 * review comments, a merge; a lease taken or released; automatic Fix CI.
 * `refreshKey` changes whenever the run or the PR does, so the list stays
 * live. Null until the first answer, and again if a read fails.
 */
export function useTaskActivity(taskId: string, refreshKey: string): ActivityEntry[] | null {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getActivity(taskId)
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries(null));
    return () => {
      alive = false;
    };
  }, [taskId, refreshKey]);
  return entries;
}
