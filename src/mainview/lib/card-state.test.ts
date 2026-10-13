import { describe, expect, test } from "bun:test";
import { cardState, columnSummary, formatElapsed, stepOrder, stepStrip, type CardState, type CardStateContext } from "./card-state.ts";
import { cardStatus } from "./card-status.ts";
import type { PipelineBlockWait, PipelineRunState, PipelineStepRecord, Task, TaskPrStatus } from "../../shared/types.ts";
import type { TaskLeaseInfo } from "./leases.ts";

// A fixed clock: every age and retry time below is measured from it.
const NOW = new Date(2031, 2, 4, 15, 0).getTime();
const MIN = 60_000;
const noLease: TaskLeaseInfo = { holds: [], waiting: [] };
const handoff = (o: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, purpose: "", summary: "", reason: "", next: null, artifacts: [], openQuestions: [], ...o });
const STEPS = [
  { id: "understand", name: "Understand" },
  { id: "build", name: "Build" },
  { id: "review", name: "Review" },
  { id: "finish", name: "Finish" },
];
const EDGES = [
  { id: "e1", from: "understand", to: "build", label: "" },
  { id: "e2", from: "build", to: "review", label: "" },
  { id: "e3", from: "review", to: "finish", label: "" },
  { id: "e4", from: "review", to: "build", label: "changes" },
];
const snapshot = (steps = STEPS, edges = EDGES) => ({ graph: { steps, edges, startStepId: "understand" }, maxSteps: 28, profiles: {}, capturedAt: 0 }) as unknown as PipelineRunState["snapshot"];
const run = (o: Partial<PipelineRunState>): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Change", status: "running", active: [], joins: {}, blocked: [], history: [], stepCount: 0, startedAt: 0, endedAt: null, snapshot: snapshot(), ...o,
});
const rec = (seq: number, stepId: string, o: Partial<PipelineStepRecord> = {}): PipelineStepRecord => ({
  seq, stepId, taskId: `s${seq}`, startedAt: NOW - 60 * MIN, endedAt: NOW - 50 * MIN, outcome: "succeeded", handoff: null, nextStepIds: ["next"], ...o,
});
const task = (o: Partial<Task>) => ({ id: "t", title: "T", column: "running", pipelineId: "p", pendingInteractionCount: 0, archivedAt: null, pipelineParentId: null, runId: null, hasOpenableRun: false, prUrl: null, updatedAt: 0, ...o }) as Task;
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t", number: 177, url: "https://github.com/o/r/pull/177", state: "open", draft: false, baseRef: "develop", headSha: "s", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o,
});
const state = (t: Task, o: Partial<CardStateContext> = {}): CardState => cardState(t, { pr: null, lease: noLease, now: NOW, ...o });
const wait = (o: Partial<PipelineBlockWait> = {}): PipelineBlockWait => ({
  stepId: "build", taskId: "s2", category: "environment", source: "text", what: "the network", ref: null, reason: "registry timed out", state: "waiting",
  since: NOW - 12 * MIN, attempt: 1, max: 3, at: NOW + 20 * MIN, deadline: NOW + 600 * MIN, tried: [{ at: NOW - 5 * MIN, trigger: "timer" }], ...o,
});
const stepBlocked = (message = 'step "Build" reported it is blocked: the fixture service did not come up') => [{ taskId: "s2", stepId: "build", kind: "step-blocked" as const, message }];
const building = { active: [{ stepId: "build", taskId: "s2", seq: 2 }], history: [rec(1, "understand"), rec(2, "build", { startedAt: NOW - 2 * MIN, endedAt: null, outcome: null })] };
const finished = (o: Partial<PipelineRunState> = {}) =>
  run({ status: "done", history: [rec(1, "understand"), rec(2, "build"), rec(3, "review"), rec(4, "finish", { handoff: handoff({ summary: "Opened the PR" }), nextStepIds: [] })], ...o });

