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
import { MERGE_TRAIN_PREF, activeTrain, advanceTrain, buildTrain, manualTrainEligible, parseTrainConfig, replaceTrain, shouldDepart, skipsTrain, trainCiStarted, trainEligible } from "./merge-train.ts";
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { mergeQueue, setMergeQueued } from "./merge-intent.ts";
import { hasConfirmedNoPr, ownFailures, prAgent, prStatusForTask, PR_FIX_CI_ACTION, PR_REVIEW_ACTION, refreshPrsNow } from "./pr-watch.ts";
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
  noPrConfirmed = true,
): MergeStep {
  if (task.column === "running") return { kind: "wait", why: "a fix-up step is running" };
  if (task.column === "blocked") return { kind: "wait", why: "blocked — see the card" };
  if (!pr) {
    // Only when GitHub said there's none — a failed lookup isn't "no PR".
    if (!noPrConfirmed) return { kind: "wait", why: "checking for a PR" };
    return task.pipelineId ? { kind: "open-pr" } : { kind: "needs-you", why: "no pull request to merge" };
  }
  if (pr.state === "merged") return { kind: "wait", why: "merged" };
  if (pr.state === "closed") return { kind: "needs-you", why: `PR #${pr.number} was closed without merging` };
  if (pr.draft) return { kind: "needs-you", why: `PR #${pr.number} is a draft` };
  const followUps = !!task.pipelineId;
  if (mergeability?.mergeable === false || mergeability?.mergeableState === "dirty") {
    return followUps ? { kind: "resolve-conflicts" } : { kind: "needs-you", why: `PR #${pr.number} conflicts with ${pr.baseRef ?? "its base"}` };
  }
  // Bring the base in only when it helps: GitHub requires an up-to-date
  // branch to merge ("behind"), or CI is failing and the base may already
  // carry the fix. A green PR that's merely behind merges as it is (a merge
  // train rebuilds on the latest base anyway) — updating restarts its CI, and
  // with several PRs queued every merge would restart all the others.
  if (mergeability?.mergeableState === "behind") return { kind: "update-branch" };
  if ((pr.behindBy ?? 0) > 0 && pr.checks === "failure") return { kind: "update-branch" };
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
  // Opening a PR is a once-per-card step; the rest once per PR head.
  const key = step.kind === "open-pr" ? `${task.id}:open-pr` : `${task.id}:${step.kind}:${pr?.headSha ?? ""}`;
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
/** When each train-eligible card became ready. Persisted (`merge_ready_since`) so an app restart doesn't restart every
 *  green card's wait for company. */
const READY_SINCE_PREF = "merge_ready_since";
const readySince = new Map<string, number>(
  (() => {
    try {
      const v = JSON.parse(preferences.get(READY_SINCE_PREF) ?? "{}") as Record<string, unknown>;
      return Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number");
    } catch {
      return [];
    }
  })(),
);
function saveReadySince(): void {
  preferences.set(READY_SINCE_PREF, JSON.stringify(Object.fromEntries(readySince)));
}

/** One merge-queue action at a time: the minute tick and the user's "Merge
 *  together" button must never build two trains or merge the same PR twice. */
let busy: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = busy.then(fn, fn);
  busy = next.catch(() => undefined);
  return next;
}

export function mergeQueueTick(now = Date.now()): Promise<void> {
  return exclusive(() => tick(now));
}

/** The Ready to Merge column's refresh button: re-read its cards' PRs from
 *  GitHub now, then take the queue's next steps (including an active train). */
export async function refreshMergeColumn(): Promise<void> {
  await refreshPrsNow("merge");
  await mergeQueueTick();
}

/**
 * The "Merge together" button: send a train now with every signed-off card in
 * Ready to Merge that can go (largest project/base group), without waiting
 * for the window or for each PR's own checks.
 */
