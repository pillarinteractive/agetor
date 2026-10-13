/**
 * A problem found after a reviewed pipeline finished goes back through the
 * pipeline, not round it.
 *
 * A card whose pipeline has the Build → Review → Finish shape
 * (`reviewedPipelineShape`) publishes once: Build and Review work on local
 * commits, Finish pushes the commit Review approved and waits for CI. When CI
 * then fails on the open PR, or the PR conflicts with its base — seen by the
 * merge queue for a signed-off card, or by the PR watcher for one waiting in
 * In Review — a one-step follow-up ("Fix CI", "Resolve merge conflicts")
 * would edit code and push it with no review, and every push is a full CI
 * run. Instead:
 *
 *   whose failure is it?
 *     the base fails the same checks      → wait (the caller: `ownFailures`)
 *     behind a base that fixed them       → update the branch (the caller)
 *     a runner / the network broke a job,
 *     or the base was red and recovered   → re-run the failed jobs, once per head
 *     this change                         → a fix round
 *
 *   a fix round
 *     the sign-off is withdrawn, the run re-enters at Build with the failure
 *     as Finish's "verification failed" handoff (failing jobs, run URLs, the
 *     quoted log tail — or the conflicting files), Review re-reviews the fix
 *     and Finish publishes it with one push. The finished run then takes the
 *     ordinary sign-off path back to Ready to Merge.
 *
 *   at most `maxRounds` rounds per card (and never a second one for a head a
 *   round left unchanged): after that the card is held in In Review for the
 *   owner. Signing it off by hand again starts a fresh allowance.
 *
 *   a conflict with the base is counted apart, per base commit: merging the
 *   base in is Build's work, never the owner's. A card conflicting with a
 *   base tip it has not been sent to Build for gets a round whatever its
 *   other rounds came to — also when it is already held. For one base tip
 *   it gets at most `maxRounds`, each for a new head. Only a round that left
 *   the head as it was — Build could not resolve it — holds the card for
 *   the owner for good.
 *
 * Config: `merge_queue_rework` = {"enabled": true, "maxRounds": 3}. With
 * `enabled: false`, or for a pipeline without that shape, follow-ups run as
 * before. The per-card ledger lives in `merge_queue_rework_state` — in
 * preferences, not in the run's stored state, so a run stays readable by a
 * build that knows nothing of this.
 */
import type { Handoff, Task, TaskPrStatus } from "../shared/types.ts";
import { reviewedPipelineShape } from "../shared/pipeline.ts";
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { getGitHubPullChecks, rerunGitHubWorkflowRun, run as exec } from "./github.ts";
import { setMergeQueued } from "./merge-intent.ts";
import { pipelineUpdateColumn } from "./orchestrator.ts";
import { reworkPipelineRun } from "./pipeline-runner.ts";
import { invalidatePrStatus, newestPerName, ownFailures } from "./pr-watch.ts";

export const MERGE_REWORK_PREF = "merge_queue_rework";
const STATE_PREF = "merge_queue_rework_state";
export const DEFAULT_MAX_REWORK_ROUNDS = 3;
/** After a re-run is requested GitHub takes a moment to show the checks as
 *  running again; until then the PR still reads as failing. */
export const RERUN_SETTLE_MS = 3 * 60_000;
const LOG_TAIL_LINES = 60;
const LOG_TAIL_CHARS = 6_000;

export interface ReworkConfig {
  enabled: boolean;
  maxRounds: number;
}

export function parseReworkConfig(raw: string | null | undefined): ReworkConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const n = o.maxRounds;
  return {
    enabled: o.enabled !== false,
    maxRounds: typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : DEFAULT_MAX_REWORK_ROUNDS,
  };
}

