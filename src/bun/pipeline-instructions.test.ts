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

/** A second execution of the fixture's step, held live the way a turn with
 *  background subagents still running is (`isTaskRunLive`) — a state the
 *  rows decide, so nothing here races an agent. `release()` settles it. */
async function liveSibling(parentId: string) {
  const { tasks, runs, subagents } = await import("./db.ts");
  const { isTaskRunLive } = await import("./orchestrator.ts");
  const run = tasks.get(parentId)!.pipelineRun!;
  const stopped = tasks.get(run.active[0]!.taskId)!;
  const id = randomUUID();
  const runId = randomUUID();
  const subagentId = randomUUID();
  tasks.insert({ ...stopped, id, runId, column: "running" });
  runs.insert({ ...runs.get(stopped.runId!)!, id: runId, taskId: id, status: "succeeded" });
  subagents.insertIfAbsent({ id: subagentId, taskId: id, runId, parentKind: "subagent", agentType: "Explore",
    description: "still working", spawnDepth: 1, sourcePath: "/tmp/agent.jsonl", status: "running", startedAt: Date.now(), endedAt: null });
  expect(isTaskRunLive(id)).toBe(true);
  expect(isTaskRunLive(stopped.id)).toBe(false);
  return { id, prompt: tasks.get(id)!.prompt, release: () => {
    subagents.setStatus(subagentId, "completed", Date.now());
    tasks.update(id, { column: "review" });
    expect(isTaskRunLive(id)).toBe(false);
  } };
}

test("a running run is refreshed: the snapshot changes, the live step keeps its prompt until its retry, the waiting step's prompt is rewritten", async () => {
  const { tasks } = await import("./db.ts");
  const { refreshPipelineInstructions, retryPipelineStep } = await import("./pipeline-runner.ts");
  const { parent, template, step } = await fixture();
  const stoppedId = parent.pipelineRun!.active[0]!.taskId;
  const stoppedPrompt = tasks.get(stoppedId)!.prompt;
  const live = await liveSibling(parent.id);
  // The stopped execution only waits for a free slot, so the run is running.
  const before = { ...parent.pipelineRun!, status: "running" as const,
    active: [...parent.pipelineRun!.active, { stepId: step.id, taskId: live.id, seq: 2 }],
    blocked: [{ taskId: stoppedId, stepId: step.id, kind: "slot-wait" as const, message: "waiting for a free slot" }] };
  tasks.setPipelineRun(parent.id, before);
  const next = template.graph.steps[0]!.instructions;

  const result = await refreshPipelineInstructions(parent.id);
  if ("error" in result) throw new Error(result.error);
  expect(result).toMatchObject({ stepIds: [step.id], unmatched: [], skippedPrompts: [] });
  const after = result.task.pipelineRun!;
  expect(after.snapshot!.graph.steps[0]!.instructions).toBe(next);
  expect(after.active).toEqual([before.active[0]!, { ...before.active[1]!, staleInstructions: step.instructions }]);
  expect({ ...after, snapshot: before.snapshot, active: before.active }).toEqual(before);
  expect(tasks.get(live.id)!.prompt).toBe(live.prompt);
  expect(tasks.get(stoppedId)!.prompt).toBe(stoppedPrompt.replace(step.instructions, next));
  const { readLogged } = await import("./activity.ts");
  expect(readLogged(parent.id).map((a) => a.text).join("\n")).toContain("picking the new one up at the next launch: Review");

  // Once that execution has stopped, its retry launches the new text.
  live.release();
  tasks.setPipelineRun(parent.id, { ...after, status: "blocked", active: [after.active[1]!],
    blocked: [{ taskId: live.id, stepId: step.id, kind: "step-failed", message: "stopped" }] });
  const retry = await retryPipelineStep(parent.id, { taskId: live.id });
  if ("error" in retry) throw new Error(retry.error);
  expect(tasks.get(live.id)!.prompt).toBe(live.prompt.replace(step.instructions, next));
  await until(() => tasks.get(parent.id)?.pipelineRun?.status === "done");
});

