/**
 * Merge trains: several signed-off PRs merged as one batch, so CI runs once on
 * the combined change (and once on develop) instead of once per PR.
 *
 * When two or more Ready to Merge cards in the same project are green and
 * mergeable (behind the base is fine — the train is built on the latest base),
 * and the oldest has waited `windowMin` (or `max` are ready), Agetor:
 *
 *   1. builds `agetor/merge-train-<id>` from `origin/<base>`, adding each PR as
 *      ONE squashed commit "<PR title> (#n)" — a PR that conflicts drops out
 *      and merges on its own;
 *   2. pushes it and opens one PR, "Merge train: #a, #b, #c";
 *   3. when that PR is green, merges it with the REBASE method — develop gets
 *      one commit per original PR (the squash convention) in one push;
 *   4. closes each original PR ("Merged in merge train #T"), moves its card to
 *      Done and closes its issue.
 *
 * If the train's CI fails (or a member changes, or it conflicts), the train is
 * disbanded: its PR closed, its members merged one by one as before.
 *
 * State lives in preferences (`merge_train_state`, `merged_via_train`); config
 * in `merge_train` = {"enabled": true, "windowMin": 10, "max": 6}.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Task, TaskPrStatus } from "../shared/types.ts";
import { dataDir, preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { closeGitHubPull, createGitHubPull, getGitHubPullChecks, getGitHubPullMergeability, mergeGitHubPull, run } from "./github.ts";
import { closeIssueForTask, rollUpChecks } from "./pr-watch.ts";
import { moveMergedTaskToDone } from "./orchestrator.ts";
import { setMergeQueued } from "./merge-intent.ts";

export const MERGE_TRAIN_PREF = "merge_train";
const STATE_PREF = "merge_train_state";
const VIA_PREF = "merged_via_train";

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

/** Should these ready cards leave now as a train? Pure. */
export function shouldDepart(readySince: number[], cfg: TrainConfig, now: number): boolean {
  if (!cfg.enabled || readySince.length < 2) return false;
  return readySince.length >= cfg.max || now - Math.min(...readySince) >= cfg.windowMin * 60_000;
}

export function trainTitle(members: Pick<TrainMember, "pr">[]): string {
  return `Merge train: ${members.map((m) => `#${m.pr}`).join(", ")}`;
}

export function trainBody(members: Pick<TrainMember, "pr" | "title">[], base: string): string {
  return [
    `Merges ${members.length} signed-off pull requests into \`${base}\` as one batch, so CI runs once for all of them.`,
    "",
    ...members.map((m) => `- #${m.pr} — ${m.title}`),
    "",
    `Each PR is one squashed commit here, \`<title> (#n)\`. Agetor merges this PR with **rebase**, so \`${base}\` keeps one commit per PR, then closes the originals with a link back here and closes their issues.`,
    "",
    "If CI fails, Agetor closes this train and merges the PRs one at a time instead.",
  ].join("\n");
}

const git = (args: string[], cwd?: string, timeoutMs = 120_000) => run(["git", ...args], cwd, timeoutMs, process.env);

async function prTitle(dir: string, n: number, fallback: string): Promise<string> {
  const r = await run(["gh", "pr", "view", String(n), "--json", "title", "-q", ".title"], dir, 20_000, process.env);
  return r.ok && r.stdout ? r.stdout : fallback;
}

/** Build, push and open a train for `ready` (all one project + base). Returns
 *  the train, or null when fewer than two PRs survived the squash. */
