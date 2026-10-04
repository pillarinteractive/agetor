/**
 * PR watcher: follows the pull request of every active task with a branch —
 * including PRs an agent opened itself with `gh pr create`, found by branch —
 * and publishes its state (checks, unresolved review threads, merged) as a
 * `prs` event. The board shows it as a badge; a finished pipeline's Next box
 * offers "Fix CI" / "Address review" follow-ups built from it
 * (`prFollowUpActions`); and a merged PR moves its card to Done.
 *
 * GitHub only (the git-host facade's other providers don't expose the same
 * calls yet). Polls every `PR_WATCH_INTERVAL_MS`; a task stops being watched
 * once it's archived or its PR is closed.
 */
import type { FollowUpAction, Task, TaskPrStatus } from "../shared/types.ts";
import { agentProfiles, preferences, tasks } from "./db.ts";
import { findGitHubPullForBranch, getGitHubPullChecks, getGitHubPullReviewThreads } from "./github.ts";
import { moveMergedTaskToDone, publishGlobalEvent } from "./orchestrator.ts";

const PR_WATCH_INTERVAL_MS = 60_000;
/** Agent that runs the PR follow-ups; `pr_followup_agent` overrides it. */
export const PR_FOLLOWUP_AGENT_PREF = "pr_followup_agent";
const DEFAULT_PR_FOLLOWUP_AGENT = "Builder";
const WATCHED_COLUMNS = new Set(["running", "blocked", "review", "done"]);

const statuses = new Map<string, TaskPrStatus>();
let loop: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function listPrStatuses(): TaskPrStatus[] {
  return [...statuses.values()];
}

export function prStatusForTask(taskId: string): TaskPrStatus | null {
  return statuses.get(taskId) ?? null;
}

/** Tasks worth a GitHub round-trip: live board cards (never a pipeline's
 *  hidden step rows, which share their parent's branch) with a branch, in a
 *  column where a PR can exist. A card in Done is only followed while its
 *  PR is still open, so a merged or abandoned one drops out. */
export function tasksToWatch(list: Task[], known: ReadonlyMap<string, TaskPrStatus>): Task[] {
  return list.filter((t) => {
    if (t.archivedAt != null || t.pipelineParentId || !t.branch) return false;
    if (!WATCHED_COLUMNS.has(t.column)) return false;
    const prev = known.get(t.id);
    if (t.column === "done") return prev?.state === "open";
    return prev?.state !== "merged";
  });
}

/** Roll a PR's check runs up into one state. */
export function rollUpChecks(runs: { name: string; status: string; conclusion: string | null; htmlUrl: string | null }[]): {
  checks: TaskPrStatus["checks"];
  failing: TaskPrStatus["failingChecks"];
} {
  if (runs.length === 0) return { checks: "none", failing: [] };
  const failing = runs
    .filter((r) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion ?? ""))
    .map((r) => ({ name: r.name, url: r.htmlUrl }));
  if (failing.length > 0) return { checks: "failure", failing };
  if (runs.some((r) => r.status !== "completed")) return { checks: "pending", failing: [] };
  return { checks: "success", failing: [] };
}

function same(a: TaskPrStatus | undefined, b: TaskPrStatus): boolean {
  return (
    !!a &&
    a.number === b.number &&
    a.state === b.state &&
    a.draft === b.draft &&
    a.checks === b.checks &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.failingChecks.map((f) => f.name).join("\n") === b.failingChecks.map((f) => f.name).join("\n")
  );
}

async function probe(task: Task): Promise<TaskPrStatus | null> {
  const dir = task.workdir;
  const found = await findGitHubPullForBranch({ dir, branch: task.branch! });
  if (!found.ok || !found.pull) return null;
  const pull = found.pull;
  const state: TaskPrStatus["state"] = pull.mergedAt ? "merged" : pull.state;
  let checks: TaskPrStatus["checks"] = "none";
  let failingChecks: TaskPrStatus["failingChecks"] = [];
  let unresolvedThreads = 0;
  if (state === "open") {
    const runs = await getGitHubPullChecks({ dir, number: pull.number });
    if (runs.ok) ({ checks, failing: failingChecks } = rollUpChecks(runs.checkRuns));
    const threads = await getGitHubPullReviewThreads({ dir, number: pull.number });
    if (threads.ok) unresolvedThreads = threads.threads.filter((t) => !t.isResolved && !t.isOutdated).length;
  }
  return {
    taskId: task.id,
    number: pull.number,
    url: pull.htmlUrl,
    state,
    draft: pull.draft,
    checks,
    failingChecks,
    unresolvedThreads,
    checkedAt: Date.now(),
  };
}

