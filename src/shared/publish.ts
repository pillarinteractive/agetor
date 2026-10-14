/**
 * Finish run by Agetor — the pure half (docs/plans/check-gated-pipeline.md §4).
 *
 * A reviewed pipeline's Finish step is a fixed procedure: check that the head
 * is the one Review approved, push it once, wait for CI, decide whose failure
 * a red result is. An agent used to carry it out from prose, and stopped the
 * card whenever the base was red or CI was slow. Here it is a state machine:
 * {@link decidePublish} maps the visit's state and what Agetor just observed
 * to ONE action, and {@link applyPublish} folds an action's result back into
 * the state. src/bun/publish-step.ts makes the observations and carries the
 * actions out; nothing here touches git, GitHub or a clock.
 *
 *   verify-head → check-merge → hold-base → push → pr → wait-ci → finalize → write
 *                                                        │
 *                                   classify ◄───────────┘ (CI failed)
 *                                      │ all inherited
 *                                   base-red → refresh → push → … → wait-ci
 *
 * A failure that is the change's own leaves the machine for Build, on the
 * step's "verification failed" edge, with no agent turn spent on Finish. A
 * failure the base shares parks the card in `base-red`: no agent, no step
 * slot, no attempt counted, and it resumes when the base's jobs pass. The
 * wait is a state Agetor entered from its own observation — no handoff, no
 * `waitingRef`, no text match decides it.
 *
 * Whose failure is decided by check name and job only (`baseVerdicts`); log
 * text is read for the runner-fault decision alone, which costs one re-run
 * when wrong.
 *
 * The agent still writes: once CI is green, one short turn of the step's own
 * agent rewrites the PR description (`write`). It does not push, wait,
 * classify or choose an edge.
 */
import type { Handoff, PipelinePublishState, PipelineRunSnapshot, PipelineStep, PublishStateName } from "./types.ts";
import { reviewedPipelineShape } from "./pipeline.ts";
import { ROLLUP_CHECKS, checksState, failedConclusion, newestPerName, type CheckRunLike } from "./check-runs.ts";

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** `{"publish": {"pipelines": ["<pipeline id>"], "cards": ["<task id>", …]}}`.
 *  `pipelines` is the switch, off when absent or empty: each entry is a
 *  pipeline's id or its exact name (case-insensitive; never a prefix — see
 *  {@link unmatchedGateRefs} for what an entry that matches nothing does).
 *  `cards` is the trial list: when present, only those cards of those
 *  pipelines; leave it out to cover every card of them. Each gate has its own
 *  entry of the same shape: `publish` (Finish run by Agetor), `steps`
 *  (checks on working steps, src/shared/checks.ts) and `preload` (Build and
 *  Review start with their reading done, src/shared/preload.ts). */
export const PIPELINE_GATES_PREF = "pipeline_gates";

/** What the preference can switch on: the two gates, and `preload`
 *  (src/shared/preload.ts) — not a gate, but switched the same way: reads
 *  Agetor does at launch and puts in a Build or Review prompt. */
export type PipelineGateName = "publish" | "steps" | "preload";
export const PIPELINE_GATE_NAMES: readonly PipelineGateName[] = ["publish", "steps", "preload"];

export interface PublishGate {
  pipelines: string[];
  /** null: every card of `pipelines`. */
  cards: string[] | null;
}

/** One gate's entry of the preference. Anything unreadable is off. */
export function parsePipelineGate(raw: string | null | undefined, name: PipelineGateName): PublishGate {
  const off: PublishGate = { pipelines: [], cards: null };
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return off;
  }
  const entry = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[name] : null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return off;
  const o = entry as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : null);
  // A `cards` that is present but unreadable allows no card: a typo in the
  // trial list must never widen the trial to the whole pipeline.
  return { pipelines: strings(o.pipelines) ?? [], cards: o.cards === undefined ? null : (strings(o.cards) ?? []) };
}

export function parsePublishGate(raw: string | null | undefined): PublishGate {
  return parsePipelineGate(raw, "publish");
}

/** Whether the switch covers this card now. Pure. */
export function publishGateOn(gate: PublishGate, card: { id: string; pipelineId: string | null; pipelineName?: string | null }): boolean {
  const name = card.pipelineName?.trim().toLowerCase();
  const pipeline = gate.pipelines.some((p) => p === card.pipelineId || (!!name && p.toLowerCase() === name));
  return pipeline && (gate.cards === null || gate.cards.includes(card.id));
}

