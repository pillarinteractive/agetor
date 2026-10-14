import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineRunState, PipelineStep, StepCheck } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Finding the position, restart-as-resume, rewind and feedback, end to end
// through the runner (Stage 3 of docs/plans/check-gated-pipeline.md). The
// agents are the scripted fake; the worktree is a temporary git repository
// with a local bare "origin". Nothing is pushed and GitHub is never called.
// Same bootstrap as pipeline-check-gates.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-position-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { tasks, preferences, pipelines, agentProfiles, runs, dataDir } = await import("./db.ts");
const { newStep, CHECK_FEEDBACK_MARKER } = await import("../shared/pipeline.ts");
const { STEP_VOID_CHECK_ID } = await import("../shared/position.ts");
const { PIPELINE_GATES_PREF } = await import("../shared/publish.ts");
const { STEP_SLOTS_PREF } = await import("./step-slots.ts");
const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
const { checkDeps, checkLedgerPath, readCheckLedger } = await import("./check-runner.ts");
const { feedbackLogPath, readFeedback } = await import("./position.ts");
const runner = await import("./pipeline-runner.ts");
const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");

const realDeps = { ...checkDeps };
let parents: string[] = [];
const SLOTS = JSON.stringify({ max: 200, heavy: { max: 200, steps: [] }, ci: { max: 200, exempt: [] } });
let slotsBefore: string | null = null;

beforeAll(() => {
  runner.initPipelineRunner();
  slotsBefore = preferences.get(STEP_SLOTS_PREF) ?? null;
  preferences.set(STEP_SLOTS_PREF, SLOTS);
});

beforeEach(() => {
  Object.assign(checkDeps, realDeps);
  checkDeps.base = async () => "develop";
  preferences.set(PIPELINE_GATES_PREF, "{}");
});

afterEach(async () => {
  runner.stopPipelineAutoRetryTimers();
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
  Object.assign(checkDeps, realDeps);
  preferences.set(STEP_SLOTS_PREF, slotsBefore ?? "");
  preferences.set(PIPELINE_GATES_PREF, "{}");
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

/** Poll for a condition (never a duration). */
async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const activity = (id: string): string[] => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
};
const runOf = (id: string): PipelineRunState => tasks.get(id)!.pipelineRun!;
const where = (id: string) => {
  const run = runOf(id);
  return JSON.stringify({ status: run.status, stepCount: run.stepCount, active: run.active.map((a) => a.seq), blocked: run.blocked.map((b) => `${b.kind}: ${b.message}`), history: run.history.map((h) => [h.seq, h.stepId.slice(0, 4), h.outcome, h.gate?.state]) });
};
/** The run in `status` with exactly `steps` launches so far. */
const settled = async (id: string, status: PipelineRunState["status"], steps?: number) => {
  try {
    return await waitFor(() => (runOf(id).status === status && (steps === undefined || runOf(id).stepCount === steps) ? runOf(id) : null), `run ${status}`);
  } catch (e) {
    throw new Error(`${(e as Error).message} — ${where(id)}`);
  }
};
const sentTo = (taskId: string): string[] => runs.listForTask(taskId).flatMap((r) => runs.events(r.id).filter((e) => e.stream === "user").map((e) => e.data));
const cmd = (id: string, command: string, o: Partial<StepCheck> = {}): StepCheck => ({ id, description: `${id} holds`, run: { kind: "command", command }, required: true, timeoutSec: 120, ...o });

const sh = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
};
/** A clone of a bare origin with `develop`, on a branch with one commit of its own. */
async function repoWithChange() {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-position-repo-"));
  const origin = path.join(root, "origin.git"), repo = path.join(root, "card");
  await sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
  await sh(root, "git", "clone", "-q", origin, repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) await sh(repo, "git", "config", k!, v!);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "base");
  await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");
  await sh(repo, "git", "checkout", "-q", "-b", "claude/x", "origin/develop");
  writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "feat: the change");
  return repo;
}
const commit = async (repo: string, file: string) => {
  writeFileSync(path.join(repo, file), `${file}\n`);
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", `more: ${file}`);
  return sh(repo, "git", "rev-parse", "HEAD");
};

