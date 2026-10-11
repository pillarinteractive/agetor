/**
 * The velocity ledger for Autopilot's roadmap mode (FORK.md "Velocity"; the
 * metrics themselves are pure, in src/shared/velocity.ts).
 *
 * Two files per tracker under `<dataDir>/roadmap-velocity/`:
 *
 *   <tracker>-<project hash>.jsonl — append-only, one JSON object per line:
 *     {"k":"run", t, began}   once: when the ledger started and when the run
 *                             began (the earliest roadmap entry in a card's
 *                             timeline, else the first pass with this build).
 *     {"k":"step", …facts}    when a step is first seen complete: everything
 *                             velocity needs about it, taken from its card's
 *                             run history and timeline at that moment — so it
 *                             survives the card being archived or deleted.
 *     {"k":"s", t, max, used, blocked, quota, ready, held}
 *                             one sample per pass: slots in use, and whether
 *                             the run is blocked. Unchanged state is written
 *                             again every few minutes as a heartbeat, so a
 *                             stretch with no samples (the app closed) can be
 *                             told from one where nothing changed.
 *     {"k":"c", t, issue, state}
 *                             a card's state as a pass saw it change:
 *                             building, merging, held, blocked, quota, retry.
 *                             The run's history can't tell a step that sat
 *                             blocked or waiting on a usage limit from one
 *                             that worked all along; these can (to within a
 *                             pass). Dropped once the step's facts are kept.
 *     {"k":"h", …}            an hour of older samples, folded on compaction.
 *   <same>.json — the roadmap as of the last pass (every step, its
 *     predecessors, state and closing time; the steps in flight), rewritten
 *     each pass. The API computes the report from these two files alone.
 *
 * Everything is best-effort: a pass never fails because of the ledger.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import {
  cardStartedAt,
  cardWindow,
  computeVelocity,
  foldSamples,
  mergeHours,
  stepFacts,
  velocityKey,
  type VelocityAnswer,
  type VelocityCard,
  type VelocityGraphStep,
  type VelocityHour,
  type VelocityOpenStep,
  type VelocitySample,
  type VelocityStepFacts,
} from "../shared/velocity.ts";
import { readLogged } from "./activity.ts";
import { dataDir, db, tasks } from "./db.ts";

/** The issue number of the step that is the main-release gate, when the
 *  title heuristic (src/shared/velocity.ts) doesn't find the right one:
 *  `agetor config autopilot_velocity_gate 123`. */
export const VELOCITY_GATE_PREF = "autopilot_velocity_gate";

/** The ledger is compacted past this size… */
export const LEDGER_MAX_BYTES = 1024 * 1024;
/** …keeping this many of the newest samples (a week at one per 5 minutes)
 *  and folding the older ones into hours… */
export const LEDGER_KEEP_SAMPLES = 2000;
/** …of which this many are kept (180 days). */
export const LEDGER_KEEP_HOURS = 24 * 180;
/** An unchanged state is sampled again after this long. */
export const HEARTBEAT_MS = 4 * 60_000;
/** A completion first seen this long after it happened was reconstructed. */
const BACKFILL_AFTER_MS = 30 * 60_000;

export interface VelocityLimits {
  maxBytes: number;
  keepSamples: number;
  keepHours: number;
}
const LIMITS: VelocityLimits = { maxBytes: LEDGER_MAX_BYTES, keepSamples: LEDGER_KEEP_SAMPLES, keepHours: LEDGER_KEEP_HOURS };

const trimDir = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function velocityFiles(tracker: number, project: string, dir = path.join(dataDir, "roadmap-velocity")): { ledger: string; snapshot: string } {
  const key = velocityKey(tracker, project);
  return { ledger: path.join(dir, `${key}.jsonl`), snapshot: path.join(dir, `${key}.json`) };
}

export interface VelocityLedger {
  run: { t: number; began: number } | null;
  facts: Map<number, VelocityStepFacts>;
  samples: VelocitySample[];
  hours: VelocityHour[];
  /** Card states the passes saw, by issue, oldest first. */
  cards: Map<number, { t: number; state: VelocityOpenStep["state"] }[]>;
}

