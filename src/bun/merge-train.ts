/**
 * Merge trains: several signed-off PRs merged as one batch, so CI runs once on
 * the combined change (and once on develop) instead of once per PR.
 *
 * When two or more Ready to Merge cards in the same project are green and
 * mergeable (behind the base is fine — the train is built on the latest base),
 * and the oldest has waited `windowMin` (or `max` are ready), Agetor:
 *
 *   1. builds `agetor/merge-train-<id>` from `origin/<base>`, adding each PR as
 *      ONE merge commit "<PR title> (#n)" whose second parent is the PR's head
 *      — a PR that conflicts drops out and merges on its own;
 *   2. pushes it and opens one PR, "Merge train: #a, #b, #c";
 *   3. when that PR is green, merges it with the MERGE method — develop's
 *      first-parent history gets the train's merge, and under it one merge
 *      per original PR, in one push.
 *
 *   Merge commits, not squashes (owner decision 2026-10-15): a PR's own
 *   commits stay reachable from the base. Records pin the commit they were
 *   made at (Pillar's docs/engineering/record-pins.md), and a squash left
 *   that commit off develop, which turned develop red after the merge;
 *   4. closes each original PR ("Merged in merge train #T"), moves its card to
 *      Done and closes its issue.
 *
 * If the train's CI fails (or a member changes, or it conflicts), the train is
 * disbanded: its PR closed, its members handled one by one.
 *
 * The fresh rule (`merge_queue_fresh`, on unless "false"): a green PR merges
 * by itself only when its checks are fresh — its head contains the base's
 * tip, so CI tested what will land. A green PR that is behind the base rides
 * a train instead, alone when it has no company (a train of one), and the
 * members of a train whose CI failed are each re-tested as a train of one
 * rather than merged on their old results. One extra CI run per lone stale
 * PR; a failed train of N costs up to N more.
 *
 * State lives in preferences (`merge_train_state`, `merged_via_train`); config
 * in `merge_train` = {"enabled": true, "windowMin": 10, "max": 6}.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task, TaskPrStatus } from "../shared/types.ts";
import { dataDir, preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import {
  cancelGitHubWorkflowRun,
  closeGitHubPull,
  createGitHubPull,
  forceCancelGitHubWorkflowRun,
  getGitHubPullChecks,
  getGitHubPullDetail,
  getGitHubPullMergeability,
  getGitHubRefCheckRuns,
  getGitHubWorkflowRunStatus,
  gitPushWithRetry,
  listActiveWorkflowRuns,
  mergeGitHubPull,
  rerunGitHubWorkflowRun,
  run,
} from "./github.ts";
import { closeIssueForTask, markInherited, newestPerName, ROLLUP_CHECKS, rollUpChecks } from "./pr-watch.ts";
import { moveMergedTaskToDone } from "./orchestrator.ts";
import { setMergeQueued } from "./merge-intent.ts";
import { MERGE_REGENERATE_PREF, parseRegenerateRules, regenerateCovering } from "../shared/publish.ts";
import { jobTails, readFailedRun } from "./ci-failure-log.ts";
import { infraReason, logTail, RERUN_SETTLE_MS, runIdFromCheckUrl, type FailedCheck } from "./merge-rework.ts";

export const MERGE_TRAIN_PREF = "merge_train";
/** "false" turns the fresh rule off: a green PR that is behind its base then
 *  merges as it is, and a failed train's members merge one at a time. */
export const MERGE_FRESH_PREF = "merge_queue_fresh";
export function freshRuleOn(raw: string | null | undefined = preferences.get(MERGE_FRESH_PREF)): boolean {
  return raw?.trim().toLowerCase() !== "false";
}

/** Whether a PR's green result is about what would land: its head contains
 *  the base's tip, so the commit CI tested is the merge result whatever the
 *  base was when the run started (a re-run tests the old merge commit, which
 *  is why run times cannot answer this). Unknown distance counts as stale. Pure. */
