import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineRunState, PipelineStep, StepCheck, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Checks on working steps, end to end through the runner (Stage 2 of
// docs/plans/check-gated-pipeline.md). The agent is the scripted fake; a
// check is a trivial shell command that reads a counter or a flag file, or a
// built-in against a temporary git repository. Nothing is pushed and GitHub
// is never called. Same bootstrap as pipeline-edge-cap.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-check-gates-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { tasks, preferences, pipelines, agentProfiles, runs, dataDir } = await import("./db.ts");
const { newStep, CHECK_FEEDBACK_MARKER } = await import("../shared/pipeline.ts");
const { COMPOSED_HANDOFF_MARK } = await import("../shared/checks.ts");
const { PIPELINE_GATES_PREF } = await import("../shared/publish.ts");
const { STEP_SLOTS_PREF, slotUse } = await import("./step-slots.ts");
const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
const { checkDeps, checkLedgerPath, readCheckLedger } = await import("./check-runner.ts");
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
/** Where a run is, for a timeout's message. */
const where = (id: string) => {
  const run = runOf(id);
  return JSON.stringify({ status: run.status, stepCount: run.stepCount, active: run.active.map((a) => a.seq), blocked: run.blocked.map((b) => `${b.kind}: ${b.message}`), history: run.history.map((h) => [h.seq, h.outcome, h.responseKind, h.gate]) });
};
const settled = async (id: string, status: PipelineRunState["status"]) => {
  try {
    return await waitFor(() => (runOf(id).status === status ? runOf(id) : null), `run ${status}`);
  } catch (e) {
    throw new Error(`${(e as Error).message} — ${where(id)}`);
  }
};
/** Every message sent into a step task's conversation. */
const sentTo = (taskId: string): string[] => runs.listForTask(taskId).flatMap((r) => runs.events(r.id).filter((e) => e.stream === "user").map((e) => e.data));
const visits = (run: PipelineRunState, step: PipelineStep) => run.history.filter((h) => h.stepId === step.id).sort((a, b) => a.seq - b.seq);

const scratch = () => mkdtempSync(path.join(tmpdir(), "agetor-check-gates-wd-"));
const cmd = (id: string, command: string, o: Partial<StepCheck> = {}): StepCheck => ({ id, description: `${id} holds`, run: { kind: "command", command }, required: true, timeoutSec: 120, ...o });
/** Fails the first `times` times it is run, then passes; says which attempt it is. */
const failsFirst = (file: string, times: number) => `n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; echo "attempt $((n+1)): expected the flag"; [ "$n" -ge ${times} ]`;
const timesRun = (file: string) => (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0);

/** Build → Review → Finish with scripted agents: each step hands off to the
 *  step named in `script` ("missing" writes no handoff at all). */
async function makeCard(o: {
  build?: Partial<PipelineStep>; review?: Partial<PipelineStep>; script?: { build?: string; review?: string; finish?: string }; workdir?: string; maxSteps?: number;
} = {}) {
  const profile = agentProfiles.insert({
    name: `check-gates-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, next: string, extra: Partial<PipelineStep> = {}) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do the ${name} work. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${next}`, ...extra });
  // `checks: []` unless a test says otherwise: the scratch directories are
  // not git repositories, so the built-in defaults have nothing to read.
  const build = step("Build", o.script?.build ?? "Review", { checks: [], ...o.build });
  const review = step("Review", o.script?.review ?? "Finish", { checks: [], ...o.review });
  const finish = step("Finish", o.script?.finish ?? "done", { canFinish: true });
  const graph = {
    steps: [build, review, finish],
    edges: [
      { id: "build-review", from: build.id, to: review.id, label: "" },
      { id: "review-build", from: review.id, to: build.id, label: "changes requested" },
      { id: "review-finish", from: review.id, to: finish.id, label: "approved" },
    ],
    startStepId: build.id,
  };
  const pipeline = pipelines.insert({ name: `check-gates-${randomUUID()}`, graph, maxSteps: o.maxSteps ?? 9 });
  const created = await createTask({ title: "check gates", prompt: "goal", workdir: o.workdir ?? scratch(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  return { id: created.task.id, pipeline, build, review, finish };
}

const gateOn = (pipelineName: string, cards?: string[]) =>
  preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ steps: { pipelines: [pipelineName], ...(cards ? { cards } : {}) } }));
async function start(id: string) {
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
}

test("switch off: a step with a failing check advances on its handoff exactly as before — no check is run, no ledger is written", async () => {
  const dir = scratch();
  const counter = path.join(dir, "count");
  const card = await makeCard({ build: { goal: "The change is committed.", checks: [cmd("flag", failsFirst(counter, 99))], maxTurns: 1 } });
  // Named for another card only: this one is not in the trial.
  gateOn(card.pipeline.name, ["some-other-card"]);
  await start(card.id);
  const run = await settled(card.id, "done");
  expect(run.snapshot!.gates).toBeUndefined();
  expect(run.stepCount).toBe(3);
  expect(run.history.map((h) => [h.outcome, h.gate])).toEqual([["succeeded", undefined], ["succeeded", undefined], ["succeeded", undefined]]);
  expect(timesRun(counter)).toBe(0);
  expect(existsSync(checkLedgerPath(card.id, run))).toBe(false);
  const prompt = tasks.get(run.history[0]!.taskId)!.prompt;
  expect(prompt).not.toContain("Checks this step must pass");
  expect(prompt).not.toContain("Step goal");
  // The template still carries the gate: it is only not in force.
  expect(run.snapshot!.graph.steps[0]).toMatchObject({ goal: "The change is committed.", maxTurns: 1, checks: [{ id: "flag" }] });
}, 90_000);

test("a failed check goes back to the same step, in its own session: no new launch, no step counted, and the run advances once it passes", async () => {
  const dir = scratch();
  const counter = path.join(dir, "count");
  const card = await makeCard({ build: { goal: "The flag is set.", checks: [cmd("flag", failsFirst(counter, 1))] } });
  gateOn(card.pipeline.name, [card.id, "another-card"]);
  await start(card.id);
  expect(runOf(card.id).snapshot!.gates).toEqual({ steps: true });
  const run = await settled(card.id, "done");

  // Build ran twice as turns of ONE step task; the run still counts three launches.
  expect(run.stepCount).toBe(3);
  const [buildVisit, ...more] = visits(run, card.build);
  expect(more).toEqual([]);
  expect(buildVisit).toMatchObject({ seq: 1, outcome: "succeeded", nextStepIds: [card.review.id], gate: { state: "passed", turns: 1, max: 2, failed: [] } });
  expect(tasks.stepsForParent(card.id).filter((t) => t.pipelineStepId === card.build.id)).toHaveLength(1);
  expect(timesRun(counter)).toBe(2);

  // What the agent was told up front, and what came back when the check failed.
  const prompt = tasks.get(buildVisit!.taskId)!.prompt;
  expect(prompt).toContain("## Step goal\n\nWhat must be true when this step ends: The flag is set.\n\n## Your step");
  expect(prompt).toContain("## Checks this step must pass");
  expect(prompt).toContain("- `flag` — flag holds");
  const feedback = sentTo(buildVisit!.taskId).filter((m) => m.startsWith(CHECK_FEEDBACK_MARKER));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain("The step's goal: The flag is set.");
  expect(feedback[0]).toContain("### `flag` — failed (exit 1)");
  expect(feedback[0]).toContain("attempt 1: expected the flag");
  expect(feedback[0]).toContain("check-feedback turn 1 of 2");
  expect(activity(card.id).some((l) => l.includes("sent back to Build in its own session (check-feedback turn 1 of 2)"))).toBe(true);

  // The ledger: two evaluations of the one visit, the failure first.
  expect(readCheckLedger(card.id, run).map((e) => [e.stepName, e.seq, e.turn, e.checkId, e.outcome, e.exitCode])).toEqual([
    ["Build", 1, 1, "flag", "fail", 1], ["Build", 1, 2, "flag", "pass", 0],
  ]);
  expect(run.history.map((h) => h.outcome)).toEqual(["succeeded", "succeeded", "succeeded"]);
}, 90_000);

test("still failing after maxTurns: one fresh session with the failures as its arrival, then the owner; Retry gives a new allowance", async () => {
  const dir = scratch();
  const flag = path.join(dir, "flag");
  const card = await makeCard({ build: { checks: [cmd("flag", `echo "no ${flag}"; test -f ${flag}`)], maxTurns: 1 } });
  gateOn(card.pipeline.name);
  await start(card.id);
  const run = await settled(card.id, "blocked");

  // Visit 1: its turn, one feedback turn, ended. Visit 2: the fresh session, the same again, then the owner.
  const [first, fresh, ...more] = visits(run, card.build);
  expect(more).toEqual([]);
  expect(run.stepCount).toBe(2); // the fresh session is a launch; the feedback turns are not
  expect(first).toMatchObject({ seq: 1, outcome: "failed", nextStepIds: [card.build.id], gate: { state: "exhausted", turns: 1, max: 1, failed: ["flag"] } });
  expect(first!.handoff!.summary.startsWith(COMPOSED_HANDOFF_MARK)).toBe(true);
  expect(fresh).toMatchObject({ seq: 2, outcome: null, gate: { state: "owner", turns: 1, max: 1, failed: ["flag"] } });
  expect(fresh!.taskId).not.toBe(first!.taskId);
  const freshPrompt = tasks.get(fresh!.taskId)!.prompt;
  expect(freshPrompt).toContain(COMPOSED_HANDOFF_MARK);
  expect(freshPrompt).toContain("You are the one fresh session this step gets");
  expect(freshPrompt).toContain("`flag` — failed (exit 1)");
  expect(freshPrompt).toContain(`no ${flag}`);

  const block = run.blocked.find((b) => b.kind === "check-failed")!;
  expect(run.blocked).toHaveLength(1);
  expect(block).toMatchObject({ taskId: fresh!.taskId, stepId: card.build.id });
  expect(block.message).toContain('step "Build" still fails its required checks after 1 feedback turn and one fresh session: flag (exit 1)');
  expect(run.active.map((a) => a.seq)).toEqual([2]);
  // Review was never started on work that did not pass.
  expect(visits(run, card.review)).toEqual([]);
  expect(readCheckLedger(card.id, run).map((e) => [e.seq, e.turn, e.outcome])).toEqual([[1, 1, "fail"], [1, 2, "fail"], [2, 1, "fail"], [2, 2, "fail"]]);
  // A blocked step holds no slot.
  expect(slotUse(() => false, undefined, [tasks.get(card.id)!])).toEqual({ total: 0, heavy: 0 });

  // The owner fixes it and presses Retry: the step gets a turn, the checks pass, the run moves on.
  writeFileSync(flag, "");
  const retried = await runner.retryPipelineStep(card.id, { taskId: fresh!.taskId });
  expect("error" in retried).toBe(false);
  const done = await settled(card.id, "done");
  expect(visits(done, card.build)[1]).toMatchObject({ outcome: "succeeded", gate: { state: "passed", turns: 1, max: 2 } });
  expect(done.stepCount).toBe(4);
  expect(done.blocked).toEqual([]);
}, 90_000);

test("Advance past failing checks is recorded as a waiver", async () => {
  const dir = scratch();
  const card = await makeCard({ build: { checks: [cmd("never", "exit 4")], maxTurns: 0 } });
  gateOn(card.pipeline.name);
  await start(card.id);
  const run = await settled(card.id, "blocked");
  // maxTurns 0: no feedback turn at all — the fresh session, then the owner.
  expect(visits(run, card.build).map((h) => [h.outcome, h.gate?.state, h.gate?.turns])).toEqual([["failed", "exhausted", 0], [null, "owner", 0]]);
  expect(sentTo(visits(run, card.build)[1]!.taskId).some((m) => m.startsWith(CHECK_FEEDBACK_MARKER))).toBe(false);

  const advanced = await runner.advancePipeline(card.id, { nextStepIds: [card.review.id] });
  expect("error" in advanced).toBe(false);
  const done = await settled(card.id, "done");
  expect(visits(done, card.build)[1]).toMatchObject({ outcome: "advanced-manually", nextStepIds: [card.review.id] });
  expect(readCheckLedger(card.id, done).map((e) => [e.seq, e.checkId, e.outcome, e.satisfied])).toEqual([
    [1, "never", "fail", false], [2, "never", "fail", false], [2, "never", "waived", false],
  ]);
  expect(activity(card.id).some((l) => l.includes("Advanced past Build's failing checks (never) — recorded as waived"))).toBe(true);
  void dir;
}, 90_000);

test("a handoff still missing after the reminder, with the checks passing: the run advances on a handoff Agetor composes", async () => {
  const card = await makeCard({ build: { checks: [cmd("ok", "true")] }, script: { build: "missing" } });
  gateOn(card.pipeline.name);
  await start(card.id);
  const run = await settled(card.id, "done");

  const [buildVisit] = visits(run, card.build);
  expect(buildVisit).toMatchObject({ outcome: "succeeded", responseKind: "handoff-missing", nextStepIds: [card.review.id], reminder: { delivered: true }, gate: { state: "passed", turns: 0, composed: true } });
  const h = buildVisit!.handoff!;
  expect(h.status).toBe("done");
  expect(h.next).toBe("Review");
  for (const field of [h.purpose, h.summary, h.reason]) expect(field.startsWith(COMPOSED_HANDOFF_MARK)).toBe(true);
  expect(h.summary).toContain("Its required checks passed (ok)");
  expect(h.summary).toContain("I finished the work but forgot the handoff."); // the step's own last words
  // Never a block for the owner, and Review is told whose words it got.
  expect(run.blocked).toEqual([]);
  expect(run.stepCount).toBe(3);
  expect(tasks.get(visits(run, card.review)[0]!.taskId)!.prompt).toContain(COMPOSED_HANDOFF_MARK);
  expect(activity(card.id).some((l) => l.includes("moving on with a handoff composed by Agetor"))).toBe(true);
  // The checks ran once, after the reminder, not before it.
  expect(readCheckLedger(card.id, run).map((e) => [e.seq, e.turn, e.outcome])).toEqual([[1, 1, "pass"]]);
}, 90_000);

test("a missing handoff with the checks failing costs a same-step turn, not the owner", async () => {
  const dir = scratch();
  const counter = path.join(dir, "count");
  const card = await makeCard({ build: { checks: [cmd("flag", failsFirst(counter, 1))] }, script: { build: "missing" } });
  gateOn(card.pipeline.name);
  await start(card.id);
  const run = await settled(card.id, "done");
  const [buildVisit, ...more] = visits(run, card.build);
  expect(more).toEqual([]);
  // Reminder, then the failed check's feedback (which repeats the handoff contract), then composed.
  expect(buildVisit).toMatchObject({ outcome: "succeeded", gate: { state: "passed", turns: 1, composed: true } });
  const feedback = sentTo(buildVisit!.taskId).filter((m) => m.startsWith(CHECK_FEEDBACK_MARKER));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain("Nothing was handed to the next step.");
  expect(feedback[0]).toContain("End your final message with a NEW handoff block");
  expect(run.stepCount).toBe(3);
}, 90_000);

test("the Change shape's defaults on a real worktree: Build passes on its commit; a Review without a verdict is never advanced or composed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-check-gates-repo-"));
  const sh = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${await new Response(p.stderr).text()}`);
    return out.trim();
  };
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

  // No `checks` declared anywhere: the defaults. Review's turns are 0 so the chain is short.
  const card = await makeCard({ workdir: repo, build: { checks: undefined }, review: { checks: undefined, maxTurns: 0 } });
  gateOn(card.pipeline.name);
  await start(card.id);
  const run = await settled(card.id, "blocked");

  expect(visits(run, card.build)).toHaveLength(1);
  expect(visits(run, card.build)[0]).toMatchObject({ outcome: "succeeded", gate: { state: "passed", turns: 0 } });
  const buildPrompt = tasks.get(visits(run, card.build)[0]!.taskId)!.prompt;
  expect(buildPrompt).toContain("- `tree-clean` — ");
  expect(buildPrompt).toContain("- `diff-nonempty` — ");
  // The scripted Review hands off "Finish" with no reviewApproval: the verdict check fails.
  expect(visits(run, card.review).map((h) => [h.outcome, h.gate?.state, h.gate?.failed])).toEqual([["failed", "exhausted", ["review-verdict"]], [null, "owner", ["review-verdict"]]]);
  expect(tasks.get(visits(run, card.review)[0]!.taskId)!.prompt).toContain('In the handoff JSON add "reviewApproval"');
  expect(visits(run, card.finish)).toEqual([]);
  expect(run.blocked.map((b) => b.kind)).toEqual(["check-failed"]);
  expect(run.blocked[0]!.message).toContain('review-verdict (the handoff has no readable "reviewApproval")');
  const ledger = readCheckLedger(card.id, run);
  expect(ledger.filter((e) => e.stepName === "Build").map((e) => [e.checkId, e.outcome])).toEqual([["tree-clean", "pass"], ["diff-nonempty", "pass"]]);
  expect(ledger.filter((e) => e.stepName === "Review").map((e) => [e.seq, e.checkId, e.outcome])).toEqual([
    [2, "tree-clean", "pass"], [2, "review-verdict", "fail"], [3, "tree-clean", "pass"], [3, "review-verdict", "fail"],
  ]);
  const head = await sh(repo, "git", "rev-parse", "HEAD");
  expect(ledger.every((e) => e.key.head === head && e.key.tree && e.key.baseTip)).toBe(true);
  // Finish has no gate by default, and nothing was pushed or changed.
  expect(await sh(repo, "git", "status", "--porcelain")).toBe("");
  expect(await sh(repo, "git", "ls-remote", "origin", "refs/heads/claude/x")).toBe("");
}, 90_000);

test("a check that cannot be evaluated spends no turn of the step and waits for the owner", async () => {
  const card = await makeCard({ build: { checks: [cmd("tool", "true")] } });
  gateOn(card.pipeline.name);
  checkDeps.command = async () => ({ exitCode: null, timedOut: false, output: "spawn /bin/sh ENOENT" });
  await start(card.id);
  const run = await settled(card.id, "blocked");
  const [buildVisit, ...more] = visits(run, card.build);
  expect(more).toEqual([]);
  expect(buildVisit).toMatchObject({ outcome: null, gate: { state: "owner", turns: 0, failed: ["tool"] } });
  expect(buildVisit!.handoff?.next).toBe("Review"); // what the step said is kept for Advance
  expect(run.blocked[0]).toMatchObject({ kind: "check-failed", taskId: buildVisit!.taskId });
  expect(run.blocked[0]!.message).toContain("a required check could not be evaluated: tool (could not be started");
  expect(sentTo(buildVisit!.taskId).some((m) => m.startsWith(CHECK_FEEDBACK_MARKER))).toBe(false);
  expect(readCheckLedger(card.id, run).map((e) => e.outcome)).toEqual(["halt"]);
}, 90_000);

test("a started run adopts the gate only on an explicit refresh, and drops it the same way; the preference alone still switches it off at once", async () => {
  const dir = scratch();
  const counter = path.join(dir, "count");
  // Build's agent never hands off: the run stops on Build with the gate off.
  const card = await makeCard({ script: { build: "missing" } });
  await start(card.id);
  const stopped = await settled(card.id, "blocked");
  expect(stopped.blocked.map((b) => b.kind)).toEqual(["handoff-missing"]);

  // The template gains a gate and the preference names the card: the run is unchanged.
  const template = pipelines.get(card.pipeline.id)!;
  pipelines.update(card.pipeline.id, {
    name: template.name, graph: { ...template.graph, steps: template.graph.steps.map((s) => (s.id === card.build.id ? { ...s, goal: "Committed.", checks: [cmd("flag", failsFirst(counter, 0))], maxTurns: 3 } : s)) },
  });
  gateOn(card.pipeline.name, [card.id]);
  expect(runOf(card.id).snapshot!.gates).toBeUndefined();
  expect(runner.stepGateFor(tasks.get(card.id)!, runOf(card.id), card.build)).toBeNull();

  expect(await runner.adoptPipelineGates(card.id)).toEqual({ publish: false, steps: true, changed: true });
  const adopted = runOf(card.id);
  expect(adopted.snapshot!.gates).toEqual({ steps: true });
  expect(adopted.snapshot!.graph.steps.find((s) => s.id === card.build.id)).toMatchObject({ goal: "Committed.", maxTurns: 3, checks: [{ id: "flag" }] });
  // Text is not what a gates refresh copies.
  expect(adopted.snapshot!.graph.steps.find((s) => s.id === card.build.id)!.instructions).toBe(card.build.instructions);
  expect(adopted.status).toBe("blocked"); // a step in mid-visit is not switched or restarted
  const adoptedBuild = adopted.snapshot!.graph.steps.find((s) => s.id === card.build.id)!;
  expect(runner.stepGateFor(tasks.get(card.id)!, adopted, adoptedBuild)).toMatchObject({ goal: "Committed.", maxTurns: 3 });
  expect(activity(card.id).some((l) => l.includes("Check gates adopted: Build advances on checks Agetor runs"))).toBe(true);
  expect(await runner.adoptPipelineGates(card.id)).toEqual({ publish: false, steps: true, changed: false });

  // Taken out of the trial list: off at once, with no refresh.
  gateOn(card.pipeline.name, ["another-card"]);
  expect(runner.stepGateFor(tasks.get(card.id)!, runOf(card.id), adoptedBuild)).toBeNull();
  // …and the trial list's other entry is no card: the answer says so.
  expect(await runner.adoptPipelineGates(card.id)).toEqual({ publish: false, steps: false, changed: true, unmatched: { pipelines: [], cards: ["steps: another-card"] } });
  expect(runOf(card.id).snapshot!.gates).toBeUndefined();

  // Both gates at once: one preference, two entries, adopted together.
  preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ publish: { pipelines: [card.pipeline.name] }, steps: { pipelines: [card.pipeline.name], cards: [card.id] } }));
  expect(await runner.adoptPipelineGates(card.id)).toEqual({ publish: true, steps: true, changed: true });
  expect(runOf(card.id).snapshot!.gates).toEqual({ publish: true, steps: true });

  // Adopted — but the Build that is stopped was launched without the gate: retried, it is settled as before.
  gateOn(card.pipeline.name, [card.id]);
  await runner.adoptPipelineGates(card.id);
  const old = visits(runOf(card.id), card.build)[0]!;
  const retried = await runner.retryPipelineStep(card.id, { taskId: old.taskId });
  expect("error" in retried).toBe(false);
  await waitFor(() => (runs.listForTask(old.taskId).length >= 3 && runOf(card.id).status === "blocked" ? true : null), "the retried Build to stop again");
  expect(runOf(card.id).blocked.map((b) => b.kind)).toEqual(["handoff-missing"]);
  expect(visits(runOf(card.id), card.build)[0]!.gate).toBeUndefined();
  expect(timesRun(counter)).toBe(0);

  // The step's next launch is under the gate: its missing handoff is composed once its check passes.
  const advanced = await runner.advancePipeline(card.id, { nextStepIds: [card.build.id] });
  expect("error" in advanced).toBe(false);
  const done = await settled(card.id, "done");
  const launched = visits(done, card.build)[1]!;
  expect(launched).toMatchObject({ outcome: "succeeded", gate: { state: "passed", composed: true } });
  expect(tasks.get(launched.taskId)!.prompt).toContain("## Step goal\n\nWhat must be true when this step ends: Committed.");
  expect(timesRun(counter)).toBe(1);
}, 90_000);

// The trial's preference named the pipeline "Change"; it is called "Change:
// Understand, Build, Review, Finish". Nothing was gated and nothing said so.
test("a preference that names a pipeline by a prefix, or a card that is not there, gates nothing and says so", async () => {
  const card = await makeCard({ script: { build: "missing" } });
  await start(card.id);
  await settled(card.id, "blocked");
  const prefix = card.pipeline.name.slice(0, 11); // "check-gates"
  preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ publish: { pipelines: [prefix] }, steps: { pipelines: [prefix, card.pipeline.id], cards: [card.id, "no-such-card"] } }));
  expect(runner.pipelineGatesUnmatched()).toEqual({ pipelines: [`publish: ${prefix}`, `steps: ${prefix}`], cards: ["steps: no-such-card"] });

  // The id still matches for `steps`; `publish` named nothing real.
  expect(await runner.adoptPipelineGates(card.id)).toEqual({
    publish: false, steps: true, changed: true, unmatched: { pipelines: [`publish: ${prefix}`, `steps: ${prefix}`], cards: ["steps: no-such-card"] },
  });
  const said = () => activity(card.id).filter((l) => l.startsWith("pipeline_gates names what is not there"));
  expect(said()).toHaveLength(1);
  expect(said()[0]).toContain(`no pipeline has the id or the exact name "${prefix}"`);
  expect(said()[0]).toContain('no card has the id "no-such-card"');
  expect(said()[0]).toContain(`This card's pipeline is "${card.pipeline.name}" (id ${card.pipeline.id})`);
  // Said once per wording, not once per refresh.
  await runner.adoptPipelineGates(card.id);
  expect(said()).toHaveLength(1);

  // A refresh of the pipeline's runs carries it on each run's result.
  const results = await runner.refreshPipelineRuns(card.pipeline.id, { gates: true });
  expect(results.find((r) => r.taskId === card.id)!.gates).toMatchObject({ steps: true, unmatched: { cards: ["steps: no-such-card"] } });

  // The exact name in another case, and real ids only: nothing to report.
  preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ steps: { pipelines: [card.pipeline.name.toUpperCase()], cards: [card.id] } }));
  expect(runner.pipelineGatesUnmatched()).toBeNull();
  expect(await runner.adoptPipelineGates(card.id)).toEqual({ publish: false, steps: true, changed: false });
}, 90_000);

