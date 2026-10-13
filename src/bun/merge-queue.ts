/**
 * Ready to Merge: the user's sign-off. Dragging a card into that column says
 * "this change is approved — get it green and merge it". Every minute, for
 * each signed-off card, the watcher takes the one next step its PR needs:
 *
 *   no PR yet               → run the "Open PR" follow-up (pipelines)
 *   conflicts with the base → run a "Resolve conflicts" follow-up (*)
 *   behind the base         → update the branch (GitHub "Update branch")
 *   its own CI failing      → run Fix CI (*)
 *   unresolved review       → run Address review
 *   checks pending          → wait
 *   green and mergeable     → squash-merge (the repo's convention; pref
 *                             `merge_method` overrides)
 *
 * (*) A card whose pipeline has Build, Review and Finish steps gets no such
 * follow-up — it would push a fix nobody reviewed. Its sign-off is withdrawn
 * and its run goes back through Build → Review → Finish with the failure as
 * context, then is signed off again the ordinary way (src/bun/merge-rework.ts,
 * which also re-runs a job a runner broke instead of "fixing" it, and holds
 * the card for the owner after `merge_queue_rework.maxRounds` rounds).
 *
 * Being behind the base never starts a fix: a green PR merges as it is or
 * rides a train built on the latest base (whose CI tests the combination),
 * and the branch is updated — a merge of the base made by GitHub, no agent
 * and no edit — only when GitHub requires it or CI is failing on a base that
 * has since fixed it.
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
import { hasConfirmedNoPr, openPrDirectly, ownFailures, prAgent, prStatusForTask, PR_FIX_CI_ACTION, PR_REVIEW_ACTION, refreshPrsNow } from "./pr-watch.ts";
import { getGitHubPullMergeability, mergeGitHubPull, updateGitHubPullBranch, setGitHubPullDraft } from "./github.ts";
import { startFollowUp } from "./pipeline-followups.ts";
import { noteBaseRed, pruneReworkState, reviewedReworkFor, reworkCiFailure, reworkConflict } from "./merge-rework.ts";

export const MERGE_METHOD_PREF = "merge_method";
const TICK_MS = 60_000;
export const MAX_AUTO_STEPS = 4;

export type MergeStep =
  | { kind: "wait"; why: string }
  | { kind: "open-pr" }
  | { kind: "mark-ready" }
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
  /** The card's fixes go back through Build → Review → Finish
   *  (`reviewedReworkFor`): a failure of its own is not worth a CI run on an
   *  updated branch first — Build merges the base as part of the round. */
  reviewed = false,
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
  // A pipeline card reaches Ready to Merge only once its work is approved, so
  // a PR its Build step opened as a draft is ready: say so, don't wait for someone.
  if (pr.draft) return task.pipelineId ? { kind: "mark-ready" } : { kind: "needs-you", why: `PR #${pr.number} is a draft` };
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
  if ((pr.behindBy ?? 0) > 0 && pr.checks === "failure" && !(reviewed && ownFailures(pr).length > 0)) return { kind: "update-branch" };
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
  `This pull request conflicts with \`origin/${base}\`; resolve it so it can be reviewed and merged as it is. ` +
  `Merge \`origin/${base}\` into this branch (a merge commit — don't rebase, never push to \`${base}\`), resolve each ` +
  "conflict keeping both sides' intent, commit and push the branch; CI verifies the result, so don't run whole suites, " +
  "lint, type checks or builds here. You need no permission to push to this task's own branch or to merge the base into it. " +
  "When two sides can't both be kept, take the option you judge best, say which and why in the handoff, and carry on; " +
  'hand off as blocked only when resolving it would discard someone else\'s work you cannot reconstruct. Otherwise hand off with "next": null.';

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
  if (step.kind === "wait") {
    // The base is failing this head's checks: not this card's failure. If the
    // base recovers without a new commit, the jobs are re-run, not "fixed".
    if (pr?.state === "open" && pr.checks === "failure" && ownFailures(pr).length === 0 && reviewedReworkFor(task)) noteBaseRed(task.id, pr.headSha);
    return;
  }
  // A reviewed pipeline's fix goes back through Build → Review → Finish
  // (src/bun/merge-rework.ts keeps its own once-per-head and per-card limits).
  if ((step.kind === "fix-ci" || step.kind === "resolve-conflicts") && pr && reviewedReworkFor(task)) {
    if (step.kind === "fix-ci") await reworkCiFailure(task, pr);
    else await reworkConflict(task, pr);
    return;
  }
  if (step.kind === "needs-you") {
    note(task, `Can't merge yet: ${step.why}`, "warning");
    return;
  }
  // Opening a PR is a once-per-card step; the rest once per PR head.
  const key = step.kind === "open-pr" ? `${task.id}:open-pr` : `${task.id}:${step.kind}:${pr?.headSha ?? ""}`;
  if (taken.has(key)) return;
  const count = stepCounts.get(task.id) ?? 0;
  if (step.kind !== "merge" && step.kind !== "update-branch" && step.kind !== "mark-ready" && count >= MAX_AUTO_STEPS) {
    note(task, `Left for you: ${MAX_AUTO_STEPS} automatic fix-ups didn't get PR #${pr?.number ?? "?"} green`, "danger");
    return;
  }
  taken.add(key);
  const base = pr?.baseRef ?? "develop";
  switch (step.kind) {
    case "open-pr": {
      stepCounts.set(task.id, count + 1);
      if (task.worktreePath) {
        const direct = await openPrDirectly(task, task.worktreePath);
        if (direct.ok) {
          if (direct.url) tasks.update(task.id, { prUrl: direct.url });
          note(task, `Opened PR #${direct.number} so it can merge`, "info");
          return;
        }
      }
      const r = await startFollowUp(task.id, { presetId: "pr" });
      note(task, "error" in r ? `Couldn't open a PR: ${r.error}` : "Opening a PR so it can merge", "error" in r ? "warning" : "info");
      return;
    }
    case "mark-ready": {
      const r = await setGitHubPullDraft({ dir: task.workdir, number: pr!.number, draft: false });
      note(task, r.ok ? `Marked PR #${pr!.number} ready for review so it can merge` : `Couldn't mark PR #${pr!.number} ready: ${r.error}`, r.ok ? "info" : "warning");
      // A failed attempt is tried again on the next pass.
      if (!r.ok) taken.delete(key);
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
    const cards = tasks.listLive().filter((t) => t.column === "merge" && t.archivedAt == null && !t.pipelineParentId && t.branch);
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
  const list = tasks.listLive();
  pruneReworkState(new Set(list.filter((t) => t.archivedAt == null && t.column !== "done").map((t) => t.id)));
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
    evals.push({ t, pr, mergeability, step: nextMergeStep(t, pr, mergeability, hasConfirmedNoPr(id), !!reviewedReworkFor(t)) });
  }

  // A Fix CI step that blocked only because CI hadn't run yet (runners busy)
  // is done once the PR's checks pass: close it out instead of leaving the
  // card blocked (the step itself is told to wait, this is the backstop).
  for (const e of evals) {
    const run = e.t.pipelineRun;
    if (e.t.column !== "blocked" || !run || e.pr?.state !== "open" || e.pr.checks !== "success") continue;
    const names = new Map((run.snapshot?.graph.steps ?? []).map((s) => [s.id, s.name]));
    const block = run.blocked.find((b) => b.taskId && b.kind === "step-blocked" && /^Fix CI/.test(names.get(b.stepId ?? "") ?? ""));
    if (!block?.taskId) continue;
    const { advancePipeline } = await import("./pipeline-runner.ts");
    const r = await advancePipeline(e.t.id, {
      nextStepIds: null,
      fromTaskId: block.taskId,
      handoff: { summary: `CI on PR #${e.pr.number} passed — nothing left to fix (the step had stopped to wait for CI runners).` },
    });
    note(e.t, "error" in r ? `Couldn't close out the waiting Fix CI step: ${r.error}` : `CI on PR #${e.pr.number} passed — closed out the Fix CI step that was waiting for it`, "error" in r ? "warning" : "info");
  }

  // Cards waiting for your review get their conflicts resolved too, so the
  // PR you review is the one that will merge (and its CI isn't wasted on a
  // branch that can't). Pipeline cards only; once per PR head (take()).
  const queued = new Set(mergeQueue());
  for (const t of list) {
    if (t.pipelineParentId || !t.pipelineId || t.archivedAt != null || t.column !== "review" || queued.has(t.id)) continue;
    const pr = prStatusForTask(t.id);
    if (pr?.state !== "open" || pr.draft) continue;
    const m = await getGitHubPullMergeability({ dir: t.workdir, number: pr.number }).catch(() => null);
    if (m && m.ok && (m.mergeable === false || m.mergeableState === "dirty")) {
      await take(t, pr, { kind: "resolve-conflicts" }).catch((err: Error) => note(t, `Merge queue error: ${err.message}`, "warning"));
    }
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
  const leftOut = new Set<string>();
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
      const candidates = group.slice(0, cfg.max);
      const train = await buildTrain(candidates.map((e) => ({ task: e.t, pr: e.pr! }))).catch(() => null);
      for (const m of train?.members ?? []) riding.add(m.taskId);
      // Offered a train and left out of it (it conflicts with the others, or
      // no train could be built): it has had its wait for company.
      for (const e of candidates) if (!riding.has(e.t.id)) leftOut.add(e.t.id);
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
      // Two green PRs that conflict with each other can never share a train;
      // if each kept waiting for the other, neither would ever merge.
      if (!leftOut.has(e.t.id) && (others > 0 || waited < cfg.windowMin * 60_000)) {
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
