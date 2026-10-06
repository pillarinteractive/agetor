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
  expect(nextMergeStep(card(), pr({ draft: true }), null).kind).toBe("needs-you");
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