test("the run state's gate fields survive the store's sanitizer, and junk does not", async () => {
  const { parsePipelineRunState } = await import("./db.ts");
  const build = newStep({ id: "b", name: "Build", goal: "g", checks: [cmd("flag", "true")], maxTurns: 1 });
  const state = {
    pipelineId: "p", pipelineName: "Change", status: "blocked", active: [{ stepId: "b", taskId: "t", seq: 1 }], joins: {},
    blocked: [{ taskId: "t", stepId: "b", kind: "check-failed", message: "m" }, { taskId: "t2", stepId: "b", kind: "made-up", message: "m" }],
    history: [
      { seq: 1, stepId: "b", taskId: "t", startedAt: 1, endedAt: null, outcome: null, handoff: null, nextStepIds: [], gate: { state: "feedback", turns: 1, max: 2, failed: ["flag", 3], at: 9, composed: true, extra: "x" } },
      { seq: 2, stepId: "b", taskId: "u", startedAt: 1, endedAt: null, outcome: null, handoff: null, nextStepIds: [], gate: { state: "dreaming", turns: 1 } },
    ],
    stepCount: 2, startedAt: 1, endedAt: null,
    snapshot: { graph: { steps: [build], edges: [], startStepId: "b" }, maxSteps: 9, profiles: {}, capturedAt: 1, gates: { publish: "yes", steps: true, other: true } },
  };
  const parsed = parsePipelineRunState(JSON.stringify(state))!;
  expect(parsed.snapshot!.gates).toEqual({ steps: true });
  expect(parsed.snapshot!.graph.steps[0]).toMatchObject({ goal: "g", maxTurns: 1, checks: [{ id: "flag" }] });
  expect(parsed.blocked.map((b) => b.kind)).toEqual(["check-failed"]);
  expect(parsed.history[0]!.gate).toEqual({ state: "feedback", turns: 1, max: 2, failed: ["flag"], at: 9, composed: true });
  expect(parsed.history[1]!.gate).toBeUndefined();
  expect(parsePipelineRunState(JSON.stringify({ ...state, snapshot: { ...state.snapshot, gates: { publish: true } } }))!.snapshot!.gates).toEqual({ publish: true });
  expect("gates" in parsePipelineRunState(JSON.stringify({ ...state, snapshot: { ...state.snapshot, gates: {} } }))!.snapshot!).toBe(false);
  void ({} as Task);
}, 90_000);
