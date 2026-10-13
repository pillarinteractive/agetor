import { useEffect } from "react";
import { ArrowRight, ExternalLink, FolderOpen, RotateCcw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Task } from "../../../shared/types.ts";
import { triedLine } from "../../../shared/block-wait.ts";
import { shortPipelineName } from "@/components/pipelines/PipelineBadge";
import { clockTime, formatElapsed, type CardAction, type CardState } from "@/lib/card-state";
import { useCardState } from "@/lib/use-card-state";
import { formatAge } from "@/lib/card-status";
import { whyStopped } from "@/lib/board-health";
import { columnLabel } from "@/lib/column-labels";
import { useTaskPr } from "@/lib/prs";
import { splitCardTitle } from "@/lib/card-names";
import { STATE_ICONS } from "./TaskCard";

interface Props {
  task: Task;
  onClose: () => void;
  /** "Open run": the full view, as a double click on the card. */
  onOpen: (t: Task) => void;
  /** The same dispatcher the cards' own buttons use (App.tsx `onCardAction`). */
  onAction: (t: Task, action: CardAction) => void;
  /** Restart the whole pipeline from its first step. The caller asks first. */
  onRestart: (t: Task) => void;
  onStop: (t: Task) => void;
  /** False while the run panel is open: Escape is the panel's then. */
  escapeCloses?: boolean;
}

/** What each recovery button does, in a sentence: resuming the step that
 *  stopped is not restarting the pipeline, and the two are easy to confuse. */
function recoveryNote(task: Task, state: CardState): string | null {
  const step = state.step?.name ?? "the step";
  const status = task.pipelineRun?.status;
  if (state.kind === "step-cap") return `Retry resumes ${step} with another step allowance. It does not restart the pipeline.`;
  if (status === "cancelled") return `Resume continues ${step} where it was stopped. Restart pipeline starts again from the first step and clears this run's history.`;
  if (state.kind === "auto-retry" || (state.kind === "dependency" && status === "blocked")) return `Nothing is needed from you: ${step} is retried by itself. Retry tries it now instead of waiting.`;
  if (status === "blocked") return `Retry runs ${step} again in place. Restart pipeline starts again from the first step and clears this run's history.`;
  if (state.state === "waiting") return "This wait ends by itself. A wait is not an agent working.";
  return null;
}

/** When the stopped step is tried again without anyone asking, from the
 *  wait queue (`run.wait`), a scheduled retry (`run.autoRetry`) or a held
 *  input (`inputRetry` on a block). */
function retrySchedule(task: Task, now: number): [string, string][] {
  const run = task.pipelineRun;
  if (!run || run.status !== "blocked") return [];
  const rows: [string, string][] = [];
  const w = run.wait;
  if (w) {
    rows.push(["Waits on", w.what]);
    rows.push(["Waiting since", `${clockTime(w.since)} (${formatElapsed(now - w.since)})`]);
    if (w.state === "waiting") rows.push(["Next retry", w.at != null ? clockTime(w.at) : "soon"]);
    rows.push(["Attempts", `${w.attempt} of ${Math.max(1, w.max)} used — ${triedLine(w, now)}`]);
    rows.push(w.state === "escalated" ? ["Given up", w.escalation ?? "automatic retries ran out"] : ["Gives up at", clockTime(w.deadline)]);
  }
  const r = run.autoRetry;
  if (r?.at != null) {
    rows.push(["Next retry", clockTime(r.at)]);
    rows.push(["Attempt", String(r.attempt)]);
    rows.push([r.kind === "quota" ? "Usage limit" : "Failure", r.reason]);
  }
  const held = run.blocked.find((b) => b.inputRetry != null)?.inputRetry;
  if (held && !w && r?.at == null) {
    rows.push(["Next check", clockTime(held.at)]);
    rows.push(["Attempt", String(held.attempt)]);
  }
  return rows;
}

/**
 * The selected card, docked under the board: its status, step and state as
 * three separate facts, the reasons in full, when it is retried, what the PR
 * watcher last saw, and every action the card has. Opens on a card click and
 * closes on Escape or its own button; the board stays the main view.
 */
