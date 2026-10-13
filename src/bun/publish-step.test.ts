import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Handoff, PipelinePublishState, PipelineRunState, PipelineStep, Task } from "../shared/types.ts";
import type { CheckRunLike } from "../shared/check-runs.ts";
import type { PullSeen } from "../shared/publish.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Every git command here runs in a temporary clone whose only remote is a
// temporary bare repository; every GitHub call is a fake (`gh` below). No
// agent is ever started: the steps' agent profiles are left out of the run's
// snapshot, so a launch stops at a "has no agent" block that shows where the
// run was sent.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-publish-step-"));
process.env.AGETOR_DATA_DIR ??= DATA_DIR;
// Only the last test starts an agent, and it is the scripted fake.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { tasks, preferences, parsePipelineRunState } = await import("./db.ts");
const { newStep } = await import("../shared/pipeline.ts");
const { PIPELINE_GATES_PREF, initialPublishState } = await import("../shared/publish.ts");
const { publishCard, publishTick, publishDeps, publishDraftBody, resetPublishForTests, BASE_LOOK_MS } = await import("./publish-step.ts");
const { adoptPipelineGates, retryPipelineStep, withPipelineLock } = await import("./pipeline-runner.ts");
const { slotUse } = await import("./step-slots.ts");
const { reviewedPillarPipeline } = await import("./autopilot.ts");

const realDeps = { ...publishDeps };
const T0 = 1_800_000_000_000;
const MIN = 60_000;

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(args, {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

/** A bare `origin` with `develop`, a clone on the card's branch holding one
 *  commit that changes `a.txt` and adds `feature.txt`, and a second clone to
 *  move `develop` from. */
async function makeRepos() {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-publish-repo-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "card");
  const other = path.join(root, "other");
  await sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
  await sh(root, "git", "clone", "-q", origin, repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) await sh(repo, "git", "config", k!, v!);
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  writeFileSync(path.join(repo, "z.txt"), "base\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "base");
  await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");
  await sh(repo, "git", "checkout", "-q", "-b", "claude/x", "origin/develop");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
  writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "feat: the change");
  await sh(root, "git", "clone", "-q", origin, other);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) await sh(other, "git", "config", k!, v!);
  const head = await sh(repo, "git", "rev-parse", "HEAD");
  const baseTip = await sh(repo, "git", "rev-parse", "origin/develop");
  /** Commit `file` on develop from the other clone and push it; returns the new tip. */
  const moveBase = async (file: string, text: string) => {
    await sh(other, "git", "pull", "-q", "origin", "develop");
    writeFileSync(path.join(other, file), text);
    await sh(other, "git", "add", ".");
    await sh(other, "git", "commit", "-qm", `base: ${file}`);
    await sh(other, "git", "push", "-q", "origin", "HEAD:develop");
    return sh(other, "git", "rev-parse", "HEAD");
  };
  const remote = async (branch: string) => (await sh(repo, "git", "ls-remote", "origin", `refs/heads/${branch}`)).split(/\s+/)[0] || null;
  return { root, origin, repo, head, baseTip, moveBase, remote };
}

const at = (minute: number) => `2026-10-13T10:${String(minute).padStart(2, "0")}:00Z`;
const check = (name: string, conclusion: string | null, minute = 1, id = 1): CheckRunLike => ({
  name, status: conclusion === null ? "in_progress" : "completed", conclusion,
  htmlUrl: `https://github.com/o/r/actions/runs/${9000 + id}/job/${id}`, startedAt: at(minute), id,
});
const GREEN = [check("web", "success", 1, 1), check("required", "success", 1, 2)];
const RED = [check("web", "failure", 1, 1), check("required", "failure", 1, 2)];

/** GitHub, faked. A pull request's head is whatever the bare origin holds. */
let gh: {
  pull: Omit<PullSeen, "headSha"> | null;
  checks: Map<string, CheckRunLike[]>;
  log: string;
  opened: { title: string; base: string; body: string }[];
  reruns: number[];
  ready: number[];
  comments: string[];
  readable: boolean;
};

function fakeGitHub(repos: Awaited<ReturnType<typeof makeRepos>>): void {
  gh = { pull: null, checks: new Map(), log: "test failed: expected 1, got 2", opened: [], reruns: [], ready: [], comments: [], readable: true };
  publishDeps.base = async () => "develop";
  publishDeps.findPull = async (task) => {
    if (!gh.readable) return { ok: false };
    return { ok: true, pull: gh.pull && { ...gh.pull, headSha: await repos.remote(task.branch!) } };
  };
  publishDeps.openPull = async (_task, input) => {
    gh.opened.push(input);
    gh.pull = { number: 7, url: "https://github.com/o/r/pull/7", state: "open", draft: true };
    return { ok: true, pr: { number: 7, url: gh.pull.url } };
  };
  publishDeps.checks = async (_task, sha) => (gh.readable ? (gh.checks.get(sha) ?? []) : null);
  publishDeps.failedLog = async () => gh.log;
  publishDeps.rerunFailed = async (_task, runId) => {
    gh.reruns.push(runId);
    return { ok: true };
  };
  publishDeps.markReady = async (_task, n) => {
    gh.ready.push(n);
    if (gh.pull) gh.pull.draft = false;
    return true;
  };
  publishDeps.comment = async (_task, _n, body) => {
    gh.comments.push(body);
    return true;
  };
}

