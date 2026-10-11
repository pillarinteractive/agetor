import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineRunState } from "../shared/types.ts";

// A step sent back into its own session after it already wrote a handoff is
// judged on what it writes from then on: the earlier handoff is void
// (pipeline-runner.ts `executionAssistantText`, `turnStartedAt`). Same
// bootstrap as pipeline-auto-retry.test.ts. Every reason here is synthetic.
//
// The fake driver's suffixes read left to right, one per turn of the step:
// `quota-blocked-then-missing-then-done` hands off "blocked" at a usage
// limit, then ends a turn with no handoff, then hands off "done".
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-stale-handoff-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const ENV = ["AGETOR_FAKE_CLAUDE_BLOCKED_REASON", "AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS"];
let parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  const { resetBlockWaitsForTests, stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  resetBlockWaitsForTests();
  stopPipelineAutoRetryTimers();
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) {
    if (!tasks.get(id)) continue;
    tasks.update(id, { worktreePath: null });
    await deleteTask(id).catch(() => {});
  }
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

/** A one-step pipeline (Build) whose turns do `suffix`, started. */
async function startBuild(suffix: string) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({
    name: `stale-handoff-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const build = newStep({ name: "Build", agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const pipeline = pipelines.insert({ name: `stale-handoff-${randomUUID()}`, graph: { steps: [build], edges: [], startStepId: build.id }, maxSteps: 25 });
  const created = await createTask({ title: "stale handoff", prompt: "goal", workdir: mkdtempSync(path.join(tmpdir(), "agetor-stale-handoff-wd-")), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, stepId: build.id };
}

async function runWhen(parentId: string, pred: (run: PipelineRunState) => boolean): Promise<PipelineRunState> {
  const { tasks } = await import("./db.ts");
  return waitFor(() => {
    const run = tasks.get(parentId)?.pipelineRun;
    return run && pred(run) ? run : undefined;
  });
}
const blocked = (run: PipelineRunState) => run.status === "blocked";
const done = (run: PipelineRunState) => run.status === "done";

// db.ts captures the data dir of whichever test file loaded it first.
const { dataDir } = await import("./db.ts");
const activity = (id: string): string[] => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
};

/** An agetor-await record for a command still running in `cwd`. */
async function startAwait(cwd: string): Promise<string> {
  const { AWAITS_DIR } = await import("./awaits.ts");
  const dir = path.join(AWAITS_DIR, `stale-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "label"), "full suite");
  writeFileSync(path.join(dir, "cwd"), cwd);
  writeFileSync(path.join(dir, "cmd"), "make verify ");
  writeFileSync(path.join(dir, "started"), String(Math.floor(Date.now() / 1000)));
  writeFileSync(path.join(dir, "pid"), String(process.pid));
  writeFileSync(path.join(dir, "log"), "ok\n");
  return dir;
}

test("resumed after a usage limit, a step that ends its turn on a running agetor-await is parked and woken — not settled on its pre-limit blocked handoff", async () => {
  const { tasks } = await import("./db.ts");
  const { fireAutoRetry } = await import("./pipeline-runner.ts");
  const { awaitTick } = await import("./awaits.ts");
  const { parentId, stepId } = await startBuild("quota-blocked-then-missing-then-done");
  const stopped = await runWhen(parentId, (r) => blocked(r) && r.autoRetry?.at != null);
  expect(stopped.history[0]).toMatchObject({ responseKind: "handoff-blocked" });
  expect(stopped.history[0]!.handoff).toMatchObject({ status: "blocked" });
  expect(stopped.autoRetry).toMatchObject({ kind: "quota", resume: "handoff" });
  const stepTaskId = stopped.active[0]!.taskId;

  // The limit resets. The resumed turn finishes the work, starts its
  // verification with agetor-await and ends the turn to wait for it.
  const worktree = mkdtempSync(path.join(tmpdir(), "agetor-stale-handoff-wt-"));
  tasks.update(parentId, { worktreePath: worktree });
  const record = await startAwait(worktree);
  expect(await fireAutoRetry(parentId, stopped.autoRetry!.at!)).toBe(true);

  const parked = await runWhen(parentId, (r) => r.blocked.some((b) => b.kind === "await"));
  expect(parked.blocked).toHaveLength(1);
  expect(parked.blocked[0]).toMatchObject({ kind: "await", taskId: stepTaskId, stepId });
  expect(parked.status).toBe("running");
  // The handoff from before the resume is gone from the record, and the
  // turn was not answered with a "you forgot the handoff" reminder.
  expect(parked.history[0]).toMatchObject({ responseKind: "handoff-missing", handoff: null, outcome: null });
  expect(parked.history[0]!.reminder ?? null).toBeNull();
  expect(activity(parentId).some((l) => l.includes('handed off "blocked"'))).toBe(false);

  // Still running: nothing to tell it yet.
  expect(await awaitTick()).toBe(0);
  // The command exits: the step is woken with the result and hands off.
  writeFileSync(path.join(record, "exit"), "0");
  expect(await awaitTick()).toBe(1);
  expect(existsSync(path.join(record, "notified"))).toBe(true);
  const finished = await runWhen(parentId, done);
  expect(finished.history[0]).toMatchObject({ taskId: stepTaskId, outcome: "succeeded", responseKind: "handoff" });
  expect(finished.history[0]!.handoff).toMatchObject({ status: "done" });
  expect(activity(parentId).some((l) => l === '"full suite" passed — woke Build to carry on')).toBe(true);
});