/** The board's Change shape — Understand (may finish), Build, Review, Finish
 *  and its loops — with scripted agents. Build has the default checks; the
 *  scripted Review cannot write a verdict, so its gate is a command check. */
async function makeCard(o: {
  workdir: string; build?: Partial<PipelineStep>; review?: Partial<PipelineStep>; script?: { understand?: string; review?: string }; goal?: string;
  /** Where "trivial change made" leads: Finish on the board's graph today, Review under Pillar's instruction policy. */
  trivialTo?: "finish" | "review";
}) {
  const profile = agentProfiles.insert({
    name: `position-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, next: string, extra: Partial<PipelineStep> = {}) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do the ${name} work. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${next}`, ...extra });
  const understand = step("Understand", o.script?.understand ?? "Build", { canFinish: true });
  const build = step("Build", "Review", o.build);
  const review = step("Review", o.script?.review ?? "Finish", { checks: [cmd("reviewed", "true")], ...o.review });
  const finish = step("Finish", "done", { canFinish: true });
  const graph = {
    steps: [understand, build, review, finish],
    edges: [
      { id: "understand-build", from: understand.id, to: build.id, label: "build" },
      { id: "understand-trivial", from: understand.id, to: o.trivialTo === "review" ? review.id : finish.id, label: "trivial change made" },
      { id: "build-review", from: build.id, to: review.id, label: "" },
      { id: "review-build", from: review.id, to: build.id, label: "changes requested" },
      { id: "review-finish", from: review.id, to: finish.id, label: "approved" },
      { id: "finish-build", from: finish.id, to: build.id, label: "verification failed" },
    ],
    startStepId: understand.id,
  };
  const pipeline = pipelines.insert({ name: `position-${randomUUID()}`, graph, maxSteps: 6 });
  const created = await createTask({ title: "position", prompt: o.goal ?? "Add the feature file.", workdir: o.workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  return { id: created.task.id, pipeline, understand, build, review, finish };
}
const gateOn = (pipelineId: string) => preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ steps: { pipelines: [pipelineId] } }));
async function start(id: string) {
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
}
const names = (id: string, run = runOf(id)) => run.history.map((h) => `${h.seq} ${run.snapshot!.graph.steps.find((s) => s.id === h.stepId)!.name} ${h.outcome}`);
const promptOf = (id: string, seq: number) => tasks.get(runOf(id).history.find((h) => h.seq === seq)!.taskId)!.prompt;

test("a card without gates: Restart starts from the beginning as before, and position, rewind and feedback are not for it", async () => {
  const card = await makeCard({ workdir: await repoWithChange() });
  await start(card.id);
  const first = await settled(card.id, "done", 4);
  expect(first.snapshot!.gates).toBeUndefined();

  expect(await runner.pipelinePosition(card.id)).toEqual({ gated: false, position: null, line: null, steps: [] });
  const rewound = await runner.rewindPipelineRun(card.id, { stepId: card.review.id });
  expect(rewound).toMatchObject({ status: 409 });
  expect("error" in rewound && rewound.error).toContain("Rewind is for a run with check gates");
  expect(await runner.steerPipelineRun(card.id, { fromStepId: card.build.id, note: "Use the helper." })).toMatchObject({ status: 409 });
  expect(runOf(card.id)).toEqual(first);
  expect(existsSync(feedbackLogPath(card.id, first))).toBe(false);
  expect(existsSync(checkLedgerPath(card.id, first))).toBe(false);

  // Restart with no flag: history emptied, a new generation, Understand first.
  const restarted = await runner.startPipelineRun(tasks.get(card.id)!, { restart: true });
  expect("error" in restarted).toBe(false);
  expect("resumed" in restarted && restarted.resumed).toBeFalsy();
  const again = await waitFor(() => (runOf(card.id).status === "done" && runOf(card.id).startedAt !== first.startedAt ? runOf(card.id) : null), "the restarted run to finish");
  expect(names(card.id, again)).toEqual(["1 Understand succeeded", "2 Build succeeded", "3 Review succeeded", "4 Finish succeeded"]);
  expect(again.history[0]!.taskId).not.toBe(first.history[0]!.taskId);
  expect(promptOf(card.id, 2)).not.toContain("Feedback from the owner");
}, 90_000);

