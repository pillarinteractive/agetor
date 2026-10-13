/**
 * Checks on working steps — the half that touches the worktree, GitHub and
 * the disk (docs/plans/check-gated-pipeline.md §3 and §5; the model and every
 * judgement are in src/shared/checks.ts).
 *
 * {@link runStepChecks} evaluates one gate once: each check in order, a
 * built-in recomputed from the worktree, a command run with `sh -c` in the
 * card's worktree, and one line per check appended to the run's ledger —
 * `<data dir>/pipeline-runs/<card>/checks-<generation>.jsonl`. Only the core
 * writes that file, and it is never rewritten. It is a file beside the run,
 * not a field of it, so a build that does not know checks cannot erase it.
 *
 * What runs on this machine by default is only what takes milliseconds:
 * `git status`, `git rev-list`, `git rev-parse`. A command check is run when
 * a pipeline declares one, and no default does.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  headApprovedFinding, ledgerEntry, orderChecks, outputTail, parseCheckLedger, planCheck, prRequiredFinding,
  reusablePass, reviewVerdictFinding, unrunResult, type CheckKey, type CheckResult, type Finding,
} from "../shared/checks.ts";
import { ROLLUP_CHECKS, checksState, failedConclusion, newestPerName, type CheckRunLike } from "../shared/check-runs.ts";
import { reviewedPipelineShape } from "../shared/pipeline.ts";
import type { CheckLedgerEntry, Handoff, PipelineRunState, PipelineStep, StepCheck, Task } from "../shared/types.ts";
import { dataDir } from "./db.ts";
import { findGitHubPullForBranch, getGitHubRefCheckRuns } from "./github.ts";
import { prBase } from "./pr-watch.ts";

export interface CommandOutcome {
  /** null: the command could not be started at all. */
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

async function gitCommand(args: string[], cwd: string): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** Run a command check: `sh -c` in the worktree, stdout and stderr together,
 *  killed at its timeout. */
