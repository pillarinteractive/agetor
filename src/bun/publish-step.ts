/**
 * Finish run by Agetor — the effectful half (docs/plans/check-gated-pipeline.md §4).
 *
 * For a card whose run adopted the `publish` gate (`pipeline_gates`), a launch
 * of Finish starts no agent: the runner parks it (`holdForPublish` in
 * src/bun/pipeline-runner.ts) and this loop carries the visit. Every minute,
 * for each held card: read what the visit's state needs from git and GitHub
 * (`observe`), ask the pure machine for the one next action (`decidePublish`,
 * src/shared/publish.ts), carry it out (`perform`), and store the new state
 * on the run (`run.publish`), so a core restart loses nothing — every state
 * re-derives what it needs.
 *
 * What it will and will not do to the repository:
 *   - it pushes one commit, by sha, to the card's own branch: the head Review
 *     approved, or that head with the base merged in when the merge is clean
 *     and the change's own diff is unchanged (`mergeProbe`);
 *   - it never force-pushes, never pushes to a base branch
 *     (`PROTECTED_BRANCHES`), never rebases or amends, and never merges the
 *     pull request — the merge queue does that once the card is signed off.
 *
 * While it waits (for CI, or for a base that is failing the same checks) the
 * card has no step task: no agent turn, no step slot, no attempt counted. The
 * step's agent gets one turn at the end, to write the PR description.
 */
import type { Handoff, PipelinePublishState, PipelineRunState, Task } from "../shared/types.ts";
import { reviewApprovalMatches, reviewedPipelineShape } from "../shared/pipeline.ts";
import { newestPerName, failedConclusion, ROLLUP_CHECKS, type CheckRunLike } from "../shared/check-runs.ts";
import {
  PROTECTED_BRANCHES, applyPublish, baseVerdicts, decidePublish, failingCauses, publishBuildHandoff, publishEvidenceComment,
  publishWriterBrief, verdictsSettled,
  MERGE_REGENERATE_PREF, parseRegenerateRules, regenerateCovering, type RegenerateRule,
  type BuildCause, type MergeProbe, type PublishAction, type PublishApproval, type PublishFacts, type PublishObservation,
  type PublishResult, type PullSeen,
} from "../shared/publish.ts";
import { preferences, tasks } from "./db.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.ts";
import {
  createGitHubComment, createGitHubPull, findGitHubPullForBranch, getGitHubRefCheckRuns, rerunGitHubWorkflowRun, setGitHubPullDraft,
} from "./github.ts";
import { failedRunReports, readFailedRun, type FailedRunLog } from "./ci-failure-log.ts";
import { ciFailureHandoff, conflictHandoff, infraReason, logTail, runIdFromCheckUrl, type CiFailureDetails, type FailedCheck } from "./merge-rework.ts";
import { invalidatePrStatus, issueNumberForTask, prBase } from "./pr-watch.ts";
import { launchPublishAgent, pipelineRunsDir, publishHooks, publishStepFor, routeFromPublish, stopPublishForOwner, updatePublish } from "./pipeline-runner.ts";

const TICK_MS = 60_000;
/** How often a card that only waits on the base (not on its own CI) looks. */
export const BASE_LOOK_MS = 3 * 60_000;
/** Base commits read, tip first, to find one that ran a failing job. */
export const BASE_LOOKBACK = 10;
/** Actions taken for one card in one pass, at most. */
const MAX_STEPS_PER_PASS = 12;

