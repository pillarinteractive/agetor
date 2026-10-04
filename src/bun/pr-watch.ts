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
import { run as run_, findGitHubPullForBranch, getGitHubCompare, getGitHubPullChecks, getGitHubPullReviewThreads, createGitHubComment, getGitHubIssueThread, getGitHubRefCheckRuns, updateGitHubIssue, updateGitHubPullBranch } from "./github.ts";
import { runPipelineFollowUp } from "./pipeline-runner.ts";
import { parseIssueUrl } from "../shared/issue-task.ts";
import { recordActivity, recordActivityOnce } from "./activity.ts";
import { isTaskRunLive, moveMergedTaskToDone, publishGlobalEvent } from "./orchestrator.ts";

const PR_WATCH_INTERVAL_MS = 60_000;
/** Agent that runs the PR follow-ups; `pr_followup_agent` overrides it. */
export const PR_FOLLOWUP_AGENT_PREF = "pr_followup_agent";
const DEFAULT_PR_FOLLOWUP_AGENT = "Builder";
const WATCHED_COLUMNS = new Set(["running", "blocked", "review", "merge", "done"]);
/** "true" starts Fix CI on its own when a PR's own checks fail. */
/** "true" / "false"; unset = on for pipeline cards (a pipeline owns its PR
 *  until it merges), off for plain tasks. */
export const PR_AUTOFIX_PREF = "pr_autofix";
/** "false" turns off updating a PR's branch from its base automatically. */
export const PR_AUTOUPDATE_PREF = "pr_autoupdate";

export function autoFixEnabled(task: Task, pref: string | null | undefined): boolean {
  if (pref === "true") return true;
  if (pref === "false") return false;
  return !!task.pipelineId;
}
/** JSON map "<taskId>#<pr>" → { count, lastSha }: auto Fix CI bookkeeping. */
const PR_AUTOFIX_ATTEMPTS_PREF = "pr_autofix_attempts";
export const PR_AUTOFIX_MAX_ATTEMPTS = 2;

const statuses = new Map<string, TaskPrStatus>();
let loop: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function listPrStatuses(): TaskPrStatus[] {
  return [...statuses.values()];
}

export function prStatusForTask(taskId: string): TaskPrStatus | null {
  return statuses.get(taskId) ?? null;
}

/** Done cards already looked up once since startup — so a Done card whose PR
 *  merged before a restart (or that never had one) is asked about once, not
 *  every tick. */
const checkedDone = new Set<string>();

/** Tasks worth a GitHub round-trip: live board cards (never a pipeline's
 *  hidden step rows, which share their parent's branch) with a branch, in a
 *  column where a PR can exist. A card in Done is looked up once (so a PR
 *  merged before a restart shows as merged, not as its last CI run), then
 *  only followed while its PR is still open. */
