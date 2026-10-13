/**
 * What the Velocity view derives from a velocity report
 * (src/shared/velocity.ts) to lay it out: the four time buckets, what one
 * forecast scope can and cannot show, the "move these next" rows joined to
 * their board cards, and the capacity figures in words. Nothing here
 * calculates or forecasts: every number is the report's own, and a number
 * the report doesn't carry is left null for the view to call unavailable.
 * Pure: the caller passes `now`.
 */
import type { LeaseStatus, Task, TaskPrStatus, TaskProgress } from "../../shared/types.ts";
import type { RoadmapCardInfo } from "../../shared/roadmap.ts";
import { fmtDuration, fmtPct, targetRange, type ForecastTarget, type VelocityBottleneck, type VelocityPhase, type VelocityReport } from "../../shared/velocity.ts";
import { CARD_STATE_ICON, cardState, clockTime, type CardAction, type CardState, type CardStateIcon, type CardStateTone } from "./card-state.ts";
import { leaseInfoForTask } from "./leases.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Where time goes ───────────────────────────────────────────────────────

export type TimeBucketKey = "working" | "held" | "ci" | "other";

export interface TimeBucket {
  key: TimeBucketKey;
  label: string;
  tone: CardStateTone;
  ms: number;
  /** Of the four buckets' sum; null when nothing was measured. */
  share: number | null;
  /** The sentence the legend shows for this bucket. */
  detail: string;
}

const BUCKET: Record<TimeBucketKey, { label: string; tone: CardStateTone; phases: (p: { phase: VelocityPhase; active: boolean }) => boolean }> = {
  working: { label: "Agents working", tone: "working", phases: (p) => p.active },
  held: { label: "Held for you", tone: "needs", phases: (p) => p.phase === "owner" },
  ci: { label: "CI / merge queue", tone: "waiting", phases: (p) => p.phase === "merge" },
  other: { label: "Other waits", tone: "queued", phases: (p) => p.phase === "quota" || p.phase === "slot" || p.phase === "other" },
};
export const TIME_BUCKETS = Object.keys(BUCKET) as TimeBucketKey[];

/**
 * The report's phases folded into four: agents working (every active
 * phase), held for the owner, CI and the merge queue, and the other waits
 * (usage limits, slots, automatic retries). The times are summed over tasks
 * that ran side by side, so each is accumulated task time, not calendar
 * time. A bucket of one phase keeps that phase's median; a bucket of several
 * has none, because medians don't add.
 */
export function timeBuckets(report: VelocityReport): TimeBucket[] {
  const phases = report.time.phases;
  const sums = TIME_BUCKETS.map((key) => phases.filter(BUCKET[key].phases).reduce((a, p) => a + p.totalMs, 0));
  const all = sums.reduce((a, b) => a + b, 0);
  return TIME_BUCKETS.map((key, i) => {
    const of = phases.filter(BUCKET[key].phases);
    const ms = sums[i]!;
    const named = of.filter((p) => p.totalMs > 0).map((p) => p.label.toLowerCase());
    const median = of.length === 1 ? `Median per step: ${fmtDuration(of[0]!.medianMs)}.` : named.length > 0 ? `Covers ${named.join(", ")}. A median per step is unavailable for a group of phases.` : "";
    return {
      key,
      label: BUCKET[key].label,
      tone: BUCKET[key].tone,
      ms,
      share: all > 0 ? ms / all : null,
      detail: `${BUCKET[key].label}: ${fmtDuration(ms)} of accumulated task time${all > 0 ? ` (${fmtPct(ms / all)})` : ""}. ${median}`.trim(),
    };
  });
}

// ── Forecast scope ────────────────────────────────────────────────────────

export type ScopeKey = "gate" | "roadmap";

export interface ScopeView {
  key: ScopeKey;
  /** "Release gate forecast". */
  title: string;
  target: ForecastTarget | null;
  /** "15–25 days"; null when there is no forecast for this scope. */
  range: { low: number; high: number | null } | null;
  /** Why there is no range, in the report's or this view's words. */
  unavailable: string | null;
  /** Whether the range includes the owner's steps taking time. */
  includesOwnerTime: boolean;
  /** Complete and open counts. Supplied for the whole roadmap only, and
   *  only by a report computed over it; never derived for the gate. */
  completion: { complete: number; total: number; openAgent: number; openOwner: number; declined: number } | null;
  completionNote: string | null;
}