/** Read a ledger; lines that don't parse are skipped, the latest facts of a
 *  step win. Exported for tests. */
export function readLedger(file: string): VelocityLedger {
  const out: VelocityLedger = { run: null, facts: new Map(), samples: [], hours: [], cards: new Map() };
  if (!existsSync(file)) return out;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.k === "run" && typeof o.t === "number" && typeof o.began === "number") out.run ??= { t: o.t, began: o.began };
      else if (o.k === "step" && typeof o.issue === "number" && typeof o.closedAt === "number") {
        const { k: _k, ...f } = o;
        out.facts.set(o.issue, f as unknown as VelocityStepFacts);
      } else if (o.k === "s" && typeof o.t === "number") {
        out.samples.push({ t: o.t, max: Number(o.max) || 0, used: Number(o.used) || 0, blocked: o.blocked === 1 || o.blocked === true, quota: o.quota === 1 || o.quota === true, ready: Number(o.ready) || 0, held: Number(o.held) || 0 });
      } else if (o.k === "c" && typeof o.t === "number" && typeof o.issue === "number" && typeof o.state === "string") {
        (out.cards.get(o.issue) ?? out.cards.set(o.issue, []).get(o.issue)!).push({ t: o.t, state: o.state as VelocityOpenStep["state"] });
      } else if (o.k === "h" && typeof o.t === "number") {
        out.hours.push({ t: o.t, known: Number(o.known) || 0, slotMs: Number(o.slotMs) || 0, usedMs: Number(o.usedMs) || 0, blockedMs: Number(o.blockedMs) || 0, quotaMs: Number(o.quotaMs) || 0 });
      }
    } catch {
      // a torn line (the core stopped mid-write): skip it
    }
  }
  out.samples.sort((a, b) => a.t - b.t);
  out.hours = mergeHours(out.hours, []);
  return out;
}

const sampleLine = (s: VelocitySample) => JSON.stringify({ k: "s", t: s.t, max: s.max, used: s.used, blocked: s.blocked ? 1 : 0, quota: s.quota ? 1 : 0, ready: s.ready, held: s.held });

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Rewrite the ledger within its bounds: the header, each step's latest
 *  facts, the newest samples; older samples become hours. */
function compact(file: string, l: VelocityLedger, limits: VelocityLimits): void {
  const cutAt = Math.max(0, l.samples.length - limits.keepSamples);
  const older = l.samples.slice(0, cutAt);
  const kept = l.samples.slice(cutAt);
  // The last folded sample holds until the first one kept.
  const hours = mergeHours(l.hours, older.length ? foldSamples(older, kept[0]?.t ?? older[older.length - 1]!.t) : []).slice(-limits.keepHours);
  const lines = [
    ...(l.run ? [JSON.stringify({ k: "run", ...l.run })] : []),
    ...[...l.facts.values()].map((f) => JSON.stringify({ k: "step", ...f })),
    ...hours.map((h) => JSON.stringify({ k: "h", ...h })),
    // Only of steps still open: a completed step's facts already hold them.
    ...[...l.cards].filter(([issue]) => !l.facts.has(issue)).flatMap(([issue, es]) => es.slice(-200).map((e) => JSON.stringify({ k: "c", t: e.t, issue, state: e.state }))),
    ...kept.map(sampleLine),
  ];
  writeAtomic(file, `${lines.join("\n")}\n`);
}

// ── Cards ─────────────────────────────────────────────────────────────────

const issueOf = (url: string | null | undefined): number | null => {
  const m = url?.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
};

/** What velocity reads of a card: its run history and its timeline. */
export function velocityCard(t: Task, activity: { ts: number; text: string }[]): VelocityCard {
  const run = t.pipelineRun;
  const name = (id: string) => run?.snapshot?.graph.steps.find((s) => s.id === id)?.name ?? id;
  return {
    cardId: t.id,
    // A plain task has no run: it counts from when it was made.
    runStartedAt: run ? run.startedAt : t.runId ? t.createdAt : null,
    records: (run?.history ?? []).map((r) => ({ stepId: r.stepId, name: name(r.stepId), startedAt: r.startedAt, endedAt: r.endedAt, outcome: r.outcome, blocked: r.handoff?.status === "blocked", next: r.nextStepIds })),
    activity: activity.map((a) => ({ ts: a.ts, text: a.text })),
  };
}

