import { describe, expect, test } from "bun:test";
import type { Task } from "./types.ts";
import { blockMentionsLease, leaseQueue, ordinal } from "./block-reason.ts";

const blocked = (id: string, message: string, endedAt: number, over: Partial<Task> = {}): Task =>
  ({
    id, title: id, workdir: "/repo", column: "blocked", archivedAt: null, pipelineParentId: null, updatedAt: 0,
    pipelineRun: {
      status: "blocked",
      blocked: [{ taskId: `${id}-s`, stepId: "build", kind: "step-blocked", message }],
      history: [{ seq: 1, stepId: "build", taskId: `${id}-s`, startedAt: 0, endedAt, outcome: "failed", handoff: null, nextStepIds: [] }],
      active: [],
      snapshot: { graph: { steps: [{ id: "build", name: "Build" }] } },
    },
    ...over,
  }) as unknown as Task;

describe("blockMentionsLease", () => {
  test("the lease's label, or the generic lease words", () => {
    expect(blockMentionsLease("plab lease is held by another checkout", "lab")).toBe(true);
    expect(blockMentionsLease("Waiting for the lab to free up", "lab")).toBe(true);
    expect(blockMentionsLease("node_modules missing; pnpm install needed", "lab")).toBe(false);
    // "lab" as a word only — not "label" or "collaborate".
    expect(blockMentionsLease("fix the label; collaborate with design", "lab")).toBe(false);
  });
});

test("leaseQueue: the project's cards blocked on the lease, longest waiting first", () => {
  const list = [
    blocked("late", "lab lease held by VM tests", 300),
    blocked("deps", "Cannot find module 'vitest'", 100),
    blocked("early", "waiting for the lab", 200),
    blocked("other-repo", "waiting for the lab", 50, { workdir: "/other" }),
    blocked("archived", "waiting for the lab", 10, { archivedAt: 1 as never }),
  ];
  expect(leaseQueue(list, { project: "/repo/", label: "lab" }).map((q) => q.task.id)).toEqual(["early", "late"]);
});

test("ordinal", () => {
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
});
