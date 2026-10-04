import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task, TaskPrStatus } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-pr-watch-"));
const { PR_FIX_CI_ACTION, PR_REVIEW_ACTION, prFollowUpActions, prFollowUpInstructions, rollUpChecks, tasksToWatch } =
  await import("./pr-watch.ts");

const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, htmlUrl: `https://ci/${name}` });
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t1", number: 42, url: "https://github.com/o/r/pull/42", state: "open", draft: false,
  checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o,
});
const task = (o: Partial<Task>) => ({ id: "t1", column: "review", branch: "feature/x", archivedAt: null, pipelineParentId: null, ...o }) as Task;

describe("rollUpChecks", () => {
  test("any failed run fails the PR and is listed; otherwise pending until all complete", () => {
    expect(rollUpChecks([])).toEqual({ checks: "none", failing: [] });
    expect(rollUpChecks([run("lint", "completed", "success"), run("test", "in_progress", null)]).checks).toBe("pending");
    expect(rollUpChecks([run("lint", "completed", "success"), run("skip", "completed", "skipped")]).checks).toBe("success");
    const failed = rollUpChecks([run("lint", "completed", "failure"), run("e2e", "completed", "timed_out"), run("test", "queued", null)]);
    expect(failed.checks).toBe("failure");
    expect(failed.failing.map((f) => f.name)).toEqual(["lint", "e2e"]);
  });
});

describe("tasksToWatch", () => {
  test("live board cards with a branch; Done only while the PR is still open; never step rows", () => {
    const known = new Map<string, TaskPrStatus>([["open-done", pr({ taskId: "open-done" })], ["merged", pr({ taskId: "merged", state: "merged" })]]);
    const list = [
      task({ id: "review" }),
      task({ id: "nobranch", branch: null }),
      task({ id: "archived", archivedAt: 1 }),
      task({ id: "step", pipelineParentId: "p" }),
      task({ id: "backlog", column: "backlog" }),
      task({ id: "done-unknown", column: "done" }),
      task({ id: "open-done", column: "done" }),
      task({ id: "merged", column: "review" }),
    ];
    expect(tasksToWatch(list, known).map((t) => t.id)).toEqual(["review", "open-done"]);
  });
});

describe("PR follow-ups", () => {
  test("failing CI and unresolved threads each offer a suggested action; a clean or merged PR offers none", () => {
    expect(prFollowUpActions(pr())).toEqual([]);
    expect(prFollowUpActions(pr({ state: "merged", checks: "failure" }))).toEqual([]);
    const actions = prFollowUpActions(pr({ checks: "failure", failingChecks: [{ name: "lint", url: null }], unresolvedThreads: 2 }));
    expect(actions.map((a) => [a.id, a.suggested])).toEqual([[PR_FIX_CI_ACTION, true], [PR_REVIEW_ACTION, true]]);
    expect(actions[0]!.label).toBe("Fix CI (#42)");
    expect(actions[1]!.matched).toEqual(["2 unresolved threads"]);
  });

  test("instructions carry the PR and failing checks, allow pushing only the task branch, and go stale with the PR", () => {
    const failing = pr({ checks: "failure", failingChecks: [{ name: "lint", url: "https://ci/lint" }] });
    const ci = prFollowUpInstructions(PR_FIX_CI_ACTION, failing)!;
    expect(ci.instructions).toContain("#42");
    expect(ci.instructions).toContain("- lint (https://ci/lint)");
    expect(ci.instructions).toContain("never force-push");
    expect(prFollowUpInstructions(PR_FIX_CI_ACTION, pr())).toBeNull();
    expect(prFollowUpInstructions(PR_REVIEW_ACTION, pr({ unresolvedThreads: 1 }))!.instructions).toContain("Don't resolve threads yourself");
    expect(prFollowUpInstructions(PR_REVIEW_ACTION, null)).toBeNull();
  });
});