/** What the preference names that is not there, so it gates nothing. */
export interface GateUnmatched {
  /** Entries of `pipelines` that are no pipeline's id and no pipeline's
   *  exact name (case-insensitive), as `<gate>: <entry>`. */
  pipelines: string[];
  /** Entries of `cards` that are no task's id, as `<gate>: <entry>`. */
  cards: string[];
}

/**
 * The entries of `pipeline_gates` that match nothing. A pipeline is named by
 * its id or by its exact name, compared without regard to case — never by a
 * prefix: "Change" does not name "Change: Understand, Build, Review, Finish",
 * and used to switch nothing on without a word. A card is named by its full
 * task id. Pure.
 */
export function unmatchedGateRefs(
  raw: string | null | undefined,
  known: { pipelines: readonly { id: string; name: string }[]; hasCard: (id: string) => boolean },
): GateUnmatched {
  const out: GateUnmatched = { pipelines: [], cards: [] };
  const names = new Set(known.pipelines.map((p) => p.name.trim().toLowerCase()));
  const ids = new Set(known.pipelines.map((p) => p.id));
  for (const name of PIPELINE_GATE_NAMES) {
    const gate = parsePipelineGate(raw, name);
    for (const p of gate.pipelines) if (!ids.has(p) && !names.has(p.toLowerCase())) out.pipelines.push(`${name}: ${p}`);
    for (const c of gate.cards ?? []) if (!known.hasCard(c)) out.cards.push(`${name}: ${c}`);
  }
  return out;
}

/** One line saying what `unmatched` names, or null when everything matched. */
export function gateUnmatchedLine(unmatched: GateUnmatched): string | null {
  const parts: string[] = [];
  if (unmatched.pipelines.length > 0) {
    parts.push(`no pipeline has the id or the exact name ${unmatched.pipelines.map((p) => JSON.stringify(p.replace(/^\w+: /, ""))).join(", ")}`);
  }
  if (unmatched.cards.length > 0) parts.push(`no card has the id ${unmatched.cards.map((c) => JSON.stringify(c.replace(/^\w+: /, ""))).join(", ")}`);
  return parts.length > 0 ? `pipeline_gates names what is not there, so it gates nothing: ${parts.join("; ")}. Use a pipeline's id or its whole name, and a card's full id` : null;
}

/** The step Agetor runs for a run that adopted the gate: Finish of the
 *  Build → Review → Finish shape, or null (no gate, or another shape). */
export function publishStepOf(snapshot: PipelineRunSnapshot | null | undefined): PipelineStep | null {
  if (!snapshot?.gates?.publish) return null;
  return reviewedPipelineShape(snapshot.graph)?.finish ?? null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** After a re-run is requested GitHub takes a moment to show the checks as
 *  running again; until then the head still reads as failed or cancelled. */
export const PUBLISH_RERUN_SETTLE_MS = 3 * 60_000;
/** A pushed head with no check run at all after this long is the owner's. */
export const PUBLISH_NO_CHECKS_MS = 20 * 60_000;
/** GitHub not showing the pushed head on the PR after this long is too. */
export const PUBLISH_PR_LAG_MS = 10 * 60_000;
/** Consecutive failures of one action (a push, a re-run request) before the
 *  owner is asked. */
export const PUBLISH_MAX_TRIES = 5;
/** Branches Agetor never pushes to, whatever the card's branch says. */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "develop", "release"]);

const STATE_NOTE: Record<PublishStateName, string> = {
  "verify-head": "checking that the head is the one Review approved",
  "check-merge": "checking that it merges with the base",
  "hold-base": "checking the base's CI before pushing",
  push: "pushing the approved head",
  pr: "opening the pull request",
  "wait-ci": "waiting for CI",
  classify: "CI failed — working out whose failure it is",
  "base-red": "the base is failing the same checks",
  refresh: "the base recovered — re-testing against it",
  finalize: "CI passed — finishing",
  write: "CI passed — the agent is writing the PR description",
  agent: "run by its agent",
};

export function initialPublishState(stepId: string, now: number): PipelinePublishState {
  return {
    state: "verify-head", stepId, since: now, stateSince: now, base: null, approvedHead: null, head: null, tree: null,
    baseTip: null, pr: null, reran: [], inherited: [], carried: 0, tries: 0, note: STATE_NOTE["verify-head"],
  };
}

/** Whether this visit is over: the agent execution it ended in (the writer,
 *  or the fallback agent) has left `active`. The step's next launch then
 *  starts a new visit. Pure. */
export function publishVisitOver(p: PipelinePublishState | undefined, stepId: string, activeSeqs: readonly number[]): boolean {
  if (!p || p.stepId !== stepId) return true;
  return p.seq !== undefined && !activeSeqs.includes(p.seq);
}

