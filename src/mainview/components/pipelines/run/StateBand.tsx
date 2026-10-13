import { ArrowRight, RotateCcw, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardState } from "@/lib/card-state";
import type { BandAction, RecoveryControls } from "@/lib/run-view";
import { STATE_ICONS } from "@/components/kanban/StateBadge";

const BUTTON = "inline-flex min-h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-semibold leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-state disabled:opacity-55";

/**
 * What is happening to the run now, in the board card's own words: the
 * same icon, label and colour the card's band shows for this task
 * (`cardState`), the step, the reason, and when it is tried again. The
 * run's recovery actions are here and nowhere else on the page.
 */
export function StateBand({
  state,
  facts,
  controls,
  busy,
  error,
  onAction,
}: {
  state: CardState;
  /** "Next retry 1:05 PM", "attempt 2 of 3", "no agent executing". */
  facts: string[];
  controls: RecoveryControls;
  busy: boolean;
  error: string | null;
  onAction: (action: BandAction) => void;
}) {
  const Icon = STATE_ICONS[state.icon];
  const actions = [controls.primary, ...controls.secondary].filter((a): a is BandAction => a != null);
  const step = state.step ? `${state.step.name}${state.step.round ? ` · round ${state.step.round}` : ""}` : null;
  return (
    <section
      data-testid="pipeline-run-state"
      data-state={state.state}
      data-state-kind={state.kind}
      aria-label={`State: ${state.label}${step ? `, step ${step}` : ""}`}
      className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-lg bg-state-bg px-4 py-3.5 text-state"
    >
      <div className="min-w-0 flex-1 basis-72">
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm font-[650] leading-[1.4]">
          <Icon className="size-[15px] shrink-0" aria-hidden />
          <span data-testid="pipeline-run-state-label">{state.label}</span>
          {step && (
            <span data-testid="pipeline-run-state-step" className="font-semibold">
              · {step}
            </span>
          )}
        </p>
        <p data-testid="pipeline-run-state-reason" className="mt-0.5 text-[11px] leading-[1.45] [overflow-wrap:anywhere]">
          {state.reason}
        </p>
        {(facts.length > 0 || controls.hint) && (
          <p data-testid="pipeline-run-state-facts" className="mt-0.5 text-[11px] leading-[1.45] [overflow-wrap:anywhere]">
            {[...facts, controls.hint].filter(Boolean).join(" · ")}
          </p>
        )}
        {error && (
          <p role="alert" data-testid="pipeline-run-action-error" className="mt-1 text-[11px] font-semibold leading-[1.45] [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
      </div>
      {actions.length > 0 && (
        <div data-testid="pipeline-run-actions" role="group" aria-label="Run actions" className="flex flex-wrap items-center gap-[7px]">
          {actions.map((a, i) => {
            const primary = i === 0 && a === controls.primary;
            return (
              <button
                key={`${a.kind}:${a.label}`}
                type="button"
                data-testid={a.kind === "retry" ? "pipeline-run-retry" : a.kind === "stop" ? "pipeline-run-stop" : "pipeline-run-action"}
                data-action={a.kind === "retry" ? a.id : a.kind === "card" ? a.action.kind : a.kind}
                title={a.title}
                // Only the requests that change the run wait on each other.
                disabled={busy && (a.kind === "retry" || a.kind === "stop")}
                onClick={() => onAction(a)}
                className={cn(BUTTON, primary ? "bg-state text-[color:var(--state-bg)] hover:brightness-110" : "border border-state bg-transparent text-state hover:bg-[color:var(--board-card)]")}
              >
                {a.kind === "retry" && <RotateCcw className="size-3 shrink-0" aria-hidden />}
                {a.kind === "stop" && <Square className="size-3 shrink-0" aria-hidden />}
                {a.label}
                {(a.kind === "card" || a.kind === "open-step") && <ArrowRight className="size-3 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
