/**
 * Velocity for Autopilot's roadmap mode (FORK.md "Velocity"): how fast steps
 * complete, where a step's time goes, how full the slots are, what holds the
 * most work back, and a forecast range. This file is the pure part — shared
 * by the core (src/bun/roadmap-velocity.ts keeps the ledger and feeds it),
 * the board (VelocityDialog.tsx) and the CLI (`agetor roadmap velocity`).
 * No I/O, no clock: `now` always comes in.
 *
 * Definitions, in one place:
 *
 *   cycle time — card start (the pipeline run's start) → the issue closed.
 *   lead time  — the step became ready (its last predecessor's issue closed,
 *                never earlier than the run began) → the issue closed.
 *   active     — time inside a pipeline step (Understand, Build, Review,
 *                Finish, follow-ups such as Fix CI, any other step).
 *   waiting    — everything else between card start and issue closed: CI and
 *                the merge queue, held for the owner, usage-limit waits,
 *                waiting for a step slot, other (automatic retries).
 *   flow efficiency — active ÷ (active + waiting).
 *
 * Nothing here guesses: a fact that wasn't recorded is null, and a stretch
 * with no ledger sample (the app was closed) is "unknown", never "blocked".
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ── Facts ─────────────────────────────────────────────────────────────────

export const ACTIVE_PHASES = ["understand", "build", "review", "finish", "fixup", "step"] as const;
export const WAITING_PHASES = ["merge", "owner", "quota", "slot", "other"] as const;
export type VelocityPhase = (typeof ACTIVE_PHASES)[number] | (typeof WAITING_PHASES)[number];
export const PHASES: readonly VelocityPhase[] = [...ACTIVE_PHASES, ...WAITING_PHASES];

export const PHASE_LABEL: Record<VelocityPhase, string> = {
  understand: "Understand",
  build: "Build",
  review: "Review",
  finish: "Finish",
  fixup: "Follow-ups (Fix CI, conflicts)",
  step: "Other steps",
  merge: "CI and merge queue",
  owner: "Held for you",
  quota: "Usage-limit waits",
  slot: "Waiting for a step slot",
  other: "Automatic retries",
};

export const isActivePhase = (p: VelocityPhase): boolean => (ACTIVE_PHASES as readonly string[]).includes(p);

export type PhaseTimes = Partial<Record<VelocityPhase, number>>;

/** One execution of a pipeline step, from the run's history. */
export interface VelocityRecord {
  stepId: string;
  /** The step's name in the run's snapshot (falls back to the id). */
  name: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  /** Its handoff said "blocked". */
  blocked: boolean;
  /** The steps it handed to. */
  next: string[];
}

/** A card that worked a step: its run history and its activity timeline. */
export interface VelocityCard {
  cardId: string;
  /** The pipeline run's start; null when it has none (then the first record). */
  runStartedAt: number | null;
  records: VelocityRecord[];
  activity: { ts: number; text: string }[];
  /** What the passes saw the card doing (the ledger's card events): a
   *  stretch blocked on the owner, waiting on a usage limit, or in an
   *  automatic retry. The run's history can't show these — a step that is
   *  retried keeps its record open — so they take precedence over it. */
  observed?: { from: number; to: number; state: "blocked" | "quota" | "retry" }[];
}

/** How a completed step got done:
 *  card    — a card of Agetor's worked it (cycle time and phases measured);
 *  no-card — its issue closed with no card to be found: closed by hand, done
 *            outside Agetor, or the card was deleted. Counts for throughput;
 *            has no cycle time. */
export type VelocityHow = "card" | "no-card";

/** What is kept about a completed step — written to the ledger when the
 *  step completes, so it survives its card being archived or deleted. */
export interface VelocityStepFacts {
  step: string;
  issue: number;
  /** The table's milestone column. */
  stage: string;
  human: boolean;
  closedAt: number;
  /** Where `closedAt` came from: GitHub's `closedAt`, the card's "Closed
   *  issue" timeline entry, or the pass that first saw it closed. */
  closedFrom: "github" | "activity" | "observed";
  /** Last predecessor closed (≥ the run's start); null = unknown. */
  readyAt: number | null;
  how: VelocityHow;
  cardId: string | null;
  /** How many cards worked it (2+ after a redo). */
  cards: number;
  startedAt: number | null;
  prOpenedAt: number | null;
  mergedAt: number | null;
  /** Time per phase, ms; sums to `closedAt - startedAt`. Null when the card
   *  has no step history to split. */
  phases: PhaseTimes | null;
  /** Review visits (1 = approved first time). */
  reviewRounds: number | null;
  /** Finish handing back to Build. */
  finishBounces: number | null;
  /** Automatic Fix CI runs. */
  fixCi: number | null;
  /** Times a step of it ran into a usage limit. */
  quotaHits: number | null;
  /** Reconstructed later from records, not at the time it completed. */
  backfilled?: boolean;
}

const phaseOfRecord = (r: Pick<VelocityRecord, "stepId" | "name">): VelocityPhase => {
  if (r.stepId.startsWith("followup-")) return "fixup";
  for (const key of [r.name, r.stepId]) {
    const k = key.trim().toLowerCase();
    if (k.startsWith("understand")) return "understand";
    if (k.startsWith("build")) return "build";
    if (k.startsWith("review")) return "review";
    if (k.startsWith("finish")) return "finish";
  }
  return "step";
};

// The activity timeline is prose; these are the sentences this file reads.
// Each is written by the module named beside it.
const RE = {
  /** src/bun/pr-watch.ts `prActivity`, `openPr` */
  prOpened: /^PR #\d+ opened$|opened PR #\d+$/,
  /** pr-watch.ts, merge-queue.ts, merge-train.ts */
  merged: /^PR #\d+ merged$|^Merged PR #\d+ into |^Merged in merge train #\d+/,
  /** pr-watch.ts `closeIssueForMergedPr` */
  issueClosed: /^Closed issue #\d+ /,
  /** autopilot.ts `signOffPass` (both wordings), server.ts task PATCH */
  holdStart: /left in In Review for you|^Sign-off withdrawn/,
  /** …or the card reaching the merge queue by the owner's hand (merge-queue.ts, merge-train.ts) */
  holdEnd: /^Autopilot: signed off PR #\d+|the hold is lifted|^Green — waiting|^Joined merge train|^Updated PR #\d+ from /,
  /** pipeline-runner.ts `scheduleAutoRetry` */
  quota: /is waiting on a usage limit/,
  retry: /retrying automatically/,
  /** pr-watch.ts `maybeAutoFix` */
  fixCi: /^Started Fix CI automatically/,
  /** autopilot.ts `roadmapPass` restart guard */
  stuck: /Not starting another card for it/,
};

interface CardWindow {
  startedAt: number;
  phases: PhaseTimes;
  prOpenedAt: number | null;
  mergedAt: number | null;
  issueClosedAt: number | null;
  reviewRounds: number;
  finishBounces: number;
  fixCi: number;
  quotaHits: number;
  /** The start of a hold still running at `until`. */
  heldSince: number | null;
  /** The phase at `until`. */
  last: VelocityPhase;
}

/** When a card started: its run's start, else its first step. */
export const cardStartedAt = (c: VelocityCard): number | null => {
  const first = c.records.length ? Math.min(...c.records.map((r) => r.startedAt)) : null;
  return c.runStartedAt != null && first != null ? Math.min(c.runStartedAt, first) : (c.runStartedAt ?? first);
};