/** The head whose Review approval covers `headSha`: when Agetor merged the
 *  base into the approved head (the change's own diff unchanged) the
 *  published head is that merge, and the approval is of `approvedHead`. Pure. */
export function approvedHeadFor(p: Pick<PipelinePublishState, "head" | "approvedHead" | "carried"> | null | undefined, headSha: string): string {
  return p && p.carried > 0 && p.approvedHead && p.head === headSha ? p.approvedHead : headSha;
}

// ---------------------------------------------------------------------------
// Whose failure
// ---------------------------------------------------------------------------

export type BaseVerdict = "failed" | "passed" | "running" | "never";

/**
 * The control arm: does the unmodified base fail the same job? For each
 * failing job, the newest run of that name on the base's tip; when the tip
 * did not run it (the suite was not selected, or it was skipped or cancelled
 * there) the most recent base commit that did, in the order given (tip
 * first). `failed` → inherited. `passed`, or `never` run on the base → the
 * change's own. `running` → undecided yet. Names only: a job failing on both
 * sides does not prove the same test failed, and the cost of being wrong is
 * a wait that ends when the base recovers, after which it is judged again.
 */
export function baseVerdicts(names: readonly string[], baseCommits: readonly (readonly CheckRunLike[])[]): Record<string, BaseVerdict> {
  const perCommit = baseCommits.map((runs) => new Map(newestPerName(runs).map((r) => [r.name, r] as const)));
  const out: Record<string, BaseVerdict> = {};
  for (const name of names) {
    let verdict: BaseVerdict = "never";
    for (const runs of perCommit) {
      const r = runs.get(name);
      if (!r) continue;
      if (r.status !== "completed") {
        verdict = "running";
        break;
      }
      if (failedConclusion(r.conclusion)) {
        verdict = "failed";
        break;
      }
      if (r.conclusion === "success" || r.conclusion === "neutral") {
        verdict = "passed";
        break;
      }
      // skipped, cancelled, stale: this commit says nothing about the job.
    }
    out[name] = verdict;
  }
  return out;
}

/** Whether every name has a verdict the list so far can give — the caller
 *  reads older base commits only while this is false. */
export function verdictsSettled(verdicts: Record<string, BaseVerdict>): boolean {
  return Object.values(verdicts).every((v) => v !== "never");
}

/** The base tip's health before a push: red means a push now spends a CI run
 *  that must fail. Judged by the roll-up check (`required`) when the base
 *  has one — a failing optional check must not hold every card — otherwise
 *  by any failed check. */
export function baseHealth(checks: readonly CheckRunLike[]): { state: "green" | "red" | "pending" | "none"; failing: string[] } {
  const newest = newestPerName(checks);
  if (newest.length === 0) return { state: "none", failing: [] };
  const failing = newest.filter((r) => failedConclusion(r.conclusion));
  const causes = failing.filter((r) => !ROLLUP_CHECKS.has(r.name)).map((r) => r.name);
  const rollups = newest.filter((r) => ROLLUP_CHECKS.has(r.name));
  const red = rollups.length > 0 ? rollups.some((r) => failedConclusion(r.conclusion)) : failing.length > 0;
  if (red) return { state: "red", failing: causes.length ? causes : failing.map((r) => r.name) };
  const judged = rollups.length > 0 ? rollups : newest;
  return { state: judged.some((r) => r.status !== "completed") ? "pending" : "green", failing: [] };
}

// ---------------------------------------------------------------------------
// Observations and actions
// ---------------------------------------------------------------------------

export interface PublishFailedCheck {
  name: string;
  url: string | null;
  conclusion: string | null;
}

/** A trial merge of the base into the head, made without touching the
 *  worktree or any ref. `conflicts`: the conflicting files, null when clean.
 *  `samePatch`: `git patch-id` of `git diff base...HEAD` equals that of the
 *  merge commit against the base — the change's own diff is unchanged.
 *  `commit`: the merge commit object, when clean. */
export interface MergeProbe {
  conflicts: string[] | null;
  samePatch: boolean;
  commit: string | null;
}

export interface PullSeen {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string | null;
}

export type PublishApproval =
  | { kind: "approved"; headSha: string }
  /** Review's handoff has no `reviewApproval` block at all. */
  | { kind: "none" }
  /** It has one, and it is not a clean approval. */
  | { kind: "not-approved"; why: string };

