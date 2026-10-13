import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DAY,
  fmtDuration,
  fmtPct,
  fmtRange,
  fmtRate,
  HOUR,
  MIN_OWNER_SAMPLE,
  targetRange,
  type Distribution,
  type ForecastTarget,
  type VelocityPhase,
  type VelocityReport,
} from "../../../shared/velocity.ts";

/**
 * The Velocity view's detail: the charts and tables under "Phase timings,
 * distributions and forecast method" (VelocityView.tsx). Inline SVG in the
 * board's state colours, each also said in words: green for agents working
 * and for completed steps, amber for what was held for the owner, blue for
 * CI, the merge queue and slots with nothing able to start, grey for counts
 * and for everything else. Each chart has its numbers as a table.
 */
const WORKING = "var(--state-working)";
const HELD = "var(--state-needs)";
const WAITING = "var(--state-waiting)";
const NEUTRAL = "var(--state-queued)";
const INK = "hsl(var(--foreground))";
const MUTED = "var(--state-queued)";
const RULE = "var(--board-line)";
const SURFACE = "var(--board-card)";

/** A phase's colour: what kind of time it was. */
const phaseColour = (p: { phase: VelocityPhase; active: boolean }) => (p.active ? WORKING : p.phase === "owner" ? HELD : p.phase === "merge" ? WAITING : NEUTRAL);

const WINDOW: Record<string, string> = { "24h": "Last 24 hours", "3d": "Last 3 days", "7d": "Last 7 days", all: "Since the run began" };
const steps = (n: number, what = "step") => `${n} ${what}${n === 1 ? "" : "s"}`;
const clock = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });

export function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="text-[13px] font-semibold text-foreground">{title}</h4>
      {note && <p className="text-muted-foreground">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export const Quiet = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground">{children}</p>;

/** A chart's numbers as a table, for whoever can't use the picture. */
function AsTable({ head, rows, label }: { head: string[]; rows: (string | number)[][]; label: string }) {
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-muted-foreground">Show as a table</summary>
      <table className="mt-1 w-full border-collapse text-left tabular-nums" aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td key={j} className="border-b border-board-line py-0.5 pr-3">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// ── Progress ──────────────────────────────────────────────────────────────

export function BurnUp({ r }: { r: VelocityReport }) {
  const titleId = useId();
  const pts = r.burnup.points;
  const total = Math.max(1, r.burnup.total);
  const now = r.generatedAt;
  const t0 = pts[0]?.t ?? now;
  const done = pts[pts.length - 1]?.done ?? 0;
  const target = r.forecast.ok ? (r.forecast.targets.find((t) => t.key === (r.view === "current" ? "scope" : "roadmap")) ?? null) : null;
  const range = target && done < total ? targetRange(target) : null;
  const history = Math.max(HOUR, now - t0);
  // The cone may run far past the history: the past keeps a quarter of the width.
  const wanted = range ? now + (range.high ?? range.low * 2) : now;
  const tEnd = Math.min(wanted, now + history * 3);
  const clipped = wanted > tEnd;
  const W = 760;
  const H = 220;
  const m = { l: 34, r: 16, t: 14, b: 24 };
  const x = (t: number) => m.l + ((Math.min(t, tEnd) - t0) / Math.max(1, tEnd - t0)) * (W - m.l - m.r);
  const y = (n: number) => H - m.b - (n / total) * (H - m.t - m.b);
  let line = "";
  pts.forEach((p, i) => {
    line += i === 0 ? `M${x(p.t).toFixed(1)},${y(p.done).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(p.done).toFixed(1)}`;
  });
  // Where a straight line from (now, done) to (t, total) leaves the plot.
  const edge = (t: number) => (t <= tEnd ? { x: x(t), y: y(total) } : { x: x(tEnd), y: y(done + ((total - done) * (tEnd - now)) / (t - now)) });
  const cone = range ? [edge(now + range.low), edge(now + (range.high ?? range.low * 2))] : null;
  const span = tEnd - t0;
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);
  const tick = (t: number) => (span > 6 * DAY ? day(t) : span > DAY ? `${day(t)} ${hourOf(t)}` : hourOf(t));
  const label = `${done} of ${total} steps complete${range && target ? `; forecast to finish in ${fmtRange(range.low, range.high)}` : ""}`;
  return (
    <div data-testid="velocity-burnup">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={titleId}>
        <title id={titleId}>{label}</title>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={m.l} x2={W - m.r} y1={y(total * f)} y2={y(total * f)} stroke={RULE} strokeWidth={1} />
            <text x={m.l - 6} y={y(total * f) + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>
              {Math.round(total * f)}
            </text>
          </g>
        ))}
        {ticks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 7} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} fontSize={10} fill={MUTED}>
            {tick(t)}
          </text>
        ))}
        {cone && (
          <g data-testid="velocity-cone">
            <polygon points={`${x(now)},${y(done)} ${cone[0]!.x},${cone[0]!.y} ${cone[0]!.y === y(total) && cone[1]!.y !== y(total) ? `${x(tEnd)},${y(total)} ` : ""}${cone[1]!.x},${cone[1]!.y}`} fill={MUTED} opacity={0.14} />
            <line x1={x(now)} y1={y(done)} x2={cone[0]!.x} y2={cone[0]!.y} stroke={MUTED} strokeWidth={1} />
            <line x1={x(now)} y1={y(done)} x2={cone[1]!.x} y2={cone[1]!.y} stroke={MUTED} strokeWidth={1} />
          </g>
        )}
        <line x1={x(now)} x2={x(now)} y1={m.t} y2={H - m.b} stroke={RULE} strokeWidth={1} />
        <path d={line} fill="none" stroke={WORKING} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(now)} cy={y(done)} r={4.5} fill={WORKING} stroke={SURFACE} strokeWidth={2} />
        <text x={x(now) - 8} y={Math.max(m.t + 10, y(done) - 9)} textAnchor="end" fontSize={11} fontWeight={600} fill={INK}>
          {done} done
        </text>
        <text x={W - m.r} y={y(total) - 5} textAnchor="end" fontSize={10} fill={MUTED}>
          {total} steps
        </text>
      </svg>
      <p className="text-muted-foreground" data-testid="velocity-burnup-caption">
        {range && target
          ? `${target.label}: ${fmtRange(range.low, range.high)} from now at the pace so far — the shaded range${clipped ? ", which runs past the right edge" : ""}.`
          : done >= total
            ? "Every step here is complete."
            : (r.forecast.reason ?? "No forecast for this scope yet.")}
      </p>
      <AsTable label="Steps completed over time" head={["When", "Completed"]} rows={pts.slice(-40).map((p) => [clock(p.t), p.done])} />
    </div>
  );
}

// ── Where the time goes, by phase ─────────────────────────────────────────

/** Every phase behind the four buckets: its accumulated time, its share and
 *  its median per step. */
