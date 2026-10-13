import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import type { CardAction } from "@/lib/card-state";
import { bottleneckRows, capacityView, rateRows, scopeView, timeBuckets, type BottleneckContext, type BottleneckRow, type ScopeKey, type TimeBucketKey } from "@/lib/velocity-view";
import { fmtDuration, fmtPct, fmtRange, fmtRate, type VelocityAnswer, type VelocityReport } from "../../../shared/velocity.ts";
import type { Task } from "../../../shared/types.ts";
import { InfoRow, PANEL, SectionHead, SUB } from "@/components/pipelines/run/parts";
import { StateBadge } from "./StateBadge";
import { BurnUp, CycleTime, Forecast, PhaseTable, Rework, Section, Slots, Throughput } from "./VelocityCharts";

const clock = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ROWS_SHOWN = 4;

interface Props {
  /** Null while the first answer is on its way. */
  answer: VelocityAnswer | null;
  error: string | null;
  /** The board's cards, to join each "move these next" step to its own. */
  tasks: Task[];
  ctx: BottleneckContext;
  /** The owner's assumed hours per step of theirs, as typed. */
  delay: string;
  onDelay: (v: string) => void;
  onApplyDelay: () => void;
  onBack: () => void;
  /** A row's button: the card's own action, dispatched as the board does. */
  onAction: (task: Task, action: CardAction) => void;
  initialScope?: ScopeKey;
}

/**
 * Velocity of the roadmap run (src/shared/velocity.ts; the numbers come from
 * `GET /autopilot/roadmap/velocity`), as a full view: a forecast range for
 * the chosen scope, how much is done, how fast steps complete, where a
 * step's time goes, what to move next and how full the slots are. Every
 * number is the report's own. Opened from the board's summary beside the
 * rocket and from the Autopilot dialog; Back returns to the board as it was.
 */
export function VelocityView({ answer, error, tasks, ctx, delay, onDelay, onApplyDelay, onBack, onAction, initialScope }: Props) {
  const [scope, setScope] = useState<ScopeKey>(initialScope ?? "roadmap");
  const r = answer?.available ? answer : null;
  return (
    <div data-testid="velocity-view" className="h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1280px] px-4 py-5 md:px-[22px]">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <button
              type="button"
              data-testid="velocity-back"
              onClick={onBack}
              className="mb-2 inline-flex items-center gap-1 rounded text-[11px] text-[color:var(--state-queued)] hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              Back to board
            </button>
            <h2 className="text-[23px] font-semibold leading-[1.3] tracking-tight text-foreground">Velocity</h2>
            {r && (
              <p className={cn(SUB, "mt-1")} data-testid="velocity-subtitle">
                Roadmap #{r.tracker} · snapshot {clock(r.asOf)}
                {r.runStartedAt != null ? ` · run started ${fmtDuration(r.generatedAt - r.runStartedAt)} ago` : " · when the run started is unavailable"}
              </p>
            )}
          </div>
          {r && (
            <div className="flex flex-wrap items-center gap-[9px] pt-1">
              <span className={SUB}>Forecast scope</span>
              <Segmented
                label="Forecast scope"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "gate", label: "Release gate", testId: "velocity-view-gate", title: "The forecast to the main-release gate. Completion is not supplied for this scope." },
                  { value: "roadmap", label: "Whole roadmap", testId: "velocity-view-roadmap" },
                ]}
              />
            </div>
          )}
        </header>
        {error && (
          <p role="alert" data-state="failed" className="mb-4 rounded-md bg-state-bg px-3 py-2 text-xs text-state">
            {error}
          </p>
        )}
        {!answer && !error && <p className={SUB}>Loading…</p>}
        {answer && !answer.available && (
          <p className="py-8 text-center text-sm text-[color:var(--state-queued)]" data-testid="velocity-empty">
            {answer.reason}
          </p>
        )}
        {r && <Report r={r} scope={scope} tasks={tasks} ctx={ctx} delay={delay} onDelay={onDelay} onApplyDelay={onApplyDelay} onAction={onAction} />}
      </div>
    </div>
  );
}