export function CardInspector({ task, onClose, onOpen, onAction, onRestart, onStop, escapeCloses = true }: Props) {
  const state = useCardState(task);
  const pr = useTaskPr(task.id);
  const now = Date.now();

  // Escape closes the inspector — unless a layer above the board (a dialog,
  // a popover, the quote pill) is open: that layer's own listener takes the
  // key, and the next Escape reaches here.
  useEffect(() => {
    if (!escapeCloses) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [data-popover-open], [data-quote-open]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, escapeCloses]);

  const run = task.pipelineRun ?? null;
  const title = splitCardTitle(task.title);
  const StateIcon = STATE_ICONS[state.icon];
  const why = whyStopped(task, pr);
  // The step's own words, when they say more than the card's one line.
  const said = (why?.lines ?? [])
    .map((l) => l.replace(/^step "[^"]*" failed(?: —|:)?\s*/i, ""))
    .filter((l) => l && l !== state.reason)
    .slice(0, 6);
  const ownersMove = state.state === "needs" || state.state === "failed";
  const schedule = retrySchedule(task, now);
  const note = recoveryNote(task, state);
  const stepProfileId = run?.snapshot?.graph.steps.find((s) => s.id === state.step?.id)?.agentProfileId;
  const agent = (stepProfileId ? run?.snapshot?.profiles[stepProfileId]?.name : undefined) ?? task.agentProfile?.name ?? (run ? null : task.agent);
  const prUrl = pr?.url ?? task.prUrl ?? null;
  const own = pr ? pr.failingChecks.filter((c) => !c.alsoOnBase) : [];
  const inherited = pr ? pr.failingChecks.filter((c) => c.alsoOnBase) : [];

  const archived = task.archivedAt != null;
  const primary = state.action;
  const stepName = state.step?.id ? state.step.name : "step";
  // Resuming the stopped step, offered whenever the server would take it
  // (a blocked or stopped run), unless it is already the card's own button.
  const canRetry = !archived && !!task.pipelineId && (run?.status === "blocked" || run?.status === "cancelled") && primary?.kind !== "retry";
  const canRestart = !archived && !!task.pipelineId && (run?.status === "blocked" || run?.status === "cancelled" || run?.status === "done");
  const canStop = !archived && (task.pipelineId ? run?.status === "running" : task.column === "running" || task.column === "blocked");

  return (
    <section
      data-testid="card-inspector"
      data-state={state.state}
      aria-label={`Selected card: ${task.title}`}
      className="mx-4 mb-3 grid max-h-[42vh] shrink-0 grid-cols-1 gap-x-4 gap-y-3 overflow-y-auto rounded-lg border border-board-line bg-board-card p-3 text-[11px] text-muted-foreground md:grid-cols-[1.2fr_1fr]"
    >
      <div className="min-w-0">
        <h2 className="mb-1 text-[13px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
          {title.issue && <span className="tabular-nums">#{title.issue} · </span>}
          {title.text}
        </h2>
        <p data-testid="inspector-reason" className="leading-[1.45] [overflow-wrap:anywhere]">
          {state.reason}
        </p>
        {why && (ownersMove || said.length > 0) && (
          <div className="mt-2">
            {/* What clears it is the owner's to know only when it is the
             *  owner's move; a wait that ends by itself gets the schedule below. */}
            <p className="font-semibold text-foreground">
              {ownersMove ? why.title : "The step says"}
              {ownersMove && <span className="font-normal text-muted-foreground"> · {why.clears}</span>}
            </p>
            {said.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-[1.45] [overflow-wrap:anywhere]">
                {said.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {schedule.length > 0 && (
          <dl data-testid="inspector-retry-schedule" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {schedule.map(([k, v], i) => (
              <div key={i} className="contents">
                <dt className="whitespace-nowrap">{k}</dt>
                <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {note && (
          <p data-testid="inspector-recovery-note" className="mt-2 leading-[1.45]">
            {note}
          </p>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          {/* Three separate facts: where the card is in the workflow, where
           *  its pipeline is, and what is happening now. */}
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            <span data-testid="inspector-status" className="rounded bg-state-neutral px-1.5 py-[3px] text-[color:var(--state-queued)]">
              Status: {columnLabel(task.column)}
            </span>
            <span data-testid="inspector-step" className="rounded bg-state-neutral px-1.5 py-[3px] text-[color:var(--state-queued)]">
              Step: {state.step ? `${state.step.name}${state.step.round ? ` · round ${state.step.round}` : ""}` : task.pipelineId ? "not started" : "no pipeline"}
            </span>
            <span data-testid="inspector-state" className="inline-flex items-center gap-1 rounded bg-state-bg px-1.5 py-[3px] font-semibold text-state">
              <StateIcon className="size-3 shrink-0" aria-hidden />
              State: {state.label}
            </span>
          </div>
          <button
            type="button"
            data-testid="inspector-close"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close (Esc)"
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-state-neutral hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
        <p className="mt-2 leading-[1.45]">
          {[agent, run ? shortPipelineName(run.pipelineName) : null, state.elapsedMs != null ? `${state.state === "working" || state.kind === "quiet" ? "running" : "waiting"} ${formatElapsed(state.elapsedMs)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {pr && (
          <dl data-testid="inspector-pr" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt>PR #{pr.number}</dt>
            <dd className="text-foreground">
              {pr.state}
              {pr.draft ? " · draft" : ""}
              {pr.baseRef ? ` · into ${pr.baseRef}` : ""}
            </dd>
            <dt>Checks</dt>
            <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">
              {pr.checks === "none" ? "none reported" : pr.checks === "success" ? "passing" : pr.checks === "pending" ? "running" : "failing"}
              {own.length > 0 && ` · ${own.map((c) => c.name).join(", ")}`}
              {inherited.length > 0 && ` · also failing on ${pr.baseRef ?? "base"}: ${inherited.map((c) => c.name).join(", ")}`}
            </dd>
            {pr.behindBy != null && (
              <>
                <dt>Branch</dt>
                <dd className="text-foreground">{pr.behindBy > 0 ? `${pr.behindBy} behind ${pr.baseRef ?? "base"}` : `up to date with ${pr.baseRef ?? "base"}`}</dd>
              </>
            )}
            {pr.unresolvedThreads > 0 && (
              <>
                <dt>Review</dt>
                <dd className="text-foreground">
                  {pr.unresolvedThreads} unresolved comment{pr.unresolvedThreads === 1 ? "" : "s"}
                </dd>
              </>
            )}
            <dt>Checked</dt>
            <dd className="text-foreground">{now - pr.checkedAt < 60_000 ? "just now" : `${formatAge(now - pr.checkedAt)} ago`}</dd>
          </dl>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 md:col-span-2" data-testid="inspector-actions">
        {primary && primary.kind !== "inspect" && (
          <button
            type="button"
            data-testid="inspector-primary"
            data-action={primary.kind}
            onClick={() => onAction(task, primary)}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-state-bg px-2.5 text-[11px] font-semibold text-state hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-state dark:hover:brightness-110"
          >
            {primary.label}
            <ArrowRight className="size-3" aria-hidden />
          </button>
        )}
        {canRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="inspector-retry"
            className="h-7 gap-1 px-2.5 text-[11px]"
            title={run?.status === "cancelled" ? `Continue ${stepName} where it was stopped` : `Run ${stepName} again in place`}
            onClick={() => onAction(task, { kind: "retry", label: "Retry", stepTaskId: null })}
          >
            <RotateCcw className="size-3" aria-hidden />
            {run?.status === "cancelled" ? "Resume" : "Retry"} {stepName}
          </Button>
        )}
        {canRestart && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="inspector-restart"
            className="h-7 gap-1 px-2.5 text-[11px]"
            title="Start the pipeline again from its first step — asks first"
            onClick={() => onRestart(task)}
          >
            <RotateCcw className="size-3" aria-hidden />
            Restart pipeline…
          </Button>
        )}
        {canStop && (
          <Button type="button" size="sm" variant="outline" data-testid="inspector-stop" className="h-7 gap-1 px-2.5 text-[11px]" onClick={() => onStop(task)}>
            <Square className="size-3" aria-hidden />
            Stop
          </Button>
        )}
        {prUrl && primary?.kind !== "view-pr" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="inspector-pr-open"
            className="h-7 gap-1 px-2.5 text-[11px]"
            onClick={() => onAction(task, { kind: "view-pr", label: "Inspect PR", url: prUrl })}
          >
            <ExternalLink className="size-3" aria-hidden />
            Inspect PR
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="inspector-open"
          className="ml-auto h-7 gap-1 px-2.5 text-[11px]"
          onClick={() => onOpen(task)}
        >
          <FolderOpen className="size-3" aria-hidden />
          Open run
        </Button>
      </div>
    </section>
  );
}