test("a gated card: Restart resumes at the first step whose gate is not satisfied, keeps the history, and from the beginning stays an explicit choice", async () => {
  const repo = await repoWithChange();
  const card = await makeCard({ workdir: repo });
  gateOn(card.pipeline.id);
  await start(card.id);
  const first = await settled(card.id, "done", 4);
  expect(first.snapshot!.gates).toEqual({ steps: true });
  const firstTasks = first.history.map((h) => h.taskId);

  // Everything holds: there is nothing to resume, and nothing is started.
  const view = await runner.pipelinePosition(card.id);
  expect(view).toMatchObject({ gated: true, position: { kind: "complete" }, line: "Every step is still satisfied (Understand, Build, Review, Finish): there is nothing to resume" });
  expect("steps" in view && view.steps.map((s) => [s.name, s.reached])).toEqual([["Understand", true], ["Build", true], ["Review", true], ["Finish", true]]);
  const nothing = await runner.startPipelineRun(tasks.get(card.id)!, { restart: true });
  expect("error" in nothing && nothing.error).toContain("there is nothing to resume — rewind to a step to redo it, or restart from the beginning");
  expect(runOf(card.id)).toEqual(first);

  // A new commit: Build's checks still hold, Review's result was for another head.
  const head = await commit(repo, "second.txt");
  // A gates refresh says where the run stands, and launches nothing.
  const refreshed = (await runner.refreshPipelineRuns(card.pipeline.id, { gates: true })).find((r) => r.taskId === card.id)!;
  expect(refreshed.gates).toEqual({ publish: false, steps: true, changed: false });
  expect(refreshed.position).toContain("Resumes at Review — ");
  expect(runOf(card.id)).toEqual(first);
  const moved = await runner.pipelinePosition(card.id);
  expect(moved).toMatchObject({ position: { kind: "step", stepId: card.review.id, satisfied: [{ stepId: card.understand.id, seq: 1 }, { stepId: card.build.id, seq: 2 }], arrivals: [{ stepId: card.build.id, seq: 2 }] } });
  expect("line" in moved && moved.line).toContain(`Resumes at Review — Review's check \`reviewed\` does not hold now: has no recorded pass for HEAD ${head.slice(0, 8)}`);

  // An uncommitted change to a tracked file: Build's own check fails now.
  writeFileSync(path.join(repo, "feature.txt"), "edited\n");
  expect(await runner.pipelinePosition(card.id)).toMatchObject({ position: { kind: "step", stepId: card.build.id, satisfied: [{ stepId: card.understand.id }], arrivals: [{ stepId: card.understand.id, seq: 1 }] } });
  await sh(repo, "git", "checkout", "-q", "--", "feature.txt");

  // Restart: resumed at Review with Build's handoff. Understand and Build are not run again.
  const restarted = await runner.startPipelineRun(tasks.get(card.id)!, { restart: true });
  expect(restarted).toMatchObject({ resumed: { stepId: card.review.id, stepName: "Review", kept: [{ stepName: "Understand" }, { stepName: "Build" }] } });
  const resumed = await settled(card.id, "done", 6);
  expect(names(card.id, resumed)).toEqual(["1 Understand succeeded", "2 Build succeeded", "3 Review succeeded", "4 Finish succeeded", "5 Review succeeded", "6 Finish succeeded"]);
  expect(resumed.startedAt).toBe(first.startedAt);
  expect(resumed.history.slice(0, 4).map((h) => h.taskId)).toEqual(firstTasks);
  expect(tasks.stepsForParent(card.id).filter((t) => t.pipelineStepId === card.understand.id || t.pipelineStepId === card.build.id)).toHaveLength(2);
  expect(promptOf(card.id, 5)).toContain('### From "Build"');
  expect(promptOf(card.id, 5)).toContain("step 5 of at most");
  expect(activity(card.id).some((l) => l.startsWith("Restarted. Resumes at Review") && l.includes("Understand, Build are still satisfied and are not run again"))).toBe(true);
  // The ledger is one file for the run: Review's new pass is for the new head.
  const ledger = readCheckLedger(card.id, resumed);
  expect(ledger.filter((e) => e.checkId === "reviewed").map((e) => [e.seq, e.outcome, e.key.head === head])).toEqual([[3, "pass", false], [5, "pass", true]]);
  expect((await runner.pipelinePosition(card.id))).toMatchObject({ position: { kind: "complete" } });

  // The card's goal was edited: Understand worked from another goal, so nothing is kept.
  tasks.update(card.id, { prompt: "Add the feature file, and a changelog entry." });
  expect(await runner.pipelinePosition(card.id)).toMatchObject({ position: { kind: "step", stepId: card.understand.id, why: "the card's goal changed since Understand read it", satisfied: [] } });
  tasks.update(card.id, { prompt: "Add the feature file." });

  // From the beginning, explicitly: what every restart used to do.
  const scratch = await runner.startPipelineRun(tasks.get(card.id)!, { restart: true, fromScratch: true });
  expect("error" in scratch).toBe(false);
  expect("resumed" in scratch && scratch.resumed).toBeFalsy();
  const fresh = await waitFor(() => (runOf(card.id).status === "done" && runOf(card.id).startedAt !== first.startedAt ? runOf(card.id) : null), "the run from the beginning to finish");
  expect(names(card.id, fresh)).toEqual(["1 Understand succeeded", "2 Build succeeded", "3 Review succeeded", "4 Finish succeeded"]);
  expect(fresh.history.map((h) => h.taskId).some((t) => firstTasks.includes(t))).toBe(false);
  // Nothing was pushed and the worktree was left as it was.
  expect(await sh(repo, "git", "rev-parse", "HEAD")).toBe(head);
  expect(await sh(repo, "git", "ls-remote", "origin", "refs/heads/claude/x")).toBe("");
}, 120_000);

