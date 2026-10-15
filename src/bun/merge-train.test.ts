import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TaskPrStatus } from "../shared/types.ts";
import { assembleTrain, parseTrainConfig, shouldDepart, trainBody, trainEligible, trainTitle } from "./merge-train.ts";

const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus =>
  ({ taskId: "t", number: 9, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "h", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, behindBy: 3, ...o }) as TaskPrStatus;
const clean = { mergeable: true, mergeableState: "clean" };

describe("who can ride a train", () => {
  test("green, open, no threads, not conflicting — behind the base is fine", () => {
    expect(trainEligible(pr(), clean)).toBe(true);
    expect(trainEligible(pr({ checks: "pending" }), clean)).toBe(false);
    expect(trainEligible(pr({ unresolvedThreads: 1 }), clean)).toBe(false);
    expect(trainEligible(pr({ draft: true }), clean)).toBe(false);
    expect(trainEligible(pr(), { mergeable: false, mergeableState: "dirty" })).toBe(false);
    expect(trainEligible(null, clean)).toBe(false);
  });
});

describe("when a train leaves", () => {
  const cfg = parseTrainConfig(null);
  test("defaults", () => expect(cfg).toEqual({ enabled: true, windowMin: 10, max: 6 }));
  test("two or more, once the oldest waited the window — or as soon as it's full", () => {
    const now = 100 * 60_000;
    expect(shouldDepart([now - 11 * 60_000, now], cfg, now)).toBe(true);
    expect(shouldDepart([now - 5 * 60_000, now], cfg, now)).toBe(false);
    expect(shouldDepart([now - 60 * 60_000], cfg, now)).toBe(false);
    expect(shouldDepart(Array(6).fill(now), cfg, now)).toBe(true);
    expect(shouldDepart([0, 0], { ...cfg, enabled: false }, now)).toBe(false);
  });
});

describe("the fresh rule", () => {
  const cfg = parseTrainConfig(null);
  test("fresh means the head contains the base's tip; unknown is stale", async () => {
    const { freshAgainstBase } = await import("./merge-train.ts");
    expect(freshAgainstBase({ behindBy: 0 })).toBe(true);
    expect(freshAgainstBase({ behindBy: 2 })).toBe(false);
    expect(freshAgainstBase({ behindBy: null })).toBe(false);
    expect(freshAgainstBase({})).toBe(false);
  });
  test("on unless the preference says false", async () => {
    const { freshRuleOn } = await import("./merge-train.ts");
    expect(freshRuleOn(null)).toBe(true);
    expect(freshRuleOn("true")).toBe(true);
    expect(freshRuleOn("false")).toBe(false);
    expect(freshRuleOn(" FALSE ")).toBe(false);
  });
  test("a lone stale PR leaves as a train of one immediately", () => {
    const now = 100 * 60_000;
    expect(shouldDepart([now], cfg, now, 1)).toBe(true);
    expect(shouldDepart([now - 5 * 60_000], cfg, now, 1)).toBe(true);
    expect(shouldDepart([now - 11 * 60_000], cfg, now)).toBe(false); // without min=1: never alone
    expect(shouldDepart([], cfg, now, 1)).toBe(false);
    expect(shouldDepart([0], { ...cfg, enabled: false }, now, 1)).toBe(false);
  });
  test("a train of one says what it is for, and what a failure leads to", () => {
    const body = trainBody([{ pr: 7, title: "fix: a" }], "develop");
    expect(body).toContain("Re-tests one signed-off pull request on the latest `develop`");
    expect(body).toContain("updated from the base");
    expect(trainTitle([{ pr: 7 }])).toBe("Merge train: #7");
  });
  test("what members are told when a train disbands, with the CI cost", async () => {
    const { disbandNote } = await import("./merge-train.ts");
    const m = (n: number) => ({ taskId: `t${n}`, pr: n, branch: `b${n}`, title: "t", headSha: null });
    const three = { pr: 50, base: "develop", members: [m(1), m(2), m(3)] };
    const one = { pr: 51, base: "develop", members: [m(1)] };
    expect(disbandNote(three, "its CI failed", { fresh: true, ciFailed: true }))
      .toBe("Merge train #50 disbanded (its CI failed) — each of its 3 PRs is re-tested alone on the latest develop before it merges (up to 3 more CI runs, one at a time)");
    expect(disbandNote(one, "its CI failed", { fresh: true, ciFailed: true }))
      .toBe("Merge train #51 disbanded (its CI failed): this PR passes alone but fails on the latest develop — updating its branch so the failure shows on the PR");
    expect(disbandNote(three, "#2 got new commits", { fresh: true, ciFailed: false })).toContain("handled on its own");
    // Rule off: the wording, and the behaviour, of before.
    expect(disbandNote(three, "its CI failed", { fresh: false, ciFailed: true })).toBe("Merge train #50 disbanded (its CI failed) — merging on its own");
  });
});

test("train PR title and body name every PR", () => {
  const m = [{ pr: 164, title: "fix: a" }, { pr: 165, title: "fix: b" }];
  expect(trainTitle(m)).toBe("Merge train: #164, #165");
  expect(trainBody(m, "develop")).toContain("- #164 — fix: a");
  expect(trainBody(m, "develop")).toContain("**rebase**");
});