export type PublishObservation =
  | { state: "verify-head"; dirty: string[]; head: string; tree: string; approval: PublishApproval; unreviewed: string[] }
  | { state: "check-merge" | "refresh"; baseTip: string; contains: boolean; merge: MergeProbe | null }
  | { state: "hold-base"; baseTip: string; checks: CheckRunLike[] }
  | { state: "push"; branch: string; localHead: string; remoteHead: string | null; remoteIsAncestor: boolean }
  | { state: "pr"; pull: PullSeen | null }
  | { state: "wait-ci" | "finalize"; pull: PullSeen | null; checks: CheckRunLike[] }
  | { state: "classify"; checks: CheckRunLike[]; baseCommits: CheckRunLike[][]; infra: string | null }
  | { state: "base-red"; baseTip: string; baseCommits: CheckRunLike[][] }
  /** Git or GitHub could not be read this pass. */
  | { state: "unreadable"; what: string };

export type BuildCause =
  | { kind: "not-approved"; why: string }
  | { kind: "dirty"; files: string[] }
  | { kind: "unapproved-head"; head: string; approvedHead: string; commits: string[] }
  | { kind: "conflict"; files: string[] }
  /** Merging the recovered base in would change the change's own diff. */
  | { kind: "changed-diff" }
  | { kind: "ci"; checks: PublishFailedCheck[]; inherited: string[] };

export type PublishAction =
  /** Move on with no side effect. */
  | { kind: "advance"; to: PublishStateName; set?: Partial<PipelinePublishState>; say?: string }
  /** Stay. Costs nothing: no agent, no slot, no attempt. */
  | { kind: "wait"; note: string; set?: Partial<PipelinePublishState> }
  /** Fast-forward the worktree to `commit` (the base merged into the head). */
  | { kind: "merge-base"; commit: string; baseTip: string; then: PublishStateName }
  | { kind: "push" }
  | { kind: "open-pr" }
  /** Re-run the head's failed (or cancelled) jobs, once per head and reason. */
  | { kind: "rerun"; why: "cancelled" | "infra" | "base-recovered"; reason: string }
  /** Leave for Build on the "verification failed" edge. */
  | { kind: "to-build"; cause: BuildCause }
  /** CI is green: mark the PR ready, post the facts, start the writer. */
  | { kind: "write" }
  /** This visit cannot be run by Agetor: its agent runs Finish as before. */
  | { kind: "agent"; why: string }
  | { kind: "owner"; why: string };

const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 8) || "unknown";
const list = (names: readonly string[], max = 4) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
const reran = (p: PipelinePublishState, why: PipelinePublishState["reran"][number]["why"]) =>
  p.reran.some((r) => r.head === p.head && r.why === why);

/** Re-runs of one head for a runner or network fault before the failure is
 *  treated as the change's own. Two: blips come in bursts (a mirror's DNS),
 *  and each one sent to Build costs a Build and a Review that change nothing. */
export const INFRA_RERUNS = 2;
const infraReruns = (p: PipelinePublishState) => p.reran.filter((r) => r.head === p.head && r.why === "infra").length;

/** The failing checks that can be a cause (never the roll-up), newest per name. */
export function failingCauses(checks: readonly CheckRunLike[]): PublishFailedCheck[] {
  return newestPerName(checks)
    .filter((r) => failedConclusion(r.conclusion) && !ROLLUP_CHECKS.has(r.name))
    .map((r) => ({ name: r.name, url: r.htmlUrl, conclusion: r.conclusion }));
}

