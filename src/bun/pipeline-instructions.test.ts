import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-instructions-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
const parents: string[] = [];

beforeAll(async () => (await import("./pipeline-runner.ts")).initPipelineRunner());
afterEach(async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  const { stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  stopPipelineAutoRetryTimers();
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents.splice(0)) await deleteTask(id);
});
afterAll(async () => {
  await Bun.sleep(150);
  rmTestDataDir(DATA_DIR);
});
async function until<T>(fn: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("fixture did not settle");
    await Bun.sleep(15);
  }
}
async function fixture(slow = false, suffix = "blocked") {
  const { agentProfiles, pipelines, tasks } = await import("./db.ts");
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: marker } = await import("./agents.ts");
  const profile = agentProfiles.insert({ name: randomUUID(), harness: "claude-code", model: "fake-model", effort: null,
    mode: null, fast: false, maxMode: false, instructions: "Original profile permissions", skills: [] });
  const step = newStep({ name: "Review", agentProfileId: profile.id,
    instructions: `Old owner checkpoint. ${marker}:${suffix}` });
  const pipeline = pipelines.insert({ name: randomUUID(), graph: { steps: [step], edges: [], startStepId: step.id }, maxSteps: 14 });
  const created = await createTask({ title: "instruction update", prompt: "Preserve every acceptance criterion", isolation: "none",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-instructions-wd-")), pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  if (slow) process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "500";
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  const parent = await until(() => {
    const t = tasks.get(created.task.id);
    return t?.pipelineRun?.status === (slow ? "running" : "blocked") ? t : undefined;
  });
  const graph = { ...pipeline.graph, steps: [{ ...step, instructions: `Repair the verified defects; no routine owner checkpoint. ${marker}:done` }] };
  const template = pipelines.update(pipeline.id, { graph, maxSteps: 99 })!;
  return { parent, template, step };
}

test("instruction refresh preserves history/holds/profiles/caps, starts no agent, and the stopped step's retry uses the new instructions", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { refreshPipelineInstructions, retryPipelineStep, pipelineRunsDir } = await import("./pipeline-runner.ts");
  const { parent, template, step } = await fixture();
  const before = parent.pipelineRun!;
  const childId = before.active[0]!.taskId;
  const oldPrompt = tasks.get(childId)!.prompt;
  const result = await refreshPipelineInstructions(parent.id, {
    expectedCapturedAt: before.snapshot!.capturedAt, expectedTemplateUpdatedAt: template.updatedAt,
  });
  if ("error" in result) throw new Error(result.error);
  expect(result.stepIds).toEqual([step.id]);
  const after = result.task.pipelineRun!;
  expect({ ...after, snapshot: before.snapshot }).toEqual(before);
  expect(after.snapshot!.profiles).toEqual(before.snapshot!.profiles);
  expect(after.snapshot!.maxSteps).toBe(14);
  expect(after.snapshot!.capturedAt).toBeGreaterThan(before.snapshot!.capturedAt);
  expect(runs.listForTask(childId)).toHaveLength(1);
  expect(tasks.get(childId)!.prompt).toBe(oldPrompt.replace(step.instructions, template.graph.steps[0]!.instructions));
  const audit = readdirSync(pipelineRunsDir(parent.id)).find((f) => f.startsWith("instruction-update-"))!;
  expect(JSON.parse(readFileSync(path.join(pipelineRunsDir(parent.id), audit), "utf8")).steps).toEqual([
    { id: step.id, before: step.instructions, after: template.graph.steps[0]!.instructions },
  ]);
  const retry = await retryPipelineStep(parent.id);
  if ("error" in retry) throw new Error(retry.error);
  await until(() => tasks.get(parent.id)?.pipelineRun?.status === "done");
});

test("refresh refuses a live execution and leaves its instructions untouched", async () => {
  const { tasks } = await import("./db.ts");
  const { refreshPipelineInstructions } = await import("./pipeline-runner.ts");
  const { parent, template } = await fixture(true);
  const result = await refreshPipelineInstructions(parent.id, {
    expectedCapturedAt: parent.pipelineRun!.snapshot!.capturedAt, expectedTemplateUpdatedAt: template.updatedAt,
  });
  expect(result).toMatchObject({ status: 409 });
  expect(tasks.get(parent.id)!.pipelineRun!.snapshot).toEqual(parent.pipelineRun!.snapshot);
});