const approvalHandoff = (headSha: string, o: Partial<NonNullable<Handoff["reviewApproval"]>> = {}): Handoff => ({
  schemaVersion: 1, purpose: "review", summary: "Approved: every criterion is met.", reason: "done", next: "Finish", artifacts: [], openQuestions: [], status: "done",
  reviewApproval: { verdict: "approved", headSha, issueUrl: "https://github.com/o/r/issues/3", acceptanceComplete: true, findings: [], ...o },
});

interface Card {
  id: string;
  build: PipelineStep;
  review: PipelineStep;
  finish: PipelineStep;
}

/** A pipeline card whose Review just approved `approval` and whose Finish is
 *  held for Agetor at `publish` (a fresh visit by default). */
function makeCard(repo: string, approval: Handoff | null, o: {
  publish?: Partial<PipelinePublishState>; branch?: string; maxTraversals?: number; history?: PipelineRunState["history"]; gates?: boolean;
  profiles?: PipelineRunState["snapshot"] extends infer S ? (S extends { profiles: infer P } ? P : never) : never; prompt?: string;
} = {}): Card {
  const build = newStep({ name: "Build", agentProfileId: "missing-profile", instructions: "Build it." });
  const review = newStep({ name: "Review", agentProfileId: "missing-profile", instructions: "Review it." });
  const finish = newStep({ name: "Finish", agentProfileId: "missing-profile", instructions: "ORIGINAL FINISH INSTRUCTIONS", canFinish: true });
  const id = randomUUID();
  const reviewRecord = (seq: number, handoff: Handoff | null) => ({
    seq, stepId: review.id, taskId: `review-${seq}`, startedAt: T0 - 10 * MIN, endedAt: T0 - 5 * MIN, outcome: "succeeded" as const, handoff, nextStepIds: [finish.id],
  });
  const history = o.history ?? [
    { seq: 1, stepId: build.id, taskId: "build-1", startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN, outcome: "succeeded" as const, handoff: null, nextStepIds: [review.id] },
    reviewRecord(2, approval),
  ];
  const run: PipelineRunState = {
    pipelineId: "p-change", pipelineName: "Change", status: "running", active: [], joins: {}, history, stepCount: history.length, startedAt: T0 - 30 * MIN, endedAt: null,
    snapshot: {
      graph: {
        steps: [build, review, finish], startStepId: build.id,
        edges: [
          { id: "e1", from: build.id, to: review.id, label: "" },
          { id: "e2", from: review.id, to: finish.id, label: "approved" },
          { id: "e3", from: finish.id, to: build.id, label: "verification failed", ...(o.maxTraversals ? { maxTraversals: o.maxTraversals } : {}) },
        ],
      },
      maxSteps: 14, profiles: o.profiles ?? {}, capturedAt: T0 - 30 * MIN, ...(o.gates === false ? {} : { gates: { publish: true as const } }),
    },
    blocked: [{
      taskId: null, stepId: finish.id, kind: "await", message: "Finish is run by Agetor", pending: { stepId: finish.id, arrivals: [{ fromStepId: review.id, seq: 2, handoff: approval }] },
    }],
    publish: { ...initialPublishState(finish.id, T0 - MIN), ...o.publish },
  };
  tasks.insert({
    id, title: "the card", prompt: o.prompt ?? "Fix the thing. Fixes #3", column: "running", agent: "claude-code", workdir: repo, isolation: "worktree", taskType: "task",
    branch: o.branch ?? "claude/x", branchSource: "created", worktreePath: repo, baseRef: null, prUrl: null, issueUrl: "https://github.com/o/r/issues/3",
    mode: null, model: null, effort: null, fast: false, maxMode: false, agentProfileId: null, agentProfile: null, references: [], backlog: [], draft: null, plans: [],
    todoProgress: null, runId: null, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    pipelineId: "p-change", pipelineRun: run, pipelineParentId: null, pipelineStepId: null, createdAt: T0, updatedAt: T0, archivedAt: null,
  } as Task);
  tasks.setPipelineRun(id, run);
  return { id, build, review, finish };
}

const runOf = (card: Card) => tasks.get(card.id)!.pipelineRun!;
const stateOf = (card: Card) => runOf(card).publish?.state;
/** Nothing an agent or a retry budget would show: no step task, no slot, no
 *  step counted, no wait-queue entry, and the run reads as running. */