export async function buildTrain(ready: { task: Task; pr: TaskPrStatus }[]): Promise<Train | null> {
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
  const { members, dropped } = await assembleTrain(project, base, branch, dir, candidates);
  for (const d of dropped) {
    recordActivity(d.member.taskId, { kind: "auto", text: `Left out of a merge train (${d.why}) — merging on its own`, tone: "muted" });
  }
  if (members.length < 2) {
    await git(["push", "--quiet", "--no-verify", "origin", "--delete", branch], project);
    return null;
  }
  const opened = await createGitHubPull({ dir: project, title: trainTitle(members), head: branch, base, body: trainBody(members, base) });
  if (!opened.ok) {
    await git(["push", "--quiet", "--no-verify", "origin", "--delete", branch], project);
    return null;
  }
  const train: Train = { id, project, base, branch, pr: opened.item.number, url: opened.item.htmlUrl, members, createdAt: Date.now() };
  saveTrain(train);
  for (const m of members) {
    // Its own CI is now redundant — free the runners for the train's run.
    const cancelled = await cancelBranchRuns(project, m.branch).catch(() => 0);
    recordActivity(m.taskId, {
      kind: "auto",
      text: `Joined merge train #${train.pr} with ${members.length - 1} other PR(s)${cancelled ? ` — cancelled ${cancelled} pending CI run(s) of its own so the train goes first` : ""}`,
      tone: "info",
      url: train.url,
    });
  }
  return train;
}

/**
 * The git half of building a train: a branch from `origin/<base>` with each
 * candidate squashed into ONE commit "<title> (#n)", in order. A candidate
 * that conflicts with what's already on the train, or adds nothing, is
 * dropped. Pushes the branch when two or more made it. Exported for tests.
 */
export async function assembleTrain(
  project: string,
  base: string,
  branch: string,
  dir: string,
  candidates: TrainMember[],
): Promise<{ members: TrainMember[]; dropped: { member: TrainMember; why: string }[] }> {
  await git(["fetch", "--quiet", "origin", base, ...candidates.map((c) => c.branch)], project);
  const added = await git(["worktree", "add", "--quiet", "-B", branch, dir, `origin/${base}`], project);
  if (!added.ok) return { members: [], dropped: candidates.map((member) => ({ member, why: `couldn't prepare the train: ${added.stderr}` })) };
  const members: TrainMember[] = [];
  const dropped: { member: TrainMember; why: string }[] = [];
  try {
    for (const c of candidates) {
      const squashed = await git(["merge", "--squash", `origin/${c.branch}`], dir);
      const nothingStaged = (await git(["diff", "--cached", "--quiet"], dir)).ok;
      if (!squashed.ok || nothingStaged) {
        await git(["reset", "--hard", "--quiet", "HEAD"], dir);
        dropped.push({ member: c, why: squashed.ok ? "no changes against the base" : "conflicts with the other PRs" });
        continue;
      }
      const committed = await git(["commit", "--quiet", "-m", `${c.title} (#${c.pr})`, "-m", `Squashed from #${c.pr} in a merge train.`], dir);
      if (!committed.ok) {
        await git(["reset", "--hard", "--quiet", "HEAD"], dir);
        dropped.push({ member: c, why: `commit failed: ${committed.stderr}` });
        continue;
      }
      // The head actually squashed in — the cached PR status can lag a push
      // made moments ago (an "update branch" from the merge queue), and a
      // stale head would read as new commits and disband the train.
      const head = await git(["rev-parse", `origin/${c.branch}`], dir);
      members.push(head.ok && head.stdout.trim() ? { ...c, headSha: head.stdout.trim() } : c);
    }
    if (members.length >= 2) {
      // --no-verify: the repo's pre-push hook (lint, vet, tests) re-checks
      // changes each PR's CI already passed, and can fail on the machine's
      // load; the train's own CI is the check that counts.
      const pushed = await git(["push", "--quiet", "--no-verify", "-u", "origin", branch], dir);
      if (!pushed.ok) return { members: [], dropped: [...dropped, ...members.map((member) => ({ member, why: `push failed: ${pushed.stderr}` }))] };
    }
  } finally {
    await git(["worktree", "remove", "--force", dir], project);
    await git(["branch", "-D", branch], project);
  }
  return { members, dropped };
}