/**
 * Split a card's time from its start until `until` into phases. Every
 * instant gets exactly one label, so the phases sum to `until - start`:
 * what a pass observed (blocked → the owner's, a usage-limit wait, a retry);
 * else inside a step record → that step; else held for the owner, a
 * usage-limit wait, the wait after a block or failure (the owner's, unless
 * an automatic retry was announced), CI and the merge queue once the run's
 * last step has finished, and otherwise waiting for a step slot. Pure.
 */
export function cardWindow(card: VelocityCard, until: number): CardWindow | null {
  const start = cardStartedAt(card);
  if (start == null || until <= start) return null;
  const records = [...card.records].sort((a, b) => a.startedAt - b.startedAt);
  const acts = [...card.activity].filter((a) => a.ts <= until).sort((a, b) => a.ts - b.ts);
  const first = (re: RegExp) => acts.find((a) => re.test(a.text))?.ts ?? null;
  const mergedAt = first(RE.merged);
  const stuckAt = first(RE.stuck);
  const nextRecordAfter = (t: number) => records.find((r) => r.startedAt > t)?.startedAt ?? until;

  // Holds: from the sentence that says so to the sign-off, the merge, or `until`.
  const holds: [number, number][] = [];
  let heldSince: number | null = null;
  for (const a of acts) {
    if (RE.holdStart.test(a.text)) heldSince ??= a.ts;
    else if (heldSince != null && (RE.holdEnd.test(a.text) || RE.merged.test(a.text))) {
      holds.push([heldSince, a.ts]);
      heldSince = null;
    }
  }
  if (heldSince != null) holds.push([heldSince, until]);
  const quotas: [number, number][] = acts.filter((a) => RE.quota.test(a.text)).map((a) => [a.ts, nextRecordAfter(a.ts)]);
  const retries = acts.filter((a) => RE.retry.test(a.text) && !RE.quota.test(a.text)).map((a) => a.ts);
  const within = (xs: [number, number][], t: number) => xs.some(([a, b]) => t >= a && t < b);

  const OBSERVED = { blocked: "owner", quota: "quota", retry: "other" } as const;
  const seen = (card.observed ?? []).filter((o) => o.to > start && o.from < until);
  const label = (t: number): VelocityPhase => {
    const o = seen.find((x) => t >= x.from && t < x.to);
    if (o) return OBSERVED[o.state];
    let inside: VelocityRecord | null = null;
    let prev: VelocityRecord | null = null;
    for (const r of records) {
      if (r.startedAt > t) break;
      if ((r.endedAt ?? until) > t) inside = r;
      else if (!prev || (r.endedAt ?? 0) >= (prev.endedAt ?? 0)) prev = r;
    }
    if (inside) return phaseOfRecord(inside);
    if (stuckAt != null && t >= stuckAt) return "owner";
    if (within(holds, t)) return "owner";
    if (within(quotas, t)) return "quota";
    if (!prev) return "slot";
    // Blocked with nowhere to go, failed or stopped — not a "blocked" handoff
    // that still named the next step.
    if ((prev.blocked && prev.next.length === 0) || prev.outcome === "failed" || prev.outcome === "cancelled") {
      const from = prev.endedAt ?? prev.startedAt;
      const to = nextRecordAfter(from);
      return retries.some((ts) => ts >= from - 5_000 && ts <= to) ? "other" : "owner";
    }
    if (prev.next.length === 0 || (mergedAt != null && t >= mergedAt)) return "merge";
    return "slot";
  };

  const cuts = new Set<number>([start, until]);
  const cut = (t: number | null | undefined) => {
    if (t != null && t > start && t < until) cuts.add(t);
  };
  for (const r of records) {
    cut(r.startedAt);
    cut(r.endedAt);
  }
  for (const [a, b] of [...holds, ...quotas, ...seen.map((o) => [o.from, o.to] as [number, number])]) {
    cut(a);
    cut(b);
  }
  cut(mergedAt);
  cut(stuckAt);
  const ts = [...cuts].sort((a, b) => a - b);
  const phases: PhaseTimes = {};
  let last: VelocityPhase = "slot";
  for (let i = 0; i + 1 < ts.length; i++) {
    last = label((ts[i]! + ts[i + 1]!) / 2);
    phases[last] = (phases[last] ?? 0) + (ts[i + 1]! - ts[i]!);
  }
  const started = records.filter((r) => r.startedAt < until);
  const buildIds = new Set(started.filter((r) => phaseOfRecord(r) === "build").map((r) => r.stepId));
  return {
    startedAt: start,
    phases,
    prOpenedAt: first(RE.prOpened),
    mergedAt,
    issueClosedAt: first(RE.issueClosed),
    reviewRounds: started.filter((r) => phaseOfRecord(r) === "review").length,
    finishBounces: started.filter((r) => phaseOfRecord(r) === "finish" && r.next.some((n) => buildIds.has(n) || n.toLowerCase().startsWith("build"))).length,
    fixCi: acts.filter((a) => RE.fixCi.test(a.text)).length,
    quotaHits: acts.filter((a) => RE.quota.test(a.text)).length,
    heldSince: holds.length && holds[holds.length - 1]![1] === until ? holds[holds.length - 1]![0] : null,
    last,
  };
}

const addPhases = (into: PhaseTimes, from: PhaseTimes): PhaseTimes => {
  for (const [k, v] of Object.entries(from)) into[k as VelocityPhase] = (into[k as VelocityPhase] ?? 0) + (v ?? 0);
  return into;
};

/**
 * The facts of a completed step, from the cards that worked it. `closedAt`
 * is GitHub's when it is known (`github`), else the card's own "Closed
 * issue" entry, else `observedAt` — the pass that first saw it closed.
 * With several cards (a redo) each one's time runs until the next starts.
 * A card that never started, or started after the issue closed, isn't
 * counted; with none left the step is `no-card`. Pure.
 */
export function stepFacts(input: {
  step: { step: string; issue: number; stage: string; human: boolean };
  cards: VelocityCard[];
  closedAt: number | null;
  observedAt: number;
  readyAt: number | null;
  backfilled?: boolean;
}): VelocityStepFacts {
  const { step } = input;
  const activityClose = input.cards.flatMap((c) => c.activity.filter((a) => RE.issueClosed.test(a.text)).map((a) => a.ts)).sort((a, b) => a - b)[0] ?? null;
  const closedAt = input.closedAt ?? activityClose ?? input.observedAt;
  const closedFrom = input.closedAt != null ? "github" : activityClose != null ? "activity" : "observed";
  const base: VelocityStepFacts = {
    step: step.step,
    issue: step.issue,
    stage: step.stage,
    human: step.human,
    closedAt,
    closedFrom,
    readyAt: input.readyAt != null && input.readyAt <= closedAt ? input.readyAt : null,
    how: "no-card",
    cardId: null,
    cards: 0,
    startedAt: null,
    prOpenedAt: null,
    mergedAt: null,
    phases: null,
    reviewRounds: null,
    finishBounces: null,
    fixCi: null,
    quotaHits: null,
    ...(input.backfilled ? { backfilled: true } : {}),
  };
  const cards = input.cards
    .map((c) => ({ c, at: cardStartedAt(c) }))
    .filter((x): x is { c: VelocityCard; at: number } => x.at != null && x.at < closedAt)
    .sort((a, b) => a.at - b.at);
  if (cards.length === 0) return base;
  const out: VelocityStepFacts = { ...base, how: "card", cardId: cards[cards.length - 1]!.c.cardId, cards: cards.length, startedAt: cards[0]!.at, reviewRounds: 0, finishBounces: 0, fixCi: 0, quotaHits: 0 };
  const phases: PhaseTimes = {};
  let split = false;
  cards.forEach(({ c }, i) => {
    const until = i + 1 < cards.length ? cards[i + 1]!.at : closedAt;
    const w = cardWindow(c, until);
    if (!w) return;
    if (c.records.length > 0) split = true;
    addPhases(phases, w.phases);
    out.reviewRounds! += w.reviewRounds;
    out.finishBounces! += w.finishBounces;
    out.fixCi! += w.fixCi;
    out.quotaHits! += w.quotaHits;
    out.prOpenedAt = w.prOpenedAt ?? out.prOpenedAt;
    out.mergedAt = w.mergedAt ?? out.mergedAt;
  });
  // A card with no step history (a plain task) can't be split.
  if (split) out.phases = phases;
  else out.reviewRounds = out.finishBounces = null;
  return out;
}