function expectNothingSpent(card: Card, stepCount = 2): void {
  const run = runOf(card);
  expect(run.stepCount).toBe(stepCount);
  expect(run.active).toEqual([]);
  expect(run.wait).toBeUndefined();
  expect(run.status).toBe("running");
  expect(tasks.stepsForParent(card.id)).toEqual([]);
  expect(slotUse(() => false, undefined, [tasks.get(card.id)!])).toEqual({ total: 0, heavy: 0 });
  expect(run.blocked.map((b) => [b.taskId, b.kind])).toEqual([[null, "await"]]);
}

beforeEach(() => {
  resetPublishForTests();
  Object.assign(publishDeps, realDeps);
  preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ publish: { pipelines: ["Change"] } }));
});

afterAll(() => {
  Object.assign(publishDeps, realDeps);
  for (const t of tasks.list()) if (t.pipelineId === "p-change" || t.pipelineParentId) tasks.delete(t.id);
  rmTestDataDir(DATA_DIR);
});

describe("the approved head goes out once, and CI is waited for without an agent", () => {
  test("verify, push, open a draft PR, wait; then green: ready, facts posted, the writer is launched", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    gh.checks.set(repos.baseTip, GREEN);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));

    await publishCard(card.id, T0);
    // One pass took it from the start to waiting on CI.
    expect(stateOf(card)).toBe("wait-ci");
    expect(await repos.remote("claude/x")).toBe(repos.head); // exactly the approved head
    expect(await repos.remote("develop")).toBe(repos.baseTip); // the base branch is never written
    expect(gh.opened).toHaveLength(1);
    expect(gh.opened[0]).toMatchObject({ title: "feat: the change", base: "develop" });
    expect(gh.opened[0]!.body).toContain("Refs #3");
    expect(gh.opened[0]!.body).not.toMatch(/fixes #/i);
    expect(runOf(card).publish).toMatchObject({ head: repos.head, approvedHead: repos.head, carried: 0, pr: { number: 7 }, base: "develop" });
    expect(tasks.get(card.id)!.prUrl).toBe("https://github.com/o/r/pull/7");
    expectNothingSpent(card);

    // CI runs for an hour: sixty passes, nothing spent, nothing pushed again.
    gh.checks.set(repos.head, [check("web", null, 1, 1), check("required", null, 1, 2)]);
    for (let i = 1; i <= 60; i++) await publishCard(card.id, T0 + i * MIN);
    expect(stateOf(card)).toBe("wait-ci");
    expect(runOf(card).blocked[0]!.message).toContain("CI running");
    expectNothingSpent(card);
    expect(gh.opened).toHaveLength(1);

    gh.checks.set(repos.head, GREEN);
    await publishCard(card.id, T0 + 61 * MIN);
    const run = runOf(card);
    expect(run.publish).toMatchObject({ state: "write", posted: repos.head });
    expect(run.publish!.brief).toContain("gh pr edit 7 --body-file");
    expect(gh.ready).toEqual([7]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain(`Head: \`${repos.head}\``);
    // The writer's launch reached the runner: a launch of Finish itself (it
    // stops here only because this test's run has no agent profiles).
    expect(run.blocked.map((b) => [b.kind, b.stepId, b.pending?.arrivals[0]?.fromStepId])).toEqual([["profile-missing", card.finish.id, card.review.id]]);
    expect(run.history.filter((h) => h.stepId === card.finish.id)).toEqual([]);

    // Nothing is posted or pushed twice by later passes.
    await publishCard(card.id, T0 + 62 * MIN);
    expect(await publishTick(T0 + 63 * MIN)).toBe(0);
    expect(gh.comments).toHaveLength(1);
    expect(await repos.remote("claude/x")).toBe(repos.head);
  }, 60_000);

  test("a cancelled duplicate run beside a newer success is green (2026-10-13); a lone cancelled run is re-run once", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    gh.checks.set(repos.head, [check("web", "success", 1, 1), check("required", "cancelled", 2, 2)]);
    await publishCard(card.id, T0 + MIN);
    expect(gh.reruns).toEqual([9002]);
    expect(runOf(card).publish).toMatchObject({ state: "wait-ci", reran: [{ head: repos.head, why: "cancelled" }] });
    expectNothingSpent(card);
    // GitHub starts a new run; the cancelled twin stays listed beside it.
    gh.checks.set(repos.head, [check("web", "success", 1, 1), check("required", "cancelled", 2, 2), check("required", "success", 9, 3)]);
    await publishCard(card.id, T0 + 2 * MIN);
    expect(stateOf(card)).toBe("write");
    expect(gh.reruns).toEqual([9002]);
  }, 60_000);

  test("GitHub unreadable: the visit waits where it is and decides nothing", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    gh.readable = false;
    gh.checks.set(repos.head, RED);
    for (let i = 1; i <= 5; i++) await publishCard(card.id, T0 + i * MIN);
    expect(stateOf(card)).toBe("wait-ci");
    expect(runOf(card).publish!.tries).toBe(0);
    expectNothingSpent(card);
  }, 60_000);
});

