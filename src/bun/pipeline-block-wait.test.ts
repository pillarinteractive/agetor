import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { LeaseStatus, PipelineRunState } from "../shared/types.ts";

// The blocked-step wait queue (pipeline-runner.ts `scheduleBlockWait` /
// `releaseBlockWaits`, rules in src/shared/block-wait.ts). Same bootstrap as
// pipeline-auto-retry.test.ts. Every block reason here is synthetic.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-block-wait-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const BLOCK_ENV = ["AGETOR_FAKE_CLAUDE_BLOCKED_REASON", "AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS", "AGETOR_FAKE_CLAUDE_BLOCKED_WAITING", "AGETOR_FAKE_CLAUDE_BLOCKED_NEXT", "AGETOR_FAKE_CLAUDE_BLOCKED_STDERR"];
const MIN = 60_000;
let parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  for (const k of BLOCK_ENV) delete process.env[k];
  const { resetBlockWaitsForTests, stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  resetBlockWaitsForTests();
  stopPipelineAutoRetryTimers();
  const { tasks, preferences } = await import("./db.ts");
  preferences.set("blocked_wait", "{}");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Build → Review (Build's only edge) → Finish, started. `buildSuffix` is
 *  what Build's turns do: "blocked" (every turn), "blocked-then-Review". */
async function startBuildReview(buildSuffix: string, workdir = mkdtempSync(path.join(tmpdir(), "agetor-block-wait-wd-"))) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({
    name: `block-wait-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, suffix: string) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const build = step("Build", buildSuffix);
  const review = step("Review", "Finish");
  const finish = step("Finish", "done");
  const pipeline = pipelines.insert({
    name: `block-wait-${randomUUID()}`,
    graph: {
      steps: [build, review, finish],
      edges: [
        { id: "e1", from: build.id, to: review.id, label: "" },
        { id: "e2", from: review.id, to: build.id, label: "changes requested" },
        { id: "e3", from: review.id, to: finish.id, label: "approved" },
      ],
      startStepId: build.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "block wait", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, review, finish, workdir };
}

const { dataDir } = await import("./db.ts");
const activity = (id: string): string[] => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
};

/** The run once it is blocked and the queue has decided (parked, or not). */
async function blockedRun(parentId: string, pred: (run: PipelineRunState) => boolean = () => true): Promise<PipelineRunState> {
  const { tasks } = await import("./db.ts");
  return waitFor(() => {
    const run = tasks.get(parentId)?.pipelineRun;
    return run?.status === "blocked" && pred(run) ? run : undefined;
  });
}
const parked = (attempt: number) => (run: PipelineRunState) => run.wait?.state === "waiting" && run.wait.attempt === attempt;

async function noJitter() {
  const { blockWaitDeps } = await import("./pipeline-runner.ts");
  blockWaitDeps.rng = () => 0;
}

const lease = (project: string, over: Partial<LeaseStatus>): LeaseStatus => ({
  project, label: "rig", held: false, holderTaskId: null, holderTitle: null, checkout: null, owner: null, since: null, checkedAt: Date.now(), error: null, queue: [], ...over,
});

test("a block nobody needs to decide is parked, holds no slot, and the same step is resumed in its own session — the next step never starts on unfinished work", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { releaseBlockWaits, listBlockWaits } = await import("./pipeline-runner.ts");
  const { holdsAutopilotSlot, waitingOnQuota } = await import("../shared/autopilot.ts");
  const { waitingInQueue } = await import("../shared/block-wait.ts");
  const { slotUse } = await import("./step-slots.ts");
  const { isTaskRunLive } = await import("./orchestrator.ts");
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT = "Review";
  const { parentId, build, review } = await startBuildReview("blocked-then-Review");
  const run = await blockedRun(parentId, parked(0));

  // Held on Build: Review was not launched.
  expect(run.active.map((a) => a.stepId)).toEqual([build.id]);
  expect(run.history.map((h) => h.stepId)).toEqual([build.id]);
  const w = run.wait!;
  expect(w).toMatchObject({ stepId: build.id, category: "unknown", source: "none", state: "waiting", attempt: 0, max: 3, reason: "the fixture service did not come up" });
  expect(Math.round((w.at! - w.since) / MIN)).toBe(15);
  expect(run.autoRetry).toBeUndefined();
  const lines = activity(parentId);
  expect(lines.some((l) => /^Build blocked — retrying automatically at .+ · attempt 1 of 3 \(no known reason matched\)$/.test(l))).toBe(true);
  expect(lines.some((l) => l.includes("holding the run on Build"))).toBe(false); // that line is for the owner's blocks

  // Waiting: no Autopilot slot, no step slot, and not a usage-limit hold.
  const card = tasks.get(parentId)!;
  expect(card.column).toBe("blocked");
  expect(waitingInQueue(card.pipelineRun)).toBe(true);
  expect(holdsAutopilotSlot(card)).toBe(false);
  expect(holdsAutopilotSlot({ ...card, column: "running" })).toBe(false);
  expect(waitingOnQuota(card.pipelineRun)).toBe(false);
  expect(slotUse(isTaskRunLive, undefined, [card, ...tasks.stepsForParent(parentId)])).toEqual({ total: 0, heavy: 0 });
  expect(listBlockWaits().find((r) => r.taskId === parentId)).toMatchObject({ step: "Build", category: "unknown", attempt: 0, max: 3, nextAt: w.at, state: "waiting" });

  // Not due yet: nothing happens.
  expect(await releaseBlockWaits(w.at! - 1000)).toBe(0);
  expect(tasks.get(parentId)!.pipelineRun!.wait).toMatchObject({ state: "waiting", attempt: 0 });

  // Due: Build is resumed — the same step task, a follow-up turn with the note.
  const buildTaskId = run.active[0]!.taskId;
  expect(await releaseBlockWaits(w.at! + 1)).toBe(1);
  const done = await waitFor(() => {
    const r = tasks.get(parentId)?.pipelineRun;
    return r?.status === "done" ? r : undefined;
  });
  expect(done.history.slice(0, 2).map((h) => [h.stepId, h.taskId === buildTaskId])).toEqual([[build.id, true], [review.id, false]]);
  expect(done.history[0]).toMatchObject({ outcome: "succeeded", responseKind: "handoff" });
  expect(done.wait).toBeUndefined();
  const turns = runs.listForTask(buildTaskId).flatMap((r) => runs.events(r.id)).filter((e) => e.stream === "user").map((e) => e.data);
  const note = turns.find((u) => u.startsWith('You handed off step "Build" as blocked'));
  expect(note).toContain('Your stated reason was: "the fixture service did not come up"');
  expect(note).toContain("This is automatic retry 1 of 3.");
  expect(note).toContain('"waitingOn"');
  expect(activity(parentId).some((l) => l === "Resumed Build in its own session to check its block (automatic retry 1 of 3)")).toBe(true);
  expect(tasks.stepsForParent(parentId).filter((t) => t.pipelineStepId === build.id).length).toBe(1);
});

test("a step that stays blocked is retried at 15 min, 45 min and 2 h, then goes to the owner with what was tried", async () => {
  const { tasks } = await import("./db.ts");
  const { releaseBlockWaits, listBlockWaits } = await import("./pipeline-runner.ts");
  const { escalatedWait, waitingInQueue } = await import("../shared/block-wait.ts");
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  const { parentId, build } = await startBuildReview("blocked");
  const delays: number[] = [];
  let clock = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await blockedRun(parentId, parked(attempt));
    delays.push(Math.round((run.wait!.at! - Date.now()) / MIN));
    clock = run.wait!.at! + 1;
    expect(await releaseBlockWaits(clock)).toBe(1);
  }
  expect(delays).toEqual([15, 45, 120]);
  const run = await blockedRun(parentId, (r) => r.wait?.state === "escalated");
  expect(run.wait).toMatchObject({ attempt: 3, at: null, escalation: "still blocked after 3 automatic retries" });
  expect(run.wait!.tried.length).toBe(3);
  // Still on Build; nothing else ran.
  expect(run.active.map((a) => a.stepId)).toEqual([build.id]);
  expect(run.history.length).toBe(1);
  expect(waitingInQueue(run)).toBe(false);
  expect(escalatedWait(run)).not.toBeNull();
  expect(activity(parentId).some((l) => l.startsWith("Build still blocked after 3 automatic retries — left for you (retried 3 times (") && l.endsWith("It says: the fixture service did not come up"))).toBe(true);
  // The queue never touches it again.
  expect(await releaseBlockWaits(clock + 48 * 60 * MIN)).toBe(0);
  expect(tasks.get(parentId)!.pipelineRun!.wait!.state).toBe("escalated");
  expect(listBlockWaits().find((r) => r.taskId === parentId)).toMatchObject({ state: "escalated", nextAt: null });
});

test("anything that asks the owner goes straight to Needs you — open questions, a declared owner, an owner's decision — whatever else the step declares", async () => {
  const { releaseBlockWaits } = await import("./pipeline-runner.ts");
  const cases: Record<string, string>[] = [
    { AGETOR_FAKE_CLAUDE_BLOCKED_REASON: "the fixture service did not come up", AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS: JSON.stringify(["Should the fixture use port 8080?"]) },
    { AGETOR_FAKE_CLAUDE_BLOCKED_REASON: "the fixture service did not come up", AGETOR_FAKE_CLAUDE_BLOCKED_WAITING: JSON.stringify({ waitingOn: "owner" }) },
    // The field can't talk its way past a question for the owner.
    { AGETOR_FAKE_CLAUDE_BLOCKED_REASON: "the rig is busy", AGETOR_FAKE_CLAUDE_BLOCKED_WAITING: JSON.stringify({ waitingOn: "resource", waitingRef: "rig" }), AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS: JSON.stringify(["May I skip the rig test?"]) },
    { AGETOR_FAKE_CLAUDE_BLOCKED_REASON: "the deploy token is missing", AGETOR_FAKE_CLAUDE_BLOCKED_WAITING: JSON.stringify({ waitingOn: "environment" }) },
    {}, // the fake's default: "needs a product decision"
  ];
  for (const env of cases) {
    for (const k of BLOCK_ENV) delete process.env[k];
    Object.assign(process.env, env);
    const { parentId } = await startBuildReview("blocked");
    const run = await blockedRun(parentId);
    await new Promise((r) => setTimeout(r, 60)); // both settle events have landed
    expect(run.wait).toBeUndefined();
    expect(run.autoRetry).toBeUndefined();
    expect(run.blocked[0]).toMatchObject({ kind: "step-blocked" });
    expect(await releaseBlockWaits(Date.now() + 72 * 60 * MIN)).toBe(0);
  }
});

test("a resumed step that comes back with a question for the owner leaves the queue at once", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { releaseBlockWaits } = await import("./pipeline-runner.ts");
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  const { parentId, build } = await startBuildReview("blocked");
  const first = await blockedRun(parentId, parked(0));
  // On its retry the step finds it needs the owner after all.
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Which port should the fixture use?"]);
  expect(await releaseBlockWaits(first.wait!.at! + 1)).toBe(1);
  const run = await waitFor(() => {
    const r = tasks.get(parentId)?.pipelineRun;
    return r?.status === "blocked" && r.wait == null && runs.listForTask(first.active[0]!.taskId).length >= 1 && activity(parentId).some((l) => l.includes("now waits on you")) ? r : undefined;
  });
  expect(run.active.map((a) => a.stepId)).toEqual([build.id]);
  expect(run.blocked[0]!.message).toContain("open questions: Which port should the fixture use?");
  expect(activity(parentId)).toContain("Build now waits on you (its handoff has open questions) — its automatic retries have stopped after 1");
  expect(await releaseBlockWaits(Date.now() + 72 * 60 * MIN)).toBe(0);
});

test("a restart loses nothing: the queue is the persisted run state, and a resume that was recorded but never sent goes back in line", async () => {
  const { tasks } = await import("./db.ts");
  const { releaseBlockWaits, resetBlockWaitsForTests, blockWaitDeps } = await import("./pipeline-runner.ts");
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  const { parentId } = await startBuildReview("blocked-then-Review");
  const run = await blockedRun(parentId, parked(0));
  // What a new core process reads back from the database.
  const stored = tasks.get(parentId)!.pipelineRun!.wait!;
  expect(stored).toEqual(run.wait!);
  resetBlockWaitsForTests(); // every in-memory trace of the queue gone
  blockWaitDeps.rng = () => 0;

  // The core died between recording the resume and sending it.
  tasks.setPipelineRun(parentId, { ...tasks.get(parentId)!.pipelineRun!, wait: { ...stored, state: "resuming", attempt: 1, at: null, tried: [{ at: stored.since, trigger: "its retry time came" }] } });
  expect(await releaseBlockWaits(stored.since + 5 * MIN)).toBe(0); // may still be starting
  expect(tasks.get(parentId)!.pipelineRun!.wait!.state).toBe("resuming");
  expect(await releaseBlockWaits(stored.since + 11 * MIN)).toBe(1); // back in line, and due
  const done = await waitFor(() => (tasks.get(parentId)?.pipelineRun?.status === "done" ? tasks.get(parentId)!.pipelineRun : undefined));
  expect(done!.wait).toBeUndefined();
});

test("a manual Retry or Stop always wins over the queue", async () => {
  const { tasks } = await import("./db.ts");
  const { retryPipelineStep, cancelPipelineRun, releaseBlockWaits } = await import("./pipeline-runner.ts");
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";

  // Retry by hand: the entry is cleared and the queue stands down.
  const retried = await startBuildReview("blocked-then-Review");
  const at = (await blockedRun(retried.parentId, parked(0))).wait!.at!;
  expect("task" in (await retryPipelineStep(retried.parentId))).toBe(true);
  expect(tasks.get(retried.parentId)!.pipelineRun!.wait).toBeUndefined();
  expect(activity(retried.parentId)).toContain("Build was resumed outside the wait queue — its automatic retries are cancelled");
  await waitFor(() => tasks.get(retried.parentId)?.pipelineRun?.status === "done");
  expect(await releaseBlockWaits(at + 1)).toBe(0);

  // Stop on a parked card: out of the queue, the block stays for the owner.
  const stopped = await startBuildReview("blocked");
  const at2 = (await blockedRun(stopped.parentId, parked(0))).wait!.at!;
  expect("task" in (await cancelPipelineRun(stopped.parentId))).toBe(true);
  const run = tasks.get(stopped.parentId)!.pipelineRun!;
  expect(run.wait).toBeUndefined();
  expect(run.status).toBe("blocked");
  expect(activity(stopped.parentId)).toContain("Automatic retry cancelled — left for you");
  expect(await releaseBlockWaits(at2 + 1)).toBe(0);
});

test("waiting for a watched lease: no resume is spent while it is held; the step is resumed as soon as it frees", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { releaseBlockWaits, blockWaitDeps, listBlockWaits } = await import("./pipeline-runner.ts");
  await noJitter();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-block-wait-wd-"));
  let held = true;
  blockWaitDeps.leases = () => [lease(workdir, { held, holderTaskId: held ? "another-card" : null, holderTitle: held ? "Another card" : null })];
  // Open questions would send it to the owner — but the watcher sees the rig
  // held elsewhere, which is what the card always showed as "Waiting for…".
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the rig lease is held by another checkout";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Can the rig suite run later?"]);
  const { parentId } = await startBuildReview("blocked-then-Review", workdir);
  const run = await blockedRun(parentId, parked(0));
  const w = run.wait!;
  expect(w).toMatchObject({ category: "resource", source: "signal", what: "the rig", ref: "rig", max: 6 });
  expect(listBlockWaits().find((r) => r.taskId === parentId)!.line).toMatch(/^Build waiting for the rig — retrying when it frees or at .+ · attempt 1 of 6$/);

  // The timer comes due with the rig still held: looked at, not resumed.
  expect(await releaseBlockWaits(w.at! + 1)).toBe(0);
  const later = tasks.get(parentId)!.pipelineRun!.wait!;
  expect(later).toMatchObject({ state: "waiting", attempt: 0, tried: [] });
  expect(later.at!).toBeGreaterThan(w.at!);

  // It frees: resumed at once, well before the next timed look.
  held = false;
  const now = w.at! + 2 * MIN;
  expect(now).toBeLessThan(later.at!);
  expect(await releaseBlockWaits(now)).toBe(1);
  await waitFor(() => tasks.get(parentId)?.pipelineRun?.status === "done");
  const turns = runs.listForTask(run.active[0]!.taskId).flatMap((r) => runs.events(r.id)).filter((e) => e.stream === "user").map((e) => e.data);
  expect(turns.some((u) => u.includes("Since then: the rig is free."))).toBe(true);
  expect(activity(parentId)).toContain("Resumed Build in its own session to check its block — the rig is free (automatic retry 1 of 6)");
});

test("waiting for another change: resumed when the issue it names is closed, never on a timer", async () => {
  const { tasks } = await import("./db.ts");
  const { releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  await noJitter();
  let state: "open" | "closed" | "unknown" = "open";
  const asked: number[] = [];
  blockWaitDeps.refState = async (_project, n) => {
    asked.push(n);
    return state;
  };
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the shared parser has to land first";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#41" });
  const { parentId } = await startBuildReview("blocked-then-Review");
  const w = (await blockedRun(parentId, parked(0))).wait!;
  expect(w).toMatchObject({ category: "dependency", source: "declared", what: "#41", ref: "#41", max: 4, at: null });
  expect(activity(parentId).some((l) => l.startsWith("Build waiting on #41 — resumes automatically when it is closed · attempt 1 of 4"))).toBe(true);

  expect(await releaseBlockWaits(w.since + 1 * MIN)).toBe(0);
  expect(await releaseBlockWaits(w.since + 31 * MIN)).toBe(0); // the old 30-minute timer is gone; #41 is still open
  // An entry an older build parked with a timer: the timer is ignored, and so
  // is GitHub not answering.
  const run = tasks.get(parentId)!.pipelineRun!;
  tasks.update(parentId, { pipelineRun: { ...run, wait: { ...run.wait!, at: w.since + 30 * MIN } } });
  state = "unknown";
  expect(await releaseBlockWaits(w.since + 40 * MIN)).toBe(0);
  expect(tasks.get(parentId)!.pipelineRun!.wait).toMatchObject({ state: "waiting", attempt: 0 });
  expect(asked.every((n) => n === 41)).toBe(true);

  state = "closed";
  expect(await releaseBlockWaits(w.since + 45 * MIN)).toBe(1); // (the lookup is cached for two minutes)
  await waitFor(() => tasks.get(parentId)?.pipelineRun?.status === "done");
  expect(activity(parentId)).toContain("Resumed Build in its own session to check its block — #41 is closed (automatic retry 1 of 4)");
});

test("a declared transient failure uses the 1/5/15/30 minute backoff; base-branch CI being red waits on the base", async () => {
  const { releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the package registry timed out twice";
  const env = await startBuildReview("blocked");
  const w = (await blockedRun(env.parentId, parked(0))).wait!;
  expect(w).toMatchObject({ category: "environment", source: "text", max: 4 });
  expect(Math.round((w.at! - w.since) / MIN)).toBe(1);
  const { deleteTask } = await import("./orchestrator.ts");
  await deleteTask(env.parentId);

  let red = true;
  blockWaitDeps.pr = (taskId) => ({
    taskId, number: 7, url: "https://example.test/pr/7", state: "open", draft: false, baseRef: "develop", headSha: "abc", unresolvedThreads: 0, checkedAt: Date.now(), behindBy: 0,
    checks: red ? "failure" : "success",
    failingChecks: red ? [{ name: "unit", url: null, alsoOnBase: true }] : [],
  });
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "CI cannot pass until the base branch is fixed";
  const ci = await startBuildReview("blocked-then-Review");
  const c = (await blockedRun(ci.parentId, parked(0))).wait!;
  expect(c).toMatchObject({ category: "dependency", source: "signal", what: "develop's CI", ref: "base-ci" });
  expect(await releaseBlockWaits(c.since + 6 * MIN)).toBe(0);
  red = false;
  expect(await releaseBlockWaits(c.since + 7 * MIN)).toBe(1);
  expect(activity(ci.parentId).some((l) => l.includes("the checks that failed on develop no longer fail there"))).toBe(true);
});

test("the queue doesn't stampede or run into a usage limit: a few resumes a pass, none while a card waits on a limit", async () => {
  const { tasks, preferences } = await import("./db.ts");
  const { releaseBlockWaits } = await import("./pipeline-runner.ts");
  await noJitter();
  preferences.set("blocked_wait", JSON.stringify({ maxPerPass: 2 }));
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  const cards = [await startBuildReview("blocked"), await startBuildReview("blocked"), await startBuildReview("blocked")];
  const ats = await Promise.all(cards.map(async (c) => (await blockedRun(c.parentId, parked(0))).wait!.at!));
  const due = Math.max(...ats) + 1;

  // A fourth card waits for its usage limit to reset: everything holds.
  const limited = await startBuildReview("quota-blocked");
  await blockedRun(limited.parentId, (r) => r.autoRetry?.kind === "quota");
  expect(await releaseBlockWaits(due)).toBe(0);
  const { deleteTask } = await import("./orchestrator.ts");
  await deleteTask(limited.parentId);

  // Three are due; one pass takes two, oldest first.
  expect(await releaseBlockWaits(due)).toBe(2);
  const states = () => cards.map((c) => tasks.get(c.parentId)!.pipelineRun!.wait!);
  await waitFor(() => states().filter((w) => w.state === "waiting" && w.attempt === 1).length === 2);
  expect(states().map((w) => w.attempt)).toEqual([1, 1, 0]);
  expect(await releaseBlockWaits(due)).toBe(1);
});

test("turned off, or with no retries configured, every block is the owner's as before", async () => {
  const { preferences } = await import("./db.ts");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  preferences.set("blocked_wait", JSON.stringify({ enabled: false }));
  const off = await startBuildReview("blocked");
  expect((await blockedRun(off.parentId)).wait).toBeUndefined();

  preferences.set("blocked_wait", JSON.stringify({ unknownBackoffMin: [] }));
  const none = await startBuildReview("blocked");
  const run = await blockedRun(none.parentId, (r) => r.wait != null);
  expect(run.wait).toMatchObject({ state: "escalated", attempt: 0, escalation: "automatic retries are turned off for this kind of block" });
});

test("a usage limit codex reports as an error row is a limit, not a block for the queue; a log line that only quotes the words is not", async () => {
  await noJitter();
  // Codex's `turn.failed` / `error` message lands on stderr as its own row
  // (codex-cli's `UsageLimitReached` text). The step stopped and said so.
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "ran out of usage part-way";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_STDERR = "You've hit your usage limit. Upgrade to Pro or try again at 11:30 PM.";
  const limited = await startBuildReview("blocked-then-Review");
  const run = await blockedRun(limited.parentId, (r) => r.autoRetry != null);
  expect(run.autoRetry).toMatchObject({ kind: "quota", attempt: 1, resume: "handoff" });
  const reset = new Date(run.autoRetry!.at! - 5 * MIN);
  expect([reset.getHours(), reset.getMinutes()]).toEqual([23, 30]);
  expect(run.wait).toBeUndefined();
  expect(run.blocked[0]!.message).toContain("stopped at its usage limit before finishing");

  // A codex log line that quotes a command containing the same words.
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_STDERR = "2031-03-04T15:00:00.000000Z ERROR codex_core::tools::router: error=exec_command failed: Rejected(\"echo You've hit your usage limit.\")";
  const quoted = await startBuildReview("blocked");
  const other = await blockedRun(quoted.parentId, parked(0));
  expect(other.autoRetry).toBeUndefined();
  expect(other.wait).toMatchObject({ category: "unknown" });
});

test("the lease watcher's own retry leaves queued cards to the queue, and never retries a step that says it waits on the owner", async () => {
  const { tasks, preferences } = await import("./db.ts");
  const { autoRetryQueued, leaseWatchTick, listLeases, resetLeaseWatchForTests, LEASE_WATCHERS_PREF } = await import("./lease-watch.ts");
  await noJitter();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-block-wait-wd-"));
  const before = preferences.get(LEASE_WATCHERS_PREF);
  preferences.set(LEASE_WATCHERS_PREF, JSON.stringify([{ project: workdir, label: "rig", command: `echo '{"held": false}'` }]));
  try {
    // Parked by the queue: it declared the rig.
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the rig is busy";
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "resource", waitingRef: "rig" });
    const queued = await startBuildReview("blocked", workdir);
    expect((await blockedRun(queued.parentId, parked(0))).wait).toMatchObject({ category: "resource", ref: "rig" });
    // Says outright that it waits on the owner, and names the rig.
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the rig needs its cable changed";
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "owner" });
    const owners = await startBuildReview("blocked", workdir);
    await blockedRun(owners.parentId);

    await Promise.all(leaseWatchTick());
    await waitFor(() => listLeases().some((l) => l.project === workdir && !l.held && (l.queue?.length ?? 0) === 2));
    expect(await autoRetryQueued()).toBeNull();
    expect(tasks.get(queued.parentId)!.pipelineRun!.wait).toMatchObject({ state: "waiting", attempt: 0 });
    expect(tasks.get(owners.parentId)!.pipelineRun!.status).toBe("blocked");

    // A block left to the owner for its open question that names the rig is
    // still retried once when the rig is free, as the lab queue always did.
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the rig suite did not start";
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING;
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Can the rig suite run on the spare rig?"]);
    const legacy = await startBuildReview("blocked-then-Review", workdir);
    expect((await blockedRun(legacy.parentId)).wait).toBeUndefined();
    await Promise.all(leaseWatchTick(Date.now() + 60_000)); // a pass of the watcher retries the first eligible card in line
    await waitFor(() => tasks.get(legacy.parentId)?.pipelineRun?.status === "done");
    expect(activity(legacy.parentId).some((l) => l.startsWith("The rig is free — retried automatically"))).toBe(true);
    // The two ahead of it in line were passed over.
    expect(tasks.get(queued.parentId)!.pipelineRun!.wait).toMatchObject({ state: "waiting", attempt: 0 });
    expect(activity(owners.parentId).some((l) => l.includes("retried automatically"))).toBe(false);
  } finally {
    preferences.set(LEASE_WATCHERS_PREF, before ?? "[]");
    resetLeaseWatchForTests();
  }
});

test('an exact registered resource await owns completion, without timed retries or duplicate resumes', async()=>{
  const {tasks}=await import('./db.ts');
  const {releaseBlockWaits}=await import('./pipeline-runner.ts');
  const {AWAITS_DIR,awaitTick}=await import('./awaits.ts');
  await noJitter();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON='the registered check has not finished';
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING=JSON.stringify({waitingOn:'resource',waitingRef:'registered-check'});
  const f=await startBuildReview('blocked-then-Review');
  const run=await blockedRun(f.parentId,parked(0));
  const childId=run.active[0]!.taskId,turn=run.history[0]!.turnStartedAt??run.history[0]!.startedAt;
  tasks.update(f.parentId,{worktreePath:f.workdir});
  tasks.update(childId,{worktreePath:f.workdir});
  const record=path.join(AWAITS_DIR,'registered-'+randomUUID());
  mkdirSync(record,{recursive:true});
  for(const [name,value]of Object.entries({label:'registered-check',cwd:f.workdir,cmd:'synthetic check',
    started:String(Math.ceil(turn/1000)),pid:String(process.pid),'resource-state':'waiting',log:'synthetic result\n'}))writeFileSync(path.join(record,name),value);
  const due=run.wait!.at!;
  expect(await releaseBlockWaits(due)).toBe(0);
  expect(tasks.get(f.parentId)!.pipelineRun!.wait).toMatchObject({state:'waiting',attempt:0});
  expect(await awaitTick()).toBe(0);
  writeFileSync(path.join(record,'exit'),'0');
  writeFileSync(path.join(record,'resource-state'),'finished');
  // A completed result also belongs to the notification watcher, not the timer.
  expect(await releaseBlockWaits(due+30*MIN)).toBe(0);
  expect(tasks.get(f.parentId)!.pipelineRun!.wait!.attempt).toBe(0);
  expect(await awaitTick()).toBe(1);
  expect(existsSync(path.join(record,'notified'))).toBe(true);
  expect(await awaitTick()).toBe(0);
  await waitFor(()=>tasks.get(f.parentId)?.pipelineRun?.status==='done');
  expect(tasks.get(f.parentId)!.pipelineRun!.stepCount).toBe(3);
  expect(tasks.get(f.parentId)!.pipelineRun!.history[0]!.taskId).toBe(childId);
});

test("a resume waits for a free step slot like any other step", async () => {
  const { tasks, preferences } = await import("./db.ts");
  const { releaseBlockWaits } = await import("./pipeline-runner.ts");
  const { STEP_SLOTS_PREF } = await import("./step-slots.ts");
  await noJitter();
  const before = preferences.get(STEP_SLOTS_PREF);
  try {
    process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
    const waiting = await startBuildReview("blocked-then-Review");
    const at = (await blockedRun(waiting.parentId, parked(0))).wait!.at!;

    // One slot, and another card's step is using it.
    preferences.set(STEP_SLOTS_PREF, JSON.stringify({ max: 1 }));
    process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
    const busy = await startBuildReview("blocked");
    await waitFor(() => tasks.get(busy.parentId)?.pipelineRun?.status === "running");
    expect(await releaseBlockWaits(at + 1)).toBe(0);
    expect(tasks.get(waiting.parentId)!.pipelineRun!.wait).toMatchObject({ state: "waiting", attempt: 0, at }); // still due, nothing spent

    // That step settles (it parks too, not yet due): the slot is free.
    await blockedRun(busy.parentId, parked(0));
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
    expect(await releaseBlockWaits(at + 1)).toBe(1);
    expect(tasks.get(waiting.parentId)!.pipelineRun!.wait?.attempt ?? 1).toBe(1);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
    preferences.set(STEP_SLOTS_PREF, before ?? "{}");
  }
});

test("a wait on an issue the card filed itself leaves the queue as a stop; a real dependency stays parked", async () => {
  const { tasks } = await import("./db.ts");
  const { releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  await noJitter();
  blockWaitDeps.refState = async () => "open";
  const asked: number[] = [];
  blockWaitDeps.refInfo = async (_project, n) => {
    asked.push(n);
    // #41: an older roadmap task. #42: opened by this card's own Finish during the run.
    return n === 41
      ? { title: "Package the baseline", body: "Needed by #9 and #77.", createdAt: 0 }
      : { title: "Resolve #77 branch conflicts with develop before CI", body: "References: #77.", createdAt: Date.now() };
  };
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "waiting for the follow-up to close";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#41" });
  const real = await startBuildReview("blocked");
  tasks.update(real.parentId, { issueUrl: "https://github.com/o/r/issues/77" });
  const w = (await blockedRun(real.parentId, parked(0))).wait!;
  expect(await releaseBlockWaits(w.since + MIN)).toBe(0);
  expect(tasks.get(real.parentId)!.pipelineRun!.wait).toMatchObject({ state: "waiting", ref: "#41" });

  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#42" });
  const self = await startBuildReview("blocked");
  tasks.update(self.parentId, { issueUrl: "https://github.com/o/r/issues/77" });
  const w2 = (await blockedRun(self.parentId, parked(0))).wait!;
  await releaseBlockWaits(w2.since + MIN);
  const run = tasks.get(self.parentId)!.pipelineRun!;
  expect(run.status).toBe("blocked");
  expect(run.wait == null || run.wait.ref !== "#42" || run.wait.state !== "waiting").toBe(true);
  expect(activity(self.parentId).some((l) => l.startsWith("Build was waiting on #42, an issue opened during this run about this card's own issue — waiting can't clear that"))).toBe(true);
  // The real dependency was looked at once and is not looked at again.
  await releaseBlockWaits(w.since + 10 * MIN);
  expect(asked.filter((n) => n === 41)).toHaveLength(1);
});

test("a wait on a list of bugs the card filed itself (2026-10-15 #846) leaves the queue as a stop", async () => {
  const { tasks } = await import("./db.ts");
  const { releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  await noJitter();
  blockWaitDeps.refState = async () => "open";
  blockWaitDeps.refInfo = async (_project, n) => ({ title: `Bug (from #77): R77-0${n - 50}: a finding`, body: "", createdAt: Date.now() });
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "waiting for the closed-out findings";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#51, #52 and #53" });
  const card = await startBuildReview("blocked");
  tasks.update(card.parentId, { issueUrl: "https://github.com/o/r/issues/77" });
  const w = (await blockedRun(card.parentId, parked(0))).wait!;
  expect(w).toMatchObject({ ref: "#51, #52, #53", at: null });
  await releaseBlockWaits(w.since + MIN);
  expect(activity(card.parentId).some((l) => l.startsWith("Build was waiting on #51, a bug filed from this card — waiting can't clear that"))).toBe(true);
});

test("a card still parked a day later goes to the owner, saying what it waited on", async () => {
  const { tasks } = await import("./db.ts");
  const { releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  await noJitter();
  blockWaitDeps.refState = async () => "open";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the shared parser has to land first";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#41" });
  const { parentId } = await startBuildReview("blocked");
  const w = (await blockedRun(parentId, parked(0))).wait!;
  expect(Math.round((w.deadline - w.since) / (60 * MIN))).toBe(24);
  expect(await releaseBlockWaits(w.deadline + 1)).toBe(0);
  expect(tasks.get(parentId)!.pipelineRun!.wait).toMatchObject({ state: "escalated", attempt: 0, at: null, escalation: "still waiting on #41 after 24h" });
  expect(activity(parentId).some((l) => l.startsWith("Build still waiting on #41 after 24h — left for you (nothing was retried)."))).toBe(true);
});
