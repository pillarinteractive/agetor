import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// An edge with `maxTraversals` is a bounded corrective loop: the run holds
// for a person when a step chooses it once more. Same bootstrap as
// pipeline-unattended.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-edge-cap-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let parents: string[] = [];

// Other test files leave step rows behind in this shared process; without
// room of its own a "Finish" step here would queue behind them.
const SLOTS = JSON.stringify({ max: 200, heavy: { max: 200, steps: [] }, ci: { max: 200, exempt: [] } });
let slotsBefore: string | null = null;

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
  const { preferences } = await import("./db.ts");
  const { STEP_SLOTS_PREF } = await import("./step-slots.ts");
  slotsBefore = preferences.get(STEP_SLOTS_PREF) ?? null;
  preferences.set(STEP_SLOTS_PREF, SLOTS);
});

afterEach(async () => {
  const { stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  stopPipelineAutoRetryTimers();
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
  const { preferences } = await import("./db.ts");
  const { STEP_SLOTS_PREF } = await import("./step-slots.ts");
  preferences.set(STEP_SLOTS_PREF, slotsBefore ?? "");
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const { dataDir } = await import("./db.ts");
const activity = (id: string): string[] => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
};

/** Build → Review → Finish, where Finish always chooses "verification failed" (back to Build). */
async function start(maxTraversals: number | undefined) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-edge-cap-wd-"));
  const profile = agentProfiles.insert({
    name: `edge-cap-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, next: string) => newStep({ name, agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${next}` });
  const build = step("Build", "Review"), review = step("Review", "Finish"), finish = { ...step("Finish", "Build"), canFinish: true };
  const graph = {
    steps: [build, review, finish],
    edges: [
      { id: "build-review", from: build.id, to: review.id, label: "" },
      { id: "review-build", from: review.id, to: build.id, label: "changes requested" },
      { id: "review-finish", from: review.id, to: finish.id, label: "approved" },
      { id: "finish-build", from: finish.id, to: build.id, label: "verification failed", ...(maxTraversals !== undefined ? { maxTraversals } : {}) },
    ],
    startStepId: build.id,
  };
  const pipeline = pipelines.insert({ name: `edge-cap-${randomUUID()}`, graph, maxSteps: 9 });
  const created = await createTask({ title: "edge cap", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, finish };
}

const blockedRun = async (parentId: string) => {
  const { tasks } = await import("./db.ts");
  return (await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  })).pipelineRun!;
};

test("the edge is taken maxTraversals times, then the step's choice is held for a person, who can still Advance it", async () => {
  const { tasks } = await import("./db.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");
  const { parentId, build, finish } = await start(1);
  const run = await blockedRun(parentId);
  // Build, Review, Finish → Build, Review, Finish (held): one corrective round.
  expect(run.stepCount).toBe(6);
  expect(run.snapshot!.graph.edges.find((e) => e.id === "finish-build")!.maxTraversals).toBe(1);
  const block = run.blocked.find((b) => b.kind === "step-blocked")!;
  expect(block.stepId).toBe(finish.id);
  expect(block.taskId).not.toBeNull();
  expect(block.message).toContain('chose "verification failed" again, but this run has already taken that route 1 of 1 times');
  // The held choice is on record, with no route taken.
  const last = run.history.at(-1)!;
  expect(last.outcome).toBeNull();
  expect(last.handoff?.next).toBe("Build");
  expect(activity(parentId).some((l) => l.includes('Finish → Build ("verification failed") reached its limit of 1 — waiting for you'))).toBe(true);

  // The owner decides to go round once more.
  const advanced = await advancePipeline(parentId, { nextStepIds: [build.id] });
  expect("error" in advanced).toBe(false);
  await waitFor(() => (tasks.get(parentId)!.pipelineRun!.stepCount >= 7 ? true : null));
});

test("without maxTraversals the same loop runs to the step cap, as before", async () => {
  const { parentId } = await start(undefined);
  const run = await blockedRun(parentId);
  expect(run.stepCount).toBe(9);
  expect(run.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  expect(run.blocked.some((b) => b.kind === "step-blocked")).toBe(false);
});
