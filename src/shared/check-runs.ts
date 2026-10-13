/**
 * Reading a commit's check runs: which run of a name counts, and what the
 * set adds up to. Shared by the PR watcher's roll-up (src/bun/pr-watch.ts)
 * and Agetor-run Finish (src/shared/publish.ts). Pure.
 */

/** A check run as these helpers read it. `startedAt` and `id` order two runs
 *  of the same name; both are optional so a caller with neither still works. */
export interface CheckRunLike {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  startedAt?: string | null;
  id?: number;
}

/** Aggregate checks that fail whenever any suite does — never a cause. */
export const ROLLUP_CHECKS: ReadonlySet<string> = new Set(["required"]);

/** Conclusions that mean the check did not pass because of what it ran. A
 *  cancelled run is not one: it was superseded or stopped, not failed. */
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
export function failedConclusion(conclusion: string | null): boolean {
  return FAILED.has(conclusion ?? "");
}

/**
 * The newest run of each check name, in first-seen order. GitHub lists every
 * check run of a commit: a second workflow run on the same commit (a
 * re-trigger, or `cancel-in-progress` cutting one short) leaves two runs of
 * one name, and only the newest says where that check stands. Newest is the
 * later `startedAt`; a run that has not started yet is newer than any that
 * has; ties go to the higher `id`, then to the later entry.
 */
export function newestPerName<T extends CheckRunLike>(runs: readonly T[]): T[] {
  const age = (r: T): number => {
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isFinite(t)) return t;
    return r.status === "completed" ? -Infinity : Infinity;
  };
  const newest = new Map<string, T>();
  for (const r of runs) {
    const seen = newest.get(r.name);
    if (!seen) {
      newest.set(r.name, r);
      continue;
    }
    const a = age(seen), b = age(r);
    if (b > a || (b === a && (r.id ?? 0) >= (seen.id ?? 0))) newest.set(r.name, r);
  }
  return [...newest.values()];
}

/** Where a commit's checks stand, each name judged by its newest run:
 *  `failure` when any failed; else `pending` while one is unfinished or was
 *  cancelled with nothing newer; else `success`; `none` without runs. */
export function checksState(all: readonly CheckRunLike[]): "none" | "pending" | "success" | "failure" {
  const runs = newestPerName(all);
  if (runs.length === 0) return "none";
  if (runs.some((r) => failedConclusion(r.conclusion))) return "failure";
  if (runs.some((r) => r.status !== "completed" || r.conclusion === "cancelled")) return "pending";
  return "success";
}
