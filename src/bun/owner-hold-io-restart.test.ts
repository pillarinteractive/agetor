import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The restart once from the base (`restartFromBase`, the `restart-from-base`
// rung of docs/plans/no-owner-holds.md) against a temporary origin and a
// clone of it as the card's worktree. GitHub is stubbed; git is real. Nothing
// here sleeps or measures time.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cap-restart-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const ROOT = mkdtempSync(path.join(tmpdir(), "agetor-cap-restart-"));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};

const { restartFromBase, capRestartSlug } = await import("./owner-hold-io.ts");
type Deps = import("./owner-hold-io.ts").CapRestartDeps;

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const tryGit = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(path.join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", `edit ${file}`);
  return sh(cwd, "rev-parse", "HEAD");
}

let n = 0;
/** An origin with `develop`, and a worktree on the card's branch with one
 *  commit of its own. `pushed`: the card's branch is on origin too. */
function setup(opts: { pushed?: "same" | "older" | false } = {}) {
  const dir = path.join(ROOT, `case-${++n}`);
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const wt = path.join(dir, "wt");
  sh(ROOT, "init", "-q", "--bare", "-b", "develop", origin);
  sh(ROOT, "clone", "-q", origin, seed);
  sh(seed, "checkout", "-q", "-b", "develop");
  commit(seed, "a.txt", "base\n");
  sh(seed, "push", "-q", "origin", "develop");
  sh(ROOT, "clone", "-q", "-b", "develop", origin, wt);
  sh(wt, "checkout", "-q", "-b", "agetor/card-1");
  const first = commit(wt, "card.txt", "attempt 1\n");
  if (opts.pushed) sh(wt, "push", "-q", "-u", "origin", "agetor/card-1");
  const head = opts.pushed === "older" ? commit(wt, "card.txt", "attempt 1, more\n") : first;
  // develop moves on after the card branched.
  const baseTip = commit(seed, "b.txt", "newer base\n");
  sh(seed, "push", "-q", "origin", "develop");
  return { origin, seed, wt, head, remote: opts.pushed ? first : null, baseTip };
}

const remoteRefs = (origin: string): Record<string, string> =>
  Object.fromEntries(sh(origin, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads").split("\n").filter(Boolean).map((l) => l.split(" ").reverse() as [string, string]).map(([sha, ref]) => [ref, sha]));

function deps(over: Partial<Deps> & { pull?: { number: number; url: string; base: string | null } | null } = {}) {
  const closed: { number: number; comment: string }[] = [];
  const calls: string[] = [];
  const d: Deps = {
    git: async (args, cwd) => {
      calls.push(args.join(" "));
      const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
      return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
    },
    findOpenPull: async () => over.pull ?? null,
    closePull: async (_dir, number, comment) => {
      closed.push({ number, comment });
      return { ok: true };
    },
    defaultBase: async () => "develop",
    ...over,
  };
  return { d, closed, calls };
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const input = (wt: string, base: string | null = null) => ({ worktree: wt, dir: wt, branch: "agetor/card-1", slug: "issue-77", base });

test("archives the attempt and the differing remote branch, closes the PR, deletes the branch only after archiving, and resets the worktree to the current base", async () => {
  const c = setup({ pushed: "older" });
  const { d, closed, calls } = deps({ pull: { number: 12, url: "https://github.com/o/r/pull/12", base: "develop" } });
  const r = await restartFromBase(input(c.wt), d);
  expect(r).toMatchObject({
    ok: true, base: "develop", baseSha: c.baseTip, closedPr: 12, note: null,
    archive: [{ ref: "archive/issue-77-attempt-1", sha: c.head }, { ref: "archive/issue-77-attempt-1-pr", sha: c.remote! }],
  });
  const refs = remoteRefs(c.origin);
  expect(refs["archive/issue-77-attempt-1"]).toBe(c.head);
  expect(refs["archive/issue-77-attempt-1-pr"]).toBe(c.remote!);
  expect(refs["agetor/card-1"]).toBeUndefined();
  expect(refs.develop).toBe(c.baseTip);
  // The order: both archive pushes, then the delete; never a force push.
  const pushes = calls.filter((x) => x.startsWith("push"));
  expect(pushes).toEqual([
    `push --quiet --no-verify origin ${c.head}:refs/heads/archive/issue-77-attempt-1`,
    `push --quiet --no-verify origin ${c.remote}:refs/heads/archive/issue-77-attempt-1-pr`,
    "push --quiet --no-verify origin --delete agetor/card-1",
  ]);
  expect(calls.some((x) => /--force|\s-f\s|\+refs\/heads\/archive/.test(x))).toBe(false);
  expect(closed.map((x) => x.number)).toEqual([12]);
  expect(closed[0]!.comment).toContain("archive/issue-77-attempt-1");
  expect(closed[0]!.comment).toContain("restarts once from the current base (`develop`) on the same branch name, `agetor/card-1`");
  // The worktree: on the card's branch, at the base, no upstream.
  expect(sh(c.wt, "symbolic-ref", "--short", "HEAD")).toBe("agetor/card-1");
  expect(sh(c.wt, "rev-parse", "HEAD")).toBe(c.baseTip);
  expect(tryGit(c.wt, "rev-parse", "--abbrev-ref", "@{upstream}").status).not.toBe(0);
});

test("a remote branch equal to the worktree's HEAD is archived once; no remote branch and no PR is a plain archive and reset", async () => {
  const same = setup({ pushed: "same" });
  const a = await restartFromBase(input(same.wt), deps().d);
  expect(a).toMatchObject({ ok: true, closedPr: null, archive: [{ ref: "archive/issue-77-attempt-1", sha: same.head }] });
  expect(remoteRefs(same.origin)["agetor/card-1"]).toBeUndefined();

  const local = setup({ pushed: false });
  const { d, calls } = deps();
  const b = await restartFromBase(input(local.wt), d);
  expect(b).toMatchObject({ ok: true, archive: [{ ref: "archive/issue-77-attempt-1", sha: local.head }] });
  expect(calls.some((x) => x.includes("--delete"))).toBe(false);
  expect(sh(local.wt, "rev-parse", "HEAD")).toBe(local.baseTip);
});

test("the attempt number is one past the highest archived attempt on origin", async () => {
  const c = setup({ pushed: false });
  sh(c.seed, "push", "-q", "origin", "develop:refs/heads/archive/issue-77-attempt-1", "develop:refs/heads/archive/issue-77-attempt-2-pr");
  const r = await restartFromBase(input(c.wt), deps().d);
  expect(r).toMatchObject({ ok: true, archive: [{ ref: "archive/issue-77-attempt-3", sha: c.head }] });
});

test("uncommitted changes refuse the restart: nothing archived, deleted or reset", async () => {
  const c = setup({ pushed: "same" });
  writeFileSync(path.join(c.wt, "card.txt"), "half-done edit\n");
  const { d, closed, calls } = deps({ pull: { number: 12, url: "u", base: "develop" } });
  const r = await restartFromBase(input(c.wt), d);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.why).toContain("uncommitted changes");
  expect(calls.some((x) => x.startsWith("push"))).toBe(false);
  expect(closed).toEqual([]);
  expect(remoteRefs(c.origin)["agetor/card-1"]).toBe(c.head);
  expect(sh(c.wt, "rev-parse", "HEAD")).toBe(c.head);
});

test("a failed archive push falls back without closing, deleting or resetting anything", async () => {
  const c = setup({ pushed: "older" });
  const base = deps({ pull: { number: 12, url: "u", base: "develop" } });
  const real = base.d.git;
  // origin refuses the `-pr` archive (the second push).
  const d: Deps = { ...base.d, git: async (args, cwd) => (args.some((a) => a.endsWith("-attempt-1-pr")) ? { ok: false, stdout: "", stderr: "remote rejected" } : real(args, cwd)) };
  const r = await restartFromBase(input(c.wt), d);
  expect(r).toMatchObject({ ok: false, closedPr: null, archive: [{ ref: "archive/issue-77-attempt-1", sha: c.head }] });
  if (!r.ok) expect(r.why).toContain("remote rejected");
  expect(base.closed).toEqual([]);
  expect(remoteRefs(c.origin)["agetor/card-1"]).toBe(c.remote!);
  expect(sh(c.wt, "rev-parse", "HEAD")).toBe(c.head);
  expect(sh(c.wt, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/agetor/card-1");
});

test("a worktree off the card's branch, or a base that does not exist, is refused before any push", async () => {
  const c = setup({ pushed: false });
  const { d, calls } = deps({ defaultBase: async () => "no-such-base" });
  const r = await restartFromBase(input(c.wt), d);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.why).toContain("no-such-base");
  sh(c.wt, "checkout", "-q", "develop");
  const s = await restartFromBase(input(c.wt), deps().d);
  expect(s.ok).toBe(false);
  if (!s.ok) expect(s.why).toContain("not on agetor/card-1");
  expect(calls.some((x) => x.startsWith("push"))).toBe(false);
});

test("the archive slug is the issue, else the branch", () => {
  expect(capRestartSlug(1481, "agetor/x")).toBe("issue-1481");
  expect(capRestartSlug(null, "agetor/fix thing")).toBe("agetor-fix-thing");
});
