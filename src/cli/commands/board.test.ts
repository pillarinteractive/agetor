import { test, expect } from "bun:test";
import { waitingLines } from "./board.ts";
import type { WaitingRow } from "../../shared/block-wait.ts";

const NOW = new Date(2031, 2, 4, 15, 0, 0).getTime();
const MIN = 60_000;
const row = (o: Partial<WaitingRow>): WaitingRow => ({
  taskId: "0123456789abcdef", title: "Issue #12: Inventory the widgets", step: "Build", category: "resource", source: "signal", what: "the rig", ref: "rig",
  reason: "the rig is busy", state: "waiting", since: NOW - 40 * MIN, attempt: 1, max: 6, nextAt: NOW + 20 * MIN, deadline: NOW + 23 * 60 * MIN, triggered: true,
  tried: [{ at: NOW - 10 * MIN, trigger: "the rig is free" }], escalation: null,
  line: "Build waiting for the rig — retrying when it frees or at 3:20 PM · attempt 2 of 6", ...o,
});
const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

test("agetor waiting: the queue with reason, attempts and next retry; then what it gave up on", () => {
  const text = plain(
    waitingLines(
      [
        row({}),
        row({ taskId: "fedcba9876543210", title: "Issue #13: Build the widget store", category: "unknown", source: "none", state: "escalated", attempt: 3, max: 3, nextAt: null, escalation: "still blocked after 3 automatic retries", reason: "the fixture service did not come up", line: "Build still blocked after 3 automatic retries: the fixture service did not come up", tried: [{ at: NOW - 200 * MIN, trigger: "its retry time came" }] }),
      ],
      NOW,
    ),
  );
  expect(text).toContain("Waiting in the queue (1) — retried by itself:");
  expect(text).toContain("Issue #12: Inventory the widgets [01234567]");
  expect(text).toContain("Build waiting for the rig — retrying when it frees or at 3:20 PM · attempt 2 of 6");
  expect(text).toContain("resource (signal) · waiting 40m · gives up 2:00 PM · retried 2:50 PM");
  expect(text).toContain("it says: the rig is busy");
  expect(text).toContain("Gave up — needs you (1):");
  expect(text).toContain("Build still blocked after 3 automatic retries: the fixture service did not come up");
  expect(text).toContain("retried 11:40 AM (its retry time came)");
  expect(text.indexOf("Gave up")).toBeGreaterThan(text.indexOf("Waiting in the queue"));
});

test("agetor waiting: nothing queued says so; a step's words are printed without control characters", () => {
  expect(plain(waitingLines([], NOW))).toBe("nothing is waiting in the queue");
  const text = waitingLines([row({ reason: "the rig \u001b[31mis busy\u0007", title: "T\u001b[2J" })], NOW).join("\n");
  expect(text).not.toContain("\u001b[31m");
  expect(text).not.toContain("\u0007");
  expect(text).not.toContain("\u001b[2J");
});