export function freshAgainstBase(pr: Pick<TaskPrStatus, "behindBy">): boolean {
  return pr.behindBy === 0;
}
const STATE_PREF = "merge_train_state";
const VIA_PREF = "merged_via_train";
const BISECT_QUEUE_PREF = "merge_train_bisect";

export interface BisectBatch {
  project: string;
  base: string;
  taskIds: string[];
}

export function getBisectQueue(): BisectBatch[] {
  try {
    const v = JSON.parse(preferences.get(BISECT_QUEUE_PREF) ?? "[]");
    return Array.isArray(v) ? (v as BisectBatch[]) : [];
  } catch {
    return [];
  }
}

export function saveBisectQueue(queue: BisectBatch[]): void {
  preferences.set(BISECT_QUEUE_PREF, JSON.stringify(queue));
}

export function clearBisectQueueForTests(): void {
  preferences.set(BISECT_QUEUE_PREF, "[]");
}

export interface TrainConfig {
  enabled: boolean;
  windowMin: number;
  max: number;
}

export function parseTrainConfig(raw: string | null | undefined): TrainConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const n = (x: unknown, d: number, min: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(min, Math.floor(x)) : d);
  return { enabled: o.enabled !== false, windowMin: n(o.windowMin, 10, 0), max: n(o.max, 6, 2) };
}

export interface TrainMember {
  taskId: string;
  pr: number;
  branch: string;
  title: string;
  headSha: string | null;
}

export interface Train {
  id: string;
  project: string;
  base: string;
  branch: string;
  pr: number;
  url: string;
  members: TrainMember[];
  createdAt: number;
  rerunAttempted?: boolean;
  rerunAttemptedAt?: number;
}

export function activeTrain(): Train | null {
  try {
    const v = JSON.parse(preferences.get(STATE_PREF) ?? "null");
    return v && typeof v === "object" && Array.isArray(v.members) ? (v as Train) : null;
  } catch {
    return null;
  }
}

function saveTrain(t: Train): void {
  preferences.set(STATE_PREF, JSON.stringify(t));
}

/** Forget train `id` — only if it's still the active one, so a late step
 *  finishing off an old train can never wipe a newer train's record. */
function clearTrain(id: string): void {
  if (activeTrain()?.id === id) preferences.set(STATE_PREF, JSON.stringify(null));
}

