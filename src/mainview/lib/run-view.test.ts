import { describe, expect, test } from "bun:test";
import { cardState, type CardState } from "./card-state.ts";
import { checksEvidence, executionSummary, recoveryControls, roundOf, stepTiles, type BandAction } from "./run-view.ts";
import type { CheckLedgerEntry, PipelineBlock, PipelineBlockWait, PipelineRunState, PipelineStepRecord, Task, TaskPrStatus } from "../../shared/types.ts";

// A fixed clock: every age and retry time below is measured from it.
const NOW = new Date(2031, 2, 4, 15, 0).getTime();
const MIN = 60_000;
const STEPS = [
  { id: "understand", name: "Understand", agentProfileId: "planner" },
  { id: "build", name: "Build", agentProfileId: "builder" },
  { id: "review", name: "Review", agentProfileId: "reviewer" },
  { id: "finish", name: "Finish", agentProfileId: null },
];
const EDGES = [
  { id: "e1", from: "understand", to: "build", label: "" },
  { id: "e2", from: "build", to: "review", label: "" },
  { id: "e3", from: "review", to: "finish", label: "" },
  { id: "e4", from: "review", to: "build", label: "changes" },
];
const graph = (steps = STEPS) => ({ steps, edges: EDGES, startStepId: "understand" }) as never;
const run = (o: Partial<PipelineRunState>): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Change", status: "running", active: [], joins: {}, blocked: [], history: [], stepCount: 0, startedAt: 0, endedAt: null,
  snapshot: { graph: graph(), maxSteps: 28, profiles: {}, capturedAt: 0 } as never, ...o,
});
const rec = (seq: number, stepId: string, o: Partial<PipelineStepRecord> = {}): PipelineStepRecord => ({
  seq, stepId, taskId: `s${seq}`, startedAt: NOW - 60 * MIN, endedAt: NOW - 50 * MIN, outcome: "succeeded", handoff: null, nextStepIds: [], ...o,
});
const task = (o: Partial<Task>) => ({ id: "t", title: "Issue #7: T", column: "running", pipelineId: "p", pendingInteractionCount: 0, archivedAt: null, pipelineParentId: null, runId: null, hasOpenableRun: false, prUrl: null, updatedAt: 0, ...o }) as Task;
const stepTask = (id: string, column: Task["column"], o: Partial<Task> = {}) => task({ id, column, pipelineParentId: "t", ...o });
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t", number: 177, url: "https://github.com/o/r/pull/177", state: "open", draft: false, baseRef: "develop", headSha: "abc1234def", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: NOW - 3 * MIN, ...o,
});
const stateOf = (t: Task, p: TaskPrStatus | null = null): CardState => cardState(t, { pr: p, lease: { holds: [], waiting: [] }, now: NOW });
const wait = (o: Partial<PipelineBlockWait> = {}): PipelineBlockWait => ({
  stepId: "build", taskId: "s2", category: "environment", source: "text", what: "the network", ref: null, reason: "registry timed out", state: "waiting",
  since: NOW - 12 * MIN, attempt: 1, max: 3, at: NOW + 20 * MIN, deadline: NOW + 600 * MIN, tried: [], ...o,
});
const stepBlocked = (o: Partial<PipelineBlock> = {}): PipelineBlock => ({ taskId: "s2", stepId: "build", kind: "step-blocked", message: 'step "Build" reported it is blocked: the fixture service did not come up', ...o });
const building = { active: [{ stepId: "build", taskId: "s2", seq: 2 }], history: [rec(1, "understand", { nextStepIds: ["build"] }), rec(2, "build", { startedAt: NOW - 2 * MIN, endedAt: null, outcome: null })] };
// Understand → Build → Review → Build (changes requested) → Review, open.
const looped = [
  rec(1, "understand", { nextStepIds: ["build"] }),
  rec(2, "build", { nextStepIds: ["review"] }),
  rec(3, "review", { nextStepIds: ["build"] }),
  rec(4, "build", { nextStepIds: ["review"] }),
  rec(5, "review", { endedAt: null, outcome: null }),
];
const retries = (c: { primary: BandAction | null; secondary: BandAction[] }) => [c.primary, ...c.secondary].filter((a): a is Extract<BandAction, { kind: "retry" }> => a?.kind === "retry");
const controls = (t: Task, steps: Task[] = [], p: TaskPrStatus | null = null) => recoveryControls(t, steps, stateOf(t, p));

