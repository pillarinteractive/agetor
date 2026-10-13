import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineEdge, Task, TaskPrStatus } from "../shared/types.ts";

// A failure the merge queue finds after a reviewed pipeline finished goes
// back through Build → Review → Finish instead of an unreviewed follow-up
// (src/bun/merge-rework.ts). Same bootstrap as pipeline-unattended.test.ts:
// real runner, fake agents that hand off as their step's marker says.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-merge-rework-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const rework = await import("./merge-rework.ts");
const realDeps = { ...rework.reworkDeps };
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
  Object.assign(rework.reworkDeps, realDeps);
  rework.resetReworkForTests();
  const { stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  stopPipelineAutoRetryTimers();
  const { tasks, preferences } = await import("./db.ts");
  preferences.set(rework.MERGE_REWORK_PREF, "{}");
  const { setMergeQueued } = await import("./merge-intent.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) {
    setMergeQueued(id, false);
    if (tasks.get(id)) await deleteTask(id).catch(() => {});
  }
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

const HEAD = "a".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/777/job/1";

/** Start a card on the Change pipeline's shape (or, `reviewed: false`, on
 *  Build → Finish with no Review) and let its fake steps run it to `done`. */
async function finishedCard(opts: { reviewed?: boolean; signedOff?: boolean } = {}) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines, tasks } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { setMergeQueued } = await import("./merge-intent.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-merge-rework-wd-"));
  const profile = agentProfiles.insert({
    name: `rework-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, next: string, canFinish = false) =>
    ({ ...newStep({ name, agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${next}` }), ...(canFinish ? { canFinish: true } : {}) });
  const understand = step("Understand", "Build", true), build = step("Build", "Review"), review = step("Review", "Finish"), finish = step("Finish", "done", true);
  const edge = (from: { id: string }, to: { id: string }, label: string): PipelineEdge => ({ id: randomUUID(), from: from.id, to: to.id, label });
  const graph = opts.reviewed === false
    ? { steps: [understand, build, finish], edges: [edge(understand, build, "build"), edge(build, finish, ""), edge(finish, build, "verification failed")], startStepId: understand.id }
    : {
      steps: [understand, build, review, finish],
      edges: [
        edge(understand, build, "build"), edge(build, review, ""), edge(review, build, "changes requested"),
        edge(review, finish, "approved"), edge(finish, build, "verification failed"),
      ],
      startStepId: understand.id,
    };
  const pipeline = pipelines.insert({ name: `rework-${randomUUID()}`, graph, maxSteps: 4 });
  const created = await createTask({ title: "rework", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  parents.push(id);
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => tasks.get(id)?.pipelineRun?.status === "done");
  if (opts.signedOff !== false) {
    setMergeQueued(id, true);
    tasks.update(id, { column: "merge" });
  }
  return { id, task: tasks.get(id)!, steps: { understand, build, review, finish } };
}

const failing = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t", number: 9, url: "https://github.com/o/r/pull/9", state: "open", draft: false, baseRef: "develop", headSha: HEAD, behindBy: 0,
  checks: "failure", failingChecks: [{ name: "web / vitest", url: RUN_URL, alsoOnBase: false }], unresolvedThreads: 0, checkedAt: 0, ...o,
});

/** GitHub's side of a CI failure, without GitHub. */
function stubCi(tail: string, over: { headSha?: string | null; conclusion?: string } = {}) {
  const calls = { details: 0, reruns: [] as number[] };
  rework.reworkDeps.failureDetails = async (_t, pr) => {
    calls.details++;
    return {
      headSha: over.headSha === undefined ? pr.headSha : over.headSha,
      checks: pr.failingChecks.filter((c) => !c.alsoOnBase).map((c) => ({ name: c.name, url: c.url, conclusion: over.conclusion ?? "failure", runId: 777 })),
      logs: [{ runId: 777, tail }],
    };
  };
  rework.reworkDeps.rerunFailed = async (_t, runId) => {
    calls.reruns.push(runId);
    return { ok: true };
  };
  return calls;
}

