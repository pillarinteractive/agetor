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

const ERROR_ENV = ["AGETOR_FAKE_CLAUDE_API_ERROR", "AGETOR_FAKE_CLAUDE_API_ERROR_TEXT", "AGETOR_FAKE_CLAUDE_API_ERROR_STATUS"];
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