// ── The ledger's samples ──────────────────────────────────────────────────

/** One observation of the run, written by a roadmap pass. The state holds
 *  until the next sample — unless that is more than `SAMPLE_GAP_MS` away. */
export interface VelocitySample {
  t: number;
  /** `maxInFlight`. */
  max: number;
  /** Slots in use (cards progressing), 0…max. */
  used: number;
  /** Slots are idle and no agent step in scope can start: what is left
   *  waits on unfinished steps, on the owner, or on other milestones. */
  blocked: boolean;
  /** New starts are held while a card waits for a usage limit to reset. */
  quota: boolean;
  /** Ready agent steps not started (they wait for a slot). */
  ready: number;
  /** Steps waiting on the owner (held, needing an answer, the owner's own). */
  held: number;
}

/** An hour of samples, folded when the ledger is compacted. */
export interface VelocityHour {
  /** Start of the hour. */
  t: number;
  /** Time covered by samples, ms (the rest of the hour is unknown). */
  known: number;
  /** ∫ max dt and ∫ used dt, in slot·ms. */
  slotMs: number;
  usedMs: number;
  blockedMs: number;
  quotaMs: number;
}

/** A pass runs at least every 5 minutes (15 as a fallback): two samples
 *  further apart than this mean nothing was watching — the app was closed
 *  or Autopilot paused — and the stretch is unknown. */
export const SAMPLE_GAP_MS = 20 * 60_000;

/** Fold samples into hours. The last sample holds until `now` when that is
 *  within the gap. Pure. */
export function foldSamples(samples: VelocitySample[], now: number): VelocityHour[] {
  const hours = new Map<number, VelocityHour>();
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  sorted.forEach((s, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1]!.t : now;
    if (end <= s.t || end - s.t > SAMPLE_GAP_MS) return; // unknown
    for (let a = s.t; a < end; ) {
      const h = Math.floor(a / HOUR) * HOUR;
      const b = Math.min(end, h + HOUR);
      const e = hours.get(h) ?? { t: h, known: 0, slotMs: 0, usedMs: 0, blockedMs: 0, quotaMs: 0 };
      const dt = b - a;
      e.known += dt;
      e.slotMs += s.max * dt;
      e.usedMs += Math.min(s.used, s.max) * dt;
      if (s.blocked) e.blockedMs += dt;
      if (s.quota) e.quotaMs += dt;
      hours.set(h, e);
      a = b;
    }
  });
  return [...hours.values()].sort((a, b) => a.t - b.t);
}

/** Hours from an earlier compaction plus the samples still kept. */
export function mergeHours(a: VelocityHour[], b: VelocityHour[]): VelocityHour[] {
  const out = new Map<number, VelocityHour>();
  for (const h of [...a, ...b]) {
    const e = out.get(h.t);
    if (!e) out.set(h.t, { ...h });
    else {
      e.known = Math.min(HOUR, e.known + h.known);
      e.slotMs += h.slotMs;
      e.usedMs += h.usedMs;
      e.blockedMs += h.blockedMs;
      e.quotaMs += h.quotaMs;
    }
  }
  return [...out.values()].sort((x, y) => x.t - y.t);
}

// ── The roadmap as the report sees it ─────────────────────────────────────

export interface VelocityGraphStep {
  step: string;
  issue: number;
  title: string;
  stage: string;
  human: boolean;
  preds: string[];
  status: "complete" | "declined" | "open";
  closedAt: number | null;
}

/** A step being worked, or waiting on the owner, as of the snapshot. */
export interface VelocityOpenStep {
  issue: number;
  /** building — a card is progressing; merging — its run finished, the PR is
   *  in CI or the merge queue; held — in In Review for the owner's sign-off;
   *  stuck — its card finished and the issue is still open (needs you);
   *  blocked — its run stopped on a block; quota — it waits for a usage
   *  limit to reset; retry — an automatic retry is pending. */
  state: "building" | "merging" | "held" | "stuck" | "blocked" | "quota" | "retry";
  cardId: string | null;
  startedAt: number | null;
  /** Since when it has been waiting on the owner (held, stuck, blocked). */
  since: number | null;
}

export interface VelocityInput {
  now: number;
  tracker: number;
  /** When the snapshot (steps, open steps) was taken. */
  asOf: number;
  maxInFlight: number;
  /** When this run began; null = unknown (then nothing is "before the run"). */
  runStartedAt: number | null;
  steps: VelocityGraphStep[];
  /** The milestones being worked, and their steps; null = the whole roadmap. */
  scope: { label: string; steps: string[] } | null;
  view: "current" | "roadmap";
  facts: VelocityStepFacts[];
  open: VelocityOpenStep[];
  samples: VelocitySample[];
  hours: VelocityHour[];
  /** The owner's assumed time per owner step; null/undefined = the median
   *  observed so far when there are at least `MIN_OWNER_SAMPLE`. */
  ownerDelayMs?: number | null;
  /** The step that is the main-release gate (an issue number), when the
   *  owner named it; else the first step whose title reads like one. */
  gateIssue?: number | null;
  seed?: number;
}

// ── Statistics ────────────────────────────────────────────────────────────

/** Linear interpolation between order statistics (R type 7): the median of
 *  [1, 2, 3, 10] is 2.5, its p75 4.75. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface Distribution {
  n: number;
  median: number;
  p75: number;
  p90: number;
  min: number;
  max: number;
  mean: number;
}

export function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9), min: s[0]!, max: s[s.length - 1]!, mean: s.reduce((a, b) => a + b, 0) / s.length };
}

/** A small seeded generator (mulberry32): the same seed, the same forecast. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Forecast ──────────────────────────────────────────────────────────────

/** Below this many agent steps completed in the run with a measured cycle
 *  time, or this little history, there is no forecast: "not enough data". */
export const MIN_FORECAST_STEPS = 5;
export const MIN_FORECAST_MS = 6 * HOUR;
/** Owner steps completed in the run before their median is used as a default. */
export const MIN_OWNER_SAMPLE = 3;
/** Full days of history before daily completions are resampled. */
export const MIN_BOOTSTRAP_DAYS = 7;
export const SIM_RUNS = 200;
const SIM_MAX_STEPS = 3000;