/** The one next action. Pure. */
export function decidePublish(p: PipelinePublishState, obs: PublishObservation, now: number): PublishAction {
  const base = p.base ?? "the base";
  if (obs.state === "unreadable") return { kind: "wait", note: `couldn't read ${obs.what} — trying again` };
  if (obs.state !== p.state) return { kind: "wait", note: p.note };
  if (p.tries >= PUBLISH_MAX_TRIES) return { kind: "owner", why: `Agetor tried ${p.tries} times and could not get past "${STATE_NOTE[p.state]}": ${p.note}` };

  switch (obs.state) {
    case "verify-head": {
      if (obs.approval.kind === "none") {
        return { kind: "agent", why: "Review's handoff has no reviewApproval block, so there is no approved head for Agetor to publish" };
      }
      if (obs.approval.kind === "not-approved") return { kind: "to-build", cause: { kind: "not-approved", why: obs.approval.why } };
      if (obs.dirty.length > 0) return { kind: "to-build", cause: { kind: "dirty", files: obs.dirty } };
      const approved = obs.approval.headSha;
      // The base merged in by Agetor earlier in this visit is the approved
      // head's own carry-over, not a new commit to review.
      const carriedOver = p.carried > 0 && p.approvedHead === approved && p.head === obs.head;
      if (obs.head !== approved && !carriedOver) {
        return { kind: "to-build", cause: { kind: "unapproved-head", head: obs.head, approvedHead: approved, commits: obs.unreviewed } };
      }
      return { kind: "advance", to: "check-merge", set: { approvedHead: approved, head: obs.head, tree: obs.tree } };
    }

    case "check-merge": {
      if (obs.contains) return { kind: "advance", to: "hold-base", set: { baseTip: obs.baseTip } };
      if (!obs.merge) return { kind: "wait", note: `couldn't try the merge with ${base} — trying again` };
      if (obs.merge.conflicts) return { kind: "to-build", cause: { kind: "conflict", files: obs.merge.conflicts } };
      if (!obs.merge.samePatch || !obs.merge.commit) {
        // Clean, but the base took part of this change: the approved head is
        // published as it is, and GitHub's CI still tests it merged with the base.
        return {
          kind: "advance", to: "hold-base", set: { baseTip: obs.baseTip },
          say: `${base} moved, and merging it in would change this change's own diff — publishing the approved head as it is`,
        };
      }
      return { kind: "merge-base", commit: obs.merge.commit, baseTip: obs.baseTip, then: "hold-base" };
    }

    case "hold-base": {
      // The base moved while this waited: bring the new tip in first.
      if (p.baseTip && obs.baseTip !== p.baseTip) return { kind: "advance", to: "check-merge", set: { baseTip: obs.baseTip } };
      const health = baseHealth(obs.checks);
      if (health.state === "red") {
        return { kind: "wait", note: `${base} is failing ${list(health.failing)} — not pushing a CI run that must fail; Agetor publishes when ${base} is green` };
      }
      return { kind: "advance", to: "push" };
    }

    case "push": {
      if (!p.head || obs.localHead !== p.head) {
        return { kind: "advance", to: "verify-head", say: `HEAD is ${short(obs.localHead)}, not the head being published (${short(p.head)}) — checking it again` };
      }
      if (PROTECTED_BRANCHES.has(obs.branch) || obs.branch === p.base) {
        return { kind: "owner", why: `the card's branch is "${obs.branch}" — Agetor never pushes to a base branch` };
      }
      if (obs.remoteHead === p.head) return { kind: "advance", to: "pr" };
      if (obs.remoteHead && !obs.remoteIsAncestor) {
        return { kind: "owner", why: `origin/${obs.branch} (${short(obs.remoteHead)}) holds commits this worktree does not have — Agetor never force-pushes` };
      }
      return { kind: "push" };
    }

    case "pr": {
      const pull = obs.pull;
      if (!pull || pull.state === "closed") return { kind: "open-pr" };
      if (pull.state === "merged") return { kind: "owner", why: `PR #${pull.number} for this branch is already merged` };
      if (pull.headSha !== p.head) {
        if (now - p.stateSince > PUBLISH_PR_LAG_MS) {
          return { kind: "owner", why: `PR #${pull.number} still shows head ${short(pull.headSha)}, not the pushed ${short(p.head)}` };
        }
        return { kind: "wait", note: `waiting for GitHub to show the pushed head on PR #${pull.number}` };
      }
      return { kind: "advance", to: "wait-ci", set: { pr: { number: pull.number, url: pull.url } } };
    }

    case "wait-ci":
    case "finalize": {
      const pull = obs.pull;
      if (!pull || pull.state !== "open") {
        return { kind: "owner", why: pull ? `PR #${pull.number} was ${pull.state} while Finish waited for its CI` : "the pull request is gone" };
      }
      if (pull.headSha && pull.headSha !== p.head) {
        return { kind: "owner", why: `PR #${pull.number} is at ${short(pull.headSha)}, not the head Agetor published (${short(p.head)}) — something else pushed to the branch` };
      }
      const state = checksState(obs.checks);
      if (state === "success") return obs.state === "finalize" ? { kind: "write" } : { kind: "advance", to: "finalize" };
      if (obs.state === "finalize") return { kind: "advance", to: "wait-ci" };
      const last = p.reran.filter((r) => r.head === p.head).at(-1);
      if (last && now - last.at < PUBLISH_RERUN_SETTLE_MS) return { kind: "wait", note: "re-run requested — waiting for GitHub to start it" };
      if (state === "none") {
        if (now - p.stateSince > PUBLISH_NO_CHECKS_MS) {
          return { kind: "owner", why: `no check has started for ${short(p.head)} on PR #${pull.number} in ${Math.round(PUBLISH_NO_CHECKS_MS / 60_000)} minutes` };
        }
        return { kind: "wait", note: `waiting for CI to start on ${short(p.head)}` };
      }
      const newest = newestPerName(obs.checks);
      const running = newest.filter((r) => r.status !== "completed");
      if (running.length > 0) {
        return { kind: "wait", note: `CI running on ${short(p.head)} (PR #${pull.number}): ${newest.length - running.length} of ${newest.length} checks finished` };
      }
      if (state === "failure") return { kind: "advance", to: "classify" };
      // Nothing running and nothing failed, yet not a pass: the newest run
      // of some check was cancelled and nothing replaced it.
      const cancelled = newest.filter((r) => r.conclusion === "cancelled").map((r) => r.name);
      if (!reran(p, "cancelled")) return { kind: "rerun", why: "cancelled", reason: `${list(cancelled)} was cancelled and nothing replaced it` };
      return { kind: "owner", why: `CI for ${short(p.head)} was cancelled again after one re-run (${list(cancelled)})` };
    }

    case "classify": {
      if (checksState(obs.checks) !== "failure") return { kind: "advance", to: "wait-ci" };
      const failing = failingCauses(obs.checks);
      if (failing.length === 0) {
        // Only the roll-up failed: a suite it needs was cancelled or never ran.
        if (!reran(p, "cancelled")) return { kind: "rerun", why: "cancelled", reason: "the roll-up check failed with no failed suite behind it" };
        return { kind: "owner", why: `the roll-up check failed on ${short(p.head)} with no failed suite behind it, again after one re-run` };
      }
      if (obs.infra && infraReruns(p) < INFRA_RERUNS) return { kind: "rerun", why: "infra", reason: obs.infra };
      const verdicts = baseVerdicts(failing.map((f) => f.name), obs.baseCommits);
      const own = failing.filter((f) => verdicts[f.name] === "passed" || verdicts[f.name] === "never");
      const inherited = failing.filter((f) => verdicts[f.name] === "failed").map((f) => f.name);
      if (own.length > 0) return { kind: "to-build", cause: { kind: "ci", checks: own, inherited } };
      const undecided = failing.filter((f) => verdicts[f.name] === "running").map((f) => f.name);
      if (undecided.length > 0) {
        return { kind: "wait", note: `CI failed on ${list(failing.map((f) => f.name))}; ${base} is still running ${list(undecided)} — whose failure it is gets decided when that finishes` };
      }
      return {
        kind: "advance", to: "base-red", set: { inherited },
        say: `CI failed only on checks ${base} fails too (${list(inherited)}) — parked without an agent until ${base} is green`,
      };
    }

    case "base-red": {
      const verdicts = baseVerdicts(p.inherited, obs.baseCommits);
      const failed = p.inherited.filter((n) => verdicts[n] === "failed");
      if (failed.length > 0) {
        return {
          kind: "wait", set: { baseTip: obs.baseTip },
          note: `${base} is failing ${list(failed)} — parked: no agent, no step slot, no attempt spent. Agetor re-tests this change when ${base} is green`,
        };
      }
      const running = p.inherited.filter((n) => verdicts[n] === "running");
      if (running.length > 0) return { kind: "wait", set: { baseTip: obs.baseTip }, note: `${base} is re-running ${list(running)} — re-testing this change when it passes` };
      return { kind: "advance", to: "refresh", set: { baseTip: obs.baseTip }, say: `${base} is green again (${list(p.inherited)}) — re-testing this change against it` };
    }

    case "refresh": {
      if (obs.contains) {
        // The base recovered without a new commit: the PR's merge commit is
        // unchanged, so the failed jobs are re-run rather than anything pushed.
        if (!reran(p, "base-recovered")) return { kind: "rerun", why: "base-recovered", reason: `${base} was failing the same checks and has recovered` };
        return { kind: "advance", to: "wait-ci" };
      }
      if (!obs.merge) return { kind: "wait", note: `couldn't try the merge with ${base} — trying again` };
      if (obs.merge.conflicts) return { kind: "to-build", cause: { kind: "conflict", files: obs.merge.conflicts } };
      if (!obs.merge.samePatch || !obs.merge.commit) return { kind: "to-build", cause: { kind: "changed-diff" } };
      // The merge is a new head: it goes out through `push`, the one place
      // that pushes, and CI runs on it once.
      return { kind: "merge-base", commit: obs.merge.commit, baseTip: obs.baseTip, then: "push" };
    }
  }
}

