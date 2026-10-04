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
