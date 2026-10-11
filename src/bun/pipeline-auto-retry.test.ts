import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// Automatic retries of steps stopped by a usage limit or a transient failure
// (pipeline-runner.ts `scheduleAutoRetry`). Same bootstrap as
// pipeline-runner.test.ts: data dir + fake claude driver before db.ts loads.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-auto-retry-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const ERROR_ENV = ["AGETOR_FAKE_CLAUDE_API_ERROR", "AGETOR_FAKE_CLAUDE_API_ERROR_TEXT", "AGETOR_FAKE_CLAUDE_API_ERROR_STATUS", "AGETOR_FAKE_CLAUDE_API_ERROR_AFTER_WORK"];
let parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  for (const k of ERROR_ENV) delete process.env[k];
  const { stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  stopPipelineAutoRetryTimers();
  const { tasks } = await import("./db.ts");
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

/** A one-step pipeline (A) whose step hands off with `suffix`, started. */
async function startOneStep(suffix: string) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({
    name: `auto-retry-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const A = newStep({ name: "Build", agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const pipeline = pipelines.insert({ name: `auto-retry-${randomUUID()}`, graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
  const created = await createTask({ title: "auto retry", prompt: "goal", workdir: mkdtempSync(path.join(tmpdir(), "agetor-auto-retry-wd-")), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, stepId: A.id };
}

// db.ts captures the data dir of whichever test file loaded it first.
const { dataDir } = await import("./db.ts");
const activity = (id: string): string[] => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
};

test("a claude session limit at turn start waits for the reset, survives a restart, then retries in place", async () => {
  const { tasks } = await import("./db.ts");
  const { fireAutoRetry, rearmPipelineAutoRetries, stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  const { holdsAutopilotSlot, waitingOnQuota } = await import("../shared/autopilot.ts");
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_TEXT = "You've hit your session limit · resets 11:30pm (America/Chicago)";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_STATUS = "429";
  const { parentId, stepId } = await startOneStep("done");

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.autoRetry ? t : undefined;
  });
  const r = blocked.pipelineRun!.autoRetry!;
  expect(r).toMatchObject({ stepId, kind: "quota", attempt: 1 });
  // 11:30pm local (today or tomorrow) + the 5-minute margin.
  const reset = new Date(r.at! - 5 * 60_000);
  expect([reset.getHours(), reset.getMinutes()]).toEqual([23, 30]);
  expect(blocked.pipelineRun!.blocked[0]!.message).toContain("hit a usage limit — You've hit your session limit");
  expect(activity(parentId).some((l) => l.includes("waiting on a usage limit") && l.includes("retrying automatically at"))).toBe(true);
  // Not progressing: no Autopilot slot.
  expect(waitingOnQuota(blocked.pipelineRun)).toBe(true);
  expect(holdsAutopilotSlot({ ...blocked, column: "running" })).toBe(false);

  // A core restart loses the timer; the persisted schedule re-arms it.
  stopPipelineAutoRetryTimers();
  expect(rearmPipelineAutoRetries()).toBe(1);
  stopPipelineAutoRetryTimers();

  // The limit has reset: the retry relaunches the same step, which now works.
  for (const k of ERROR_ENV) delete process.env[k];
  expect(await fireAutoRetry(parentId, r.at!)).toBe(true);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.pipelineRun!.autoRetry).toBeUndefined(); // the step got through: count reset
  expect(tasks.stepsForParent(parentId).length).toBe(1); // retried in place, not a new card/step
});

test("a stale timer (rescheduled, or Stopped) never fires", async () => {
  const { tasks } = await import("./db.ts");
  const { fireAutoRetry, cancelPipelineRun } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_TEXT = "You've hit your usage limit. Try again later.";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_STATUS = "429";
  const { parentId } = await startOneStep("done");
  const t = await waitFor(() => tasks.get(parentId)?.pipelineRun?.autoRetry ? tasks.get(parentId) : undefined);
  const at = t!.pipelineRun!.autoRetry!.at!;
  // No reset time given: the first backoff is 15 minutes.
  expect(at - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(await fireAutoRetry(parentId, at - 1)).toBe(false);
  // Stop on a card that's only waiting cancels the retry.
  const stopped = await cancelPipelineRun(parentId);
  expect("task" in stopped).toBe(true);
  expect(tasks.get(parentId)!.pipelineRun!.autoRetry!.at).toBeNull();
  expect(await fireAutoRetry(parentId, at)).toBe(false);
  expect(tasks.get(parentId)!.pipelineRun!.status).toBe("blocked");
});

test("an interrupted step retries after boot without becoming running before a worker starts", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { fireAutoRetry, stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  const { parentId } = await startOneStep("done");
  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.autoRetry ? t : undefined;
  });
  stopPipelineAutoRetryTimers();
  const run = blocked.pipelineRun!;
  const execution = run.active[0]!;
  const previous = runs.listForTask(execution.taskId)[0]!;
  // Boot reconciles a missing worker this way: the execution remains for
  // retry, but its run is orphaned and there is no ordinary blocked entry.
  runs.update(previous.id, { status: "orphaned", endedAt: Date.now(), exitCode: -1 });
  tasks.update(execution.taskId, { column: "ready", runId: null });
  run.status = "cancelled";
  run.blocked = [];
  run.endedAt = Date.now();
  run.history.at(-1)!.outcome = "cancelled";
  run.history.at(-1)!.endedAt = run.endedAt;
  run.autoRetry = { ...run.autoRetry!, reason: "lost its session" };
  tasks.setPipelineRun(parentId, run);
  const at = run.autoRetry.at!;
  for (const k of ERROR_ENV) delete process.env[k];

  expect(await fireAutoRetry(parentId, at)).toBe(true);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(runs.listForTask(execution.taskId).length).toBe(2);
  expect(tasks.stepsForParent(parentId).map((t) => t.id)).toEqual([execution.taskId]);
  expect(done.pipelineRun!.stepCount).toBe(run.stepCount);
  expect(done.pipelineRun!.autoRetry).toBeUndefined();
});

test("transient failures retry with backoff up to 4 times, then stay blocked for the user", async () => {
  const { tasks } = await import("./db.ts");
  const { fireAutoRetry } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1"; // 529 Overloaded
  const { parentId } = await startOneStep("done");
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const t = await waitFor(() => {
      const r = tasks.get(parentId)?.pipelineRun?.autoRetry;
      return r && r.attempt === attempt && tasks.get(parentId)?.pipelineRun?.status === "blocked" ? r : undefined;
    });
    expect(t.kind).toBe("transient");
    if (attempt === 5) {
      expect(t.at).toBeNull();
      break;
    }
    delays.push(Math.round((t.at! - Date.now()) / 60_000));
    expect(await fireAutoRetry(parentId, t.at!)).toBe(true);
  }
  expect(delays).toEqual([1, 5, 15, 30]);
  expect(activity(parentId).some((l) => l.includes("left for you after 4 automatic retries"))).toBe(true);
});

test("a step that stopped for claude's usage-limit grace window retries at the reset; a real block doesn't", async () => {
  const { tasks } = await import("./db.ts");
  const quota = await startOneStep("quota-blocked");
  const q = await waitFor(() => {
    const t = tasks.get(quota.parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(q.pipelineRun!.blocked[0]!.kind).toBe("step-blocked");
  expect(q.pipelineRun!.autoRetry).toMatchObject({ kind: "quota", attempt: 1 });
  const reset = new Date(q.pipelineRun!.autoRetry!.at! - 5 * 60_000);
  expect([reset.getHours(), reset.getMinutes()]).toEqual([23, 30]);

  const real = await startOneStep("blocked");
  const b = await waitFor(() => {
    const t = tasks.get(real.parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(b.pipelineRun!.blocked[0]!.kind).toBe("step-blocked");
  expect(b.pipelineRun!.autoRetry).toBeUndefined();
});

// --- An unfinished step is never handed to the next one ---------------------
//
// The live shape (four cards, one evening): Build → Review is Build's only
// edge, so its contract says `set "next" to "Review"`. Claude's usage-limit
// grace note arrives mid-work; Build stops, hands off `blocked` WITH
// `next: "Review"` as instructed, and claude prints when it will continue.
// The run used to read that `next` as a routing choice and start Review on
// half-done work. Fixture text is synthetic.

/** Build → Review (Build's sole, unlabeled edge); Review → Build "changes
 *  requested" / → Finish "approved". Started. */
async function startBuildReview(buildSuffix: string, reviewSuffix = "Finish") {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({
    name: `auto-retry-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, suffix: string) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const build = step("Build", buildSuffix);
  const review = step("Review", reviewSuffix);
  const finish = step("Finish", "done");
  const pipeline = pipelines.insert({
    name: `auto-retry-${randomUUID()}`,
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
  const created = await createTask({ title: "unfinished build", prompt: "goal", workdir: mkdtempSync(path.join(tmpdir(), "agetor-auto-retry-wd-")), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, review, finish };
}

const blockedRun = async (parentId: string) => {
  const { tasks } = await import("./db.ts");
  return waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t.pipelineRun : undefined;
  });
};

test("Build stopped by a usage limit with next: \"Review\" resumes Build in its own session and never starts Review on unfinished work", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { fireAutoRetry } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT = "Review";
  try {
    const { parentId, build, review } = await startBuildReview("quota-blocked-then-Review");
    const run = await blockedRun(parentId);

    // Parked on Build: Review was never launched.
    expect(run.active.map((a) => a.stepId)).toEqual([build.id]);
    expect(run.history.map((h) => h.stepId)).toEqual([build.id]);
    expect(run.history[0]).toMatchObject({ responseKind: "handoff-blocked", outcome: null, nextStepIds: [] });
    expect(run.history[0]!.handoff).toMatchObject({ status: "blocked", next: "Review" });
    expect(run.blocked[0]).toMatchObject({ kind: "step-blocked", stepId: build.id });
    expect(run.blocked[0]!.message).toContain("stopped at its usage limit before finishing");
    // The quota wait applies to that same step, as a resume.
    expect(run.autoRetry).toMatchObject({ stepId: build.id, kind: "quota", attempt: 1, resume: "handoff" });
    const reset = new Date(run.autoRetry!.at! - 5 * 60_000);
    expect([reset.getHours(), reset.getMinutes()]).toEqual([23, 30]);
    // The timeline says what happened.
    const lines = activity(parentId);
    expect(lines.some((l) => /^Build stopped at its usage limit before finishing — resuming it at .+ instead of handing unfinished work to Review$/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("following its choice"))).toBe(false);

    // The limit resets: Build continues in the SAME step task, as a follow-up
    // turn carrying the resume note — not a relaunch from its first prompt.
    const buildTaskId = run.active[0]!.taskId;
    expect(await fireAutoRetry(parentId, run.autoRetry!.at!)).toBe(true);
    const done = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" ? t.pipelineRun : undefined;
    });
    // Build finished on its second turn, and only then did Review run.
    expect(done.history.map((h) => h.stepId)).toEqual([build.id, review.id, done.history[2]!.stepId]);
    expect(done.history[0]).toMatchObject({ taskId: buildTaskId, outcome: "succeeded", responseKind: "handoff", nextStepIds: [review.id] });
    expect(done.history[0]!.handoff!.status).toBe("done");
    expect(done.autoRetry).toBeUndefined();
    const buildRuns = runs.listForTask(buildTaskId);
    const userTurns = buildRuns.flatMap((r) => runs.events(r.id)).filter((e) => e.stream === "user").map((e) => e.data);
    expect(userTurns.some((u) => u.includes("The usage limit that stopped you has reset") && u.includes("your earlier blocked handoff is void"))).toBe(true);
    expect(activity(parentId).some((l) => l.includes("Build's usage limit has reset — resumed it in the same session"))).toBe(true);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT;
  }
});

