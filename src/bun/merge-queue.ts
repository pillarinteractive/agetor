/**
 * Ready to Merge: the user's sign-off. Dragging a card into that column says
 * "this change is approved — get it green and merge it". Every minute, for
 * each signed-off card, the watcher takes the one next step its PR needs:
 *
 *   no PR yet               → run the "Open PR" follow-up (pipelines)
 *   conflicts with the base → run a "Resolve conflicts" follow-up
 *   behind the base         → update the branch (GitHub "Update branch")
 *   its own CI failing      → run Fix CI
 *   unresolved review       → run Address review
 *   checks pending          → wait
 *   green and mergeable     → squash-merge (the repo's convention; pref
 *                             `merge_method` overrides)
 *
 * Each automatic step is taken at most once per PR head, and at most
 * {@link MAX_AUTO_STEPS} times per card before it's left for the user. A
 * merged PR moves the card to Done and closes its issue (src/bun/pr-watch.ts).
 * Dragging the card back to In Review (or Backlog) withdraws the sign-off.
 */
import type { Task, TaskPrStatus } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { mergeQueue, setMergeQueued } from "./merge-intent.ts";
import { ownFailures, prAgent, prStatusForTask, PR_FIX_CI_ACTION, PR_REVIEW_ACTION } from "./pr-watch.ts";
import { getGitHubPullMergeability, mergeGitHubPull, updateGitHubPullBranch } from "./github.ts";
import { startFollowUp } from "./pipeline-followups.ts";

export const MERGE_METHOD_PREF = "merge_method";
const TICK_MS = 60_000;
export const MAX_AUTO_STEPS = 4;

export type MergeStep =
  | { kind: "wait"; why: string }
  | { kind: "open-pr" }
  | { kind: "resolve-conflicts" }
  | { kind: "update-branch" }
  | { kind: "fix-ci" }
  | { kind: "address-review" }
  | { kind: "merge" }
  | { kind: "needs-you"; why: string };

/** The one next step for a signed-off card. Pure; exported for tests. */
export function nextMergeStep(
  task: Pick<Task, "column" | "pipelineId" | "pipelineRun">,
  pr: TaskPrStatus | null,
  mergeability: { mergeable: boolean | null; mergeableState: string } | null,
): MergeStep {
  if (task.column === "running") return { kind: "wait", why: "a fix-up step is running" };
  if (task.column === "blocked") return { kind: "wait", why: "blocked — see the card" };
  if (!pr) return task.pipelineId ? { kind: "open-pr" } : { kind: "needs-you", why: "no pull request to merge" };
  if (pr.state === "merged") return { kind: "wait", why: "merged" };
  if (pr.state === "closed") return { kind: "needs-you", why: `PR #${pr.number} was closed without merging` };
  if (pr.draft) return { kind: "needs-you", why: `PR #${pr.number} is a draft` };
  const followUps = !!task.pipelineId;
  if (mergeability?.mergeable === false || mergeability?.mergeableState === "dirty") {
    return followUps ? { kind: "resolve-conflicts" } : { kind: "needs-you", why: `PR #${pr.number} conflicts with ${pr.baseRef ?? "its base"}` };
  }
  if ((pr.behindBy ?? 0) > 0) return { kind: "update-branch" };
  if (pr.checks === "failure") {
    if (ownFailures(pr).length === 0) return { kind: "wait", why: `${pr.baseRef ?? "the base"} is failing the same checks` };
    return followUps ? { kind: "fix-ci" } : { kind: "needs-you", why: `PR #${pr.number} CI failing` };
  }
  if (pr.unresolvedThreads > 0) {
    return followUps ? { kind: "address-review" } : { kind: "needs-you", why: `PR #${pr.number} has review comments` };
  }
  if (pr.checks === "pending" || pr.checks === "none") return { kind: "wait", why: "checks running" };
  if (mergeability && mergeability.mergeableState !== "clean" && mergeability.mergeableState !== "has_hooks") {
    return { kind: "wait", why: `GitHub says ${mergeability.mergeableState}` };
  }
  return { kind: "merge" };
}

const CONFLICTS_REQUEST = (base: string) =>
  `Resolve merge conflicts with ${base}\n\n` +
  `This pull request conflicts with \`origin/${base}\` and the user has signed it off for merging. ` +
  `Merge \`origin/${base}\` into this branch (a merge commit — don't rebase, never push to \`${base}\`), resolve each ` +
  "conflict keeping both sides' intent, run the project's verification for what changed, commit and push the branch. " +
  'If a conflict can\'t be resolved without a product decision, hand off as blocked and say which. Otherwise hand off with "next": null.';

/** Steps already taken: `<taskId>:<step>:<headSha>` — one try per head. */
const taken = new Set<string>();
const stepCounts = new Map<string, number>();
const lastNote = new Map<string, string>();

