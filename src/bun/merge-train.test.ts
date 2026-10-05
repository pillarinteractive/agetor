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