test("a trivial change, on either route: the position follows the steps the run took, and a restart resumes at Review where the route has one", async () => {
  for (const trivialTo of ["finish", "review"] as const) {
    const repo = await repoWithChange();
    const card = await makeCard({ workdir: repo, trivialTo, script: { understand: trivialTo === "review" ? "Review" : "Finish" } });
    gateOn(card.pipeline.id);
    await start(card.id);
    const took = trivialTo === "review" ? ["Understand", "Review", "Finish"] : ["Understand", "Finish"];
    const first = await settled(card.id, "done", took.length);
    expect(names(card.id, first)).toEqual(took.map((n, i) => `${i + 1} ${n} succeeded`));
    const view = await runner.pipelinePosition(card.id);
    expect(view).toMatchObject({ gated: true, position: { kind: "complete" }, line: `Every step is still satisfied (${took.join(", ")}): there is nothing to resume` });
    expect("steps" in view && view.steps.map((s) => s.name)).toEqual(took);

    // A new commit. → Finish: no step the run took has a gate, so nothing moves.
    const head = await commit(repo, "second.txt");
    const moved = await runner.pipelinePosition(card.id);
    if (trivialTo === "finish") {
      expect(moved).toMatchObject({ position: { kind: "complete" } });
      continue;
    }
    // → Review: its result was for another head. Build was skipped and is not asked for.
    expect(moved).toMatchObject({ position: { kind: "step", stepId: card.review.id, satisfied: [{ stepId: card.understand.id, seq: 1 }], arrivals: [{ stepId: card.understand.id, seq: 1 }] } });
    const restarted = await runner.startPipelineRun(tasks.get(card.id)!, { restart: true });
    expect(restarted).toMatchObject({ resumed: { stepId: card.review.id, stepName: "Review", kept: [{ stepName: "Understand" }] } });
    const resumed = await settled(card.id, "done", 5);
    expect(names(card.id, resumed)).toEqual(["1 Understand succeeded", "2 Review succeeded", "3 Finish succeeded", "4 Review succeeded", "5 Finish succeeded"]);
    expect(promptOf(card.id, 4)).toContain('### From "Understand"');
    expect(readCheckLedger(card.id, resumed).filter((e) => e.checkId === "reviewed").map((e) => [e.seq, e.outcome, e.key.head === head])).toEqual([[2, "pass", false], [4, "pass", true]]);
    expect(tasks.stepsForParent(card.id).filter((t) => t.pipelineStepId === card.build.id)).toEqual([]);
    expect(await runner.pipelinePosition(card.id)).toMatchObject({ position: { kind: "complete" } });
  }
}, 180_000);

