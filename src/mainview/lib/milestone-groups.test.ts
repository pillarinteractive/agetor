import { expect, test } from "bun:test";
import type { GitHubRepoMilestone } from "../../shared/types.ts";
import { groupByMilestone, milestoneProgress } from "./milestone-groups.ts";

const ms = (number: number, title: string, o: Partial<GitHubRepoMilestone> = {}): GitHubRepoMilestone => ({
  number,
  title,
  state: "open",
  description: "",
  dueOn: null,
  openIssues: 3,
  closedIssues: 1,
  htmlUrl: `u/${number}`,
  ...o,
});
const row = (n: number, milestone: { number: number; title: string } | null) => ({ n, item: { milestone } });

test("groups in milestone order, keeps empty open milestones, puts unassigned last", () => {
  const groups = groupByMilestone(
    [row(1, null), row(2, { number: 2, title: "1.0 / 2" }), row(3, { number: 1, title: "1.0 / 1" }), row(4, { number: 2, title: "1.0 / 2" })],
    [ms(2, "1.0 / 2"), ms(1, "1.0 / 1"), ms(3, "1.0 / 3"), ms(9, "Old", { state: "closed" })],
  );
  expect(groups.map((g) => [g.title, g.rows.map((r) => r.n)])).toEqual([
    ["1.0 / 1", [3]],
    ["1.0 / 2", [2, 4]],
    ["1.0 / 3", []],
    ["No milestone", [1]],
  ]);
});

test("a milestone the repo list doesn't have still gets a group, from the issue", () => {
  const [g] = groupByMilestone([row(1, { number: 7, title: "Later" })]);
  expect(g).toMatchObject({ number: 7, title: "Later", milestone: null });
});

test("progress", () => {
  expect(milestoneProgress(ms(1, "a", { openIssues: 17, closedIssues: 3 }))).toEqual({ done: 3, total: 20, pct: 15 });
  expect(milestoneProgress(ms(1, "a", { openIssues: 0, closedIssues: 0 }))).toEqual({ done: 0, total: 0, pct: 0 });
  expect(milestoneProgress(null)).toBeNull();
});
