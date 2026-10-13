import { useState, type ReactNode } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clockTime, formatElapsed, type CardState } from "@/lib/card-state";
import { formatAge } from "@/lib/card-status";
import { hasLiveExecution, type AdvanceTarget, type ExecutionSummary, type RecoveryControls } from "@/lib/run-view";
import { StateBadge } from "@/components/kanban/StateBadge";
import { recoveryNote, retrySchedule } from "@/components/kanban/CardInspector";
import type { Handoff, PipelineGraph, PipelineRunState, Task, TaskPrStatus } from "../../../../shared/types.ts";
import { AdvanceForm } from "./AdvanceForm";
import { InfoRow, PANEL, SUB } from "./parts";

/** Who has to act for the run to move, in a word or two. */
function recoveryWord(run: PipelineRunState | null, state: CardState): string {
  if (!run || (run.status === "idle" && run.history.length === 0)) return "Not started";
  if (run.status === "done") return state.state === "needs" || state.state === "failed" ? "Needs you" : state.state === "waiting" ? "Automatic" : "None needed";
  if (run.status === "cancelled") return "Stopped: resume it when ready";
  if (state.state === "waiting") return "Automatic";
  if (state.state === "needs" || state.state === "failed") return "Needs you";
  if (state.state === "working") return "None needed";
  return "Waiting to start";
}

const blockWords = (kind: string) => (kind === "slot-wait" ? "queued — starts when a slot frees up" : kind === "await" ? "waiting on a long command — wakes when it finishes" : kind);

/**
 * Beside the selected step: what holds the run and how it recovers, as
 * plain rows — the retry schedule, whether any agent is executing, the pull
 * request, the step cap — then each block in the step's own words. Restart
 * and manual Advance are under "Advanced run controls": each is a
 * different thing from retrying, and each asks before it does anything.
 */