interface SimStep {
  id: string;
  human: boolean;
  preds: string[];
  /** Already started: how long ago. */
  elapsed: number | null;
}

export interface SimSample {
  cycle: number;
  /** How long of it the step held a slot. */
  slot: number;
}

/**
 * One run of the roadmap forward from now: steps start in table order when
 * every predecessor is complete and a slot is free (`max` at once); an agent
 * step takes a cycle time drawn from the observed ones and frees its slot
 * after the observed slot time; an owner step takes `ownerDelay` from the
 * moment it is ready and no slot. Returns the time until every step is
 * complete, or null when some step can never start. Pure, deterministic for
 * a given generator.
 */
export function simulateOnce(steps: SimStep[], max: number, samples: SimSample[], ownerDelay: number, rand: () => number): number | null {
  const draw = () => samples[Math.floor(rand() * samples.length)]!;
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const waiting = steps.map((s) => s.preds.filter((p) => index.has(p)).length);
  const succ: number[][] = steps.map(() => []);
  steps.forEach((s, i) => s.preds.forEach((p) => index.has(p) && succ[index.get(p)!]!.push(i)));
  const running: { i: number; done: number; free: number }[] = [];
  const ready: number[] = [];
  let left = steps.length;
  let time = 0;
  const becomeReady = (i: number) => {
    if (steps[i]!.human) return void running.push({ i, done: time + ownerDelay, free: time });
    // Kept in table order.
    let lo = 0;
    let hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ready[mid]! < i) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, i);
  };
  steps.forEach((s, i) => {
    if (s.elapsed != null && !s.human) {
      // Conditional on having run this long already.
      const longer = samples.filter((x) => x.cycle > s.elapsed!);
      const pick = longer.length ? longer[Math.floor(rand() * longer.length)]! : null;
      running.push(pick ? { i, done: pick.cycle - s.elapsed, free: Math.max(0, pick.slot - s.elapsed) } : { i, done: s.elapsed * 0.25, free: 0 });
    } else if (waiting[i] === 0) becomeReady(i);
  });
  for (let guard = 0; left > 0 && guard < steps.length * 4 + 16; guard++) {
    let used = running.filter((r) => r.free > time && !steps[r.i]!.human).length;
    while (ready.length && used < max) {
      const i = ready.shift()!;
      const s = draw();
      running.push({ i, done: time + s.cycle, free: time + Math.min(s.slot, s.cycle) });
      used++;
    }
    if (running.length === 0) return null; // what is left can never start
    let next = Infinity;
    for (const r of running) {
      next = Math.min(next, r.done);
      if (ready.length && r.free > time && !steps[r.i]!.human) next = Math.min(next, r.free);
    }
    time = Math.max(time, next);
    for (let k = running.length - 1; k >= 0; k--) {
      const r = running[k]!;
      if (r.done > time) continue;
      running.splice(k, 1);
      left--;
      for (const j of succ[r.i]!) if (--waiting[j]! === 0) becomeReady(j);
    }
  }
  return left === 0 ? time : null;
}

export interface ForecastRange {
  /** ms from now: 10th, 50th and 90th percentile of the runs. */
  low: number;
  mid: number;
  high: number;
}

/** The simulation's answer: from the optimistic end of the runs with every
 *  slot available to the pessimistic end of the runs with only as many
 *  slots as have actually been busy. */
export interface ForecastSim {
  low: number;
  high: number;
  /** With `maxInFlight` slots. */
  full: ForecastRange;
  /** With the observed number of busy slots; null when that isn't known
   *  or is no fewer. */
  observed: ForecastRange | null;
}

export interface ForecastTarget {
  key: "scope" | "gate" | "roadmap";
  label: string;
  /** Open steps that must complete (the target's, and what they wait on). */
  remainingAgent: number;
  /** Of those: agent steps outside the target's own set that it waits on. */
  ancestorsOutside: number;
  /** Open owner steps on the path. */
  ownerSteps: number;
  /** Steps behind a declined step: they can never start and aren't counted. */
  unreachable: number;
  /** Remaining agent steps ÷ recent throughput; `high` null = no upper bound. */
  naive: { low: number; high: number | null; method: "rate-band" | "daily-bootstrap" } | null;
  /** The dependency simulation with owner steps taking no time. */
  sim: ForecastSim | null;
  /** The same, with each owner step taking `ownerDelayMs` once it is ready. */
  simWithOwner: ForecastSim | null;
}

export interface VelocityForecast {
  ok: boolean;
  /** Why there is no forecast ("3 steps completed — not enough for a forecast"). */
  reason: string | null;
  /** What it rests on. */
  sample: { steps: number; days: number };
  minSteps: number;
  ownerDelayMs: number | null;
  ownerDelayFrom: "you" | "observed" | "unknown";
  /** Owner steps completed in the run with a measured lead time. */
  ownerSample: number;
  /** How many slots have been busy on average, and of how many; where it
   *  comes from: the ledger's samples, or (before there are 6 hours of
   *  them) the time cards spent building. Null when neither says. */
  busySlots: { avg: number; max: number; from: "samples" | "cards" } | null;
  targets: ForecastTarget[];
  notes: string[];
}

/** A title that reads like the main-release gate ("Publish the main release"). */
const GATE_RE = /\b(?:publish|ship|cut|tag)\b.*\b(?:main|public|stable|general|ga|1\.0)\b.*\brelease\b|\brelease gate\b/i;

function hash(n: number, s: string): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

// ── The report ────────────────────────────────────────────────────────────

export interface ThroughputWindow {
  key: "24h" | "3d" | "7d" | "all";
  /** The window, clipped to the run's age, in days. */
  days: number;
  agent: number;
  owner: number;
  /** Steps per day; null when the window is under an hour. */
  agentPerDay: number | null;
  ownerPerDay: number | null;
}

export interface VelocityBottleneck {
  step: string;
  issue: number;
  title: string;
  stage: string;
  human: boolean;
  /** in-flight states, or: ready (waits for a slot), yours (the owner's
   *  step), outside (another milestone's), open. */
  state: VelocityOpenStep["state"] | "ready" | "yours" | "outside";
  /** Open steps that can't complete before this one does, followed all the way. */
  successors: number;
  /** How long its card has been going. */
  inFlightMs: number | null;
  /** How long it has waited on the owner. */
  waitingOnYouMs: number | null;
}