export function PhaseTable({ r }: { r: VelocityReport }) {
  if (r.time.n === 0) {
    const n = r.totals.runAgent;
    return <Quiet>{n === 0 ? "No agent step has completed yet — the breakdown appears with the first one." : `${steps(n)} completed, none with a card whose time could be split.`}</Quiet>;
  }
  const rows = r.time.phases.filter((p) => p.totalMs >= 60_000);
  const top = Math.max(...rows.map((p) => p.share), 0.01);
  return (
    <div data-testid="velocity-phases">
      <table className="w-full border-collapse tabular-nums" aria-label="Time per phase">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="border-b border-board-line py-1 pr-2 font-medium">
              Phase / wait
            </th>
            <th scope="col" className="border-b border-board-line py-1 font-medium">
              <span className="sr-only">Share, drawn</span>
            </th>
            <th scope="col" className="border-b border-board-line py-1 pl-2 text-right font-medium">
              Accumulated
            </th>
            <th scope="col" className="border-b border-board-line py-1 pl-2 text-right font-medium">
              Share
            </th>
            <th scope="col" className="border-b border-board-line py-1 pl-2 text-right font-medium">
              Median / step
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.phase} data-testid={`velocity-phase-${p.phase}`}>
              <th scope="row" className="w-[34%] py-1 pr-2 text-left font-normal text-foreground">
                {p.label}
              </th>
              <td className="py-1">
                <div className="h-2.5 rounded-r-[3px]" style={{ width: `${Math.max(1.5, (p.share / top) * 100)}%`, background: phaseColour(p) }} />
              </td>
              <td className="w-16 py-1 pl-2 text-right text-foreground">{fmtDuration(p.totalMs)}</td>
              <td className="w-12 py-1 pl-2 text-right text-muted-foreground">{fmtPct(p.share)}</td>
              <td className="w-20 py-1 pl-2 text-right text-muted-foreground">{fmtDuration(p.medianMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-muted-foreground">
        Accumulated task time over {steps(r.time.n)}: tasks run side by side, so it is longer than the calendar time that passed.
        {r.time.stepsWithQuota > 0 && ` ${steps(r.time.stepsWithQuota)} ran into a usage limit.`}
        {r.time.unsplit > 0 && ` ${steps(r.time.unsplit)} more with a cycle time only.`}
      </p>
    </div>
  );
}

// ── Cycle time ────────────────────────────────────────────────────────────

const spread = (d: Distribution) => `median ${fmtDuration(d.median)} · p75 ${fmtDuration(d.p75)} · p90 ${fmtDuration(d.p90)} · ${fmtDuration(d.min)}–${fmtDuration(d.max)}`;

export function CycleTime({ r }: { r: VelocityReport }) {
  const titleId = useId();
  const d = r.cycle.all;
  if (!d) return <Quiet>No agent step has completed with a card yet.</Quiet>;
  const bins = r.cycle.histogram;
  const top = Math.max(1, ...bins.map((b) => b.count));
  const W = 360;
  const H = 108;
  const m = { l: 6, r: 6, t: 16, b: 20 };
  const band = (W - m.l - m.r) / bins.length;
  const bar = Math.min(24, band - 6);
  const h = (n: number) => (n / top) * (H - m.t - m.b);
  return (
    <div data-testid="velocity-cycle">
      <p className="tabular-nums text-foreground">
        {spread(d)} <span className="text-muted-foreground">({steps(d.n)})</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-auto w-full" role="img" aria-labelledby={titleId}>
        <title id={titleId}>{`Cycle times of ${steps(d.n)}: ${bins.filter((b) => b.count).map((b) => `${b.count} in ${b.label}`).join(", ")}`}</title>
        <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke={RULE} strokeWidth={1} />
        {bins.map((b, i) => {
          const cx = m.l + band * i + band / 2;
          const top_ = H - m.b - h(b.count);
          return (
            <g key={b.label}>
              {b.count > 0 && (
                <>
                  <path d={`M${cx - bar / 2},${H - m.b}V${top_ + 3}q0,-3 3,-3h${bar - 6}q3,0 3,3V${H - m.b}Z`} fill={NEUTRAL}>
                    <title>{`${b.label}: ${steps(b.count)}`}</title>
                  </path>
                  <text x={cx} y={top_ - 4} textAnchor="middle" fontSize={10} fill={INK}>
                    {b.count}
                  </text>
                </>
              )}
              <text x={cx} y={H - 6} textAnchor="middle" fontSize={9.5} fill={MUTED}>
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
      {r.lead.all && (
        <p className="mt-1 text-muted-foreground" title="From the step becoming ready (its last predecessor closed) to its issue closing: cycle time plus waiting for a slot, or for its milestone to be in scope">
          Lead time (ready → closed): <span className="tabular-nums">{spread(r.lead.all)}</span>
        </p>
      )}
      {r.cycle.byStage.length > 1 && (
        <p className="mt-0.5 text-muted-foreground">By stage: {r.cycle.byStage.map((s) => `${s.stage || "none"} ${fmtDuration(s.median)} (${s.n})`).join(" · ")}</p>
      )}
      <AsTable label="Cycle time distribution" head={["Cycle time", "Steps"]} rows={bins.map((b) => [b.label, b.count])} />
    </div>
  );
}

export function Rework({ r }: { r: VelocityReport }) {
  const w = r.rework;
  if (w.n === 0) return <Quiet>No reviewed step yet.</Quiet>;
  const top = Math.max(...w.roundsDist.map((d) => d.steps));
  return (
    <div data-testid="velocity-rework">
      <p className="text-foreground">
        <span className="tabular-nums">{w.roundsAvg!.toFixed(1)}</span> review rounds per step · <span className="tabular-nums">{fmtPct(w.firstPass)}</span> approved first time
      </p>
      <table className="mt-1.5 w-full border-collapse tabular-nums" aria-label="Review rounds per step">
        <tbody>
          {w.roundsDist.map((d) => (
            <tr key={d.rounds}>
              <th scope="row" className="w-24 py-0.5 pr-2 text-left font-normal text-foreground">
                {d.rounds} round{d.rounds === 1 ? "" : "s"}
              </th>
              <td className="py-0.5">
                <div className="h-2.5 rounded-r-[3px]" style={{ width: `${(d.steps / top) * 100}%`, background: NEUTRAL }} />
              </td>
              <td className="w-16 py-0.5 pl-2 text-right text-muted-foreground">{steps(d.steps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-muted-foreground">
        Finish sent {steps(w.stepsWithBounce)} back to Build ({w.finishBounces}×) · {w.fixCiRuns} automatic Fix CI run{w.fixCiRuns === 1 ? "" : "s"} on {steps(w.stepsWithFixCi)}
      </p>
    </div>
  );
}

// ── Slots ─────────────────────────────────────────────────────────────────

export function Slots({ r }: { r: VelocityReport }) {
  const titleId = useId();
  const u = r.utilisation;
  if (u.avgUsed == null) return <Quiet>No samples yet — every Autopilot pass adds one, starting with the first after this build was installed.</Quiet>;
  const s = u.series;
  const top = Math.max(1, ...s.map((p) => p.max ?? 0), r.maxInFlight);
  const W = 760;
  const H = 120;
  const m = { l: 34, r: 16, t: 10, b: 30 };
  const band = (W - m.l - m.r) / s.length;
  const bar = Math.min(10, band - 2);
  const y = (n: number) => H - m.b - (n / top) * (H - m.t - m.b);
  return (
    <div data-testid="velocity-slots-hourly">
      <p className="tabular-nums text-foreground">
        {u.avgUsed.toFixed(1)} of {Math.round(u.avgMax ?? r.maxInFlight)} occupied on average over all observed time ({fmtPct(u.share)}) · blocked {fmtPct(u.blockedShare)} of the time
        {(u.quotaShare ?? 0) > 0 && ` · holding for a usage limit ${fmtPct(u.quotaShare)}`}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-auto w-full" role="img" aria-labelledby={titleId}>
        <title id={titleId}>{`Slots occupied by hour over the last 48 hours. Over all observed time: ${u.avgUsed.toFixed(1)} of ${Math.round(u.avgMax ?? r.maxInFlight)} on average`}</title>
        {[0, top].map((n) => (
          <g key={n}>
            <line x1={m.l} x2={W - m.r} y1={y(n)} y2={y(n)} stroke={RULE} strokeWidth={1} />
            <text x={m.l - 6} y={y(n) + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>
              {n}
            </text>
          </g>
        ))}
        {s.map((p, i) => {
          const cx = m.l + band * i + band / 2;
          const when = `${day(p.t)} ${hourOf(p.t)}`;
          return (
            <g key={p.t}>
              {p.used == null ? (
                <rect x={cx - 1} y={H - m.b - 2} width={2} height={2} fill={MUTED} opacity={0.5}>
                  <title>{`${when}: no data — the app was closed or Autopilot paused`}</title>
                </rect>
              ) : (
                <>
                  <path d={`M${cx - bar / 2},${H - m.b}V${Math.min(H - m.b, y(p.used) + 2)}q0,-2 2,-2h${bar - 4}q2,0 2,2V${H - m.b}Z`} fill={NEUTRAL}>
                    <title>{`${when}: ${p.used.toFixed(1)} of ${Math.round(p.max ?? top)} slots occupied${p.blocked ? `, blocked ${fmtPct(p.blocked)} of the hour` : ""}`}</title>
                  </path>
                  {(p.blocked ?? 0) > 0.02 && (
                    <rect x={cx - bar / 2} y={H - m.b + 4} width={bar} height={4} rx={1} fill={WAITING} opacity={0.35 + 0.65 * p.blocked!}>
                      <title>{`${when}: blocked ${fmtPct(p.blocked)} of the hour`}</title>
                    </rect>
                  )}
                </>
              )}
              {i % 12 === 0 && (
                <text x={cx} y={H - 5} textAnchor="start" fontSize={10} fill={MUTED}>
                  {when}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-[2px]" style={{ background: NEUTRAL }} aria-hidden />
          Slots occupied (a slot may be waiting, not executing)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1 w-2 rounded-[1px]" style={{ background: WAITING }} aria-hidden />
          Blocked: slots idle, nothing in scope could start
        </span>
        <span>
          Watched {fmtDuration(u.knownMs)}
          {u.unknownMs > 60_000 && ` · ${fmtDuration(u.unknownMs)} unknown (the app was closed or Autopilot paused)`}
        </span>
      </div>
      <AsTable
        label="Slots occupied by hour"
        head={["Hour", "Occupied", "Of", "Blocked"]}
        rows={s.filter((p) => p.used != null).slice(-24).map((p) => [`${day(p.t)} ${hourOf(p.t)}`, p.used!.toFixed(1), Math.round(p.max ?? top), fmtPct(p.blocked)])}
      />
    </div>
  );
}

// ── Throughput ────────────────────────────────────────────────────────────

export function Throughput({ r }: { r: VelocityReport }) {
  const all = r.throughput.windows;
  // A window longer than the run is the run: shown once.
  const windows = all.filter((w) => w.key === "all" || w.days < all[all.length - 1]!.days - 1e-9);
  return (
    <div data-testid="velocity-throughput">
      <table className="w-full border-collapse text-left tabular-nums" aria-label="Throughput by window">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
              Window
            </th>
            <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
              Agent steps
            </th>
            <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
              Your steps
            </th>
          </tr>
        </thead>
        <tbody>
          {windows.map((w) => (
            <tr key={w.key}>
              <th scope="row" className="border-b border-board-line py-0.5 pr-3 font-normal">
                {WINDOW[w.key]} <span className="text-muted-foreground">({w.days < 1 ? fmtDuration(w.days * DAY) : `${w.days.toFixed(1)} days`})</span>
              </th>
              <td className="border-b border-board-line py-0.5 pr-3">
                {fmtRate(w.agentPerDay)}/day <span className="text-muted-foreground">({w.agent})</span>
              </td>
              <td className="border-b border-board-line py-0.5 pr-3">{w.owner ? `${fmtRate(w.ownerPerDay)}/day (${w.owner})` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-muted-foreground">
        {r.throughput.agentPerHour24 != null && `${r.throughput.agentPerHour24.toFixed(2)} agent steps per hour over the last 24 hours. `}
        {r.throughput.byStage.length > 0 && `Complete by stage: ${r.throughput.byStage.map((s) => `${s.stage || "none"} ${s.complete}/${s.total}`).join(" · ")}`}
      </p>
    </div>
  );
}

// ── Forecast ──────────────────────────────────────────────────────────────

export function Forecast({ r, delay, onDelay, onApply }: { r: VelocityReport; delay: string; onDelay: (v: string) => void; onApply: () => void }) {
  const f = r.forecast;
  const inputId = useId();
  if (!f.ok) {
    return (
      <p className="text-foreground" data-testid="velocity-forecast-none">
        {f.reason}
      </p>
    );
  }
  const anyOwner = f.targets.some((t) => t.ownerSteps > 0);
  const withYours = (t: ForecastTarget) => (t.ownerSteps === 0 ? "—" : t.simWithOwner ? fmtRange(t.simWithOwner.low, t.simWithOwner.high) : "unknown");
  return (
    <div data-testid="velocity-forecast">
      <table className="w-full border-collapse text-left tabular-nums" aria-label="Forecast ranges">
        <thead>
          <tr className="align-bottom text-muted-foreground">
            <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
              To finish
            </th>
            <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
              Left
            </th>
            <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
              {anyOwner ? "If your steps take no time" : "Simulated"}
            </th>
            {anyOwner && (
              <th scope="col" className="border-b border-board-line py-0.5 pr-3 font-medium">
                {f.ownerDelayMs != null ? `With ${fmtDuration(f.ownerDelayMs)} per step of yours` : "With your steps"}
              </th>
            )}
            <th scope="col" className="border-b border-board-line py-0.5 font-medium">
              Naive (left ÷ rate)
            </th>
          </tr>
        </thead>
        <tbody>
          {f.targets.map((t) => (
            <tr key={t.key} className="align-top" data-testid={`velocity-forecast-${t.key}`}>
              <th scope="row" className="border-b border-board-line py-1 pr-3 font-normal text-foreground">
                {t.label}
              </th>
              <td className="border-b border-board-line py-1 pr-3">
                {steps(t.remainingAgent, "agent step")}
                {t.ownerSteps > 0 && <div className="text-[color:var(--state-needs)]">{t.ownerSteps} of yours on the path</div>}
                {t.unreachable > 0 && <div className="text-muted-foreground">{t.unreachable} can never start</div>}
              </td>
              <td className="border-b border-board-line py-1 pr-3 font-medium text-foreground">{t.sim ? fmtRange(t.sim.low, t.sim.high) : "—"}</td>
              {anyOwner && <td className="border-b border-board-line py-1 pr-3 font-medium text-foreground">{withYours(t)}</td>}
              <td className="border-b border-board-line py-1 text-muted-foreground">{t.naive ? fmtRange(t.naive.low, t.naive.high) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyOwner && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="text-foreground">
            Assume each of your steps takes
          </label>
          <Input
            id={inputId}
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            data-testid="velocity-owner-delay"
            value={delay}
            placeholder={f.ownerDelayFrom === "observed" && f.ownerDelayMs != null ? (f.ownerDelayMs / HOUR).toFixed(1) : "?"}
            onChange={(e) => onDelay(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onApply()}
            className="h-7 w-20"
          />
          <span className="text-foreground">hours once it is ready</span>
          <Button size="sm" variant="outline" className="h-7" data-testid="velocity-owner-apply" onClick={onApply}>
            Apply
          </Button>
          <span className="text-muted-foreground">
            {f.ownerDelayFrom === "you"
              ? "Your assumption."
              : f.ownerDelayFrom === "observed"
                ? `Default: ${fmtDuration(f.ownerDelayMs)}, the median of the ${f.ownerSample} you have finished.`
                : `No default yet — it takes ${MIN_OWNER_SAMPLE} of your steps finished to have one (${f.ownerSample} so far).`}
          </span>
        </div>
      )}
      <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground" data-testid="velocity-forecast-notes">
        {f.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
