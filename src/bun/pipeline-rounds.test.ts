// Review rounds (src/shared/finding-ledger.ts, the runner's
// `settleReviewFindings`, `classSearchReturn`, `cleanDelta`): the ledger kept
// as Review settles, the close-out after a finding came back twice, the
// Class search gate, and the re-review delta without develop's own hunks.
// Run state is built by hand; GitHub is stubbed; the delta runs real git in a
// scratch repository.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { Handoff, PipelineRunState, Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-rounds-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
const { preferences } = await import("./db.ts");
const { newStep } = await import("../shared/pipeline.ts");
const runner = await import("./pipeline-runner.ts");

const build = newStep({ name: "Build", agentProfileId: "p", instructions: "" });
const review = newStep({ name: "Review", agentProfileId: "p", instructions: "" });
const finish = newStep({ name: "Finish", agentProfileId: "p", instructions: "" });
const graph = {
  steps: [build, review, finish],
  edges: [
    { id: "e1", from: build.id, to: review.id, label: "" },
    { id: "e2", from: review.id, to: build.id, label: "changes requested" },
    { id: "e3", from: review.id, to: finish.id, label: "approved" },
  ],
  startStepId: build.id,
};
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-rounds-wd-"));
const parent = { id: "card", pipelineId: null, issueUrl: "https://github.com/o/r/issues/823", worktreePath: null, workdir: WORKDIR } as unknown as Task;
const freshRun = () => ({ pipelineName: "Change", snapshot: { graph, profiles: {}, decisionPolicy: "agent-followups" }, history: [], stepCount: 0 }) as unknown as PipelineRunState;
const handoff = (findings: string[], verdict: "approved" | "changes-requested" = "changes-requested", extra: Partial<Handoff> = {}): Handoff =>
  ({ schemaVersion: 1, purpose: "", summary: "", reason: "", next: verdict === "approved" ? "Finish" : "Build", artifacts: [], openQuestions: [], status: "done",
    reviewApproval: { verdict, headSha: "a".repeat(40), issueUrl: parent.issueUrl!, acceptanceComplete: verdict === "approved", findings }, ...extra }) as Handoff;
const toBuild = { kind: "steps" as const, stepIds: [build.id] };
const filed: string[] = [];

beforeAll(() => {
  const { PIPELINE_DECISIONS_PREF } = require("../shared/pipeline-decisions.ts");
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: "agent-followups", projects: [WORKDIR] }));
  preferences.set("owner_holds", "resolve");
  runner.findingDeps.fileFollowup = async (_p, id) => { filed.push(id); return { number: 1700 + filed.length, url: "u" }; };
});
afterAll(() => rmTestDataDir(DATA_DIR));

test("a finding that comes back twice is closed out; with nothing else open Review decides once, then the run wraps up", async () => {
  const run = freshRun();
  const settle = (seq: number, findings: string[]) =>
    runner.settleReviewFindings(parent, run, "Review", { stepId: review.id, seq }, handoff(findings), toBuild);
  expect(await settle(2, ["823-R3: budget resets", "823-R9: cap resets"])).toBe(toBuild);
  expect(await settle(4, ["823-R3: envelope excluded"])).toBe(toBuild); // repeat 1: the next Build escalates
  expect(run.findings!["823-R3"]).toMatchObject({ repeat: 1, state: "open" });
  // Third time: closed out, filed as a bug, and Review decides instead of a Build 4.
  expect(await settle(6, ["823-R3: suppressed results"])).toEqual({ kind: "steps", stepIds: [review.id] });
  expect(filed).toEqual(["823-R3"]);
  expect(run.findings!["823-R3"]).toMatchObject({ state: "closed", issue: { number: 1701 } });
  expect(run.findingCloseOut).toMatchObject({ wrapped: false });
  // Review sends it back anyway: the run finishes through the wrap-up.
  expect(await settle(7, ["823-R3: still"])).toBe(toBuild);
  expect(run.findingCloseOut!.wrapped).toBe(true);
  expect(run.capWrapUp).toMatchObject({ closeout: { issues: [] } });
});

test("a close-out beside other open findings lets Build work on the rest", async () => {
  const run = freshRun();
  const settle = (seq: number, findings: string[]) =>
    runner.settleReviewFindings(parent, run, "Review", { stepId: review.id, seq }, handoff(findings), toBuild);
  await settle(2, ["X-1: a"]);
  await settle(4, ["X-1: a"]);
  expect(await settle(6, ["X-1: a", "Y-2: new after a merge"])).toBe(toBuild);
  expect(run.findings!["X-1"]!.state).toBe("closed");
  expect(run.findingCloseOut).toBeUndefined();
});