export function departTrainNow(): Promise<{ train: { pr: number; url: string; members: number[] } } | { error: string }> {
  return exclusive(async () => {
    // A train that hasn't started CI yet is cheaper to replace than to wait
    // for: close it and send one bigger train (its PRs ride the new one).
    const out = activeTrain();
    if (out) {
      if (await trainCiStarted(out)) {
        return { error: `merge train #${out.pr} is already running CI — it has to land or disband first` };
      }
      await replaceTrain(out);
    }
    const cards = tasks.list().filter((t) => t.column === "merge" && t.archivedAt == null && !t.pipelineParentId && t.branch);
    const ready: { task: Task; pr: TaskPrStatus }[] = [];
    const left: string[] = [];
    for (const t of cards) {
      const pr = prStatusForTask(t.id);
      let mergeability: { mergeable: boolean | null; mergeableState: string } | null = null;
      if (pr?.state === "open") {
        const m = await getGitHubPullMergeability({ dir: t.workdir, number: pr.number }).catch(() => null);
        if (m && m.ok) mergeability = { mergeable: m.mergeable, mergeableState: m.mergeableState };
      }
      if (pr && manualTrainEligible(pr, mergeability)) ready.push({ task: t, pr });
      else left.push(pr ? `#${pr.number}` : t.title.slice(0, 30));
    }
    const groups = new Map<string, typeof ready>();
    for (const r of ready) {
      const key = `${r.task.workdir}\0${r.pr.baseRef ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const group = [...groups.values()].sort((x, y) => y.length - x.length)[0] ?? [];
    if (group.length < 2) {
      return { error: `need at least two PRs that can go together (ready: ${group.length}${left.length ? `; not ready: ${left.join(", ")}` : ""})` };
    }
    const train = await buildTrain(group.slice(0, 12));
    if (!train) return { error: "couldn't build the train — fewer than two PRs merged cleanly together (see the cards' timelines)" };
    for (const m of train.members) readySince.delete(m.taskId);
    return { train: { pr: train.pr, url: train.url, members: train.members.map((m) => m.pr) } };
  });
}

async function tick(now: number): Promise<void> {
  const list = tasks.list();
  // In Ready to Merge → signed off. Withdrawing is the user's own move out
  // of the column (server.ts PATCH); a card the pipeline runner parked in In
  // Review / Blocked / Running while a follow-up step works keeps its
  // sign-off, and comes back to Ready to Merge when the run is done.
  for (const t of list) {
    if (t.pipelineParentId) continue;
    if (t.column === "merge" && t.archivedAt == null) setMergeQueued(t.id, true);
  }
  type Eval = { t: Task; pr: TaskPrStatus | null; mergeability: { mergeable: boolean | null; mergeableState: string } | null; step: MergeStep };
  const evals: Eval[] = [];
  const prs = new Map<string, TaskPrStatus | null>();
  for (const id of mergeQueue()) {
    const t = list.find((x) => x.id === id);
    if (!t || t.archivedAt != null || t.column === "done") {
      setMergeQueued(id, false);
      readySince.delete(id);
      continue;
    }
    // Signed off but parked outside the column while a step works on it:
    // keep the sign-off, take no merge step until it's back.
    if (t.column !== "merge" && t.column !== "running" && t.column !== "blocked") {
      readySince.delete(id);
      continue;
    }
    const pr = prStatusForTask(id);
    prs.set(id, pr);
    let mergeability: Eval["mergeability"] = null;
    if (pr?.state === "open" && t.column === "merge") {
      const m = await getGitHubPullMergeability({ dir: t.workdir, number: pr.number }).catch(() => null);
      if (m && m.ok) mergeability = { mergeable: m.mergeable, mergeableState: m.mergeableState };
    }
    evals.push({ t, pr, mergeability, step: nextMergeStep(t, pr, mergeability, hasConfirmedNoPr(id)) });
  }

  // 1. The train already out: land it when green, disband it when not.
  const out = activeTrain();
  if (out) await advanceTrain(out, prs).catch(() => "waiting");
  const riding = new Set(activeTrain()?.members.map((m) => m.taskId) ?? []);

  // 2. Cards that could ride a train (src/bun/merge-train.ts).
  const cfg = parseTrainConfig(preferences.get(MERGE_TRAIN_PREF));
  const eligible = evals.filter(
    (e) => !riding.has(e.t.id) && e.t.column === "merge" && !!e.t.branch && trainEligible(e.pr, e.mergeability) && !skipsTrain(e.pr!),
  );
  const eligibleIds = new Set(eligible.map((e) => e.t.id));
  for (const id of [...readySince.keys()]) if (!eligibleIds.has(id)) readySince.delete(id);
  for (const e of eligible) if (!readySince.has(e.t.id)) readySince.set(e.t.id, now);
  saveReadySince();
  if (cfg.enabled && !activeTrain()) {
    const groups = new Map<string, Eval[]>();
    for (const e of eligible) {
      const key = `${e.t.workdir}\0${e.pr!.baseRef ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const group = [...groups.values()].sort((x, y) => y.length - x.length)[0] ?? [];
    if (shouldDepart(group.map((e) => readySince.get(e.t.id)!), cfg, now)) {
      const train = await buildTrain(group.slice(0, cfg.max).map((e) => ({ task: e.t, pr: e.pr! }))).catch(() => null);
      for (const m of train?.members ?? []) riding.add(m.taskId);
    }
  }

  // 3. Everyone else takes their own next step. A ready card waits up to the
  //    train window for company before merging alone.
  for (const e of evals) {
    if (riding.has(e.t.id)) continue;
    // A train that landed above moved its members to Done: don't step them.
    if (tasks.get(e.t.id)?.column !== "merge") continue;
    if (cfg.enabled && eligibleIds.has(e.t.id) && (e.step.kind === "merge" || e.step.kind === "update-branch")) {
      // Company = other ready PRs that could share its train (same project and base).
      const others = eligible.filter(
        (x) => x.t.id !== e.t.id && !riding.has(x.t.id) && x.t.workdir === e.t.workdir && x.pr!.baseRef === e.pr!.baseRef,
      ).length;
      const waited = now - (readySince.get(e.t.id) ?? now);
      if (others > 0 || waited < cfg.windowMin * 60_000) {
        note(e.t, `Green — waiting up to ${cfg.windowMin} min to merge together with other PRs`, "muted");
        continue;
      }
    }
    await take(e.t, e.pr, e.step).catch((err: Error) => note(e.t, `Merge queue error: ${err.message}`, "warning"));
  }
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startMergeQueueLoop(): void {
  if (loop) return;
  loop = setInterval(() => void mergeQueueTick().catch(() => undefined), TICK_MS);
  loop.unref?.();
}
