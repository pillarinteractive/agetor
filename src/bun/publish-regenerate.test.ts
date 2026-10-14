// Finish's merge of the base when only generated files conflict
// (`merge_regenerate`, publish-step.ts `mergeProbe`): the base's copy is taken
// and the generator rerun in a scratch worktree, and the merge carries
// Review's approval. Real git in a scratch repository.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-regenerate-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { mergeProbe } = await import("./publish-step.ts");
const { parseRegenerateRules, regenerateCovering } = await import("../shared/publish.ts");
afterAll(() => rmTestDataDir(DATA_DIR));

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const INDEX = "ls docs | grep -v README | sort > docs/README.md";

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-regenerate-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  const put = (f: string, body: string) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), body); };
  const index = () => execFileSync("/bin/sh", ["-c", INDEX], { cwd: dir });
  git("init", "-q", "-b", "develop");
  put("docs/a.md", "a"); index(); git("add", "."); git("commit", "-qm", "base");
  git("branch", "feature");
  put("docs/b.md", "b"); index(); git("add", "."); git("commit", "-qm", "develop adds b");
  git("checkout", "-q", "feature");
  put("docs/c.md", "c"); index(); git("add", "."); git("commit", "-qm", "feature adds c");
  return { dir, git, put, index };
}

test("rules for this project only; covering needs every conflicted file", () => {
  const raw = JSON.stringify([{ project: "/repo/", path: "docs/README.md", command: "x" }, { project: "/other", path: "y", command: "z" }, { bad: 1 }]);
  const rules = parseRegenerateRules(raw, "/repo");
  expect(rules).toEqual([{ project: "/repo/", path: "docs/README.md", command: "x" }]);
  expect(regenerateCovering(["docs/README.md"], rules)).toHaveLength(1);
  expect(regenerateCovering(["docs/README.md", "src/a.ts"], rules)).toBeNull();
  expect(regenerateCovering([], rules)).toBeNull();
});

test("a conflict only in a generated index is merged by regenerating it, without touching the card's worktree", async () => {
  const { dir, git } = repo();
  const head = git("rev-parse", "HEAD");
  const tip = git("rev-parse", "develop");
  const rules = [{ project: dir, path: "docs/README.md", command: INDEX }];
  // Without a rule it is a conflict, as before.
  expect(await mergeProbe(dir, tip, "develop")).toMatchObject({ conflicts: ["docs/README.md"], commit: null });
  const probe = (await mergeProbe(dir, tip, "develop", rules))!;
  expect(probe).toMatchObject({ conflicts: null, samePatch: true, regenerated: ["docs/README.md"] });
  expect(git("show", `${probe.commit}:docs/README.md`).split("\n")).toEqual(["a.md", "b.md", "c.md"]);
  expect(git("rev-list", "--parents", "-n", "1", probe.commit!).split(" ").slice(1)).toEqual([head, tip]);
  // The card's own worktree and HEAD are untouched, and no scratch worktree is left.
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("status", "--porcelain")).toBe("");
  expect(git("worktree", "list").split("\n")).toHaveLength(1);
});

test("a failing generator or another conflicted file leaves the conflict for Build", async () => {
  const { dir, git, put, index } = repo();
  put("src.txt", "feature"); git("add", "."); git("commit", "-qm", "feature src");
  git("checkout", "-q", "develop"); put("src.txt", "develop"); index(); git("add", "."); git("commit", "-qm", "develop src");
  git("checkout", "-q", "feature");
  const tip = git("rev-parse", "develop");
  const probe = (await mergeProbe(dir, tip, "develop", [{ project: dir, path: "docs/README.md", command: INDEX }]))!;
  expect(probe.conflicts?.sort()).toEqual(["docs/README.md", "src.txt"]);
  const only = repo();
  const failing = (await mergeProbe(only.dir, only.git("rev-parse", "develop"), "develop", [{ project: only.dir, path: "docs/README.md", command: "exit 3" }]))!;
  expect(failing).toMatchObject({ conflicts: ["docs/README.md"], commit: null });
  expect(existsSync(path.join(only.dir, "docs/README.md"))).toBe(true);
  expect(only.git("worktree", "list").split("\n")).toHaveLength(1);
});