/** Members of a disbanded train merge one at a time — remembered per PR head,
 *  so a fresh push can ride a later train. */
const trainSkip = new Set<string>();
export function skipsTrain(pr: TaskPrStatus): boolean {
  return trainSkip.has(`${pr.number}:${pr.headSha ?? ""}`);
}

/**
 * Cancel queued and running CI on `branch`. A train's run checks its members'
 * changes combined, so their own pending runs only hold runners the train is
 * waiting for (runners serve the oldest run first); a replaced or disbanded
 * train's run is just as dead. Best-effort; returns how many were cancelled.
 */
export async function cancelBranchRuns(dir: string, branch: string): Promise<number> {
  let n = 0;
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    const list = await run(
      ["gh", "api", `repos/{owner}/{repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=${status}&per_page=50`, "-q", ".workflow_runs[].id"],
      dir,
      20_000,
      process.env,
    );
    if (!list.ok) continue;
    for (const id of list.stdout.split("\n").filter(Boolean)) {
      const r = await run(["gh", "api", "-X", "POST", `repos/{owner}/{repo}/actions/runs/${id}/cancel`], dir, 20_000, process.env);
      if (r.ok) n++;
      stuck.add(`${dir}\0${id}`);
    }
  }
  return n;
}

/** Runs we've asked to cancel. A run whose remaining job is still waiting
 *  for a self-hosted runner can sit in "queued" after a cancel — GitHub only
 *  finishes the cancel once a runner picks the job up — so on the next pass
 *  those get a force-cancel. */
const stuck = new Set<string>();

export async function forceCancelStuck(): Promise<number> {
  let n = 0;
  for (const key of [...stuck]) {
    const [dir, id] = key.split("\0") as [string, string];
    const state = await run(["gh", "api", `repos/{owner}/{repo}/actions/runs/${id}`, "-q", ".status"], dir, 20_000, process.env);
    if (!state.ok || state.stdout === "completed") {
      stuck.delete(key);
      continue;
    }
    const r = await run(["gh", "api", "-X", "POST", `repos/{owner}/{repo}/actions/runs/${id}/force-cancel`], dir, 20_000, process.env);
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

async function disband(t: Train, why: string, prs: Map<string, TaskPrStatus | null>): Promise<void> {
  await closeGitHubPull({ dir: t.project, number: t.pr, comment: `Disbanding this merge train: ${why}. Agetor merges these PRs one at a time instead.` });
  await cancelBranchRuns(t.project, t.branch).catch(() => 0);
  await git(["push", "--quiet", "--no-verify", "origin", "--delete", t.branch], t.project);
  for (const m of t.members) {
    const pr = prs.get(m.taskId);
    trainSkip.add(`${m.pr}:${pr?.headSha ?? m.headSha ?? ""}`);
    recordActivity(m.taskId, { kind: "auto", text: `Merge train #${t.pr} disbanded (${why}) — merging on its own`, tone: "warning", url: t.url });
  }
  clearTrain(t.id);
}

async function trainPrState(t: Train): Promise<string | null> {
  const r = await run(["gh", "pr", "view", String(t.pr), "--json", "state", "-q", ".state"], t.project, 20_000, process.env);
  return r.ok ? r.stdout.trim() : null;
}

async function land(t: Train): Promise<void> {
  const via = mergedViaTrain();
  for (const m of t.members) {
    await closeGitHubPull({ dir: t.project, number: m.pr, comment: `Merged in merge train #${t.pr} (${t.url}) as one commit on \`${t.base}\`.` });
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
  // pending on their branches (a late push, a re-run), and force-cancel runs a
  // plain cancel left stuck in the queue.
  await forceCancelStuck().catch(() => 0);
  for (const m of t.members) await cancelBranchRuns(t.project, m.branch).catch(() => 0);
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
    await disband(t, "its CI failed", prs);
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
  const merged = await mergeGitHubPull({ dir: t.project, number: t.pr, method: "rebase" });
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