describe("cardState — one case per state", () => {
  test("Needs input: a pending question wins over everything, and the button counts them", () => {
    const s = state(task({ pendingInteractionCount: 2, pipelineRun: run(building) }));
    expect(s).toMatchObject({ kind: "needs-input", state: "needs", label: "Needs input", icon: "alert", reason: "Asked you 2 questions", action: { kind: "open", label: "Answer (2)" } });
    expect(state(task({ pendingInteractionCount: 1 })).action).toEqual({ kind: "open", label: "Answer" });
  });

  test("Merged: the PR merged, or the merge train that carried it did", () => {
    expect(state(task({ column: "done", pipelineRun: finished() }), { pr: pr({ state: "merged" }) })).toMatchObject({ state: "merged", label: "Merged", icon: "merge", reason: "PR #177 merged into develop", action: null, step: { name: "Complete" } });
    expect(state(task({ column: "done", mergeTrain: { pr: 300, url: "u", state: "merged" } }), { pr: pr({ state: "closed" }) })).toMatchObject({ state: "merged", reason: "Merged in merge train #300" });
  });

  test("Ready to Merge: blue, labelled with the part of merging it is on", () => {
    const merge = (p: TaskPrStatus | null, o: Partial<Task> = {}) => state(task({ column: "merge", pipelineRun: finished(), ...o }), { pr: p });
    expect(merge(null)).toMatchObject({ state: "waiting", label: "Opening PR", reason: "Opening a PR so it can merge", action: null });
    expect(merge(pr({ behindBy: 3 }))).toMatchObject({ state: "waiting", label: "Updating branch", reason: "Updating from develop, then merging", action: { kind: "view-pr", label: "Inspect PR", url: "https://github.com/o/r/pull/177" } });
    expect(merge(pr({ checks: "pending" }))).toMatchObject({ state: "waiting", label: "Waiting on CI" });
    expect(merge(pr())).toMatchObject({ state: "waiting", label: "Merging", reason: "Green — merging" });
    expect(merge(pr({ checks: "failure", failingChecks: [{ name: "test", url: null, alsoOnBase: false }] }))).toMatchObject({ state: "waiting", label: "Fixing CI" });
    expect(merge(pr(), { mergeTrain: { pr: 300, url: "https://github.com/o/r/pull/300", state: "riding" } })).toMatchObject({
      state: "waiting", label: "In merge train", action: { kind: "view-pr", label: "Inspect PR", url: "https://github.com/o/r/pull/300" },
    });
    // The two that only the owner can settle are amber, not blue.
    expect(merge(pr({ draft: true }))).toMatchObject({ state: "needs", label: "Draft PR" });
    expect(merge(pr({ state: "closed" }))).toMatchObject({ state: "needs", label: "PR closed", action: { kind: "open" } });
  });

  test("Dependency: an unsatisfied card dependency, with the card to open", () => {
    const s = state(task({ column: "backlog", blockedBy: [{ taskId: "dep", title: "Issue #1351: lease", satisfied: false, detail: "running", ref: "#1351" }] }));
    expect(s).toMatchObject({ state: "queued", label: "Dependency", icon: "dashed", reason: "Waiting on #1351 · running", action: { kind: "open-dependency", label: "Open dependency", taskId: "dep" } });
  });

  test("Dependency: a card that has run and waits on another is blue; one nothing has run yet stays grey", () => {
    const blockedBy = [{ taskId: "dep", title: "Issue #1351: lease", satisfied: false, detail: "running", ref: "#1351" }];
    const stopped = run({ status: "cancelled", history: [rec(1, "understand"), rec(2, "build", { outcome: "cancelled" })] });
    expect(state(task({ column: "ready", pipelineRun: stopped, blockedBy }))).toMatchObject({ state: "waiting", label: "Dependency", icon: "clock", action: { kind: "open-dependency" } });
    expect(state(task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: stepBlocked(), ...building }), blockedBy }))).toMatchObject({ state: "waiting", label: "Dependency" });
    expect(state(task({ column: "ready", pipelineRun: run({ status: "idle" }), blockedBy }))).toMatchObject({ state: "queued", label: "Dependency", icon: "dashed" });
  });

  test("Dependency: parked in the wait queue on an issue is blue; opens the card only when the board knows which one", () => {
    const parked = run({ status: "blocked", blocked: stepBlocked(), ...building, wait: wait({ category: "dependency", what: "#41", ref: "#41" }) });
    const s = state(task({ column: "blocked", pipelineRun: parked }));
    expect(s).toMatchObject({ state: "waiting", label: "Dependency", icon: "clock", reason: "Waiting on #41 — retrying when it lands or at 3:20 PM · attempt 2 of 3", action: { kind: "inspect", label: "Inspect retry" }, elapsedMs: 12 * MIN });
    const known = state(task({ column: "blocked", pipelineRun: parked, blockedBy: [{ taskId: "dep", title: "x", satisfied: true, detail: "done", ref: "#41" }] }));
    expect(known.action).toEqual({ kind: "open-dependency", label: "Open dependency", taskId: "dep" });
  });

  test("Queued: never started (Run), a roadmap card's line, and a step waiting for a slot (no button)", () => {
    expect(state(task({ column: "backlog", pipelineRun: null }))).toMatchObject({ state: "queued", label: "Queued", reason: "In backlog — not started", action: { kind: "run", label: "Run" }, step: null, strip: null });
    expect(state(task({ column: "backlog" }), { roadmap: { taskId: "t", line: "Step 3 · waits on step 2", tone: "muted" } as never })).toMatchObject({ label: "Queued", reason: "Step 3 · waits on step 2", action: { kind: "run" } });
    const slot = run({ history: [rec(1, "understand")], blocked: [{ taskId: null, stepId: "build", kind: "slot-wait", message: "queued — 3 of 3 agents busy" }] });
    expect(state(task({ pipelineRun: slot }))).toMatchObject({ state: "queued", label: "Queued", reason: "Starts when a slot frees up", action: null, step: { name: "Build" } });
  });

  test("Finish run by Agetor: waiting on CI, waiting on the base, and publishing, never Queued", () => {
    const held = (publish: Record<string, unknown>) => task({ pipelineRun: run({
      history: [rec(1, "understand"), rec(2, "build"), rec(3, "review")],
      blocked: [{ taskId: null, stepId: "finish", kind: "await", message: "Agetor is running Finish" }],
      publish: { stepId: "finish", tries: 0, carried: 0, ...publish },
    } as never) });
    const url = "https://github.com/o/r/pull/7";
    expect(state(held({ state: "wait-ci", note: "Waiting for required on abc1234" }), { pr: pr({ url }) }))
      .toMatchObject({ state: "waiting", label: "Waiting on CI", reason: "Waiting for required on abc1234", action: { kind: "view-pr", label: "Inspect CI" }, step: { name: "Finish" } });
    expect(state(held({ state: "base-red", note: "develop fails required too" }), { pr: pr({ url }) }))
      .toMatchObject({ state: "waiting", label: "Waiting on base", reason: "develop fails required too", action: { kind: "view-pr", label: "Inspect PR" } });
    expect(state(held({ state: "push" }))).toMatchObject({ state: "working", label: "Publishing", action: null });
    // An agent runs this visit as before: the ordinary rules apply.
    expect(state(held({ state: "agent" })).label).not.toBe("Publishing");
  });

  test("Working: an active step that is not parked; elapsed runs from its latest start", () => {
    const s = state(task({ pipelineRun: run(building) }));
    expect(s).toMatchObject({ kind: "working", state: "working", label: "Working", icon: "activity", reason: "Agent is working", elapsedMs: 2 * MIN, action: null, step: { id: "build", name: "Build", round: null } });
    expect(state(task({ pipelineRun: run(building) }), { lease: { holds: ["lab"], waiting: [] } }).reason).toBe("Agent is working · holds lab");
    expect(state(task({ pipelineRun: run({ ...building, capWrapUp: { at: NOW, fromStepId: "review", seq: 2 } }) })).reason).toBe("Wrapping up: the run reached its step cap");
    // An execution with no record yet has no start to count from.
    expect(state(task({ pipelineRun: run({ active: [{ stepId: "build", taskId: "s9", seq: 9 }], history: [rec(1, "understand")] }) }))).toMatchObject({ label: "Working", reason: "Step is starting", elapsedMs: null });
  });

  test("Waiting on CI / command: every active step parked on a long command is blue, not green", () => {
    const awaiting = (message: string) => run({ ...building, blocked: [{ taskId: "s2", stepId: "build", kind: "await", message }] });
    const ci = state(task({ pipelineRun: awaiting('step "Build" is waiting on "ci-wait 1476" — it resumes when the command exits') }), { pr: pr() });
    expect(ci).toMatchObject({ kind: "awaiting", state: "waiting", label: "Waiting on CI", icon: "clock", action: { kind: "view-pr", label: "Inspect CI" } });
    const cmd = state(task({ pipelineRun: awaiting('step "Build" is waiting on "make e2e" — it resumes when the command exits') }));
    expect(cmd).toMatchObject({ state: "waiting", label: "Waiting on command", reason: 'Resumes when "make e2e" finishes', action: null });
  });

  test("Quiet: a running step that has said nothing for 20 minutes is the owner's to check", () => {
    const s = state(task({ lastActivityAt: NOW - 25 * MIN, pipelineRun: run(building) }));
    expect(s).toMatchObject({ kind: "quiet", state: "needs", label: "Quiet", reason: "Build has said nothing for 25m", action: { kind: "open", label: "Check" } });
    // A live lab run reporting progress is not quiet.
    expect(state(task({ lastActivityAt: NOW - 25 * MIN, pipelineRun: run(building) }), { progressActive: true }).label).toBe("Working");
  });

  test("Auto retry: parked in the wait queue — blue, with how long it has waited", () => {
    const s = state(task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: stepBlocked(), ...building, wait: wait() }) }));
    expect(s).toMatchObject({
      kind: "auto-retry", state: "waiting", label: "Auto retry", icon: "clock",
      reason: "Hit a transient failure — retrying at 3:20 PM · attempt 2 of 3",
      action: { kind: "inspect", label: "Inspect retry" }, elapsedMs: 12 * MIN, step: { name: "Build" },
    });
  });

  test("Auto retry: a scheduled retry, a held input, and a lease another checkout holds", () => {
    const failed = [{ taskId: "s2", stepId: "build", kind: "step-failed" as const, message: 'step "Build" failed — exit 1' }];
    const at = NOW + 30 * MIN;
    const quota = state(task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: failed, ...building, autoRetry: { stepId: "build", kind: "quota", attempt: 1, at, reason: "limit" } }) }));
    expect(quota).toMatchObject({ state: "waiting", label: "Auto retry", reason: "Waiting for the usage limit to reset · retries at 3:30 PM" });
    const flake = state(task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: failed, ...building, autoRetry: { stepId: "build", kind: "transient", attempt: 2, at, reason: "529" } }) }));
    expect(flake).toMatchObject({ state: "waiting", label: "Auto retry", reason: "Failed · retries at 3:30 PM · attempt 2" });
    const input = run({ status: "blocked", history: [rec(1, "understand")], blocked: [{ taskId: null, stepId: "build", kind: "step-blocked", message: "input evidence for #41 is not available yet", pending: { stepId: "build", arrivals: [] }, inputRetry: { at, attempt: 3 } }] });
    expect(state(task({ column: "blocked", pipelineRun: input }))).toMatchObject({ state: "waiting", label: "Auto retry", reason: "input evidence for #41 is not available yet · re-checks at 3:30 PM · attempt 3", step: { name: "Build" } });
    const lab = state(task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: stepBlocked("m"), ...building }) }), { lease: { holds: [], waiting: [{ label: "lab", heldBy: "E2E", free: false, position: 2, queueLength: 3 }] } });
    expect(lab).toMatchObject({ state: "waiting", label: "Auto retry", reason: "Waiting for lab (held by E2E, 2nd of 3 in line)" });
  });

  test("Step cap: amber, and the button resumes the step it stopped before", () => {
    const capped = run({ status: "blocked", history: [rec(1, "understand"), rec(2, "build"), rec(3, "review")], blocked: [{ taskId: null, stepId: "review", kind: "step-cap", message: "reached the step cap", pending: { stepId: "review", arrivals: [] } }] });
    expect(state(task({ column: "blocked", pipelineRun: capped }))).toMatchObject({
      kind: "step-cap", state: "needs", label: "Step cap", reason: "Reached the 28-step cap", action: { kind: "retry", label: "Retry Review", stepTaskId: null }, step: { name: "Review" },
    });
  });

  test("Needs you: the queue gave up, a step asks a question, or it ended without a handoff", () => {
    const gaveUp = run({ status: "blocked", blocked: stepBlocked(), ...building, wait: wait({ state: "escalated", attempt: 3, at: null, escalation: "still blocked after 3 automatic retries", reason: "the fixture service did not come up" }) });
    expect(state(task({ column: "blocked", pipelineRun: gaveUp }))).toMatchObject({ kind: "needs-you", state: "needs", label: "Needs you", reason: "Build still blocked after 3 automatic retries: the fixture service did not come up", action: { kind: "open", label: "Open" } });
    const asks = run({ status: "blocked", blocked: stepBlocked(), active: building.active, history: [rec(1, "understand"), rec(2, "build", { handoff: handoff({ reason: "need a decision", openQuestions: ["Which registry?"] }) as never })] });
    expect(state(task({ column: "blocked", pipelineRun: asks }))).toMatchObject({ state: "needs", label: "Needs you", reason: "Asks: Which registry?", action: { kind: "open" } });
    const silent = run({ status: "blocked", ...building, blocked: [{ taskId: "s2", stepId: "build", kind: "handoff-missing", message: "the step ended without a handoff" }] });
    expect(state(task({ column: "blocked", pipelineRun: silent }))).toMatchObject({ state: "needs", label: "Needs you", reason: "the step ended without a handoff", action: { kind: "open" } });
    // First in line for a lease that is free: the owner's Retry.
    const free = state(task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked: stepBlocked("m"), ...building }) }), { lease: { holds: [], waiting: [{ label: "lab", heldBy: null, free: true, position: 1, queueLength: 1 }] } });
    expect(free).toMatchObject({ state: "needs", reason: "lab is free now", action: { kind: "retry", label: "Retry Build", stepTaskId: "s2" } });
  });

  test("Failed: a step that crashed or has no profile is red; a usage limit with no retry scheduled is amber", () => {
    const failed = (message: string, kind: "step-failed" | "profile-missing" = "step-failed") => state(task({ column: "blocked", pipelineRun: run({ status: "blocked", ...building, blocked: [{ taskId: "s2", stepId: "build", kind, message }] }) }));
    expect(failed('step "Build" failed — exit code 1')).toMatchObject({ kind: "failed", state: "failed", label: "Failed", icon: "x", reason: "exit code 1", action: { kind: "retry", label: "Retry Build", stepTaskId: "s2" } });
    expect(failed("agent profile is missing", "profile-missing")).toMatchObject({ state: "failed", label: "Failed" });
    expect(failed('step "Build" failed — You have hit your usage limit')).toMatchObject({ state: "needs", label: "Needs you", action: { kind: "retry" } });
  });

  test("Stopped: grey, and the button resumes the stopped step — it does not restart the pipeline", () => {
    const stopped = run({ status: "cancelled", active: building.active, history: [rec(1, "understand"), rec(2, "build", { outcome: "cancelled" })] });
    expect(state(task({ column: "ready", pipelineRun: stopped }))).toMatchObject({ kind: "stopped", state: "queued", label: "Stopped", reason: "Stopped at Build", action: { kind: "retry", label: "Resume Build", stepTaskId: null } });
  });

  test("CI failed: a finished pipeline whose own checks fail gets the fix-CI button; another card only opens", () => {
    const failing = pr({ checks: "failure", failingChecks: [{ name: "unit", url: null, alsoOnBase: false }] });
    expect(state(task({ column: "review", pipelineRun: finished() }), { pr: failing })).toMatchObject({ kind: "ci-failed", state: "failed", label: "CI failed", reason: "CI failing (unit)", action: { kind: "fix-ci", label: "Fix CI" } });
    expect(state(task({ column: "review", pipelineId: null }), { pr: failing })).toMatchObject({ label: "CI failed", action: { kind: "open" } });
    // The same checks fail on the base branch: not this card's to fix.
    const inherited = pr({ checks: "failure", failingChecks: [{ name: "unit", url: null, alsoOnBase: true }] });
    expect(state(task({ column: "review", pipelineRun: finished() }), { pr: inherited })).toMatchObject({ state: "waiting", label: "Waiting on base", action: { kind: "view-pr", label: "Inspect PR" } });
  });

  test("the rest of a finished card's PR states are amber: review, comments, update the branch, no PR", () => {
    const review = (p: TaskPrStatus | null) => state(task({ column: "review", pipelineRun: finished() }), { pr: p });
    expect(review(pr())).toMatchObject({ state: "needs", label: "Review PR", reason: "Checks pass — review and sign off", action: { kind: "view-pr", label: "Review PR" } });
    expect(review(pr({ unresolvedThreads: 2 }))).toMatchObject({ state: "needs", label: "Review comments", reason: "2 review comments to address", action: { kind: "open" } });
    expect(review(pr({ checks: "failure", behindBy: 2, failingChecks: [{ name: "unit", url: null, alsoOnBase: false, passesOnBase: true }] }))).toMatchObject({ state: "needs", label: "Update branch" });
    expect(review(pr({ checks: "pending" }))).toMatchObject({ state: "waiting", label: "Waiting on CI", action: { kind: "view-pr", label: "Inspect CI" } });
    expect(review(null)).toMatchObject({ state: "needs", label: "No PR yet", reason: "Opened the PR", action: { kind: "open" } });
  });

  test("Done: grey, with the result, and it asks for nothing", () => {
    expect(state(task({ column: "done", pipelineRun: finished() }))).toMatchObject({ kind: "done", state: "queued", label: "Done", reason: "Opened the PR", action: null });
    expect(state(task({ column: "done", pipelineRun: finished() }), { pr: pr() })).toMatchObject({ label: "Done", reason: "Checks pass — review and sign off", action: null });
  });
});

