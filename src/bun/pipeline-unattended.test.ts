import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// What an unattended board (the planner-recommendation policy) does with the
// two stops that need no person: a step that ended without a handoff, and a
// run that reached its step cap. Same bootstrap as pipeline-auto-retry.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-unattended-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  const { stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  stopPipelineAutoRetryTimers();
  const { tasks, preferences } = await import("./db.ts");
  const { PIPELINE_DECISIONS_PREF } = await import("../shared/pipeline-decisions.ts");
  preferences.set(PIPELINE_DECISIONS_PREF, "null");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
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

/** Start a pipeline of `names` steps in a cycle (one step: no edge), each handing off with `suffix`. */
async function start(names: string[], suffix: string, maxSteps: number, unattended: boolean) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines, preferences } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { PIPELINE_DECISIONS_PREF } = await import("../shared/pipeline-decisions.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-unattended-wd-"));
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: "planner-recommendation", projects: unattended ? [workdir] : [] }));
  const profile = agentProfiles.insert({
    name: `unattended-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const steps = names.map((name) => newStep({ name, agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` }));
  const edges = steps.length > 1 ? steps.map((s, i) => ({ id: `e${i}`, from: s.id, to: steps[(i + 1) % steps.length]!.id, label: "" })) : [];
  const pipeline = pipelines.insert({ name: `unattended-${randomUUID()}`, graph: { steps, edges, startStepId: steps[0]!.id }, maxSteps });
  const created = await createTask({ title: "unattended", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, stepIds: steps.map((s) => s.id) };
}

const blockedRun = async (parentId: string) => {
  const { tasks } = await import("./db.ts");
  return (await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  })).pipelineRun!;
};

test("unattended: the step cap extends itself once, then waits for a person", async () => {
  const { AUTO_CAP_EXTENSIONS } = await import("./pipeline-runner.ts");
  const { parentId } = await start(["A", "B"], "done", 2, true);
  const run = await blockedRun(parentId);
  expect(AUTO_CAP_EXTENSIONS).toBe(1);
  expect(run.capExtensions).toBe(1);
  // 2 → 4 steps, then the loop is left for someone.
  expect(run.stepCount).toBe(4);
  expect(run.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  expect(activity(parentId).filter((l) => l.includes("continuing automatically up to")).length).toBe(1);
});

test("attended: the step cap still blocks at the cap", async () => {
  const { parentId } = await start(["A", "B"], "done", 2, false);
  const run = await blockedRun(parentId);
  expect(run.stepCount).toBe(2);
  expect(run.capExtensions ?? 0).toBe(0);
  expect(run.blocked.some((b) => b.kind === "step-cap")).toBe(true);
});

test("unattended: a step that never hands off is scheduled to start again", async () => {
  const { parentId, stepIds } = await start(["Build"], "missing", 25, true);
  const run = await blockedRun(parentId);
  expect(run.blocked.some((b) => b.kind === "handoff-missing" && b.message.startsWith("still no valid handoff after one reminder"))).toBe(true);
  expect(run.autoRetry).toMatchObject({ stepId: stepIds[0], kind: "transient", attempt: 1 });
  expect(run.autoRetry!.at).toBeGreaterThan(Date.now());
  expect(activity(parentId).some((l) => l.includes("ended without a handoff") && l.includes("retrying automatically at"))).toBe(true);
});

test("attended: a step that never hands off waits for a person", async () => {
  const { parentId } = await start(["Build"], "missing", 25, false);
  const run = await blockedRun(parentId);
  expect(run.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);
  expect(run.autoRetry ?? null).toBeNull();
});
