// The contract of `ci-wait` as the Finish step's instructions describe it:
// exit 0 passed, 1 CI failed, 2 not ready to wait, 3 timed out, 4 conflicts
// with the base — and what a failure prints. `gh` and `git` are stand-ins on
// PATH that answer from files; nothing reaches GitHub, and every case ends
// on its first look, so nothing waits.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CI_WAIT_SCRIPT runs the same contract against another copy (the installed one).
const SCRIPT = process.env.CI_WAIT_SCRIPT ?? join(import.meta.dir, "../../scripts/ci-wait/ci-wait");
const python = Bun.which("python3");
const HEAD = "f177ff167802182bddb0c8dbcc07d8e4682aa5a4";
const PR_URL = "https://github.com/o/r/pull/7";
const RUN_URL = "https://github.com/o/r/actions/runs/9001";

const FAKE_GIT = `#!/bin/sh
case "$*" in
  "rev-parse HEAD") cat "$CI_WAIT_FAKE/head" ;;
  "rev-parse --abbrev-ref HEAD") echo "claude/x" ;;
  "rev-parse --absolute-git-dir") echo "$CI_WAIT_FAKE/gitdir" ;;
  status*) cat "$CI_WAIT_FAKE/dirty" ;;
  ls-remote*) cat "$CI_WAIT_FAKE/remote" ;;
  *) echo "unexpected git $*" >&2; exit 64 ;;
esac
`;
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$CI_WAIT_FAKE/gh-calls"
case "$*" in
  "pr view claude/x --json number,url,isDraft,baseRefName,state") f=pr.json ;;
  "pr view 7 --json mergeable,headRefOid") f=state.json ;;
  "repo view --json nameWithOwner") echo '{"nameWithOwner":"o/r"}'; exit 0 ;;
  api*check-runs*) f=checks.json ;;
  "run view 9001 --log-failed") f=log.txt ;;
  "run view 9001 --json workflowName,url") f=run.json ;;
  *) echo "unexpected gh $*" >&2; exit 64 ;;
esac
[ -f "$CI_WAIT_FAKE/$f" ] || exit 1
cat "$CI_WAIT_FAKE/$f"
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Scene {
  head?: string;
  dirty?: string;
  remote?: string;
  pr?: unknown;
  state?: unknown;
  checks?: unknown;
  log?: string;
  run?: unknown;
}
const run = (name: string, conclusion: string | null, id: number) => ({
  name, status: conclusion === null ? "in_progress" : "completed", conclusion, started_at: "2026-10-14T00:40:00Z",
  html_url: `${RUN_URL}/job/${id}`,
});
const OPEN_PR = { number: 7, url: PR_URL, isDraft: true, baseRefName: "develop", state: "OPEN" };

