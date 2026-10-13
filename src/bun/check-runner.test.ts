import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Handoff, PipelineRunState, PipelineStep, StepCheck, Task } from "../shared/types.ts";
import type { CheckRunLike } from "../shared/check-runs.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Git runs for real in temporary repositories whose only remote is a
// temporary bare repository; commands are trivial shell (`true`, `exit 3`,
// `echo`); GitHub is a fake. Nothing is pushed anywhere but that bare
// repository, and no test suite, linter or build is ever started.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-check-runner-"));
process.env.AGETOR_DATA_DIR ??= DATA_DIR;

const { newStep } = await import("../shared/pipeline.ts");
const { builtinCheck, gateVerdict } = await import("../shared/checks.ts");
const { checkDeps, checkLedgerPath, readCheckLedger, recordWaivedChecks, runStepChecks } = await import("./check-runner.ts");

const realDeps = { ...checkDeps };
const T0 = 1_800_000_000_000;

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(args, {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

/** A bare `origin` with `develop` and a clone on the card's branch `claude/x`,
 *  which starts at the base with nothing of its own. */
async function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-check-repo-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "card");
  await sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
  await sh(root, "git", "clone", "-q", origin, repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) await sh(repo, "git", "config", k!, v!);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "base");
  await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");
  await sh(repo, "git", "checkout", "-q", "-b", "claude/x", "origin/develop");
  const commit = async (file: string, text: string) => {
    writeFileSync(path.join(repo, file), text);
    await sh(repo, "git", "add", ".");
    await sh(repo, "git", "commit", "-qm", `change ${file}`);
    return sh(repo, "git", "rev-parse", "HEAD");
  };
  return { root, repo, commit, head: () => sh(repo, "git", "rev-parse", "HEAD") };
}

const build = newStep({ id: "build", name: "Build" });
const review = newStep({ id: "review", name: "Review" });
const finish = newStep({ id: "finish", name: "Finish", canFinish: true });

function card(repo: string, o: { history?: PipelineRunState["history"]; branch?: string } = {}): { parent: Task; run: PipelineRunState } {
  const run: PipelineRunState = {
    pipelineId: "p", pipelineName: "Change", status: "running", active: [], joins: {}, blocked: [], history: o.history ?? [], stepCount: 1, startedAt: T0, endedAt: null,
    snapshot: {
      graph: { steps: [build, review, finish], startStepId: "build", edges: [{ id: "e1", from: "build", to: "review", label: "" }, { id: "e2", from: "review", to: "finish", label: "approved" }] },
      maxSteps: 14, profiles: {}, capturedAt: T0, gates: { steps: true },
    },
  };
  const parent = { id: randomUUID(), workdir: repo, worktreePath: repo, branch: o.branch ?? "claude/x", baseRef: null, issueUrl: "https://github.com/o/r/issues/3", pipelineId: "p", pipelineRun: run } as Task;
  return { parent, run };
}

const evaluate = (c: { parent: Task; run: PipelineRunState }, checks: StepCheck[], o: { step?: PipelineStep; seq?: number; handoff?: Handoff | null } = {}) =>
  runStepChecks({ ...c, step: o.step ?? build, seq: o.seq ?? 1, checks, handoff: o.handoff ?? null });
const outcomes = (results: Awaited<ReturnType<typeof evaluate>>) => results.map((r) => `${r.check.id}:${r.outcome}`);
const cmd = (id: string, command: string, o: Partial<StepCheck> = {}): StepCheck => ({ id, description: `${id} passes`, run: { kind: "command", command }, required: true, timeoutSec: 120, ...o });
const approval = (headSha: string, o: Partial<NonNullable<Handoff["reviewApproval"]>> = {}): Handoff => ({
  schemaVersion: 1, purpose: "review", summary: "ok", reason: "done", next: "Finish", artifacts: [], openQuestions: [], status: "done",
  reviewApproval: { verdict: "approved", headSha, issueUrl: "https://github.com/o/r/issues/3", acceptanceComplete: true, findings: [], ...o },
});

beforeEach(() => {
  Object.assign(checkDeps, realDeps);
  checkDeps.base = async () => "develop";
  checkDeps.now = () => T0;
});

afterAll(() => {
  Object.assign(checkDeps, realDeps);
  rmTestDataDir(DATA_DIR);
});