const stepNames = (t: Task) => {
  const names = new Map(t.pipelineRun!.snapshot!.graph.steps.map((s) => [s.id, s.name]));
  return t.pipelineRun!.history.map((h) => names.get(h.stepId));
};

test("a CI failure this change caused goes to Build with the failure as context, then Review and Finish; the sign-off is withdrawn and later restored", async () => {
  const { tasks } = await import("./db.ts");
  const { isMergeQueued, setMergeQueued } = await import("./merge-intent.ts");
  const { signOffPass } = await import("./autopilot.ts");
  const { id, task, steps } = await finishedCard();
  const calls = stubCi("FAIL src/cart.test.ts > totals > rounds half up\nAssertionError: expected 10.5 to be 11");

  const out = await rework.reworkCiFailure(task, failing());
  expect(out).toEqual({ kind: "round", round: 1 });
  expect(calls.reruns).toEqual([]);
  // Withdrawn at once: the head that was signed off is about to change.
  expect(isMergeQueued(id)).toBe(false);
  expect(tasks.get(id)!.column).not.toBe("merge");

  // Build is entered exactly as from Finish's "verification failed".
  const run = tasks.get(id)!.pipelineRun!;
  const buildRecord = run.history.at(-1)!.stepId === steps.build.id ? run.history.at(-1)! : run.history.find((h) => h.seq === 5)!;
  expect(buildRecord.stepId).toBe(steps.build.id);
  const prompt = tasks.get(buildRecord.taskId)!.prompt;
  expect(prompt).toContain("Finish");
  expect(prompt).toContain("web / vitest (failure) " + RUN_URL);
  expect(prompt).toContain("AssertionError: expected 10.5 to be 11");
  expect(prompt).toContain("verification failed");
  expect(prompt).toContain("do not push");
  expect(prompt).toContain("fix round 1 of 3");
  // Finish's own last report said everything passed; it is not handed over as the reason to be here.
  expect(prompt).not.toContain("The full report from \"Finish\"");

  // The run goes on by its own edges and ends in In Review, not Ready to Merge.
  const done = await waitFor(() => {
    const t = tasks.get(id)!;
    return t.pipelineRun?.status === "done" ? t : null;
  });
  expect(stepNames(done)).toEqual(["Understand", "Build", "Review", "Finish", "Build", "Review", "Finish"]);
  expect(done.column).toBe("review");
  // What automatic sign-off checks: the last Review is immediately before the last Finish.
  const h = done.pipelineRun!.history;
  expect([h.at(-2)!.stepId, h.at(-1)!.stepId]).toEqual([steps.review.id, steps.finish.id]);
  expect(h.at(-2)!.nextStepIds).toEqual([steps.finish.id]);
  expect(h.every((r) => r.outcome === "succeeded")).toBe(true);
  // The cap was raised for the round, like a follow-up raises it for its step.
  expect(done.pipelineRun!.stepCount).toBe(7);
  expect(done.pipelineRun!.blocked).toEqual([]);

  const log = activity(id);
  expect(log.some((l) => l.startsWith("Merge queue: CI failed (web / vitest) on PR #9 — sign-off withdrawn, sent back through Build → Review → Finish (fix round 1 of 3)"))).toBe(true);
  // Not the wording that marks the owner taking a card back (src/shared/velocity.ts).
  expect(log.some((l) => l.startsWith("Sign-off withdrawn"))).toBe(false);

  // The ordinary sign-off path returns it to the queue.
  const state = { held: [], holds: {}, unread: {} } as unknown as Parameters<typeof signOffPass>[0];
  await signOffPass(state, [done], {
    prStatus: () => ({ ...failing(), checks: "success", failingChecks: [], headSha: "b".repeat(40) }),
    prFiles: async () => ["src/cart.ts"],
    rules: () => ({ globs: null, signature: "s" }),
    handsOff: () => new Set(rework.reworkHeld()),
    signOff: (t) => {
      setMergeQueued(t.id, true);
      tasks.update(t.id, { column: "merge" });
    },
    activity: () => {},
  });
  expect(isMergeQueued(id)).toBe(true);
  expect(tasks.get(id)!.column).toBe("merge");
  expect(rework.reworkEntry(id)).toMatchObject({ rounds: 1, lastHead: HEAD });
});