function ciWait(scene: Scene, args: string[] = []): { code: number; out: string; dir: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ci-wait-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, text] of [["git", FAKE_GIT], ["gh", FAKE_GH]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const put = (file: string, value: unknown) => {
    if (value !== undefined) writeFileSync(join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  put("head", scene.head ?? HEAD);
  put("dirty", scene.dirty ?? "");
  put("remote", scene.remote ?? `${HEAD}\trefs/heads/claude/x`);
  put("pr.json", scene.pr);
  put("state.json", scene.state ?? { mergeable: "MERGEABLE", headRefOid: HEAD });
  put("checks.json", scene.checks);
  put("log.txt", scene.log);
  put("run.json", scene.run);
  const ran = Bun.spawnSync([python!, "-I", SCRIPT, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, CI_WAIT_FAKE: dir, PYTHONIOENCODING: "utf-8", HOME: dir },
  });
  const calls = existsSync(join(dir, "gh-calls")) ? readFileSync(join(dir, "gh-calls"), "utf8").trim().split("\n") : [];
  return { code: ran.exitCode, out: ran.stdout.toString() + ran.stderr.toString(), dir, calls };
}

const HEADER = `ci-wait: PR #7 ${PR_URL} head f177ff167 (draft=True, base develop)\n`;

describe.skipIf(!python)("ci-wait", () => {
  const cases: { name: string; scene: Scene; args?: string[]; code: number; out: string }[] = [
    {
      name: "uncommitted tracked changes: 2",
      scene: { dirty: " M a.txt" },
      code: 2,
      out: "ci-wait: tracked files have uncommitted changes; CI verifies the pushed commit, so commit first\n",
    },
    {
      name: "HEAD is not on the remote: 2",
      scene: { remote: "0000000000000000000000000000000000000000\trefs/heads/claude/x" },
      code: 2,
      out: "ci-wait: HEAD f177ff167 is not what origin/claude/x points at; run `git push -u origin claude/x` first\n",
    },
    {
      name: "no open pull request: 2",
      scene: { pr: { ...OPEN_PR, state: "CLOSED" } },
      code: 2,
      out: "ci-wait: no open pull request for claude/x; open one first: `gh pr create --draft --base develop --head claude/x ...`\n",
    },
    {
      name: "the pull request conflicts with its base: 4",
      scene: { pr: OPEN_PR, state: { mergeable: "CONFLICTING", headRefOid: HEAD } },
      code: 4,
      out: `${HEADER}ci-wait: PR #7 conflicts with develop, so CI cannot run. Merge origin/develop and resolve, then push and wait again.\n`,
    },
    {
      name: "the pull request's head moved: 2",
      scene: { pr: OPEN_PR, state: { mergeable: "MERGEABLE", headRefOid: "aaaaaaaaa1111111" } },
      code: 2,
      out: `${HEADER}ci-wait: the PR head moved to aaaaaaaaa; this wait was for f177ff167\n`,
    },
    {
      name: "`required` succeeded: 0",
      scene: { pr: OPEN_PR, checks: { check_runs: [run("web / unit", "success", 1), run("required", "success", 2)] } },
      code: 0,
      out: `${HEADER}ci-wait: 2/2 checks complete\nci-wait: PASSED — \`required\` succeeded for f177ff167: ${RUN_URL}/job/2\n`,
    },
    {
      name: "select and every suite job passed while `required` is still queued: 0",
      scene: { pr: OPEN_PR, checks: { check_runs: [run("select", "success", 1), run("web / unit", "success", 3), run("required", null, 2)] } },
      code: 0,
      out: `${HEADER}ci-wait: 2/3 checks complete\nci-wait: PASSED — select and all 1 suite jobs succeeded for f177ff167; ` +
        `the \`required\` aggregator is still queued (it must finish before the PR can merge): ${PR_URL}/checks\n`,
    },
    {
      name: "the timeout: 3",
      scene: { pr: OPEN_PR },
      args: ["--timeout", "0"],
      code: 3,
      out: `${HEADER}ci-wait: timed out after 0 minutes waiting for \`required\` on f177ff167; see \`gh pr checks 7\`\n`,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = ciWait(c.scene, c.args);
      expect(got.out).toBe(c.out);
      expect(got.code).toBe(c.code);
    });
  }

  test("CI failed: 1, with each failed job's workflow, job, step and exit code over its failure lines, and the full log saved", () => {
    const line = (job: string, step: string, text: string) => `${job}\t${step}\t2026-10-14T00:48:29.3248291Z ${text}`;
    const log = [
      ...Array.from({ length: 200 }, (_, i) => line("web / unit", "Run tests", `ok case ${i}`)),
      line("web / unit", "Run tests", "\x1b[31m ✗ adds an item\x1b[0m"),
      line("web / unit", "Run tests", "AssertionError: expected 1 to be 2"),
      line("web / unit", "Run tests", "##[error]Process completed with exit code 1."),
      ...Array.from({ length: 40 }, (_, i) => line("web / unit", "Post Run actions/checkout", `[command]/usr/bin/git config --unset ${i}`)),
    ].join("\n");
    const got = ciWait({
      pr: OPEN_PR, log, run: { workflowName: "ci", url: RUN_URL },
      checks: { check_runs: [run("web / unit", "failure", 1), run("lint", "success", 3), run("required", "failure", 2)] },
    });
    expect(got.code).toBe(1);
    const saved = join(got.dir, "gitdir", "agetor", "ci-failed-9001.log");
    const lines = got.out.split("\n");
    // Unchanged from the hand-installed script: the verdict and the failed checks.
    expect(lines.slice(0, 5)).toEqual([
      HEADER.trimEnd(),
      "ci-wait: 3/3 checks complete",
      "ci-wait: FAILED — `required` is failure for f177ff167",
      `  failed: web / unit (failure) ${RUN_URL}/job/1`,
      `  failed: required (failure) ${RUN_URL}/job/2`,
    ]);
    // New: the excerpt in place of the log's last 60 lines.
    expect(lines.slice(5, 9)).toEqual([
      `Run 9001: ${RUN_URL}`,
      `Full log: ${saved} (or \`gh run view 9001 --log-failed\`)`,
      '--- failed: ci / web / unit / step "Run tests" — exit code 1 ---',
      "(23 of 243 log lines: the 3 failure lines with up to 20 lines either side)",
    ]);
    expect(lines.slice(-6, -1)).toEqual([
      " ✗ adds an item",
      "AssertionError: expected 1 to be 2",
      "##[error]Process completed with exit code 1.",
      "… 40 lines omitted …",
      'ci-wait: failed jobs: ci / web / unit (exit 1, step "Run tests"). Their excerpts are above; read the full log only where they are not enough.',
    ]);
    expect(got.out).not.toContain("git config --unset");
    expect(got.out).not.toContain("2026-10-14T00:48");
    expect(readFileSync(saved, "utf8")).toBe(`${log}\n`);
    // One look at the checks; the failed run is read once, with its name.
    expect(got.calls.filter((c) => c.startsWith("api "))).toHaveLength(1);
    expect(got.calls.filter((c) => c.startsWith("run view"))).toEqual(["run view 9001 --log-failed", "run view 9001 --json workflowName,url"]);
  });

  test("CI failed and the run cannot be described: still 1, with what is known", () => {
    const got = ciWait({ pr: OPEN_PR, checks: { check_runs: [run("web / unit", "failure", 1), run("required", "failure", 2)] } });
    expect(got.code).toBe(1);
    expect(got.out).toContain("Run 9001\n");
    expect(got.out).toContain("(the failed log is empty: the job failed before any of its steps ran)");
  });
});