export function tasksToWatch(
  list: Task[],
  known: ReadonlyMap<string, TaskPrStatus>,
  doneChecked: ReadonlySet<string> = checkedDone,
): Task[] {
  return list.filter((t) => {
    if (t.archivedAt != null || t.pipelineParentId || !t.branch) return false;
    if (!WATCHED_COLUMNS.has(t.column)) return false;
    const prev = known.get(t.id);
    if (t.column === "done") return prev ? prev.state === "open" : !doneChecked.has(t.id);
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
    .map((r) => ({ name: r.name, url: r.htmlUrl, alsoOnBase: false }));
  if (failing.length > 0) return { checks: "failure", failing };
  if (runs.some((r) => r.status !== "completed")) return { checks: "pending", failing: [] };
  return { checks: "success", failing: [] };
}

/** Flag each PR failure that also fails on the base branch's tip. */
export function markInherited(
  pr: TaskPrStatus["failingChecks"],
  base: TaskPrStatus["failingChecks"],
  passingOnBase: string[] = [],
): TaskPrStatus["failingChecks"] {
  const onBase = new Set(base.map((b) => b.name));
  const passes = new Set(passingOnBase);
  return pr.map((f) => ({ ...f, alsoOnBase: onBase.has(f.name), passesOnBase: passes.has(f.name) }));
}

/** The PR is behind its base and some of its failures pass on the base now
 *  — the base probably fixed them; updating the branch is the move, not a
 *  fix on the PR. */
export function staleAgainstBase(pr: TaskPrStatus | null): boolean {
  return !!pr && (pr.behindBy ?? 0) > 0 && pr.failingChecks.some((f) => f.passesOnBase && !ROLLUP_CHECKS.has(f.name));
}

/** The failures the PR itself caused — the ones worth fixing on its branch.
 *  A rollup check (e.g. "required", which fails whenever any suite does) is
 *  only "own" when some real suite failure is. */
export function ownFailures(pr: TaskPrStatus | null): TaskPrStatus["failingChecks"] {
  const behind = (pr?.behindBy ?? 0) > 0;
  return (pr?.failingChecks ?? []).filter(
    (f) => !f.alsoOnBase && !ROLLUP_CHECKS.has(f.name) && !(behind && f.passesOnBase),
  );
}

/** Aggregate checks that fail whenever any suite does — never a cause. */
const ROLLUP_CHECKS = new Set(["required"]);

function same(a: TaskPrStatus | undefined, b: TaskPrStatus): boolean {
  return (
    !!a &&
    a.number === b.number &&
    a.state === b.state &&
    a.draft === b.draft &&
    a.checks === b.checks &&
    a.unresolvedThreads === b.unresolvedThreads &&
    (a.behindBy ?? null) === (b.behindBy ?? null) &&
    a.failingChecks.map((f) => `${f.name}:${f.alsoOnBase}:${f.passesOnBase}`).join("\n") ===
      b.failingChecks.map((f) => `${f.name}:${f.alsoOnBase}:${f.passesOnBase}`).join("\n")
  );
}

/** Runs already given an automatic Open PR (`<taskId>:<run.endedAt>`). */
const openPrStarted = new Set<string>();

/**
 * In Review always has a PR. A pipeline that finished with commits on its
 * branch but no PR (its last step verified and stopped, or a PR step was
 * skipped) gets the "Open PR" follow-up started automatically — once per run.
 * Only after GitHub confirmed there's no PR, and only when the branch has
 * commits beyond its base (a "not a bug" report has nothing to ship).
 */
async function maybeOpenMissingPr(task: Task): Promise<void> {
  const run = task.pipelineRun;
  if (!run || run.status !== "done" || task.column !== "review" || !hasConfirmedNoPr(task.id)) return;
  const key = `${task.id}:${run.endedAt ?? run.stepCount}`;
  if (openPrStarted.has(key)) return;
  const checkout = task.worktreePath;
  if (!checkout || !task.baseRef) return;
  const ahead = await run_(["git", "rev-list", "--count", `${task.baseRef}..HEAD`], checkout);
  if (!ahead.ok || Number(ahead.stdout) <= 0) return;
  openPrStarted.add(key);
  const { startFollowUp } = await import("./pipeline-followups.ts");
  const r = await startFollowUp(task.id, { presetId: "pr" });
  recordActivity(task.id, {
    kind: "auto",
    text: "error" in r ? `Finished without a PR, and couldn't open one: ${r.error}` : "Finished without a PR — opening one",
    tone: "error" in r ? "warning" : "info",
  });
}

/** Cards whose branch GitHub confirmed has no PR (a successful lookup that
 *  came back empty). "No status" alone can also mean the lookup failed — no
 *  token, offline — and must never be taken as "open a PR". */
const confirmedNoPr = new Set<string>();

export function hasConfirmedNoPr(taskId: string): boolean {
  return confirmedNoPr.has(taskId) && !statuses.has(taskId);
}

async function probe(task: Task): Promise<TaskPrStatus | null> {
  const dir = task.workdir;
  const found = await findGitHubPullForBranch({ dir, branch: task.branch! });
  if (!found.ok) {
    confirmedNoPr.delete(task.id);
    throw new Error(found.error); // keep the last status; try again next tick
  }
  if (!found.pull) {
    confirmedNoPr.add(task.id);
    return null;
  }
  confirmedNoPr.delete(task.id);
  const pull = found.pull;
  const state: TaskPrStatus["state"] = pull.mergedAt ? "merged" : pull.state;
  let checks: TaskPrStatus["checks"] = "none";
  let failingChecks: TaskPrStatus["failingChecks"] = [];
  let unresolvedThreads = 0;
  let behindBy: number | null = null;
  if (state === "open") {
    const runs = await getGitHubPullChecks({ dir, number: pull.number });
    if (runs.ok) ({ checks, failing: failingChecks } = rollUpChecks(runs.checkRuns));
    if (failingChecks.length > 0 && pull.baseRef) {
      const base = await getGitHubRefCheckRuns({ dir, ref: pull.baseRef });
      if (base.ok) {
        const passing = base.checkRuns.filter((r) => r.status === "completed" && r.conclusion === "success").map((r) => r.name);
        failingChecks = markInherited(failingChecks, rollUpChecks(base.checkRuns).failing, passing);
      }
    }
    if (pull.baseRef && pull.headSha) {
      const cmp = await getGitHubCompare({ dir, base: pull.baseRef, head: pull.headSha });
      if (cmp.ok) behindBy = cmp.behindBy;
    }
    const threads = await getGitHubPullReviewThreads({ dir, number: pull.number });
    if (threads.ok) unresolvedThreads = threads.threads.filter((t) => !t.isResolved && !t.isOutdated).length;
  }
  return {
    taskId: task.id,
    number: pull.number,
    url: pull.htmlUrl,
    state,
    draft: pull.draft,
    baseRef: pull.baseRef,
    headSha: pull.headSha,
    behindBy,
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
      if (task.column === "done") checkedDone.add(task.id);
      if (!next) {
        await maybeOpenMissingPr(task);
        continue;
      }
      const prev = statuses.get(task.id);
      statuses.set(task.id, next);
      // First sight after a restart re-derives "opened"/"merged"; don't log them twice.
      for (const e of prActivity(prev, next)) (prev ? recordActivity : recordActivityOnce)(task.id, e);
      if (!task.prUrl && next.url) tasks.update(task.id, { prUrl: next.url });
      if (next.state === "merged" && prev?.state !== "merged" && canMoveToDone(task)) moveMergedTaskToDone(task.id);
      if (next.state === "merged") await closeIssueForMergedPr(task, next);
      if (!same(prev, next)) changed = true;
      await maybeAutoUpdateBranch(task, next);
      await maybeAutoFix(task, next);
    }
  } finally {
    inFlight = false;
  }
  if (changed) publishGlobalEvent({ kind: "prs", prs: listPrStatuses(), ts: Date.now() });
}

/** Timeline entries for what changed between two observations of a PR.
 *  Exported for tests. */
export function prActivity(
  prev: TaskPrStatus | undefined,
  next: TaskPrStatus,
): { kind: "pr" | "ci" | "review"; text: string; tone: "muted" | "info" | "success" | "warning" | "danger"; url?: string }[] {
  const out: ReturnType<typeof prActivity> = [];
  const n = `PR #${next.number}`;
  if (!prev || prev.number !== next.number) out.push({ kind: "pr", text: `${n} opened`, tone: "info", url: next.url });
  if (next.state === "merged" && prev?.state !== "merged") out.push({ kind: "pr", text: `${n} merged`, tone: "success", url: next.url });
  else if (next.state === "closed" && prev?.state !== "closed") out.push({ kind: "pr", text: `${n} closed without merging`, tone: "muted", url: next.url });
  if (next.state !== "open") return out;
  const failingKey = (p: TaskPrStatus | undefined) => (p?.failingChecks ?? []).map((f) => f.name).sort().join("\n");
  if (next.checks === "failure" && (prev?.checks !== "failure" || failingKey(prev) !== failingKey(next))) {
    const own = ownFailures(next).map((f) => f.name);
    const inherited = next.failingChecks.filter((f) => f.alsoOnBase).map((f) => f.name);
    const text = own.length
      ? `CI failing: ${own.join(", ")}${inherited.length ? ` (also inherited from ${next.baseRef ?? "base"}: ${inherited.join(", ")})` : ""}`
      : `CI failing, but only on checks that also fail on ${next.baseRef ?? "base"}: ${inherited.join(", ")}`;
    out.push({ kind: "ci", text, tone: own.length ? "danger" : "warning", url: next.url });
  } else if (next.checks === "success" && prev?.checks !== "success") {
    out.push({ kind: "ci", text: "CI passed", tone: "success", url: next.url });
  }
  const before = prev?.unresolvedThreads ?? 0;
  if (next.unresolvedThreads > before) {
    out.push({ kind: "review", text: `${next.unresolvedThreads} review comment${next.unresolvedThreads === 1 ? "" : "s"} to address`, tone: "warning", url: next.url });
  } else if (before > 0 && next.unresolvedThreads === 0) {
    out.push({ kind: "review", text: "Review comments resolved", tone: "success", url: next.url });
  }
  return out;
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
  checkedDone.clear();
  confirmedNoPr.clear();
  openPrStarted.clear();
  inFlight = false;
}

/** Can a follow-up run on this card right now: a finished run, or a blocked
 *  one with nothing still live. */
export function followUpReady(task: Task, isLive: (taskId: string) => boolean = isTaskRunLive): boolean {
  const run = task.pipelineRun;
  if (!run || !run.snapshot) return false;
  if (run.status === "done") return true;
  return run.status === "blocked" && run.active.every((a) => !isLive(a.taskId));
}

type AutoFixLedger = Record<string, { count: number; lastSha: string | null }>;

function readLedger(): AutoFixLedger {
  try {
    const v = JSON.parse(preferences.get(PR_AUTOFIX_ATTEMPTS_PREF) ?? "{}");
    return v && typeof v === "object" ? (v as AutoFixLedger) : {};
  } catch {
    return {};
  }
}

/** Whether auto Fix CI should start for this PR now: on, the PR's own
 *  checks fail, the card can take a follow-up, this commit wasn't already
 *  tried, and the attempt cap isn't reached. Exported for tests. */
export function shouldAutoFix(
  task: Task,
  pr: TaskPrStatus,
  opts: { enabled: boolean; ledger: AutoFixLedger; isLive?: (taskId: string) => boolean },
): boolean {
  if (!opts.enabled || pr.state !== "open" || pr.checks !== "failure") return false;
  if (ownFailures(pr).length === 0) return false;
  if (!followUpReady(task, opts.isLive)) return false;
  const entry = opts.ledger[`${task.id}#${pr.number}`];
  if (entry && (entry.count >= PR_AUTOFIX_MAX_ATTEMPTS || (pr.headSha && entry.lastSha === pr.headSha))) return false;
  return true;
}

/** Issues this watcher already closed (issue URLs) — so a restart, or the
 *  same PR seen again, never closes or comments twice. */
const CLOSED_ISSUES_PREF = "closed_issues";

/** The issue a card fixes: its own issue link, else a "Fixes #N" line in its
 *  prompt (cards made from an issue carry both). Pure; exported for tests. */
export function issueNumberForTask(task: Pick<Task, "issueUrl" | "prompt">): number | null {
  const parsed = parseIssueUrl(task.issueUrl ?? null);
  if (parsed) return parsed.number;
  const m = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i.exec(task.prompt ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * GitHub only auto-closes "Fixes #N" when the PR merges into the repo's
 * default branch. Pillar's PRs merge into `develop`, so a fixed issue stayed
 * open until a release reached `main`. When a card's PR merges (into any
 * branch), close the issue it fixes, saying which PR and where.
 */
async function closeIssueForMergedPr(task: Task, pr: TaskPrStatus): Promise<void> {
  const number = issueNumberForTask(task);
  if (!number) return;
  const key = task.issueUrl ?? `${task.workdir}#${number}`;
  let done: string[] = [];
  try {
    done = JSON.parse(preferences.get(CLOSED_ISSUES_PREF) ?? "[]");
  } catch {
    done = [];
  }
  if (done.includes(key)) return;
  const remember = () => preferences.set(CLOSED_ISSUES_PREF, JSON.stringify([...done, key].slice(-500)));
  const thread = await getGitHubIssueThread({ dir: task.workdir, number, includeComments: false });
  if (!thread.ok) return; // try again next tick
  if (thread.item.state === "closed") {
    remember();
    return;
  }
  const where = pr.baseRef ? ` into \`${pr.baseRef}\`` : "";
  await createGitHubComment({
    dir: task.workdir,
    number,
    body: `Fixed by #${pr.number}, merged${where}. Closed by Agetor when the PR merged — GitHub only auto-closes on merges into the default branch.`,
  });
  const closed = await updateGitHubIssue({ dir: task.workdir, number, state: "closed" });
  remember();
  recordActivity(task.id, {
    kind: "pr",
    text: closed.ok ? `Closed issue #${number} (fixed by PR #${pr.number})` : `Couldn't close issue #${number}: ${closed.error}`,
    tone: closed.ok ? "success" : "warning",
    url: task.issueUrl ?? undefined,
  });
}

/** PR heads already updated from their base (`<pr>:<headSha>`) — an update
 *  makes a new head, so each stale head is updated once. */
const updatedHeads = new Set<string>();

/** A PR behind its base whose failing checks pass on the base now: merge the
 *  base into its branch (GitHub's "Update branch") so CI re-runs against
 *  what it will merge into. Only when the base has actually moved ahead. */
export function shouldAutoUpdate(pr: TaskPrStatus, opts: { enabled: boolean; done: ReadonlySet<string> }): boolean {
  if (!opts.enabled || pr.state !== "open" || !staleAgainstBase(pr)) return false;
  return !opts.done.has(`${pr.number}:${pr.headSha ?? ""}`);
}

async function maybeAutoUpdateBranch(task: Task, pr: TaskPrStatus): Promise<void> {
  if (!shouldAutoUpdate(pr, { enabled: preferences.get(PR_AUTOUPDATE_PREF) !== "false", done: updatedHeads })) return;
  updatedHeads.add(`${pr.number}:${pr.headSha ?? ""}`);
  const r = await updateGitHubPullBranch({ dir: task.workdir, number: pr.number });
  recordActivity(task.id, {
    kind: "auto",
    text: r.ok
      ? `Updated PR #${pr.number}'s branch from ${pr.baseRef ?? "base"} (${pr.behindBy} behind; its failing checks pass there)`
      : `Couldn't update PR #${pr.number}'s branch from ${pr.baseRef ?? "base"}: ${r.error}`,
    tone: r.ok ? "info" : "warning",
  });
}

async function maybeAutoFix(task: Task, pr: TaskPrStatus): Promise<void> {
  const fresh = tasks.get(task.id);
  if (!fresh) return;
  const ledger = readLedger();
  if (!shouldAutoFix(fresh, pr, { enabled: autoFixEnabled(fresh, preferences.get(PR_AUTOFIX_PREF)), ledger })) return;
  const fix = prFollowUpInstructions(PR_FIX_CI_ACTION, pr);
  const agent = prAgent();
  if (!fix || !agent.id) return;
  const key = `${task.id}#${pr.number}`;
  const count = (ledger[key]?.count ?? 0) + 1;
  ledger[key] = { count, lastSha: pr.headSha };
  preferences.set(PR_AUTOFIX_ATTEMPTS_PREF, JSON.stringify(ledger));
  recordActivity(task.id, { kind: "auto", text: `Started Fix CI automatically (attempt ${count} of ${PR_AUTOFIX_MAX_ATTEMPTS})`, tone: "info" });
  await runPipelineFollowUp(task.id, {
    profileId: agent.id,
    name: `${fix.name} · auto ${count}/${PR_AUTOFIX_MAX_ATTEMPTS}`,
    instructions: fix.instructions,
  });
}

// ---------------------------------------------------------------------------
// Follow-ups built from a PR's state (offered in a finished pipeline's Next box)
// ---------------------------------------------------------------------------

export const PR_FIX_CI_ACTION = "pr:fix-ci";
export const PR_REVIEW_ACTION = "pr:review";

export function prAgent(): { name: string; id: string | null } {
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
  const own = ownFailures(pr);
  if (pr.checks === "failure" && own.length > 0) {
    out.push({
      id: PR_FIX_CI_ACTION,
      label: `Fix CI (#${pr.number})`,
      agentName: agent.name,
      agentId: agent.id,
      requiresRequest: false,
      suggested: true,
      matched: own.map((c) => c.name).slice(0, 3),
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
  const own = ownFailures(pr);
  if (actionId === PR_FIX_CI_ACTION && pr.checks === "failure" && own.length > 0) {
    const list = own.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`).join("\n");
    const inherited = pr.failingChecks.filter((c) => c.alsoOnBase).map((c) => c.name);
    const inheritedNote = inherited.length
      ? `\n\nThese also fail on ${pr.baseRef ?? "the base branch"} and are not this PR's to fix — leave them alone: ${inherited.join(", ")}.`
      : "";
    return {
      name: `Fix CI (#${pr.number})`,
      instructions:
        `CI is failing on pull request #${pr.number} (${pr.url}). Failing checks this PR caused:\n${list}${inheritedNote}\n\n` +
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