/** What an effect came back with. */
export type PublishResult =
  | { ok: true; head?: string; tree?: string; pr?: { number: number; url: string } }
  | { ok: false; error: string };

/**
 * The state after `action` was carried out with `result`. `to-build`,
 * `write`, `agent` and `owner` end the held visit and are the runner's to
 * record (src/bun/pipeline-runner.ts), so they leave the state as it is. Pure.
 */
export function applyPublish(p: PipelinePublishState, action: PublishAction, result: PublishResult, now: number): PipelinePublishState {
  const enter = (to: PublishStateName, more: Partial<PipelinePublishState> = {}, note?: string): PipelinePublishState =>
    ({ ...p, ...more, state: to, stateSince: now, tries: 0, note: note ?? STATE_NOTE[to] });
  const failed = (what: string): PipelinePublishState => {
    const error = result.ok ? "" : result.error.replace(/\s+/g, " ").trim().slice(0, 200);
    return { ...p, tries: p.tries + 1, note: `${what} failed (attempt ${p.tries + 1} of ${PUBLISH_MAX_TRIES}): ${error}` };
  };
  switch (action.kind) {
    case "advance":
      return enter(action.to, action.set, action.say);
    case "wait":
      return { ...p, ...action.set, note: action.note };
    case "merge-base":
      if (!result.ok) return failed("merging the base in");
      return enter(action.then, { head: result.head ?? action.commit, tree: result.tree ?? p.tree, baseTip: action.baseTip, carried: p.carried + 1 });
    case "push":
      return result.ok ? enter("pr") : failed("the push");
    case "open-pr":
      return result.ok && result.pr ? enter("wait-ci", { pr: result.pr }) : failed("opening the pull request");
    case "rerun":
      if (!result.ok) return failed("the re-run request");
      return enter("wait-ci", { reran: [...p.reran, { head: p.head ?? "", why: action.why, at: now }].slice(-12) });
    default:
      return p;
  }
}

