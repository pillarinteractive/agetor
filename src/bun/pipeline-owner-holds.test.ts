import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineRunState } from "../shared/types.ts";

// No owner holds (src/shared/owner-holds.ts, the runner's
// `resolveOwnerHolds`): an unattended card's stops resolve by themselves.
// Same bootstrap as pipeline-unattended.test.ts. No GitHub: the follow-up
// issue and the committed-work check are stubbed (`ownerHoldDeps`). The ladder
// pass is driven by hand; nothing here sleeps or measures time.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-owner-holds-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const BLOCK_ENV = ["AGETOR_FAKE_CLAUDE_BLOCKED_REASON", "AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS", "AGETOR_FAKE_CLAUDE_BLOCKED_WAITING", "AGETOR_FAKE_CLAUDE_BLOCKED_NEXT"];
const HOUR = 3_600_000;
let parents: string[] = [];
let filed: { key: string; title: string; body: string }[] = [];
let commits = false;

// Other test files leave step rows behind in this shared process; without
// room of its own a step here would queue behind them (as merge-rework.test.ts).
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
  for (const k of BLOCK_ENV) delete process.env[k];
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
  filed = [];
  commits = false;
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

async function stubs() {
  const { ownerHoldDeps, blockWaitDeps } = await import("./pipeline-runner.ts");
  let next = 500;
  const byKey = new Map<string, number>();
  ownerHoldDeps.fileIssue = async (input) => {
    filed.push(input);
    // Deduplicated by key, as the ledger does.
    const n = byKey.get(input.key) ?? ++next;
    const reused = byKey.has(input.key);
    byKey.set(input.key, n);
    return { number: n, url: `https://github.com/o/r/issues/${n}`, reused };
  };
  ownerHoldDeps.hasCommits = async () => commits;
  ownerHoldDeps.pending = () => [];
  blockWaitDeps.rng = () => 0;
  return ownerHoldDeps;
}

/** Build → Review → Finish (Review may send back to Build, Finish ends the
 *  run). `suffix` per step is the fake agent's behaviour. */
async function start(suffix: { build: string; review?: string; finish?: string }, opts: { unattended?: boolean; single?: boolean } = {}) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines, preferences } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { PIPELINE_DECISIONS_PREF } = await import("../shared/pipeline-decisions.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-owner-holds-wd-"));
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: "agent-followups", projects: opts.unattended === false ? [] : [workdir] }));
  const profile = agentProfiles.insert({
    name: `owner-holds-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, s: string) => newStep({ name, agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${s}` });
  const build = step("Build", suffix.build);
  const review = step("Review", suffix.review ?? "Finish");
  const finish = { ...step("Finish", suffix.finish ?? "done"), canFinish: true };
  const graph = opts.single
    ? { steps: [build], edges: [], startStepId: build.id }
    : {
      steps: [build, review, finish],
      edges: [
        { id: "e1", from: build.id, to: review.id, label: "" },
        { id: "e2", from: review.id, to: build.id, label: "changes requested" },
        { id: "e3", from: review.id, to: finish.id, label: "approved" },
        { id: "e4", from: finish.id, to: build.id, label: "verification failed" },
      ],
      startStepId: build.id,
    };
  const pipeline = pipelines.insert({ name: `owner-holds-${randomUUID()}`, graph, maxSteps: 25 });
  const created = await createTask({ title: "owner holds", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, review, finish, workdir };
}

const runOf = async (id: string) => (await import("./db.ts")).tasks.get(id)!.pipelineRun!;
/** The run once it stopped (blocked, nothing live) and `pred` holds. */
async function settled(parentId: string, pred: (run: PipelineRunState) => boolean = () => true): Promise<PipelineRunState> {
  const { tasks } = await import("./db.ts");
  const { isTaskRunLive } = await import("./orchestrator.ts");
  return waitFor(() => {
    const run = tasks.get(parentId)?.pipelineRun;
    return run?.status === "blocked" && run.active.every((a) => !isTaskRunLive(a.taskId)) && pred(run) ? run : undefined;
  });
}
const { runs: runRows } = await import("./db.ts");
const userTurns = (taskId: string) => runRows.listForTask(taskId).flatMap((r) => runRows.events(r.id)).filter((e) => e.stream === "user").map((e) => e.data);
const counters = (run: PipelineRunState) => Object.values(run.ladder?.steps ?? {})[0];