describe("a red base", () => {
  test("before the push: nothing is pushed while the base fails; it publishes by itself when the base is green", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    gh.checks.set(repos.baseTip, RED);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    for (let i = 0; i < 40; i++) await publishCard(card.id, T0 + i * BASE_LOOK_MS);
    expect(stateOf(card)).toBe("hold-base");
    expect(runOf(card).blocked[0]!.message).toContain("develop is failing web");
    expect(await repos.remote("claude/x")).toBeNull();
    expect(gh.opened).toEqual([]);
    expectNothingSpent(card);

    gh.checks.set(repos.baseTip, [...RED, check("web", "success", 9, 3), check("required", "success", 9, 4)]);
    await publishCard(card.id, T0 + 41 * BASE_LOOK_MS);
    expect(stateOf(card)).toBe("wait-ci");
    expect(await repos.remote("claude/x")).toBe(repos.head);
  }, 60_000);

  test("CI fails on a check the base fails too: parked with no agent, no slot, no attempt — and it resumes by itself (2026-10-13 #1351)", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    expect(stateOf(card)).toBe("wait-ci");

    // The PR's run fails on `web`; the base's tip fails `web` as well.
    gh.checks.set(repos.head, RED);
    gh.checks.set(repos.baseTip, RED);
    await publishCard(card.id, T0 + MIN);
    expect(runOf(card).publish).toMatchObject({ state: "base-red", inherited: ["web"] });
    expect(gh.reruns).toEqual([]);

    // A day of passes. The old loop spent four timed retries here and then
    // went to the owner; this spends nothing and asks nobody.
    for (let i = 1; i <= 480; i++) await publishCard(card.id, T0 + MIN + i * BASE_LOOK_MS);
    const parked = runOf(card);
    expect(parked.publish).toMatchObject({ state: "base-red", tries: 0, reran: [] });
    expect(parked.blocked[0]!.message).toBe("Finish is run by Agetor: develop is failing web — parked: no agent, no step slot, no attempt spent. Agetor re-tests this change when develop is green");
    expectNothingSpent(card);
    expect(await repos.remote("claude/x")).toBe(repos.head);

    // The base is fixed by a commit that does not touch the change's files.
    const later = T0 + 2000 * MIN;
    const fixed = await repos.moveBase("z.txt", "base, fixed\n");
    gh.checks.set(fixed, GREEN);
    await publishCard(card.id, later);

    // A recovered base is merged by Build, then independently reviewed.
    const run = runOf(card);
    expect(run.publish).toBeUndefined();
    expect(run.history.at(-1)!.handoff!.summary).toContain("Finish never merges");
    expect(await repos.remote("claude/x")).toBe(repos.head);
    expect(await sh(repos.repo, "git", "rev-parse", "HEAD")).toBe(repos.head);

  }, 60_000);

  test("the recovered base conflicts with the change: back to Build with the files, as today", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    gh.checks.set(repos.head, RED);
    gh.checks.set(repos.baseTip, RED);
    await publishCard(card.id, T0 + MIN);
    const fixed = await repos.moveBase("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten!\n");
    gh.checks.set(fixed, GREEN);
    await publishCard(card.id, T0 + 10 * MIN);

    const run = runOf(card);
    expect(run.publish).toBeUndefined();
    expect(await repos.remote("claude/x")).toBe(repos.head); // nothing pushed
    expect(await sh(repos.repo, "git", "rev-parse", "HEAD")).toBe(repos.head); // the worktree is untouched
    const record = run.history.at(-1)!;
    expect(record).toMatchObject({ seq: 3, stepId: card.finish.id, outcome: "succeeded", nextStepIds: [card.build.id], responseKind: "handoff" });
    expect(record.handoff!.purpose).toContain("conflicts with develop");
    expect(record.handoff!.summary).toContain("- a.txt");
    expect(record.handoff!.summary).toContain("Found by Agetor while it ran Finish");
    expect(record.handoff!.next).toBe("verification failed");
    // Build's launch got Finish's handoff as its arrival.
    expect(run.blocked.map((b) => [b.kind, b.stepId, b.pending?.arrivals[0]?.fromStepId, b.pending?.arrivals[0]?.seq])).toEqual([["profile-missing", card.build.id, card.finish.id, 3]]);
    expect(run.stepCount).toBe(3); // one execution, as an agent's Finish costs
  }, 60_000);

  test("the recovered base already holds part of the change: the diff would change, so Build merges it", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    gh.checks.set(repos.head, RED);
    gh.checks.set(repos.baseTip, RED);
    await publishCard(card.id, T0 + MIN);
    // The same edit to a.txt lands on the base: the merge is clean, but the
    // change's own diff against the base no longer includes it.
    const fixed = await repos.moveBase("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    gh.checks.set(fixed, GREEN);
    await publishCard(card.id, T0 + 10 * MIN);
    const run = runOf(card);
    expect(run.publish).toBeUndefined();
    expect(run.history.at(-1)!.handoff!.summary).toContain("merge origin/develop into this branch");
    expect(await repos.remote("claude/x")).toBe(repos.head);
    expect(await sh(repos.repo, "git", "rev-parse", "HEAD")).toBe(repos.head);
  }, 60_000);
});