/** The card's one line while Finish is held. */
export function publishBlockMessage(stepName: string, p: Pick<PipelinePublishState, "note">): string {
  return `${stepName} is run by Agetor: ${p.note}`;
}

// ---------------------------------------------------------------------------
// What Build is told, what the agent is asked to write, what Agetor posts
// ---------------------------------------------------------------------------

const BUILD_RULES =
  "This arrives as a verification failure found by Agetor while it ran Finish (no agent published anything): fix it locally and commit, " +
  "do not push and do not touch the pull request. Review re-reviews the result and Finish publishes the approved commit with one push.";

/** The handoff Build receives for a failure Agetor can describe without CI
 *  logs (CI failures and conflicts use src/bun/merge-rework.ts's). Pure. */
export function publishBuildHandoff(
  cause: Exclude<BuildCause, { kind: "ci" } | { kind: "conflict" }>,
  ctx: { base: string; next: string },
): Handoff {
  const made = (purpose: string, summary: string, reason: string): Handoff => ({
    schemaVersion: 1, status: "done", purpose: `Verification failed: ${purpose}`, summary: `${summary} ${BUILD_RULES}`,
    reason, next: ctx.next, artifacts: [], openQuestions: [],
  });
  switch (cause.kind) {
    case "dirty": {
      const files = cause.files.slice(0, 40).map((f) => `- ${f}`).join("\n");
      return made(
        "the working tree has uncommitted changes",
        `Finish publishes a commit, and the worktree has tracked changes that are in none:\n${files}\n\nCommit what belongs to the change and discard what does not.`,
        "uncommitted tracked changes in the worktree",
      );
    }
    case "unapproved-head": {
      const commits = cause.commits.length
        ? `Commits Review has not seen:\n${cause.commits.slice(0, 30).map((c) => `- ${c}`).join("\n")}`
        : `The approved head is not an ancestor of HEAD (\`git log ${short(cause.approvedHead)}..HEAD\`).`;
      return made(
        "HEAD is not the head Review approved",
        `Review approved ${cause.approvedHead}, and HEAD is ${cause.head}. Only the exact approved head is published. ${commits}\n\n` +
          "If those commits belong to the change, hand off to Review so it reviews this head; if they do not, remove them.",
        `HEAD ${short(cause.head)} differs from the approved ${short(cause.approvedHead)}`,
      );
    }
    case "not-approved":
      return made(
        "Review did not approve this head",
        `The last Review handoff is not a clean approval (${cause.why}). Address its findings, then hand off to Review.`,
        cause.why,
      );
    case "changed-diff":
      return made(
        `${ctx.base} recovered, and merging it in changes this change's own diff`,
        `CI failed only on checks ${ctx.base} was failing too, and ${ctx.base} is green again. Agetor merges it in itself when that leaves the change's own diff ` +
          `untouched (\`git patch-id\` of \`git diff origin/${ctx.base}...HEAD\`); here it does not, so the merge needs a look. ` +
          `\`git fetch origin ${ctx.base}\`, merge origin/${ctx.base} into this branch (a merge commit — never a rebase), check what it did to the change, and commit.`,
        `merging origin/${ctx.base} changes the change's own diff`,
      );
  }
}