test("an owner question on Build: answered in place, then one fresh session, then closed out on a filed issue — and it resumes when that issue is closed", async () => {
  const { resolveOwnerHolds, releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  const { readBlockLog } = await import("./block-log.ts");
  await stubs();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "needs a product decision";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Use the v2 schema or keep v1?"]);
  const { parentId, build } = await start({ build: "blocked" }, { single: true });

  // The old owner hold: recorded as before, and read as being resolved.
  let run = await settled(parentId, (r) => r.blocked.some((b) => b.kind === "step-blocked"));
  expect(run.ladder?.resolving?.note).toContain("Build: needs a product decision");
  const buildTask = run.active[0]!.taskId;

  // Rung 1: the same step, its own session, the answer.
  expect(await resolveOwnerHolds()).toBe(1);
  run = await settled(parentId, (r) => counters(r)?.answers === 1 && r.blocked.length > 0);
  const answer = (userTurns(buildTask)).find((u) => u.startsWith("Nobody will answer this."));
  expect(answer).toContain('"Use the v2 schema or keep v1?"');
  expect(answer).toContain("take the recommended option (the planner's, or yours) as PROVISIONAL");
  expect(answer).toContain('"hardStop": {"kind": "credentials" | "destructive" | "protected"');
  expect(answer).toContain("agetor-await");
  expect(run.active.map((a) => a.taskId)).toEqual([buildTask]);

  // A restart mid-ladder loses nothing: the counters are on the stored run.
  expect((await runOf(parentId)).ladder!.steps[`${buildTask}#1`]).toEqual({ answers: 1, fresh: 0, reroutes: 0 });

  // Rung 2: Build gets one fresh session.
  expect(await resolveOwnerHolds()).toBe(1);
  run = await settled(parentId, (r) => counters(r)?.fresh === 1 && r.blocked.length > 0);
  expect(run.active.map((a) => a.taskId)).toEqual([buildTask]);

  // Rung 3: no commits, so a dependency wait on the issue filed for the owner.
  expect(await resolveOwnerHolds()).toBe(1);
  run = await runOf(parentId);
  expect(filed.length).toBe(1);
  expect(filed[0]!.title).toContain("Owner decision: Build");
  expect(filed[0]!.body).toContain("Use the v2 schema or keep v1?");
  expect(filed[0]!.body).toContain(`<!-- agetor-owner-hold:${filed[0]!.key} -->`);
  expect(run.status).toBe("blocked");
  expect(run.wait).toMatchObject({ category: "dependency", ref: "#501", what: "#501", state: "waiting", closeout: true, endless: true, deadline: Number.MAX_SAFE_INTEGER });
  expect(run.ladder?.closed).toMatchObject({ mode: "depend", issues: [501] });
  expect(run.ladder?.resolving).toBeUndefined();
  // Nothing more to do for the ladder: the queue has it.
  expect(await resolveOwnerHolds()).toBe(0);

  const lines = activity(parentId).filter((l) => l.startsWith("Resolving without you: "));
  expect(lines.length).toBe(3);
  expect(lines[2]).toContain("Filed #501 for the owner; the card waits on #501 and resumes by itself when it is closed");
  expect(readBlockLog().filter((e) => e.taskId === parentId).map((e) => e.resolution)).toEqual(["answered", "fresh-session", "closed-dependency"]);

  // Still open: the timer only re-checks, at any hour — it never escalates.
  blockWaitDeps.refState = async () => "open";
  expect(await releaseBlockWaits(Date.now() + 48 * HOUR)).toBe(0);
  expect((await runOf(parentId)).wait).toMatchObject({ state: "waiting", closeout: true });

  // Closed by the owner: a new allowance, and Build is resumed with it.
  blockWaitDeps.refState = async () => "closed";
  expect(await releaseBlockWaits(Date.now() + 49 * HOUR)).toBe(1);
  await waitFor(async () => (userTurns(buildTask)).some((u) => u.includes("#501 is closed")));
  run = await settled(parentId, (r) => !r.wait?.closeout);
  expect(run.ladder?.steps).toEqual(expect.any(Object));
  expect(run.ladder?.closed).toBeUndefined();
  expect(run.history.filter((h) => h.stepId === build.id).length).toBe(1);
});

test("a Review that still cannot proceed after its answer sends its reason back to Build", async () => {
  const { resolveOwnerHolds } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");
  await stubs();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "Only the owner can confirm that they accepted the residual in #1497";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Did you accept the residual in #1497?"]);
  const { parentId, build, review } = await start({ build: "Review", review: "blocked" });
  let run = await settled(parentId, (r) => r.active.some((a) => a.stepId === review.id));
  expect(await resolveOwnerHolds()).toBe(1); // answer
  run = await settled(parentId, (r) => counters(r)?.answers === 1 && r.blocked.length > 0);
  expect(await resolveOwnerHolds()).toBe(1); // reroute
  const rerouted = await waitFor(() => {
    const r = tasks.get(parentId)?.pipelineRun;
    return r && r.history.length >= 3 && r.history[2]!.stepId === build.id ? r : undefined;
  });
  expect(rerouted.ladder!.reroutes).toBe(1);
  expect(rerouted.history[1]).toMatchObject({ stepId: review.id, outcome: "failed" });
  const prompt = tasks.get(rerouted.history[2]!.taskId)!.prompt;
  expect(prompt).toContain("Review could not proceed, and nobody will answer");
  expect(prompt).toContain("Only the owner can confirm that they accepted the residual in #1497");
  expect(activity(parentId).some((l) => l.startsWith("Resolving without you: Review could not proceed — sent its reason back to Build"))).toBe(true);
  // Park it: the fake Review would block again.
  (await import("./db.ts")).preferences.set("owner_holds", "park");
});

test("a declared hard stop is confirmed once, then goes straight to the close-out: committed work is published through Finish, nothing is merged", async () => {
  const { resolveOwnerHolds } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");
  await stubs();
  commits = true;
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "the registry needs a token this agent does not have";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ hardStop: { kind: "credentials", detail: "NPM_TOKEN for the private registry" } });
  const { parentId, review, finish } = await start({ build: "Review", review: "blocked" });
  let run = await settled(parentId, (r) => r.active.some((a) => a.stepId === review.id));
  expect(run.history.find((h) => h.stepId === review.id)!.handoff!.hardStop).toEqual({ kind: "credentials", detail: "NPM_TOKEN for the private registry" });
  expect(await resolveOwnerHolds()).toBe(1); // the confirming answer
  const reviewTask = run.active[0]!.taskId;
  run = await settled(parentId, (r) => counters(r)?.answers === 1 && r.blocked.length > 0);
  expect((userTurns(reviewTask)).find((u) => u.startsWith("Nobody will answer"))).toContain("You declared a hard stop (credentials");
  expect(await resolveOwnerHolds()).toBe(1); // close-out: no reroute, no fresh session
  const done = await waitFor(() => (tasks.get(parentId)?.pipelineRun?.status === "done" ? tasks.get(parentId)!.pipelineRun! : undefined));
  expect(done.ladder!.reroutes).toBe(0);
  expect(Object.values(done.ladder!.steps)[0]).toMatchObject({ answers: 1, fresh: 0, reroutes: 0 });
  expect(done.ladder!.closed).toMatchObject({ mode: "publish", issues: [501] });
  expect(done.capWrapUp).toMatchObject({ closeout: { issues: [501] } });
  expect(filed[0]!.body).toContain("**Hard stop:** credentials — NPM_TOKEN for the private registry");
  const last = done.history.at(-1)!;
  expect(last.stepId).toBe(finish.id);
  const prompt = tasks.get(last.taskId)!.prompt;
  expect(prompt).toContain("## Closing out without the owner — wrap up this run");
  expect(prompt).toContain("Agetor already filed #501");
  expect(prompt).toContain("Do not merge it.");
  expect(prompt).toContain("published unapproved");
});