export function HoldAside({
  task,
  run,
  graph,
  steps,
  state,
  pr,
  now,
  summary,
  controls,
  busy,
  profileName,
  renderHandoff,
  liveProgress,
  onOpenTask,
  onRestart,
  onAdvance,
}: {
  task: Task;
  run: PipelineRunState | null;
  graph: PipelineGraph | null;
  steps: Task[];
  state: CardState;
  pr: TaskPrStatus | null;
  now: number;
  summary: ExecutionSummary | null;
  controls: RecoveryControls;
  busy: boolean;
  profileName: (profileId: string | null) => string | null;
  renderHandoff: (h: Handoff) => ReactNode;
  liveProgress?: ReactNode;
  onOpenTask: (t: Task) => void;
  onRestart: () => void;
  onAdvance: (fromTaskId: string | null, nextStepIds: string[] | null, handoff?: Partial<Handoff>) => void;
}) {
  const [showGoal, setShowGoal] = useState(false);
  // Which Advance form is open. None is by default: advancing is never a default.
  const [advancing, setAdvancing] = useState<string | null>(null);
  const held = !!run && (run.status === "blocked" || run.status === "cancelled" || run.blocked.length > 0 || state.state === "waiting" || state.state === "needs" || state.state === "failed");
  const schedule = retrySchedule(task, now);
  // The inspector's sentence, in this page's word for the step-cap button.
  const note = state.kind === "step-cap" ? `Extend cap continues ${state.step?.name ?? "the step"} with another step allowance. It does not restart the pipeline.` : recoveryNote(task, state);
  const stepName = (id: string | null) => (id ? (graph?.steps.find((s) => s.id === id)?.name ?? id) : null);
  const profileId = graph?.steps.find((s) => s.id === state.step?.id)?.agentProfileId ?? null;
  const live = hasLiveExecution(steps, run);
  const executing = run ? run.active.filter((a) => steps.find((t) => t.id === a.taskId)?.column === "running").length : 0;
  const candidates = (graph?.steps ?? []).map((s) => ({ value: s.id, label: s.name }));
  const awaiting = controls.advance.filter((a) => a.key.startsWith("review:"));
  const target = (a: AdvanceTarget) => (
    <div key={a.key} data-testid="pipeline-run-advance-target">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="pipeline-run-advance-open"
        aria-expanded={advancing === a.key}
        title={`${a.stepName} ${a.why}. Advancing overrides the pipeline's routing: you pick what runs next.`}
        className="h-7 px-2.5 text-[11px]"
        onClick={() => setAdvancing((cur) => (cur === a.key ? null : a.key))}
      >
        Advance {a.stepName}…
      </Button>
      {advancing === a.key && (
        <AdvanceForm
          candidates={candidates}
          busy={busy}
          onSubmit={(next, handoff) => {
            setAdvancing(null);
            onAdvance(a.fromTaskId, next, handoff);
          }}
        />
      )}
    </div>
  );

  return (
    <aside data-testid="pipeline-run-hold" aria-labelledby="run-hold-title" className={cn(PANEL, "min-w-0 px-4 py-3.5")}>
      <h3 id="run-hold-title" className="text-sm font-semibold leading-[1.4] text-foreground">
        {held ? "Current hold" : "Run details"}
      </h3>
      <div className="mt-2.5">
        <StateBadge tone={state.state} icon={state.icon} label={state.label} testId="pipeline-run-hold-state" />
      </div>
      <dl className="mt-1.5">
        <InfoRow name="Recovery">{recoveryWord(run, state)}</InfoRow>
        {schedule.map(([k, v], i) => (
          <InfoRow key={i} name={k}>
            {/* Only the wait queue keeps a maximum; nothing else claims one. */}
            {k === "Attempt" ? `${v} · no maximum recorded` : v}
          </InfoRow>
        ))}
        {state.elapsedMs != null && <InfoRow name={state.state === "working" || state.kind === "quiet" ? "Running for" : "Waiting for"}>{formatElapsed(state.elapsedMs)}</InfoRow>}
        {run && run.status !== "done" && !(run.status === "idle" && run.history.length === 0) && (
          <InfoRow name="Agents executing" testId="pipeline-run-executing">
            {executing > 0 ? String(executing) : live ? "none: a step waits on your answer" : "none"}
          </InfoRow>
        )}
        {state.step?.id && <InfoRow name={`${state.step.name} profile`}>{profileName(profileId) ?? "none set"}</InfoRow>}
        <InfoRow name="Pull request" testId="pipeline-run-hold-pr">
          {pr ? `#${pr.number} · ${pr.state}${pr.draft ? " · draft" : ""} · checks ${pr.checks === "none" ? "none reported" : pr.checks === "success" ? "passing" : pr.checks === "pending" ? "running" : "failing"} as of ${clockTime(pr.checkedAt)}` : "none known"}
        </InfoRow>
        {summary && run && (
          <>
            <InfoRow name="Step cap" testId="pipeline-run-step-cap">
              {summary.cap.used} of {summary.cap.max} executions started
            </InfoRow>
            {run.startedAt != null && <InfoRow name="Run started">{`${clockTime(run.startedAt)} · ${formatAge(now - run.startedAt)} ago`}</InfoRow>}
          </>
        )}
      </dl>

      {run && run.blocked.length > 0 && (
        <div data-testid="pipeline-run-blocked" className="mt-3 flex flex-col gap-2">
          {run.blocked.map((entry, index) => {
            const name = stepName(entry.stepId);
            const stepTask = entry.taskId ? (steps.find((t) => t.id === entry.taskId) ?? null) : null;
            // A step that handed off as blocked explains itself in its
            // handoff — show that formatted instead of the one-line message
            // the runner flattened it into.
            const handoff = entry.kind === "step-blocked" && entry.taskId ? ([...run.history].filter((r) => r.taskId === entry.taskId).sort((a, b) => b.seq - a.seq)[0]?.handoff ?? null) : null;
            const selfClearing = entry.kind === "slot-wait" || entry.kind === "await";
            return (
              // Index-prefixed: two run-level blocks of the same kind share every other field.
              <div key={`${index}:${entry.kind}:${entry.stepId ?? entry.taskId ?? "run"}`} data-state={entry.kind === "slot-wait" ? "queued" : entry.kind === "await" ? "waiting" : state.state === "working" ? "needs" : state.state} className="rounded-md bg-state-bg p-2.5">
                <p className="text-[11px] font-semibold leading-[1.45] text-state [overflow-wrap:anywhere]">
                  {name ? `${name} — ` : ""}
                  {blockWords(entry.kind)}
                </p>
                {handoff ? <div className="mt-1.5">{renderHandoff(handoff)}</div> : <p className="mt-0.5 text-[11px] leading-[1.45] text-foreground [overflow-wrap:anywhere]">{entry.message}</p>}
                {stepTask && !selfClearing && (
                  <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-open-step" onClick={() => onOpenTask(stepTask)} className="mt-2 h-7 px-2.5 text-[11px]">
                    Open step
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {awaiting.length > 0 && (
        <div data-testid="pipeline-run-review" className="mt-3 flex flex-col gap-2">
          <p className={cn(SUB, "font-semibold")}>Awaiting review</p>
          {awaiting.map((a) => {
            const stepTask = a.fromTaskId ? (steps.find((t) => t.id === a.fromTaskId) ?? null) : null;
            return (
              <div key={a.key} data-state="needs" className="rounded-md bg-state-bg p-2.5">
                <p className="text-[11px] font-semibold leading-[1.45] text-state">{a.stepName} — finished, awaiting next step</p>
                {stepTask && (
                  <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-open-step" onClick={() => onOpenTask(stepTask)} className="mt-2 h-7 px-2.5 text-[11px]">
                    Open step
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {note && (
        <p data-testid="pipeline-run-recovery-note" className={cn(SUB, "mt-3")}>
          {note}
        </p>
      )}
      {liveProgress != null && <div className="mt-3 empty:hidden">{liveProgress}</div>}

      <div className="mt-3">
        <button
          type="button"
          data-testid="pipeline-run-goal-toggle"
          aria-expanded={showGoal}
          onClick={() => setShowGoal((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-md border border-board-line px-2.5 py-1.5 text-left text-[11px] font-medium text-[color:var(--state-queued)] hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          Goal
          <ChevronDown className={cn("size-3.5 shrink-0", showGoal && "rotate-180")} aria-hidden />
        </button>
        {showGoal && (
          <p data-testid="pipeline-run-goal" className="mt-1.5 whitespace-pre-wrap rounded-md bg-state-neutral p-2 text-xs text-foreground [overflow-wrap:anywhere]">
            {task.prompt}
          </p>
        )}
      </div>

      {(controls.restart || controls.advance.length > 0) && (
        <details data-testid="pipeline-run-advanced" className="mt-4 border-t border-board-line pt-3">
          <summary className="cursor-pointer rounded text-xs font-semibold text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Advanced run controls</summary>
          <p className={cn(SUB, "mt-2")}>
            These are not retries. Advancing overrides the pipeline's routing: you choose what runs next. Restarting starts a fresh run from the first step and clears this run's history. Each asks before it does anything.
          </p>
          <div className="mt-2.5 flex flex-col gap-2">
            {controls.advance.map(target)}
            {controls.restart && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="pipeline-run-restart"
                  disabled={busy}
                  title="Start the pipeline again from its first step — asks first"
                  onClick={onRestart}
                  className="h-7 gap-1 px-2.5 text-[11px]"
                >
                  <RotateCcw className="size-3" aria-hidden />
                  Restart pipeline…
                </Button>
              </div>
            )}
          </div>
        </details>
      )}
    </aside>
  );
}
