import { expect, test } from "bun:test";
import { DEFAULT_STEP_SLOTS, isHeavyStep, parseStepSlots, slotDecision } from "./step-slots.ts";
import { deriveRunStatus } from "../shared/pipeline.ts";

test("config: defaults, overrides, floors", () => {
  expect(parseStepSlots(null)).toEqual(DEFAULT_STEP_SLOTS);
  expect(parseStepSlots('{"max":5,"heavy":{"max":2,"steps":["Finish"]}}')).toEqual({ max: 5, heavy: { max: 2, steps: ["Finish"] } });
  expect(parseStepSlots('{"max":0}').max).toBe(DEFAULT_STEP_SLOTS.max);
});

test("heavy steps match by name prefix, case-insensitively", () => {
  expect(isHeavyStep("Finish", DEFAULT_STEP_SLOTS)).toBe(true);
  expect(isHeavyStep("fix ci", DEFAULT_STEP_SLOTS)).toBe(true);
  expect(isHeavyStep("Resolve merge conflicts with develop", DEFAULT_STEP_SLOTS)).toBe(true);
  expect(isHeavyStep("Build", DEFAULT_STEP_SLOTS)).toBe(false);
});

test("a step waits when all slots are busy, or when it's heavy and the verification slot is taken", () => {
  const slots = { max: 3, heavy: { max: 1, steps: ["Finish"] } };
  expect(slotDecision("Build", { total: 2, heavy: 1 }, slots)).toEqual({ ok: true });
  expect(slotDecision("Finish", { total: 2, heavy: 1 }, slots).ok).toBe(false);
  expect(slotDecision("Finish", { total: 2, heavy: 0 }, slots)).toEqual({ ok: true });
  expect(slotDecision("Build", { total: 3, heavy: 0 }, slots).ok).toBe(false);
});

test("a run whose only blocks are slot waits is running, not blocked", () => {
  const base = { status: "running", active: [], history: [], joins: {} } as never as import("../shared/types.ts").PipelineRunState;
  const wait: import("../shared/types.ts").PipelineBlock = { taskId: null, stepId: "finish", kind: "slot-wait", message: "m", pending: { stepId: "finish", arrivals: [] } };
  expect(deriveRunStatus({ ...base, blocked: [wait] })).toBe("running");
  expect(deriveRunStatus({ ...base, blocked: [wait, { taskId: "t", stepId: "b", kind: "step-blocked", message: "x" }] })).toBe("blocked");
});

test("a live step waiting on the user or on a usage-limit pause doesn't hold a step slot", async () => {
  const { slotUse } = await import("./step-slots.ts");
  type T = import("../shared/types.ts").Task;
  const slots = { max: 8, heavy: { max: 2, steps: ["Finish"] } };
  const step = (id: string, pending = 0) => ({ id, archivedAt: null, pipelineParentId: "p", column: "running", pendingInteractionCount: pending }) as never as T;
  const run = {
    status: "running",
    blocked: [],
    history: [],
    joins: {},
    active: [{ stepId: "build", taskId: "s1", seq: 1 }, { stepId: "finish", taskId: "s2", seq: 2 }, { stepId: "build", taskId: "s3", seq: 3 }],
    snapshot: { graph: { steps: [{ id: "build", name: "Build" }, { id: "finish", name: "Finish" }], edges: [] } },
  };
  const parent = { id: "p", archivedAt: null, pipelineParentId: null, column: "running", pendingInteractionCount: 1, pipelineRun: run } as never as T;
  const plain = (id: string, pending: number) => ({ id, archivedAt: null, pipelineParentId: null, column: "running", pendingInteractionCount: pending, pipelineRun: null }) as never as T;
  const live = () => true;
  // All three steps and one plain task working.
  expect(slotUse(live, slots, [parent, step("s1"), step("s2"), step("s3"), plain("x", 0)], () => false)).toEqual({ total: 4, heavy: 1 });
  // s2 (heavy) has a question card open, s3 is paused on the usage limit, the plain task waits on a permission.
  expect(slotUse(live, slots, [parent, step("s1"), step("s2", 1), step("s3"), plain("x", 2)], (id) => id === "s3")).toEqual({ total: 1, heavy: 0 });
});