describe("the base moved before the first push", () => {
  test("a clean merge that leaves the change's diff alone is made by Agetor, so the PR's checks are fresh", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const moved = await repos.moveBase("z.txt", "base, moved\n");
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    expect(await repos.remote("claude/x")).toBe(repos.head);
    expect(runOf(card).publish).toMatchObject({ state: "wait-ci", head: repos.head, approvedHead: repos.head, carried: 0, baseTip: moved });
    expect(await sh(repos.repo, "git", "rev-parse", "HEAD")).toBe(repos.head);
    expectNothingSpent(card);
  }, 60_000);

  test("a conflict goes to Build before anything is pushed", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    await repos.moveBase("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten!\n");
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    expect(await repos.remote("claude/x")).toBeNull();
    expect(runOf(card).history.at(-1)!.handoff!.purpose).toBe("Verification failed: the branch conflicts with develop");
  }, 60_000);
});

describe("failures of the change's own", () => {
  test("the job passes on the base: back to Build with the job and its log, and Finish is one execution", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    gh.checks.set(repos.baseTip, GREEN);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    gh.checks.set(repos.head, RED);
    await publishCard(card.id, T0 + MIN);
    const run = runOf(card);
    expect(run.publish).toBeUndefined();
    const record = run.history.at(-1)!;
    expect(record.handoff!.summary).toContain("- web (failure)");
    expect(record.handoff!.reason).toContain("test failed: expected 1, got 2");
    expect(record.handoff!.summary).not.toContain("fix round");
    // The record has a hidden task of its own, so the card's strip can open it.
    expect(tasks.get(record.taskId)).toMatchObject({ pipelineParentId: card.id, pipelineStepId: card.finish.id, column: "done", runId: null });
    expect(gh.reruns).toEqual([]);
  }, 60_000);

  test("the suite was not selected on the base tip: an older base commit that ran it decides", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    // The tip ran only lint; the commit before it failed `web`.
    const tip = await repos.moveBase("z.txt", "docs only\n");
    gh.checks.set(tip, [check("lint", "success", 1, 5)]);
    gh.checks.set(repos.baseTip, RED);
    gh.checks.set(repos.head, RED);
    await publishCard(card.id, T0 + MIN);
    expect(runOf(card).publish).toMatchObject({ state: "base-red", inherited: ["web"] });
  }, 60_000);

  test("a runner fault is re-run once, not sent to Build", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    gh.checks.set(repos.baseTip, GREEN);
    gh.log = "Error: The runner has received a shutdown signal.";
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    gh.checks.set(repos.head, RED);
    await publishCard(card.id, T0 + MIN);
    expect(gh.reruns.sort()).toEqual([9001, 9002]);
    expect(runOf(card).publish).toMatchObject({ state: "wait-ci", reran: [{ why: "infra" }] });
    expectNothingSpent(card);
  }, 60_000);

  test("Finish → Build has a traversal limit: Agetor's route counts against it and stops for the owner", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    gh.checks.set(repos.baseTip, GREEN);
    const card = makeCard(repos.repo, approvalHandoff(repos.head), { maxTraversals: 1 });
    await publishCard(card.id, T0);
    gh.checks.set(repos.head, RED);
    await publishCard(card.id, T0 + MIN);
    expect(runOf(card).history.at(-1)).toMatchObject({ stepId: card.finish.id, nextStepIds: [card.build.id] });

    // A second visit in the same run, failing the same way.
    const run = runOf(card);
    run.blocked = [{ taskId: null, stepId: card.finish.id, kind: "await", message: "", pending: { stepId: card.finish.id, arrivals: [] } }];
    run.publish = { ...initialPublishState(card.finish.id, T0 + 2 * MIN), state: "classify", base: "develop", approvedHead: repos.head, head: repos.head, pr: { number: 7, url: "u" } };
    tasks.setPipelineRun(card.id, run);
    await publishCard(card.id, T0 + 3 * MIN);
    const after = runOf(card);
    expect(after.status).toBe("blocked");
    expect(after.blocked.map((b) => [b.kind, b.stepId])).toEqual([["step-blocked", card.finish.id]]);
    expect(after.blocked[0]!.message).toContain("already taken that route 1 of 1 times");
    expect(after.history.filter((h) => h.stepId === card.finish.id)).toHaveLength(1);
  }, 60_000);
});

