import { expect, test } from "bun:test";
import type { PipelineBlock } from "../shared/types.ts";
import { newBlocks, summarizeBlocks } from "./block-log.ts";

const b = (taskId: string, message: string): PipelineBlock => ({ taskId, stepId: "finish", kind: "step-blocked", message });

test("newBlocks: only the ones that just appeared", () => {
  expect(newBlocks([b("a", "x")], [b("a", "x"), b("b", "y")])).toEqual([b("b", "y")]);
  expect(newBlocks([], [b("a", "x")])).toEqual([b("a", "x")]);
  // Same step, new reason: a new block.
  expect(newBlocks([b("a", "x")], [b("a", "z")])).toEqual([b("a", "z")]);
});

test("summarizeBlocks: grouped by pipeline/step/kind, most frequent first, newest examples", () => {
  const e = (ts: number, step: string, title: string) => ({ ts, taskId: "t", title, pipeline: "Bugfix", step, kind: "step-blocked", message: `m${ts}` });
  const rows = summarizeBlocks([e(1, "Finish", "A"), e(2, "Fix", "B"), e(3, "Finish", "C")]);
  expect(rows.map((r) => [r.step, r.count])).toEqual([["Finish", 2], ["Fix", 1]]);
  expect(rows[0]!.lastAt).toBe(3);
  expect(rows[0]!.examples[0]).toEqual({ title: "C", message: "m3" });
});

test("readBlockLog: a resolution line names the rung that handled the newest matching block, and the block count is unchanged", async () => {
  // Under `bun test` db.ts allocates a throwaway data dir (never ~/.agetor).
  const { logBlocks, logBlockResolution, readBlockLog } = await import("./block-log.ts");
  const e = { taskId: `t-${Math.random()}`, title: "T", pipeline: "Change", step: "Finish", kind: "step-blocked", message: "needs you" };
  logBlocks([e], 1);
  logBlockResolution({ ...e, resolution: "answered" }, 2);
  logBlocks([e], 3);
  logBlocks([{ ...e, message: "other" }], 4);
  logBlockResolution({ ...e, resolution: "rerouted" }, 5);
  const mine = readBlockLog().filter((x) => x.taskId === e.taskId);
  expect(mine.map((x) => [x.ts, x.message, x.resolution ?? null])).toEqual([[1, "needs you", "answered"], [3, "needs you", "rerouted"], [4, "other", null]]);
});
