import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAge } from "@/lib/card-status";
import { clockTime } from "@/lib/card-state";
import { formatSpan, outcomeLabel, roundOf, type ExecutionSummary } from "@/lib/run-view";
import type { Handoff, PipelineGraph, PipelineRunState, PipelineStepRecord } from "../../../../shared/types.ts";
import { SectionHead, SUB } from "./parts";

export interface RunActivityEntry {
  ts: number;
  kind: string;
  text: string;
  tone: "muted" | "info" | "success" | "warning" | "danger";
  url?: string;
}

export type ResponseKindInfo = { text: string; tone: "success" | "warning" | "danger" | "muted" };

// The same pairs the board's states use: red for a failure, amber for the
// owner's attention, green for a clean handoff, grey for the rest.
const TONE_STATE: Record<ResponseKindInfo["tone"], string> = { success: "working", warning: "needs", danger: "failed", muted: "queued" };
const DOT: Record<RunActivityEntry["tone"], string> = { danger: "failed", warning: "needs", success: "working", info: "waiting", muted: "queued" };

const ACTIVITY_SHOWN = 6;
const HISTORY_SHOWN = 3;

/**
 * What happened on this card and when, newest first: steps starting, handing
 * off and blocking; the PR opening, CI going red or green, review comments, a
 * merge; a lease taken or released; automatic Fix CI. These are recorded
 * events: a CI pass in this list is history, not the current head's result.
 */