describe("the built-in checks, on a real worktree", () => {
  test("Build's defaults: nothing committed fails diff-nonempty; a commit passes; an uncommitted edit fails tree-clean", async () => {
    const r = await makeRepo();
    const c = card(r.repo);
    const defaults = [builtinCheck("tree-clean"), builtinCheck("diff-nonempty")];

    const empty = await evaluate(c, defaults);
    expect(outcomes(empty)).toEqual(["tree-clean:pass", "diff-nonempty:fail"]);
    expect(empty[1]!.detail).toBe("no commit ahead of origin/develop");
    expect(gateVerdict(empty).state).toBe("fail");

    await r.commit("feature.txt", "feature\n");
    const done = await evaluate(c, defaults);
    expect(outcomes(done)).toEqual(["tree-clean:pass", "diff-nonempty:pass"]);
    expect(done[1]!.detail).toBe("1 commit ahead of origin/develop");
    expect(gateVerdict(done).state).toBe("pass");

    writeFileSync(path.join(r.repo, "a.txt"), "edited\n");
    writeFileSync(path.join(r.repo, "scratch.tmp"), "untracked files are not the check's business\n");
    const dirty = await evaluate(c, defaults);
    expect(outcomes(dirty)).toEqual(["tree-clean:fail", "diff-nonempty:pass"]);
    expect(dirty[0]!.detail).toBe("1 tracked file has uncommitted changes");
    expect(dirty[0]!.output).toContain("a.txt");
    expect(dirty[0]!.output).not.toContain("scratch.tmp");
  });

  test("review-verdict binds the reviewer's judgement to HEAD; the ledger records the tree Agetor read", async () => {
    const r = await makeRepo();
    const first = await r.commit("feature.txt", "feature\n");
    const c = card(r.repo);
    const checks = [builtinCheck("tree-clean"), builtinCheck("review-verdict")];

    expect(outcomes(await evaluate(c, checks, { step: review, seq: 2, handoff: approval(first) }))).toEqual(["tree-clean:pass", "review-verdict:pass"]);
    // "changes requested" for HEAD is a judgement the run follows, not a failed check.
    expect(outcomes(await evaluate(c, checks, { step: review, seq: 2, handoff: approval(first, { verdict: "changes-requested", acceptanceComplete: false, findings: ["x"] }) }))).toEqual(["tree-clean:pass", "review-verdict:pass"]);
    // No handoff, hence no verdict: this is why a Review is never advanced on a composed handoff.
    const none = await evaluate(c, checks, { step: review, seq: 2, handoff: null });
    expect(outcomes(none)).toEqual(["tree-clean:pass", "review-verdict:fail"]);
    expect(none[1]!.output).toContain('"reviewApproval"');

    // A commit after the approval: the same verdict no longer passes.
    const second = await r.commit("more.txt", "more\n");
    const stale = await evaluate(c, checks, { step: review, seq: 2, handoff: approval(first) });
    expect(stale[1]).toMatchObject({ outcome: "fail", detail: `the verdict is for ${first.slice(0, 8)}, but HEAD is ${second.slice(0, 8)}` });

    const ledger = readCheckLedger(c.parent.id, c.run);
    const tree = await sh(r.repo, "git", "rev-parse", "HEAD^{tree}");
    const base = await sh(r.repo, "git", "rev-parse", "origin/develop");
    expect(ledger.at(-1)).toMatchObject({ stepId: "review", stepName: "Review", seq: 2, turn: 4, checkId: "review-verdict", outcome: "fail", satisfied: false, key: { head: second, tree, baseTip: base }, at: T0 });
    expect(ledger.map((e) => e.turn)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test("head-approved reads the run's last finished Review", async () => {
    const r = await makeRepo();
    const head = await r.commit("feature.txt", "feature\n");
    const rec = (handoff: Handoff) => [{ seq: 2, stepId: "review", taskId: "t", startedAt: T0, endedAt: T0, outcome: "succeeded" as const, handoff, nextStepIds: ["finish"] }];
    expect(outcomes(await evaluate(card(r.repo, { history: rec(approval(head)) }), [builtinCheck("head-approved")], { step: finish }))).toEqual(["head-approved:pass"]);
    expect(outcomes(await evaluate(card(r.repo, { history: rec(approval("f".repeat(40))) }), [builtinCheck("head-approved")], { step: finish }))).toEqual(["head-approved:fail"]);
    expect(outcomes(await evaluate(card(r.repo), [builtinCheck("head-approved")], { step: finish }))).toEqual(["head-approved:fail"]);
  });

  test("merges-with-base and head-published read the local refs and origin, and change nothing", async () => {
    const r = await makeRepo();
    const head = await r.commit("a.txt", "mine\n");
    const c = card(r.repo);
    const checks = [builtinCheck("merges-with-base"), builtinCheck("head-published")];
    expect(outcomes(await evaluate(c, checks))).toEqual(["merges-with-base:pass", "head-published:fail"]);

    await sh(r.repo, "git", "push", "-q", "origin", "HEAD:refs/heads/claude/x");
    expect(outcomes(await evaluate(c, checks))).toEqual(["merges-with-base:pass", "head-published:pass"]);

    // The base changes the same line: a conflict, found without touching the worktree.
    const other = path.join(r.root, "other");
    await sh(r.root, "git", "clone", "-q", path.join(r.root, "origin.git"), other);
    for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) await sh(other, "git", "config", k!, v!);
    writeFileSync(path.join(other, "a.txt"), "theirs\n");
    await sh(other, "git", "commit", "-qam", "base moves");
    await sh(other, "git", "push", "-q", "origin", "HEAD:develop");
    await sh(r.repo, "git", "fetch", "-q", "origin", "develop");
    const conflicted = await evaluate(c, checks);
    expect(conflicted[0]).toMatchObject({ outcome: "fail", detail: "conflicts with origin/develop" });
    expect(conflicted[0]!.output).toContain("a.txt");
    expect(await r.head()).toBe(head);
    expect(await sh(r.repo, "git", "status", "--porcelain")).toBe("");
  });

  test("pr-required-check is a read of GitHub: not applicable without a pull request, the roll-up's result with one", async () => {
    const r = await makeRepo();
    const head = await r.commit("feature.txt", "feature\n");
    const c = card(r.repo);
    const run = (name: string, conclusion: string | null): CheckRunLike => ({ name, status: conclusion === null ? "in_progress" : "completed", conclusion, htmlUrl: null, startedAt: "2026-10-13T10:00:00Z" });
    let pull: { number: number; headSha: string | null; state: string } | null = null;
    let runs: CheckRunLike[] | null = [];
    const asked: string[] = [];
    checkDeps.pull = async () => ({ ok: true, pull });
    checkDeps.checkRuns = async (_t, sha) => {
      asked.push(sha);
      return runs;
    };
    const one = async () => (await evaluate(c, [builtinCheck("pr-required-check")]))[0]!;

    expect(await one()).toMatchObject({ outcome: "skip", satisfied: true });
    expect(asked).toEqual([]); // no pull request: nothing else is read
    pull = { number: 7, headSha: head, state: "open" };
    runs = [run("web", "success"), run("required", "success")];
    expect(await one()).toMatchObject({ outcome: "pass", satisfied: true });
    expect(asked).toEqual([head]);
    runs = [run("web", "failure"), run("required", "failure")];
    expect(await one()).toMatchObject({ outcome: "fail", output: "Failing: web" });
    runs = [run("web", "success"), run("required", null)];
    expect(await one()).toMatchObject({ outcome: "halt", satisfied: false });
    // Without a roll-up the whole set is the verdict.
    runs = [run("web", "success"), run("lint", "failure")];
    expect((await one()).outcome).toBe("fail");
    runs = null;
    expect(await one()).toMatchObject({ outcome: "halt", detail: "GitHub could not be read" });
    checkDeps.pull = async () => ({ ok: false });
    expect((await one()).outcome).toBe("halt");
  });

  test("a card with no worktree, or a base that cannot be found, halts — it never passes and never blames the step", async () => {
    const r = await makeRepo();
    await r.commit("feature.txt", "feature\n");
    const gone = card(path.join(r.root, "missing"));
    const missing = await evaluate(gone, [builtinCheck("tree-clean")]);
    expect(missing[0]).toMatchObject({ outcome: "halt", satisfied: false });
    checkDeps.base = async () => "no-such-branch";
    const unknown = await evaluate(card(r.repo), [builtinCheck("diff-nonempty")]);
    expect(unknown[0]).toMatchObject({ outcome: "halt", detail: "no local ref for the base branch (no-such-branch)" });
    expect(gateVerdict(unknown).state).toBe("halt");
  });
});

describe("command checks", () => {
  test("exit 0 passes, anything else fails with its exit code and the end of its output; the whole output is kept in a file", async () => {
    const r = await makeRepo();
    const c = card(r.repo);
    const results = await evaluate(c, [
      cmd("ok", "true"),
      cmd("three", "echo to-stdout; echo to-stderr >&2; exit 3"),
      cmd("optional", "exit 9", { required: false }),
      cmd("long", "i=0; while [ $i -lt 200 ]; do echo line $i; i=$((i+1)); done; exit 1"),
    ]);
    expect(outcomes(results)).toEqual(["ok:pass", "three:fail", "optional:fail", "long:fail"]);
    expect(results[0]).toMatchObject({ satisfied: true, exitCode: 0, detail: "exit 0", output: "" });
    expect(results[1]).toMatchObject({ satisfied: false, exitCode: 3, detail: "exit 3", output: "to-stdout\nto-stderr" });
    expect(readFileSync(results[1]!.outputPath!, "utf8")).toBe("to-stdout\nto-stderr\n");
    expect(path.basename(results[1]!.outputPath!)).toBe(`check-${T0.toString(36)}-1-1-three.log`);
    // 200 lines: the last 60 go out, the file has them all.
    expect(results[3]!.output.split("\n")[0]).toBe("[… 140 earlier lines not shown …]");
    expect(results[3]!.output.endsWith("line 199")).toBe(true);
    expect(readFileSync(results[3]!.outputPath!, "utf8").split("\n").filter(Boolean)).toHaveLength(200);
    // The optional one failed too, and does not stand in the way.
    expect(gateVerdict(results).failed.map((x) => x.check.id)).toEqual(["three", "long"]);
  });

  test("a command runs in the card's worktree with the check's id in its environment", async () => {
    const r = await makeRepo();
    process.env.EXPECTED = r.repo;
    try {
      const results = await evaluate(card(r.repo), [cmd("where", 'test "$(pwd -P)" = "$(cd "$EXPECTED" && pwd -P)" && test "$AGETOR_CHECK_ID" = where && test "$AGETOR_CHECK_STEP" = Build')]);
      expect(outcomes(results)).toEqual(["where:pass"]);
    } finally {
      delete process.env.EXPECTED;
    }
  });

  test("dependsOn: a check runs only after what it depends on passed, in dependency order", async () => {
    const r = await makeRepo();
    const marker = path.join(r.root, "ran");
    const c = card(r.repo);
    const checks = [
      cmd("suite", `echo suite >> ${marker}`, { dependsOn: ["cheap"] }),
      cmd("cheap", `echo cheap >> ${marker}; exit 1`),
      cmd("after", `echo after >> ${marker}`, { dependsOn: ["suite"] }),
    ];
    const results = await evaluate(c, checks);
    expect(outcomes(results)).toEqual(["cheap:fail", "suite:skip", "after:skip"]);
    expect(results[1]).toMatchObject({ satisfied: false, detail: 'not run: "cheap" did not pass' });
    expect(readFileSync(marker, "utf8")).toBe("cheap\n"); // neither dependent was started
    const verdict = gateVerdict(results);
    expect([verdict.state, verdict.failed.map((x) => x.check.id), verdict.unmet.map((x) => x.check.id)]).toEqual(["fail", ["cheap"], ["suite", "after"]]);

    checks[1] = cmd("cheap", `echo cheap >> ${marker}`);
    expect(outcomes(await evaluate(c, checks))).toEqual(["cheap:pass", "suite:pass", "after:pass"]);
    expect(readFileSync(marker, "utf8")).toBe("cheap\ncheap\nsuite\nafter\n");
  });

  test("skipWhen: a recorded pass for the same head, tree, base and definition is not run again; any of them changing runs it", async () => {
    const r = await makeRepo();
    await r.commit("feature.txt", "feature\n");
    const marker = path.join(r.root, "ran");
    const c = card(r.repo);
    const ran = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);
    const unit = cmd("unit", `echo x >> ${marker}`, { skipWhen: "unchanged-since-pass" });
    const every = cmd("every", `echo x >> ${marker}`);

    expect(outcomes(await evaluate(c, [unit]))).toEqual(["unit:pass"]);
    const again = await evaluate(c, [unit]);
    expect(again[0]).toMatchObject({ outcome: "skip", satisfied: true, detail: "unchanged since it passed — not run again" });
    expect(ran()).toBe(1);
    expect(gateVerdict(again).state).toBe("pass");
    // Still reused on the third look: the reuse is recorded, the pass stays in force.
    expect((await evaluate(c, [unit]))[0]!.outcome).toBe("skip");
    // A check without skipWhen runs every time.
    await evaluate(c, [every]);
    await evaluate(c, [every]);
    expect(ran()).toBe(3);
    // A new commit is a new key.
    await r.commit("more.txt", "more\n");
    expect(outcomes(await evaluate(c, [unit]))).toEqual(["unit:pass"]);
    expect(ran()).toBe(4);
    // A changed command is a different check.
    expect(outcomes(await evaluate(c, [{ ...unit, run: { kind: "command", command: `echo y >> ${marker}` } }]))).toEqual(["unit:pass"]);
    expect(ran()).toBe(5);
    // Another step's pass of a check with the same id is not this step's.
    expect(outcomes(await evaluate(c, [unit], { step: review, seq: 2 }))).toEqual(["unit:pass"]);
    expect(ran()).toBe(6);
    // A failure for this key cancels the recorded pass.
    const failing = { ...unit, run: { kind: "command" as const, command: `echo y >> ${marker}; exit 1` } };
    await evaluate(c, [{ ...unit, run: { kind: "command", command: `echo y >> ${marker}` } }]); // reused
    expect(ran()).toBe(6);
    await evaluate(c, [failing]);
    expect(ran()).toBe(7);
  });

  test("a timeout is a failure of the check; a command that cannot be started is a halt", async () => {
    const r = await makeRepo();
    const c = card(r.repo);
    const seen: { command: string; cwd: string; timeoutSec: number }[] = [];
    // The clock is not involved: the shell is replaced by what it would report.
    checkDeps.command = async (command, cwd, timeoutSec) => {
      seen.push({ command, cwd, timeoutSec });
      return command === "hang" ? { exitCode: 137, timedOut: true, output: "started\n" } : { exitCode: null, timedOut: false, output: "spawn /bin/sh ENOENT" };
    };
    const results = await evaluate(c, [cmd("slow", "hang", { timeoutSec: 7 }), cmd("broken", "x")]);
    expect(results[0]).toMatchObject({ outcome: "fail", detail: "timed out after 7 s", exitCode: 137, output: "started" });
    expect(results[1]).toMatchObject({ outcome: "halt", satisfied: false, exitCode: null });
    expect(seen).toEqual([{ command: "hang", cwd: r.repo, timeoutSec: 7 }, { command: "x", cwd: r.repo, timeoutSec: 120 }]);
  });
});

describe("the ledger", () => {
  test("append-only, one file per run generation, one line per check per evaluation", async () => {
    const r = await makeRepo();
    const c = card(r.repo);
    const file = checkLedgerPath(c.parent.id, c.run);
    expect(path.basename(file)).toBe(`checks-${T0.toString(36)}.jsonl`);
    expect(path.dirname(file).endsWith(path.join("pipeline-runs", c.parent.id))).toBe(true);
    expect(readCheckLedger(c.parent.id, c.run)).toEqual([]);

    await evaluate(c, [cmd("a", "true"), cmd("b", "exit 2", { required: false })]);
    const first = readFileSync(file, "utf8");
    expect(first.split("\n").filter(Boolean)).toHaveLength(2);
    checkDeps.now = () => T0 + 5;
    await evaluate(c, [cmd("a", "true")]);
    const second = readFileSync(file, "utf8");
    expect(second.startsWith(first)).toBe(true); // earlier lines are never rewritten
    expect(readCheckLedger(c.parent.id, c.run).map((e) => [e.seq, e.turn, e.checkId, e.outcome, e.required, e.exitCode, e.at])).toEqual([
      [1, 1, "a", "pass", true, 0, T0], [1, 1, "b", "fail", false, 2, T0], [1, 2, "a", "pass", true, 0, T0 + 5],
    ]);
    // A restart is a new generation: a new file, the old one untouched.
    const restarted = { ...c, run: { ...c.run, startedAt: T0 + 1000 } };
    await evaluate(restarted, [cmd("a", "true")]);
    expect(readFileSync(file, "utf8")).toBe(second);
    expect(readCheckLedger(c.parent.id, restarted.run).map((e) => e.turn)).toEqual([1]);
  });

  test("a waiver is recorded as a waiver and cancels a reusable pass", async () => {
    const r = await makeRepo();
    await r.commit("feature.txt", "feature\n");
    const c = card(r.repo);
    const unit = cmd("unit", "true", { skipWhen: "unchanged-since-pass" });
    await evaluate(c, [unit, cmd("other", "exit 1")]);
    recordWaivedChecks({ ...c, step: build, seq: 1, checks: [unit, cmd("other", "exit 1")], ids: ["other", "unit"] });
    const ledger = readCheckLedger(c.parent.id, c.run);
    expect(ledger.slice(-2).map((e) => [e.checkId, e.outcome, e.satisfied, e.turn])).toEqual([["unit", "waived", false, 1], ["other", "waived", false, 1]]);
    expect(ledger.at(-1)!.key.head).toBe(await r.head());
    expect((await evaluate(c, [unit]))[0]!.outcome).toBe("pass"); // run again, not reused
  });
});