export interface VelocityIo {
  dir?: string;
  limits?: Partial<VelocityLimits>;
  /** Every card of this project made from one of these issues — archived
   *  ones too — by issue. */
  cardsFor(project: string, issues: ReadonlySet<number>): Map<number, VelocityCard[]>;
  activity(taskId: string): { ts: number; text: string }[];
}

export const VELOCITY_IO: VelocityIo = {
  cardsFor(project, issues) {
    const rows = db
      .query<{ id: string; workdir: string; issue_url: string }, []>("SELECT id, workdir, issue_url FROM tasks WHERE pipeline_parent_id IS NULL AND issue_url IS NOT NULL")
      .all()
      .filter((r) => trimDir(r.workdir) === trimDir(project) && issues.has(issueOf(r.issue_url) ?? -1));
    const out = new Map<number, VelocityCard[]>();
    for (const t of tasks.listByIds(rows.map((r) => r.id))) {
      const n = issueOf(t.issueUrl);
      if (n == null) continue;
      (out.get(n) ?? out.set(n, []).get(n)!).push(velocityCard(t, readLogged(t.id)));
    }
    return out;
  },
  activity: (taskId) => readLogged(taskId),
};

// ── The pass ──────────────────────────────────────────────────────────────

export interface VelocityPassInput {
  tracker: number;
  project: string;
  now: number;
  maxInFlight: number;
  /** Every step of the roadmap, as this pass read it. */
  steps: VelocityGraphStep[];
  scope: { label: string; steps: string[] } | null;
  sample: Omit<VelocitySample, "t">;
  /** The started live card of each open step. */
  live: Map<number, Task>;
  /** Open steps whose card waits in In Review for the owner. */
  held: ReadonlySet<number>;
  /** Open steps whose card waits for a usage limit to reset. */
  quota?: ReadonlySet<number>;
  /** Open steps whose card finished without closing the issue: since when. */
  stuck: Map<number, { at: number; cardId: string | null }>;
}

interface Snapshot {
  t: number;
  tracker: number;
  project: string;
  maxInFlight: number;
  scope: { label: string; steps: string[] } | null;
  steps: VelocityGraphStep[];
  open: VelocityOpenStep[];
}

const sameSample = (a: Omit<VelocitySample, "t">, b: Omit<VelocitySample, "t">) => a.max === b.max && a.used === b.used && a.blocked === b.blocked && a.quota === b.quota && a.ready === b.ready && a.held === b.held;

/**
 * Record one roadmap pass: the facts of every step newly seen complete (on
 * the first run, of every step already complete — the backfill), a sample
 * of the slots, and the snapshot. Returns what it wrote. Exported for tests.
 */
