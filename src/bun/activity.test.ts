import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineRunState, Task, TaskPrStatus } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-activity-"));
const { listActivity, pipelineActivity, recordActivity } = await import("./activity.ts");
const { prActivity } = await import("./pr-watch.ts");

const handoff = (summary: string, status?: "blocked") => ({
  schemaVersion: 1 as const, purpose: "", summary, reason: "", next: null, artifacts: [], openQuestions: [], ...(status ? { status } : {}),
});
const run = {
  status: "blocked", active: [], blocked: [], joins: {}, stepCount: 3, startedAt: 0, endedAt: null, pipelineId: "p", pipelineName: "Bugfix",
  snapshot: { graph: { steps: [{ id: "fix", name: "Fix" }, { id: "review", name: "Review" }, { id: "finish", name: "Finish" }], edges: [] } },
  history: [
    { seq: 1, stepId: "fix", taskId: "a", startedAt: 100, endedAt: 200, outcome: "succeeded", handoff: handoff("- Changed one line"), nextStepIds: ["review"] },
    { seq: 2, stepId: "review", taskId: "b", startedAt: 200, endedAt: 300, outcome: "succeeded", handoff: handoff("Approved"), nextStepIds: ["finish"] },
    { seq: 3, stepId: "finish", taskId: "c", startedAt: 300, endedAt: 400, outcome: "succeeded", handoff: handoff("Verification failed", "blocked"), nextStepIds: [] },
  ],
} as unknown as PipelineRunState;
const task = (o: Partial<Task> = {}) => ({ id: "t-activity", createdAt: 50, pipelineRun: run, ...o }) as Task;

describe("pipelineActivity", () => {
  test("each step's start and end in words, with its headline", () => {
    expect(pipelineActivity(task()).map((e) => e.text)).toEqual([
      "Fix started",
      "Fix finished → Review: Changed one line",
      "Review started",
      "Review finished → Finish: Approved",
      "Finish started",
      "Finish blocked: Verification failed",
    ]);
  });
});

describe("prActivity", () => {
  const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
    taskId: "t", number: 177, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "s", checks: "pending", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o,
  });
  test("opened, CI red (own vs inherited), green, comments, merged", () => {
    expect(prActivity(undefined, pr()).map((e) => e.text)).toEqual(["PR #177 opened"]);
    const inherited = pr({ checks: "failure", failingChecks: [{ name: "vitest", url: null, alsoOnBase: true }] });
    expect(prActivity(pr(), inherited)[0]).toMatchObject({ text: "CI failing, but only on checks that also fail on develop: vitest", tone: "warning" });
    const own = pr({ checks: "failure", failingChecks: [{ name: "lint", url: null, alsoOnBase: false }] });
    expect(prActivity(pr(), own)[0]).toMatchObject({ text: "CI failing: lint", tone: "danger" });
    expect(prActivity(own, own)).toEqual([]);
    expect(prActivity(own, pr({ checks: "success" })).map((e) => e.text)).toEqual(["CI passed"]);
    expect(prActivity(pr(), pr({ unresolvedThreads: 2 })).map((e) => e.text)).toEqual(["2 review comments to address"]);
    expect(prActivity(pr({ unresolvedThreads: 2 }), pr()).map((e) => e.text)).toEqual(["Review comments resolved"]);
    expect(prActivity(pr(), pr({ state: "merged" })).map((e) => e.text)).toEqual(["PR #177 merged"]);
  });
});

test("recorded events merge with the derived ones, newest first", () => {
  recordActivity("t-activity", { ts: 250, kind: "lease", text: "Took the lab", tone: "info" });
  const texts = listActivity(task()).map((e) => e.text);
  expect(texts[0]).toBe("Finish blocked: Verification failed");
  expect(texts).toContain("Took the lab");
  expect(texts.indexOf("Took the lab")).toBeLessThan(texts.indexOf("Review started"));
  expect(texts.at(-1)).toBe("Card created");
});
