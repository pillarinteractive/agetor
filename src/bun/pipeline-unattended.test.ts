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

/** Build → Review → Finish (may end the run, or go back to Build); Review and Finish each choose `reviewNext`/`finishNext`. */
async function startTemplate(reviewNext: string, finishNext: string, maxSteps: number, unattended: boolean) {
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
  const step = (name: string, next: string) => newStep({ name, agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${next}` });
  const build = step("Build", "Review"), review = step("Review", reviewNext), finish = { ...step("Finish", finishNext), canFinish: true };
  const graph = {
    steps: [build, review, finish],
    edges: [
      { id: "build-review", from: build.id, to: review.id, label: "" },
      { id: "review-build", from: review.id, to: build.id, label: "changes requested" },
      { id: "review-finish", from: review.id, to: finish.id, label: "approved" },
      { id: "finish-build", from: finish.id, to: build.id, label: "verification failed" },
    ],
    startStepId: build.id,
  };
  const pipeline = pipelines.insert({ name: `unattended-${randomUUID()}`, graph, maxSteps });
  const created = await createTask({ title: "unattended", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, review, finish };
}

const WRAP_UP_HEADING = "## Step cap reached — wrap up this run";
const wrapUpLines = (id: string) => activity(id).filter((l) => l.includes("finishing through Finish and filing issues for what is unresolved"));

test("unattended: the cap reached on the launch of the terminal step launches it as the wrap-up", async () => {
  const { tasks } = await import("./db.ts");
  // Cap 1 → 2 (the automatic extension, on Review); Finish is the third launch.
  const { parentId, review, finish } = await startTemplate("Finish", "done", 1, true);
  const done = await waitFor(() => (tasks.get(parentId)?.pipelineRun?.status === "done" ? tasks.get(parentId)! : null));
  const run = done.pipelineRun!;
  expect(run.stepCount).toBe(3);
  expect(run.capExtensions).toBe(1);
  expect(run.blocked).toEqual([]);
  expect(run.capWrapUp).toMatchObject({ fromStepId: finish.id, seq: 3 });
  const last = run.history.at(-1)!;
  expect(last).toMatchObject({ seq: 3, stepId: finish.id, outcome: "succeeded" });
  const prompt = tasks.get(last.taskId)!.prompt;
  expect(prompt).toContain(WRAP_UP_HEADING);
  expect(prompt).toContain("This run reached its 2-step cap");
  expect(prompt).toContain("step 3 of at most 3: Finish");
  // Earlier steps were launched under the cap, with no wrap-up section.
  expect(tasks.get(run.history.find((h) => h.stepId === review.id)!.taskId)!.prompt).not.toContain(WRAP_UP_HEADING);
  expect(wrapUpLines(parentId)).toEqual(["Reached the 2-step cap — finishing through Finish and filing issues for what is unresolved"]);
});

test("unattended: the cap reached on the launch of another step launches the terminal step in its place, then blocks", async () => {
  const { tasks } = await import("./db.ts");
  const { retryPipelineStep } = await import("./pipeline-runner.ts");
  // Review keeps asking for Build, and so does Finish: Build, Review, Build,
  // Review (cap 2 → 4), Finish as the wrap-up in place of Build, then the
  // Build that Finish asks for meets the cap with the wrap-up used.
  const { parentId, build, review, finish } = await startTemplate("Build", "Build", 2, true);
  const run = await blockedRun(parentId);
  expect(run.stepCount).toBe(5);
  expect(run.history.map((h) => h.stepId)).toEqual([build.id, review.id, build.id, review.id, finish.id]);
  expect(run.capWrapUp).toMatchObject({ fromStepId: build.id, seq: 5 });
  // The reviewer's own choice stays on record; Finish ran in Build's place.
  expect(run.history[3]!.nextStepIds).toEqual([build.id]);
  const wrapUp = tasks.get(run.history[4]!.taskId)!;
  expect(wrapUp.prompt).toContain(WRAP_UP_HEADING);
  // The same arrival Build would have had: Review's handoff, as a file reference and inline.
  expect(wrapUp.prompt).toContain('### From "Review"');
  expect(wrapUp.references.some((r) => /handoff-[0-9a-z]+-5-from-4\.json$/.test(r.path))).toBe(true);
  expect(wrapUpLines(parentId).length).toBe(1);

  const block = run.blocked.find((b) => b.kind === "step-cap")!;
  expect(block.message).toBe("reached the 4-step cap for this run — retry to keep going, or stop here");
  expect(block.pending).toMatchObject({ stepId: build.id, arrivals: [{ fromStepId: finish.id, seq: 5 }] });

  // A person's Retry extends the cap and carries on as before; the next cap
  // hit blocks again, with no second wrap-up.
  const retried = await retryPipelineStep(parentId);
  expect("error" in retried).toBe(false);
  const again = (await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.capExtensions === 2 ? t : undefined;
  })).pipelineRun!;
  expect(again.stepCount).toBe(6);
  expect(again.history.at(-1)!.stepId).toBe(build.id);
  expect(tasks.get(again.history.at(-1)!.taskId)!.prompt).not.toContain(WRAP_UP_HEADING);
  expect(again.capWrapUp).toMatchObject({ fromStepId: build.id, seq: 5 });
  expect(again.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  expect(wrapUpLines(parentId).length).toBe(1);
});

test("attended: the cap blocks on the terminal step's launch too, with no wrap-up", async () => {
  const { tasks } = await import("./db.ts");
  const { parentId, finish } = await startTemplate("Finish", "done", 2, false);
  const run = await blockedRun(parentId);
  expect(run.stepCount).toBe(2);
  expect(run.capWrapUp).toBeUndefined();
  expect(run.blocked.find((b) => b.kind === "step-cap")!.pending).toMatchObject({ stepId: finish.id });
  expect(run.history.every((h) => !tasks.get(h.taskId)!.prompt.includes(WRAP_UP_HEADING))).toBe(true);
  expect(wrapUpLines(parentId)).toEqual([]);
});