describe("cardState — the PR fixes", () => {
  test("no checks reported is not a pass", () => {
    const none = pr({ checks: "none" });
    const s = state(task({ column: "review", pipelineRun: finished() }), { pr: none });
    expect(s).toMatchObject({ state: "needs", label: "Review PR", reason: "No checks reported — review it" });
    expect(cardStatus(task({ column: "review", pipelineRun: finished() }), { pr: none, lease: noLease, now: NOW })).toMatchObject({ line: "PR #177: no checks reported — review it", tone: "warning" });
    // In Ready to Merge it keeps waiting for checks rather than merging.
    expect(state(task({ column: "merge", pipelineRun: finished() }), { pr: none }).label).toBe("Waiting on CI");
  });

  test("a PR closed without merging does not read as no PR yet", () => {
    const closed = pr({ state: "closed" });
    expect(state(task({ column: "review", pipelineRun: finished() }), { pr: closed })).toMatchObject({ kind: "pr-closed", state: "needs", label: "PR closed", reason: "PR #177 was closed without merging", action: { kind: "view-pr", label: "Inspect PR" } });
    expect(cardStatus(task({ column: "review", pipelineRun: finished() }), { pr: closed, lease: noLease, now: NOW }).line).toBe("PR #177 was closed without merging");
    expect(cardStatus(task({ column: "review", pipelineId: null }), { pr: closed, lease: noLease, now: NOW }).line).toBe("PR #177 was closed without merging");
    expect(state(task({ column: "done", pipelineRun: finished() }), { pr: closed }).label).toBe("Done");
  });
});