test('owner_holds "park" restores the old outcome: the card waits for you', async () => {
  const { resolveOwnerHolds } = await import("./pipeline-runner.ts");
  const { preferences } = await import("./db.ts");
  await stubs();
  preferences.set("owner_holds", "park");
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Which option?"]);
  const { parentId } = await start({ build: "blocked" }, { single: true });
  const run = await settled(parentId, (r) => r.blocked.some((b) => b.kind === "step-blocked"));
  expect(run.ladder?.resolving).toBeUndefined();
  expect(await resolveOwnerHolds()).toBe(0);
  const after = await runOf(parentId);
  expect(after.ladder).toBeUndefined();
  expect(after.blocked.map((b) => b.kind)).toEqual(["step-blocked"]);
  expect(filed).toEqual([]);
});

test("a card a person runs is left as it was", async () => {
  const { resolveOwnerHolds } = await import("./pipeline-runner.ts");
  await stubs();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS = JSON.stringify(["Which option?"]);
  const { parentId } = await start({ build: "blocked" }, { single: true, unattended: false });
  await settled(parentId, (r) => r.blocked.some((b) => b.kind === "step-blocked"));
  expect(await resolveOwnerHolds()).toBe(0);
  expect((await runOf(parentId)).ladder).toBeUndefined();
});

