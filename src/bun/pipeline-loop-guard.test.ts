import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineRunState } from "../shared/types.ts";
import type { HeadAt } from "../shared/no-change-loop.ts";

// The no-change Build ↔ Review loop guard (src/shared/no-change-loop.ts, the
// runner's `guardNoChangeLoop`). Same bootstrap as pipeline-owner-holds.test.ts.
// The head each step leaves is stubbed (`loopGuardDeps.readHead`); nothing
// here sleeps or measures time beyond waiting for the fake steps to settle.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-loop-guard-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let parents: string[] = [];
const SLOTS = JSON.stringify({ max: 200, heavy: { max: 200, steps: [] }, ci: { max: 200, exempt: [] } });
let slotsBefore: string | null = null;
const H: HeadAt = { head: "e0c8e488aaaa", tree: "tree-1" };

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
  const { preferences } = await import("./db.ts");
  const { STEP_SLOTS_PREF } = await import("./step-slots.ts");
  slotsBefore = preferences.get(STEP_SLOTS_PREF) ?? null;
  preferences.set(STEP_SLOTS_PREF, SLOTS);
});

afterEach(async () => {
  const { resetBlockWaitsForTests, stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  resetBlockWaitsForTests();
  stopPipelineAutoRetryTimers();
  const { tasks, preferences } = await import("./db.ts");
  const { PIPELINE_DECISIONS_PREF } = await import("../shared/pipeline-decisions.ts");
  preferences.set(PIPELINE_DECISIONS_PREF, "null");
  preferences.set("owner_holds", "resolve");
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

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15000): Promise<T> {
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

/** Heads by the order steps settle: the n-th Build or Review settle reads `heads(n)`. */
async function stubHeads(heads: (n: number) => HeadAt) {
  const { loopGuardDeps } = await import("./pipeline-runner.ts");
  let n = 0;
  loopGuardDeps.readHead = async () => heads(n++);
}

/** Build → Review → Finish; Review sends every visit back to Build. */
async function start(opts: { unattended?: boolean; maxSteps?: number } = {}) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines, preferences } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { PIPELINE_DECISIONS_PREF } = await import("../shared/pipeline-decisions.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-loop-guard-wd-"));
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: "agent-followups", projects: opts.unattended === false ? [] : [workdir] }));
  const profile = agentProfiles.insert({
    name: `loop-guard-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, s: string) => newStep({ name, agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${s}` });
  const build = step("Build", "Review");
  const review = step("Review", "Build");
  const finish = { ...step("Finish", "done"), canFinish: true };
  const graph = {
    steps: [build, review, finish],
    edges: [
      { id: "e1", from: build.id, to: review.id, label: "" },
      { id: "e2", from: review.id, to: build.id, label: "changes requested" },
      { id: "e3", from: review.id, to: finish.id, label: "approved" },
      { id: "e4", from: finish.id, to: build.id, label: "verification failed" },
    ],
    startStepId: build.id,
  };
  const pipeline = pipelines.insert({ name: `loop-guard-${randomUUID()}`, graph, maxSteps: opts.maxSteps ?? 25 });
  const created = await createTask({ title: "loop guard", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, review, finish };
}

const ended = async (parentId: string): Promise<PipelineRunState> => {
  const { tasks } = await import("./db.ts");
  const { isTaskRunLive } = await import("./orchestrator.ts");
  return waitFor(() => {
    const run = tasks.get(parentId)?.pipelineRun;
    return run && (run.status === "done" || (run.status === "blocked" && run.active.every((a) => !isTaskRunLive(a.taskId)))) ? run : undefined;
  });
};
const promptOf = async (taskId: string) => (await import("./db.ts")).tasks.get(taskId)!.prompt;
const NOTE = "## Build made no change — decide what Build can still fix";