export interface VelocityReport {
  available: true;
  generatedAt: number;
  asOf: number;
  tracker: number;
  view: "current" | "roadmap";
  /** What the progress chart and the bottleneck list cover. */
  scopeLabel: string;
  runStartedAt: number | null;
  maxInFlight: number;
  totals: {
    total: number;
    complete: number;
    declined: number;
    open: number;
    openAgent: number;
    openOwner: number;
    inFlight: number;
    /** Completed since the run began, in the whole roadmap. */
    runAgent: number;
    runOwner: number;
    /** Completed without a card (by hand, outside Agetor, or its card is gone). */
    runNoCard: number;
  };
  throughput: {
    windows: ThroughputWindow[];
    /** Agent steps completed in each of the last 24 hours, oldest first. */
    hourly24: number[];
    agentPerHour24: number | null;
    byStage: { stage: string; total: number; complete: number; inRun: number; open: number }[];
  };
  burnup: { total: number; points: { t: number; done: number }[] };
  cycle: {
    all: Distribution | null;
    byStage: ({ stage: string } & Distribution)[];
    histogram: { label: string; from: number; to: number | null; count: number }[];
  };
  lead: { all: Distribution | null; owner: Distribution | null };
  time: {
    /** Completed agent steps whose time could be split. */
    n: number;
    /** Completed with a card whose time couldn't be split. */
    unsplit: number;
    phases: { phase: VelocityPhase; label: string; active: boolean; totalMs: number; share: number; medianMs: number }[];
    activeMs: number;
    waitingMs: number;
    flowEfficiency: number | null;
    /** Steps that ran into a usage limit at least once. */
    stepsWithQuota: number;
  };
  rework: {
    n: number;
    roundsAvg: number | null;
    /** Share approved on the first review. */
    firstPass: number | null;
    roundsDist: { rounds: number; steps: number }[];
    finishBounces: number;
    stepsWithBounce: number;
    fixCiRuns: number;
    stepsWithFixCi: number;
  };
  utilisation: {
    knownMs: number;
    unknownMs: number;
    /** Average slots in use, and of how many. */
    avgUsed: number | null;
    avgMax: number | null;
    share: number | null;
    blockedShare: number | null;
    quotaShare: number | null;
    /** The last 48 hours, by hour; `used` null where nothing was sampled. */
    series: { t: number; used: number | null; max: number | null; blocked: number | null; known: number }[];
  };
  bottlenecks: { critical: VelocityBottleneck[]; owner: VelocityBottleneck[] };
  /** The most recent completions (newest first). */
  recent: { step: string; issue: number; stage: string; human: boolean; how: VelocityHow; closedAt: number; cycleMs: number | null; leadMs: number | null; reviewRounds: number | null; phases: PhaseTimes | null }[];
  forecast: VelocityForecast;
  /** What couldn't be measured, in words. */
  dataQuality: string[];
}

export type VelocityAnswer = VelocityReport | { available: false; reason: string };