test("approval resolves every open finding", async () => {
  const run = freshRun();
  await runner.settleReviewFindings(parent, run, "Review", { stepId: review.id, seq: 2 }, handoff(["X-1: a"]), toBuild);
  await runner.settleReviewFindings(parent, run, "Review", { stepId: review.id, seq: 4 }, handoff([], "approved"), { kind: "steps", stepIds: [finish.id] });
  expect(run.findings!["X-1"]!.state).toBe("resolved");
});

test("a Build without Class search lines for the open findings goes back to itself once", async () => {
  const run = freshRun();
  await runner.settleReviewFindings(parent, run, "Review", { stepId: review.id, seq: 2 }, handoff(["823-R3: a", "823-R9: b"]), toBuild);
  const entry = { stepId: build.id, seq: 3, taskId: "t3", startedAt: 0 };
  runner.findingDeps.report = () => "Fixed.\nClass search:\n- 823-R3: rg -n WindowBytes → 3 hits, fixed";
  const b = { ...handoff([]), reviewApproval: undefined, summary: "done" } as Handoff;
  expect(await runner.classSearchReturn(run, "Build", entry, b)).toEqual(["823-R9"]);
  run.classSearchReturned = 3;
  expect(await runner.classSearchReturn(run, "Build", entry, b)).toBeNull(); // the second miss goes on to Review
  runner.findingDeps.report = () => "Class search:\n- 823-R3: rg -n a → 3 hits\n- 823-R9: ast-grep --pattern b → 1 hit (single site)";
  expect(await runner.classSearchReturn(run, "Build", { ...entry, seq: 5 }, b)).toBeNull();
});

test("re-reviews run lighter and repeated findings escalate, unless turned off", () => {
  expect(runner.parseRoundsPolicy(null)).toEqual({ escalateProfile: "Builder", reviewEffort: "medium" });
  expect(runner.parseRoundsPolicy(JSON.stringify({ enabled: false }))).toEqual({ escalateProfile: null, reviewEffort: null });
  expect(runner.parseRoundsPolicy(JSON.stringify({ escalateProfile: "Opus", reviewEffort: "low" }))).toEqual({ escalateProfile: "Opus", reviewEffort: "low" });
});

test("the delta since the last review leaves out develop's own hunks in a file both changed", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-rounds-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const write = (body: string) => writeFileSync(path.join(repo, "bar.go"), body);
  const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i}`).join("\n") + "\n";
  git("init", "-q", "-b", "develop");
  write(lines(40)); git("add", "."); git("commit", "-qm", "base");
  git("branch", "feature");
  // develop changes the top of the file
  write(lines(40, { 2: "develop edit" })); git("commit", "-qam", "develop");
  git("checkout", "-q", "feature");
  write(lines(40, { 30: "build 1" })); git("commit", "-qam", "build 1");
  const reviewed = git("rev-parse", "HEAD");
  git("merge", "-q", "--no-edit", "develop");
  write(lines(40, { 2: "develop edit", 30: "build 1", 35: "build 2" })); git("commit", "-qam", "build 2");
  git("update-ref", "refs/remotes/origin/develop", "develop");
  const d = (await runner.cleanDelta(repo, reviewed, "origin/develop"))!;
  expect(d.diff).toContain("+build 2");
  expect(d.diff).not.toContain("develop edit");
  expect(d.note).toContain("its own changes are left out");
  // No merge since: the plain diff.
  const plain = (await runner.cleanDelta(repo, git("rev-parse", "HEAD~1"), "origin/develop"))!;
  expect(plain.diff).toContain("+build 2");
  expect((await runner.cleanDelta(repo, git("rev-parse", "HEAD"), "origin/develop"))!.note).toContain("no change since");
});

test("a Review that names a dependency is already a wait: the parser makes it blocked", async () => {
  const { normalizeHandoff } = await import("../shared/pipeline.ts");
  const h = normalizeHandoff({ ...handoff(["ARC08-R15: needs #1169"]), waitingOn: { on: "dependency", ref: "#1169" } } as never);
  expect(h).toMatchObject({ status: "blocked", waitingOn: { on: "dependency", ref: "#1169" } });
});
