import { expect, test } from "bun:test";
import type { Task } from "../shared/types.ts";
import { inactiveStepSessions } from "./pipeline-runner.ts";

const now = 10_000_000;
const name = (id: string) => `agetor-${id}`;
const parent = {
  id: "p",
  pipelineRun: {
    active: [{ stepId: "build", taskId: "new-build", seq: 5 }],
    blocked: [{ taskId: "parked", kind: "await" }],
  },
} as unknown as Task;
const step = (id: string, o: Partial<Task> = {}) => ({ id, pipelineParentId: "p", createdAt: now - 3_600_000, ...o }) as Task;

test("a finished step's session is closed; the active, parked and just-launched ones stay (#526/#361)", () => {
  const list = [parent, step("old-build"), step("new-build"), step("parked"), step("launching", { createdAt: now - 5_000 }), step("no-session")];
  const live = new Set(["old-build", "new-build", "parked", "launching"].map(name));
  expect(inactiveStepSessions(list, live, now, name)).toEqual(["old-build"]);
});

test("steps of a pipeline that has no run any more are all closed", () => {
  const done = { id: "p", pipelineRun: null } as unknown as Task;
  expect(inactiveStepSessions([done, step("a")], new Set([name("a")]), now, name)).toEqual(["a"]);
});