describe("cardState — a task without a pipeline", () => {
  test("the Running column alone is not Working: it takes activity", () => {
    const plain = (o: Partial<Task>) => state(task({ pipelineId: null, ...o }));
    expect(plain({ column: "running" })).toMatchObject({ kind: "no-activity", state: "queued", label: "No activity yet", step: null, strip: null, action: null });
    expect(plain({ column: "running", lastActivityAt: NOW - MIN, todoProgress: { completed: 2, total: 5 } })).toMatchObject({ state: "working", label: "Working", reason: "Agent is working · 2/5 todos", elapsedMs: null });
    expect(plain({ column: "running", lastActivityAt: NOW - 30 * MIN })).toMatchObject({ state: "needs", label: "Quiet", action: { kind: "open", label: "Check" } });
    expect(plain({ column: "blocked" })).toMatchObject({ state: "needs", label: "Needs you", action: { kind: "open", label: "Review" } });
    expect(plain({ column: "review" })).toMatchObject({ state: "needs", label: "Review", action: { kind: "open", label: "Review" } });
    expect(plain({ column: "done" })).toMatchObject({ state: "queued", label: "Done", action: null });
    expect(plain({ column: "ready" })).toMatchObject({ state: "queued", label: "Queued", reason: "Ready to run", action: { kind: "run", label: "Run" } });
    // Run before and moved back: nothing to offer but opening it.
    expect(plain({ column: "backlog", hasOpenableRun: true }).action).toBeNull();
    expect(plain({ column: "done", archivedAt: 1 })).toMatchObject({ kind: "archived", label: "Archived", action: null });
  });
});

