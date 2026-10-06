import { expect, test } from "bun:test";
import type { Task } from "../shared/types.ts";
import { unsettledSteps } from "./pipeline-runner.ts";

const now = 10_000_000;
const parent = (o: { blocked?: unknown[]; outcome?: string | null } = {}) =>
  ({
    id: "p",
    archivedAt: null,
    pipelineRun: {
      active: [{ stepId: "review", taskId: "s", seq: 3 }],
      blocked: o.blocked ?? [],
      history: [{ stepId: "review", taskId: "s", seq: 3, startedAt: 0, outcome: o.outcome ?? null }],
    },
  }) as unknown as Task;
const step = (o: Partial<Task> = {}) => ({ id: "s", runId: "r", column: "review", updatedAt: now - 10 * 60_000, ...o }) as Task;

test("a finished, idle, unsettled step is picked up", () => {
  expect(unsettledSteps([parent(), step()], () => false, now)).toEqual([{ taskId: "s", runId: "r" }]);
});

test("not while it's live, still running, recently finished, blocked/parked, or already settled", () => {
  expect(unsettledSteps([parent(), step()], () => true, now)).toEqual([]);
  expect(unsettledSteps([parent(), step({ column: "running" })], () => false, now)).toEqual([]);
  expect(unsettledSteps([parent(), step({ updatedAt: now - 60_000 })], () => false, now)).toEqual([]);
  expect(unsettledSteps([parent({ blocked: [{ taskId: "s", kind: "await" }] }), step()], () => false, now)).toEqual([]);
  expect(unsettledSteps([parent({ outcome: "succeeded" }), step()], () => false, now)).toEqual([]);
});