test("a Stop the user pressed is never resumed by the ladder, until a person starts the step again", async () => {
  const { resolveOwnerHolds, cancelPipelineRun, retryPipelineStep } = await import("./pipeline-runner.ts");
  await stubs();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "waiting for #77 to merge";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#77" });
  const { parentId } = await start({ build: "blocked" }, { single: true });
  await settled(parentId, (r) => r.wait?.state === "waiting");
  const stopped = await cancelPipelineRun(parentId);
  expect("error" in stopped).toBe(false);
  const run = await runOf(parentId);
  expect(run.ladder?.userStop).toEqual(expect.any(Number));
  expect(run.wait).toBeUndefined();
  expect(run.status).toBe("blocked");
  expect(await resolveOwnerHolds()).toBe(0);
  expect(await resolveOwnerHolds()).toBe(0);
  expect((await runOf(parentId)).blocked.length).toBe(1);
  expect(filed).toEqual([]);
  // A person's Retry: the step runs again and the mark is gone.
  expect("error" in (await retryPipelineStep(parentId))).toBe(false);
  await settled(parentId, (r) => r.ladder?.userStop == null && r.wait?.state === "waiting");
});

test("an unattended dependency wait is never escalated at 24 hours: it is re-checked at the long interval", async () => {
  const { releaseBlockWaits, blockWaitDeps } = await import("./pipeline-runner.ts");
  await stubs();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "waiting for #77 to merge";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "dependency", waitingRef: "#77" });
  const { parentId } = await start({ build: "blocked" }, { single: true });
  const run = await settled(parentId, (r) => r.wait?.state === "waiting");
  expect(run.wait).toMatchObject({ category: "dependency", ref: "#77", endless: true, deadline: Number.MAX_SAFE_INTEGER });
  blockWaitDeps.refState = async () => "open";
  expect(await releaseBlockWaits(Date.now() + 25 * HOUR)).toBe(0);
  const later = await runOf(parentId);
  expect(later.wait?.state).toBe("waiting");
  expect(later.wait?.at).toBeGreaterThan(Date.now() + 25 * HOUR);
  expect(activity(parentId).some((l) => l.includes("left for you"))).toBe(false);
});

test("a question a step asks in an unattended run is answered automatically, never approved", async () => {
  const { resolveOwnerHolds, ownerHoldDeps } = await import("./pipeline-runner.ts");
  await stubs();
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON = "fixture never came up";
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING = JSON.stringify({ waitingOn: "environment" });
  const { parentId } = await start({ build: "blocked" }, { single: true });
  const run = await settled(parentId, (r) => r.wait?.state === "waiting");
  const stepTask = run.active[0]!.taskId;
  const asked = { kind: "ask_questions" as const, id: "q1", taskId: stepTask, runId: "r", questions: [{ question: "Ship with v1 or v2?", options: [{ label: "v1" }, { label: "v2" }] }], createdAt: 0 };
  const answered: { id: string; note: string }[] = [];
  ownerHoldDeps.pending = (taskId) => (taskId === stepTask && answered.length === 0 ? [asked] : []);
  ownerHoldDeps.answerInteraction = async (req, note) => {
    answered.push({ id: req.id, note });
    return true;
  };
  expect(await resolveOwnerHolds()).toBe(1);
  expect(answered.map((a) => a.id)).toEqual(["q1"]);
  expect(answered[0]!.note).toContain('"Ship with v1 or v2?"');
  expect(answered[0]!.note).toContain("the question you asked was not shown to anyone");
  expect((await runOf(parentId)).ladder!.steps[`${stepTask}#1`]!.interactions).toBe(1);
  ownerHoldDeps.answerInteraction = async (req, note) => (await import("./owner-hold-io.ts")).answerPendingInteraction(req, note);
});

test("follow-up issues are deduplicated across stops by the local ledger: the same item reuses its issue without a second create", async () => {
  const { fileOwnerHoldIssue } = await import("./owner-hold-io.ts");
  writeFileSync(path.join(dataDir, "owner-hold-followups.json"), JSON.stringify({ k1: { state: "filed", number: 1502, url: "https://github.com/o/r/issues/1502", at: 1 } }));
  // A directory with no GitHub remote: a create would fail, a reuse never asks.
  const r = await fileOwnerHoldIssue({ dir: mkdtempSync(path.join(tmpdir(), "agetor-owner-holds-nogit-")), key: "k1", title: "t", body: "b" });
  expect(r).toEqual({ number: 1502, url: "https://github.com/o/r/issues/1502", reused: true });
});
