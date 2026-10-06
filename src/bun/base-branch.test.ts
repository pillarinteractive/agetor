import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { branchNameForBase } from "./base-branch.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
for (const k of Object.keys(env)) if (k.startsWith("GIT_DIR") || k === "GIT_WORK_TREE" || k === "GIT_INDEX_FILE") delete env[k];
function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(args, { cwd, env });
  if (p.exitCode !== 0) throw new Error(`${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

test("branchNameForBase: branch names (local or origin/), HEAD's branch; not shas", async () => {
  const refs = new Set(["refs/heads/develop", "refs/remotes/origin/release"]);
  const git = async (args: string[]) => {
    if (args[0] === "symbolic-ref") return { ok: true, stdout: "develop" };
    return { ok: refs.has(args[args.length - 1]!), stdout: "" };
  };
  expect(await branchNameForBase("develop", git)).toBe("develop");
  expect(await branchNameForBase("origin/release", git)).toBe("release");
  expect(await branchNameForBase("HEAD", git)).toBe("develop");
  expect(await branchNameForBase("0a49d119e98352d98c1b2a19184151904a83bd0b", git)).toBeNull();
  expect(await branchNameForBase("nope", git)).toBeNull();
});

test("a card made from develop starts from the latest origin/develop, even when local develop is stale", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "base-branch-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
  sh(root, "git", "clone", "-q", origin, repo);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-qm", "one");
  sh(repo, "git", "push", "-q", "origin", "HEAD:develop");

  const { createTask } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { db, tasks } = await import("./db.ts");
  const made = await createTask({ title: "fresh base", prompt: "p", agent: "claude-code", workdir: repo, isolation: "worktree", baseRef: "develop" });
  if ("error" in made) throw new Error(made.error);
  const id = made.task.id;
  try {
    // develop moves on GitHub after the card was made; the local clone never pulls.
    sh(root, "git", "clone", "-q", origin, other);
    writeFileSync(path.join(other, "a.txt"), "two\n");
    sh(other, "git", "commit", "-qam", "two");
    sh(other, "git", "push", "-q", "origin", "HEAD:develop");
    const latest = sh(other, "git", "rev-parse", "HEAD");
    expect(sh(repo, "git", "rev-parse", "develop")).not.toBe(latest);

    const prepared = await prepareWorkdir(tasks.get(id)!);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(sh(prepared.worktreePath!, "git", "rev-parse", "HEAD")).toBe(latest);
    expect(tasks.get(id)!.baseRef).toBe(latest);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
}, 30_000);