async function shellCommand(command: string, cwd: string, timeoutSec: number, env: Record<string, string>): Promise<CommandOutcome> {
  try {
    const p = Bun.spawn(["/bin/sh", "-c", `exec 2>&1\n${command}`], {
      cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutSec * 1000, killSignal: "SIGKILL",
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode, timedOut: p.signalCode === "SIGKILL", output: `${stdout}${stderr}` };
  } catch (e) {
    return { exitCode: null, timedOut: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** Git, the shell, GitHub and the clock — replaceable in tests. Git and the
 *  shell run for real (tests give them temporary repositories and trivial
 *  commands); nothing reaches GitHub except through `pull` and `checkRuns`,
 *  and both only read. */
export const checkDeps = {
  git: gitCommand,
  command: shellCommand,
  base: (checkout: string): Promise<string> => prBase(checkout),
  async pull(task: Task): Promise<{ ok: true; pull: { number: number; headSha: string | null; state: string } | null } | { ok: false }> {
    if (!task.branch) return { ok: true, pull: null };
    const found = await findGitHubPullForBranch({ dir: task.workdir, branch: task.branch });
    if (!found.ok) return { ok: false };
    const pull = found.pull;
    return { ok: true, pull: pull && { number: pull.number, headSha: pull.headSha, state: pull.mergedAt ? "merged" : pull.state } };
  },
  async checkRuns(task: Task, sha: string): Promise<CheckRunLike[] | null> {
    const r = await getGitHubRefCheckRuns({ dir: task.workdir, ref: sha });
    return r.ok ? r.checkRuns : null;
  },
  now: (): number => Date.now(),
};

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** A run generation's name in file names — the same one handoff and report
 *  files use (`run.startedAt`, set once per fresh run or restart). */
const generationOf = (run: Pick<PipelineRunState, "startedAt">) => (run.startedAt ?? 0).toString(36);

const runsDir = (parentId: string) => join(dataDir, "pipeline-runs", parentId);

export function checkLedgerPath(parentId: string, run: Pick<PipelineRunState, "startedAt">): string {
  return join(runsDir(parentId), `checks-${generationOf(run)}.jsonl`);
}

/** The run's ledger, oldest first. Empty when there is none or it cannot be read. */
export function readCheckLedger(parentId: string, run: Pick<PipelineRunState, "startedAt">): CheckLedgerEntry[] {
  const file = checkLedgerPath(parentId, run);
  if (!existsSync(file)) return [];
  try {
    return parseCheckLedger(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** Append to the run's ledger. Throws when the line cannot be written: a
 *  result that is not on record must not move the run. */
export function appendCheckLedger(parentId: string, run: Pick<PipelineRunState, "startedAt">, entries: readonly CheckLedgerEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(runsDir(parentId), { recursive: true });
  appendFileSync(checkLedgerPath(parentId, run), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

// ---------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------

const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
const finding = (outcome: Finding["outcome"], detail: string, output = ""): Finding => ({ outcome, satisfied: outcome === "pass", detail, output });

interface Worktree {
  checkout: string;
  key: CheckKey;
  /** The base branch and the local ref the checks compare with, when one resolves. */
  base: string | null;
  baseRef: string | null;
}

/** What the worktree is now: HEAD, its tree, and the base as this machine
 *  last fetched it. Nothing is fetched — a check reads, it does not reach out. */
async function readWorktree(task: Task): Promise<Worktree | null> {
  const checkout = task.worktreePath ?? task.workdir;
  if (!checkout) return null;
  const rev = async (what: string) => {
    const r = await checkDeps.git(["rev-parse", "--verify", "--quiet", what], checkout);
    return r.ok && r.stdout ? r.stdout : null;
  };
  const head = await rev("HEAD");
  const tree = head ? await rev("HEAD^{tree}") : null;
  const base = await checkDeps.base(checkout).catch(() => null);
  let baseRef: string | null = null;
  let baseTip: string | null = null;
  for (const candidate of [base ? `refs/remotes/origin/${base}` : null, task.baseRef ?? null, base ? `refs/heads/${base}` : null]) {
    if (!candidate) continue;
    const tip = await rev(`${candidate}^{commit}`);
    if (tip) {
      baseRef = candidate;
      baseTip = tip;
      break;
    }
  }
  return { checkout, key: { head, tree, baseTip }, base, baseRef };
}

async function builtin(check: StepCheck & { run: { kind: "builtin" } }, ctx: { task: Task; run: PipelineRunState; wt: Worktree; handoff: Handoff | null }): Promise<Finding> {
  const { task, run, wt } = ctx;
  const git = (args: string[]) => checkDeps.git(args, wt.checkout);
  const baseName = wt.baseRef?.replace(/^refs\/(?:remotes|heads)\//, "") ?? wt.base ?? "the base";
  switch (check.run.name) {
    case "tree-clean": {
      const status = await git(["status", "--porcelain", "--untracked-files=no"]);
      if (!status.ok) return finding("halt", `git status failed: ${status.stderr.slice(0, 200)}`);
      const dirty = lines(status.stdout);
      if (dirty.length === 0) return finding("pass", "no uncommitted change to a tracked file");
      return finding("fail", `${dirty.length} tracked file${dirty.length === 1 ? " has" : "s have"} uncommitted changes`,
        `git status --porcelain --untracked-files=no\n${dirty.slice(0, 80).join("\n")}${dirty.length > 80 ? `\n… and ${dirty.length - 80} more` : ""}`);
    }
    case "diff-nonempty": {
      if (!wt.key.head) return finding("halt", "HEAD could not be read");
      if (!wt.baseRef) return finding("halt", `no local ref for the base branch (${wt.base ?? "unknown"})`);
      const ahead = await git(["rev-list", "--count", `${wt.baseRef}..HEAD`]);
      if (!ahead.ok) return finding("halt", `git rev-list failed: ${ahead.stderr.slice(0, 200)}`);
      const n = Number(ahead.stdout);
      if (n > 0) return finding("pass", `${n} commit${n === 1 ? "" : "s"} ahead of ${baseName}`);
      return finding("fail", `no commit ahead of ${baseName}`, `git rev-list --count ${wt.baseRef}..HEAD → 0. Nothing this step did is committed on the branch.`);
    }
    case "review-verdict":
      return reviewVerdictFinding(ctx.handoff, wt.key.head, task.issueUrl ?? null);
    case "head-approved": {
      const shape = reviewedPipelineShape(run.snapshot?.graph);
      const last = shape && run.history.filter((h) => h.stepId === shape.review.id && (h.outcome === "succeeded" || h.outcome === "advanced-manually")).at(-1);
      return headApprovedFinding(last?.handoff ?? null, wt.key.head);
    }
    case "merges-with-base": {
      if (!wt.baseRef) return finding("halt", `no local ref for the base branch (${wt.base ?? "unknown"})`);
      const merged = await git(["merge-tree", "--write-tree", "--name-only", "HEAD", wt.baseRef]);
      if (merged.exitCode === 0) return finding("pass", `merges cleanly with ${baseName} as last fetched`);
      // Exit 1: conflicts. The first line is the tree; the rest names the files.
      if (merged.exitCode === 1) return finding("fail", `conflicts with ${baseName}`, merged.stdout.split("\n").slice(1).join("\n").trim());
      return finding("halt", `git merge-tree failed: ${merged.stderr.slice(0, 200)}`);
    }
    case "head-published": {
      if (!wt.key.head || !task.branch) return finding("halt", "the card's branch and HEAD could not be read");
      const remote = await git(["ls-remote", "origin", `refs/heads/${task.branch}`]);
      if (!remote.ok) return finding("halt", `origin could not be read: ${remote.stderr.slice(0, 200)}`);
      const remoteHead = remote.stdout.split(/\s+/)[0] || null;
      if (remoteHead === wt.key.head) return finding("pass", `origin/${task.branch} is at HEAD`);
      return finding("fail", remoteHead ? `origin/${task.branch} is at ${remoteHead.slice(0, 8)}, not HEAD` : `origin has no branch ${task.branch}`);
    }
    case "pr-required-check": {
      const found = await checkDeps.pull(task);
      if (!found.ok) return prRequiredFinding({ readable: false }, wt.key.head);
      if (!found.pull || !wt.key.head) return prRequiredFinding({ readable: true, pull: found.pull, state: "none", failing: [] }, wt.key.head);
      const runs = await checkDeps.checkRuns(task, wt.key.head);
      if (!runs) return prRequiredFinding({ readable: false }, wt.key.head);
      const newest = newestPerName(runs);
      // The roll-up is the verdict where the repository has one; else the set.
      const rollup = newest.filter((r) => ROLLUP_CHECKS.has(r.name));
      const state = checksState(rollup.length > 0 ? rollup : newest);
      const failing = newest.filter((r) => failedConclusion(r.conclusion) && !ROLLUP_CHECKS.has(r.name)).map((r) => r.name);
      return prRequiredFinding({ readable: true, pull: found.pull, state, failing }, wt.key.head);
    }
  }
}

async function command(check: StepCheck & { run: { kind: "command" } }, ctx: { parentId: string; run: PipelineRunState; stepName: string; seq: number; turn: number; wt: Worktree }): Promise<Omit<CheckResult, "check">> {
  const ran = await checkDeps.command(check.run.command, ctx.wt.checkout, check.timeoutSec, {
    AGETOR_CHECK_ID: check.id, AGETOR_CHECK_STEP: ctx.stepName, AGETOR_CHECK_HEAD: ctx.wt.key.head ?? "",
  });
  let outputPath: string | null = join(runsDir(ctx.parentId), `check-${generationOf(ctx.run)}-${ctx.seq}-${ctx.turn}-${check.id}.log`);
  try {
    mkdirSync(runsDir(ctx.parentId), { recursive: true });
    writeFileSync(outputPath, ran.output);
  } catch {
    outputPath = null; // the tail still goes out
  }
  const output = outputTail(ran.output);
  if (ran.exitCode === null) return { outcome: "halt", satisfied: false, exitCode: null, detail: `could not be started: ${ran.output.slice(0, 200)}`, output, outputPath };
  if (ran.timedOut) return { outcome: "fail", satisfied: false, exitCode: ran.exitCode, detail: `timed out after ${check.timeoutSec} s`, output, outputPath };
  return ran.exitCode === 0
    ? { outcome: "pass", satisfied: true, exitCode: 0, detail: "exit 0", output: "", outputPath }
    : { outcome: "fail", satisfied: false, exitCode: ran.exitCode, detail: `exit ${ran.exitCode}`, output, outputPath };
}

/**
 * Evaluate a step's gate once, for the turn of a visit that just ended (the
 * ledger's `turn` counts the visit's evaluations from 1): every check in
 * order (`orderChecks`), each run, reused or left out as `planCheck` says,
 * and the whole evaluation appended to the ledger. `handoff` is the handoff
 * of the turn being judged (the reviewer's verdict is read from it), or null
 * when the turn wrote none. Never throws for a check's own failure; throws
 * only when the ledger cannot be written.
 */
export async function runStepChecks(input: {
  parent: Task; run: PipelineRunState; step: PipelineStep; seq: number; checks: readonly StepCheck[]; handoff: Handoff | null;
}): Promise<CheckResult[]> {
  const { parent, run, step } = input;
  const wt = await readWorktree(parent);
  const ledger = readCheckLedger(parent.id, run);
  // The evaluation's number within the visit, counted from the ledger itself.
  const turn = ledger.filter((e) => e.stepId === step.id && e.seq === input.seq).reduce((n, e) => Math.max(n, e.turn), 0) + 1;
  const done = new Map<string, CheckResult>();
  const results: CheckResult[] = [];
  for (const check of orderChecks(input.checks)) {
    let result: CheckResult;
    if (!wt) {
      result = { check, outcome: "halt", satisfied: false, exitCode: null, detail: "the card has no worktree to check", output: "", outputPath: null };
    } else {
      const plan = planCheck(check, done, reusablePass(check, step.id, wt.key, ledger));
      if (plan.action !== "run") {
        result = unrunResult(check, plan);
      } else if (check.run.kind === "builtin") {
        const found = await builtin(check as StepCheck & { run: { kind: "builtin" } }, { task: parent, run, wt, handoff: input.handoff })
          .catch((e): Finding => finding("halt", `could not be evaluated: ${e instanceof Error ? e.message : String(e)}`));
        result = { check, ...found, output: outputTail(found.output), exitCode: null, outputPath: null };
      } else {
        result = { check, ...(await command(check as StepCheck & { run: { kind: "command" } }, { parentId: parent.id, run, stepName: step.name, seq: input.seq, turn, wt })) };
      }
    }
    done.set(check.id, result);
    results.push(result);
  }
  const at = checkDeps.now();
  const key: CheckKey = wt?.key ?? { head: null, tree: null, baseTip: null };
  appendCheckLedger(parent.id, run, results.map((result) => ledgerEntry({ at, stepId: step.id, stepName: step.name, seq: input.seq, turn, key, result })));
  return results;
}

/** Record that the owner advanced past checks that had not passed: one
 *  `waived` line each. A waiver is never read as a pass. Best-effort. */
export function recordWaivedChecks(input: { parent: Task; run: PipelineRunState; step: PipelineStep; seq: number; checks: readonly StepCheck[]; ids: readonly string[] }): void {
  const at = checkDeps.now();
  const last = new Map(readCheckLedger(input.parent.id, input.run).filter((e) => e.stepId === input.step.id && e.seq === input.seq).map((e) => [e.checkId, e]));
  const entries = input.checks.filter((c) => input.ids.includes(c.id)).map((c): CheckLedgerEntry => {
    const prior = last.get(c.id);
    return {
      at, stepId: input.step.id, stepName: input.step.name, seq: input.seq, turn: prior?.turn ?? 1, checkId: c.id, description: c.description, required: c.required,
      outcome: "waived", satisfied: false, key: prior?.key ?? { head: null, tree: null, baseTip: null, def: "" }, exitCode: null,
      detail: "the owner advanced the run past this check", outputTail: "", outputPath: null,
    };
  });
  try {
    appendCheckLedger(input.parent.id, input.run, entries);
  } catch {
    // best-effort
  }
}