const HIST_EDGES_H = [0, 1, 2, 3, 4, 6, 8, 12, 24];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function computeVelocity(input: VelocityInput): VelocityReport {
  const { now, steps } = input;
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const byIssue = new Map(steps.map((s) => [s.issue, s]));
  const scopeSet = input.scope ? new Set(input.scope.steps) : null;
  const scoped = input.view === "current" && scopeSet ? scopeSet : null;
  const inView = (s: VelocityGraphStep) => !scoped || scoped.has(s.step);
  const isOpen = (s: VelocityGraphStep) => s.status === "open";
  const viewSteps = steps.filter(inView);
  const openByIssue = new Map(input.open.map((o) => [o.issue, o]));
  // A fact belongs to the roadmap as it is now: a step removed from the
  // tracker is dropped, a reopened one isn't complete.
  const facts = input.facts.filter((f) => byIssue.get(f.issue)?.status === "complete" && f.closedAt <= now);
  const firstFact = facts.length ? Math.min(...facts.map((f) => f.closedAt)) : null;
  const runStart = input.runStartedAt;
  const inRun = (f: VelocityStepFacts) => runStart == null || f.closedAt >= runStart;
  const run = facts.filter(inRun);
  const agentRun = run.filter((f) => !f.human);
  const ownerRun = run.filter((f) => f.human);
  const age = runStart != null ? Math.max(0, now - runStart) : firstFact != null ? now - firstFact : 0;
  const quality: string[] = [];

  // Throughput.
  const windowOf = (key: ThroughputWindow["key"], ms: number | null): ThroughputWindow => {
    const span = ms == null ? age : Math.min(ms, age);
    const within = (f: VelocityStepFacts) => ms == null || f.closedAt > now - ms;
    const agent = agentRun.filter(within).length;
    const owner = ownerRun.filter(within).length;
    const days = span / DAY;
    const rate = (n: number) => (span >= HOUR ? n / days : null);
    return { key, days, agent, owner, agentPerDay: rate(agent), ownerPerDay: rate(owner) };
  };
  const windows = [windowOf("24h", DAY), windowOf("3d", 3 * DAY), windowOf("7d", 7 * DAY), windowOf("all", null)];
  const hourly24 = Array.from({ length: 24 }, () => 0);
  for (const f of agentRun) {
    const back = Math.floor((now - f.closedAt) / HOUR);
    if (back >= 0 && back < 24) hourly24[23 - back]!++;
  }
  const stageOrder: string[] = [];
  for (const s of steps) if (!stageOrder.includes(s.stage)) stageOrder.push(s.stage);
  const byStage = stageOrder
    .map((stage) => {
      const of = steps.filter((s) => s.stage === stage);
      return { stage, total: of.length, complete: of.filter((s) => s.status === "complete").length, inRun: run.filter((f) => f.stage === stage).length, open: of.filter(isOpen).length };
    })
    .filter((s) => s.inRun > 0 || (scopeSet != null && steps.some((x) => x.stage === s.stage && scopeSet.has(x.step))))
    .slice(0, 30);

  // Burn-up: completions in view over time, from the run's start.
  const closes = viewSteps.filter((s) => s.status === "complete").map((s) => facts.find((f) => f.issue === s.issue)?.closedAt ?? s.closedAt ?? null);
  const dated = closes.filter((t): t is number => t != null).sort((a, b) => a - b);
  const undated = closes.length - dated.length;
  const from = runStart ?? dated[0] ?? now;
  let done = undated + dated.filter((t) => t < from).length;
  let points = [{ t: from, done }];
  for (const t of dated) if (t >= from) points.push({ t, done: ++done });
  points.push({ t: Math.max(now, from), done });
  if (points.length > 240) {
    const stride = Math.ceil(points.length / 240);
    points = points.filter((_, i) => i % stride === 0 || i === points.length - 1);
  }
  const viewTotal = viewSteps.filter((s) => s.status !== "declined").length;

  // Cycle and lead time: agent steps a card worked, completed in the run.
  const carded = agentRun.filter((f) => f.how === "card" && f.startedAt != null);
  const cycleOf = (f: VelocityStepFacts) => f.closedAt - f.startedAt!;
  const cycles = carded.map(cycleOf);
  const leadOf = (f: VelocityStepFacts) => (f.readyAt != null ? f.closedAt - f.readyAt : null);
  const leads = carded.map(leadOf).filter((x): x is number => x != null);
  const ownerLeads = ownerRun.map(leadOf).filter((x): x is number => x != null);
  const histogram = HIST_EDGES_H.map((h, i) => {
    const to = HIST_EDGES_H[i + 1] ?? null;
    return { label: to == null ? `${h}h+` : `${h}–${to}h`, from: h * HOUR, to: to == null ? null : to * HOUR, count: cycles.filter((c) => c >= h * HOUR && (to == null || c < to * HOUR)).length };
  });
  const noCard = run.filter((f) => f.how === "no-card");
  if (noCard.some((f) => !f.human)) quality.push(`${plural(noCard.filter((f) => !f.human).length, "agent step")} completed with no card to be found (closed by hand, or the card was deleted): counted for throughput, no cycle time`);
  const noReady = carded.filter((f) => f.readyAt == null).length;
  if (noReady) quality.push(`${plural(noReady, "step")} with no known ready time (a predecessor's closing time is unknown): left out of lead time`);
  const guessed = run.filter((f) => f.closedFrom !== "github").length;
  if (guessed) quality.push(`${plural(guessed, "step")} closed at a time GitHub didn't supply: taken from the card's timeline or from when a pass first saw it`);

  // Where the time goes.
  const split = carded.filter((f) => f.phases);
  const totals = new Map<VelocityPhase, number>();
  for (const f of split) for (const p of PHASES) totals.set(p, (totals.get(p) ?? 0) + (f.phases![p] ?? 0));
  const allMs = sum([...totals.values()]);
  const phaseRows = PHASES.map((phase) => {
    const totalMs = totals.get(phase) ?? 0;
    const per = split.map((f) => f.phases![phase] ?? 0).sort((a, b) => a - b);
    return { phase, label: PHASE_LABEL[phase], active: isActivePhase(phase), totalMs, share: allMs > 0 ? totalMs / allMs : 0, medianMs: per.length ? quantile(per, 0.5) : 0 };
  });
  const activeMs = sum(phaseRows.filter((p) => p.active).map((p) => p.totalMs));
  const waitingMs = allMs - activeMs;
  if (carded.length > split.length) quality.push(`${plural(carded.length - split.length, "step")} whose card has no step history: cycle time only, no breakdown`);

  // Rework.
  const reviewed = carded.filter((f) => f.reviewRounds != null && f.reviewRounds > 0);
  const rounds = new Map<number, number>();
  for (const f of reviewed) rounds.set(f.reviewRounds!, (rounds.get(f.reviewRounds!) ?? 0) + 1);

  // Utilisation.
  const hours = mergeHours(input.hours, foldSamples(input.samples, now));
  const knownMs = sum(hours.map((h) => h.known));
  const slotMs = sum(hours.map((h) => h.slotMs));
  const usedMs = sum(hours.map((h) => h.usedMs));
  // Watched since the first sample (or the first folded hour); whatever of
  // that no sample covers is unknown — the app was closed, or Autopilot off.
  const starts = [input.hours[0]?.t, ...input.samples.map((s) => s.t)].filter((t): t is number => t != null);
  const watched = starts.length ? Math.max(0, now - Math.min(...starts)) : 0;
  const hourMap = new Map(hours.map((h) => [h.t, h]));
  const thisHour = Math.floor(now / HOUR) * HOUR;
  const series = Array.from({ length: 48 }, (_, i) => {
    const t = thisHour - (47 - i) * HOUR;
    const h = hourMap.get(t);
    return h && h.known > 0 ? { t, used: h.usedMs / h.known, max: h.slotMs / h.known, blocked: h.blockedMs / h.known, known: h.known / HOUR } : { t, used: null, max: null, blocked: null, known: 0 };
  });
  // How many slots have really been busy: from the samples once there are
  // six hours of them; before that, from the time cards spent building.
  const building = sum(carded.map((f) => (f.phases ? cycleOf(f) - (f.phases.merge ?? 0) - (f.phases.owner ?? 0) : cycleOf(f)))) + sum(input.open.filter((o) => o.state === "building" && o.startedAt != null).map((o) => Math.max(0, now - o.startedAt!)));
  const busy: { avg: number; from: "samples" | "cards" } | null = knownMs >= 6 * HOUR ? { avg: usedMs / knownMs, from: "samples" } : age >= HOUR && building > 0 ? { avg: building / age, from: "cards" } : null;
  if (knownMs === 0) quality.push("no slot samples yet: utilisation starts with the first pass after this build is installed");

  // Bottlenecks: the open steps whose predecessors are all complete (what
  // could move now), by how much is waiting behind them.
  const succOf = new Map<string, string[]>();
  for (const s of steps) for (const p of s.preds) (succOf.get(p) ?? succOf.set(p, []).get(p)!).push(s.step);
  const behind = (id: string): number => {
    const seen = new Set<string>();
    const stack = [...(succOf.get(id) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      const s = byStep.get(x);
      if (!s || !isOpen(s)) continue;
      seen.add(x);
      stack.push(...(succOf.get(x) ?? []));
    }
    return seen.size;
  };
  const frontier = steps.filter((s) => isOpen(s) && s.preds.every((p) => byStep.get(p)?.status === "complete" || !byStep.has(p)));
  const row = (s: VelocityGraphStep): VelocityBottleneck => {
    const o = openByIssue.get(s.issue);
    const readySince = Math.max(...s.preds.map((p) => byStep.get(p)?.closedAt ?? 0), runStart ?? 0) || null;
    const state: VelocityBottleneck["state"] = o ? o.state : s.human ? "yours" : scopeSet && !scopeSet.has(s.step) ? "outside" : "ready";
    const ownerSince = o && (o.state === "held" || o.state === "stuck" || o.state === "blocked") ? o.since : state === "yours" ? readySince : null;
    return {
      step: s.step,
      issue: s.issue,
      title: s.title,
      stage: s.stage,
      human: s.human,
      state,
      successors: behind(s.step),
      inFlightMs: o?.startedAt != null ? Math.max(0, now - o.startedAt) : null,
      waitingOnYouMs: ownerSince != null ? Math.max(0, now - ownerSince) : null,
    };
  };
  const rows = frontier.filter((s) => inView(s) || openByIssue.has(s.issue) || behind(s.step) > 0).map(row);
  const relevant = scoped ? rows.filter((r) => scoped.has(r.step) || steps.some((s) => scoped.has(s.step) && isOpen(s) && reaches(byStep, s, r.step))) : rows;
  const critical = relevant.filter((r) => r.successors > 0).sort((a, b) => b.successors - a.successors || (b.inFlightMs ?? 0) - (a.inFlightMs ?? 0)).slice(0, 8);
  const owner = relevant.filter((r) => r.state === "held" || r.state === "stuck" || r.state === "blocked" || r.state === "yours").sort((a, b) => (b.waitingOnYouMs ?? 0) - (a.waitingOnYouMs ?? 0)).slice(0, 12);

  const report: VelocityReport = {
    available: true,
    generatedAt: now,
    asOf: input.asOf,
    tracker: input.tracker,
    view: scoped ? "current" : "roadmap",
    scopeLabel: scoped && input.scope ? input.scope.label : "the whole roadmap",
    runStartedAt: runStart,
    maxInFlight: input.maxInFlight,
    totals: {
      total: viewSteps.length,
      complete: viewSteps.filter((s) => s.status === "complete").length,
      declined: viewSteps.filter((s) => s.status === "declined").length,
      open: viewSteps.filter(isOpen).length,
      openAgent: viewSteps.filter((s) => isOpen(s) && !s.human).length,
      openOwner: viewSteps.filter((s) => isOpen(s) && s.human).length,
      inFlight: viewSteps.filter((s) => isOpen(s) && openByIssue.has(s.issue) && openByIssue.get(s.issue)!.state !== "stuck").length,
      runAgent: agentRun.length,
      runOwner: ownerRun.length,
      runNoCard: noCard.length,
    },
    throughput: { windows, hourly24, agentPerHour24: age >= HOUR ? windows[0]!.agent / Math.min(24, age / HOUR) : null, byStage },
    burnup: { total: viewTotal, points },
    cycle: {
      all: distribution(cycles),
      byStage: stageOrder.flatMap((stage) => {
        const d = distribution(carded.filter((f) => f.stage === stage).map(cycleOf));
        return d ? [{ stage, ...d }] : [];
      }),
      histogram,
    },
    lead: { all: distribution(leads), owner: distribution(ownerLeads) },
    time: { n: split.length, unsplit: carded.length - split.length, phases: phaseRows, activeMs, waitingMs, flowEfficiency: allMs > 0 ? activeMs / allMs : null, stepsWithQuota: carded.filter((f) => (f.quotaHits ?? 0) > 0).length },
    rework: {
      n: reviewed.length,
      roundsAvg: reviewed.length ? sum(reviewed.map((f) => f.reviewRounds!)) / reviewed.length : null,
      firstPass: reviewed.length ? reviewed.filter((f) => f.reviewRounds === 1).length / reviewed.length : null,
      roundsDist: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => ({ rounds: r, steps: n })),
      finishBounces: sum(carded.map((f) => f.finishBounces ?? 0)),
      stepsWithBounce: carded.filter((f) => (f.finishBounces ?? 0) > 0).length,
      fixCiRuns: sum(carded.map((f) => f.fixCi ?? 0)),
      stepsWithFixCi: carded.filter((f) => (f.fixCi ?? 0) > 0).length,
    },
    utilisation: {
      knownMs,
      unknownMs: Math.max(0, watched - knownMs),
      avgUsed: knownMs > 0 ? usedMs / knownMs : null,
      avgMax: knownMs > 0 ? slotMs / knownMs : null,
      share: slotMs > 0 ? usedMs / slotMs : null,
      blockedShare: knownMs > 0 ? sum(hours.map((h) => h.blockedMs)) / knownMs : null,
      quotaShare: knownMs > 0 ? sum(hours.map((h) => h.quotaMs)) / knownMs : null,
      series,
    },
    bottlenecks: { critical, owner },
    recent: [...run]
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 30)
      .map((f) => ({ step: f.step, issue: f.issue, stage: f.stage, human: f.human, how: f.how, closedAt: f.closedAt, cycleMs: f.how === "card" && f.startedAt != null ? cycleOf(f) : null, leadMs: leadOf(f), reviewRounds: f.reviewRounds, phases: f.phases })),
    forecast: forecast(input, { carded, agentRun, ownerLeads, age, windows, busy }),
    dataQuality: quality,
  };
  return report;
}