/** One pass over the watched tasks. Exported for tests. */
export async function prWatchTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  let changed = false;
  try {
    const all = tasks.list();
    const live = new Set(all.filter((t) => t.archivedAt == null).map((t) => t.id));
    for (const id of [...statuses.keys()]) {
      if (!live.has(id)) {
        statuses.delete(id);
        changed = true;
      }
    }
    for (const task of tasksToWatch(all, statuses)) {
      let next: TaskPrStatus | null;
      try {
        next = await probe(task);
      } catch {
        continue; // network hiccup: keep the last status, try next tick
      }
      if (!next) continue;
      const prev = statuses.get(task.id);
      statuses.set(task.id, next);
      if (!task.prUrl && next.url) tasks.update(task.id, { prUrl: next.url });
      if (next.state === "merged" && prev?.state !== "merged" && canMoveToDone(task)) moveMergedTaskToDone(task.id);
      if (!same(prev, next)) changed = true;
    }
  } finally {
    inFlight = false;
  }
  if (changed) publishGlobalEvent({ kind: "prs", prs: listPrStatuses(), ts: Date.now() });
}

/** A merged PR finishes the card — unless a pipeline run is still live
 *  (its column belongs to the run until it finishes). */
function canMoveToDone(task: Task): boolean {
  const run = task.pipelineRun;
  return !run || run.status === "done" || run.status === "cancelled";
}

export function startPrWatchLoop(): void {
  if (loop) return;
  void prWatchTick();
  loop = setInterval(() => void prWatchTick(), PR_WATCH_INTERVAL_MS);
  loop.unref?.();
}

export function resetPrWatchForTests(): void {
  if (loop) clearInterval(loop);
  loop = null;
  statuses.clear();
  inFlight = false;
}

// ---------------------------------------------------------------------------
// Follow-ups built from a PR's state (offered in a finished pipeline's Next box)
// ---------------------------------------------------------------------------

export const PR_FIX_CI_ACTION = "pr:fix-ci";
export const PR_REVIEW_ACTION = "pr:review";

function prAgent(): { name: string; id: string | null } {
  const name = preferences.get(PR_FOLLOWUP_AGENT_PREF)?.trim() || DEFAULT_PR_FOLLOWUP_AGENT;
  const id = agentProfiles.list().find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  return { name, id };
}

/** "Fix CI" when the PR's checks failed, "Address review" when it has
 *  unresolved review threads — both suggested, since they're why the PR
 *  can't merge. */
export function prFollowUpActions(pr: TaskPrStatus | null): FollowUpAction[] {
  if (!pr || pr.state !== "open") return [];
  const agent = prAgent();
  const out: FollowUpAction[] = [];
  if (pr.checks === "failure") {
    out.push({
      id: PR_FIX_CI_ACTION,
      label: `Fix CI (#${pr.number})`,
      agentName: agent.name,
      agentId: agent.id,
      requiresRequest: false,
      suggested: true,
      matched: pr.failingChecks.map((c) => c.name).slice(0, 3),
    });
  }
  if (pr.unresolvedThreads > 0) {
    out.push({
      id: PR_REVIEW_ACTION,
      label: `Address review (#${pr.number})`,
      agentName: agent.name,
      agentId: agent.id,
      requiresRequest: false,
      suggested: true,
      matched: [`${pr.unresolvedThreads} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"}`],
    });
  }
  return out;
}

/** Instructions for a PR follow-up, or null when the action no longer
 *  applies (the PR moved on since the button was shown). */
export function prFollowUpInstructions(actionId: string, pr: TaskPrStatus | null): { name: string; instructions: string } | null {
  if (!pr || pr.state !== "open") return null;
  const push =
    "Commit the fixes (conventional commits) and push them to this task's branch so the PR updates — " +
    "never force-push and never push to main or develop. Put the PR URL in the handoff artifacts.";
  if (actionId === PR_FIX_CI_ACTION && pr.checks === "failure") {
    const list = pr.failingChecks.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`).join("\n");
    return {
      name: `Fix CI (#${pr.number})`,
      instructions:
        `CI is failing on pull request #${pr.number} (${pr.url}). Failing checks:\n${list}\n\n` +
        "Read the failing logs (`gh pr checks " + pr.number + "`, `gh run view <run-id> --log-failed`), find the root cause, " +
        "and fix it with the smallest correct change; reproduce locally with the matching verification commands from AGENTS.md. " +
        "If a failure is unrelated to this branch (flaky or infrastructure), say so with evidence instead of changing code. " +
        push,
    };
  }
  if (actionId === PR_REVIEW_ACTION && pr.unresolvedThreads > 0) {
    return {
      name: `Address review (#${pr.number})`,
      instructions:
        `Pull request #${pr.number} (${pr.url}) has ${pr.unresolvedThreads} unresolved review thread(s). ` +
        "Read them (`gh pr view " + pr.number + " --comments`, and `gh api repos/{owner}/{repo}/pulls/" + pr.number + "/comments` " +
        "for line comments). Address each: change the code where the reviewer is right, or reply on the thread explaining why " +
        "not (`gh api` / `gh pr comment`). Don't resolve threads yourself — the reviewer does. Run the relevant verification. " +
        push +
        " In the handoff, list each thread and what you did about it.",
    };
  }
  return null;
}