async function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

test("assembling: one squashed commit per PR on the latest base; a PR that conflicts drops out", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "train-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
  await sh(root, "git", "clone", "-q", origin, repo);
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "base");
  await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");
  const branch = async (name: string, file: string, text: string, commits = 1) => {
    await sh(repo, "git", "checkout", "-q", "-b", name, "origin/develop");
    for (let i = 0; i < commits; i++) {
      writeFileSync(path.join(repo, file), `${text}${i}\n`);
      await sh(repo, "git", "commit", "-qam", `wip ${name} ${i}`);
    }
    await sh(repo, "git", "push", "-q", "origin", name);
  };
  writeFileSync(path.join(repo, "b.txt"), "");
  await sh(repo, "git", "add", "b.txt");
  await sh(repo, "git", "commit", "-qm", "b");
  await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");
  await branch("feat-a", "a.txt", "A", 3);
  await branch("feat-b", "b.txt", "B");
  await branch("feat-c", "a.txt", "C"); // same line as feat-a → conflicts once A is on the train
  await sh(repo, "git", "checkout", "-q", "develop");

  const m = (taskId: string, n: number, b: string) => ({ taskId, pr: n, branch: b, title: `fix: ${b}`, headSha: null });
  const { members, dropped } = await assembleTrain(repo, "develop", "agetor/merge-train-x", path.join(root, "wt"), [m("a", 1, "feat-a"), m("b", 2, "feat-b"), m("c", 3, "feat-c")]);
  expect(members.map((x) => x.pr)).toEqual([1, 2]);
  expect(dropped.map((d) => [d.member.pr, d.why])).toEqual([[3, "conflicts with the other PRs"]]);
  const log = await sh(repo, "git", "log", "--format=%s", "origin/develop..origin/agetor/merge-train-x");
  expect(log.split("\n")).toEqual(["fix: feat-b (#2)", "fix: feat-a (#1)"]); // three wip commits squashed into one
  // Each member records the head it was squashed from (not a cached, possibly stale one).
  expect(members[0]!.headSha).toBe(await sh(repo, "git", "rev-parse", "origin/feat-a"));

  // A train of one: pushed only when asked for (the fresh rule), built on the latest base.
  const none = await assembleTrain(repo, "develop", "agetor/merge-train-y", path.join(root, "wt-y"), [m("b", 2, "feat-b")]);
  expect(none.members.map((x) => x.pr)).toEqual([2]);
  expect(await sh(repo, "git", "ls-remote", "origin", "refs/heads/agetor/merge-train-y")).toBe("");
  const alone = await assembleTrain(repo, "develop", "agetor/merge-train-z", path.join(root, "wt-z"), [m("b", 2, "feat-b")], 1);
  expect(alone.members.map((x) => x.pr)).toEqual([2]);
  expect((await sh(repo, "git", "log", "--format=%s", "origin/develop..origin/agetor/merge-train-z")).split("\n")).toEqual(["fix: feat-b (#2)"]);
  expect(await sh(repo, "git", "rev-parse", "origin/agetor/merge-train-z~1")).toBe(await sh(repo, "git", "rev-parse", "origin/develop"));
}, 30_000);

test("sent by hand: a PR whose own checks are still running can ride; failing, conflicting, draft or commented ones can't", async () => {
  const { manualTrainEligible } = await import("./merge-train.ts");
  expect(manualTrainEligible(pr({ checks: "pending" }), clean)).toBe(true);
  expect(manualTrainEligible(pr({ checks: "success" }), clean)).toBe(true);
  expect(manualTrainEligible(pr({ checks: "failure" }), clean)).toBe(false);
  expect(manualTrainEligible(pr(), { mergeable: false, mergeableState: "dirty" })).toBe(false);
  expect(manualTrainEligible(pr({ draft: true }), clean)).toBe(false);
  expect(manualTrainEligible(pr({ unresolvedThreads: 2 }), clean)).toBe(false);
});

test("bisection: disbanding a failed train of >= 3 members queues two halves instead of skipping all", async () => {
  const { disband, getBisectQueue, clearBisectQueueForTests, resetTrainMarksForTests, skipsTrain } = await import("./merge-train.ts");
  clearBisectQueueForTests();
  resetTrainMarksForTests();
  const train = {
    id: "tr1",
    project: "/tmp/nonexistent-project",
    branch: "agetor/merge-train-1",
    base: "develop",
    pr: 99,
    url: "https://github.com/foo/bar/pull/99",
    members: [
      { taskId: "t1", pr: 101, branch: "b1", title: "t1", headSha: "h1" },
      { taskId: "t2", pr: 102, branch: "b2", title: "t2", headSha: "h2" },
      { taskId: "t3", pr: 103, branch: "b3", title: "t3", headSha: "h3" },
      { taskId: "t4", pr: 104, branch: "b4", title: "t4", headSha: "h4" },
    ],
    createdAt: Date.now(),
    rerunAttempted: false,
  };
  const prs = new Map();
  await disband(train, "its CI failed", prs, true);
  const queue = getBisectQueue();
  expect(queue.length).toBe(2);
  expect(queue[0]).toEqual({ project: "/tmp/nonexistent-project", base: "develop", taskIds: ["t1", "t2"] });
  expect(queue[1]).toEqual({ project: "/tmp/nonexistent-project", base: "develop", taskIds: ["t3", "t4"] });
  expect(skipsTrain({ number: 101, headSha: "h1" } as any)).toBe(false);
});

