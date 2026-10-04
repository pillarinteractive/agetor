import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task, TaskPrStatus } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-pr-watch-"));
const {
  PR_FIX_CI_ACTION, PR_REVIEW_ACTION, followUpReady, markInherited, prFollowUpActions, prFollowUpInstructions, rollUpChecks,
  shouldAutoFix, staleAgainstBase, tasksToWatch,
} = await import("./pr-watch.ts");

const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, htmlUrl: `https://ci/${name}` });
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t1", number: 42, url: "https://github.com/o/r/pull/42", state: "open", draft: false, baseRef: "develop", headSha: "abc",
  checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o,
});
const task = (o: Partial<Task>) => ({ id: "t1", column: "review", branch: "feature/x", archivedAt: null, pipelineParentId: null, ...o }) as Task;

describe("rollUpChecks", () => {
  test("any failed run fails the PR and is listed; otherwise pending until all complete", () => {
    expect(rollUpChecks([])).toEqual({ checks: "none", failing: [] });
    expect(rollUpChecks([run("lint", "completed", "success"), run("test", "in_progress", null)]).checks).toBe("pending");
    expect(rollUpChecks([run("lint", "completed", "success"), run("skip", "completed", "skipped")]).checks).toBe("success");
    const failed = rollUpChecks([run("lint", "completed", "failure"), run("e2e", "completed", "timed_out"), run("test", "queued", null)]);
    expect(failed.checks).toBe("failure");
    expect(failed.failing.map((f) => f.name)).toEqual(["lint", "e2e"]);
  });
});

describe("tasksToWatch", () => {
  test("live board cards with a branch; Done only while the PR is still open; never step rows", () => {
    const known = new Map<string, TaskPrStatus>([["open-done", pr({ taskId: "open-done" })], ["merged", pr({ taskId: "merged", state: "merged" })]]);
    const list = [
      task({ id: "review" }),
      task({ id: "nobranch", branch: null }),
      task({ id: "archived", archivedAt: 1 }),
      task({ id: "step", pipelineParentId: "p" }),
      task({ id: "backlog", column: "backlog" }),
      task({ id: "done-unknown", column: "done" }),
      task({ id: "open-done", column: "done" }),
      task({ id: "merged", column: "review" }),
    ];
    // A Done card is looked up once (it may have merged before a restart)…
    expect(tasksToWatch(list, known, new Set()).map((t) => t.id)).toEqual(["review", "done-unknown", "open-done"]);
    // …then only while its PR is open.
    expect(tasksToWatch(list, known, new Set(["done-unknown"])).map((t) => t.id)).toEqual(["review", "open-done"]);
  });
});

describe("PR follow-ups", () => {
  test("failing CI and unresolved threads each offer a suggested action; a clean or merged PR offers none", () => {
    expect(prFollowUpActions(pr())).toEqual([]);
    expect(prFollowUpActions(pr({ state: "merged", checks: "failure" }))).toEqual([]);
    const actions = prFollowUpActions(pr({ checks: "failure", failingChecks: [{ name: "lint", url: null, alsoOnBase: false }], unresolvedThreads: 2 }));
    expect(actions.map((a) => [a.id, a.suggested])).toEqual([[PR_FIX_CI_ACTION, true], [PR_REVIEW_ACTION, true]]);
    expect(actions[0]!.label).toBe("Fix CI (#42)");
    expect(actions[1]!.matched).toEqual(["2 unresolved threads"]);
  });

  test("instructions carry the PR and failing checks, allow pushing only the task branch, and go stale with the PR", () => {
    const failing = pr({ checks: "failure", failingChecks: [{ name: "lint", url: "https://ci/lint", alsoOnBase: false }] });
    const ci = prFollowUpInstructions(PR_FIX_CI_ACTION, failing)!;
    expect(ci.instructions).toContain("#42");
    expect(ci.instructions).toContain("- lint (https://ci/lint)");
    expect(ci.instructions).toContain("never force-push");
    expect(prFollowUpInstructions(PR_FIX_CI_ACTION, pr())).toBeNull();
    expect(prFollowUpInstructions(PR_REVIEW_ACTION, pr({ unresolvedThreads: 1 }))!.instructions).toContain("Don't resolve threads yourself");
    expect(prFollowUpInstructions(PR_REVIEW_ACTION, null)).toBeNull();
  });
});

describe("inherited failures", () => {
  const fail = (name: string, alsoOnBase = false) => ({ name, url: null, alsoOnBase });

  test("markInherited flags the PR failures that also fail on the base branch", () => {
    expect(markInherited([fail("vitest"), fail("lint")], [fail("vitest")]).map((f) => [f.name, f.alsoOnBase])).toEqual([
      ["vitest", true],
      ["lint", false],
    ]);
  });

  test("no Fix CI when every failure is inherited (the 'required' rollup doesn't count)", () => {
    const inheritedOnly = pr({ checks: "failure", failingChecks: [fail("vitest", true), fail("required")] });
    expect(prFollowUpActions(inheritedOnly)).toEqual([]);
    expect(prFollowUpInstructions(PR_FIX_CI_ACTION, inheritedOnly)).toBeNull();
  });

  test("Fix CI lists only the PR's own failures and tells the agent to leave inherited ones alone", () => {
    const mixed = pr({ checks: "failure", failingChecks: [fail("vitest", true), fail("lint")] });
    expect(prFollowUpActions(mixed)[0]!.matched).toEqual(["lint"]);
    const text = prFollowUpInstructions(PR_FIX_CI_ACTION, mixed)!.instructions;
    expect(text).toContain("- lint");
    expect(text).not.toContain("- vitest");
    expect(text).toContain("also fail on develop");
  });
});