/** What Agetor did and saw, for the writer's brief and the evidence comment. */
export interface PublishFacts {
  branch: string;
  base: string;
  pr: { number: number; url: string };
  head: string;
  tree: string | null;
  approvedHead: string;
  carried: number;
  baseTip: string | null;
  checks: { name: string; conclusion: string | null; url: string | null }[];
  reran: PipelinePublishState["reran"];
}

/** The comment Agetor posts once CI is green: facts only. Pure. */
export function publishEvidenceComment(f: PublishFacts): string {
  const carried = f.carried > 0
    ? `- Approved by Review: \`${f.approvedHead}\`. Agetor merged \`origin/${f.base}\` into it ${f.carried === 1 ? "once" : `${f.carried} times`}; the change's own diff is unchanged (\`git patch-id\` of \`git diff ${f.base}...HEAD\`), so the approval carries over.`
    : `- Approved by Review: \`${f.approvedHead}\` — the head published.`;
  const reruns = f.reran.length
    ? [`- Re-runs requested by Agetor: ${f.reran.map((r) => `${r.why} (\`${short(r.head)}\`)`).join(", ")}`]
    : [];
  return [
    "### Published by Agetor",
    "",
    `- Head: \`${f.head}\`${f.tree ? ` (tree \`${f.tree}\`)` : ""}, pushed once to \`${f.branch}\``,
    carried,
    `- Base: \`${f.base}\`${f.baseTip ? ` at \`${f.baseTip}\`` : ""}`,
    ...reruns,
    `- Checks on this head, newest run of each (${f.checks.length}):`,
    ...f.checks.map((c) => `  - ${c.name}: ${c.conclusion ?? "unknown"}${c.url ? ` — ${c.url}` : ""}`),
    "",
    "These are observations Agetor made itself; no agent pushed, waited for or judged this run.",
  ].join("\n");
}

/** The Finish step's instructions for its one agent turn. Pure. */
export function publishWriterBrief(f: PublishFacts & { issueUrl: string | null; factsPosted: boolean; markedReady: boolean }): string {
  const head = f.carried > 0
    ? `HEAD ${f.head} is the head Review approved (${f.approvedHead}) with origin/${f.base} merged in by Agetor; the change's own diff is unchanged`
    : `HEAD ${f.head} is the exact head Review approved`;
  return [
    "Finish is run by Agetor for this card. Everything mechanical is done; your part is the writing.",
    "",
    "What Agetor already did and checked itself:",
    `- The working tree is clean and ${head}.`,
    `- It pushed that head once to \`${f.branch}\` and ${`pull request #${f.pr.number} (${f.pr.url}) is open against \`${f.base}\``}.`,
    `- CI finished on that head and every check passed: ${f.checks.map((c) => c.name).join(", ") || "(none listed)"}.`,
    f.markedReady ? "- The pull request is marked ready for review." : "- The pull request could not be marked ready; the merge queue does that.",
    f.factsPosted ? "- A comment on the pull request records these facts (head, base, checks)." : "- The facts comment could not be posted; put the head and the passed checks in the description.",
    "",
    "Do this, and only this:",
    `1. Rewrite the pull request's description so a reviewer can act on it without opening the card: Summary, Why, Impact, How it was verified, Review focus. ` +
      `Take it from the handoffs and reports above. Write it to a file and apply it with \`gh pr edit ${f.pr.number} --body-file <file>\`. ` +
      `Keep the closing line the earlier steps chose${f.issueUrl ? ` for ${f.issueUrl}` : ""} (\`Fixes #n\` when the change completes the issue, \`Refs #n\` when it does not).`,
    "2. If the acceptance criteria need mapping to evidence that the description does not carry, add ONE comment with it. Otherwise add none.",
    "",
    "Do not push, commit, merge, rebase or amend. Do not re-run or wait for CI: it has passed. Do not change code, and do not mark or merge the pull request. " +
      "If you find something wrong with the change, say so in the handoff summary; it is not fixed in this step.",
    "",
    `Then hand off with "status": "done", "next": null, and ${f.pr.url} in "artifacts".`,
  ].join("\n");
}