describe("stepStrip", () => {
  const names = (r: PipelineRunState, current: string | null) => stepStrip(r, current)!.map((s) => `${s.name}:${s.status}`);

  test("segments follow the graph from its start step, not the array's order", () => {
    const shuffled = snapshot([STEPS[3]!, STEPS[1]!, STEPS[0]!, STEPS[2]!]);
    expect(names(run({ snapshot: shuffled, history: [rec(1, "understand")] }), "build")).toEqual(["Understand:done", "Build:current", "Review:todo", "Finish:todo"]);
  });

  test("a loop back: the steps ahead are to do again, and the step says which round it is on", () => {
    const looped = run({ active: [{ stepId: "build", taskId: "s4", seq: 4 }], history: [rec(1, "understand"), rec(2, "build"), rec(3, "review"), rec(4, "build", { taskId: "s4", startedAt: NOW - MIN, endedAt: null, outcome: null })] });
    expect(names(looped, "build")).toEqual(["Understand:done", "Build:current", "Review:todo", "Finish:todo"]);
    expect(state(task({ pipelineRun: looped })).step).toEqual({ id: "build", name: "Build", round: 2 });
  });

  test("a step before the current one without a succeeded execution is not done", () => {
    const skipped = run({ history: [rec(1, "understand", { outcome: "advanced-manually" }), rec(2, "build")] });
    expect(names(skipped, "review")).toEqual(["Understand:todo", "Build:done", "Review:current", "Finish:todo"]);
  });

  test("a follow-up step has no segment: the pipeline's own steps stay done", () => {
    const followUp = finished({
      status: "running",
      snapshot: snapshot([...STEPS, { id: "followup-1", name: "Fix CI" }]),
      active: [{ stepId: "followup-1", taskId: "s5", seq: 5 }],
      history: [rec(1, "understand"), rec(2, "build"), rec(3, "review"), rec(4, "finish"), rec(5, "followup-1", { startedAt: NOW - 3 * MIN, endedAt: null, outcome: null })],
    });
    const s = state(task({ pipelineRun: followUp }));
    expect(s.strip!.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(s).toMatchObject({ label: "Working", step: { name: "Fix CI" }, elapsedMs: 3 * MIN });
  });

  test("a step reached both directly and through others comes after the others; a loop back does not reorder", () => {
    // Understand → Finish for a trivial change, beside Understand → Build → Review → Finish.
    const edges = [
      { id: "a", from: "understand", to: "build", label: "" },
      { id: "b", from: "understand", to: "finish", label: "trivial" },
      { id: "c", from: "build", to: "review", label: "" },
      { id: "d", from: "review", to: "build", label: "changes" },
      { id: "e", from: "review", to: "finish", label: "approved" },
      { id: "f", from: "finish", to: "build", label: "verification failed" },
    ];
    expect(stepOrder(snapshot(STEPS, edges)!.graph)).toEqual(["understand", "build", "review", "finish"]);
    // The steps as listed, when nothing says where the start is reached from.
    expect(stepOrder(snapshot(STEPS, [])!.graph)).toEqual(["understand", "build", "review", "finish"]);
    // A fan-out and its join: both branches before the step that joins them.
    const fan = [
      { id: "a", from: "understand", to: "build", label: "" },
      { id: "b", from: "understand", to: "review", label: "" },
      { id: "c", from: "build", to: "finish", label: "" },
      { id: "d", from: "review", to: "finish", label: "" },
    ];
    expect(stepOrder(snapshot(STEPS, fan)!.graph)).toEqual(["understand", "build", "review", "finish"]);
  });

  test("no snapshot, no strip — and the step falls back to its id", () => {
    const bare = run({ snapshot: null, ...building });
    expect(stepStrip(bare, "build")).toBeNull();
    expect(state(task({ pipelineRun: bare }))).toMatchObject({ label: "Working", strip: null, step: { name: "build" } });
  });

  test("a finished run: every step that succeeded is done and none is current", () => {
    expect(names(finished(), null)).toEqual(["Understand:done", "Build:done", "Review:done", "Finish:done"]);
  });
});

describe("columnSummary and formatElapsed", () => {
  test("counts by state, the owner's first", () => {
    const of = (...tones: CardState["state"][]) => columnSummary(tones.map((t) => ({ state: t })));
    expect(of("working", "working", "waiting", "waiting")).toBe("2 working · 2 waiting");
    expect(of("needs", "needs", "waiting", "failed")).toBe("2 need you · 1 failed · 1 waiting");
    expect(of("needs", "merged", "queued")).toBe("1 needs you · 1 queued · 1 merged");
    expect(of()).toBe("");
  });

  test("elapsed reads in minutes and hours", () => {
    expect(formatElapsed(20_000)).toBe("<1m");
    expect(formatElapsed(2 * MIN)).toBe("2m");
    expect(formatElapsed(125 * MIN)).toBe("2h 5m");
    expect(formatElapsed(120 * MIN)).toBe("2h");
  });
});