/** Whether `from` waits on step `target`, directly or through open steps. */
function reaches(byStep: Map<string, VelocityGraphStep>, from: VelocityGraphStep, target: string): boolean {
  const seen = new Set<string>();
  const stack = [...from.preds];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = byStep.get(id);
    if (s && s.status === "open") stack.push(...s.preds);
  }
  return false;
}

function forecast(
  input: VelocityInput,
  m: { carded: VelocityStepFacts[]; agentRun: VelocityStepFacts[]; ownerLeads: number[]; age: number; windows: ThroughputWindow[]; busy: { avg: number; from: "samples" | "cards" } | null },
): VelocityForecast {
  const { steps, now } = input;
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const sample = { steps: m.carded.length, days: m.age / DAY };
  const observedOwner = m.ownerLeads.length >= MIN_OWNER_SAMPLE ? distribution(m.ownerLeads)!.median : null;
  const ownerDelayMs = input.ownerDelayMs != null && input.ownerDelayMs >= 0 ? input.ownerDelayMs : observedOwner;
  const base: VelocityForecast = {
    ok: false,
    reason: null,
    sample,
    minSteps: MIN_FORECAST_STEPS,
    ownerDelayMs,
    ownerDelayFrom: input.ownerDelayMs != null && input.ownerDelayMs >= 0 ? "you" : observedOwner != null ? "observed" : "unknown",
    ownerSample: m.ownerLeads.length,
    busySlots: m.busy ? { ...m.busy, max: input.maxInFlight } : null,
    targets: [],
    notes: [],
  };
  if (steps.every((s) => s.status !== "open")) return { ...base, reason: "Every step is complete or declined — nothing left to forecast" };
  if (m.carded.length < MIN_FORECAST_STEPS) {
    return { ...base, reason: `${plural(m.carded.length, "step")} completed with a measured cycle time — not enough for a forecast (it needs ${MIN_FORECAST_STEPS})` };
  }
  if (m.age < MIN_FORECAST_MS) return { ...base, reason: `Only ${(m.age / HOUR).toFixed(1)} hours of history — not enough for a forecast (it needs ${MIN_FORECAST_MS / HOUR})` };

  const samples: SimSample[] = m.carded.map((f) => {
    const cycle = Math.max(60_000, f.closedAt - f.startedAt!);
    const after = f.phases ? (f.phases.merge ?? 0) + (f.phases.owner ?? 0) : 0;
    return { cycle, slot: Math.max(60_000, cycle - after) };
  });
  const elapsedOf = new Map(input.open.filter((o) => o.startedAt != null && o.state !== "stuck").map((o) => [o.issue, Math.max(0, now - o.startedAt!)]));

  // Recent throughput, for the naive range.
  const w3 = m.windows.find((w) => w.key === "3d")!;
  const w7 = m.windows.find((w) => w.key === "7d")!;
  const band = [w3, w7].filter((w) => w.days > 0);
  const fast = Math.max(...band.map((w) => (w.agent + Math.sqrt(w.agent)) / w.days));
  const slow = Math.min(...band.map((w) => Math.max(0, w.agent - Math.sqrt(w.agent)) / w.days));
  const fullDays = Math.floor(m.age / DAY);
  const daily: number[] = [];
  if (fullDays >= MIN_BOOTSTRAP_DAYS) {
    for (let d = 0; d < Math.min(fullDays, 14); d++) daily.push(m.agentRun.filter((f) => f.closedAt > now - (d + 1) * DAY && f.closedAt <= now - d * DAY).length);
  }
  const seed = input.seed ?? hash(input.tracker, `${steps.filter((s) => s.status === "complete").length}/${steps.length}/${m.carded.length}`);

  // As few slots as have actually been busy: the pessimistic end.
  const busySlots = m.busy ? Math.max(1, Math.min(input.maxInFlight, Math.floor(m.busy.avg))) : null;
  const declined = new Set(steps.filter((s) => s.status === "declined").map((s) => s.step));
  const target = (key: ForecastTarget["key"], label: string, own: VelocityGraphStep[]): ForecastTarget | null => {
    // The target's open steps and every unfinished step they wait on.
    const need = new Map<string, VelocityGraphStep>();
    const dead = new Set<string>();
    const visit = (s: VelocityGraphStep, trail: Set<string>): boolean => {
      if (dead.has(s.step)) return false;
      if (need.has(s.step)) return true;
      if (trail.has(s.step)) return false; // a cycle
      trail.add(s.step);
      let ok = true;
      for (const p of s.preds) {
        const ps = byStep.get(p);
        if (!ps || declined.has(p)) ok = false;
        else if (ps.status === "open" && !visit(ps, trail)) ok = false;
        if (!ok) break;
      }
      trail.delete(s.step);
      if (ok) need.set(s.step, s);
      else dead.add(s.step);
      return ok;
    };
    const ownOpen = own.filter((s) => s.status === "open");
    if (ownOpen.length === 0) return null;
    for (const s of ownOpen) visit(s, new Set());
    const ownIds = new Set(own.map((s) => s.step));
    const needed = steps.filter((s) => need.has(s.step));
    const agents = needed.filter((s) => !s.human);
    const owners = needed.filter((s) => s.human);
    const remaining = agents.length;
    let naive: ForecastTarget["naive"] = null;
    if (daily.length && daily.some((d) => d > 0)) {
      const rand = rng(seed ^ hash(1, key));
      const runs: number[] = [];
      for (let r = 0; r < 400; r++) {
        let left = remaining;
        let days = 0;
        while (left > 0 && days < 5000) {
          const d = daily[Math.floor(rand() * daily.length)]!;
          if (d >= left && d > 0) {
            days += left / d;
            left = 0;
          } else {
            left -= d;
            days++;
          }
        }
        runs.push(days * DAY);
      }
      runs.sort((a, b) => a - b);
      naive = { low: quantile(runs, 0.1), high: quantile(runs, 0.9), method: "daily-bootstrap" };
    } else if (fast > 0) {
      naive = { low: (remaining / fast) * DAY, high: slow > 0 ? (remaining / slow) * DAY : null, method: "rate-band" };
    }
    const simSteps: SimStep[] = needed.map((s) => ({ id: s.step, human: s.human, preds: s.preds.filter((p) => need.has(p)), elapsed: s.human ? null : (elapsedOf.get(s.issue) ?? null) }));
    const runSim = (slots: number, delay: number, salt: number): ForecastRange | null => {
      if (needed.length > SIM_MAX_STEPS || needed.length === 0) return null;
      const rand = rng(seed ^ hash(salt, key));
      const runs: number[] = [];
      for (let r = 0; r < SIM_RUNS; r++) {
        const t = simulateOnce(simSteps, slots, samples, delay, rand);
        if (t != null) runs.push(t);
      }
      if (runs.length === 0) return null;
      runs.sort((a, b) => a - b);
      return { low: quantile(runs, 0.1), mid: quantile(runs, 0.5), high: quantile(runs, 0.9) };
    };
    const sim = (delay: number, salt: number): ForecastSim | null => {
      const full = runSim(input.maxInFlight, delay, salt);
      if (!full) return null;
      const observed = busySlots != null && busySlots < input.maxInFlight ? runSim(busySlots, delay, salt + 10) : null;
      return { low: full.low, high: Math.max(full.high, observed?.high ?? 0), full, observed };
    };
    return {
      key,
      label,
      remainingAgent: remaining,
      ancestorsOutside: agents.filter((s) => !ownIds.has(s.step)).length,
      ownerSteps: owners.length,
      unreachable: ownOpen.filter((s) => dead.has(s.step)).length,
      naive,
      sim: sim(0, 2),
      simWithOwner: owners.length > 0 && ownerDelayMs != null ? sim(ownerDelayMs, 3) : null,
    };
  };

  const targets: ForecastTarget[] = [];
  if (input.scope) {
    const ids = new Set(input.scope.steps);
    const t = target("scope", input.scope.label, steps.filter((s) => ids.has(s.step)));
    if (t) targets.push(t);
  }
  const gate = (input.gateIssue != null ? steps.find((s) => s.issue === input.gateIssue) : null) ?? steps.find((s) => GATE_RE.test(s.title));
  if (gate && gate.status === "open") {
    const t = target("gate", `the main-release gate (step ${gate.step})`, [gate]);
    if (t) targets.push(t);
  }
  const all = target("roadmap", "the whole roadmap", steps);
  if (all) targets.push(all);

  const notes = [
    `Rests on ${plural(m.carded.length, "completed agent step")} over ${sample.days.toFixed(1)} days. An estimate, not a date.`,
    `Simulation: ${SIM_RUNS} seeded runs of the dependency graph, each step's duration drawn from the observed cycle times.` +
      (busySlots != null && busySlots < input.maxInFlight
        ? ` The range runs from the 10th percentile with all ${input.maxInFlight} slots busy to the 90th with ${busySlots} — ${m.busy!.avg.toFixed(1)} have been busy on average so far.`
        : ` The range is the 10th to the 90th percentile with ${input.maxInFlight} slots.`),
    "It assumes Autopilot stays on, every ready step may start whatever milestone it is in, and later steps take as long as the ones finished so far. It doesn't model usage limits, the merge queue backing up, or your own time unless you set it.",
    naiveNote(daily.length > 0),
  ];
  if (m.age < 3 * DAY) notes.push("Less than 3 days of history: expect the range to move as more steps finish.");
  if (targets.some((t) => t.unreachable > 0)) notes.push("Steps behind a declined step can never start; they are left out.");
  return { ...base, ok: true, targets, notes };
}

