import { expect, test } from "bun:test";
import type { Task, TaskPrStatus } from "../shared/types.ts";
import { nextMergeStep } from "./merge-queue.ts";

const card = (o: Partial<Task> = {}) => ({ column: "merge", pipelineId: "p", pipelineRun: null, ...o }) as unknown as Task;
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus =>
  ({ taskId: "t", number: 9, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "h", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, behindBy: 0, ...o }) as TaskPrStatus;
const clean = { mergeable: true, mergeableState: "clean" };

test("green, mergeable, current → merge", () => {
  expect(nextMergeStep(card(), pr(), clean)).toEqual({ kind: "merge" });
});

test("one fix-up at a time, in order: conflicts, behind, own CI, review", () => {
  expect(nextMergeStep(card(), pr({ behindBy: 2 }), { mergeable: false, mergeableState: "dirty" }).kind).toBe("resolve-conflicts");
  expect(nextMergeStep(card(), pr({ behindBy: 2, checks: "failure" }), clean).kind).toBe("update-branch");
  const own = pr({ checks: "failure", failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: false }] });
  expect(nextMergeStep(card(), own, clean).kind).toBe("fix-ci");
  expect(nextMergeStep(card(), pr({ unresolvedThreads: 2 }), clean).kind).toBe("address-review");
});

test("waits: checks running, base failing the same checks, a step running, GitHub not clean yet", () => {
  expect(nextMergeStep(card(), pr({ checks: "pending" }), clean).kind).toBe("wait");
  const inherited = pr({ checks: "failure", failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: true }] });
  expect(nextMergeStep(card(), inherited, clean).kind).toBe("wait");
  expect(nextMergeStep(card({ column: "running" }), pr(), clean).kind).toBe("wait");
  expect(nextMergeStep(card(), pr(), { mergeable: null, mergeableState: "unknown" }).kind).toBe("wait");
});

test("no PR: a pipeline opens one; a plain task needs the user", () => {
  expect(nextMergeStep(card(), null, null).kind).toBe("open-pr");
  expect(nextMergeStep(card({ pipelineId: null }), null, null).kind).toBe("needs-you");
});

test("plain tasks can't run fix-up steps — those need the user", () => {
  const plain = card({ pipelineId: null });
  expect(nextMergeStep(plain, pr(), { mergeable: false, mergeableState: "dirty" }).kind).toBe("needs-you");
  expect(nextMergeStep(plain, pr({ unresolvedThreads: 1 }), clean).kind).toBe("needs-you");
  // …but updating the branch and merging don't need an agent.
  expect(nextMergeStep(plain, pr({ behindBy: 1 }), clean).kind).toBe("merge");
  expect(nextMergeStep(plain, pr(), clean).kind).toBe("merge");
});

test("closed or draft PRs need the user", () => {
  expect(nextMergeStep(card(), pr({ state: "closed" }), null).kind).toBe("needs-you");
  // A pipeline's approved card marks its own draft ready; a plain task's draft is the owner's call.
  expect(nextMergeStep(card(), pr({ draft: true }), null).kind).toBe(card().pipelineId ? "mark-ready" : "needs-you");
  expect(nextMergeStep(card({ pipelineId: "p1" }), pr({ draft: true }), null).kind).toBe("mark-ready");
  expect(nextMergeStep(card({ pipelineId: null }), pr({ draft: true }), null).kind).toBe("needs-you");
});

test("no PR status because the lookup failed isn't 'no PR' — it waits instead of opening another", () => {
  expect(nextMergeStep(card(), null, null, false)).toEqual({ kind: "wait", why: "checking for a PR" });
  expect(nextMergeStep(card(), null, null, true).kind).toBe("open-pr");
});

test("behind the base: merge a green PR as it is; update only when GitHub requires it or CI is failing", () => {
  const behind = { mergeable: true, mergeableState: "behind" };
  expect(nextMergeStep(card(), pr({ behindBy: 3 }), clean).kind).toBe("merge");
  expect(nextMergeStep(card(), pr({ behindBy: 3, checks: "pending" }), clean).kind).toBe("wait");
  expect(nextMergeStep(card(), pr({ behindBy: 3 }), behind).kind).toBe("update-branch");
  expect(nextMergeStep(card(), pr({ behindBy: 3, checks: "failure", failingChecks: [{ name: "x", url: null }] as never }), clean).kind).toBe("update-branch");
});

// The fresh rule (`merge_queue_fresh`): a green PR merges by itself only when
// its head contains the base's tip — otherwise CI never tested what lands.
const fresh = (p: TaskPrStatus, m: { mergeable: boolean | null; mergeableState: string } = clean, c = card()) => nextMergeStep(c, p, m, true, false, true);
const freshCases: { name: string; pr: TaskPrStatus; mergeability?: { mergeable: boolean | null; mergeableState: string }; card?: Task; kind: string }[] = [
  { name: "green and current merges", pr: pr({ behindBy: 0 }), kind: "merge" },
  { name: "green but behind rides a train", pr: pr({ behindBy: 3 }), kind: "train" },
  { name: "green, distance unknown, is treated as stale", pr: pr({ behindBy: null }), kind: "train" },
  { name: "a plain task's stale PR rides a train too", pr: pr({ behindBy: 1 }), card: card({ pipelineId: null }), kind: "train" },
  { name: "checks still running: wait, whatever the distance", pr: pr({ behindBy: 3, checks: "pending" }), kind: "wait" },
  { name: "GitHub requires an up-to-date branch: update it", pr: pr({ behindBy: 3 }), mergeability: { mergeable: true, mergeableState: "behind" }, kind: "update-branch" },
  { name: "conflicts come first", pr: pr({ behindBy: 3 }), mergeability: { mergeable: false, mergeableState: "dirty" }, kind: "resolve-conflicts" },
  { name: "review comments come first", pr: pr({ behindBy: 3, unresolvedThreads: 1 }), kind: "address-review" },
  { name: "not mergeable yet: wait", pr: pr({ behindBy: 3 }), mergeability: { mergeable: null, mergeableState: "unknown" }, kind: "wait" },
];
for (const c of freshCases) {
  test(`fresh rule: ${c.name}`, () => {
    expect(fresh(c.pr, c.mergeability, c.card).kind).toBe(c.kind as never);
  });
}

test("fresh rule: the train step says how far behind; with the rule off a stale green PR merges as before", () => {
  expect(fresh(pr({ behindBy: 1 }))).toEqual({ kind: "train", why: "its checks ran 1 commit behind develop" });
  expect(fresh(pr({ behindBy: 4 }))).toEqual({ kind: "train", why: "its checks ran 4 commits behind develop" });
  expect(nextMergeStep(card(), pr({ behindBy: 4 }), clean, true, false, false)).toEqual({ kind: "merge" });
  expect(nextMergeStep(card(), pr({ behindBy: 4 }), clean)).toEqual({ kind: "merge" });
});

test("fresh rule: the last look before a merge — behind now, or unknown, does not merge", async () => {
  const { mergeNow } = await import("./merge-queue.ts");
  expect(mergeNow(0)).toBe("merge");
  expect(mergeNow(2)).toBe("stale");
  expect(mergeNow(null)).toBe("unknown");
});