test("refresh refuses quota recovery after its timer is claimed and before the unlocked resumed turn finishes", async () => {
  const { tasks } = await import("./db.ts");
  const { fireAutoRetry, refreshPipelineInstructions } = await import("./pipeline-runner.ts");
  const { parent, template } = await fixture(false, "quota-blocked");
  const before = parent.pipelineRun!;
  const [recovery, refresh] = await Promise.all([
    fireAutoRetry(parent.id, before.autoRetry!.at!),
    refreshPipelineInstructions(parent.id, { expectedCapturedAt: before.snapshot!.capturedAt, expectedTemplateUpdatedAt: template.updatedAt }),
  ]);
  expect(recovery).toBe(true);
  expect(refresh).toMatchObject({ status: 409, error: expect.stringContaining("recovery") });
  expect(tasks.get(parent.id)!.pipelineRun!.snapshot).toEqual(before.snapshot);
});

test("instruction refresh preserves literal dollar replacement syntax in both snapshot and stopped prompt", async () => {
  const { tasks, pipelines } = await import("./db.ts");
  const { refreshPipelineInstructions } = await import("./pipeline-runner.ts");
  const { parent, template, step } = await fixture();
  const instructions = "Use replacements literally: $$ | $& | $` | $' | $1 | $99 | $<name>\n\n" + step.instructions;
  const latest = pipelines.update(template.id, { graph: { ...template.graph, steps: [{ ...step, instructions }] } })!;
  const childId = parent.pipelineRun!.active[0]!.taskId;
  const before = tasks.get(childId)!.prompt;
  const result = await refreshPipelineInstructions(parent.id, {
    expectedCapturedAt: parent.pipelineRun!.snapshot!.capturedAt, expectedTemplateUpdatedAt: latest.updatedAt,
  });
  if ("error" in result) throw new Error(result.error);
  expect(tasks.get(childId)!.prompt).toBe(before.replace(step.instructions, () => instructions));
  expect(result.task.pipelineRun!.snapshot!.graph.steps[0]!.instructions).toBe(instructions);
});

test("refresh rejects stale revisions, changed topology/agents, scheduled recovery and modified step prompts", async () => {
  const { tasks, pipelines } = await import("./db.ts");
  const { refreshPipelineInstructions } = await import("./pipeline-runner.ts");
  const { parent, template, step } = await fixture();
  const before = parent.pipelineRun!;
  const call = (expectedTemplateUpdatedAt = pipelines.get(template.id)!.updatedAt) => refreshPipelineInstructions(parent.id, {
    expectedCapturedAt: before.snapshot!.capturedAt, expectedTemplateUpdatedAt,
  });
  expect(await call(template.updatedAt - 1)).toMatchObject({ status: 409, error: expect.stringContaining("changed") });
  pipelines.update(template.id, { graph: { ...template.graph, steps: [{ ...step, agentProfileId: "different" }] } });
  expect(await call()).toMatchObject({ status: 409, error: expect.stringContaining("agent assignments") });
  pipelines.update(template.id, { graph: template.graph });
  tasks.setPipelineRun(parent.id, { ...before, autoRetry: { stepId: step.id, kind: "quota", attempt: 1, at: Date.now() + 60000, reason: "usage exhausted" } });
  expect(await call()).toMatchObject({ status: 409, error: expect.stringContaining("recovery") });
  expect(tasks.get(parent.id)!.pipelineRun!.autoRetry!.kind).toBe("quota");
  tasks.setPipelineRun(parent.id, before);
  tasks.update(before.active[0]!.taskId, { prompt: "A manually changed prompt" });
  expect(await call()).toMatchObject({ status: 409, error: expect.stringContaining("prompt") });
  expect(tasks.get(parent.id)!.pipelineRun).toEqual(before);
});