const naiveNote = (bootstrap: boolean) =>
  bootstrap
    ? "Naive range: remaining agent steps against daily completions resampled from the last 14 days (10th to 90th percentile). It ignores dependencies."
    : "Naive range: remaining agent steps ÷ the 3-day and 7-day rates, each widened by its counting noise (±√n). It ignores dependencies.";

// ── Words ─────────────────────────────────────────────────────────────────

/** "42m", "3.5h", "2.1d". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const m = ms / 60_000;
  if (m < 1) return "<1m";
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

const days = (ms: number) => {
  const d = ms / DAY;
  return d < 1 ? "<1" : d < 10 ? String(Math.round(d * 2) / 2) : String(Math.round(d));
};

/** "2–4 days", "about 3 days", "5–9 hours", "30 days or more": always a
 *  span of time from now, never a date. Under a day and a half, in hours. */
export function fmtRange(low: number, high: number | null): string {
  if (high == null) return `${days(low)} days or more`;
  if (high < 1.5 * DAY) {
    const a = Math.max(1, Math.round(low / HOUR));
    const b = Math.max(1, Math.round(high / HOUR));
    return a === b ? `about ${a} hour${a === 1 ? "" : "s"}` : `${a}–${b} hours`;
  }
  const a = days(low);
  const b = days(high);
  if (a === b) return `about ${a} day${a === "1" ? "" : "s"}`;
  return a === "<1" ? `up to ${b} days` : `${a}–${b} days`;
}

export const fmtRate = (r: number | null): string => (r == null ? "—" : r >= 10 ? r.toFixed(0) : r.toFixed(1));
export const fmtPct = (x: number | null): string => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** The range to quote for a target: the simulation's, else the naive one. */
export function targetRange(t: ForecastTarget): { low: number; high: number | null } | null {
  const s = t.simWithOwner ?? t.sim;
  return s ? { low: s.low, high: s.high } : t.naive;
}

/** The rate to quote: the last 3 days', else since the run began. */
export function headlineRate(r: VelocityReport): number | null {
  return r.throughput.windows.find((w) => w.key === "3d")?.agentPerDay ?? r.throughput.windows.find((w) => w.key === "all")?.agentPerDay ?? null;
}

/** The board's one-line summary: "15 done · 4.2/day · M02 ≈ 2–4 days". */
export function velocitySummary(r: VelocityReport): string {
  const doneCount = r.totals.runAgent + r.totals.runOwner;
  const parts = [`${doneCount} done`];
  const rate = headlineRate(r);
  if (rate != null) parts.push(`${fmtRate(rate)}/day`);
  const t = r.forecast.ok ? (r.forecast.targets.find((x) => x.key === "scope") ?? r.forecast.targets[0]) : null;
  const range = t ? targetRange(t) : null;
  if (t && range) parts.push(`${t.key === "roadmap" ? "roadmap" : t.key === "gate" ? "release gate" : t.label} ≈ ${fmtRange(range.low, range.high).replace(/^about /, "")}`);
  return parts.join(" · ");
}
