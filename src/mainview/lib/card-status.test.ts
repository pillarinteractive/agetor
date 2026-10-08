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
const status = (t: Task, o: { pr?: TaskPrStatus | null; lease?: TaskLeaseInfo; progressActive?: boolean } = {}) => cardStatus(t, { pr: o.pr ?? null, lease: o.lease ?? noLease, now: NOW, progressActive: o.progressActive });

describe("cardStatus — pipelines", () => {
  test("running: the active step and how long it's been going, plus a held lease", () => {
    const t = task({ pipelineRun: run({ active: [{ stepId: "build", taskId: "s1", seq: 3 }], history: [{ seq: 3, stepId: "build", taskId: "s1", startedAt: NOW - 3 * 3_600_000 - 5 * 60_000, endedAt: null, outcome: null, handoff: null, nextStepIds: [] }] }) });
    expect(status(t, { lease: { holds: ["lab"], waiting: [] } })).toMatchObject({ line: "Build step running · 3h 5m · holds lab", tone: "info", needsYou: null });
  });

  test("blocked on a lease held elsewhere: waiting, nothing for the user to do", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: "m" }] }) });
    expect(status(t, { lease: { holds: [], waiting: [{ label: "lab", heldBy: "E2E", free: false, position: 1, queueLength: 1 }] } })).toMatchObject({ line: "Waiting for lab (held by E2E)", needsYou: null });
  });

  test("waiting on an automatic retry (usage-limit reset, transient backoff): nothing for the user to do", () => {
    const at = new Date(2026, 9, 6, 23, 35).getTime();
    const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const blocked = [{ taskId: "s1", stepId: "build", kind: "step-failed" as const, message: "m" }];
    const quota = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked, autoRetry: { stepId: "build", kind: "quota", attempt: 1, at, reason: "limit" } }) });
    expect(status(quota)).toMatchObject({ line: `Build waiting for the usage limit to reset · retries at ${time}`, needsYou: null });
    const flake = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked, autoRetry: { stepId: "build", kind: "transient", attempt: 2, at, reason: "529" } }) });
    expect(status(flake)).toMatchObject({ line: `Build failed · retrying automatically at ${time} (attempt 2)`, needsYou: null });
    // Given up: back to the ordinary blocked status.
    const gaveUp = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked, autoRetry: { stepId: "build", kind: "transient", attempt: 5, at: null, reason: "529" } }) });
    expect(status(gaveUp).line).not.toContain("retrying automatically");
  });

  test("second in line for a busy lease says so", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: "m" }] }) });
    expect(status(t, { lease: { holds: [], waiting: [{ label: "lab", heldBy: "E2E", free: false, position: 2, queueLength: 3 }] } }).line).toBe("Waiting for lab (held by E2E, 2nd of 3 in line)");
  });

  test("free lease but someone is ahead in line: still waiting, nothing to do", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: "m" }] }) });
    expect(status(t, { lease: { holds: [], waiting: [{ label: "lab", heldBy: null, free: true, position: 2, queueLength: 2 }] } })).toMatchObject({ line: "Waiting for lab, 2nd of 2 in line", needsYou: null });
  });

  test("running but quiet past the threshold: a warning the user should check", () => {
    const t = task({ lastActivityAt: NOW - 25 * 60_000, pipelineRun: run({ active: [{ stepId: "build", taskId: "s1", seq: 3 }], history: [{ seq: 3, stepId: "build", taskId: "s1", startedAt: NOW - 3_600_000, endedAt: null, outcome: null, handoff: null, nextStepIds: [] }] }) });
    expect(status(t)).toMatchObject({ line: "Build step running · 1h · quiet 25m", tone: "warning", needsYou: { reason: "Build has been quiet for 25m", actionLabel: "Check" } });
    // A lab/E2E run reporting live progress isn't quiet.
    expect(status(t, { progressActive: true })).toMatchObject({ tone: "info", needsYou: null });
    // Recent activity isn't quiet either.
    expect(status({ ...t, lastActivityAt: NOW - 60_000 })).toMatchObject({ tone: "info", needsYou: null });
  });

  test("blocked, lease now free: retry is the user's move", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: "m" }] }) });
    expect(status(t, { lease: { holds: [], waiting: [{ label: "lab", heldBy: null, free: true, position: 1, queueLength: 1 }] } }).needsYou).toMatchObject({ action: "retry", actionLabel: "Retry" });
  });

  test("a stopped step says why (its handoff's reason, not what it did) and what it's asking", () => {
    const h = { ...handoff("- Merged origin/develop; working tree is clean\n- more", "blocked"), reason: "- Verification failed: DATABASE_URL unset\n- more", openQuestions: ["Can it run with less load?"] };
    const t = task({ column: "blocked", pipelineRun: run({
      status: "blocked",
      blocked: [{ taskId: "s5", stepId: "followup-1", kind: "step-blocked", message: 'step "Open PR" reported it is blocked: - Verification failed: DATABASE_URL unset' }],
      history: [{ seq: 5, stepId: "followup-1", taskId: "s5", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: h, nextStepIds: [] }],
    }) });
    expect(status(t)).toMatchObject({
      line: "Open PR stopped: Verification failed: DATABASE_URL unset",
      tone: "danger",
      needsYou: { action: "open", reason: "Open PR asks: Can it run with less load?" },
    });
    // No handoff: the runner's message, without its preamble.
    const bare = task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s5", stepId: "followup-1", kind: "step-blocked", message: 'step "Open PR" reported it is blocked: tests timed out' }] }) });
    expect(status(bare).line).toBe("Open PR stopped: tests timed out");
  });

  const finished = (o: Partial<Task> = {}) => task({ column: "review", pipelineRun: run({
    status: "done",
    history: [{ seq: 4, stepId: "finish", taskId: "s4", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: handoff("Committed the fix"), nextStepIds: [] }],
  }), ...o });

  test("finished without a PR: In Review needs a PR first", () => {
    expect(status(finished())).toMatchObject({ line: "No PR yet — Committed the fix", tone: "warning", needsYou: { actionLabel: "Open" } });
  });

  test("finished with a PR: the PR leads — inherited CI waits, own CI needs a fix, green is ready to merge", () => {
    const inherited = pr({ checks: "failure", failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: true }, { name: "required", url: null, alsoOnBase: false }] });
    expect(status(finished(), { pr: inherited })).toMatchObject({ line: "PR #177: waiting on develop (same checks fail there)", needsYou: null });
    const own = pr({ checks: "failure", failingChecks: [{ name: "lint", url: null, alsoOnBase: false }] });
    expect(status(finished(), { pr: own })).toMatchObject({ tone: "danger", needsYou: { actionLabel: "Fix CI" } });
    expect(status(finished(), { pr: pr() })).toMatchObject({ line: "PR #177: checks pass — review and sign off", needsYou: { action: "open-pr", actionLabel: "Review PR" } });
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

