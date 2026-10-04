import { expect, test } from "bun:test";
import type { Task, TaskPrStatus } from "../shared/types.ts";
import { createsCycle, dependencyOf, readDependencies, unblockAction, unblockedMessage } from "./dependencies.ts";

const task = (o: Partial<Task>): Task => ({ id: "t", title: "Fix procexec", column: "running", archivedAt: null, runId: "r", pipelineRun: null, ...o }) as unknown as Task;
const pr = (o: Partial<TaskPrStatus>): TaskPrStatus =>
  ({ taskId: "t", number: 201, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "h", checks: "pending", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o }) as TaskPrStatus;

test("readDependencies drops junk and self-references", () => {
  expect(readDependencies(JSON.stringify({ a: ["b", "a", "b"], c: "x", d: [] }))).toEqual({ a: ["b"] });
  expect(readDependencies("nope")).toEqual({});
});

test("createsCycle", () => {
  expect(createsCycle({ b: ["c"] }, "a", ["b"])).toBe(false);
  expect(createsCycle({ b: ["c"], c: ["a"] }, "a", ["b"])).toBe(true);
  expect(createsCycle({}, "a", ["a"])).toBe(true);
});

test("a dependency is satisfied by a merged PR, Done, archived or deletion — not by an open PR", () => {
  expect(dependencyOf(task({}), "t", pr({}))).toMatchObject({ satisfied: false, detail: "PR #201 · checks running" });
  expect(dependencyOf(task({}), "t", pr({ state: "merged" }))).toMatchObject({ satisfied: true, detail: "PR #201 merged" });
  expect(dependencyOf(task({ column: "done" }), "t", null)).toMatchObject({ satisfied: true });
  expect(dependencyOf(task({ archivedAt: 1 as never }), "t", null)).toMatchObject({ satisfied: true });
  expect(dependencyOf(null, "gone", null)).toMatchObject({ satisfied: true, detail: "deleted" });
  expect(dependencyOf(task({ column: "review" }), "t", null)).toMatchObject({ satisfied: false, detail: "review" });
});

test("what happens when the last dependency lands", () => {
  expect(unblockAction(task({ column: "ready", runId: null }))).toBe("start");
  expect(unblockAction(task({ column: "review" }))).toBe("message-task");
  expect(unblockAction(task({ column: "running" }))).toBe("none");
  const blockedRun = { status: "blocked", history: [{}], blocked: [{ taskId: "s" }] } as never;
  expect(unblockAction(task({ column: "blocked", pipelineRun: blockedRun }))).toBe("message-step");
  const fresh = { status: "idle", history: [], blocked: [] } as never;
  expect(unblockAction(task({ column: "ready", pipelineRun: fresh, runId: null }))).toBe("start");
  const running = { status: "running", history: [{}], blocked: [] } as never;
  expect(unblockAction(task({ column: "running", pipelineRun: running }))).toBe("none");
});

test("the carry-on message names what landed and says merge, not rebase", () => {
  const m = unblockedMessage([{ taskId: "d", title: "procexec fix", satisfied: true, detail: "PR #201 merged" }]);
  expect(m).toContain('"procexec fix" (PR #201 merged)');
  expect(m).toContain("git merge --no-edit origin/<base>");
  expect(m).toContain("no rebase");
});