describe("executionSummary", () => {
  test("counts recorded executions, never against the graph's step count", () => {
    const s = executionSummary(run({ history: looped, stepCount: 5, active: [{ stepId: "review", taskId: "s5", seq: 5 }] }));
    expect(s.recorded).toBe(5);
    expect(s.label).toBe("5 executions recorded");
    expect(s.label).not.toContain("/");
    expect(Object.fromEntries(s.byStep)).toEqual({ understand: 1, build: 2, review: 2 });
    expect(executionSummary(run({ history: [rec(1, "understand")] })).label).toBe("1 execution recorded");
  });

  test("a loop is a record that hands to a step with an earlier record", () => {
    const s = executionSummary(run({ history: looped }));
    expect(s.loops).toEqual([
      { seq: 3, fromStepId: "review", toStepId: "build" },
      { seq: 4, fromStepId: "build", toStepId: "review" },
    ]);
    expect(executionSummary(run({ history: [rec(1, "understand", { nextStepIds: ["build"] }), rec(2, "build")] })).loops).toEqual([]);
  });

  test("the round is the step's nth record", () => {
    const r = run({ history: looped });
    expect(roundOf(r, looped[1]!)).toBe(1);
    expect(roundOf(r, looped[3]!)).toBe(2);
  });

  test("the step cap reads as executions started of the allowance, extensions included", () => {
    expect(executionSummary(run({ stepCount: 28 })).cap).toEqual({ used: 28, max: 28, label: "step cap 28 of 28" });
    expect(executionSummary(run({ stepCount: 30, capExtensions: 1 })).cap.label).toBe("step cap 30 of 56");
  });

  test("several active executions are parallel", () => {
    expect(executionSummary(run({ active: [{ stepId: "build", taskId: "a", seq: 2 }, { stepId: "review", taskId: "b", seq: 3 }] })).parallel).toBe(true);
    expect(executionSummary(run(building)).parallel).toBe(false);
  });
});

describe("stepTiles", () => {
  test("the current step's tile wears the card's own state; steps behind it read Handed off", () => {
    const t = task({ pipelineRun: run({ ...building, blocked: [{ taskId: "s2", stepId: "build", kind: "await", message: 'step "Build" is waiting on "ci-wait 1476" — it resumes when the command exits' }] }) });
    const state = stateOf(t);
    const { tiles } = stepTiles(t.pipelineRun!, graph(), [stepTask("s2", "running")], t, state);
    expect(tiles.map((x) => [x.name, x.label, x.tone, x.current])).toEqual([
      ["Understand", "Handed off", "working", false],
      ["Build", state.label, state.state, true],
      ["Review", "Not started", "queued", false],
      ["Finish", "Not started", "queued", false],
    ]);
    expect(state.label).toBe("Waiting on CI");
    expect(tiles[1]!.icon).toBe(state.icon);
  });

  test("counts are per step, and a step that has not run says so", () => {
    const t = task({ pipelineRun: run({ history: looped, active: [{ stepId: "review", taskId: "s5", seq: 5 }] }) });
    const { tiles } = stepTiles(t.pipelineRun!, graph(), [stepTask("s5", "running")], t, stateOf(t));
    expect(tiles.map((x) => x.countLabel)).toEqual(["1 execution", "2 executions recorded", "2 executions recorded", "Not run yet"]);
    expect(tiles.map((x) => x.taskId)).toEqual(["s1", "s4", "s5", null]);
  });

  test("a fan-out has several current tiles, each from its own execution", () => {
    const fan = run({
      history: [rec(1, "understand", { nextStepIds: ["build", "review"] }), rec(2, "build", { endedAt: null, outcome: null }), rec(3, "review", { endedAt: null, outcome: null })],
      active: [{ stepId: "build", taskId: "s2", seq: 2 }, { stepId: "review", taskId: "s3", seq: 3 }],
    });
    const t = task({ pipelineRun: fan });
    const out = stepTiles(fan, graph(), [stepTask("s2", "running"), stepTask("s3", "running")], t, stateOf(t));
    expect(out.parallel).toBe(true);
    expect(out.tiles.filter((x) => x.current).map((x) => [x.name, x.label])).toEqual([["Build", "Working"], ["Review", "Working"]]);
  });

  test("failed, stopped and manually advanced records keep their own words", () => {
    const r = run({ status: "done", history: [rec(1, "understand", { outcome: "advanced-manually" }), rec(2, "build", { outcome: "failed" }), rec(3, "review", { outcome: "cancelled" })] });
    const t = task({ column: "review", pipelineRun: r });
    expect(stepTiles(r, graph(), [], t, stateOf(t)).tiles.map((x) => [x.label, x.tone])).toEqual([
      ["Advanced manually", "queued"],
      ["Failed", "failed"],
      ["Stopped", "queued"],
      ["Not started", "queued"],
    ]);
  });

  test("follow-up steps are listed apart from the graph's own", () => {
    const g = graph([...STEPS, { id: "followup-1", name: "Fix CI", agentProfileId: "builder" }]);
    const r = run({ status: "done", history: [rec(1, "understand"), rec(2, "followup-1")] });
    const t = task({ column: "review", pipelineRun: r });
    const out = stepTiles(r, g, [], t, stateOf(t));
    expect(out.tiles.map((x) => x.id)).toEqual(["understand", "build", "review", "finish"]);
    expect(out.followUps.map((x) => [x.name, x.label])).toEqual([["Fix CI", "Handed off"]]);
  });

  test("a run not started yet: every tile is Not started, from the live graph", () => {
    const t = task({ column: "backlog", pipelineRun: null });
    expect(stepTiles(null, graph(), [], t, stateOf(t)).tiles.every((x) => x.label === "Not started" && x.executions === 0 && !x.current)).toBe(true);
    expect(stepTiles(null, null, [], t, stateOf(t)).tiles).toEqual([]);
  });
});