test("rewind: the step's and every later step's evidence is void in the ledger, history and git are kept, and the run goes on from the step", async () => {
  const repo = await repoWithChange();
  const card = await makeCard({ workdir: repo });
  gateOn(card.pipeline.id);
  await start(card.id);
  const first = await settled(card.id, "done", 4);
  const ledgerBefore = readFileSync(checkLedgerPath(card.id, first), "utf8");
  const head = await sh(repo, "git", "rev-parse", "HEAD");

  // What cannot be rewound to says why, and changes nothing.
  expect(await runner.rewindPipelineRun(card.id, { stepId: "no-such-step" })).toMatchObject({ status: 400 });
  expect(await runner.rewindPipelineRun(card.id, { stepId: undefined })).toMatchObject({ status: 400 });
  expect(readFileSync(checkLedgerPath(card.id, first), "utf8")).toBe(ledgerBefore);

  const rewound = await runner.rewindPipelineRun(card.id, { stepId: card.review.id });
  expect(rewound).toMatchObject({
    stepId: card.review.id, stepName: "Review", voided: ["Review", "Finish"], stopped: [],
    // The branch was never pushed: its one commit is not on the remote, and stays.
    unpushed: { count: 1, head, remoteHead: null },
  });
  const done = await settled(card.id, "done", 6);
  expect(names(card.id, done)).toEqual(["1 Understand succeeded", "2 Build succeeded", "3 Review succeeded", "4 Finish succeeded", "5 Review succeeded", "6 Finish succeeded"]);
  expect(done.startedAt).toBe(first.startedAt);
  expect(promptOf(card.id, 5)).toContain('### From "Build"');

  // Append-only: every earlier line is still there, byte for byte, with the void lines after it.
  const ledgerAfter = readFileSync(checkLedgerPath(card.id, done), "utf8");
  expect(ledgerAfter.startsWith(ledgerBefore)).toBe(true);
  const voids = readCheckLedger(card.id, done).filter((e) => e.outcome === "void");
  expect(voids.map((e) => [e.stepName, e.checkId, e.seq, e.detail])).toEqual([
    ["Review", STEP_VOID_CHECK_ID, 4, "rewound to Review by the owner"], ["Review", "reviewed", 4, "rewound to Review by the owner"],
    ["Finish", STEP_VOID_CHECK_ID, 4, "rewound to Review by the owner"],
  ]);
  expect(activity(card.id).some((l) => l.startsWith("Rewound to Review: the results of Review, Finish are void") && l.includes("1 commit not on the remote stay where they are"))).toBe(true);
  // Run again since the rewind: satisfied again.
  expect(await runner.pipelinePosition(card.id)).toMatchObject({ position: { kind: "complete" } });
  // Git was not touched.
  expect(await sh(repo, "git", "rev-parse", "HEAD")).toBe(head);
  expect(await sh(repo, "git", "status", "--porcelain")).toBe("");
  expect(await sh(repo, "git", "ls-remote", "origin", "refs/heads/claude/x")).toBe("");
}, 120_000);

