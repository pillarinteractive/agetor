import type { GitHubListItem, GitHubRepoMilestone } from "../../shared/types.ts";

export interface MilestoneGroup<R> {
  /** Milestone number, or null for issues without one. */
  number: number | null;
  title: string;
  /** The repo milestone, when known (progress counts and link). */
  milestone: GitHubRepoMilestone | null;
  rows: R[];
}

/**
 * Group issue rows by milestone: milestones in their repo order (by number,
 * which is creation order — how a roadmap's "1.0 / 1, 1.0 / 2…" are made),
 * then "No milestone" last. Open milestones with no loaded issues are kept so
 * the roadmap reads complete; rows keep their order within a group. Pure.
 */
export function groupByMilestone<R extends { item: Pick<GitHubListItem, "milestone"> }>(
  rows: R[],
  milestones: GitHubRepoMilestone[] = [],
): MilestoneGroup<R>[] {
  const groups = new Map<number | null, MilestoneGroup<R>>();
  for (const m of milestones) {
    if (m.state === "open") groups.set(m.number, { number: m.number, title: m.title, milestone: m, rows: [] });
  }
  for (const r of rows) {
    const m = r.item.milestone;
    const key = m?.number ?? null;
    let g = groups.get(key);
    if (!g) {
      g = {
        number: key,
        title: m?.title ?? "No milestone",
        milestone: milestones.find((x) => x.number === key) ?? null,
        rows: [],
      };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return a.number - b.number;
  });
}

/** "3 of 20 done" for a milestone, or null when the counts aren't known. */
export function milestoneProgress(m: GitHubRepoMilestone | null): { done: number; total: number; pct: number } | null {
  if (!m) return null;
  const total = m.openIssues + m.closedIssues;
  return { done: m.closedIssues, total, pct: total ? Math.round((m.closedIssues / total) * 100) : 0 };
}