export function scopeView(report: VelocityReport, key: ScopeKey): ScopeView {
  const f = report.forecast;
  const target = f.ok ? (f.targets.find((t) => t.key === key) ?? null) : null;
  const range = target ? targetRange(target) : null;
  const what = key === "gate" ? "release gate" : "whole roadmap";
  const unavailable = !f.ok
    ? (f.reason ?? "No forecast yet.")
    : !target
      ? key === "gate"
        ? "The report has no open release-gate step, so there is no forecast for this scope."
        : "The report has no open step left to forecast."
      : !range
        ? `A range for the ${what} is unavailable: the report carries no simulation or rate for it.`
        : null;
  const whole = key === "roadmap" && report.view === "roadmap";
  return {
    key,
    title: key === "gate" ? "Release gate forecast" : "Whole roadmap forecast",
    target,
    range,
    unavailable,
    includesOwnerTime: !!target?.simWithOwner,
    completion: whole ? { complete: report.totals.complete, total: report.totals.total, openAgent: report.totals.openAgent, openOwner: report.totals.openOwner, declined: report.totals.declined } : null,
    completionNote:
      key === "gate"
        ? "Completion is not supplied for this scope: the report counts what remains on the path to the gate, not how much of it is done. No total is derived from the gate's step number."
        : whole
          ? null
          : "Completion for the whole roadmap is unavailable: this report covers the milestones in scope.",
  };
}

// ── Move these next ───────────────────────────────────────────────────────

export interface BottleneckContext {
  prs: ReadonlyMap<string, TaskPrStatus>;
  leases: LeaseStatus[];
  now: number;
  progress?: TaskProgress[];
  roadmap?: ReadonlyMap<string, RoadmapCardInfo>;
}

export interface BottleneckRow {
  issue: number;
  step: string;
  title: string;
  tone: CardStateTone;
  icon: CardStateIcon;
  label: string;
  /** The card's own reason; "unavailable" words for a step with no card. */
  reason: string;
  reasonKnown: boolean;
  /** Open steps that can't complete before this one does. Rows overlap. */
  dependents: number;
  dependentsLabel: string;
  /** "Card started 61m ago", "Next retry 1:49 PM · attempt 2 of 4". */
  timing: string | null;
  task: Task | null;
  action: CardAction | null;
}

/** What the report says of a step, for one with no card to ask. */
const REPORT_STATE: Record<VelocityBottleneck["state"], { tone: CardStateTone; label: string }> = {
  building: { tone: "working", label: "In flight" },
  merging: { tone: "waiting", label: "CI / merge queue" },
  held: { tone: "needs", label: "Held for sign-off" },
  stuck: { tone: "needs", label: "Needs you" },
  blocked: { tone: "needs", label: "Blocked" },
  quota: { tone: "waiting", label: "Usage limit" },
  retry: { tone: "waiting", label: "Auto retry" },
  waiting: { tone: "waiting", label: "Auto retry" },
  ready: { tone: "queued", label: "Ready" },
  yours: { tone: "needs", label: "Yours to do" },
  outside: { tone: "queued", label: "Another milestone" },
};

const issueOf = (t: Task): number | null => {
  const m = /^Issue #(\d+):/.exec(t.title) ?? /\/issues\/(\d+)/.exec(t.issueUrl ?? "");
  return m ? Number(m[1]) : null;
};

/** When the card is tried again, where its run says: only the wait queue
 *  carries a maximum, so only it reads "attempt n of m". */
function retryTiming(task: Task): string | null {
  const run = task.pipelineRun;
  if (!run || run.status !== "blocked") return null;
  const w = run.wait;
  if (w && w.state === "waiting") return `Next retry ${w.at != null ? clockTime(w.at) : "soon"} · attempt ${Math.min(w.attempt + 1, Math.max(1, w.max))} of ${Math.max(1, w.max)}`;
  if (run.autoRetry?.at != null) return `Next retry ${clockTime(run.autoRetry.at)} · attempt ${run.autoRetry.attempt} · no maximum recorded`;
  const held = run.blocked.find((b) => b.inputRetry != null)?.inputRetry;
  if (held) return `Next check ${clockTime(held.at)} · attempt ${held.attempt} · no maximum recorded`;
  return null;
}

/**
 * The steps that hold the most work back, each with the state of its board
 * card: the same `cardState` the board draws, so a row and its card agree. A
 * step with no card on the board keeps what the report says of it and an
 * unavailable reason. `dependents` counts overlap between rows.
 */