describe("what is never published", () => {
  test("a commit made after Review approved: back to Build with the commits, nothing pushed, no agent turn", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    writeFileSync(path.join(repos.repo, "late.txt"), "late\n");
    await sh(repos.repo, "git", "add", ".");
    await sh(repos.repo, "git", "commit", "-qm", "fix: after the review");
    await publishCard(card.id, T0);
    const run = runOf(card);
    expect(await repos.remote("claude/x")).toBeNull();
    expect(run.publish).toBeUndefined();
    expect(run.history.at(-1)!.handoff!.summary).toContain("fix: after the review");
    expect(run.history.at(-1)!.handoff!.purpose).toBe("Verification failed: HEAD is not the head Review approved");
  }, 60_000);

  test("uncommitted tracked changes: back to Build, nothing pushed", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    writeFileSync(path.join(repos.repo, "a.txt"), "scribble\n");
    await publishCard(card.id, T0);
    expect(await repos.remote("claude/x")).toBeNull();
    expect(runOf(card).history.at(-1)!.handoff!.summary).toContain("- a.txt");
  }, 60_000);

  test("a Review that requested changes is not published", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head, { verdict: "changes-requested", findings: ["a bug"], acceptanceComplete: false }));
    await publishCard(card.id, T0);
    expect(await repos.remote("claude/x")).toBeNull();
    expect(runOf(card).history.at(-1)!.handoff!.purpose).toBe("Verification failed: Review did not approve this head");
  }, 60_000);

  test("the remote branch holds commits the worktree lacks: the owner, never a force-push; Retry resumes the visit", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    // Someone else pushed to the card's branch.
    await sh(repos.repo, "git", "push", "-q", "origin", "origin/develop:refs/heads/claude/x");
    const foreign = await sh(path.join(repos.root, "other"), "git", "rev-parse", "HEAD");
    await sh(path.join(repos.root, "other"), "git", "fetch", "-q", "origin");
    await sh(path.join(repos.root, "other"), "git", "checkout", "-q", "-B", "claude/x", "origin/claude/x");
    writeFileSync(path.join(repos.root, "other", "foreign.txt"), "x\n");
    await sh(path.join(repos.root, "other"), "git", "add", ".");
    await sh(path.join(repos.root, "other"), "git", "commit", "-qm", "foreign");
    await sh(path.join(repos.root, "other"), "git", "push", "-q", "origin", "HEAD:claude/x");
    const theirs = await repos.remote("claude/x");
    expect(theirs).not.toBe(foreign);

    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    await publishCard(card.id, T0);
    let run = runOf(card);
    expect(run.status).toBe("blocked");
    expect(run.blocked.map((b) => [b.taskId, b.kind, b.stepId])).toEqual([[null, "step-blocked", card.finish.id]]);
    expect(run.blocked[0]!.message).toContain("Agetor never force-pushes");
    expect(run.publish!.state).toBe("push");
    expect(await repos.remote("claude/x")).toBe(theirs);

    // Retry is a launch of Finish: under the gate it is parked for Agetor
    // again, the same visit, not a new agent.
    await retryPipelineStep(card.id);
    await withPipelineLock(card.id, async () => undefined);
    run = runOf(card);
    expect(run.status).toBe("running");
    expect(run.blocked.map((b) => [b.taskId, b.kind, b.stepId, b.pending?.arrivals.length])).toEqual([[null, "await", card.finish.id, 1]]);
    expect(run.publish).toMatchObject({ state: "push", head: repos.head, since: T0 - MIN });
    expect(tasks.stepsForParent(card.id)).toEqual([]);
  }, 60_000);

  test("a card whose branch is a base branch is never pushed", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head), { branch: "develop" });
    await publishCard(card.id, T0);
    expect(runOf(card).blocked[0]!.message).toContain("never pushes to a base branch");
    expect(await repos.remote("develop")).toBe(repos.baseTip);
  }, 60_000);
});

