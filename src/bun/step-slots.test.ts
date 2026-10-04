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