test("rewind stops what is under way: a stopped step's visit ends as cancelled and stays in the history; a step never reached cannot be rewound to", async () => {
  const repo = await repoWithChange();
  // Review never hands off and has two ways on: the run stops there.
  const card = await makeCard({ workdir: repo, script: { review: "missing" } });
  gateOn(card.pipeline.id);
  await start(card.id);
  const stopped = await settled(card.id, "blocked", 3);
  expect(stopped.blocked.map((b) => b.kind)).toEqual(["handoff-missing"]);
  const reviewTask = stopped.active[0]!.taskId;

  const notYet = await runner.rewindPipelineRun(card.id, { stepId: card.finish.id });
  expect(notYet).toMatchObject({ status: 409 });
  expect("error" in notYet && notYet.error).toBe("Finish has not been reached in this run: Review has no finished visit to hand it");
  expect(runOf(card.id)).toEqual(stopped);

  const rewound = await runner.rewindPipelineRun(card.id, { stepId: card.build.id });
  expect(rewound).toMatchObject({ stepName: "Build", voided: ["Build", "Review", "Finish"], stopped: ["Review"] });
  const again = await settled(card.id, "blocked", 5);
  expect(names(card.id, again)).toEqual(["1 Understand succeeded", "2 Build succeeded", "3 Review cancelled", "4 Build succeeded", "5 Review null"]);
  expect(tasks.get(reviewTask)!.archivedAt).not.toBeNull();
  expect(again.active.map((a) => a.seq)).toEqual([5]);
  expect(promptOf(card.id, 4)).toContain('### From "Understand"');
}, 120_000);

test("feedback: the note is in the reopened step's prompt and each later step's once; without invalidate nothing is voided, with it the evidence is", async () => {
  const repo = await repoWithChange();
  const card = await makeCard({ workdir: repo });
  gateOn(card.pipeline.id);
  await start(card.id);
  const first = await settled(card.id, "done", 4);
  const ledgerBefore = readFileSync(checkLedgerPath(card.id, first), "utf8");

  for (const bad of [{ fromStepId: card.build.id, note: "   " }, { fromStepId: card.build.id, note: 7 }, { fromStepId: "nope", note: "x" }, { fromStepId: card.build.id, note: "x", invalidate: "yes" }]) {
    expect(await runner.steerPipelineRun(card.id, bad)).toMatchObject({ status: 400 });
  }
  expect(readFeedback(card.id, first)).toEqual([]);
  expect(runOf(card.id)).toEqual(first);

  // A refinement, from Build.
  const steered = await runner.steerPipelineRun(card.id, { fromStepId: card.build.id, note: "Use the existing retry helper instead of a new loop." });
  expect(steered).toMatchObject({ stepName: "Build", invalidated: false, voided: [], stopped: [] });
  const refined = await settled(card.id, "done", 7);
  expect(names(card.id, refined).slice(4)).toEqual(["5 Build succeeded", "6 Review succeeded", "7 Finish succeeded"]);
  expect(readFeedback(card.id, refined)).toMatchObject([{ fromStepId: card.build.id, note: "Use the existing retry helper instead of a new loop.", invalidate: false, seq: 4 }]);
  const buildPrompt = promptOf(card.id, 5);
  expect(buildPrompt).toContain("## Feedback from the owner");
  expect(buildPrompt).toContain("### Note (sent to this step)\n\nUse the existing retry helper instead of a new loop.");
  expect(buildPrompt).toContain("This is a refinement: the earlier work passed its checks and stays.");
  expect(buildPrompt).toContain('### From "Understand"');
  expect(promptOf(card.id, 6)).toContain("### Note (sent to Build, and passed on to the steps after it)");
  expect(promptOf(card.id, 7)).toContain("Use the existing retry helper instead of a new loop.");
  // Nothing was voided: the ledger only grew by the new evaluations.
  expect(readFileSync(checkLedgerPath(card.id, refined), "utf8").startsWith(ledgerBefore)).toBe(true);
  expect(readCheckLedger(card.id, refined).some((e) => e.outcome === "void")).toBe(false);
  expect(activity(card.id).some((l) => l.startsWith("Feedback sent to Build (and passed on to Review, Finish)") && l.includes("a refinement: earlier results stand"))).toBe(true);

  // With invalidate, from Review: its evidence is void, and the first note —
  // which every step has read once — is not repeated.
  const voided = await runner.steerPipelineRun(card.id, { fromStepId: card.review.id, note: "The error message must name the file.", invalidate: true });
  expect(voided).toMatchObject({ stepName: "Review", invalidated: true, voided: ["Review", "Finish"] });
  const redone = await settled(card.id, "done", 9);
  expect(names(card.id, redone).slice(7)).toEqual(["8 Review succeeded", "9 Finish succeeded"]);
  const reviewPrompt = promptOf(card.id, 8);
  expect(reviewPrompt).toContain("The error message must name the file.");
  expect(reviewPrompt).toContain("The owner voided the earlier results of this step with it");
  expect(reviewPrompt).not.toContain("Use the existing retry helper");
  expect(readCheckLedger(card.id, redone).filter((e) => e.outcome === "void").map((e) => [e.stepName, e.checkId, e.seq])).toEqual([
    ["Review", STEP_VOID_CHECK_ID, 7], ["Review", "reviewed", 7], ["Finish", STEP_VOID_CHECK_ID, 7],
  ]);
  expect(readFeedback(card.id, redone).map((n) => [n.invalidate, n.seq])).toEqual([[false, 4], [true, 7]]);
}, 120_000);