test("a conflict with the base goes to Build with the conflicting files", async () => {
  const { tasks } = await import("./db.ts");
  const { isMergeQueued } = await import("./merge-intent.ts");
  const { id, task, steps } = await finishedCard();
  rework.reworkDeps.conflictFiles = async () => ({ headSha: HEAD, files: ["apps/web/src/cart.ts", "pnpm-lock.yaml"] });

  expect(await rework.reworkConflict(task, failing({ checks: "success", failingChecks: [] }))).toEqual({ kind: "round", round: 1 });
  expect(isMergeQueued(id)).toBe(false);
  const record = tasks.get(id)!.pipelineRun!.history.find((h) => h.seq === 5)!;
  expect(record.stepId).toBe(steps.build.id);
  const prompt = tasks.get(record.taskId)!.prompt;
  expect(prompt).toContain("conflicts with develop");
  expect(prompt).toContain("- apps/web/src/cart.ts");
  expect(prompt).toContain("- pnpm-lock.yaml");
  expect(prompt).toContain("never a rebase");
  const done = await waitFor(() => (tasks.get(id)!.pipelineRun?.status === "done" ? tasks.get(id)! : null));
  expect(stepNames(done).slice(-3)).toEqual(["Build", "Review", "Finish"]);
  expect(activity(id).some((l) => l.includes("a conflict with develop on PR #9") && l.includes("fix round 1 of 3"))).toBe(true);
});

test("develop failing the same checks starts nothing: the queue waits, and no round runs", async () => {
  const { tasks } = await import("./db.ts");
  const { isMergeQueued } = await import("./merge-intent.ts");
  const { nextMergeStep } = await import("./merge-queue.ts");
  const { id, task } = await finishedCard();
  const calls = stubCi("anything");
  const inherited = failing({ failingChecks: [{ name: "web / vitest", url: RUN_URL, alsoOnBase: true }, { name: "required", url: null, alsoOnBase: false }] });

  expect(nextMergeStep(task, inherited, { mergeable: true, mergeableState: "clean" }, true, true)).toEqual({ kind: "wait", why: "develop is failing the same checks" });
  expect(await rework.reworkCiFailure(task, inherited)).toEqual({ kind: "skipped", why: "no failure of its own" });
  expect(calls.details).toBe(0);
  expect(tasks.get(id)!.pipelineRun!.status).toBe("done");
  expect(tasks.get(id)!.pipelineRun!.stepCount).toBe(4);
  expect(isMergeQueued(id)).toBe(true);
  expect(tasks.get(id)!.column).toBe("merge");

  // Develop recovered and moved on, the branch is behind: a merge of the base, no fix round.
  const stale = failing({ behindBy: 2, failingChecks: [{ name: "web / vitest", url: RUN_URL, alsoOnBase: false, passesOnBase: true }] });
  expect(nextMergeStep(task, stale, { mergeable: true, mergeableState: "clean" }, true, true)).toEqual({ kind: "update-branch" });
  expect(await rework.reworkCiFailure(task, stale)).toEqual({ kind: "skipped", why: "no failure of its own" });

  // Develop recovered with no new commit (it was a re-run there): the same jobs are re-run here, once.
  rework.noteBaseRed(id, HEAD);
  expect(await rework.reworkCiFailure(task, failing())).toMatchObject({ kind: "rerun" });
  expect(calls.reruns).toEqual([777]);
  expect(tasks.get(id)!.pipelineRun!.status).toBe("done");
  expect(isMergeQueued(id)).toBe(true);
});