export function recordVelocityPass(input: VelocityPassInput, io: VelocityIo = VELOCITY_IO): { facts: number; sample: boolean; compacted: boolean } {
  const files = velocityFiles(input.tracker, input.project, io.dir);
  const limits = { ...LIMITS, ...io.limits };
  mkdirSync(path.dirname(files.ledger), { recursive: true });
  const ledger = readLedger(files.ledger);
  const lines: string[] = [];
  const { now, steps } = input;
  const byStep = new Map(steps.map((s) => [s.step, s]));

  // The run's start. Every card's timeline says when Autopilot added or
  // started it for this roadmap; the earliest of those is when it began.
  const said = new RegExp(`of roadmap #${input.tracker}\\b`);
  let allCards: Map<number, VelocityCard[]> | null = null;
  const first = !ledger.run;
  if (!ledger.run) {
    allCards = io.cardsFor(input.project, new Set(steps.map((s) => s.issue)));
    // A card Autopilot started outright says so a moment after its run began.
    const stamps = [...allCards.values()].flat().flatMap((c) => {
      const said_ = c.activity.filter((a) => said.test(a.text)).map((a) => a.ts);
      const at = cardStartedAt(c);
      return said_.length && at != null && Math.min(...said_) - at < 10 * 60_000 ? [...said_, at] : said_;
    });
    ledger.run = { t: now, began: stamps.length ? Math.min(now, ...stamps) : now };
    lines.push(JSON.stringify({ k: "run", ...ledger.run }));
  }
  const began = ledger.run.began;

  // Steps newly complete (or closed again at another time).
  const fresh = steps.filter((s) => {
    if (s.status !== "complete") return false;
    const f = ledger.facts.get(s.issue);
    return !f || (s.closedAt != null && f.closedAt !== s.closedAt);
  });
  let written = 0;
  if (fresh.length > 0) {
    const cards = allCards ?? io.cardsFor(input.project, new Set(fresh.map((s) => s.issue)));
    for (const s of fresh) {
      const preds = s.preds.map((p) => byStep.get(p)?.closedAt ?? null);
      const readyAt = preds.some((t) => t == null) ? null : Math.max(began, ...(preds as number[]));
      const closed = s.closedAt ?? null;
      // A card from before the run isn't this run's work on a step the run
      // completed — unless a pass saw it in flight, or its timeline names the roadmap.
      const seen = ledger.cards.get(s.issue) ?? [];
      const observed = seen.flatMap((e, i) => (e.state === "blocked" || e.state === "quota" || e.state === "retry" ? [{ from: e.t, to: seen[i + 1]?.t ?? closed ?? now, state: e.state }] : []));
      const mine = (cards.get(s.issue) ?? [])
        .filter((c) => closed == null || closed < began || (cardStartedAt(c) ?? 0) >= began || seen.length > 0 || c.activity.some((a) => said.test(a.text)))
        .map((c) => ({ ...c, observed }));
      const f = stepFacts({
        step: { step: s.step, issue: s.issue, stage: s.stage, human: s.human },
        cards: mine,
        closedAt: closed,
        observedAt: now,
        readyAt,
        backfilled: first || (closed != null && now - closed > BACKFILL_AFTER_MS),
      });
      ledger.facts.set(s.issue, f);
      lines.push(JSON.stringify({ k: "step", ...f }));
      written++;
    }
  }

  // The sample: on a change, and as a heartbeat.
  const last = ledger.samples[ledger.samples.length - 1];
  const sample: VelocitySample = { t: now, ...input.sample, used: Math.max(0, Math.min(input.sample.used, input.sample.max)) };
  const due = !last || !sameSample(last, sample) || now - last.t >= HEARTBEAT_MS;
  if (due) {
    ledger.samples.push(sample);
    lines.push(sampleLine(sample));
  }
  if (lines.length) appendFileSync(files.ledger, `${lines.join("\n")}\n`);

  let compacted = false;
  try {
    if (statSync(files.ledger).size > limits.maxBytes) {
      compact(files.ledger, ledger, limits);
      compacted = true;
    }
  } catch {
    // next pass
  }

  // The steps in flight, and the ones waiting on the owner. A card's state
  // is appended when it differs from the last one a pass saw.
  const open: VelocityOpenStep[] = [];
  const events: string[] = [];
  for (const [issue, t] of input.live) {
    const card = velocityCard(t, io.activity(t.id));
    const startedAt = cardStartedAt(card);
    const w = startedAt != null ? cardWindow(card, Math.max(now, startedAt + 1)) : null;
    const lastEnd = Math.max(0, ...card.records.map((r) => r.endedAt ?? 0)) || null;
    const run = t.pipelineRun;
    const retrying = run?.status === "blocked" && run.autoRetry?.at != null ? (run.autoRetry.kind === "quota" ? "quota" : "retry") : null;
    const state: VelocityOpenStep["state"] = input.held.has(issue)
      ? "held"
      : input.quota?.has(issue)
        ? "quota"
        : retrying
          ? retrying
          : run?.status === "blocked" || (t.pendingInteractionCount ?? 0) > 0
            ? "blocked"
            : t.column === "review" || t.column === "merge"
              ? "merging"
              : "building";
    const before = ledger.cards.get(issue);
    const changedAt = before?.length && before[before.length - 1]!.state === state ? before[before.length - 1]!.t : now;
    if (changedAt === now) events.push(JSON.stringify({ k: "c", t: now, issue, state }));
    open.push({ issue, state, cardId: t.id, startedAt, since: state === "held" ? (w?.heldSince ?? changedAt) : state === "blocked" ? changedAt : null });
  }
  for (const [issue, s] of input.stuck) if (!input.live.has(issue)) open.push({ issue, state: "stuck", cardId: s.cardId, startedAt: null, since: s.at });
  if (events.length) appendFileSync(files.ledger, `${events.join("\n")}\n`);
  const snapshot: Snapshot = { t: now, tracker: input.tracker, project: input.project, maxInFlight: input.maxInFlight, scope: input.scope, steps, open };
  writeAtomic(files.snapshot, JSON.stringify(snapshot));
  return { facts: written, sample: due, compacted };
}

