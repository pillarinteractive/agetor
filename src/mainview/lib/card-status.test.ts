import { describe, expect, test } from "bun:test";
import { cardStatus, formatAge, needsYouList } from "./card-status.ts";
import type { PipelineRunState, Task, TaskPrStatus } from "../../shared/types.ts";
import type { TaskLeaseInfo } from "./leases.ts";

const NOW = 10 * 3_600_000;
const noLease: TaskLeaseInfo = { holds: [], waiting: [] };
const handoff = (summary: string, status?: "done" | "blocked") => ({
  schemaVersion: 1 as const, purpose: "", summary, reason: "", next: null, artifacts: [], openQuestions: [], ...(status ? { status } : {}),
});
const run = (o: Partial<PipelineRunState>): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Bugfix", status: "running", active: [], joins: {}, blocked: [], history: [], stepCount: 0,
  startedAt: 0, endedAt: null,
  snapshot: { graph: { steps: [{ id: "build", name: "Build" }, { id: "finish", name: "Finish" }, { id: "followup-1", name: "Open PR" }], edges: [], startStepId: "build" }, maxSteps: 25, profiles: {}, capturedAt: 0 } as unknown as PipelineRunState["snapshot"],
  ...o,
});
const task = (o: Partial<Task>) => ({ id: "t", title: "T", column: "running", pendingInteractionCount: 0, archivedAt: null, pipelineParentId: null, updatedAt: 0, ...o }) as Task;
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t", number: 177, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "s", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o,
});
const status = (t: Task, o: { pr?: TaskPrStatus | null; lease?: TaskLeaseInfo } = {}) => cardStatus(t, { pr: o.pr ?? null, lease: o.lease ?? noLease, now: NOW });

describe("cardStatus — pipelines", () => {
  test("running: the active step and how long it's been going, plus a held lease", () => {
    const t = task({ pipelineRun: run({ active: [{ stepId: "build", taskId: "s1", seq: 3 }], history: [{ seq: 3, stepId: "build", taskId: "s1", startedAt: NOW - 3 * 3_600_000 - 5 * 60_000, endedAt: null, outcome: null, handoff: null, nextStepIds: [] }] }) });
    expect(status(t, { lease: { holds: ["lab"], waiting: [] } })).toMatchObject({ line: "Build · 3h 5m · holds lab", tone: "info", needsYou: null });
  });

  test("blocked on a lease held elsewhere: waiting, nothing for the user to do", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: "m" }] }) });
    expect(status(t, { lease: { holds: [], waiting: [{ label: "lab", heldBy: "E2E", free: false }] } })).toMatchObject({ line: "Waiting for lab (held by E2E)", needsYou: null });
  });

  test("blocked, lease now free: retry is the user's move", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: "m" }] }) });
    expect(status(t, { lease: { holds: [], waiting: [{ label: "lab", heldBy: null, free: true }] } }).needsYou).toMatchObject({ action: "retry", actionLabel: "Retry" });
  });

  test("blocked step explains itself with its handoff headline", () => {
    const t = task({ column: "blocked", pipelineRun: run({
      status: "blocked",
      blocked: [{ taskId: "s5", stepId: "followup-1", kind: "step-blocked", message: "long flattened message" }],
      history: [{ seq: 5, stepId: "followup-1", taskId: "s5", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: handoff("- Verification failed: DATABASE_URL unset\n- more", "blocked"), nextStepIds: [] }],
    }) });
    expect(status(t)).toMatchObject({ line: "Open PR blocked: Verification failed: DATABASE_URL unset", tone: "danger", needsYou: { action: "open" } });
  });

  const finished = (o: Partial<Task> = {}) => task({ column: "review", pipelineRun: run({
    status: "done",
    history: [{ seq: 4, stepId: "finish", taskId: "s4", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: handoff("Committed the fix"), nextStepIds: [] }],
  }), ...o });

  test("finished without a PR: review the result", () => {
    expect(status(finished())).toMatchObject({ line: "Finished: Committed the fix", needsYou: { actionLabel: "Review" } });
  });

  test("finished with a PR: the PR leads — inherited CI waits, own CI needs a fix, green is ready to merge", () => {
    const inherited = pr({ checks: "failure", failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: true }, { name: "required", url: null, alsoOnBase: false }] });
    expect(status(finished(), { pr: inherited })).toMatchObject({ line: "PR #177: waiting on develop (same checks fail there)", needsYou: null });
    const own = pr({ checks: "failure", failingChecks: [{ name: "lint", url: null, alsoOnBase: false }] });
    expect(status(finished(), { pr: own })).toMatchObject({ tone: "danger", needsYou: { actionLabel: "Fix CI" } });
    expect(status(finished(), { pr: pr() })).toMatchObject({ line: "PR #177: ready to merge", needsYou: { action: "open-pr" } });
    expect(status(finished(), { pr: pr({ state: "merged" }) })).toMatchObject({ line: "PR #177 merged", needsYou: null });
  });

  test("a question beats everything", () => {
    expect(status(finished({ pendingInteractionCount: 1 }), { pr: pr() })).toMatchObject({ needsYou: { actionLabel: "Answer" } });
  });
});

describe("cardStatus — single-agent tasks", () => {
  test("running shows todo progress; review needs a look; blocked needs you", () => {
    expect(status(task({ todoProgress: { completed: 2, total: 5 } })).line).toBe("Working · 2/5 todos");
    expect(status(task({ column: "review" })).needsYou?.actionLabel).toBe("Review");
    expect(status(task({ column: "blocked" })).tone).toBe("danger");
  });
});

describe("needsYouList", () => {
  test("only cards waiting on the user, questions first, never step rows or archived", () => {
    const items = [
      { task: task({ id: "review", column: "review", updatedAt: 5 }), status: status(task({ column: "review" })) },
      { task: task({ id: "q", pendingInteractionCount: 1 }), status: status(task({ pendingInteractionCount: 1 })) },
      { task: task({ id: "busy" }), status: status(task({})) },
      { task: task({ id: "step", pipelineParentId: "p", column: "review" }), status: status(task({ column: "review" })) },
    ];
    expect(needsYouList(items).map((i) => i.task.id)).toEqual(["q", "review"]);
  });
});

test("formatAge", () => {
  expect(formatAge(30_000)).toBe("just now");
  expect(formatAge(12 * 60_000)).toBe("12m");
  expect(formatAge(2 * 3_600_000)).toBe("2h");
});