export function RecentActivity({ entries, now, onOpenUrl }: { entries: RunActivityEntry[] | null; now: number; onOpenUrl?: (url: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? (entries ?? []) : (entries ?? []).slice(0, ACTIVITY_SHOWN);
  return (
    <section aria-labelledby="run-activity-title" className="min-w-0">
      <SectionHead id="run-activity-title" title="Recent activity" note="Recorded events" />
      {entries == null ? (
        <p className={SUB}>Activity is unavailable right now.</p>
      ) : entries.length === 0 ? (
        <p className={SUB}>Nothing has been recorded for this card yet.</p>
      ) : (
        <ol data-testid="activity-timeline" className="text-[11px] leading-[1.45]">
          {shown.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 border-b border-board-line py-2.5">
              <time dateTime={new Date(e.ts).toISOString()} title={new Date(e.ts).toLocaleString()} className="tabular-nums text-[color:var(--state-queued)]">
                {formatAge(now - e.ts) === "just now" ? "just now" : `${formatAge(now - e.ts)} ago`}
              </time>
              <span data-state={DOT[e.tone]} className="flex min-w-0 items-start gap-1.5 text-foreground">
                <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-state" />
                {e.url && onOpenUrl ? (
                  <button type="button" onClick={() => onOpenUrl(e.url!)} className="min-w-0 text-left underline-offset-2 [overflow-wrap:anywhere] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                    {e.text}
                  </button>
                ) : (
                  <span className="min-w-0 [overflow-wrap:anywhere]">{e.text}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {(entries?.length ?? 0) > ACTIVITY_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className={cn(SUB, "mt-2 inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring")}>
          {all ? "Show fewer" : `Show all ${entries!.length}`}
          <ChevronDown className={cn("size-3", all && "rotate-180")} aria-hidden />
        </button>
      )}
    </section>
  );
}

function HistoryRow({
  record,
  run,
  graph,
  now,
  renderHandoff,
  responseKind,
}: {
  record: PipelineStepRecord;
  run: PipelineRunState;
  graph: PipelineGraph | null;
  now: number;
  renderHandoff: (h: Handoff) => ReactNode;
  responseKind?: (kind: PipelineStepRecord["responseKind"]) => ResponseKindInfo | null;
}) {
  const [open, setOpen] = useState(false);
  const stepName = graph?.steps.find((s) => s.id === record.stepId)?.name ?? record.stepId;
  const round = roundOf(run, record);
  const elapsed = record.endedAt != null ? formatSpan(record.endedAt - record.startedAt) : `${formatSpan(now - record.startedAt)} so far`;
  const kindInfo = responseKind?.(record.responseKind) ?? null;
  return (
    <li data-testid="pipeline-run-history-row" className="border-b border-board-line py-2 text-[11px] leading-[1.45]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!record.handoff}
        title={record.handoff ? "Show this execution's handoff" : "This execution recorded no handoff"}
        className="grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_6.5rem] items-baseline gap-3 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 truncate text-foreground">
          <span className="tabular-nums">#{record.seq}</span> {stepName}
          {round > 1 && <span className="text-[color:var(--state-queued)]"> · round {round}</span>}
        </span>
        <span className="min-w-0 truncate text-[color:var(--state-queued)]" data-outcome={record.outcome ?? "open"}>
          {outcomeLabel(record, graph)}
        </span>
        <span className="shrink-0 text-right tabular-nums text-foreground">{elapsed}</span>
      </button>
      {(kindInfo || record.reminder) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {kindInfo && (
            <span data-testid="pipeline-run-response-kind" data-kind={record.responseKind} data-state={TONE_STATE[kindInfo.tone]} className="inline-flex items-center rounded bg-state-bg px-1.5 py-0.5 text-[10px] font-medium text-state">
              {kindInfo.text}
            </span>
          )}
          {record.reminder && (
            <span
              data-testid="pipeline-run-reminder"
              title={record.reminder.detail}
              data-delivered={record.reminder.delivered !== false}
              data-state={record.reminder.delivered === false ? "failed" : "needs"}
              className="inline-flex items-center gap-1 rounded bg-state-bg px-1.5 py-0.5 text-[10px] font-medium text-state"
            >
              {record.reminder.delivered === false ? "Reminder failed" : "Reminder sent"} · {clockTime(record.reminder.at)}
            </span>
          )}
        </div>
      )}
      {open && record.handoff && (
        <div data-testid="pipeline-run-history-handoff" className="mt-2">
          {renderHandoff(record.handoff)}
        </div>
      )}
    </li>
  );
}

/** Every execution the run recorded, newest first: the newest three, then
 *  the rest on request. A row opens that execution's handoff. */
export function ExecutionHistory({
  run,
  graph,
  summary,
  now,
  renderHandoff,
  responseKind,
}: {
  run: PipelineRunState;
  graph: PipelineGraph | null;
  summary: ExecutionSummary;
  now: number;
  renderHandoff: (h: Handoff) => ReactNode;
  responseKind?: (kind: PipelineStepRecord["responseKind"]) => ResponseKindInfo | null;
}) {
  const [all, setAll] = useState(false);
  const records = [...run.history].sort((a, b) => b.seq - a.seq);
  const shown = all ? records : records.slice(0, HISTORY_SHOWN);
  return (
    <section aria-labelledby="run-history-title" className="min-w-0">
      <SectionHead id="run-history-title" title="Execution history" note={summary.label} />
      {records.length === 0 ? (
        <p className={SUB}>No steps have run yet.</p>
      ) : (
        <>
          <div aria-hidden className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_6.5rem] gap-3 border-b border-board-line pb-1.5 text-[11px] font-medium text-[color:var(--state-queued)]">
            <span>Execution</span>
            <span>Outcome</span>
            <span className="text-right">Elapsed</span>
          </div>
          <ul data-testid="pipeline-run-history">
            {shown.map((record) => (
              <HistoryRow key={record.seq} record={record} run={run} graph={graph} now={now} renderHandoff={renderHandoff} responseKind={responseKind} />
            ))}
          </ul>
          {records.length > HISTORY_SHOWN && (
            <button
              type="button"
              data-testid="pipeline-run-history-all"
              onClick={() => setAll((v) => !v)}
              aria-expanded={all}
              className={cn(SUB, "mt-2 inline-flex items-center gap-1 rounded font-semibold hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring")}
            >
              {all ? "Show the newest 3" : `Show all ${records.length} executions`}
              <ChevronDown className={cn("size-3", all && "rotate-180")} aria-hidden />
            </button>
          )}
          <p className={cn(SUB, "mt-2")}>Elapsed execution time can include waits. A handoff does not mean the task is merged.</p>
        </>
      )}
    </section>
  );
}