test("being behind the base is never a fix round; an own failure on a behind branch skips the extra CI run", async () => {
  const { nextMergeStep } = await import("./merge-queue.ts");
  const { task } = await finishedCard();
  const clean = { mergeable: true, mergeableState: "clean" };
  // Green and behind: merge as it is (or ride a train built on the latest base).
  expect(nextMergeStep(task, failing({ checks: "success", failingChecks: [], behindBy: 4 }), clean, true, true)).toEqual({ kind: "merge" });
  // GitHub requires an up-to-date branch: GitHub's own merge of the base, no agent.
  expect(nextMergeStep(task, failing({ checks: "success", failingChecks: [], behindBy: 4 }), { mergeable: true, mergeableState: "behind" }, true, true)).toEqual({ kind: "update-branch" });
  // Its own failure while behind: straight to the fix round (Build merges the base in it).
  expect(nextMergeStep(task, failing({ behindBy: 4 }), clean, true, true)).toEqual({ kind: "fix-ci" });
  // …where a pipeline without Review still updates first, as before.
  expect(nextMergeStep(task, failing({ behindBy: 4 }), clean, true, false)).toEqual({ kind: "update-branch" });
});

test("a job the runner broke is re-run once, not fixed; if it fails again the round starts", async () => {
  const { tasks } = await import("./db.ts");
  const { isMergeQueued } = await import("./merge-intent.ts");
  const { id, task } = await finishedCard();
  const calls = stubCi("Run pnpm install\nfatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com\nError: Process completed with exit code 128.");
  let now = 1_000_000;
  rework.reworkDeps.now = () => now;

  expect(await rework.reworkCiFailure(task, failing())).toMatchObject({ kind: "rerun" });
  expect(calls.reruns).toEqual([777]);
  expect(tasks.get(id)!.pipelineRun!.status).toBe("done");
  expect(isMergeQueued(id)).toBe(true);
  expect(rework.reworkEntry(id)).toMatchObject({ rounds: 0, rerun: { head: HEAD, at: now } });
  expect(activity(id).some((l) => l.includes("not because of this change") && l.includes("re-ran the failed jobs once; no fix round"))).toBe(true);

  // GitHub still shows the old failure for a moment: nothing happens.
  now += 30_000;
  expect(await rework.reworkCiFailure(task, failing())).toEqual({ kind: "skipped", why: "failed jobs were just re-run" });
  expect(calls.details).toBe(1);

  // The re-run failed the same way: no second re-run for this head.
  now += rework.RERUN_SETTLE_MS;
  expect(await rework.reworkCiFailure(task, failing())).toEqual({ kind: "round", round: 1 });
  expect(calls.reruns).toEqual([777]);
  expect(isMergeQueued(id)).toBe(false);
  await waitFor(() => tasks.get(id)!.pipelineRun?.status === "done");
});

test("what counts as the runner's failure", () => {
  const check = (conclusion: string | null = "failure", runId: number | null = 1) => ({ name: "web / vitest", url: null, conclusion, runId });
  const log = (tail: string) => [{ runId: 1, tail }];
  expect(rework.infraReason({ checks: [check()], logs: log("AssertionError: expected 1 to be 2") })).toBeNull();
  expect(rework.infraReason({ checks: [check()], logs: log("The runner has received a shutdown signal.") })).toContain("shutdown signal");
  expect(rework.infraReason({ checks: [check()], logs: log("ENOSPC: no space left on device, write") })).toContain("no space left on device");
  expect(rework.infraReason({ checks: [check("startup_failure", null)], logs: [] })).toContain("failed to start");
  expect(rework.infraReason({ checks: [check()], logs: log("") })).toContain("before any of its steps ran");
  // One real failure beside a broken job is still this change's.
  expect(rework.infraReason({ checks: [check(), { ...check(), name: "agent / go test", runId: 2 }], logs: [{ runId: 1, tail: "Could not resolve host: github.com" }, { runId: 2, tail: "--- FAIL: TestCart" }] })).toBeNull();
  // A log that could not be read proves nothing.
  expect(rework.infraReason({ checks: [check()], logs: [] })).toBeNull();
  expect(rework.infraReason({ checks: [], logs: [] })).toBeNull();
  expect(rework.runIdFromCheckUrl(RUN_URL)).toBe(777);
  expect(rework.logTail("job\tstep\t2026-10-12T00:00:00Z line one\n\njob\tstep\tline two")).toBe("2026-10-12T00:00:00Z line one\nline two");
});

