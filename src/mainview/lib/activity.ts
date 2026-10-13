import { useEffect, useState } from "react";
import { api } from "./api";
import type { CheckLedgerEntry } from "../../shared/types.ts";
import type { PipelinePositionView } from "../../shared/position.ts";

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

/**
 * A run's check ledger, oldest first (src/bun/check-runner.ts), read again
 * whenever `refreshKey` changes. Null until the first answer and when a read
 * fails; empty for a run no step of which is judged by checks.
 */
export function useCheckLedger(taskId: string, refreshKey: string): CheckLedgerEntry[] | null {
  const [entries, setEntries] = useState<CheckLedgerEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getPipelineChecks(taskId)
      .then((r) => alive && setEntries(r.checks))
      .catch(() => alive && setEntries(null));
    return () => {
      alive = false;
    };
  }, [taskId, refreshKey]);
  return entries;
}

/** Where a run with check gates stands (`GET /tasks/:id/pipeline/position`),
 *  read again whenever `refreshKey` changes; null until read, on a failure,
 *  and for a run that has never started. */
export function usePipelinePosition(taskId: string, refreshKey: string): PipelinePositionView | null {
  const [view, setView] = useState<PipelinePositionView | null>(null);
  useEffect(() => {
    let alive = true;
    if (!refreshKey) {
      setView(null);
      return;
    }
    api
      .getPipelinePosition(taskId)
      .then((r) => alive && setView(r))
      .catch(() => alive && setView(null));
    return () => {
      alive = false;
    };
  }, [taskId, refreshKey]);
  return view;
}