test("a blocked handoff on a step's only edge holds the run on that step (Needs you), even though it names the next step", async () => {
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT = "Review";
  try {
    const { parentId, build } = await startBuildReview("blocked");
    const run = await blockedRun(parentId);
    expect(run.active.map((a) => a.stepId)).toEqual([build.id]);
    expect(run.history.length).toBe(1);
    expect(run.blocked[0]).toMatchObject({ kind: "step-blocked", stepId: build.id });
    expect(run.blocked[0]!.message).toContain('step "Build" reported it is blocked: needs a product decision');
    expect(run.autoRetry).toBeUndefined(); // a real block is a person's call, not a retry
    expect(activity(parentId)).toContain('Build handed off "blocked" with its work unfinished — holding the run on Build instead of starting Review');
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT;
  }
});

test("a step with a real choice still routes a blocked handoff — unless the turn hit a usage limit", async () => {
  const { tasks } = await import("./db.ts");
  // Review may send the work back or on. Blocked + "changes requested" is a
  // decision about who fixes it: Build runs again.
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT = "changes requested";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "A correctness defect remains; Build should fix the failing scenario.";
  try {
    const routed = await startBuildReview("Review", "blocked-then-Finish");
    await waitFor(() => (tasks.get(routed.parentId)?.pipelineRun?.history.length ?? 0) >= 3);
    const h = tasks.get(routed.parentId)!.pipelineRun!.history;
    expect(h.slice(0, 3).map((x) => x.stepId)).toEqual([routed.build.id, routed.review.id, routed.build.id]);
    expect(h[1]).toMatchObject({ responseKind: "handoff-blocked", outcome: "succeeded", nextStepIds: [routed.build.id] });
    expect(activity(routed.parentId)).toContain('Review reported a problem and handed it to "changes requested" — following its choice');

    // The same handoff from a Review that ran out of usage is not a decision.
    const limited = await startBuildReview("Review", "quota-blocked");
    const run = await blockedRun(limited.parentId);
    expect(run.active.map((a) => a.stepId)).toEqual([limited.review.id]);
    expect(run.history.map((x) => x.stepId)).toEqual([limited.build.id, limited.review.id]);
    expect(run.autoRetry).toMatchObject({ stepId: limited.review.id, kind: "quota", resume: "handoff" });
    expect(activity(limited.parentId).some((l) => l.startsWith("Review stopped at its usage limit before finishing — resuming it at ") && l.endsWith("instead of handing unfinished work to Build"))).toBe(true);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT;
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON;
  }
});