describe("the switch", () => {
  test("no reviewApproval in Review's handoff: this visit is the agent's, as before", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const noApproval = { ...approvalHandoff(repos.head) };
    delete noApproval.reviewApproval;
    const card = makeCard(repos.repo, noApproval);
    await publishCard(card.id, T0);
    const run = runOf(card);
    expect(run.publish!.state).toBe("agent");
    expect(run.publish!.brief).toBeUndefined();
    expect(run.blocked.map((b) => [b.kind, b.stepId])).toEqual([["profile-missing", card.finish.id]]);
    expect(await repos.remote("claude/x")).toBeNull();
  }, 60_000);

  test("taken out of pipeline_gates while held: the agent runs Finish again, at once", async () => {
    const repos = await makeRepos();
    fakeGitHub(repos);
    const card = makeCard(repos.repo, approvalHandoff(repos.head));
    preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ publish: { pipelines: ["Change"], cards: ["some-other-card"] } }));
    await publishCard(card.id, T0);
    expect(runOf(card).publish!.state).toBe("agent");
    expect(await repos.remote("claude/x")).toBeNull();
  }, 60_000);

  test("a started run adopts or drops the gate only when asked to", async () => {
    const repos = await makeRepos();
    const card = makeCard(repos.repo, approvalHandoff(repos.head), { gates: false });
    // The preference names the card, but the run started without the gate.
    expect(runOf(card).snapshot!.gates).toBeUndefined();
    expect(await adoptPipelineGates(card.id)).toEqual({ publish: true, steps: false, changed: true });
    expect(runOf(card).snapshot!.gates).toEqual({ publish: true });
    expect(await adoptPipelineGates(card.id)).toEqual({ publish: true, steps: false, changed: false });
    preferences.set(PIPELINE_GATES_PREF, "{}");
    expect(await adoptPipelineGates(card.id)).toEqual({ publish: false, steps: false, changed: true });
    expect(runOf(card).snapshot!.gates).toBeUndefined();
    // A trial list that does not name the card leaves it out.
    preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ publish: { pipelines: ["Change"], cards: [card.id] } }));
    expect(await adoptPipelineGates(card.id)).toEqual({ publish: true, steps: false, changed: true });
  }, 60_000);

  test("the visit's state survives the run's sanitizer; an unreadable one is dropped", () => {
    const p = { ...initialPublishState("finish", T0), state: "base-red" as const, base: "develop", head: "a".repeat(40), approvedHead: "a".repeat(40), inherited: ["web"], carried: 1,
      pr: { number: 7, url: "u" }, reran: [{ head: "a".repeat(40), why: "infra" as const, at: T0 }], posted: "a".repeat(40), seq: 4, brief: "write" };
    const stored = (publish: unknown) => parsePipelineRunState(JSON.stringify({ pipelineId: "p", publish }))?.publish;
    expect(stored(p)).toEqual(p);
    expect(stored({ ...p, state: "nonsense" })).toBeUndefined();
    expect(stored({ ...p, stepId: "" })).toBeUndefined();
    expect(stored("x")).toBeUndefined();
    expect(stored({ ...p, head: "not a sha", reran: [{ head: "x", why: "because", at: 1 }], tries: -3 })).toMatchObject({ head: null, reran: [], tries: 0 });
    expect(parsePipelineRunState(JSON.stringify({ pipelineId: "p", snapshot: { graph: { steps: [], edges: [] }, gates: { publish: true } } }))?.snapshot?.gates).toEqual({ publish: true });
    expect(parsePipelineRunState(JSON.stringify({ pipelineId: "p", snapshot: { graph: { steps: [], edges: [] }, gates: { publish: "yes" } } }))?.snapshot?.gates).toBeUndefined();
  });
});