test("disbanding a failed train of 2 members marks both to skip trains rather than bisecting", async () => {
  const { disband, getBisectQueue, clearBisectQueueForTests, resetTrainMarksForTests, skipsTrain } = await import("./merge-train.ts");
  clearBisectQueueForTests();
  resetTrainMarksForTests();
  const train = {
    id: "tr2",
    project: "/tmp/nonexistent-project",
    branch: "agetor/merge-train-2",
    base: "develop",
    pr: 100,
    url: "https://github.com/foo/bar/pull/100",
    members: [
      { taskId: "t1", pr: 101, branch: "b1", title: "t1", headSha: "h1" },
      { taskId: "t2", pr: 102, branch: "b2", title: "t2", headSha: "h2" },
    ],
    createdAt: Date.now(),
  };
  const prs = new Map([
    ["t1", { number: 101, headSha: "h1" } as any],
    ["t2", { number: 102, headSha: "h2" } as any],
  ]);
  await disband(train, "its CI failed", prs, true);
  expect(getBisectQueue().length).toBe(0);
  expect(skipsTrain({ number: 101, headSha: "h1" } as any)).toBe(true);
  expect(skipsTrain({ number: 102, headSha: "h2" } as any)).toBe(true);
});

test("disbanding a failed train of 1 member marks it as failedAlone", async () => {
  const { disband, resetTrainMarksForTests, trainFailedAlone } = await import("./merge-train.ts");
  resetTrainMarksForTests();
  const train = {
    id: "tr3",
    project: "/tmp/nonexistent-project",
    branch: "agetor/merge-train-3",
    base: "develop",
    pr: 101,
    url: "https://github.com/foo/bar/pull/101",
    members: [
      { taskId: "t1", pr: 101, branch: "b1", title: "t1", headSha: "h1" },
    ],
    createdAt: Date.now(),
  };
  const prs = new Map([["t1", { number: 101, headSha: "h1" } as any]]);
  await disband(train, "its CI failed", prs, true);
  expect(trainFailedAlone({ number: 101, headSha: "h1" })).toBe(true);
});

test("assembling with regenerable conflicts: resolves conflict via scratch worktree when covered by regenerate rules", async () => {
  const { preferences } = await import("./db.ts");
  const { MERGE_REGENERATE_PREF } = await import("../shared/publish.ts");
  const root = mkdtempSync(path.join(tmpdir(), "train-regen-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  preferences.set(MERGE_REGENERATE_PREF, JSON.stringify([{ project: repo, path: "regen.txt", command: "echo regenerated > regen.txt" }]));
  try {
    await sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
    await sh(root, "git", "clone", "-q", origin, repo);
    await sh(repo, "git", "config", "user.email", "t@t");
    await sh(repo, "git", "config", "user.name", "t");
    writeFileSync(path.join(repo, "regen.txt"), "base\n");
    await sh(repo, "git", "add", ".");
    await sh(repo, "git", "commit", "-qm", "base");
    await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");

    // feat-1 modifies regen.txt
    await sh(repo, "git", "checkout", "-q", "-b", "feat-1", "origin/develop");
    writeFileSync(path.join(repo, "regen.txt"), "from feat-1\n");
    await sh(repo, "git", "commit", "-qam", "feat-1");
    await sh(repo, "git", "push", "-q", "origin", "feat-1");

    // feat-2 modifies regen.txt
    await sh(repo, "git", "checkout", "-q", "-b", "feat-2", "origin/develop");
    writeFileSync(path.join(repo, "regen.txt"), "from feat-2\n");
    await sh(repo, "git", "commit", "-qam", "feat-2");
    await sh(repo, "git", "push", "-q", "origin", "feat-2");

    await sh(repo, "git", "checkout", "-q", "develop");

    const m = (taskId: string, n: number, b: string) => ({ taskId, pr: n, branch: b, title: `fix: ${b}`, headSha: null });
    const { members, dropped } = await assembleTrain(repo, "develop", "agetor/merge-train-regen", path.join(root, "wt"), [
      m("1", 1, "feat-1"),
      m("2", 2, "feat-2"),
    ]);

    expect(members.map((x) => x.pr)).toEqual([1, 2]);
    expect(dropped).toEqual([]);
    const log = await sh(repo, "git", "log", "--format=%s", "origin/develop..origin/agetor/merge-train-regen");
    expect(log.split("\n")).toEqual(["fix: feat-2 (#2)", "fix: feat-1 (#1)"]);
  } finally {
    preferences.set(MERGE_REGENERATE_PREF, "");
  }
}, 30_000);