test("a stale PR status (the head moved on) starts nothing", async () => {
  const { tasks } = await import("./db.ts");
  const { isMergeQueued } = await import("./merge-intent.ts");
  const { id, task } = await finishedCard();
  stubCi("AssertionError", { headSha: "c".repeat(40) });
  expect(await rework.reworkCiFailure(task, failing())).toEqual({ kind: "skipped", why: "the pull request moved on" });
  expect(tasks.get(id)!.pipelineRun!.status).toBe("done");
  expect(isMergeQueued(id)).toBe(true);
});

test("the cap: after maxRounds rounds the card is held in In Review for the owner, and Autopilot leaves it there", async () => {
  const { tasks, preferences } = await import("./db.ts");
  const { isMergeQueued, setMergeQueued } = await import("./merge-intent.ts");
  const { signOffPass } = await import("./autopilot.ts");
  preferences.set(rework.MERGE_REWORK_PREF, JSON.stringify({ maxRounds: 2 }));
  const { id } = await finishedCard();
  stubCi("AssertionError: nope");
  const heads = ["1", "2", "3"].map((c) => c.repeat(40));
  const signOff = () => {
    setMergeQueued(id, true);
    tasks.update(id, { column: "merge" });
  };

  for (const [i, head] of heads.slice(0, 2).entries()) {
    expect(await rework.reworkCiFailure(tasks.get(id)!, failing({ headSha: head }))).toEqual({ kind: "round", round: i + 1 });
    await waitFor(() => tasks.get(id)!.pipelineRun?.status === "done");
    signOff();
  }
  const steps = tasks.get(id)!.pipelineRun!.stepCount;
  expect(steps).toBe(10);

  // The third failure: no round.
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing({ headSha: heads[2]! }))).toEqual({ kind: "held" });
  const held = tasks.get(id)!;
  expect(held.pipelineRun!.status).toBe("done");
  expect(held.pipelineRun!.stepCount).toBe(steps);
  expect(held.column).toBe("review");
  expect(isMergeQueued(id)).toBe(false);
  expect(rework.reworkHeld()).toEqual([id]);
  const said = activity(id).filter((l) => l.startsWith("Held for you:"));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("2 fix rounds through Build, Review and Finish did not get it mergeable");
  expect(said[0]).toContain("sign-off withdrawn");

  // Said once; a later look changes nothing.
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing({ headSha: heads[2]! }))).toEqual({ kind: "held" });
  expect(await rework.reworkConflict(tasks.get(id)!, failing({ headSha: heads[2]! }))).toEqual({ kind: "held" });
  expect(activity(id).filter((l) => l.startsWith("Held for you:"))).toHaveLength(1);

  // Autopilot does not sign it off again…
  const signed: string[] = [];
  const state = { held: [], holds: {}, unread: {} } as unknown as Parameters<typeof signOffPass>[0];
  await signOffPass(state, [tasks.get(id)!], {
    prStatus: () => failing({ headSha: heads[2]! }),
    prFiles: async () => ["src/cart.ts"],
    rules: () => ({ globs: null, signature: "s" }),
    handsOff: () => new Set(rework.reworkHeld()),
    signOff: (t) => void signed.push(t.id),
    activity: () => {},
  });
  expect(signed).toEqual([]);

  // …until the owner signs it off by hand, which starts a fresh allowance.
  rework.noteOwnerSignOff(id);
  expect(rework.reworkHeld()).toEqual([]);
  expect(rework.reworkEntry(id)).toEqual({ rounds: 0 });
});