// ── The report ────────────────────────────────────────────────────────────

/**
 * `GET /autopilot/roadmap/velocity`: the report for the tracker configured
 * now, from the ledger and the last pass's snapshot. Reads two files; never
 * reaches GitHub.
 */
export function velocityAnswer(
  cfg: { roadmap: { issue: number } | null; project: string; maxInFlight: number },
  opts: { view?: "current" | "roadmap"; ownerDelayMs?: number | null; gateIssue?: number | null; now?: number; dir?: string } = {},
): VelocityAnswer {
  if (!cfg.roadmap || !cfg.project) return { available: false, reason: "Autopilot isn't working a roadmap — set a tracker issue first" };
  const files = velocityFiles(cfg.roadmap.issue, cfg.project, opts.dir);
  let snap: Snapshot | null = null;
  try {
    snap = existsSync(files.snapshot) ? (JSON.parse(readFileSync(files.snapshot, "utf8")) as Snapshot) : null;
  } catch {
    snap = null;
  }
  if (!snap || !Array.isArray(snap.steps)) return { available: false, reason: "No velocity data yet — it is collected from the first Autopilot pass on" };
  const ledger = readLedger(files.ledger);
  return computeVelocity({
    now: opts.now ?? Date.now(),
    tracker: cfg.roadmap.issue,
    asOf: snap.t,
    maxInFlight: cfg.maxInFlight || snap.maxInFlight,
    runStartedAt: ledger.run?.began ?? null,
    steps: snap.steps,
    scope: snap.scope ?? null,
    view: opts.view ?? "current",
    facts: [...ledger.facts.values()],
    open: Array.isArray(snap.open) ? snap.open : [],
    samples: ledger.samples,
    hours: ledger.hours,
    ownerDelayMs: opts.ownerDelayMs ?? null,
    gateIssue: opts.gateIssue ?? null,
  });
}

let memo: { key: string; at: number; answer: VelocityAnswer } | null = null;

/** `velocityAnswer`, kept for half a minute while neither file changes: the
 *  board asks every minute and the forecast's simulation isn't free. */
export function velocityAnswerCached(cfg: Parameters<typeof velocityAnswer>[0], opts: Parameters<typeof velocityAnswer>[1] = {}): VelocityAnswer {
  const stamp = (file: string) => {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  };
  const files = cfg.roadmap && cfg.project ? velocityFiles(cfg.roadmap.issue, cfg.project, opts.dir) : null;
  const key = JSON.stringify([cfg.roadmap?.issue, cfg.project, cfg.maxInFlight, opts.view, opts.ownerDelayMs, opts.gateIssue, files && stamp(files.ledger), files && stamp(files.snapshot)]);
  const now = opts.now ?? Date.now();
  if (memo && memo.key === key && now - memo.at < 30_000) return memo.answer;
  const answer = velocityAnswer(cfg, opts);
  memo = { key, at: now, answer };
  return answer;
}
