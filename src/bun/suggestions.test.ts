import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LeaseStatus, PipelineRunState, Task, TaskPrStatus } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-suggestions-"));
const { suggestFor } = await import("./suggestions.ts");

const handoff = (summary: string, o: { reason?: string; openQuestions?: string[] } = {}) => ({
  schemaVersion: 1 as const, purpose: "", summary, reason: o.reason ?? "", next: null, artifacts: [], openQuestions: o.openQuestions ?? [], status: "blocked" as const,
});
const blockedRun = (summary: string, o: { reason?: string; openQuestions?: string[]; message?: string } = {}) => ({
  pipelineId: "p", pipelineName: "Bugfix", status: "blocked", active: [{ stepId: "finish", taskId: "step-1", seq: 4 }], joins: {}, stepCount: 4, startedAt: 0, endedAt: null,
  snapshot: { graph: { steps: [{ id: "finish", name: "Finish" }], edges: [] } },
  blocked: [{ taskId: "step-1", stepId: "finish", kind: "step-blocked", message: o.message ?? "blocked" }],
  history: [{ seq: 4, stepId: "finish", taskId: "step-1", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: handoff(summary, o), nextStepIds: [] }],
}) as unknown as PipelineRunState;
const task = (o: Partial<Task>) => ({ id: "t", title: "Issue #191", column: "blocked", workdir: "/repo", prUrl: null, archivedAt: null, pipelineParentId: null, ...o }) as Task;
const ctx = (o: Partial<{ pr: TaskPrStatus | null; leases: LeaseStatus[]; hasOpenPrPreset: boolean }> = {}) => ({ pr: null, leases: [], hasOpenPrPreset: true, ...o });
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t", number: 177, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "abc", checks: "failure", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, behindBy: 0, ...o,
});

describe("suggestFor", () => {
  test("a step blocked on the test environment gets the unblock message", () => {
    const s = suggestFor(task({ pipelineRun: blockedRun("- Final pnpm test failed: 17 suites could not load because DATABASE_URL is not set in .env.local") }), ctx());
    expect(s).toMatchObject({ apply: { kind: "message", stepTaskId: "step-1" } });
    expect(s!.title).toContain("Unblock Finish");
    expect((s!.apply as { text: string }).text).toContain("pillar_ci");
  });

  test("a step blocked on the lab gets Retry once the lease is free — not while it's held", () => {
    const t = task({ pipelineRun: blockedRun("The lab is held by another checkout") });
    const lease = (held: boolean): LeaseStatus => ({ project: "/repo", label: "lab", held, holderTaskId: null, holderTitle: null, checkout: null, owner: null, since: null, checkedAt: 0, error: null });
    expect(suggestFor(t, ctx({ leases: [lease(false)] }))).toMatchObject({ apply: { kind: "retry" } });
    expect(suggestFor(t, ctx({ leases: [lease(true)] }))).toBeNull();
  });

  test("a PR behind its base, failing only on checks the base has fixed, gets Update branch", () => {
    const stale = pr({ behindBy: 2, failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: false, passesOnBase: true }, { name: "required", url: null, alsoOnBase: false, passesOnBase: false }] });
    expect(suggestFor(task({ column: "review" }), ctx({ pr: stale }))).toMatchObject({ apply: { kind: "update-branch", number: 177 } });
    // Up to date with base: the failure is the PR's own — no Update branch.
    expect(suggestFor(task({ column: "review" }), ctx({ pr: { ...stale, behindBy: 0 } }))).toBeNull();
  });

  test("a finished run with committed work and no PR gets Open PR, when the preset exists", () => {
    const done = { ...blockedRun("x"), status: "done", blocked: [], active: [], history: [{ seq: 4, stepId: "finish", taskId: "step-1", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: { ...handoff("Committed 85858764 on the task branch"), status: undefined }, nextStepIds: [] }] } as unknown as PipelineRunState;
    expect(suggestFor(task({ column: "review", pipelineRun: done }), ctx())).toMatchObject({ apply: { kind: "followup", presetId: "pr" } });
    expect(suggestFor(task({ column: "review", pipelineRun: done }), ctx({ hasOpenPrPreset: false }))).toBeNull();
    expect(suggestFor(task({ column: "review", pipelineRun: done, prUrl: "https://x/pull/1" }), ctx())).toBeNull();
  });

  test("otherwise a block with open questions surfaces the first question", () => {
    const s = suggestFor(task({ pipelineRun: blockedRun("Needs a decision", { openQuestions: ["Should CUJs carry an unverified state?"] }) }), ctx());
    expect(s).toMatchObject({ title: "Finish asks: Should CUJs carry an unverified state?", apply: { kind: "open" } });
  });

  test("nothing to suggest for a healthy running card", () => {
    expect(suggestFor(task({ column: "running" }), ctx())).toBeNull();
  });
});
