/**
 * Which cards the user has signed off for merging (dragged to Ready to
 * Merge). Kept apart from the card's column because a pipeline card's column
 * follows its run — a Fix CI step moves it to Running, and when the run is
 * done again it must come back to Ready to Merge, not In Review. Stored in
 * the `merge_queue` preference; tiny module so the pipeline runner can read
 * it without importing the merge watcher.
 */
import { preferences } from "./db.ts";

export const MERGE_QUEUE_PREF = "merge_queue";

export function mergeQueue(): string[] {
  try {
    const v = JSON.parse(preferences.get(MERGE_QUEUE_PREF) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function isMergeQueued(taskId: string): boolean {
  return mergeQueue().includes(taskId);
}

export function setMergeQueued(taskId: string, queued: boolean): boolean {
  const q = mergeQueue();
  const has = q.includes(taskId);
  if (has === queued) return false;
  preferences.set(MERGE_QUEUE_PREF, JSON.stringify(queued ? [...q, taskId] : q.filter((id) => id !== taskId)));
  return true;
}