test("the draft description never says Fixes: that is the writer's to decide", () => {
  expect(publishDraftBody("- did it", 12)).toContain("Refs #12");
  expect(publishDraftBody("- did it", 12)).not.toMatch(/\bfix(es|ed)?\s+#/i);
  expect(publishDraftBody(null, null)).not.toContain("#");
});

test("automatic sign-off rejects legacy carried approval for a different head", () => {
  const approved = "a".repeat(40), merged = "c".repeat(40);
  const review = newStep({ name: "Review", agentProfileId: "rev" });
  const finish = newStep({ name: "Finish", agentProfileId: "fin" });
  const prUrl = "https://github.com/pillar-interactive/pillar/pull/7";
  const issueUrl = "https://github.com/pillar-interactive/pillar/issues/3";
  const card = (publish: PipelineRunState["publish"]) => ({
    id: "t", workdir: "/p", pipelineId: "p", pipelineParentId: null, issueUrl, prUrl,
    pipelineRun: {
      status: "done", endedAt: 200, publish,
      snapshot: { graph: { steps: [review, finish], edges: [], startStepId: null }, profiles: { rev: { model: "gpt-6.1-sol" } } },
      history: [
        { seq: 1, stepId: review.id, outcome: "succeeded", nextStepIds: [finish.id], handoff: { ...approvalHandoff(approved), reviewApproval: { ...approvalHandoff(approved).reviewApproval!, issueUrl } } },
        { seq: 2, stepId: finish.id, outcome: "succeeded", nextStepIds: [], handoff: { ...approvalHandoff(approved), reviewApproval: undefined, artifacts: [prUrl] } },
      ],
    },
  }) as unknown as Task;
  const cfg = { autoMergePipelines: true, autoMergeSince: 100, roadmap: { issue: 639 }, project: "/p" } as never;
  const pr = (headSha: string) => ({ taskId: "t", number: 7, url: prUrl, state: "open", draft: false, baseRef: "develop", headSha, checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0 }) as never;
  const carried = { ...initialPublishState(finish.id, 0), state: "write" as const, approvedHead: approved, head: merged, carried: 1 };
  expect(reviewedPillarPipeline(card(undefined), cfg, pr(approved))).toBe(true);
  expect(reviewedPillarPipeline(card(undefined), cfg, pr(merged))).toBe(false);
  expect(reviewedPillarPipeline(card(carried), cfg, pr(merged))).toBe(false);
  expect(reviewedPillarPipeline(card(carried), cfg, pr("d".repeat(40)))).toBe(false);
  expect(reviewedPillarPipeline(card({ ...carried, carried: 0 }), cfg, pr(merged))).toBe(false);
});

test("the writer: the step's agent gets the brief in place of Finish's instructions, and its turn ends the run whatever next it names", async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  initPipelineRunner();
  const repos = await makeRepos();
  fakeGitHub(repos);
  await sh(repos.repo, "git", "push", "-q", "origin", "HEAD:refs/heads/claude/x");
  gh.pull = { number: 7, url: "https://github.com/o/r/pull/7", state: "open", draft: true };
  gh.checks.set(repos.head, GREEN);
  const profile = {
    id: "missing-profile", name: "Finisher", harness: "claude-code", harnessKind: "claude-code" as const, harnessLabel: "Claude Code", model: "fake-model",
    effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [], capturedAt: T0,
  };
  // The scripted agent hands off with "next": "Build" — the edge an agent's
  // Finish would take for a failure.
  const card = makeCard(repos.repo, approvalHandoff(repos.head), {
    profiles: { "missing-profile": profile }, prompt: `Fix the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:Build`,
    publish: { state: "finalize", base: "develop", approvedHead: repos.head, head: repos.head, pr: { number: 7, url: "https://github.com/o/r/pull/7" } },
  });
  try {
    await publishCard(card.id, T0);
    // Wait for the scripted turn to settle (a condition, not a duration).
    for (let i = 0; i < 2000 && runOf(card).status !== "done" && runOf(card).status !== "blocked"; i++) await new Promise((r) => setTimeout(r, 10));
    const run = runOf(card);
    expect(run.status).toBe("done");
    const writer = run.history.at(-1)!;
    expect(writer).toMatchObject({ seq: 3, stepId: card.finish.id, outcome: "succeeded", nextStepIds: [] });
    expect(writer.handoff!.next).toBe("Build"); // what it wrote is kept; it is not followed
    expect(run.history.filter((h) => h.stepId === card.build.id)).toHaveLength(1); // no new Build
    expect(run.publish).toMatchObject({ state: "write", seq: 3 });
    const prompt = tasks.get(writer.taskId)!.prompt;
    expect(prompt).toContain("Finish is run by Agetor for this card");
    expect(prompt).toContain("gh pr edit 7 --body-file");
    expect(prompt).not.toContain("ORIGINAL FINISH INSTRUCTIONS");
    expect(prompt).not.toContain("Publish only the exact independently approved head");
    expect(prompt).toContain("Approved: every criterion is met."); // Review's handoff is its arrival
    expect(await repos.remote("claude/x")).toBe(repos.head);
  } finally {
    await deleteTask(card.id).catch(() => undefined);
  }
}, 60_000);

test("local verification failure returns to Build without publishing", async () => {
  const repos = await makeRepos();
  fakeGitHub(repos);
  const card = makeCard(repos.repo, approvalHandoff(repos.head));
  publishDeps.verify = async () => ({ ok: false, error: "named regression failed" });
  await publishCard(card.id, T0);
  expect(await repos.remote("claude/x")).toBeNull();
  expect(await sh(repos.repo, "git", "rev-parse", "HEAD")).toBe(repos.head);
  expect(runOf(card).publish).toBeUndefined();
  expect(runOf(card).history.at(-1)!.handoff!.summary).toContain("named regression failed");
});

test("verification cannot mutate the reviewed head and publish it", async () => {
  const repos = await makeRepos();
  fakeGitHub(repos);
  const card = makeCard(repos.repo, approvalHandoff(repos.head));
  publishDeps.verify = async () => {
    writeFileSync(path.join(repos.repo, "feature.txt"), "unreviewed change");
    await sh(repos.repo, "git", "add", "feature.txt");
    await sh(repos.repo, "git", "commit", "-qm", "fix: unreviewed");
    return { ok: true };
  };
  await publishCard(card.id, T0);
  expect(await repos.remote("claude/x")).toBeNull();
  expect(runOf(card).history.at(-1)!.handoff!.summary).toContain("changed during selected verification");
});

test("cancellation during selected verification prevents publication", async () => {
  const repos = await makeRepos();
  fakeGitHub(repos);
  const card = makeCard(repos.repo, approvalHandoff(repos.head));
  publishDeps.verify = async () => {
    const run = runOf(card);
    tasks.setPipelineRun(card.id, { ...run, status: "cancelled" });
    return { ok: true };
  };
  await publishCard(card.id, T0);
  expect(await repos.remote("claude/x")).toBeNull();
  expect(runOf(card).status).toBe("cancelled");
});
