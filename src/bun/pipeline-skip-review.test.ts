// A Build that Finish sent back and that changed nothing returns to Finish
// without another Review, once per approval (pipeline-runner.ts
// `skipReviewOfApprovedHead`). The run state is built by hand; the head the
// Build left is stubbed (`loopGuardDeps.readHead`).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineRunState, PipelineStepRecord, Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-skip-review-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
const { preferences } = await import("./db.ts");
const { newStep } = await import("../shared/pipeline.ts");
const runner = await import("./pipeline-runner.ts");

const ISSUE = "https://github.com/o/r/issues/7";
const HEAD = "a".repeat(40);
const build = newStep({ name: "Build", agentProfileId: "p", instructions: "" });
const review = newStep({ name: "Review", agentProfileId: "p", instructions: "" });
const finish = newStep({ name: "Finish", agentProfileId: "p", instructions: "" });
const graph = {
  steps: [build, review, finish],
  edges: [
    { id: "e1", from: build.id, to: review.id, label: "" },
    { id: "e2", from: review.id, to: build.id, label: "changes requested" },
    { id: "e3", from: review.id, to: finish.id, label: "approved" },
    { id: "e4", from: finish.id, to: build.id, label: "verification failed" },
  ],
  startStepId: build.id,
};
const handoff = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, purpose: "", summary: "", reason: "", next: "", artifacts: [], openQuestions: [], status: "done", ...extra });
const approval = (headSha = HEAD) => handoff({ reviewApproval: { verdict: "approved", headSha, issueUrl: ISSUE, acceptanceComplete: true, findings: [] } });
const rec = (seq: number, stepId: string, h: unknown = handoff(), nextStepIds: string[] = []) =>
  ({ seq, stepId, taskId: `t${seq}`, startedAt: seq, endedAt: seq, outcome: "succeeded", handoff: h, nextStepIds }) as unknown as PipelineStepRecord;
const runOf = (history: PipelineStepRecord[], gates = true) =>
  ({ pipelineName: "Change", snapshot: { graph, gates: gates ? { publish: true } : {} }, history }) as unknown as PipelineRunState;
const parent = { id: "card", pipelineId: null, issueUrl: ISSUE, worktreePath: "/tmp/x", workdir: "/tmp/x" } as unknown as Task;
const toReview = { kind: "steps" as const, stepIds: [review.id] };
// Review approved, Finish found CI failing, and this Build (seq 4) changed nothing.
const sentBack = [rec(1, build.id), rec(2, review.id, approval(), [finish.id]), rec(3, finish.id, handoff(), [build.id])];

beforeAll(() => {
  preferences.set("pipeline_gates", JSON.stringify({ publish: { pipelines: ["Change"] } }));
  runner.loopGuardDeps.readHead = async () => ({ head: HEAD, tree: "t" });
});
afterAll(() => rmTestDataDir(DATA_DIR));

test("an unchanged, approved head goes back to Finish without another Review", async () => {
  expect(await runner.skipReviewOfApprovedHead(parent, runOf(sentBack), "Build", { stepId: build.id, seq: 4 }, toReview))
    .toEqual({ kind: "steps", stepIds: [finish.id] });
});

test("only once per approval: Finish sending the same head back again means Review", async () => {
  const again = [...sentBack, rec(4, build.id, handoff(), [finish.id]), rec(5, finish.id, handoff(), [build.id])];
  expect(await runner.skipReviewOfApprovedHead(parent, runOf(again), "Build", { stepId: build.id, seq: 6 }, toReview)).toBe(toReview);
});

test("a changed head, an unapproved head, a Build Review sent back, or no publish gate go to Review", async () => {
  runner.loopGuardDeps.readHead = async () => ({ head: "b".repeat(40), tree: "t2" });
  expect(await runner.skipReviewOfApprovedHead(parent, runOf(sentBack), "Build", { stepId: build.id, seq: 4 }, toReview)).toBe(toReview);
  runner.loopGuardDeps.readHead = async () => ({ head: HEAD, tree: "t" });
  const notApproved = [rec(1, build.id), rec(2, review.id, approval("c".repeat(40)), [finish.id]), rec(3, finish.id, handoff(), [build.id])];
  expect(await runner.skipReviewOfApprovedHead(parent, runOf(notApproved), "Build", { stepId: build.id, seq: 4 }, toReview)).toBe(toReview);
  const fromReview = [rec(1, build.id), rec(2, review.id, approval(), [build.id])];
  expect(await runner.skipReviewOfApprovedHead(parent, runOf(fromReview), "Build", { stepId: build.id, seq: 3 }, toReview)).toBe(toReview);
  expect(await runner.skipReviewOfApprovedHead(parent, runOf(sentBack, false), "Build", { stepId: build.id, seq: 4 }, toReview)).toBe(toReview);
});