export interface GitResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function gitCommand(args: string[], cwd: string, stdin?: string): Promise<GitResult> {
  try {
    const p = Bun.spawn(["git", ...args], {
      cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** Git, GitHub and the clock — replaceable in tests. Git runs for real (tests
 *  give it temporary repositories); nothing reaches GitHub except through
 *  the calls below. */
export const publishDeps = {
  git: gitCommand,
  /** A regenerate command, through the agents' PATH; true when it exited 0. */
  async shell(command: string, cwd: string): Promise<boolean> {
    try {
      const p = Bun.spawn(["/bin/sh", "-c", `. "$HOME/.agetor/bin/agent-path.sh" 2>/dev/null; ${command}`], {
        cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return (await p.exited) === 0;
    } catch {
      return false;
    }
  },
  base: (checkout: string): Promise<string> => prBase(checkout),
  async findPull(task: Task): Promise<{ ok: true; pull: PullSeen | null } | { ok: false }> {
    const found = await findGitHubPullForBranch({ dir: task.workdir, branch: task.branch! });
    if (!found.ok) return { ok: false };
    const pull = found.pull;
    return {
      ok: true,
      pull: pull && { number: pull.number, url: pull.htmlUrl, state: pull.mergedAt ? "merged" : pull.state, draft: pull.draft, headSha: pull.headSha },
    };
  },
  async openPull(task: Task, input: { title: string; base: string; body: string }): Promise<PublishResult> {
    const created = await createGitHubPull({ dir: task.workdir, title: input.title, head: task.branch!, base: input.base, body: input.body, draft: true });
    return created.ok ? { ok: true, pr: { number: created.item.number, url: created.item.htmlUrl ?? "" } } : { ok: false, error: created.error };
  },
  /** Every check run of a commit, or null when GitHub could not be read. */
  async checks(task: Task, sha: string): Promise<CheckRunLike[] | null> {
    const r = await getGitHubRefCheckRuns({ dir: task.workdir, ref: sha });
    return r.ok ? r.checkRuns : null;
  },
  /** A failed run's log, whole, with the run's workflow and page. Its tail is
   *  read for the runner-fault decision and its failure lines are quoted to
   *  Build (src/shared/ci-failure.ts); never compared with the base's. */
  failedLog: (task: Task, runId: number): Promise<FailedRunLog | null> => readFailedRun(task.workdir, runId),
  async rerunFailed(task: Task, runId: number): Promise<{ ok: boolean; error?: string }> {
    const r = await rerunGitHubWorkflowRun({ dir: task.workdir, runId, failedOnly: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
  async markReady(task: Task, number: number): Promise<boolean> {
    return (await setGitHubPullDraft({ dir: task.workdir, number, draft: false })).ok;
  },
  async comment(task: Task, number: number, body: string): Promise<boolean> {
    return (await createGitHubComment({ dir: task.workdir, number, body })).ok;
  },
};

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/** The head Review approved, read from the run's last finished Review. */
export function publishApproval(task: Pick<Task, "issueUrl">, run: PipelineRunState): PublishApproval {
  const shape = reviewedPipelineShape(run.snapshot?.graph);
  const last = shape && run.history.filter((h) => h.stepId === shape.review.id && (h.outcome === "succeeded" || h.outcome === "advanced-manually")).at(-1);
  const approval = last?.handoff?.reviewApproval;
  if (!last?.handoff || !approval) return { kind: "none" };
  if (reviewApprovalMatches(last.handoff, task.issueUrl ?? approval.issueUrl, approval.headSha)) return { kind: "approved", headSha: approval.headSha };
  const why = approval.verdict !== "approved" ? `its verdict is "${approval.verdict}"`
    : approval.findings.length ? `it lists ${approval.findings.length} finding(s)`
    : !approval.acceptanceComplete ? "it says acceptance is incomplete"
    : "it is for another issue, or carries open questions";
  return { kind: "not-approved", why };
}

/**
 * Try merging `origin/<base>` into HEAD without touching the worktree or any
 * ref (`merge-tree`, `commit-tree`), and say whether the change's own diff
 * survives it: `git patch-id` of `git diff <base>...HEAD` before against the
 * same for the merge commit, plus the list of files the change touches. Null
 * when git could not answer.
 */
export async function mergeProbe(checkout: string, baseTip: string, base: string, regenerate: readonly RegenerateRule[] = []): Promise<MergeProbe | null> {
  const git = publishDeps.git;
  const tried = await git(["merge-tree", "--write-tree", "--name-only", "HEAD", baseTip], checkout);
  if (tried.exitCode === 1) {
    // The tree id, then the conflicted paths, then a blank line and messages.
    const files = [...new Set((tried.stdout.split("\n\n")[0] ?? "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean))];
    const rules = regenerateCovering(files, regenerate);
    const commit = rules ? await regeneratedMerge(checkout, baseTip, base, files, rules).catch(() => null) : null;
    if (commit) return { conflicts: null, samePatch: true, commit, regenerated: files };
    return { conflicts: files, samePatch: false, commit: null };
  }
  const tree = tried.stdout.split("\n")[0]?.trim();
  if (!tried.ok || !tree) return null;
  const commit = await git(["commit-tree", tree, "-p", "HEAD", "-p", baseTip, "-m", `Merge remote-tracking branch 'origin/${base}'`, "-m", "Merged by Agetor: the change's own diff is unchanged."], checkout);
  if (!commit.ok || !commit.stdout) return null;
  const fingerprint = async (rev: string): Promise<string | null> => {
    const diff = await git(["diff", "--full-index", `${baseTip}...${rev}`], checkout);
    const names = await git(["diff", "--name-status", `${baseTip}...${rev}`], checkout);
    if (!diff.ok || !names.ok) return null;
    const id = await git(["patch-id", "--stable"], checkout, `${diff.stdout}\n`);
    return id.ok ? `${id.stdout}\n${names.stdout}` : null;
  };
  const [before, after] = [await fingerprint("HEAD"), await fingerprint(commit.stdout)];
  return { conflicts: null, samePatch: before !== null && before === after, commit: commit.stdout };
}

/**
 * The merge of `baseTip` into HEAD with each conflicted generated file
 * rebuilt: in a scratch worktree (the card's own is not touched), take the
 * base's copy of each, run the rules' commands, and commit the merge when
 * nothing else is left unmerged. The commit's id, or null — the conflict
 * then goes to Build as before.
 */
async function regeneratedMerge(checkout: string, baseTip: string, base: string, files: string[], rules: RegenerateRule[]): Promise<string | null> {
  const git = publishDeps.git;
  const scratch = mkdtempSync(join(tmpdir(), "agetor-regenerate-"));
  rmSync(scratch, { recursive: true, force: true });
  const added = await git(["worktree", "add", "--detach", "--quiet", scratch, "HEAD"], checkout);
  if (!added.ok) return null;
  try {
    await git(["merge", "--no-commit", "--no-ff", "--quiet", baseTip], scratch);
    for (const f of files) {
      if (!(await git(["checkout", "--theirs", "--", f], scratch)).ok) return null;
    }
    for (const rule of rules) {
      if (!(await publishDeps.shell(rule.command, scratch))) return null;
    }
    if (!(await git(["add", "--", ...files], scratch)).ok) return null;
    const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], scratch);
    if (!unmerged.ok || unmerged.stdout) return null;
    const committed = await git(["commit", "--quiet", "--no-verify", "-m", `Merge remote-tracking branch 'origin/${base}'`,
      "-m", `Merged by Agetor: ${files.join(", ")} conflicted and ${files.length === 1 ? "was" : "were"} regenerated (merge_regenerate); the change's own diff is otherwise unchanged.`], scratch);
    if (!committed.ok) return null;
    const sha = await git(["rev-parse", "HEAD"], scratch);
    return sha.ok && sha.stdout ? sha.stdout : null;
  } finally {
    await git(["worktree", "remove", "--force", scratch], checkout);
  }
}

/** Check runs of base commits other than the tip, which no longer change. */
const settledBaseChecks = new Map<string, CheckRunLike[]>();

async function baseCommits(task: Task, checkout: string, base: string, names: string[]): Promise<{ baseTip: string; commits: CheckRunLike[][] } | null> {
  const git = publishDeps.git;
  await git(["fetch", "--quiet", "origin", base], checkout);
  const log = await git(["rev-list", "-n", String(BASE_LOOKBACK), `refs/remotes/origin/${base}`], checkout);
  const shas = log.ok ? lines(log.stdout) : [];
  if (shas.length === 0) return null;
  const commits: CheckRunLike[][] = [];
  for (const [i, sha] of shas.entries()) {
    const key = `${task.workdir}\0${sha}`;
    let runs = i > 0 ? settledBaseChecks.get(key) : undefined;
    if (!runs) {
      const read = await publishDeps.checks(task, sha);
      if (!read) return i === 0 ? null : { baseTip: shas[0]!, commits };
      runs = read;
      if (i > 0 && read.every((r) => r.status === "completed")) settledBaseChecks.set(key, read);
    }
    commits.push(runs);
    if (verdictsSettled(baseVerdicts(names, commits))) break;
  }
  return { baseTip: shas[0]!, commits };
}

async function observe(task: Task, run: PipelineRunState, p: PipelinePublishState): Promise<PublishObservation> {
  const git = publishDeps.git;
  const checkout = task.worktreePath;
  if (!checkout || !task.branch) return { state: "unreadable", what: "the card's worktree and branch" };
  const base = p.base ?? "";
  const rev = async (what: string) => {
    const r = await git(["rev-parse", "--verify", "--quiet", what], checkout);
    return r.ok && r.stdout ? r.stdout : null;
  };
  const baseTip = async () => {
    const fetched = await git(["fetch", "--quiet", "origin", base], checkout);
    return fetched.ok ? rev(`refs/remotes/origin/${base}`) : null;
  };

  switch (p.state) {
    case "verify-head": {
      const status = await git(["status", "--porcelain", "--untracked-files=no"], checkout);
      const [head, tree] = [await rev("HEAD"), await rev("HEAD^{tree}")];
      if (!status.ok || !head || !tree) return { state: "unreadable", what: "the worktree's HEAD" };
      const approval = publishApproval(task, run);
      let unreviewed: string[] = [];
      if (approval.kind === "approved" && approval.headSha !== head) {
        const log = await git(["log", "--format=%h %s", `${approval.headSha}..HEAD`], checkout);
        unreviewed = log.ok ? lines(log.stdout) : [];
      }
      return { state: "verify-head", dirty: lines(status.stdout).map((l) => l.replace(/^\S+\s+/, "")), head, tree, approval, unreviewed };
    }
    case "check-merge":
    case "refresh": {
      const tip = await baseTip();
      if (!tip) return { state: "unreadable", what: `origin/${base}` };
      const contains = (await git(["merge-base", "--is-ancestor", tip, "HEAD"], checkout)).ok;
      const regenerate = parseRegenerateRules(preferences.get(MERGE_REGENERATE_PREF), task.workdir);
      return { state: p.state, baseTip: tip, contains, merge: contains ? null : await mergeProbe(checkout, tip, base, regenerate) };
    }
    case "hold-base": {
      const tip = await baseTip();
      const checks = tip ? await publishDeps.checks(task, tip) : null;
      if (!tip || !checks) return { state: "unreadable", what: `${base}'s CI` };
      return { state: "hold-base", baseTip: tip, checks };
    }
    case "push": {
      const localHead = await rev("HEAD");
      const remote = await git(["ls-remote", "origin", `refs/heads/${task.branch}`], checkout);
      if (!localHead || !remote.ok) return { state: "unreadable", what: `origin/${task.branch}` };
      const remoteHead = remote.stdout.split(/\s+/)[0] || null;
      let remoteIsAncestor = false;
      if (remoteHead) {
        if (!(await git(["cat-file", "-e", `${remoteHead}^{commit}`], checkout)).ok) await git(["fetch", "--quiet", "origin", task.branch], checkout);
        remoteIsAncestor = (await git(["merge-base", "--is-ancestor", remoteHead, "HEAD"], checkout)).ok;
      }
      return { state: "push", branch: task.branch, localHead, remoteHead, remoteIsAncestor };
    }
    case "pr": {
      const found = await publishDeps.findPull(task);
      return found.ok ? { state: "pr", pull: found.pull } : { state: "unreadable", what: "the pull request" };
    }
    case "wait-ci":
    case "finalize": {
      const found = await publishDeps.findPull(task);
      const checks = p.head ? await publishDeps.checks(task, p.head) : null;
      if (!found.ok || !checks) return { state: "unreadable", what: "the pull request's checks" };
      return { state: p.state, pull: found.pull, checks };
    }
    case "classify": {
      const checks = p.head ? await publishDeps.checks(task, p.head) : null;
      if (!checks) return { state: "unreadable", what: "the pull request's checks" };
      const failing = failingCauses(checks);
      const seen = await baseCommits(task, checkout, base, failing.map((f) => f.name));
      if (!seen) return { state: "unreadable", what: `${base}'s CI` };
      const details = await failureDetails(task, failing);
      return { state: "classify", checks, baseCommits: seen.commits, infra: infraReason(details) };
    }
    case "base-red": {
      const seen = await baseCommits(task, checkout, base, p.inherited);
      if (!seen) return { state: "unreadable", what: `${base}'s CI` };
      return { state: "base-red", baseTip: seen.baseTip, baseCommits: seen.commits };
    }
    default:
      return { state: "unreadable", what: "a visit that is the agent's now" };
  }
}

/** The failing checks with their runs' logs. `save`: the logs are kept in
 *  the card's run folder and the report names them — for the handoff to
 *  Build, not for the look that only asks whether a runner was at fault. */
async function failureDetails(task: Task, failing: { name: string; url: string | null; conclusion: string | null }[], save = false): Promise<Pick<CiFailureDetails, "checks" | "logs">> {
  const checks: FailedCheck[] = failing.map((c) => ({ ...c, runId: runIdFromCheckUrl(c.url) }));
  const runs: FailedRunLog[] = [];
  for (const runId of [...new Set(checks.map((c) => c.runId).filter((n): n is number => n != null))].slice(0, 2)) {
    const read = await publishDeps.failedLog(task, runId);
    if (read !== null) runs.push(read);
  }
  return { checks, logs: failedRunReports(runs, save ? pipelineRunsDir(task.id) : null, logTail) };
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/** The description a PR is opened with. `Refs`, never `Fixes`: whether the
 *  change completes its issue is the writer's to say, and a PR that says
 *  `Fixes` closes the issue when it merges. Pure; exported for tests. */
export function publishDraftBody(summary: string | null, issueNumber: number | null): string {
  return [
    summary?.trim() || "Opened by Agetor once Review approved the change.",
    issueNumber ? `\nRefs #${issueNumber}` : "",
    "\n---\nOpened as a draft by Agetor when Review approved this head. The description is rewritten once CI passes.",
  ].filter(Boolean).join("\n");
}

const said = new Map<string, string>();
function say(taskId: string, text: string, tone: "info" | "success" | "warning" | "danger" | "muted" = "info"): void {
  // The same line with other numbers ("3 of 12 checks finished") is not news.
  const key = text.replace(/\d+/g, "#");
  if (said.get(taskId) === key) return;
  said.set(taskId, key);
  recordActivity(taskId, { kind: "auto", text, tone });
}

async function buildHandoff(task: Task, run: PipelineRunState, p: PipelinePublishState, cause: BuildCause): Promise<{ toStepId: string; handoff: Handoff; activity: string } | null> {
  const shape = reviewedPipelineShape(run.snapshot?.graph);
  if (!shape) return null;
  const base = p.base ?? "the base";
  const next = shape.viaEdge?.label.trim() || shape.build.name;
  const pr = { number: p.pr?.number ?? 0, url: p.pr?.url ?? "", baseRef: p.base, headSha: p.head };
  const back = `sent back to ${shape.build.name} without an agent turn on ${shape.finish.name}`;
  switch (cause.kind) {
    case "ci": {
      const details = await failureDetails(task, cause.checks, true);
      return {
        toStepId: shape.build.id,
        handoff: ciFailureHandoff({ shape, pr, details, inherited: cause.inherited, round: 0, maxRounds: 0, signedOff: false, inRun: true }),
        activity: `CI failed on this change's own checks (${cause.checks.map((c) => c.name).slice(0, 3).join(", ")}): they pass on ${base} — ${back}`,
      };
    }
    case "conflict":
      return {
        toStepId: shape.build.id,
        handoff: conflictHandoff({ shape, pr, files: cause.files, round: 0, maxRounds: 0, signedOff: false, inRun: true }),
        activity: `The branch conflicts with ${base} (${cause.files.length} file${cause.files.length === 1 ? "" : "s"}) — ${back}`,
      };
    default: {
      const handoff = publishBuildHandoff(cause, { base, next });
      return { toStepId: shape.build.id, handoff, activity: `${handoff.purpose} — ${back}` };
    }
  }
}

/** Carry out one action. `again`: the state moved and the next one can be
 *  looked at in this pass; `stop`: wait for the next pass (or the visit left
 *  Agetor's hands). */
async function perform(task: Task, run: PipelineRunState, p: PipelinePublishState, action: PublishAction, now: number): Promise<"again" | "stop"> {
  const git = publishDeps.git;
  const checkout = task.worktreePath!;
  const store = async (result: PublishResult): Promise<PipelinePublishState | null> => {
    const next = applyPublish(p, action, result, now);
    return updatePublish(task.id, p, next);
  };
  const failed = async (error: string): Promise<"stop"> => {
    const next = await store({ ok: false, error });
    if (next) say(task.id, `Finish (run by Agetor): ${next.note}`, "warning");
    return "stop";
  };

  switch (action.kind) {
    case "advance": {
      const next = await store({ ok: true });
      if (next && action.say) say(task.id, `Finish (run by Agetor): ${action.say}`, action.to === "base-red" ? "warning" : "info");
      return next ? "again" : "stop";
    }
    case "wait": {
      // Nothing new to say: no write, no event.
      const same = action.note === p.note && Object.entries(action.set ?? {}).every(([k, v]) => p[k as keyof PipelinePublishState] === v);
      const next = same ? p : await store({ ok: true });
      // A wait on the base is worth a line; "CI running" is on the card already.
      if (next && (p.state === "hold-base" || p.state === "base-red")) say(task.id, `Finish (run by Agetor): ${action.note}`, "warning");
      return "stop";
    }
    case "merge-base": {
      const head = await git(["rev-parse", "HEAD"], checkout);
      const dirty = await git(["status", "--porcelain", "--untracked-files=no"], checkout);
      if (!head.ok || head.stdout !== p.head || !dirty.ok || dirty.stdout) return failed("the worktree changed since the head was verified");
      const merged = await git(["merge", "--ff-only", "--quiet", action.commit], checkout);
      const after = await git(["rev-parse", "HEAD"], checkout);
      if (!merged.ok || after.stdout !== action.commit) return failed(merged.stderr || "the fast-forward to the merge commit did not apply");
      const tree = await git(["rev-parse", "HEAD^{tree}"], checkout);
      const next = await store({ ok: true, head: action.commit, ...(tree.ok ? { tree: tree.stdout } : {}) });
      if (next) {
        say(task.id, `Finish (run by Agetor): merged origin/${p.base} into the approved head — the merge is clean and the change's own diff is unchanged, so Review's approval carries over (no agent step)`, "info");
      }
      return next ? "again" : "stop";
    }
    case "push": {
      // Exactly the verified head, by sha, to the card's own branch. Never forced.
      const head = await git(["rev-parse", "HEAD"], checkout);
      if (!p.head || !head.ok || head.stdout !== p.head) return failed("HEAD is no longer the verified head");
      if (!task.branch || PROTECTED_BRANCHES.has(task.branch) || task.branch === p.base) return failed(`refusing to push to "${task.branch}"`);
      const pushed = await git(["push", "--quiet", "--no-verify", "origin", `${p.head}:refs/heads/${task.branch}`], checkout);
      if (!pushed.ok) return failed(pushed.stderr || "git push failed");
      const next = await store({ ok: true });
      if (next) say(task.id, `Finish (run by Agetor): pushed ${p.head.slice(0, 8)} to ${task.branch}${p.carried ? ` (the approved head with ${p.base} merged in)` : " — the head Review approved"}`, "info");
      invalidatePrStatus(task.id);
      return next ? "again" : "stop";
    }
    case "open-pr": {
      const subject = await git(["log", "--no-merges", "-1", "--format=%s", `refs/remotes/origin/${p.base}..${p.approvedHead ?? "HEAD"}`], checkout);
      const title = subject.ok ? subject.stdout : "";
      if (!title) return failed("no commit to name the pull request after");
      const summary = [...run.history].reverse().find((h) => h.handoff?.summary)?.handoff?.summary ?? null;
      const opened = await publishDeps.openPull(task, { title, base: p.base!, body: publishDraftBody(summary, issueNumberForTask(task)) });
      if (!opened.ok) return failed(opened.error);
      const next = await store(opened);
      if (next && opened.pr) {
        if (opened.pr.url) tasks.update(task.id, { prUrl: opened.pr.url });
        say(task.id, `Finish (run by Agetor): opened draft PR #${opened.pr.number}`, "info");
        invalidatePrStatus(task.id);
      }
      return next ? "again" : "stop";
    }
    case "rerun": {
      const checks = p.head ? await publishDeps.checks(task, p.head) : null;
      if (!checks) return failed("couldn't read the checks to re-run");
      const newest = newestPerName(checks);
      const cancelled = newest.filter((r) => r.conclusion === "cancelled");
      const broken = newest.filter((r) => failedConclusion(r.conclusion));
      const targets = action.why === "cancelled" && cancelled.length ? cancelled : broken.length ? broken : newest.filter((r) => ROLLUP_CHECKS.has(r.name));
      const runIds = [...new Set(targets.map((r) => runIdFromCheckUrl(r.htmlUrl)).filter((n): n is number => n != null))];
      if (runIds.length === 0) return failed("no workflow run to re-run");
      const results = await Promise.all(runIds.map((id) => publishDeps.rerunFailed(task, id)));
      if (!results.some((r) => r.ok)) return failed(results.find((r) => !r.ok)?.error ?? "the re-run was refused");
      const next = await store({ ok: true });
      if (next) say(task.id, `Finish (run by Agetor): re-ran the ${action.why === "cancelled" ? "cancelled" : "failed"} jobs once (${action.reason}) — not a failure of this change`, "info");
      invalidatePrStatus(task.id);
      return "stop";
    }
    case "to-build": {
      const built = await buildHandoff(task, run, p, action.cause);
      if (!built) {
        await stopPublishForOwner(task.id, "the pipeline no longer has a Build step to send the failure to");
        return "stop";
      }
      await routeFromPublish(task.id, built);
      return "stop";
    }
    case "write": {
      const pr = p.pr;
      const checks = p.head ? await publishDeps.checks(task, p.head) : null;
      const found = await publishDeps.findPull(task);
      const head = p.head;
      if (!pr || !head || !p.approvedHead || !checks || !found.ok) return failed("couldn't read the pull request to finish it");
      const facts: PublishFacts = {
        branch: task.branch!, base: p.base!, pr, head, tree: p.tree, approvedHead: p.approvedHead, carried: p.carried, baseTip: p.baseTip,
        checks: newestPerName(checks).map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.htmlUrl })), reran: p.reran,
      };
      const markedReady = found.pull?.draft ? await publishDeps.markReady(task, pr.number) : true;
      let factsPosted = p.posted === head;
      if (!factsPosted && (await publishDeps.comment(task, pr.number, publishEvidenceComment(facts)))) {
        factsPosted = true;
        // Remembered before the writer starts, so a failed launch never posts twice.
        const kept = await updatePublish(task.id, p, { ...p, posted: head });
        if (!kept) return "stop";
        p = kept;
      }
      if (!task.prUrl && pr.url) tasks.update(task.id, { prUrl: pr.url });
      invalidatePrStatus(task.id);
      await launchPublishAgent(task.id, {
        mode: "write",
        brief: publishWriterBrief({ ...facts, issueUrl: task.issueUrl ?? null, factsPosted, markedReady }),
        activity: `Finish (run by Agetor): CI passed on ${head.slice(0, 8)} (PR #${pr.number}) — its agent writes the PR description; nothing else is left`,
      });
      return "stop";
    }
    case "agent":
      await launchPublishAgent(task.id, { mode: "agent", activity: `Finish is run by its agent for this visit: ${action.why}` });
      return "stop";
    case "owner":
      await stopPublishForOwner(task.id, action.why);
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** The card's held publish visit, or null. */
function heldVisit(task: Task | null | undefined): { run: PipelineRunState; p: PipelinePublishState } | null {
  const run = task?.pipelineRun;
  const p = run?.publish;
  if (!task || !run || !p || task.archivedAt != null || task.pipelineParentId || p.state === "write" || p.state === "agent") return null;
  if (!run.blocked.some((b) => b.taskId === null && b.stepId === p.stepId && b.kind === "await")) return null;
  return { run, p };
}

const inFlight = new Set<string>();
/** When each card waiting on the base last looked at it. */
const lastBaseLook = new Map<string, number>();

/** One pass for one card. Exported for tests. */
export async function publishCard(parentId: string, now = Date.now()): Promise<void> {
  if (inFlight.has(parentId)) return;
  inFlight.add(parentId);
  try {
    for (let i = 0; i < MAX_STEPS_PER_PASS; i++) {
      const task = tasks.get(parentId);
      const held = heldVisit(task);
      if (!task || !held) return;
      const { run } = held;
      let { p } = held;
      // Taken out of `pipeline_gates` while it was held: the agent's again.
      if (!publishStepFor(task, run)) {
        await launchPublishAgent(parentId, { mode: "agent", activity: "Finish is run by its agent again: pipeline_gates no longer names this card" });
        return;
      }
      if (!p.base) {
        const base = task.worktreePath ? await publishDeps.base(task.worktreePath).catch(() => null) : null;
        if (!base) return;
        const kept = await updatePublish(parentId, p, { ...p, base });
        if (!kept) return;
        p = kept;
      }
      if (p.state === "hold-base" || p.state === "base-red") {
        const last = lastBaseLook.get(parentId);
        if (i === 0 && last !== undefined && now - last < BASE_LOOK_MS && now >= last) return;
        lastBaseLook.set(parentId, now);
      }
      const action = decidePublish(p, await observe(task, run, p), now);
      if ((await perform(task, run, p, action, now)) === "stop") return;
    }
  } finally {
    inFlight.delete(parentId);
  }
}

/** One pass over every card whose Finish Agetor is running. Exported for tests. */
export async function publishTick(now = Date.now()): Promise<number> {
  let n = 0;
  const live = new Set<string>();
  for (const task of tasks.listLive()) {
    if (!heldVisit(task)) continue;
    live.add(task.id);
    n++;
    await publishCard(task.id, now).catch((e: unknown) => say(task.id, `Finish (run by Agetor) hit an error and will try again: ${e instanceof Error ? e.message : String(e)}`, "warning"));
  }
  for (const id of [...lastBaseLook.keys()]) if (!live.has(id)) lastBaseLook.delete(id);
  for (const id of [...said.keys()]) if (!live.has(id)) said.delete(id);
  return n;
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startPublishLoop(): void {
  if (loop) return;
  // A card just put on hold gets its first look now, not in a minute.
  publishHooks.held = (parentId) => {
    queueMicrotask(() => void publishCard(parentId).catch(() => undefined));
  };
  loop = setInterval(() => void publishTick().catch(() => undefined), TICK_MS);
  loop.unref?.();
}

export function resetPublishForTests(): void {
  if (loop) clearInterval(loop);
  loop = null;
  publishHooks.held = () => {};
  inFlight.clear();
  lastBaseLook.clear();
  said.clear();
  settledBaseChecks.clear();
}