describe("auto Fix CI", () => {
  const doneRun = { status: "done", active: [], snapshot: { graph: { steps: [], edges: [] } } };
  const card = (run: unknown) => task({ pipelineRun: run as Task["pipelineRun"] });
  const failing = pr({ checks: "failure", headSha: "sha1", failingChecks: [{ name: "lint", url: null, alsoOnBase: false }] });
  const opts = (o: Partial<{ enabled: boolean; ledger: Record<string, { count: number; lastSha: string | null }> }> = {}) => ({
    enabled: true, ledger: {}, isLive: () => false, ...o,
  });

  test("starts for the PR's own failure on a finished run", () => {
    expect(shouldAutoFix(card(doneRun), failing, opts())).toBe(true);
  });

  test("never when off, inherited, already tried on this commit, or out of attempts", () => {
    expect(shouldAutoFix(card(doneRun), failing, opts({ enabled: false }))).toBe(false);
    const inherited = pr({ checks: "failure", failingChecks: [{ name: "vitest", url: null, alsoOnBase: true }] });
    expect(shouldAutoFix(card(doneRun), inherited, opts())).toBe(false);
    expect(shouldAutoFix(card(doneRun), failing, opts({ ledger: { "t1#42": { count: 1, lastSha: "sha1" } } }))).toBe(false);
    expect(shouldAutoFix(card(doneRun), failing, opts({ ledger: { "t1#42": { count: 2, lastSha: "old" } } }))).toBe(false);
    expect(shouldAutoFix(card(doneRun), failing, opts({ ledger: { "t1#42": { count: 1, lastSha: "old" } } }))).toBe(true);
  });

  test("a blocked run takes a follow-up only when nothing in it is still running", () => {
    const blocked = { status: "blocked", active: [{ stepId: "s", taskId: "step-1", seq: 1 }], snapshot: {} };
    expect(followUpReady(card(blocked), () => false)).toBe(true);
    expect(followUpReady(card(blocked), () => true)).toBe(false);
    expect(followUpReady(card({ ...doneRun, status: "running" }))).toBe(false);
    expect(followUpReady(task({}))).toBe(false);
  });
});

describe("behind the base branch", () => {
  const stale = (behindBy: number) =>
    pr({ checks: "failure", behindBy, failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: false, passesOnBase: true }] });

  test("a failure that passes on an updated base isn't the PR's: no Fix CI, no auto-fix, Update branch instead", () => {
    expect(staleAgainstBase(stale(3))).toBe(true);
    expect(prFollowUpActions(stale(3))).toEqual([]);
    const doneRun = { status: "done", active: [], snapshot: { graph: { steps: [], edges: [] } } };
    expect(shouldAutoFix(task({ pipelineRun: doneRun as unknown as Task["pipelineRun"] }), stale(3), { enabled: true, ledger: {}, isLive: () => false })).toBe(false);
  });

  test("up to date with the base, the same failure is the PR's own", () => {
    expect(staleAgainstBase(stale(0))).toBe(false);
    expect(prFollowUpActions(stale(0)).map((a) => a.id)).toEqual([PR_FIX_CI_ACTION]);
  });
});

test("auto Fix CI: on by default for pipeline cards, off for plain tasks, the pref overrides", async () => {
  const { autoFixEnabled } = await import("./pr-watch.ts");
  const pipe = { pipelineId: "p" } as unknown as import("../shared/types.ts").Task;
  const plain = { pipelineId: null } as unknown as import("../shared/types.ts").Task;
  expect(autoFixEnabled(pipe, null)).toBe(true);
  expect(autoFixEnabled(plain, null)).toBe(false);
  expect(autoFixEnabled(pipe, "false")).toBe(false);
  expect(autoFixEnabled(plain, "true")).toBe(true);
});

test("auto update branch: only an open PR behind its base whose failures pass there, once per head", async () => {
  const { shouldAutoUpdate } = await import("./pr-watch.ts");
  const base = {
    taskId: "t", number: 9, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "h1", checks: "failure",
    failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: false, passesOnBase: true }], unresolvedThreads: 0, checkedAt: 0, behindBy: 2,
  } as import("../shared/types.ts").TaskPrStatus;
  expect(shouldAutoUpdate(base, { enabled: true, done: new Set() })).toBe(true);
  expect(shouldAutoUpdate(base, { enabled: true, done: new Set(["9:h1"]) })).toBe(false);
  expect(shouldAutoUpdate(base, { enabled: false, done: new Set() })).toBe(false);
  // Develop hasn't moved ahead: nothing to merge.
  expect(shouldAutoUpdate({ ...base, behindBy: 0 }, { enabled: true, done: new Set() })).toBe(false);
  // Its own failure (doesn't pass on base): that's Fix CI's job.
  expect(shouldAutoUpdate({ ...base, failingChecks: [{ name: "web / vitest", url: null, alsoOnBase: false, passesOnBase: false }] }, { enabled: true, done: new Set() })).toBe(false);
});

test("the issue a card fixes: its issue link, else a Fixes/Closes/Resolves line in the prompt", async () => {
  const { issueNumberForTask } = await import("./pr-watch.ts");
  expect(issueNumberForTask({ issueUrl: "https://github.com/o/r/issues/191", prompt: "" })).toBe(191);
  expect(issueNumberForTask({ issueUrl: null, prompt: "Work on it.\n\nFixes #156" })).toBe(156);
  expect(issueNumberForTask({ issueUrl: null, prompt: "closes #7 please" })).toBe(7);
  expect(issueNumberForTask({ issueUrl: null, prompt: "See #12 for context" })).toBeNull();
});