function note(task: Task, text: string, tone: "info" | "success" | "warning" | "danger" | "muted" = "info"): void {
  if (lastNote.get(task.id) === text) return;
  lastNote.set(task.id, text);
  recordActivity(task.id, { kind: "auto", text, tone });
}

async function take(task: Task, pr: TaskPrStatus | null, step: MergeStep): Promise<void> {
  if (step.kind === "wait") return;
  if (step.kind === "needs-you") {
    note(task, `Can't merge yet: ${step.why}`, "warning");
    return;
  }
  const key = `${task.id}:${step.kind}:${pr?.headSha ?? task.pipelineRun?.stepCount ?? ""}`;
  if (taken.has(key)) return;
  const count = stepCounts.get(task.id) ?? 0;
  if (step.kind !== "merge" && step.kind !== "update-branch" && count >= MAX_AUTO_STEPS) {
    note(task, `Left for you: ${MAX_AUTO_STEPS} automatic fix-ups didn't get PR #${pr?.number ?? "?"} green`, "danger");
    return;
  }
  taken.add(key);
  const base = pr?.baseRef ?? "develop";
  switch (step.kind) {
    case "open-pr": {
      stepCounts.set(task.id, count + 1);
      const r = await startFollowUp(task.id, { presetId: "pr" });
      note(task, "error" in r ? `Couldn't open a PR: ${r.error}` : "Opening a PR so it can merge", "error" in r ? "warning" : "info");
      return;
    }
    case "resolve-conflicts": {
      stepCounts.set(task.id, count + 1);
      const agent = prAgent();
      const r = agent.id
        ? await startFollowUp(task.id, { profileId: agent.id, request: CONFLICTS_REQUEST(base) })
        : { error: `agent "${agent.name}" not found` };
      note(task, "error" in r ? `Couldn't start resolving conflicts: ${r.error}` : `Resolving conflicts with ${base}`, "error" in r ? "warning" : "info");
      return;
    }
    case "update-branch": {
      const r = await updateGitHubPullBranch({ dir: task.workdir, number: pr!.number });
      note(task, r.ok ? `Updated PR #${pr!.number} from ${base} before merging` : `Couldn't update PR #${pr!.number} from ${base}: ${r.error}`, r.ok ? "info" : "warning");
      return;
    }
    case "fix-ci":
    case "address-review": {
      stepCounts.set(task.id, count + 1);
      const presetId = step.kind === "fix-ci" ? PR_FIX_CI_ACTION : PR_REVIEW_ACTION;
      const r = await startFollowUp(task.id, { presetId });
      const what = step.kind === "fix-ci" ? "Fixing CI" : "Addressing review comments";
      note(task, "error" in r ? `Couldn't start ${what.toLowerCase()}: ${r.error}` : `${what} before merging`, "error" in r ? "warning" : "info");
      return;
    }
    case "merge": {
      const method = (preferences.get(MERGE_METHOD_PREF) as "squash" | "merge" | "rebase" | null) ?? "squash";
      const r = await mergeGitHubPull({ dir: task.workdir, number: pr!.number, method });
      note(task, r.ok ? `Merged PR #${pr!.number} into ${base}` : `Couldn't merge PR #${pr!.number}: ${r.error}`, r.ok ? "success" : "warning");
      return;
    }
  }
}

/** One pass. Exported for tests. */
export async function mergeQueueTick(): Promise<void> {
  const list = tasks.list();
  // The column is the user's say: in Ready to Merge → signed off; dragged
  // back to In Review / Backlog → withdrawn. Running/Blocked/Done keep it
  // (a fix-up step is working on it, or it merged).
  for (const t of list) {
    if (t.pipelineParentId) continue;
    if (t.column === "merge" && t.archivedAt == null) setMergeQueued(t.id, true);
  }
  for (const id of mergeQueue()) {
    const t = list.find((x) => x.id === id);
    if (!t || t.archivedAt != null || t.column === "done" || t.column === "review" || t.column === "backlog" || t.column === "ready") {
      setMergeQueued(id, false);
      if (t && (t.column === "review" || t.column === "backlog")) note(t, "Sign-off withdrawn — moved out of Ready to Merge", "muted");
      continue;
    }
    const pr = prStatusForTask(id);
    let mergeability: { mergeable: boolean | null; mergeableState: string } | null = null;
    if (pr?.state === "open" && t.column === "merge") {
      const m = await getGitHubPullMergeability({ dir: t.workdir, number: pr.number }).catch(() => null);
      if (m && m.ok) mergeability = { mergeable: m.mergeable, mergeableState: m.mergeableState };
    }
    const step = nextMergeStep(t, pr, mergeability);
    await take(t, pr, step).catch((e: Error) => note(t, `Merge queue error: ${e.message}`, "warning"));
  }
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startMergeQueueLoop(): void {
  if (loop) return;
  loop = setInterval(() => void mergeQueueTick().catch(() => undefined), TICK_MS);
  loop.unref?.();
}