function Report({ r, scope, tasks, ctx, delay, onDelay, onApplyDelay, onAction }: { r: VelocityReport; scope: ScopeKey } & Pick<Props, "tasks" | "ctx" | "delay" | "onDelay" | "onApplyDelay" | "onAction">) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const view = scopeView(r, scope);
  // Everything but the forecast and the progress is the whole run's, whatever the scope.
  const runWide = scope === "gate" ? " · run-wide" : "";
  const f = r.forecast;
  const showMethod = () => {
    const el = detailsRef.current;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ block: "start" });
    el.querySelector<HTMLElement>(":scope > summary")?.focus();
  };
  return (
    <>
      <section data-testid="velocity-forecast-panel" data-scope={scope} aria-labelledby="velocity-forecast-title" className={cn(PANEL, "mb-5 grid grid-cols-1 items-center gap-x-4 gap-y-3 px-[18px] py-[17px] sm:grid-cols-[minmax(0,1fr)_auto]")}>
        <div className="min-w-0">
          <h3 id="velocity-forecast-title" className="text-sm font-semibold leading-[1.4] text-foreground">
            {view.title}
          </h3>
          {view.range ? (
            <>
              <p data-testid="velocity-forecast-range" className="my-1 text-[27px] font-semibold leading-[1.3] tracking-tight text-foreground">
                {fmtRange(view.range.low, view.range.high)}
              </p>
              <p className={SUB}>
                Estimated time remaining · a range, not a promised date
                {view.target && view.target.ownerSteps > 0 && !view.includesOwnerTime && " · your own steps are counted as taking no time"}
              </p>
            </>
          ) : (
            <>
              <p data-testid="velocity-forecast-range" className="my-1 text-xl font-semibold leading-[1.3] tracking-tight text-foreground">
                Forecast unavailable
              </p>
              <p className={SUB} data-testid="velocity-forecast-unavailable">
                {view.unavailable}
              </p>
            </>
          )}
          <button type="button" data-testid="velocity-method-link" onClick={showMethod} className={cn(SUB, "mt-1.5 rounded underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}>
            Assumptions and how the range is made
          </button>
        </div>
        <div className="text-xs leading-[1.6] text-[color:var(--state-queued)] sm:text-right">
          {view.target ? (
            <>
              <div>
                <strong data-testid="velocity-remaining-agent" className="font-semibold tabular-nums text-foreground">
                  {view.target.remainingAgent}
                </strong>{" "}
                agent {view.target.remainingAgent === 1 ? "step" : "steps"} remaining
              </div>
              <div>
                <strong data-testid="velocity-remaining-owner" className="font-semibold tabular-nums text-foreground">
                  {view.target.ownerSteps}
                </strong>{" "}
                human {view.target.ownerSteps === 1 ? "step" : "steps"} on the path
              </div>
              {view.target.unreachable > 0 && <div>{plural(view.target.unreachable, "step")} can never start (behind a declined step)</div>}
            </>
          ) : (
            <div>Remaining steps for this scope: unavailable</div>
          )}
          <div className="mt-1.5 text-[11px]">
            {f.ownerDelayMs != null
              ? `Assumes ${fmtDuration(f.ownerDelayMs)} per human step${f.ownerDelayFrom === "you" ? " (your figure)" : ` (the median of the ${f.ownerSample} finished)`}`
              : "No time is assumed per human step: none is observed yet"}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-x-6 md:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <section data-testid="velocity-progress" aria-labelledby="velocity-progress-title" className="mb-6">
            {view.completion ? (
              <>
                <SectionHead id="velocity-progress-title" title="Roadmap position" note={<span data-testid="velocity-progress-count">{`${view.completion.complete} of ${view.completion.total} complete`}</span>} />
                <Progress c={view.completion} />
              </>
            ) : (
              <>
                <SectionHead
                  id="velocity-progress-title"
                  title={scope === "gate" ? "Remaining on the release path" : "Roadmap position"}
                  note={<span data-testid="velocity-progress-count">{view.target ? `${view.target.remainingAgent + view.target.ownerSteps} remaining` : "unavailable"}</span>}
                />
                {view.target && (
                  <p className="text-xs text-foreground">
                    {plural(view.target.remainingAgent, "agent step")} · {plural(view.target.ownerSteps, "human step")}
                  </p>
                )}
                <p data-testid="velocity-completion-unavailable" className={cn(SUB, "mt-1")}>
                  {view.completionNote}
                </p>
              </>
            )}
          </section>

          <section data-testid="velocity-rates" aria-labelledby="velocity-rates-title" className="mb-5">
            <SectionHead id="velocity-rates-title" title="Completion rate" note="Agent steps · run-wide" />
            {rateRows(r).map((row) => (
              <div key={row.key} data-testid={`velocity-rate-${row.key}`} className="grid grid-cols-[78px_minmax(0,1fr)_112px] items-center gap-3 py-2 text-[11px]">
                <span className="text-foreground">{row.label}</span>
                <div className="h-[7px] overflow-hidden rounded-sm bg-state-neutral" aria-hidden>
                  <span className="block h-full bg-state-working" style={{ width: `${row.fraction * 100}%` }} />
                </div>
                <span className="text-right tabular-nums text-[color:var(--state-queued)]">
                  {row.perDay == null ? (
                    "unavailable"
                  ) : (
                    <>
                      <strong className="text-[13px] font-semibold text-foreground">{fmtRate(row.perDay)}</strong> / day · {row.count}
                    </>
                  )}
                </span>
                {row.clipped && <span className={cn(SUB, "col-span-3 -mt-1.5")}>{row.clipped}, so this window is the whole run</span>}
              </div>
            ))}
            <p className={SUB}>
              {plural(r.totals.runAgent, "agent step")} + {plural(r.totals.runOwner, "human step")} completed since the run began. A trend is unavailable: the report keeps these three windows, not a history of rates.
            </p>
          </section>

          <dl data-testid="velocity-tiles" className="mb-5 grid grid-cols-2 gap-3 border-y border-board-line py-[13px] sm:grid-cols-3">
            <Stat name="Median cycle time" value={r.cycle.all ? fmtDuration(r.cycle.all.median) : "unavailable"} note={r.cycle.all ? `p90 ${fmtDuration(r.cycle.all.p90)} · ${plural(r.cycle.all.n, "step")}${runWide}` : `no step measured yet${runWide}`} />
            <Stat name="Review rounds / step" value={r.rework.roundsAvg != null ? r.rework.roundsAvg.toFixed(1) : "unavailable"} note={r.rework.n > 0 ? `${fmtPct(r.rework.firstPass)} approved first time${runWide}` : `no reviewed step yet${runWide}`} />
            <Stat
              name="Agent working share"
              value={r.time.flowEfficiency != null ? fmtPct(r.time.flowEfficiency) : "unavailable"}
              note={r.time.flowEfficiency != null ? `${fmtPct(1 - r.time.flowEfficiency)} waiting · of accumulated task time${runWide}` : `no step's time could be split yet${runWide}`}
              className="col-span-2 sm:col-span-1"
            />
          </dl>

          <TimeAllocation r={r} runWide={runWide} />
        </div>

        <div className="min-w-0">
          <Bottlenecks r={r} tasks={tasks} ctx={ctx} scope={scope} onAction={onAction} />
          <Capacity r={r} runWide={runWide} />
        </div>
      </div>

      <details ref={detailsRef} data-testid="velocity-details" className="mt-2 border-t border-board-line pt-3 text-xs">
        <summary className="cursor-pointer rounded text-xs font-semibold text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Phase timings, distributions and forecast method</summary>
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
          <Section title="Time per phase" note="Run-wide: every completed agent step, whatever the forecast scope">
            <PhaseTable r={r} />
          </Section>
          <Section title="Forecast" note="An estimate — a range, not a date. Every scope the report forecasts">
            <Forecast r={r} delay={delay} onDelay={onDelay} onApply={onApplyDelay} />
          </Section>
          <Section title="Cycle time" note="Card start → issue closed, agent steps · run-wide">
            <CycleTime r={r} />
          </Section>
          <Section title="Rework" note="Run-wide">
            <Rework r={r} />
          </Section>
          <div className="md:col-span-2">
            <Section title="Progress over time" note={`Steps completed in ${r.scopeLabel}, against the ${r.burnup.total} it holds`}>
              <BurnUp r={r} />
            </Section>
          </div>
          <div className="md:col-span-2">
            <Section title="Slots by hour" note="Occupied slots over the last 48 hours. The averages above cover all observed time">
              <Slots r={r} />
            </Section>
          </div>
          <Section title="Throughput" note="Steps completed per day · run-wide">
            <Throughput r={r} />
          </Section>
          <Section title="What couldn't be measured">
            {r.dataQuality.length > 0 ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground" data-testid="velocity-quality">
                {r.dataQuality.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">Nothing is reported as unmeasured.</p>
            )}
            <p className="mt-2 text-muted-foreground">
              Throughput, cycle time, where time goes and capacity stay run-wide when the forecast scope changes. No completion count is derived for the release gate from its step number.
            </p>
          </Section>
        </div>
      </details>
    </>
  );
}

function Stat({ name, value, note, className }: { name: string; value: string; note: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className={SUB}>{name}</dt>
      <dd className={cn("my-[3px] font-semibold tracking-tight text-foreground", value === "unavailable" ? "text-sm" : "text-[19px] leading-tight tabular-nums")}>{value}</dd>
      <dd className={SUB}>{note}</dd>
    </div>
  );
}

/** Complete, agent steps still open, human steps still open: one bar, each
 *  part also in words under it. Declined steps are part of the total and of
 *  no segment. */
function Progress({ c }: { c: { complete: number; total: number; openAgent: number; openOwner: number; declined: number } }) {
  const of = Math.max(1, c.total);
  const part = (n: number) => `${(n / of) * 100}%`;
  return (
    <>
      <div
        role="img"
        aria-label={`Whole roadmap: ${c.complete} complete, ${c.openAgent} agent steps and ${c.openOwner} human steps remaining`}
        className="my-2.5 flex h-2.5 overflow-hidden rounded-[3px] bg-state-neutral"
      >
        <span className="block h-full bg-state-working" style={{ width: part(c.complete) }} />
        <span className="block h-full bg-[color:var(--state-queued)]" style={{ width: part(c.openAgent) }} />
        <span className="block h-full bg-[color:var(--state-needs)]" style={{ width: part(c.openOwner) }} />
      </div>
      <div className={cn(SUB, "flex flex-wrap justify-between gap-x-3 gap-y-1")}>
        <Legend colour="var(--state-working)" text={`${c.complete} complete`} />
        <Legend colour="var(--state-queued)" text={`${c.openAgent} agent, not done`} />
        <Legend colour="var(--state-needs)" text={`${c.openOwner} human, not done`} />
        {c.declined > 0 && <span>{c.declined} declined</span>}
      </div>
    </>
  );
}

function Legend({ colour, text }: { colour: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-[5px]">
      <span aria-hidden className="inline-block size-[7px] rounded-[2px]" style={{ background: colour }} />
      {text}
    </span>
  );
}

const BUCKET_COLOUR: Record<TimeBucketKey, string> = { working: "var(--state-working)", held: "var(--state-needs)", ci: "var(--state-waiting)", other: "var(--state-queued)" };

function TimeAllocation({ r, runWide }: { r: VelocityReport; runWide: string }) {
  const buckets = timeBuckets(r);
  const [picked, setPicked] = useState<TimeBucketKey>("held");
  const selected = buckets.find((b) => b.key === picked)!;
  const measured = buckets.some((b) => b.share != null);
  return (
    <section data-testid="velocity-time" aria-labelledby="velocity-time-title" className="mb-6">
      <SectionHead id="velocity-time-title" title="Where time goes" note={`${plural(r.time.n, "completed agent step")}${runWide}`} />
      {!measured ? (
        <p className={SUB}>{r.totals.runAgent === 0 ? "Unavailable: no agent step has completed yet." : "Unavailable: no completed step has a card whose time could be split."}</p>
      ) : (
        <>
          <div role="img" aria-label={buckets.map((b) => `${b.label} ${fmtPct(b.share)}`).join(", ")} className="my-3 flex h-[19px] gap-[3px] overflow-hidden rounded-[3px]">
            {buckets.map((b) => (
              <span key={b.key} data-bucket={b.key} className="block h-full" style={{ width: `${(b.share ?? 0) * 100}%`, background: BUCKET_COLOUR[b.key] }} />
            ))}
          </div>
          <div role="group" aria-label="Time buckets" className="grid grid-cols-1 gap-x-3 gap-y-[7px] sm:grid-cols-2">
            {buckets.map((b) => (
              <button
                key={b.key}
                type="button"
                data-testid={`velocity-bucket-${b.key}`}
                aria-pressed={picked === b.key}
                onClick={() => setPicked(b.key)}
                className={cn(
                  "flex items-center justify-between gap-1.5 border-b-2 py-[5px] text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  picked === b.key ? "border-foreground text-foreground" : "border-transparent text-[color:var(--state-queued)] hover:text-foreground",
                )}
              >
                <span className="flex items-center gap-[5px]">
                  <span aria-hidden className="inline-block size-[7px] rounded-[2px]" style={{ background: BUCKET_COLOUR[b.key] }} />
                  {b.label}
                </span>
                <strong className="font-semibold tabular-nums">{fmtPct(b.share)}</strong>
              </button>
            ))}
          </div>
          <p data-testid="velocity-bucket-detail" data-state={selected.tone} aria-live="polite" className="mt-3 min-h-12 rounded-md bg-state-bg px-[11px] py-[9px] text-[11px] leading-[1.45] text-state">
            {selected.detail}
          </p>
          <p className={cn(SUB, "mt-2")}>This is accumulated task time: tasks run side by side, so it is longer than the calendar time that passed. Percentages are rounded.</p>
        </>
      )}
    </section>
  );
}

function Bottlenecks({ r, tasks, ctx, scope, onAction }: { r: VelocityReport; tasks: Task[]; ctx: BottleneckContext; scope: ScopeKey; onAction: Props["onAction"] }) {
  const [all, setAll] = useState(false);
  const rows = bottleneckRows(r, tasks, ctx);
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  return (
    <section data-testid="velocity-bottlenecks" aria-labelledby="velocity-next-title" className="mb-6">
      <SectionHead id="velocity-next-title" title="Move these next" note={`By steps behind each · ${r.scopeLabel}${scope === "gate" ? ", not only the release path" : ""}`} />
      {rows.length === 0 ? (
        <p className={SUB}>Nothing is holding other steps back right now.</p>
      ) : (
        <ol>
          {shown.map((row) => (
            <BottleneckItem key={row.issue} row={row} onAction={onAction} />
          ))}
        </ol>
      )}
      {rows.length > ROWS_SHOWN && (
        <button type="button" data-testid="velocity-bottlenecks-all" aria-expanded={all} onClick={() => setAll((v) => !v)} className={cn(SUB, "mt-2 rounded font-semibold hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}>
          {all ? `Show the first ${ROWS_SHOWN}` : `Show all ${rows.length}`}
        </button>
      )}
      {rows.length > 0 && <p className={cn(SUB, "mt-2")}>These counts overlap: the same step can be behind several of these, and resolving one task does not start every step behind it.</p>}
    </section>
  );
}

function BottleneckItem({ row, onAction }: { row: BottleneckRow; onAction: Props["onAction"] }) {
  const { task, action } = row;
  return (
    <li data-testid="velocity-bottleneck" data-issue={row.issue} data-state={row.tone} className="border-b border-board-line py-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <StateBadge tone={row.tone} icon={row.icon} label={row.label} testId="velocity-bottleneck-state" />
        <span className={cn(SUB, "tabular-nums")}>
          step {row.step} · #{row.issue}
        </span>
      </div>
      <p className="my-1 text-xs font-semibold leading-[1.4] text-foreground [overflow-wrap:anywhere]">{row.title}</p>
      <p className={cn(SUB, "[overflow-wrap:anywhere]")}>
        <span data-testid="velocity-bottleneck-reason" data-known={row.reasonKnown}>
          {row.reason}
        </span>{" "}
        · {row.dependentsLabel}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className={cn(SUB, "tabular-nums")}>{row.timing ?? (task ? "No retry is scheduled" : "No card on the board")}</span>
        {task && action && (
          <button
            type="button"
            data-testid="velocity-bottleneck-action"
            data-action={action.kind}
            aria-label={`${action.label}: #${row.issue}`}
            onClick={() => onAction(task, action)}
            className="inline-flex min-h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-state-bg px-2.5 py-1.5 text-[11px] font-semibold leading-none text-state hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-state dark:hover:brightness-110"
          >
            {action.label}
            <ArrowRight className="size-3 shrink-0" aria-hidden />
          </button>
        )}
      </div>
    </li>
  );
}

function Capacity({ r, runWide }: { r: VelocityReport; runWide: string }) {
  const c = capacityView(r);
  return (
    <section data-testid="velocity-slots" aria-labelledby="velocity-capacity-title" className="mb-6">
      <SectionHead id="velocity-capacity-title" title="Execution capacity" note={`${c.window}${runWide}`} />
      <dl>
        <InfoRow name="Slots occupied, on average" testId="velocity-occupied">
          <strong className="font-semibold tabular-nums">{c.occupied}</strong>
        </InfoRow>
      </dl>
      {c.available && (
        <div role="img" aria-label={`Average occupancy ${c.occupied} slots`} className="my-3 flex gap-1">
          {c.pips.map((p, i) => (
            <span
              key={i}
              data-pip={p}
              className="h-[9px] flex-1 rounded-sm bg-state-neutral"
              style={p === "full" ? { background: "var(--state-queued)" } : p === "half" ? { background: "linear-gradient(to right, var(--state-queued) 50%, var(--state-queued-bg) 50%)" } : undefined}
            />
          ))}
        </div>
      )}
      <dl>
        <InfoRow name="Blocked by readiness / scope">{c.blockedShare}</InfoRow>
        <InfoRow name="Usage-limit holds">{c.quotaShare}</InfoRow>
      </dl>
      <p className={cn(SUB, "mt-2")}>{c.available ? c.note : "Unavailable: no slot samples yet. Every Autopilot pass adds one."}</p>
    </section>
  );
}