export function bottleneckRows(report: VelocityReport, tasks: Task[], ctx: BottleneckContext): BottleneckRow[] {
  const { critical, owner } = report.bottlenecks;
  const all = [...critical, ...owner.filter((o) => !critical.some((c) => c.issue === o.issue))];
  // A step's live card: an archived or step-task row is not it.
  const cards = new Map<number, Task>();
  for (const t of tasks) {
    if (t.pipelineParentId || t.archivedAt != null) continue;
    const n = issueOf(t);
    if (n != null && !cards.has(n)) cards.set(n, t);
  }
  return all.map((b) => {
    const task = cards.get(b.issue) ?? null;
    const state: CardState | null = task
      ? cardState(task, {
          pr: ctx.prs.get(task.id) ?? null,
          lease: leaseInfoForTask(task, ctx.leases),
          now: ctx.now,
          progressActive: (ctx.progress ?? []).some((p) => p.taskId === task.id && p.active),
          roadmap: ctx.roadmap?.get(task.id) ?? null,
        })
      : null;
    const from = REPORT_STATE[b.state] ?? { tone: "queued" as const, label: b.state };
    const started = b.inFlightMs != null ? `Card started ${fmtDuration(b.inFlightMs)} ago` : null;
    const waited = b.waitingOnYouMs != null ? `Waiting on you for ${fmtDuration(b.waitingOnYouMs)}` : null;
    return {
      issue: b.issue,
      step: b.step,
      title: b.title,
      tone: state?.state ?? from.tone,
      icon: state?.icon ?? CARD_STATE_ICON[from.tone],
      label: state?.label ?? from.label,
      reason: state ? state.reason : b.human ? "The owner's step: no card runs it, so a wait reason is unavailable." : "Wait reason unavailable: no card on the board for this step.",
      reasonKnown: state != null,
      dependents: b.successors,
      dependentsLabel: b.successors > 0 ? `${plural(b.successors, "step")} behind it` : "no step behind it",
      timing: (task ? retryTiming(task) : null) ?? waited ?? started,
      task,
      // A card with no move of its own can still be opened.
      action: state ? (state.action ?? { kind: "open", label: "Open" }) : null,
    };
  });
}

// ── Execution capacity ────────────────────────────────────────────────────

export interface CapacityView {
  /** False until a pass has sampled the slots. */
  available: boolean;
  /** "4.5 of 8". */
  occupied: string;
  /** One mark per slot: occupied, half, or free, for the average. */
  pips: ("full" | "half" | "empty")[];
  blockedShare: string;
  quotaShare: string;
  /** What the averages cover. They are the whole ledger's, not a recent window. */
  window: string;
  note: string;
}

export function capacityView(report: VelocityReport): CapacityView {
  const u = report.utilisation;
  const max = Math.max(1, Math.round(u.avgMax ?? report.maxInFlight));
  const used = u.avgUsed ?? 0;
  const pips = Array.from({ length: max }, (_, i): "full" | "half" | "empty" => (used >= i + 0.75 ? "full" : used >= i + 0.25 ? "half" : "empty"));
  const unobserved = u.unknownMs > 60_000 ? ` ${fmtDuration(u.unknownMs)} went unobserved while the app was closed or Autopilot paused.` : "";
  return {
    available: u.avgUsed != null,
    occupied: u.avgUsed == null ? "unavailable" : `${u.avgUsed.toFixed(1)} of ${max}`,
    pips,
    blockedShare: u.blockedShare == null ? "unavailable" : `${fmtPct(u.blockedShare)} of observed time`,
    quotaShare: u.quotaShare == null ? "unavailable" : `${fmtPct(u.quotaShare)} of observed time`,
    window: u.avgUsed == null ? "No samples yet" : `All observed time · ${fmtDuration(u.knownMs)}`,
    note: `An occupied slot may be waiting, not executing.${unobserved}`,
  };
}

// ── Completion rates ──────────────────────────────────────────────────────

export interface RateRow {
  key: "24h" | "3d" | "all";
  label: string;
  /** Agent steps per day; null when the window is under an hour. */
  perDay: number | null;
  count: number;
  /** Of the fastest of the three, for the bar. */
  fraction: number;
  /** "the run is 2.1 days old" when the window is longer than the run. */
  clipped: string | null;
}

/** The three windows the view shows, as the report computed them. They are
 *  three windows of one run, not a trend: the report keeps no rate history. */
export function rateRows(report: VelocityReport): RateRow[] {
  const want: { key: RateRow["key"]; label: string; days: number | null }[] = [
    { key: "24h", label: "Last 24h", days: 1 },
    { key: "3d", label: "Last 3 days", days: 3 },
    { key: "all", label: "Since start", days: null },
  ];
  const rows = want.flatMap((w) => {
    const win = report.throughput.windows.find((x) => x.key === w.key);
    return win ? [{ ...w, win }] : [];
  });
  const top = Math.max(0, ...rows.map((r) => r.win.agentPerDay ?? 0));
  return rows.map(({ key, label, days, win }) => ({
    key,
    label,
    perDay: win.agentPerDay,
    count: win.agent,
    fraction: top > 0 && win.agentPerDay != null ? win.agentPerDay / top : 0,
    clipped: days != null && win.days < days - 1e-9 ? `the run is ${win.days < 1 ? fmtDuration(win.days * 86_400_000) : `${win.days.toFixed(1)} days`} old` : null,
  }));
}