describe("recoveryControls — one Retry, named for what it does", () => {
  test("running: Stop only, and only while a step task is live", () => {
    const t = task({ pipelineRun: run(building) });
    expect(controls(t, [stepTask("s2", "running")])).toMatchObject({ primary: null, secondary: [{ kind: "stop", label: "Stop" }], restart: false, advance: [] });
    expect(controls(t, [stepTask("s2", "review")]).secondary).toEqual([]);
  });

  test("failed: Retry <step> on the blocked execution; Restart and Advance stay under Advanced", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", ...building, blocked: [{ taskId: "s2", stepId: "build", kind: "step-failed", message: 'step "Build" failed — exit 1' }] }) });
    const c = controls(t, [stepTask("s2", "blocked")]);
    expect(c.primary).toMatchObject({ kind: "retry", id: "retry", label: "Retry Build", stepTaskId: "s2" });
    expect(retries(c)).toHaveLength(1);
    expect(c.restart).toBe(true);
    expect(c.advance.map((x) => [x.fromTaskId, x.stepName])).toEqual([["s2", "Build"]]);
  });

  test("cancelled: Resume <step>, once", () => {
    const t = task({ column: "ready", pipelineRun: run({ status: "cancelled", history: [rec(1, "understand"), rec(2, "build", { outcome: "cancelled" })] }) });
    const c = controls(t);
    expect(c.primary).toMatchObject({ kind: "retry", id: "resume", label: "Resume Build" });
    expect(retries(c)).toHaveLength(1);
    expect(c.restart).toBe(true);
  });

  test("step cap: Extend cap, with the allowance in its tooltip", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", stepCount: 28, history: looped, blocked: [{ taskId: null, stepId: "review", kind: "step-cap", message: "reached the step cap of 28" }] }) });
    const c = controls(t);
    expect(c.primary).toMatchObject({ kind: "retry", id: "extend-cap", label: "Extend cap" });
    expect((c.primary as { title: string }).title).toContain("step cap 28 of 28");
    expect(retries(c)).toHaveLength(1);
    expect(c.advance).toEqual([]);
  });

  test("a held input: Recheck now, and the tooltip says it is the retry request", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", history: [rec(1, "understand")], blocked: [{ taskId: null, stepId: "review", kind: "step-blocked", message: "required input #1326 is not complete", inputRetry: { at: NOW + 5 * MIN, attempt: 32 } }] }) });
    const c = controls(t);
    expect(c.primary).toMatchObject({ kind: "retry", id: "recheck", label: "Recheck now" });
    expect((c.primary as { title: string }).title).toMatch(/retry request: it also retries any other blocked execution/);
    expect(retries(c)).toHaveLength(1);
  });

  test("an automatic retry: Retry <step> now, beside the dependency to open when there is one", () => {
    const parked = run({ status: "blocked", ...building, blocked: [stepBlocked()], wait: wait({ category: "dependency", what: "#41", ref: "#41" }) });
    const alone = controls(task({ column: "blocked", pipelineRun: parked }), [stepTask("s2", "blocked")]);
    expect(alone.primary).toMatchObject({ kind: "retry", id: "retry-now", label: "Retry Build now" });
    const known = controls(task({ column: "blocked", pipelineRun: parked, blockedBy: [{ taskId: "dep", title: "x", satisfied: true, detail: "done", ref: "#41" }] }), [stepTask("s2", "blocked")]);
    expect(known.primary).toMatchObject({ kind: "card", action: { kind: "open-dependency", taskId: "dep" } });
    expect(known.secondary).toMatchObject([{ kind: "retry", id: "retry-now" }]);
    expect(retries(known)).toHaveLength(1);
  });

  test("a question for the owner: open the step that asks; nothing retries or advances by default", () => {
    const t = task({ column: "blocked", pendingInteractionCount: 1, pipelineRun: run(building) });
    const c = controls(t, [stepTask("s2", "blocked", { pendingInteractionCount: 1 })]);
    expect(c.primary).toEqual({ kind: "open-step", label: "Answer", title: "Opens Build's panel", taskId: "s2" });
    expect(c.secondary).toEqual([{ kind: "stop", label: "Stop", title: expect.any(String) }]);
  });

  test("a missing handoff: no Retry (it cannot fix it); the band points at Advance", () => {
    const t = task({ column: "blocked", pipelineRun: run({ status: "blocked", ...building, blocked: [{ taskId: "s2", stepId: "build", kind: "handoff-missing", message: "no handoff" }] }) });
    const c = controls(t, [stepTask("s2", "review")]);
    expect(retries(c)).toEqual([]);
    expect(c.advance).toHaveLength(1);
    expect(c.hint).toContain("Advance…");
  });

  test("two blocked executions of a fan-out: one Retry each, by name", () => {
    const fan = run({
      status: "blocked",
      active: [{ stepId: "build", taskId: "s2", seq: 2 }, { stepId: "review", taskId: "s3", seq: 3 }],
      history: [rec(1, "understand"), rec(2, "build", { outcome: null, endedAt: null }), rec(3, "review", { outcome: null, endedAt: null })],
      blocked: [
        { taskId: "s2", stepId: "build", kind: "step-failed", message: 'step "Build" failed — exit 1' },
        { taskId: "s3", stepId: "review", kind: "step-failed", message: 'step "Review" failed — exit 1' },
      ],
    });
    const c = controls(task({ column: "blocked", pipelineRun: fan }), [stepTask("s2", "blocked"), stepTask("s3", "blocked")]);
    expect(retries(c).map((r) => [r.label, r.stepTaskId])).toEqual([["Retry Build", "s2"], ["Retry Review", "s3"]]);
  });

  test("done: the PR's own next move, never a retry; Restart only under Advanced", () => {
    const done = run({ status: "done", history: [rec(1, "understand"), rec(2, "build"), rec(3, "review"), rec(4, "finish")] });
    const failing = pr({ checks: "failure", failingChecks: [{ name: "unit", url: null, alsoOnBase: false }] });
    const c = controls(task({ column: "review", pipelineRun: done }), [], failing);
    expect(c.primary).toMatchObject({ kind: "card", action: { kind: "fix-ci" }, label: "Fix CI" });
    expect(retries(c)).toEqual([]);
    expect(c).toMatchObject({ restart: true, advance: [] });
  });

  test("not started: Run; archived: nothing", () => {
    expect(controls(task({ column: "backlog", pipelineRun: null }))).toMatchObject({ primary: { kind: "card", action: { kind: "run" } }, restart: false });
    expect(controls(task({ column: "blocked", archivedAt: 1, pipelineRun: run({ status: "blocked", blocked: [stepBlocked()] }) }))).toEqual({ primary: null, secondary: [], restart: false, advance: [], hint: null });
  });

  test("a step that finished and waits for a choice can be advanced, and the band says where", () => {
    const t = task({ pipelineRun: run(building) });
    const c = controls(t, [stepTask("s2", "review")]);
    expect(c.advance).toEqual([{ key: "review:s2", fromTaskId: "s2", stepName: "Build", why: "finished and waits for the next step to be chosen" }]);
    expect(c.hint).toContain("Advance…");
  });
});