test("resumed after a usage limit, a turn with no handoff and nothing awaited gets the one reminder", async () => {
  const { fireAutoRetry } = await import("./pipeline-runner.ts");
  const { parentId } = await startBuild("quota-blocked-then-missing-then-done");
  const stopped = await runWhen(parentId, (r) => blocked(r) && r.autoRetry?.at != null);
  expect(await fireAutoRetry(parentId, stopped.autoRetry!.at!)).toBe(true);
  const finished = await runWhen(parentId, done);
  expect(finished.history[0]).toMatchObject({ outcome: "succeeded", responseKind: "handoff" });
  expect(finished.history[0]!.reminder).toMatchObject({ reason: "handoff-missing", delivered: true });
  expect(finished.history[0]!.handoff).toMatchObject({ status: "done" });
  expect(activity(parentId).some((l) => l.includes('handed off "blocked"'))).toBe(false);
});

test("after the handoff reminder, a reply with no handoff is 'missing' — the invalid block from before the reminder is not read again", async () => {
  const { parentId } = await startBuild("invalid-then-missing");
  const run = await runWhen(parentId, blocked);
  expect(run.history[0]!.reminder).toMatchObject({ reason: "handoff-invalid", delivered: true });
  expect(run.history[0]).toMatchObject({ responseKind: "handoff-missing" });
  expect(run.blocked[0]).toMatchObject({ kind: "handoff-missing" });
  expect(run.blocked[0]!.message).toContain("never emitted a <handoff> block");
});

test("a message sent to a blocked step: its reply is what counts, not the blocked handoff it wrote before", async () => {
  const { tasks } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Which of the two layouts should this use?"]);
  const { parentId } = await startBuild("blocked-then-missing-then-done");
  const held = await runWhen(parentId, blocked);
  expect(held.blocked[0]).toMatchObject({ kind: "step-blocked" });
  expect(held.wait).toBeUndefined(); // it asked the owner: theirs
  const stepRunId = tasks.get(held.active[0]!.taskId)!.runId!;
  expect((await sendInput(stepRunId, "Use the first layout.")).delivered).toBe(true);
  // The reply had no handoff: reminded once, then it hands off "done".
  const finished = await runWhen(parentId, done);
  expect(finished.history[0]).toMatchObject({ outcome: "succeeded", responseKind: "handoff" });
  expect(finished.history[0]!.reminder).toMatchObject({ reason: "handoff-missing" });
  expect(activity(parentId).filter((l) => l.includes('reported it is blocked') || l.includes('handed off "blocked"')).length).toBeLessThanOrEqual(1);
});

test("a Retry (the lease watcher's too) starts the step again: the new session's reply counts, not the old blocked handoff", async () => {
  const { retryPipelineStep } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Which of the two layouts should this use?"]);
  const { parentId } = await startBuild("blocked-then-missing-then-done");
  const held = await runWhen(parentId, blocked);
  expect(held.history[0]!.handoff).toMatchObject({ status: "blocked" });
  const retried = await retryPipelineStep(parentId);
  expect("task" in retried).toBe(true);
  const finished = await runWhen(parentId, done);
  expect(finished.history[0]).toMatchObject({ outcome: "succeeded", responseKind: "handoff" });
  expect(finished.history[0]!.reminder).toMatchObject({ reason: "handoff-missing" });
});

test("a step resumed by the wait queue that ends its turn without a handoff is not parked again on its old block", async () => {
  const { blockWaitDeps, releaseBlockWaits } = await import("./pipeline-runner.ts");
  blockWaitDeps.rng = () => 0;
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the fixture service did not come up";
  const { parentId } = await startBuild("blocked-then-missing-then-done");
  const parked = await runWhen(parentId, (r) => blocked(r) && r.wait?.state === "waiting");
  expect(await releaseBlockWaits(parked.wait!.at! + 1)).toBe(1);
  const finished = await runWhen(parentId, done);
  expect(finished.history[0]).toMatchObject({ outcome: "succeeded", responseKind: "handoff" });
  expect(finished.history[0]!.reminder).toMatchObject({ reason: "handoff-missing" });
  expect(finished.wait).toBeUndefined();
  // One resume was spent, not a second one on the stale reason.
  expect(activity(parentId).filter((l) => l.startsWith("Resumed Build in its own session to check its block")).length).toBe(1);
});