test("a target-code security finding automatically returns Review to Build without treating it as an agent permission hold", async () => {
  const { tasks } = await import("./db.ts");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT = "changes requested";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "Changes requested: callers are not authorized yet access succeeds.";
  try {
    const routed = await startBuildReview("Review", "blocked-then-Finish");
    await waitFor(() => (tasks.get(routed.parentId)?.pipelineRun?.history.length ?? 0) >= 3);
    const run = tasks.get(routed.parentId)!.pipelineRun!;
    expect(run.history.slice(0, 3).map((h) => h.stepId)).toEqual([routed.build.id, routed.review.id, routed.build.id]);
    expect(run.history[1]).toMatchObject({ outcome: "succeeded", nextStepIds: [routed.build.id] });
    expect(run.wait ?? null).toBeNull();
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT;
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON;
  }
});

test("a contradictory blocked approval never starts Finish with unresolved acceptance findings", async () => {
  const { tasks } = await import("./db.ts");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT = "approved";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "Critical tenant-isolation failure remains; AC1 fails.";
  try {
    const { parentId, review, finish } = await startBuildReview("Review", "blocked");
    const run = await blockedRun(parentId);
    expect(run.history.some((h) => h.stepId === finish.id)).toBe(false);
    expect(run.active.map((a) => a.stepId)).toEqual([review.id]);
    expect(run.history[1]!.handoff).toMatchObject({ status: "blocked", next: "approved" });
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_NEXT;
    delete process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON;
  }
});