test("a round that left the head unchanged is not repeated: held", async () => {
  const { tasks } = await import("./db.ts");
  const { id } = await finishedCard();
  stubCi("AssertionError: nope");
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing())).toEqual({ kind: "round", round: 1 });
  await waitFor(() => tasks.get(id)!.pipelineRun?.status === "done");
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing())).toEqual({ kind: "held" });
  expect(activity(id).some((l) => l.startsWith("Held for you:") && l.includes("left the pull request's head unchanged"))).toBe(true);
});

test("a pipeline without a Review step keeps its follow-ups", async () => {
  const { tasks } = await import("./db.ts");
  const { isMergeQueued } = await import("./merge-intent.ts");
  const { nextMergeStep } = await import("./merge-queue.ts");
  const { id, task } = await finishedCard({ reviewed: false });
  const calls = stubCi("AssertionError: nope");
  expect(rework.reviewedReworkFor(task)).toBeNull();
  expect(await rework.reworkCiFailure(task, failing())).toEqual({ kind: "skipped", why: "not a reviewed pipeline" });
  expect(await rework.reworkConflict(task, failing())).toEqual({ kind: "skipped", why: "not a reviewed pipeline" });
  expect(calls.details).toBe(0);
  expect(tasks.get(id)!.pipelineRun!.stepCount).toBe(3);
  expect(isMergeQueued(id)).toBe(true);
  // The queue's own decision is what it was.
  expect(nextMergeStep(task, failing(), { mergeable: true, mergeableState: "clean" }).kind).toBe("fix-ci");
  expect(nextMergeStep(task, failing(), { mergeable: false, mergeableState: "dirty" }).kind).toBe("resolve-conflicts");
});

test("rework turned off in the preference: a reviewed pipeline keeps follow-ups too", async () => {
  const { preferences } = await import("./db.ts");
  const { task } = await finishedCard();
  expect(rework.reviewedReworkFor(task)).not.toBeNull();
  preferences.set(rework.MERGE_REWORK_PREF, JSON.stringify({ enabled: false }));
  expect(rework.reviewedReworkFor(task)).toBeNull();
  expect(await rework.reworkCiFailure(task, failing())).toEqual({ kind: "skipped", why: "not a reviewed pipeline" });
  expect(rework.parseReworkConfig(null)).toEqual({ enabled: true, maxRounds: 3 });
  expect(rework.parseReworkConfig('{"maxRounds":0}').maxRounds).toBe(1);
  expect(rework.parseReworkConfig("not json")).toEqual({ enabled: true, maxRounds: 3 });
});

test("only a finished run is sent back: a blocked or running one is the pipeline's own", async () => {
  const { tasks } = await import("./db.ts");
  const { reworkPipelineRun } = await import("./pipeline-runner.ts");
  const { id, steps } = await finishedCard();
  stubCi("AssertionError: nope");
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing())).toEqual({ kind: "round", round: 1 });
  // Mid-round: a second trigger is refused by the runner and skipped by the caller.
  const handoff = { schemaVersion: 1 as const, purpose: "", summary: "again", reason: "", next: null, artifacts: [], openQuestions: [] };
  const again = await reworkPipelineRun(id, { stepId: steps.build.id, fromStepId: steps.finish.id, handoff });
  expect(again).toMatchObject({ status: 409 });
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing({ headSha: "d".repeat(40) }))).toEqual({ kind: "skipped", why: "the run is not finished" });
  await waitFor(() => tasks.get(id)!.pipelineRun?.status === "done");
  expect(tasks.get(id)!.pipelineRun!.stepCount).toBe(7);
  expect(await reworkPipelineRun(id, { stepId: "nope", fromStepId: steps.finish.id, handoff })).toMatchObject({ status: 400 });
});