/** Cards that landed through a train: taskId → { pr, url }. */
export function mergedViaTrain(): Record<string, { pr: number; url: string }> {
  try {
    const v = JSON.parse(preferences.get(VIA_PREF) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** A signed-off PR that could ride a train now: open, green, no review
 *  threads, not draft, not conflicting. Being behind the base is fine. Pure. */
export function trainEligible(pr: TaskPrStatus | null, mergeability: { mergeable: boolean | null; mergeableState: string } | null): boolean {
  if (!pr || pr.state !== "open" || pr.draft || pr.checks !== "success" || pr.unresolvedThreads > 0) return false;
  if (mergeability?.mergeable === false || mergeability?.mergeableState === "dirty") return false;
  return true;
}

/** For a train the user sends by hand: the train's own CI checks the combined
 *  change, so a PR's own checks may still be running — only a PR that is
 *  failing, conflicting, draft or has open review threads stays behind. Pure. */
export function manualTrainEligible(pr: TaskPrStatus | null, mergeability: { mergeable: boolean | null; mergeableState: string } | null): boolean {
  if (!pr || pr.state !== "open" || pr.draft || pr.checks === "failure" || pr.unresolvedThreads > 0) return false;
  if (mergeability?.mergeable === false || mergeability?.mergeableState === "dirty") return false;
  return true;
}

/** Should these ready cards leave now as a train? `min` is 1 for a lone
 *  stale PR under the fresh rule. A lone train of one departs immediately. Pure. */
export function shouldDepart(readySince: number[], cfg: TrainConfig, now: number, min = 2): boolean {
  if (!cfg.enabled || readySince.length < Math.max(1, min)) return false;
  if (min === 1 && readySince.length === 1) return true;
  return readySince.length >= cfg.max || now - Math.min(...readySince) >= cfg.windowMin * 60_000;
}

export function trainTitle(members: Pick<TrainMember, "pr">[]): string {
  return `Merge train: ${members.map((m) => `#${m.pr}`).join(", ")}`;
}

export function trainBody(members: Pick<TrainMember, "pr" | "title">[], base: string): string {
  return [
    members.length === 1
      ? `Re-tests one signed-off pull request on the latest \`${base}\` before it merges: its own checks ran against an older \`${base}\`.`
      : `Merges ${members.length} signed-off pull requests into \`${base}\` as one batch, so CI runs once for all of them.`,
    "",
    ...members.map((m) => `- #${m.pr} — ${m.title}`),
    "",
    `Each PR is one squashed commit here, \`<title> (#n)\`. Agetor merges this PR with **rebase**, so \`${base}\` keeps one commit per PR, then closes the originals with a link back here and closes their issues.`,
    "",
    members.length === 1
      ? "If CI fails, Agetor closes this train and the pull request is updated from the base so the failure shows on it."
      : "If CI fails, Agetor closes this train and handles the PRs one at a time instead.",
  ].join("\n");
}

const git = (args: string[], cwd?: string, timeoutMs = 120_000) => run(["git", ...args], cwd, timeoutMs, process.env);

async function runShellCommand(command: string, cwd: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["/bin/sh", "-c", `. "$HOME/.agetor/bin/agent-path.sh" 2>/dev/null; ${command}`], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 300_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

async function prTitle(dir: string, n: number, fallback: string): Promise<string> {
  const r = await getGitHubPullDetail({ dir, number: n });
  return r.ok && r.item?.title ? r.item.title : fallback;
}

/** Build, push and open a train for `ready` (all one project + base). Returns
 *  the train, or null when fewer than `min` PRs survived the squash (two;
 *  one for a train of one under the fresh rule). */
export async function buildTrain(ready: { task: Task; pr: TaskPrStatus }[], min = 2): Promise<Train | null> {
  const project = ready[0]!.task.workdir;
  const base = ready[0]!.pr.baseRef ?? "develop";
  const id = Date.now().toString(36);
  const branch = `agetor/merge-train-${id}`;
  const dir = path.join(dataDir, "merge-trains", id);
  mkdirSync(path.dirname(dir), { recursive: true });

  const candidates = await Promise.all(
    ready.map(async ({ task, pr }) => ({
      taskId: task.id,
      pr: pr.number,
      branch: task.branch!,
      title: await prTitle(project, pr.number, task.title),
      headSha: pr.headSha ?? null,
    })),
  );
  const { members, dropped } = await assembleTrain(project, base, branch, dir, candidates, min);
  for (const d of dropped) {
    recordActivity(d.member.taskId, { kind: "auto", text: `Left out of a merge train (${d.why}) — ${freshRuleOn() ? "handled" : "merging"} on its own`, tone: "muted" });
  }
  if (members.length < Math.max(1, min)) {
    await git(["push", "--quiet", "--no-verify", "origin", "--delete", branch], project).catch(() => undefined);
    return null;
  }
  const opened = await createGitHubPull({ dir: project, title: trainTitle(members), head: branch, base, body: trainBody(members, base) });
  if (!opened.ok) {
    await git(["push", "--quiet", "--no-verify", "origin", "--delete", branch], project).catch(() => undefined);
    return null;
  }
  const train: Train = { id, project, base, branch, pr: opened.item.number, url: opened.item.htmlUrl, members, createdAt: Date.now() };
  saveTrain(train);
  // Its own CI is now redundant — free the runners for the train's run in one pass.
  const cancelled = await cancelRunsForBranches(project, new Set(members.map((m) => m.branch))).catch(() => 0);
  for (const m of members) {
    recordActivity(m.taskId, {
      kind: "auto",
      text: members.length === 1
        ? `Riding merge train #${train.pr} alone: its own checks ran against an older ${base}, so CI tests what will land before it merges (one extra CI run)`
        : `Joined merge train #${train.pr} with ${members.length - 1} other PR(s)${cancelled ? ` — cancelled ${cancelled} pending CI run(s) of member branches so the train goes first` : ""}`,
      tone: "info",
      url: train.url,
    });
  }
  return train;
}

/**
 * The git half of building a train: a branch from `origin/<base>` with each
 * candidate squashed into ONE commit "<title> (#n)", in order.
 *
 * Fast path: built entirely in-memory using `git merge-tree --write-tree` and
 * `git commit-tree`, avoiding disk worktree churn.
 * Fallback: when conflicts occur and every conflicted path is covered by
 * `merge_regenerate` rules, a scratch worktree regenerates the files.
 * Candidates that still conflict or add nothing are dropped. Pushes the branch
 * when `min` or more survived (two; one for a train of one). Exported for tests.
 */
export async function assembleTrain(
  project: string,
  base: string,
  branch: string,
  dir: string,
  candidates: TrainMember[],
  min = 2,
): Promise<{ members: TrainMember[]; dropped: { member: TrainMember; why: string }[] }> {
  await git(["fetch", "--quiet", "origin", base, ...candidates.map((c) => c.branch)], project);

  const members: TrainMember[] = [];
  const dropped: { member: TrainMember; why: string }[] = [];

  const baseTreeRes = await git(["rev-parse", `origin/${base}^{tree}`], project);
  if (!baseTreeRes.ok || !baseTreeRes.stdout) {
    return { members: [], dropped: candidates.map((member) => ({ member, why: `couldn't resolve origin/${base}: ${baseTreeRes.stderr}` })) };
  }

  let currentCommit = (await git(["rev-parse", `origin/${base}`], project)).stdout.trim();
  let currentTree = baseTreeRes.stdout.trim();

  const rules = parseRegenerateRules(preferences.get(MERGE_REGENERATE_PREF), project);

  for (const c of candidates) {
    const candidateShaRes = await git(["rev-parse", `origin/${c.branch}`], project);
    const candidateSha = candidateShaRes.ok && candidateShaRes.stdout.trim() ? candidateShaRes.stdout.trim() : null;

    // 1. In-memory merge probe
    const merged = await git(["merge-tree", "--write-tree", "--name-only", currentCommit, `origin/${c.branch}`], project);
    if (merged.ok) {
      const newTree = merged.stdout.split("\n")[0]?.trim();
      if (!newTree || newTree === currentTree) {
        dropped.push({ member: c, why: "no changes against the base" });
        continue;
      }
      if (!candidateSha) {
        dropped.push({ member: c, why: `couldn't resolve origin/${c.branch}` });
        continue;
      }
      const committed = await git([
        "commit-tree",
        newTree,
        "-p",
        currentCommit,
        "-p",
        candidateSha,
        "-m",
        `${c.title} (#${c.pr})`,
        "-m",
        `Merged from #${c.pr} in a merge train.`,
      ], project);
      if (!committed.ok || !committed.stdout) {
        dropped.push({ member: c, why: `commit failed: ${committed.stderr}` });
        continue;
      }
      currentCommit = committed.stdout.trim();
      currentTree = newTree;
      members.push(candidateSha ? { ...c, headSha: candidateSha } : c);
      continue;
    }

    // 2. Conflicted: check if covered by regenerateCovering
    if (merged.exitCode === 1) {
      const files = [...new Set((merged.stdout.split("\n\n")[0] ?? "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean))];
      const covering = files.length > 0 ? regenerateCovering(files, rules) : null;
      if (covering) {
        const scratch = mkdtempSync(path.join(tmpdir(), "train-regenerate-"));
        rmSync(scratch, { recursive: true, force: true });
        try {
          const added = await git(["worktree", "add", "--detach", "--quiet", scratch, currentCommit], project);
          if (added.ok) {
            const sq = await git(["merge", "--no-ff", "--no-commit", `origin/${c.branch}`], scratch);
            if (!sq.ok) {
              for (const f of files) {
                await git(["checkout", currentCommit, "--", f], scratch).catch(() => undefined);
              }
              let regenOk = true;
              for (const r of covering) {
                if (!(await runShellCommand(r.command, scratch))) {
                  regenOk = false;
                  break;
                }
              }
              if (regenOk) {
                await git(["add", "--", ...files], scratch);
                const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], scratch);
                if (unmerged.ok && !unmerged.stdout) {
                  const comm = await git([
                    "commit",
                    "--quiet",
                    "--no-verify",
                    "-m",
                    `${c.title} (#${c.pr})`,
                    "-m",
                    `Merged from #${c.pr} in a merge train (regenerated ${files.join(", ")}).`,
                  ], scratch);
                  if (comm.ok) {
                    const newHead = (await git(["rev-parse", "HEAD"], scratch)).stdout.trim();
                    const newTreeSha = (await git(["rev-parse", "HEAD^{tree}"], scratch)).stdout.trim();
                    if (newHead && newTreeSha) {
                      currentCommit = newHead;
                      currentTree = newTreeSha;
                      members.push(candidateSha ? { ...c, headSha: candidateSha } : c);
                      continue;
                    }
                  }
                }
              }
            }
          }
        } finally {
          await git(["worktree", "remove", "--force", scratch], project).catch(() => undefined);
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }

    dropped.push({ member: c, why: "conflicts with the other PRs" });
  }

  if (members.length >= Math.max(1, min)) {
    const pushed = await gitPushWithRetry(["push", "--quiet", "--no-verify", "-u", "origin", `${currentCommit}:refs/heads/${branch}`], project);
    if (!pushed.ok) {
      return { members: [], dropped: [...dropped, ...members.map((member) => ({ member, why: `push failed: ${pushed.stderr}` }))] };
    }
    await git(["fetch", "--quiet", "origin", branch], project).catch(() => undefined);
  }

  return { members, dropped };
}

/** Members of a disbanded train are handled one at a time — remembered per
 *  PR head, so a fresh push can ride a later train. Under the fresh rule
 *  "one at a time" is a train of one for a PR behind its base. */
const trainSkip = new Set<string>();
export function skipsTrain(pr: TaskPrStatus): boolean {
  return trainSkip.has(`${pr.number}:${pr.headSha ?? ""}`);
}
/** Keep this PR head out of shared trains (it conflicts with the others). */
export function markRidesAlone(pr: Pick<TaskPrStatus, "number" | "headSha">): void {
  trainSkip.add(`${pr.number}:${pr.headSha ?? ""}`);
}
/** PR heads whose train of one failed CI: green alone, red on the latest
 *  base. Another train would fail the same way; the merge queue updates the
 *  branch so the failure shows on the PR itself. */
const failedAlone = new Set<string>();
export function trainFailedAlone(pr: Pick<TaskPrStatus, "number" | "headSha">): boolean {
  return failedAlone.has(`${pr.number}:${pr.headSha ?? ""}`);
}
export function resetTrainMarksForTests(): void {
  trainSkip.clear();
  failedAlone.clear();
}

/**
 * Cancel active runs for all branches belonging to train members in one pass.
 * Fetches active runs in the repo once through fetchGitHub (avoiding 4N gh subprocesses).
 */
export async function cancelRunsForBranches(dir: string, branches: Set<string>): Promise<number> {
  const active = await listActiveWorkflowRuns({ dir });
  if (!active.ok) return 0;
  let n = 0;
  for (const r of active.runs) {
    if (branches.has(r.headBranch)) {
      const res = await cancelGitHubWorkflowRun({ dir, runId: r.id });
      if (res.ok) {
        n++;
        stuck.add(`${dir}\0${r.id}`);
      }
    }
  }
  return n;
}

/**
 * Cancel queued and running CI on `branch`. Best-effort; returns how many were cancelled.
 */
export async function cancelBranchRuns(dir: string, branch: string): Promise<number> {
  return cancelRunsForBranches(dir, new Set([branch]));
}

/** Runs we've asked to cancel. A run whose remaining job is still waiting
 *  for a self-hosted runner can sit in "queued" after a cancel — GitHub only
 *  finishes the cancel once a runner picks the job up — so on the next pass
 *  those get a force-cancel. */
const stuck = new Set<string>();

export async function forceCancelStuck(): Promise<number> {
  let n = 0;
  for (const key of [...stuck]) {
    const [dir, idStr] = key.split("\0") as [string, string];
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0) {
      stuck.delete(key);
      continue;
    }
    const state = await getGitHubWorkflowRunStatus({ dir, runId: id });
    if (!state.ok || state.status === "completed") {
      stuck.delete(key);
      continue;
    }
    const r = await forceCancelGitHubWorkflowRun({ dir, runId: id });
    if (r.ok) {
      n++;
      stuck.delete(key);
    }
  }
  return n;
}

/** Has the train's CI actually started — any check run in progress or done?
 *  (Queued-only checks haven't used a runner yet.) */
export async function trainCiStarted(t: Train): Promise<boolean> {
  const checks = await getGitHubPullChecks({ dir: t.project, number: t.pr });
  if (!checks.ok) return true; // unknown: assume started, don't throw work away
  return checks.checkRuns.some((r) => r.status !== "queued" && r.status !== "pending" && r.status !== "waiting" && r.status !== "requested" && r.name !== "Vercel Preview Comments");
}

/** Close a train that hasn't started CI so a bigger one can replace it. Its
 *  members aren't marked to merge alone — they ride the replacement. */
export async function replaceTrain(t: Train): Promise<void> {
  await closeGitHubPull({ dir: t.project, number: t.pr, comment: "Replaced by a larger merge train sent by hand — these PRs ride that one." });
  await cancelBranchRuns(t.project, t.branch).catch(() => 0);
  await git(["push", "--quiet", "--no-verify", "origin", "--delete", t.branch], t.project);
  clearTrain(t.id);
}

/** What a member is told when its train disbands. Pure; exported for tests. */
export function disbandNote(t: Pick<Train, "pr" | "members" | "base">, why: string, opts: { fresh: boolean; ciFailed: boolean }): string {
  const head = `Merge train #${t.pr} disbanded (${why})`;
  if (!opts.fresh) return `${head} — merging on its own`;
  if (t.members.length === 1) {
    return opts.ciFailed
      ? `${head}: this PR passes alone but fails on the latest ${t.base} — updating its branch so the failure shows on the PR`
      : `${head} — handled on its own`;
  }
  return opts.ciFailed
    ? `${head} — each of its ${t.members.length} PRs is re-tested alone on the latest ${t.base} before it merges (up to ${t.members.length} more CI runs, one at a time)`
    : `${head} — handled on its own (re-tested first if it is behind ${t.base})`;
}

export async function disband(t: Train, why: string, prs: Map<string, TaskPrStatus | null>, ciFailed = false): Promise<void> {
  const fresh = freshRuleOn();
  await closeGitHubPull({ dir: t.project, number: t.pr, comment: `Disbanding this merge train: ${why}. Agetor ${fresh ? "handles" : "merges"} these PRs one at a time instead.` });
  await cancelRunsForBranches(t.project, new Set(t.members.map((m) => m.branch))).catch(() => 0);
  await git(["push", "--quiet", "--no-verify", "origin", "--delete", t.branch], t.project).catch(() => undefined);

  // If a multi-member train (>= 3) genuinely failed CI, bisect instead of splitting into N trains of one
  if (fresh && ciFailed && t.members.length >= 3) {
    const mid = Math.ceil(t.members.length / 2);
    const firstHalf = t.members.slice(0, mid);
    const secondHalf = t.members.slice(mid);
    const queue = getBisectQueue();
    queue.push({ project: t.project, base: t.base, taskIds: firstHalf.map((m) => m.taskId) });
    queue.push({ project: t.project, base: t.base, taskIds: secondHalf.map((m) => m.taskId) });
    saveBisectQueue(queue);
    for (const m of t.members) {
      recordActivity(m.taskId, {
        kind: "auto",
        text: `Merge train #${t.pr} disbanded (${why}) — bisecting into smaller batches: [#${firstHalf.map((x) => x.pr).join(", #")}] and [#${secondHalf.map((x) => x.pr).join(", #")}]`,
        tone: "warning",
        url: t.url,
      });
    }
  } else {
    for (const m of t.members) {
      const pr = prs.get(m.taskId);
      const key = `${m.pr}:${pr?.headSha ?? m.headSha ?? ""}`;
      trainSkip.add(key);
      if (fresh && ciFailed && t.members.length === 1) failedAlone.add(key);
      recordActivity(m.taskId, { kind: "auto", text: disbandNote(t, why, { fresh, ciFailed }), tone: "warning", url: t.url });
    }
  }
  clearTrain(t.id);
}

async function trainPrState(t: Train): Promise<string | null> {
  const d = await getGitHubPullDetail({ dir: t.project, number: t.pr });
  return d.ok && d.item?.state ? d.item.state.toUpperCase() : null;
}

async function land(t: Train): Promise<void> {
  const via = mergedViaTrain();
  for (const m of t.members) {
    // Its head is on the base now, so GitHub usually marks the PR merged by
    // itself; closing it is for when it doesn't (a refused close is fine).
    await closeGitHubPull({ dir: t.project, number: m.pr, comment: `Merged in merge train #${t.pr} (${t.url}) as one merge commit on \`${t.base}\`.` });
    // Its work is on the base: delete the branch here, as GitHub would.
    await git(["push", "--quiet", "--no-verify", "origin", "--delete", m.branch], t.project);
    via[m.taskId] = { pr: t.pr, url: t.url };
    preferences.set(VIA_PREF, JSON.stringify(via));
    const task = tasks.get(m.taskId);
    setMergeQueued(m.taskId, false);
    if (task) {
      moveMergedTaskToDone(m.taskId);
      recordActivity(m.taskId, { kind: "pr", text: `Merged in merge train #${t.pr}`, tone: "success", url: t.url });
      await closeIssueForTask(task, {
        comment: `Fixed by #${m.pr}, merged into \`${t.base}\` in merge train #${t.pr}. Closed by Agetor.`,
        activity: `fixed by PR #${m.pr}, via merge train #${t.pr}`,
        prNumber: m.pr,
      }).catch(() => undefined);
    }
  }
  await git(["push", "--quiet", "--no-verify", "origin", "--delete", t.branch], t.project);
  clearTrain(t.id);
}

/** Move the active train along: land it when green, disband it when it
 *  fails, conflicts, or a member changed or was withdrawn. */
export async function advanceTrain(t: Train, prs: Map<string, TaskPrStatus | null>): Promise<"waiting" | "landed" | "disbanded"> {
  // Merged or closed by hand on GitHub: finish the job (or stand down) rather
  // than wait on a PR that will never change again.
  const outside = await trainPrState(t);
  if (outside === "MERGED") {
    await land(t);
    return "landed";
  }
  if (outside === "CLOSED") {
    await disband(t, "its PR was closed", prs);
    return "disbanded";
  }
  // While the train is out, its members' own CI is redundant: cancel anything
  // pending on their branches (a late push, a re-run) in one single list call per tick,
  // and force-cancel runs a plain cancel left stuck in the queue.
  await forceCancelStuck().catch(() => 0);
  await cancelRunsForBranches(t.project, new Set(t.members.map((m) => m.branch))).catch(() => 0);
  for (const m of t.members) {
    const task = tasks.get(m.taskId);
    const pr = prs.get(m.taskId);
    if (!task || task.column !== "merge") {
      await disband(t, `#${m.pr} was taken out of Ready to Merge`, prs);
      return "disbanded";
    }
    if (pr && pr.headSha && m.headSha && pr.headSha !== m.headSha) {
      await disband(t, `#${m.pr} got new commits`, prs);
      return "disbanded";
    }
  }
  const checks = await getGitHubPullChecks({ dir: t.project, number: t.pr });
  if (!checks.ok) return "waiting";
  const { checks: state } = rollUpChecks(checks.checkRuns);
  if (state === "failure") {
    // 1. Compare against base checks: is develop itself failing the same checks?
    let failing = rollUpChecks(checks.checkRuns).failing;
    const baseChecks = await getGitHubRefCheckRuns({ dir: t.project, ref: t.base });
    if (baseChecks.ok) {
      const passing = newestPerName(baseChecks.checkRuns)
        .filter((r) => r.status === "completed" && r.conclusion === "success")
        .map((r) => r.name);
      failing = markInherited(failing, rollUpChecks(baseChecks.checkRuns).failing, passing);
    }
    const own = failing.filter((f) => !f.alsoOnBase && !ROLLUP_CHECKS.has(f.name));
    if (failing.length > 0 && own.length === 0) {
      // The failure is on develop itself; wait for develop to recover rather than disbanding.
      return "waiting";
    }

    // 2. Classify infra/runner failures and re-run failed jobs once before disbanding
    if (t.rerunAttemptedAt && Date.now() - t.rerunAttemptedAt < RERUN_SETTLE_MS) {
      return "waiting";
    }
    if (!t.rerunAttempted) {
      const conclusions = new Map(newestPerName(checks.checkRuns).map((r) => [r.name, r.conclusion] as const));
      const checksList: FailedCheck[] = own.map((c) => ({
        name: c.name,
        url: c.url,
        conclusion: conclusions.get(c.name) ?? null,
        runId: runIdFromCheckUrl(c.url),
      }));
      const runIds = [...new Set(checksList.map((c) => c.runId).filter((n): n is number => n != null))];
      const logs: { runId: number; tail: string; jobs?: Record<string, string> }[] = [];
      for (const runId of runIds.slice(0, 2)) {
        const read = await readFailedRun(t.project, runId);
        if (read) logs.push({ runId, tail: logTail(read.raw), jobs: jobTails(read.raw) });
      }
      const infra = infraReason({ checks: checksList, logs });
      if (infra && runIds.length > 0) {
        const results = await Promise.all(runIds.map((id) => rerunGitHubWorkflowRun({ dir: t.project, runId: id, failedOnly: true })));
        if (results.some((r) => r.ok)) {
          t.rerunAttempted = true;
          t.rerunAttemptedAt = Date.now();
          saveTrain(t);
          for (const m of t.members) {
            recordActivity(m.taskId, {
              kind: "auto",
              text: `CI failed on merge train #${t.pr}, but looks like a runner/infrastructure issue (${infra}) — re-ran failed jobs once before disbanding`,
              tone: "info",
              url: t.url,
            });
          }
          return "waiting";
        }
      }
    }

    await disband(t, "its CI failed", prs, true);
    return "disbanded";
  }
  if (state !== "success") return "waiting";
  const m = await getGitHubPullMergeability({ dir: t.project, number: t.pr });
  if (!m.ok) return "waiting";
  if (m.mergeable === false || m.mergeableState === "dirty") {
    await disband(t, `it conflicts with \`${t.base}\``, prs);
    return "disbanded";
  }
  if (m.mergeableState !== "clean" && m.mergeableState !== "has_hooks") return "waiting";
  const merged = await mergeGitHubPull({ dir: t.project, number: t.pr, method: "merge" });
  if (!merged.ok) {
    await disband(t, `GitHub refused the merge: ${merged.error}`, prs);
    return "disbanded";
  }
  await land(t);
  return "landed";
}

/** A card's merge-train badge, for decorating API responses. */
export function trainFor(taskId: string, train: Train | null = activeTrain(), via = mergedViaTrain()): Task["mergeTrain"] | undefined {
  if (train?.members.some((m) => m.taskId === taskId)) return { pr: train.pr, url: train.url, state: "riding" };
  const v = via[taskId];
  return v ? { pr: v.pr, url: v.url, state: "merged" } : undefined;
}