test("the owner's Retry of a step stopped on its checks runs the checks first: no turn when they pass now, a feedback turn when one still fails", async () => {
  const repo = await repoWithChange();
  const flag = path.join(mkdtempSync(path.join(tmpdir(), "agetor-position-flag-")), "flag");
  const card = await makeCard({ workdir: repo, build: { checks: [cmd("flag", `echo "no flag"; test -f ${flag}`)], maxTurns: 1 } });
  gateOn(card.pipeline.id);
  await start(card.id);
  // Understand; Build's visit and its fresh session each fail after one feedback turn.
  const stopped = await settled(card.id, "blocked", 3);
  expect(stopped.blocked.map((b) => b.kind)).toEqual(["check-failed"]);
  const visit = stopped.history.at(-1)!;
  expect(visit).toMatchObject({ seq: 3, outcome: null, gate: { state: "owner", turns: 1, max: 1 } });
  const feedbackTurns = () => sentTo(visit.taskId).filter((m) => m.startsWith(CHECK_FEEDBACK_MARKER)).length;
  const turns = () => runs.listForTask(visit.taskId).length;
  expect(feedbackTurns()).toBe(1);

  // Still failing: the checks run, and the step is sent back with the output under a new allowance.
  expect("error" in await runner.retryPipelineStep(card.id, { checksFirst: true })).toBe(false);
  const still = await waitFor(() => (feedbackTurns() === 2 && runOf(card.id).status === "blocked" ? runOf(card.id) : null), "the second feedback turn to end in a stop");
  expect(still.history.at(-1)).toMatchObject({ seq: 3, outcome: null, gate: { state: "owner", turns: 2, max: 2 } });
  expect(still.stepCount).toBe(3);

  // The owner fixes it: Retry runs the checks, they pass, and the run moves on with no turn for Build.
  writeFileSync(flag, "");
  const before = turns();
  expect("error" in await runner.retryPipelineStep(card.id, { checksFirst: true })).toBe(false);
  const done = await settled(card.id, "done", 5);
  expect(turns()).toBe(before);
  expect(feedbackTurns()).toBe(2);
  expect(done.history.find((h) => h.seq === 3)).toMatchObject({ outcome: "succeeded", nextStepIds: [card.review.id], gate: { state: "passed" } });
  expect(activity(card.id).filter((l) => l === "Retry: running the stopped step's checks again before giving it a turn")).toHaveLength(2);
}, 120_000);