test("a card blocked by another card says what it's waiting on — until it lands", () => {
  const dep = { taskId: "d", title: "Issue #214: rollupInvariants times out", satisfied: false, detail: "PR #201 · checks running" };
  const t = task({ column: "blocked", blockedBy: [dep] });
  expect(status(t)).toMatchObject({ line: "Waiting on #214 · PR #201 · checks running", tone: "warning", needsYou: null });
  const other = { ...dep, taskId: "e", title: "procexec TestRun_BoundsStdout times out on macOS" };
  expect(status(task({ column: "blocked", blockedBy: [dep, other] })).line).toBe("Waiting on #214, procexec…");
  // Satisfied dependencies don't hold the card.
  expect(status(task({ column: "ready", blockedBy: [{ ...dep, satisfied: true }] })).line).not.toContain("Waiting on");
});

describe("cardStatus — Ready to Merge", () => {
  const inMerge = (o: Partial<Task> = {}) => task({ column: "merge", ...o });
  test("says which part of getting to merged it's on", () => {
    expect(status(inMerge())).toMatchObject({ line: "Opening a PR so it can merge" });
    expect(status(inMerge(), { pr: pr({ checks: "pending" }) })).toMatchObject({ line: "PR #177: merges when checks pass", needsYou: null });
    expect(status(inMerge(), { pr: pr({ checks: "success" }) })).toMatchObject({ line: "PR #177: green — merging", tone: "success" });
    expect(status(inMerge(), { pr: pr({ checks: "success", behindBy: 2 }) }).line).toBe("PR #177: updating from develop, then merging");
    expect(status(inMerge(), { pr: pr({ checks: "success", unresolvedThreads: 1 }) }).line).toBe("PR #177: addressing review comments, then merging");
    expect(status(inMerge(), { pr: pr({ checks: "failure", failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: false }] }) }).line).toBe("PR #177: CI failing — fixing before merge");
  });
  test("a closed or draft PR needs the user", () => {
    expect(status(inMerge(), { pr: pr({ state: "closed" }) }).needsYou).not.toBeNull();
    expect(status(inMerge(), { pr: pr({ draft: true }) }).needsYou).not.toBeNull();
  });
});