test("a refresh during quota recovery applies instead of being refused", async () => {
  const { tasks } = await import("./db.ts");
  const { fireAutoRetry, refreshPipelineInstructions } = await import("./pipeline-runner.ts");
  const { parent, template, step } = await fixture(false, "quota-blocked");
  const before = parent.pipelineRun!;
  const [recovery, refresh] = await Promise.all([
    fireAutoRetry(parent.id, before.autoRetry!.at!),
    refreshPipelineInstructions(parent.id),
  ]);
  expect(recovery).toBe(true);
  expect(refresh).toMatchObject({ stepIds: [step.id] });
  expect(tasks.get(parent.id)!.pipelineRun!.snapshot!.graph.steps[0]!.instructions).toBe(template.graph.steps[0]!.instructions);
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

test("revisions are checked only when given; a template with other agents still refreshes; waits, timers and edited prompts are preserved", async () => {
  const { tasks, pipelines } = await import("./db.ts");
  const { refreshPipelineInstructions } = await import("./pipeline-runner.ts");
  const { parent, template, step } = await fixture();
  const before = parent.pipelineRun!;
  const childId = before.active[0]!.taskId;
  const edit = (instructions: string, patch: Partial<typeof step> = {}) =>
    pipelines.update(template.id, { graph: { ...template.graph, steps: [{ ...step, ...patch, instructions }] } })!;
  const snapshot = () => tasks.get(parent.id)!.pipelineRun!.snapshot!;

  // A named revision that no longer matches still refuses; either may be left out.
  expect(await refreshPipelineInstructions(parent.id, { expectedTemplateUpdatedAt: template.updatedAt - 1 }))
    .toMatchObject({ status: 409, error: expect.stringContaining("changed") });
  expect(await refreshPipelineInstructions(parent.id, { expectedCapturedAt: before.snapshot!.capturedAt - 1 }))
    .toMatchObject({ status: 409, error: expect.stringContaining("changed") });
  expect(snapshot()).toEqual(before.snapshot!);
  expect(await refreshPipelineInstructions(parent.id, { expectedCapturedAt: before.snapshot!.capturedAt }))
    .toMatchObject({ stepIds: [step.id] });

  // The template's agent, name and routing moved on; the run keeps its own.
  edit("Second text", { agentProfileId: "different", name: "Renamed", transition: "all", canFinish: true });
  expect(await refreshPipelineInstructions(parent.id, {})).toMatchObject({ stepIds: [step.id], unmatched: [], skippedPrompts: [] });
  expect(snapshot().graph.steps[0]).toEqual({ ...before.snapshot!.graph.steps[0]!, instructions: "Second text" });
  expect(tasks.get(childId)!.prompt).toContain("\n\n## Your step\n\nSecond text\n\n");

  // A scheduled recovery and a wait in the queue are no reason to refuse, and both survive.
  const held = { ...tasks.get(parent.id)!.pipelineRun!,
    autoRetry: { stepId: step.id, kind: "quota" as const, attempt: 1, at: Date.now() + 3_600_000, reason: "usage exhausted" },
    wait: { stepId: step.id, taskId: childId, category: "resource" as const, source: "declared" as const, what: "the lab lease", ref: null,
      reason: "lease held elsewhere", state: "waiting" as const, since: 1, attempt: 1, max: 5, at: null, deadline: 2, tried: [] } };
  tasks.setPipelineRun(parent.id, held);
  const stored = tasks.get(parent.id)!.pipelineRun!;
  expect(stored.wait).toEqual(held.wait);
  edit("Third text");
  expect(await refreshPipelineInstructions(parent.id)).toMatchObject({ stepIds: [step.id] });
  const refreshed = tasks.get(parent.id)!.pipelineRun!;
  expect({ ...refreshed, snapshot: stored.snapshot }).toEqual(stored);
  expect(tasks.get(childId)!.prompt).toContain("\n\n## Your step\n\nThird text\n\n");

  // A hand-edited prompt is kept and reported; the snapshot is updated anyway.
  tasks.update(childId, { prompt: "A manually changed prompt" });
  edit("Fourth text");
  expect(await refreshPipelineInstructions(parent.id)).toMatchObject({ stepIds: [step.id], skippedPrompts: [childId] });
  expect(snapshot().graph.steps[0]!.instructions).toBe("Fourth text");
  expect(tasks.get(childId)!.prompt).toBe("A manually changed prompt");

  // What cannot be done is still refused.
  expect(await refreshPipelineInstructions("missing")).toMatchObject({ status: 404 });
  pipelines.delete(template.id);
  expect(await refreshPipelineInstructions(parent.id)).toMatchObject({ status: 404, error: expect.stringContaining("template") });
});

// What Pillar's `sync_policy.py` saves in one `agetor pipeline edit`: new step
// text, and "trivial change made" moved from Finish to Review.
test("one edit of step text and of the trivial route: an unfinished run takes the text and keeps its route; a run started afterwards has both", async () => {
  const { agentProfiles, pipelines, tasks } = await import("./db.ts");
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { newStep, reviewedPipelineShape } = await import("../shared/pipeline.ts");
  const { refreshPipelineRuns } = await import("./pipeline-runner.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: marker } = await import("./agents.ts");
  const profile = agentProfiles.insert({ name: randomUUID(), harness: "claude-code", model: "fake-model", effort: null,
    mode: null, fast: false, maxMode: false, instructions: "", skills: [] });
  const step = (name: string, canFinish = false) => newStep({ name, agentProfileId: profile.id, instructions: `Old ${name} text. ${marker}:blocked`, ...(canFinish ? { canFinish } : {}) });
  const understand = step("Understand", true), build = step("Build"), review = step("Review"), finish = step("Finish", true);
  const edges = (trivialTo: string) => [
    { id: "understand-build", from: understand.id, to: build.id, label: "build" }, { id: "understand-finish", from: understand.id, to: trivialTo, label: "trivial change made" },
    { id: "build-review", from: build.id, to: review.id, label: "" }, { id: "review-build", from: review.id, to: build.id, label: "changes requested" },
    { id: "review-finish", from: review.id, to: finish.id, label: "approved" }, { id: "finish-build", from: finish.id, to: build.id, label: "verification failed" },
  ];
  const pipeline = pipelines.insert({ name: randomUUID(), graph: { steps: [understand, build, review, finish], edges: edges(finish.id), startStepId: understand.id }, maxSteps: 14 });
  const launch = async () => {
    const created = await createTask({ title: "policy", prompt: "goal", isolation: "none", workdir: mkdtempSync(path.join(tmpdir(), "agetor-instructions-wd-")), pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    parents.push(created.task.id);
    const started = await startTask(created.task.id);
    if ("error" in started) throw new Error(started.error);
    return until(() => {
      const t = tasks.get(created.task.id);
      return t?.pipelineRun?.status === "blocked" ? t : undefined;
    });
  };
  const trivial = (id: string) => tasks.get(id)!.pipelineRun!.snapshot!.graph.edges.find((e) => e.label === "trivial change made")!.to;
  const text = (id: string) => tasks.get(id)!.pipelineRun!.snapshot!.graph.steps.map((s) => s.instructions);
  const before = await launch();

  const edited = [understand, build, review, finish].map((s) => ({ ...s, instructions: `New ${s.name} text. ${marker}:blocked` }));
  pipelines.update(pipeline.id, { graph: { steps: edited, edges: edges(review.id), startStepId: understand.id } });
  const results = await refreshPipelineRuns(pipeline.id);
  const result = results.find((r) => r.taskId === before.id)!;
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ stepIds: [understand.id, build.id, review.id, finish.id], unmatched: [], skippedPrompts: [] });

  const run = tasks.get(before.id)!.pipelineRun!;
  expect(text(before.id)).toEqual(edited.map((s) => s.instructions));
  expect(trivial(before.id)).toBe(finish.id);
  expect(run.history).toEqual(before.pipelineRun!.history);
  expect(tasks.get(run.active[0]!.taskId)!.prompt).toContain("New Understand text.");
  expect(reviewedPipelineShape(run.snapshot!.graph)?.finish.id).toBe(finish.id);

  const after = await launch();
  expect(text(after.id)).toEqual(edited.map((s) => s.instructions));
  expect(trivial(after.id)).toBe(review.id);
  expect(reviewedPipelineShape(after.pipelineRun!.snapshot!.graph)?.finish.id).toBe(finish.id);
});