/** One card's bookkeeping. */
export interface ReworkEntry {
  /** Fix rounds started since the owner last signed the card off by hand. */
  rounds: number;
  /** The PR head the last round was started for. */
  lastHead?: string;
  /** The one automatic re-run of failed jobs: which head, and when. */
  rerun?: { head: string; at: number };
  /** The head whose failures were last seen to be the base's, not its own. */
  baseRed?: string;
  /** Held for the owner: no more rounds, and Autopilot leaves it in In Review. */
  held?: boolean;
  /** The run the hold is about (`PipelineRunState.startedAt`), and whether
   *  the owner reopened that run since: a hold does not outlive its run
   *  (`signOffMarkLapsed`). Absent on a hold recorded by an older build. */
  heldRun?: number;
  reopened?: boolean;
  /** Conflict rounds started against one tip of the base branch. */
  conflict?: { baseTip: string; rounds: number };
  /** Why the card is held, when that decides what lifts it: Build's round
   *  left the conflict as it was, so a moved base does not send it to Build
   *  again. */
  heldFor?: "conflict-unresolved";
}

function readState(): Record<string, ReworkEntry> {
  try {
    const v = JSON.parse(preferences.get(STATE_PREF) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, ReworkEntry> = {};
    for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const rerun = e.rerun as { head?: unknown; at?: unknown } | undefined;
      const conflict = e.conflict as { baseTip?: unknown; rounds?: unknown } | undefined;
      out[id] = {
        rounds: typeof e.rounds === "number" && Number.isSafeInteger(e.rounds) && e.rounds >= 0 ? e.rounds : 0,
        ...(typeof e.lastHead === "string" ? { lastHead: e.lastHead } : {}),
        ...(rerun && typeof rerun.head === "string" && typeof rerun.at === "number" ? { rerun: { head: rerun.head, at: rerun.at } } : {}),
        ...(typeof e.baseRed === "string" ? { baseRed: e.baseRed } : {}),
        ...(e.held === true ? { held: true } : {}),
        ...(typeof e.heldRun === "number" && Number.isFinite(e.heldRun) ? { heldRun: e.heldRun } : {}),
        ...(e.reopened === true ? { reopened: true } : {}),
        ...(conflict && typeof conflict.baseTip === "string" && conflict.baseTip && typeof conflict.rounds === "number" && Number.isSafeInteger(conflict.rounds) && conflict.rounds >= 0
          ? { conflict: { baseTip: conflict.baseTip, rounds: conflict.rounds } } : {}),
        ...(e.heldFor === "conflict-unresolved" ? { heldFor: "conflict-unresolved" as const } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeEntry(taskId: string, entry: ReworkEntry | null): void {
  const state = readState();
  if (entry) state[taskId] = entry;
  else delete state[taskId];
  preferences.set(STATE_PREF, JSON.stringify(state));
}

export function reworkEntry(taskId: string): ReworkEntry {
  return readState()[taskId] ?? { rounds: 0 };
}

/** Cards held for the owner after their rounds ran out: Autopilot treats
 *  them like cards the owner took back, and does not sign them off again. */
export function reworkHeld(): string[] {
  return Object.entries(readState()).filter(([, e]) => e.held).map(([id]) => id);
}

/** The owner signed the card off by hand: a fresh allowance of rounds. */
export function noteOwnerSignOff(taskId: string): void {
  if (readState()[taskId]) writeEntry(taskId, null);
}

/** What a card's hold is about, for `signOffMarkLapsed`; null when it is not
 *  held. A hold from a build that did not record its run is given `run` (the
 *  card's run as it is now) the first time it is asked about. */
export function reworkHoldMark(taskId: string, run: number | null): { run: number | null; head: string | null; reopened?: boolean } | null {
  const entry = readState()[taskId];
  if (!entry?.held) return null;
  if (entry.heldRun === undefined && run != null) writeEntry(taskId, { ...entry, heldRun: run });
  return { run: entry.heldRun ?? run, head: entry.lastHead ?? null, ...(entry.reopened ? { reopened: true } : {}) };
}

/** The owner sent the held card's run back through its steps (a restart from
 *  a step, a rewind, feedback): the hold is about a run that is being redone. */
export function noteRunReopened(taskId: string): void {
  const entry = readState()[taskId];
  if (entry?.held && !entry.reopened) writeEntry(taskId, { ...entry, reopened: true });
}

/** Forget cards that are gone (merged, archived, deleted). */
export function pruneReworkState(live: ReadonlySet<string>): void {
  const state = readState();
  const kept = Object.fromEntries(Object.entries(state).filter(([id]) => live.has(id)));
  if (Object.keys(kept).length !== Object.keys(state).length) preferences.set(STATE_PREF, JSON.stringify(kept));
}

/** The base, not this change, is failing this head's checks: remembered so
 *  that if the base recovers with no new commit the jobs are re-run, not
 *  "fixed". */
export function noteBaseRed(taskId: string, headSha: string | null): void {
  if (!headSha) return;
  const entry = reworkEntry(taskId);
  if (entry.baseRed !== headSha) writeEntry(taskId, { ...entry, baseRed: headSha });
}

/** The shape to send this card back through, or null when it keeps
 *  follow-ups: rework turned off, no run, or a pipeline without Build,
 *  Review and Finish. Read from the run's frozen graph, which is what runs. */
export function reviewedReworkFor(
  task: Pick<Task, "pipelineId" | "pipelineRun">,
  cfg: ReworkConfig = parseReworkConfig(preferences.get(MERGE_REWORK_PREF)),
): NonNullable<ReturnType<typeof reviewedPipelineShape>> | null {
  if (!cfg.enabled || !task.pipelineId) return null;
  return reviewedPipelineShape(task.pipelineRun?.snapshot?.graph);
}

// ---------------------------------------------------------------------------
// Whose failure is it
// ---------------------------------------------------------------------------

export interface FailedCheck {
  name: string;
  url: string | null;
  conclusion: string | null;
  runId: number | null;
}

export interface CiFailureDetails {
  /** The PR's head as GitHub has it now; null when it couldn't be read. */
  headSha: string | null;
  checks: FailedCheck[];
  /** The tail of each failed run's log (`gh run view --log-failed`). */
  logs: { runId: number; tail: string }[];
}

const INFRA_LOG_RE = new RegExp(
  [
    "the runner has received a shutdown signal",
    "runner .*lost communication with the server",
    "the self-hosted runner.* (?:lost|offline|did not connect)",
    "no space left on device",
    "could not resolve host",
    "temporary failure in name resolution",
    "\\bEAI_AGAIN\\b",
    "\\bECONNRESET\\b",
    "\\bETIMEDOUT\\b",
    "tls handshake timeout",
    "\\b50[234] (?:bad gateway|service unavailable|gateway time-?out)",
    "the operation was canceled",
    "failed to connect to github\\.com",
    "unable to access 'https://github\\.com",
    "rate limit exceeded",
  ].join("|"),
  "i",
);

/**
 * Why this failure looks like the runner's or the network's rather than the
 * change's, or null. Deliberately narrow — every failed check must show it:
 * one real test failure next to a flaky job is still this change's to fix. A
 * wrong "infra" costs one re-run of the failed jobs; a wrong "own" costs a
 * fix round whose Build is told to check exactly this. Pure.
 */
export function infraReason(details: Pick<CiFailureDetails, "checks" | "logs">): string | null {
  if (details.checks.length === 0) return null;
  const reasons: string[] = [];
  for (const c of details.checks) {
    if (c.conclusion === "startup_failure") {
      reasons.push(`${c.name} failed to start`);
      continue;
    }
    if (c.runId == null) return null;
    const log = details.logs.find((l) => l.runId === c.runId);
    if (!log) return null;
    if (log.tail.trim() === "") {
      reasons.push(`${c.name} failed before any of its steps ran`);
      continue;
    }
    const hit = INFRA_LOG_RE.exec(log.tail);
    if (!hit) return null;
    reasons.push(`${c.name}: "${hit[0]}"`);
  }
  return [...new Set(reasons)].slice(0, 3).join("; ");
}

export function runIdFromCheckUrl(url: string | null): number | null {
  const m = /\/actions\/runs\/(\d+)/.exec(url ?? "");
  return m ? Number(m[1]) : null;
}

/** The last lines of `gh run view --log-failed` output, without its
 *  `job<TAB>step<TAB>` prefix (as `ci-wait` prints them). Pure. */
export function logTail(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim()).map((l) => l.split("\t").slice(2).join("\t") || l);
  const tail = lines.slice(-LOG_TAIL_LINES).join("\n");
  return tail.length > LOG_TAIL_CHARS ? tail.slice(-LOG_TAIL_CHARS) : tail;
}

// ---------------------------------------------------------------------------
// What Build is told
// ---------------------------------------------------------------------------

type Shape = NonNullable<ReturnType<typeof reviewedPipelineShape>>;

function routeName(shape: Shape): string {
  return shape.viaEdge?.label.trim() || shape.build.name;
}

const ROUND_RULES =
  "This arrives as a verification failure: fix it locally and commit, do not push and do not touch the pull request. " +
  "Review re-reviews your fix and Finish publishes the approved commit with one push.";

const foundBy = (inRun: boolean | undefined) =>
  inRun ? "Found by Agetor while it ran Finish (no agent published this)" : "Found by Agetor's merge queue, not by a step";
const roundNote = (input: { inRun?: boolean; round: number; maxRounds: number; perBase?: string }) =>
  input.inRun ? ""
    : input.perBase
      ? ` This is round ${input.round} of ${input.maxRounds} against this commit of ${input.perBase}. If a conflict cannot be resolved without a decision that is the owner's, ` +
        'change nothing and hand off with status "blocked", naming the file and the decision: that, and only that, puts the card in front of the owner.'
      : ` This is fix round ${input.round} of ${input.maxRounds} for this card; after the last one it is held for the owner.`;

/** The handoff Build receives for a CI failure found after the run finished:
 *  what Finish's own "verification failed" carries. Pure. */
export function ciFailureHandoff(input: {
  shape: Shape;
  pr: Pick<TaskPrStatus, "number" | "url" | "baseRef" | "headSha">;
  details: Pick<CiFailureDetails, "checks" | "logs">;
  inherited: string[];
  round: number;
  maxRounds: number;
  signedOff: boolean;
  /** Found by Agetor while it ran Finish inside the run (src/bun/publish-step.ts),
   *  not by the merge queue afterwards: no fix-round count applies. */
  inRun?: boolean;
}): Handoff {
  const { pr, details } = input;
  const base = pr.baseRef ?? "the base branch";
  const runUrls = [...new Set(details.checks.map((c) => c.url).filter((u): u is string => !!u))];
  const jobs = details.checks.map((c) => `- ${c.name}${c.conclusion ? ` (${c.conclusion})` : ""}${c.url ? ` ${c.url}` : ""}`).join("\n");
  const logs = details.logs.filter((l) => l.tail.trim()).map((l) =>
    `--- last lines of the failed log, run ${l.runId} (full: gh run view ${l.runId} --log-failed) ---\n${l.tail}`).join("\n\n");
  return {
    schemaVersion: 1,
    status: "done",
    purpose: `Verification failed: CI on PR #${pr.number} failed${input.inRun ? "" : input.signedOff ? " after the card was signed off" : " after the pipeline finished"}`,
    summary:
      `${foundBy(input.inRun)}: CI failed on pull request #${pr.number} (${pr.url}) at head ${pr.headSha ?? "unknown"}. ` +
      `Failing checks this change caused:\n${jobs}\n\n` +
      (input.inherited.length ? `These also fail on ${base} and are not this change's to fix — leave them alone: ${input.inherited.join(", ")}.\n\n` : "") +
      `Reproduce each failure with the narrowest local command, fix the root cause, add the regression test if one was missing, and say which commit answers which failing job. ` +
      `If you find the failure is ${base}'s or a runner's and not this change's, make no code change: merge origin/${base} if it moved, and say so with the evidence. ` +
      `${ROUND_RULES}${roundNote(input)}`,
    reason: logs || "The failed runs' logs could not be read; read them with `gh run view <run id> --log-failed`.",
    next: routeName(input.shape),
    artifacts: [pr.url, ...runUrls],
    openQuestions: [],
  };
}

/** The handoff Build receives when the PR conflicts with its base. Pure. */
export function conflictHandoff(input: {
  shape: Shape;
  pr: Pick<TaskPrStatus, "number" | "url" | "baseRef" | "headSha">;
  files: string[];
  round: number;
  maxRounds: number;
  signedOff: boolean;
  inRun?: boolean;
  /** Counted against one base commit, not against the card (`reworkConflict`). */
  perBaseTip?: boolean;
}): Handoff {
  const { pr } = input;
  const base = pr.baseRef ?? "develop";
  const files = input.files.length
    ? `Conflicting files:\n${input.files.slice(0, 40).map((f) => `- ${f}`).join("\n")}${input.files.length > 40 ? `\n- … and ${input.files.length - 40} more` : ""}`
    : `The conflicting files could not be listed here; \`git merge-tree --write-tree --name-only HEAD origin/${base}\` names them.`;
  return {
    schemaVersion: 1,
    status: "done",
    purpose: `Verification failed: ${pr.number ? `PR #${pr.number}` : "the branch"} conflicts with ${base}`,
    summary:
      `${foundBy(input.inRun)}: ${input.inRun && !pr.number ? "this branch" : `pull request #${pr.number} (${pr.url})`} no longer merges into ${base}` +
      `${input.signedOff ? " (the card was signed off)" : ""}. ${files}\n\n` +
      `\`git fetch origin ${base}\`, merge origin/${base} into this branch (a merge commit — never a rebase, never a push to ${base}), ` +
      `resolve each conflict keeping both sides' intent, rerun the local checks for what the resolution touched, and commit. ` +
      `Make no change beyond the merge and what the resolution needs. ` +
      `${ROUND_RULES}${roundNote({ ...input, ...(input.perBaseTip ? { perBase: base } : {}) })}`,
    reason: pr.number ? `PR #${pr.number} conflicts with ${base}` : `the branch conflicts with ${base}`,
    next: routeName(input.shape),
    artifacts: pr.url ? [pr.url] : [],
    openQuestions: [],
  };
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

/** GitHub, git and the runner — replaceable in tests. */
export const reworkDeps = {
  /** The failing checks this PR caused, with their conclusions and log tails. */
  async failureDetails(task: Task, pr: TaskPrStatus): Promise<CiFailureDetails> {
    const own = ownFailures(pr);
    const live = await getGitHubPullChecks({ dir: task.workdir, number: pr.number });
    const conclusions = new Map(live.ok ? newestPerName(live.checkRuns).map((r) => [r.name, r.conclusion] as const) : []);
    const checks: FailedCheck[] = own.map((c) => ({ name: c.name, url: c.url, conclusion: conclusions.get(c.name) ?? null, runId: runIdFromCheckUrl(c.url) }));
    const logs: CiFailureDetails["logs"] = [];
    for (const runId of [...new Set(checks.map((c) => c.runId).filter((n): n is number => n != null))].slice(0, 2)) {
      const r = await exec(["gh", "run", "view", String(runId), "--log-failed"], task.workdir, 60_000, process.env);
      if (r.ok) logs.push({ runId, tail: logTail(r.stdout) });
    }
    return { headSha: live.ok ? live.sha : null, checks, logs };
  },
  /** The files that conflict between the PR's branch and its base, and the
   *  branch's head on the remote. */
  async conflictFiles(task: Task, pr: TaskPrStatus): Promise<{ headSha: string | null; files: string[]; baseTip?: string | null }> {
    const base = pr.baseRef ?? "develop";
    if (!task.branch) return { headSha: null, files: [] };
    const git = (args: string[]) => exec(["git", ...args], task.workdir, 120_000, process.env);
    await git(["fetch", "--quiet", "origin", base, task.branch]);
    const head = await git(["rev-parse", `origin/${task.branch}`]);
    const merged = await git(["merge-tree", "--write-tree", "--name-only", `origin/${task.branch}`, `origin/${base}`]);
    // Exit 1 = conflicts: the tree id, then the conflicted paths, then a blank line and messages.
    const files = merged.exitCode === 1
      ? (merged.stdout.split("\n\n")[0] ?? "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean)
      : [];
    const tip = await git(["rev-parse", `origin/${base}`]);
    return {
      headSha: head.ok && head.stdout.trim() ? head.stdout.trim() : null, files: [...new Set(files)],
      baseTip: tip.ok && tip.stdout.trim() ? tip.stdout.trim() : null,
    };
  },
  /** The base branch's tip on the remote, without fetching it; null when it
   *  could not be read. Asked for a held card, once a pass. */
  async baseTip(task: Task, base: string): Promise<string | null> {
    const r = await exec(["git", "ls-remote", "origin", `refs/heads/${base}`], task.workdir, 60_000, process.env);
    const sha = r.ok ? (r.stdout.trim().split(/\s+/)[0] ?? "") : "";
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  },
  async rerunFailed(task: Task, runId: number): Promise<{ ok: boolean; error?: string }> {
    const r = await rerunGitHubWorkflowRun({ dir: task.workdir, runId, failedOnly: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
  rework: reworkPipelineRun,
  now: () => Date.now(),
};

export type ReworkOutcome =
  | { kind: "skipped"; why: string }
  | { kind: "rerun"; why: string }
  | { kind: "round"; round: number }
  | { kind: "held" }
  | { kind: "error"; error: string };

/** Heads a round could not be started for (`<taskId>:<head>`): tried again
 *  after a restart or a new head, not every minute. */
const failedStarts = new Set<string>();

function say(taskId: string, text: string, tone: "info" | "warning" | "danger" | "muted" = "info"): void {
  recordActivity(taskId, { kind: "auto", text, tone });
}

/** Out of rounds, or a round changed nothing: back to In Review, sign-off
 *  withdrawn, for the owner. Says so once. */
function hold(task: Task, pr: Pick<TaskPrStatus, "number">, entry: ReworkEntry, what: string, why: string, heldFor?: ReworkEntry["heldFor"]): ReworkOutcome {
  if (entry.held) return { kind: "held" };
  const heldRun = tasks.get(task.id)?.pipelineRun?.startedAt ?? task.pipelineRun?.startedAt;
  const { reopened: _reopened, heldFor: _heldFor, ...rest } = entry;
  writeEntry(task.id, { ...rest, held: true, ...(heldRun != null ? { heldRun } : {}), ...(heldFor ? { heldFor } : {}) });
  setMergeQueued(task.id, false);
  if (tasks.get(task.id)?.column === "merge") pipelineUpdateColumn(task.id, null, "review");
  say(
    task.id,
    `Held for you: ${what} on PR #${pr.number}, and ${why}. The card is in In Review with its sign-off withdrawn and nothing more runs on it by itself — ` +
      "fix it or take it over. Dragging it to Ready to Merge again allows a fresh set of fix rounds.",
    "danger",
  );
  return { kind: "held" };
}

async function startRound(
  task: Task,
  pr: TaskPrStatus,
  head: string,
  shape: Shape,
  cfg: ReworkConfig,
  what: string,
  build: (round: number, signedOff: boolean) => Handoff,
): Promise<ReworkOutcome> {
  const entry = reworkEntry(task.id);
  if (entry.held) return { kind: "held" };
  if (entry.rounds >= cfg.maxRounds) {
    return hold(task, pr, entry, what, `${entry.rounds} fix round${entry.rounds === 1 ? "" : "s"} through Build, Review and Finish did not get it mergeable`);
  }
  if (entry.rounds > 0 && entry.lastHead === head) {
    return hold(task, pr, entry, what, "the last fix round left the pull request's head unchanged");
  }
  const key = `${task.id}:${head}`;
  if (failedStarts.has(key)) return { kind: "skipped", why: "a round could not be started for this head" };
  const signedOff = task.column === "merge";
  const round = entry.rounds + 1;
  const r = await reworkDeps.rework(task.id, { stepId: shape.build.id, fromStepId: shape.finish.id, handoff: build(round, signedOff) });
  // The run left `done` when Build launched, queued for a slot, or stopped on
  // a block a Retry relaunches: in each case this round is under way.
  if (tasks.get(task.id)?.pipelineRun?.status === "done") {
    failedStarts.add(key);
    const error = "error" in r ? r.error : "the run did not start";
    say(task.id, `Couldn't send the card back to ${shape.build.name} (${what} on PR #${pr.number}): ${error}`, "warning");
    return { kind: "error", error };
  }
  writeEntry(task.id, { ...entry, rounds: round, lastHead: head });
  // The sign-off was for a head that is about to change. The finished run
  // goes to In Review and is signed off again the ordinary way.
  const withdrawn = setMergeQueued(task.id, false);
  say(
    task.id,
    `${withdrawn || signedOff ? "Merge queue" : "After the pipeline finished"}: ${what} on PR #${pr.number} — ${withdrawn || signedOff ? "sign-off withdrawn, " : ""}sent back through ${shape.build.name} → ${shape.review.name} → ${shape.finish.name} ` +
      `(fix round ${round} of ${cfg.maxRounds}); nothing is pushed until ${shape.review.name} approves the fix`,
    "warning",
  );
  return { kind: "round", round };
}

/**
 * CI is failing on the open PR of a card whose run has finished, and the
 * failure is not the base's (`ownFailures(pr)` is non-empty). Re-runs the
 * failed jobs once when it is the runner's doing, otherwise starts a fix
 * round or holds the card.
 */
export async function reworkCiFailure(task: Task, pr: TaskPrStatus): Promise<ReworkOutcome> {
  const cfg = parseReworkConfig(preferences.get(MERGE_REWORK_PREF));
  const shape = reviewedReworkFor(task, cfg);
  if (!shape) return { kind: "skipped", why: "not a reviewed pipeline" };
  if (task.pipelineRun?.status !== "done") return { kind: "skipped", why: "the run is not finished" };
  if (pr.state !== "open" || pr.checks !== "failure" || !pr.headSha || ownFailures(pr).length === 0) return { kind: "skipped", why: "no failure of its own" };
  const head = pr.headSha;
  const before = reworkEntry(task.id);
  if (before.held) return { kind: "held" };
  const now = reworkDeps.now();
  if (before.rerun?.head === head && now - before.rerun.at < RERUN_SETTLE_MS) return { kind: "skipped", why: "failed jobs were just re-run" };
  if (failedStarts.has(`${task.id}:${head}`)) return { kind: "skipped", why: "a round could not be started for this head" };

  const details = await reworkDeps.failureDetails(task, pr);
  // The cached status is of an older head (a push the watcher has not seen
  // yet): nothing here is about the commit that is failing.
  if (details.headSha && details.headSha !== head) {
    invalidatePrStatus(task.id);
    return { kind: "skipped", why: "the pull request moved on" };
  }

  if (before.rerun?.head !== head) {
    const infra = infraReason(details) ?? (before.baseRed === head ? `${pr.baseRef ?? "the base"} was failing the same checks and has recovered` : null);
    const runIds = [...new Set(details.checks.map((c) => c.runId).filter((n): n is number => n != null))];
    if (infra && runIds.length > 0) {
      const results = await Promise.all(runIds.map((id) => reworkDeps.rerunFailed(task, id)));
      if (results.some((r) => r.ok)) {
        writeEntry(task.id, { ...before, rerun: { head, at: now } });
        invalidatePrStatus(task.id);
        say(task.id, `CI failed on PR #${pr.number}, but not because of this change (${infra}) — re-ran the failed jobs once; no fix round`, "info");
        return { kind: "rerun", why: infra };
      }
      say(task.id, `Couldn't re-run the failed jobs of PR #${pr.number}: ${results.find((r) => !r.ok)?.error ?? "unknown error"}`, "warning");
    }
  }

  const inherited = pr.failingChecks.filter((c) => c.alsoOnBase).map((c) => c.name);
  const names = details.checks.map((c) => c.name).slice(0, 3).join(", ");
  return startRound(task, pr, head, shape, cfg, `CI failed (${names})`, (round, signedOff) =>
    ciFailureHandoff({ shape, pr, details, inherited, round, maxRounds: cfg.maxRounds, signedOff }));
}

/**
 * The open PR of a card whose run has finished conflicts with its base.
 * Merging the base in is Build's work, so this is counted per base commit
 * and not against the card's fix rounds:
 *
 * - a base tip the card has not been sent to Build for: a round, whatever
 *   its other rounds came to, and also when the card is already held
 *   (rounds ran out on CI failures, or on an older base tip);
 * - the same base tip again: only for a head the last round changed, and at
 *   most `maxRounds` times — then it waits for the base to move;
 * - the same base tip and the same head: Build's round resolved nothing.
 *   That is the one conflict held for the owner, and a moved base does not
 *   lift it (`heldFor`).
 *
 * When the base tip cannot be read the card's ordinary round limit applies.
 */
export async function reworkConflict(task: Task, pr: TaskPrStatus): Promise<ReworkOutcome> {
  const cfg = parseReworkConfig(preferences.get(MERGE_REWORK_PREF));
  const shape = reviewedReworkFor(task, cfg);
  if (!shape) return { kind: "skipped", why: "not a reviewed pipeline" };
  if (task.pipelineRun?.status !== "done") return { kind: "skipped", why: "the run is not finished" };
  if (pr.state !== "open") return { kind: "skipped", why: "the pull request is not open" };
  const base = pr.baseRef ?? "develop";
  const before = reworkEntry(task.id);
  if (before.held) {
    if (before.heldFor === "conflict-unresolved") return { kind: "held" };
    // Held, and the base has not moved since its last conflict round (or
    // cannot be read): nothing new to hand Build. One `ls-remote`, no fetch.
    const tip = await reworkDeps.baseTip(task, base).catch(() => null);
    if (!tip || tip === before.conflict?.baseTip) return { kind: "held" };
  }
  const seen = pr.headSha ?? "";
  if (failedStarts.has(`${task.id}:${seen}`)) return { kind: "skipped", why: "a round could not be started for this head" };
  const found = await reworkDeps.conflictFiles(task, pr);
  const head = found.headSha ?? seen;
  const at = { ...pr, headSha: head || pr.headSha };
  const what = `a conflict with ${base}`;
  const tip = found.baseTip ?? null;
  if (!tip) {
    if (before.held) return { kind: "held" };
    return startRound(task, at, head, shape, cfg, what, (round, signedOff) =>
      conflictHandoff({ shape, pr: at, files: found.files, round, maxRounds: cfg.maxRounds, signedOff }));
  }

  const sameTip = before.conflict?.baseTip === tip;
  const tipRounds = sameTip ? before.conflict!.rounds : 0;
  if (sameTip && tipRounds > 0 && before.lastHead === head) {
    if (before.held) return { kind: "held" };
    return hold(task, pr, before, what, `the round through ${shape.build.name} left the branch as it was — it could not resolve the conflict`, "conflict-unresolved");
  }
  if (tipRounds >= cfg.maxRounds) {
    if (before.held) return { kind: "held" };
    return hold(task, pr, before, what,
      `${tipRounds} round${tipRounds === 1 ? "" : "s"} through ${shape.build.name} did not resolve it against ${base} at ${tip.slice(0, 8)}. It goes to ${shape.build.name} again by itself when ${base} moves`);
  }
  const key = `${task.id}:${head}`;
  if (failedStarts.has(key)) return { kind: "skipped", why: "a round could not be started for this head" };
  const signedOff = task.column === "merge";
  const round = tipRounds + 1;
  const r = await reworkDeps.rework(task.id, {
    stepId: shape.build.id, fromStepId: shape.finish.id,
    handoff: conflictHandoff({ shape, pr: at, files: found.files, round, maxRounds: cfg.maxRounds, signedOff, perBaseTip: true }),
  });
  if (tasks.get(task.id)?.pipelineRun?.status === "done") {
    failedStarts.add(key);
    const error = "error" in r ? r.error : "the run did not start";
    say(task.id, `Couldn't send the card back to ${shape.build.name} (${what} on PR #${pr.number}): ${error}`, "warning");
    return { kind: "error", error };
  }
  // A hold is lifted by the round: the finished run is signed off the
  // ordinary way. The card's other rounds are not spent on a conflict.
  const { held: wasHeld, heldRun: _heldRun, heldFor: _heldFor, reopened: _reopened, ...rest } = before;
  writeEntry(task.id, { ...rest, lastHead: head, conflict: { baseTip: tip, rounds: round } });
  const withdrawn = setMergeQueued(task.id, false);
  say(
    task.id,
    `${wasHeld ? `No longer held for you: ${base} moved to ${tip.slice(0, 8)} and merging it in is ${shape.build.name}'s work. ` : ""}` +
      `${withdrawn || signedOff ? "Merge queue" : "After the pipeline finished"}: ${what} on PR #${pr.number} — ${withdrawn || signedOff ? "sign-off withdrawn, " : ""}sent back through ${shape.build.name} → ${shape.review.name} → ${shape.finish.name} ` +
      `(round ${round} of ${cfg.maxRounds} against ${base} at ${tip.slice(0, 8)}); nothing is pushed until ${shape.review.name} approves the merge`,
    "warning",
  );
  return { kind: "round", round };
}

export function resetReworkForTests(): void {
  failedStarts.clear();
  preferences.set(STATE_PREF, "{}");
}