test("a usage limit that cuts a turn off mid-work resumes that session; one hit before any work relaunches", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { fireAutoRetry } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_TEXT = "You've hit your usage limit. Try again at 11:30 PM.";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_STATUS = "429";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_AFTER_WORK = "1";
  const { parentId, build, review } = await startBuildReview("Review");
  const run = await blockedRun(parentId);
  expect(run.history.map((h) => h.stepId)).toEqual([build.id]);
  expect(run.history[0]).toMatchObject({ outcome: "failed", responseKind: "error" });
  expect(run.autoRetry).toMatchObject({ stepId: build.id, kind: "quota", resume: "cut-off" });
  expect(activity(parentId).some((l) => l.startsWith("Build stopped at its usage limit before finishing — resuming it at "))).toBe(true);

  for (const k of ERROR_ENV) delete process.env[k];
  const buildTaskId = run.active[0]!.taskId;
  expect(await fireAutoRetry(parentId, run.autoRetry!.at!)).toBe(true);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t.pipelineRun : undefined;
  });
  expect(done.history.slice(0, 2).map((h) => [h.stepId, h.taskId === buildTaskId])).toEqual([[build.id, true], [review.id, false]]);
  const userTurns = runs.listForTask(buildTaskId).flatMap((r) => runs.events(r.id)).filter((e) => e.stream === "user").map((e) => e.data);
  expect(userTurns.some((u) => u.startsWith('The usage limit that cut off your turn on step "Build" has reset.'))).toBe(true);

  // Hit at the very start of the turn (nothing done yet): no `resume` — the
  // step is simply started again, as before.
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_TEXT = "You've hit your usage limit. Try again at 11:30 PM.";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR_STATUS = "429";
  const fresh = await startBuildReview("Review");
  const atStart = await blockedRun(fresh.parentId);
  expect(atStart.autoRetry).toMatchObject({ kind: "quota" });
  expect(atStart.autoRetry!.resume).toBeUndefined();
  expect(activity(fresh.parentId).some((l) => l.includes("Build is waiting on a usage limit") && l.includes("retrying automatically at"))).toBe(true);
});