test("Build leaving Review's head unchanged twice tells the next Review once; sent back again, the run wraps up through Finish unapproved", async () => {
  await stubHeads(() => H);
  const { parentId, build, review, finish } = await start();
  const run = await ended(parentId);
  expect(run.status).toBe("done");
  // Build, Review, Build (round 1), Review, Build (round 2 → told), Review (told; sends back) → Finish.
  expect(run.history.map((h) => h.stepId)).toEqual([build.id, review.id, build.id, review.id, build.id, review.id, finish.id]);
  const reviews = run.history.filter((h) => h.stepId === review.id);
  const prompts = await Promise.all(reviews.map((h) => promptOf(h.taskId)));
  expect(prompts.map((p) => p.includes(NOTE))).toEqual([false, false, true]);
  expect(prompts[2]).toContain("Build ended 2 times in a row");
  const fin = await promptOf(run.history.at(-1)!.taskId);
  expect(fin).toContain("## Closing out without the owner — wrap up this run");
  expect(fin).toContain("Build made no change 2 times for the same findings");
  expect(fin).toContain("published unapproved");
  expect(fin).toContain("`Refs`, not `Fixes`");
  expect(fin).not.toContain(NOTE);
  expect(run.capWrapUp).toMatchObject({ fromStepId: build.id, closeout: { issues: [] } });
  expect(run.noChangeLoop).toMatchObject({ rounds: 2, key: "tree-1" });
  expect(run.noChangeLoop!.instructedAt).not.toBeNull();
  expect(run.noChangeLoop!.wrappedAt).not.toBeNull();
  const lines = activity(parentId);
  expect(lines.filter((l) => l.includes("telling Review to stop returning findings Build cannot fix"))).toHaveLength(1);
  expect(lines.filter((l) => l.includes("back to Build a third time — finishing through Finish"))).toHaveLength(1);
});

test("a Build that changes the head resets the count", async () => {
  // Settles: B1, R1, B2, R2, B3(changed), R3, B4, R4, B5 → told, R5 → wrap-up.
  await stubHeads((n) => (n >= 4 ? { head: "b2", tree: "tree-2" } : H));
  const { parentId, build, review, finish } = await start();
  const run = await ended(parentId);
  expect(run.status).toBe("done");
  const steps = run.history.map((h) => (h.stepId === build.id ? "B" : h.stepId === review.id ? "R" : h.stepId === finish.id ? "F" : "?"));
  expect(steps.join("")).toBe("BRBRBRBRBRF");
  const reviews = run.history.filter((h) => h.stepId === review.id);
  const told = await Promise.all(reviews.map(async (h) => (await promptOf(h.taskId)).includes(NOTE)));
  expect(told).toEqual([false, false, false, false, true]);
});

test("a card a person runs, and owner_holds park, are left alone: no note, no wrap-up, the step cap ends it", async () => {
  const { preferences } = await import("./db.ts");
  for (const mode of ["attended", "park"] as const) {
    await stubHeads(() => H);
    if (mode === "park") preferences.set("owner_holds", "park");
    const { parentId, review } = await start({ unattended: mode !== "attended", maxSteps: 8 });
    const run = await ended(parentId);
    if (mode === "attended") {
      expect(run.status).toBe("blocked");
      expect(run.blocked.map((b) => b.kind)).toContain("step-cap");
    } else {
      // Unattended, park: the ordinary step-cap path (extension, then its wrap-up), not this guard's.
      expect(run.history.length).toBeGreaterThan(8);
    }
    expect(run.noChangeLoop).toBeUndefined();
    expect(run.capWrapUp?.closeout).toBeUndefined();
    const prompts = await Promise.all(run.history.filter((h) => h.stepId === review.id).map((h) => promptOf(h.taskId)));
    expect(prompts.some((p) => p.includes(NOTE))).toBe(false);
    preferences.set("owner_holds", "resolve");
  }
});

test("the counter is kept on the run across a reload (the run sanitizer keeps it)", async () => {
  const { tasks } = await import("./db.ts");
  await stubHeads(() => H);
  const { parentId } = await start();
  await ended(parentId);
  const state = { reviewed: "tree-1", key: "tree-1", rounds: 2, instructedAt: 123, wrappedAt: null };
  const run = tasks.get(parentId)!.pipelineRun!;
  tasks.setPipelineRun(parentId, { ...run, noChangeLoop: state });
  expect(tasks.get(parentId)!.pipelineRun!.noChangeLoop).toEqual(state);
});

test("a run parked at its step cap whose pull request was merged is finished by settleMergedRun", async () => {
  await stubHeads((i) => ({ head: `h${i}`, tree: `t${i}` }));
  const { parentId } = await start({ unattended: false, maxSteps: 2 });
  const run = await ended(parentId);
  expect(run.status).toBe("blocked");
  expect(run.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  const { settleMergedRun } = await import("./pipeline-runner.ts");
  expect(await settleMergedRun(parentId, 42)).toBe(true);
  const { tasks } = await import("./db.ts");
  const after = tasks.get(parentId)!.pipelineRun!;
  expect(after.status).toBe("done");
  expect(after.blocked).toEqual([]);
  expect(after.endedAt).not.toBeNull();
  // Idempotent: a later probe finds it done and changes nothing.
  expect(await settleMergedRun(parentId, 42)).toBe(true);
});