describe("checksEvidence", () => {
  const done = run({ status: "done", history: [rec(1, "understand", { startedAt: NOW - 300 * MIN, endedAt: NOW - 200 * MIN }), rec(2, "finish", { startedAt: NOW - 200 * MIN, endedAt: NOW - 100 * MIN })] });
  const t = task({ column: "review", pipelineRun: done });
  const activity = [
    { ts: NOW - 150 * MIN, kind: "ci", text: "CI passed", tone: "success", url: "https://github.com/o/r/pull/177" },
    { ts: NOW - 160 * MIN, kind: "ci", text: "CI failing: unit", tone: "danger" },
    { ts: NOW - 170 * MIN, kind: "pr", text: "PR #177 opened", tone: "info" },
  ];

  test("the current head comes only from the PR watcher, with when and which commit", () => {
    const e = checksEvidence({ pr: pr({ checks: "failure", failingChecks: [{ name: "unit", url: null, alsoOnBase: false }, { name: "lint", url: null, alsoOnBase: true }] }), run: done, activity, task: t, now: NOW });
    expect(e.current).toMatchObject({ source: "current-head", status: "failing", text: "Checks failing: unit · also failing on develop: lint", head: "abc1234def", currentHead: true, observedAt: NOW - 3 * MIN });
    expect(e.current!.qualifier).toBe("as of 2:57 PM on abc1234");
  });

  test("a recorded pass is history, never the current head's result", () => {
    const e = checksEvidence({ pr: pr({ checks: "pending" }), run: done, activity, task: t, now: NOW });
    expect(e.current!.status).toBe("running");
    expect(e.recorded.map((r) => [r.status, r.currentHead, r.head, r.qualifier, r.duringStepId])).toEqual([
      ["passing", false, null, "recorded, head not recorded", "finish"],
      ["failing", false, null, "recorded, head not recorded", "finish"],
    ]);
    expect(e.note).toContain("does not show that the current head passes");
  });

  test("no pull request: the current head is unavailable, in words", () => {
    const e = checksEvidence({ pr: null, run: done, activity, task: t, now: NOW });
    expect(e.current).toBeNull();
    expect(e.note).toContain("unavailable");
  });

  test("a live CI wait is a row of its own, with no head", () => {
    const waiting = run({ ...building, blocked: [{ taskId: "s2", stepId: "build", kind: "await", message: 'step "Build" is waiting on "ci-wait 1476" — it resumes when the command exits' }] });
    const e = checksEvidence({ pr: null, run: waiting, activity: null, task: task({ pipelineRun: waiting }), now: NOW });
    expect(e.recorded).toMatchObject([{ source: "step-wait", status: "running", text: 'Waiting on "ci-wait 1476"', head: null, observedAt: null, currentHead: false, duringStepId: "build" }]);
  });

  test("the check ledger: each check of each evaluation is a row for the step it judged, with the head it was computed for", () => {
    const line = (o: Partial<CheckLedgerEntry>): CheckLedgerEntry => ({
      at: NOW - 30 * MIN, stepId: "build", stepName: "Build", seq: 2, turn: 1, checkId: "tree-clean", description: "clean", required: true, outcome: "pass", satisfied: true,
      key: { head: "abc1234def", tree: "t", baseTip: "b", def: "d" }, exitCode: null, detail: "no uncommitted change to a tracked file", outputTail: "", outputPath: null, ...o,
    });
    const ledger = [
      line({ outcome: "fail", satisfied: false, detail: "1 tracked file has uncommitted changes", key: { head: "0ld5ha0000", tree: "t", baseTip: "b", def: "d" } }),
      line({ turn: 2, at: NOW - 20 * MIN }),
      line({ turn: 2, at: NOW - 20 * MIN, checkId: "unit", required: false, outcome: "skip", satisfied: true, detail: "unchanged since it passed — not run again" }),
      line({ stepId: "review", stepName: "Review", seq: 3, at: NOW - 10 * MIN, checkId: "review-verdict", outcome: "halt", satisfied: false, detail: "HEAD could not be read", key: { head: null, tree: null, baseTip: null, def: "d" } }),
      line({ stepId: "review", stepName: "Review", seq: 3, at: NOW - 5 * MIN, checkId: "review-verdict", outcome: "waived", satisfied: false, detail: "the owner advanced the run past this check" }),
    ];
    const e = checksEvidence({ pr: pr(), run: done, activity: [], task: t, now: NOW, ledger });
    expect(e.recorded.map((r) => [r.source, r.duringStepId, r.status, r.text, r.qualifier, r.currentHead])).toEqual([
      ["step-check", "review", "none", "review-verdict: waived by the owner — the owner advanced the run past this check", "Review #3, evaluation 1 · on abc1234 (the pull request's head)", false],
      ["step-check", "review", "unavailable", "review-verdict: could not be evaluated — HEAD could not be read", "Review #3, evaluation 1 · head not read", false],
      ["step-check", "build", "passing", "tree-clean: passed — no uncommitted change to a tracked file", "Build #2, evaluation 2 · on abc1234 (the pull request's head)", false],
      ["step-check", "build", "passing", "unit: passed earlier, unchanged — unchanged since it passed — not run again", "Build #2, evaluation 2 · on abc1234 (the pull request's head) · optional", false],
      ["step-check", "build", "failing", "tree-clean: failed — 1 tracked file has uncommitted changes", "Build #2, evaluation 1 · on 0ld5ha0 (not the pull request's head)", false],
    ]);
    expect(e.recorded[2]).toMatchObject({ head: "abc1234def", observedAt: NOW - 20 * MIN, url: null });
    expect(e.note).toBe("Only the first row speaks for the pull request's current head. Step checks are the ones Agetor ran when a step's turn ended, each for the head it names; they are not CI.");
    // Without a pull request a row says which commit and claims nothing about a PR.
    const alone = checksEvidence({ pr: null, run: done, activity: [], task: t, now: NOW, ledger: ledger.slice(1, 2) });
    expect(alone.recorded[0]!.qualifier).toBe("Build #2, evaluation 2 · on abc1234");
    expect(alone.note).toContain("the current head's CI checks are unavailable");
    // No ledger, or an empty one: exactly what it was.
    const before = checksEvidence({ pr: pr(), run: done, activity, task: t, now: NOW });
    expect(checksEvidence({ pr: pr(), run: done, activity, task: t, now: NOW, ledger: [] })).toEqual(before);
    expect(checksEvidence({ pr: pr(), run: done, activity, task: t, now: NOW, ledger: null })).toEqual(before);
  });

  test("a watcher that recorded no head says so", () => {
    expect(checksEvidence({ pr: pr({ headSha: null }), run: done, activity: [], task: t, now: NOW }).current!.qualifier).toBe("as of 2:57 PM on a head the watcher did not record");
  });
});

describe("a step stopped on its checks", () => {
  test("Retry runs the step again and Advance… is offered, named for what it does to the checks", () => {
    const stopped = run({
      status: "blocked", active: [{ stepId: "build", taskId: "s2", seq: 2 }],
      blocked: [{ taskId: "s2", stepId: "build", kind: "check-failed", message: 'step "Build" still fails its required checks after 2 feedback turns and one fresh session: tree-clean (dirty)' }],
      history: [rec(1, "understand", { nextStepIds: ["build"] }), rec(2, "build", { endedAt: null, outcome: null, gate: { state: "owner", turns: 2, max: 2, failed: ["tree-clean"], at: NOW } })],
    });
    const c = controls(task({ column: "blocked", pipelineRun: stopped }), [stepTask("s2", "review")]);
    expect(retries(c).map((a) => [a.label, a.stepTaskId])).toEqual([["Retry Build", "s2"]]);
    expect(c.advance).toEqual([{ key: "block:0:s2", fromTaskId: "s2", stepName: "Build", why: "did not pass its checks (advancing records them as waived)" }]);
  });
});
