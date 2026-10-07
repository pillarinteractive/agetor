import { expect, test } from "bun:test";
import { classifyStall } from "./stall-monitor.ts";

test("a stall is busy when the process burned CPU through it, idle when it didn't", () => {
  expect(classifyStall(5_000, 4_800)).toBe("busy");
  expect(classifyStall(5_000, 100)).toBe("idle");
  expect(classifyStall(5_000, 1_500)).toBe("mixed");
});