test("stored run state: a run from before this change still loads, and a reworked run is nothing an older build cannot read", async () => {
  const { tasks, parsePipelineRunState } = await import("./db.ts");
  // A run as the previous build stored it (the fields it wrote, no others).
  const before = {
    pipelineId: "deec4252", pipelineName: "Change", status: "done", active: [], joins: {}, blocked: [], stepCount: 2, startedAt: 10, endedAt: 20,
    snapshot: {
      graph: { steps: [{ id: "build", name: "Build", instructions: "old prompt", agentProfileId: "p", position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any" }],
        edges: [{ id: "e", from: "build", to: "build", label: "again" }], startStepId: "build" },
      profiles: {}, maxSteps: 14, capturedAt: 5,
    },
    history: [{ seq: 1, stepId: "build", taskId: "c1", startedAt: 10, endedAt: 15, outcome: "succeeded", handoff: { schemaVersion: 1, purpose: "", summary: "s", reason: "", next: null, artifacts: [], openQuestions: [], status: "done" }, nextStepIds: [] }],
  };
  const loaded = parsePipelineRunState(JSON.stringify(before))!;
  expect(loaded.status).toBe("done");
  expect(loaded.snapshot!.graph.steps[0]!.instructions).toBe("old prompt");
  expect(loaded.snapshot!.graph.edges[0]).toEqual({ id: "e", from: "build", to: "build", label: "again" });
  expect(loaded.history).toHaveLength(1);
  expect(rework.reviewedReworkFor({ pipelineId: "deec4252", pipelineRun: loaded })).toBeNull();

  // A reworked run uses only fields that were already there: it reads back
  // identically through the stored-state parser, which this change leaves alone.
  const { id } = await finishedCard();
  stubCi("AssertionError: nope");
  const snapshotBefore = JSON.stringify(tasks.get(id)!.pipelineRun!.snapshot!.graph);
  expect(await rework.reworkCiFailure(tasks.get(id)!, failing())).toEqual({ kind: "round", round: 1 });
  const done = await waitFor(() => (tasks.get(id)!.pipelineRun?.status === "done" ? tasks.get(id)! : null));
  // The frozen graph and prompts are untouched (a follow-up would have appended a step).
  expect(JSON.stringify(done.pipelineRun!.snapshot!.graph)).toBe(snapshotBefore);
  const known = new Set(["pipelineId", "pipelineName", "snapshot", "status", "active", "joins", "blocked", "history", "stepCount", "startedAt", "endedAt", "capExtensions", "autoRetry", "launchRetries", "wait"]);
  expect(Object.keys(done.pipelineRun!).filter((k) => !known.has(k))).toEqual([]);
  expect(parsePipelineRunState(JSON.stringify(done.pipelineRun))).toEqual(done.pipelineRun!);
  // A launch that had to queue keeps its arrival (seq 0 names no execution) through a restart.
  const queued = { ...before, status: "running", blocked: [{ taskId: null, stepId: "build", kind: "slot-wait", message: "Build is waiting for a slot",
    pending: { stepId: "build", arrivals: [{ fromStepId: "build", seq: 0, handoff: before.history[0]!.handoff }] } }] };
  expect(parsePipelineRunState(JSON.stringify(queued))!.blocked[0]!.pending!.arrivals[0]).toMatchObject({ fromStepId: "build", seq: 0 });
});

test("a Fix CI asked for by hand on a reviewed pipeline is refused as a follow-up when the PR gives it nothing to do", async () => {
  const { tasks } = await import("./db.ts");
  const { startFollowUp } = await import("./pipeline-followups.ts");
  const { PR_FIX_CI_ACTION } = await import("./pr-watch.ts");
  const { id } = await finishedCard();
  // No PR status is known for this card: the ordinary answer, and no follow-up step is appended.
  const r = await startFollowUp(id, { presetId: PR_FIX_CI_ACTION });
  expect(r).toMatchObject({ status: 409 });
  expect(tasks.get(id)!.pipelineRun!.snapshot!.graph.steps.map((s) => s.name)).toEqual(["Understand", "Build", "Review", "Finish"]);
});
