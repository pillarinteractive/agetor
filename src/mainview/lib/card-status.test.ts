import { describe, expect, test } from "bun:test";
import { cardStatus, formatAge, needsYouList, roadmapCardInfo, roadmapLinkInfo, roadmapNeedsYou, roadmapOffer } from "./card-status.ts";
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

  test("parked in the blocked-step wait queue: what it waits on, when it is retried, which attempt — and not the owner's", () => {
    const blocked = [{ taskId: "s1", stepId: "build", kind: "step-blocked" as const, message: 'step "Build" reported it is blocked: the fixture service did not come up' }];
    const at = new Date(2031, 2, 4, 15, 40).getTime();
    const wait = (o: Record<string, unknown> = {}) => ({ stepId: "build", taskId: "s1", category: "unknown", source: "none", what: "its own stated reason", ref: null, reason: "the fixture service did not come up", state: "waiting", since: at - 60 * 60_000, attempt: 1, max: 3, at, deadline: at + 86_400_000, tried: [{ at: at - 45 * 60_000, trigger: "its retry time came" }], ...o }) as never;
    const card = (w: unknown) => task({ column: "blocked", pipelineRun: run({ status: "blocked", blocked, active: [{ stepId: "build", taskId: "s1", seq: 1 }], wait: w as never }) });
    const now = at - 20 * 60_000;
    const st = (t: Task, lease = noLease) => cardStatus(t, { pr: null, lease, now });
    expect(st(card(wait()))).toEqual({ line: "Build blocked — retrying at 3:40 PM · attempt 2 of 3", tone: "muted", needsYou: null });
    expect(st(card(wait({ category: "dependency", what: "#41", ref: "#41", max: 4 }))).line).toBe("Build waiting on #41 — resumes when it is closed · attempt 2 of 4");
    // A watched lease: who holds it, and the place in line.
    const lab = wait({ category: "resource", source: "signal", what: "the lab", ref: "lab", max: 6 });
    expect(st(card(lab), { holds: [], waiting: [{ label: "lab", heldBy: "E2E", free: false, position: 2, queueLength: 3 }] })).toMatchObject({
      line: "Build waiting for the lab (held by E2E, 2nd of 3 in line) — retrying when it frees or at 3:40 PM · attempt 2 of 6",
      needsYou: null,
    });
    expect(st(card(lab)).line).toBe("Build waiting for the lab — retrying at 3:40 PM · attempt 2 of 6");

    // The queue gave up: the owner's, with the reason and what was tried.
    const gaveUp = st(card(wait({ state: "escalated", attempt: 3, at: null, escalatedAt: now, escalation: "still blocked after 3 automatic retries", tried: [{ at: at - 200 * 60_000, trigger: "t" }, { at: at - 150 * 60_000, trigger: "t" }, { at: at - 45 * 60_000, trigger: "t" }] })));
    expect(gaveUp).toMatchObject({ line: "Build still blocked after 3 automatic retries: the fixture service did not come up", tone: "danger" });
    expect(gaveUp.needsYou).toEqual({ reason: "Build still blocked after 3 automatic retries — retried 3 times (12:20 PM, 1:10 PM, 2:55 PM); it says: the fixture service did not come up", action: "open", actionLabel: "Open" });
    expect(needsYouList([{ task: card(wait()), status: st(card(wait())) }])).toEqual([]);

    // No queue entry: a block is the owner's, as before.
    expect(st(card(undefined)).needsYou).not.toBeNull();
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

describe("roadmapNeedsYou — roadmap steps with no card", () => {
  const status = {
    issue: 600,
    url: "https://github.com/o/r/issues/600",
    fetchedAt: 0,
    scope: null as { number: number; title: string; roadmapTotal: number } | null,
    counts: { total: 3, complete: 0, declined: 0, inFlight: 0, ready: 1, waiting: 2, backlog: 2 },
    blockedOutside: [],
    cards: [
      { taskId: "bl-13", step: "3", issue: 13, human: false, line: "Step 3 · waits on steps 1 (#11), 2 (#12)", tone: "muted" as const },
      { taskId: "bl-11", step: "1", issue: 11, human: true, line: "Step 1 · yours to do — open the issue", tone: "warning" as const },
    ],
    humanReady: [{ step: "1", issue: 11, title: "[Human] Provide the sample device", url: "https://github.com/o/r/issues/11" }],
    needsUser: [{ step: "2", issue: 12, title: "Inventory the widgets", url: "https://github.com/o/r/issues/12", reason: "PR #77 merged but the issue is still open" }],
    nextWaiting: [],
    problems: [],
    idleReason: null,
  };
  const autopilot = (enabled: boolean, roadmap: { issue: number } | null) => ({ config: { enabled, roadmap }, state: { roadmap: status } });

  test("steps Autopilot won't restart first, then the ready human steps, each with its issue URL", () => {
    expect(roadmapNeedsYou(autopilot(true, { issue: 600 }))).toEqual([
      { key: "stuck:12", kind: "stuck", step: "2", issue: 12, title: "Step 2 · #12 Inventory the widgets", reason: "PR #77 merged but the issue is still open", detail: null, url: "https://github.com/o/r/issues/12", pr: null, prUrl: null, taskId: null },
      { key: "human:11", kind: "human", step: "1", issue: 11, title: "Step 1 · #11 [Human] Provide the sample device", reason: "ready for you — only you can do this step", detail: null, url: "https://github.com/o/r/issues/11", pr: null, prUrl: null, taskId: null },
    ]);
  });

  test("a stuck step carries its PR and what the PR said; a held card's step opens its PR and card", () => {
    const withHeld = {
      ...status,
      needsUser: [
        { step: "2", issue: 12, title: "Inventory the widgets", url: "https://github.com/o/r/issues/12", kind: "stuck" as const, reason: "PR #77 merged but the issue is still open", pr: 77, prUrl: "https://github.com/o/r/pull/77", detail: "PR #77 left it open on purpose: “Refs #12 — the export is not wired yet”", taskId: "c12" },
        { step: "3", issue: 13, title: "Build the widget store", url: "https://github.com/o/r/issues/13", kind: "held" as const, reason: "PR #78 changes sensitive code — held in In Review for your sign-off", pr: 78, prUrl: "https://github.com/o/r/pull/78", detail: "src/lib/billing/prices.ts", taskId: "c13" },
      ],
      humanReady: [],
    };
    const out = roadmapNeedsYou({ config: { enabled: true, roadmap: { issue: 600 } }, state: { roadmap: withHeld } });
    expect(out.map((o) => o.key)).toEqual(["stuck:12", "held:13"]);
    expect(out[0]).toMatchObject({ kind: "stuck", pr: 77, prUrl: "https://github.com/o/r/pull/77", detail: expect.stringContaining("Refs #12"), taskId: "c12" });
    expect(out[1]).toMatchObject({ kind: "held", pr: 78, prUrl: "https://github.com/o/r/pull/78", detail: "src/lib/billing/prices.ts", taskId: "c13" });
  });

  test("nothing when Autopilot is paused, in milestone mode, or the status is another roadmap's", () => {
    expect(roadmapNeedsYou(autopilot(false, { issue: 600 }))).toEqual([]);
    expect(roadmapNeedsYou(autopilot(true, null))).toEqual([]);
    expect(roadmapNeedsYou(autopilot(true, { issue: 601 }))).toEqual([]);
    expect(roadmapNeedsYou({ config: { enabled: true, roadmap: { issue: 600 } }, state: {} })).toEqual([]);
    expect(roadmapNeedsYou(null)).toEqual([]);
  });
});

describe("roadmap backlog cards", () => {
  const info: import("../../shared/roadmap.ts").RoadmapCardInfo = { taskId: "bl-13", step: "3", issue: 13, human: false, line: "Step 3 · waits on steps 1 (#11), 2 (#12)", tone: "muted" };
  const idle = run({ status: "idle", snapshot: null });
  const st = (t: Task, roadmap: typeof info | null) => cardStatus(t, { pr: null, lease: noLease, now: NOW, roadmap });

  test("a never-started card says its step and what it waits on", () => {
    expect(st(task({ id: "bl-13", column: "backlog", runId: null, pipelineRun: idle }), info)).toEqual({ line: "Step 3 · waits on steps 1 (#11), 2 (#12)", tone: "muted", needsYou: null });
    // The owner's card doesn't ask twice: the Needs you strip already lists its step.
    const owner = { ...info, taskId: "bl-11", human: true, line: "Step 1 · yours to do — open the issue", tone: "warning" as const };
    expect(st(task({ id: "bl-11", column: "backlog", runId: null, pipelineRun: idle }), owner)).toEqual({ line: "Step 1 · yours to do — open the issue", tone: "warning", needsYou: null });
  });

  test("once it runs, or is done, the card speaks for itself", () => {
    const running = task({ id: "bl-13", column: "running", pipelineRun: run({ active: [{ stepId: "build", taskId: "s1", seq: 1 }] }) });
    expect(st(running, info).line).toBe("Build step starting");
    expect(st(task({ id: "bl-13", column: "done", runId: null, pipelineRun: idle }), info).line).toBe("Done");
  });

  test("a pipeline card nothing has run is in the backlog — not 'finished without a PR'", () => {
    expect(st(task({ column: "backlog", runId: null, pipelineRun: idle }), null)).toEqual({ line: "In backlog", tone: "muted", needsYou: null });
    expect(st(task({ column: "ready", runId: null, pipelineRun: idle }), null)).toEqual({ line: "Ready to run", tone: "muted", needsYou: null });
  });

  test("roadmapCardInfo: the current run's cards by id — paused too, never another milestone's", () => {
    const scoped = { issue: 600, scope: { number: 2, title: "M02", roadmapTotal: 6 }, cards: [info] } as never;
    const a = (enabled: boolean, milestone: { number: number } | null) => ({ config: { enabled, roadmap: { issue: 600 }, milestone }, state: { roadmap: scoped } });
    expect([...roadmapCardInfo(a(true, { number: 2 })).keys()]).toEqual(["bl-13"]);
    expect([...roadmapCardInfo(a(false, { number: 2 })).keys()]).toEqual(["bl-13"]);
    expect(roadmapCardInfo(a(true, { number: 3 })).size).toBe(0);
    expect(roadmapCardInfo(a(true, null)).size).toBe(0);
    expect(roadmapCardInfo(null).size).toBe(0);
    // A status saved before cards existed has none.
    expect(roadmapCardInfo({ config: { roadmap: { issue: 600 }, milestone: null }, state: { roadmap: { issue: 600 } as never } }).size).toBe(0);
  });

  test("Needs you follows the scope: another milestone's status raises nothing", () => {
    const scoped = { issue: 600, scope: { number: 2, title: "M02", roadmapTotal: 6 }, needsUser: [], humanReady: [{ step: "1", issue: 11, title: "[Human] Provide the sample device", url: null }] } as never;
    const a = (milestone: { number: number } | null) => ({ config: { enabled: true, roadmap: { issue: 600 }, milestone }, state: { roadmap: scoped } });
    expect(roadmapNeedsYou(a({ number: 2 })).map((n) => n.key)).toEqual(["human:11"]);
    expect(roadmapNeedsYou(a({ number: 3 }))).toEqual([]);
    expect(roadmapNeedsYou(a(null))).toEqual([]);
  });
});


describe("roadmap links and the next-milestone offer, from the status of the run configured now", () => {
  const M01 = { number: 1, title: "M01 — Widget foundations" };
  const M02 = { number: 2, title: "M02 — Widget page" };
  const offer = { stage: "M02", number: 2, title: M02.title, steps: 3, agentSteps: 3, startable: 1, waitingOn: null, current: "M01", left: 1, maxInFlight: 2, reason: "nearly-done" as const, dismissedAt: null as number | null };
  const roadmap = {
    issue: 600,
    scope: { ...M01, roadmapTotal: 6, milestones: [{ ...M01, total: 2 }] },
    cards: [],
    links: [
      { step: "2", issue: 12, title: "Inventory the widgets", state: "in-flight", taskId: "c12", predecessors: [], successors: [] },
      { step: "3", issue: 13, title: "Build the widget store", state: "backlog", taskId: "bl-13", predecessors: [], successors: [] },
      { step: "9", issue: 19, title: "A step with no card yet", state: "open", taskId: null, predecessors: [], successors: [] },
    ],
    nextMilestone: offer,
  };
  const dto = (config: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => ({
    config: { enabled: true, roadmap: { issue: 600 }, milestone: M01, milestones: [M01], autoContinue: false, ...config },
    state: { roadmap: { ...roadmap, ...status } as never },
  });

  test("links are keyed by card: steps without a card have no entry", () => {
    expect([...roadmapLinkInfo(dto()).keys()]).toEqual(["c12", "bl-13"]);
    expect(roadmapLinkInfo(dto()).get("bl-13")).toMatchObject({ step: "3", issue: 13 });
    // Paused: the cards are still there, and so are their links.
    expect(roadmapLinkInfo(dto({ enabled: false })).size).toBe(2);
    // Another scope, a status from an older build, or no Autopilot at all: nothing.
    expect(roadmapLinkInfo(dto({ milestone: M02, milestones: [M02] })).size).toBe(0);
    expect(roadmapLinkInfo(dto({}, { links: undefined })).size).toBe(0);
    expect(roadmapLinkInfo(null).size).toBe(0);
  });

  test("the board asks only about an offer that is due, unanswered, and not automatic", () => {
    expect(roadmapOffer(dto())).toMatchObject({ number: 2, reason: "nearly-done" });
    expect(roadmapOffer(dto({}, { nextMilestone: { ...offer, reason: null } }))).toBeNull(); // not due yet
    expect(roadmapOffer(dto({}, { nextMilestone: { ...offer, dismissedAt: 5 } }))).toBeNull(); // "not now"
    expect(roadmapOffer(dto({}, { nextMilestone: null }))).toBeNull();
    expect(roadmapOffer(dto({ autoContinue: true }))).toBeNull(); // Autopilot takes it itself
    expect(roadmapOffer(dto({ enabled: false }))).toBeNull(); // paused
    // The scope changed by hand since the status was written: that offer belongs to another run.
    expect(roadmapOffer(dto({ milestone: M01, milestones: [M01, M02] }))).toBeNull();
    expect(roadmapOffer(null)).toBeNull();
  });
});
