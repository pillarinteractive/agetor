import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineRunStatus, Task } from "../../../../shared/types.ts";
import { splitCardTitle } from "@/lib/card-names";
import type { ExecutionSummary } from "@/lib/run-view";
import { SUB } from "./parts";

export const RUN_STATUS_LABEL: Record<PipelineRunStatus, string> = {
  idle: "Not started",
  running: "Running",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * The run's heading: the way back, the card's own title (what the user
 * knows the work by), the pipeline, the pull request and how many
 * executions were recorded, and the run's status as a plain chip. The
 * coloured state is the band below, not this chip.
 */
export function RunHeader({
  task,
  status,
  pipelineName,
  prNumber,
  summary,
  onBack,
  onTaskDetails,
}: {
  task: Task;
  status: PipelineRunStatus;
  pipelineName: string;
  prNumber: number | null;
  /** Null before the first run. */
  summary: ExecutionSummary | null;
  onBack: () => void;
  onTaskDetails: () => void;
}) {
  const title = splitCardTitle(task.title);
  const loops = summary?.loops.length ?? 0;
  const facts = [
    pipelineName,
    prNumber != null ? `PR #${prNumber}` : null,
    summary ? summary.label : "no execution recorded",
    loops > 0 ? `looped back ${loops === 1 ? "once" : `${loops} times`}` : null,
    summary?.parallel ? "several executions at once" : null,
  ].filter(Boolean);
  return (
    <header className="mb-4">
      <button
        type="button"
        data-testid="pipeline-run-back"
        onClick={onBack}
        className="mb-2 inline-flex items-center gap-1 rounded text-[11px] text-[color:var(--state-queued)] hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to board
      </button>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-80">
          <h2 data-testid="pipeline-run-title" title={task.title} className="text-xl font-semibold leading-[1.3] tracking-tight text-foreground [overflow-wrap:anywhere]">
            {title.issue && <span className="tabular-nums">#{title.issue} · </span>}
            {title.text}
          </h2>
          <p data-testid="pipeline-run-facts" className={`${SUB} mt-1 [overflow-wrap:anywhere]`}>
            {facts.join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[7px]">
          <span className="inline-flex items-center gap-1 rounded bg-state-neutral px-[7px] py-[3px] text-[11px] font-medium text-[color:var(--state-queued)]">
            Status: <span data-testid="pipeline-run-status">{RUN_STATUS_LABEL[status]}</span>
          </span>
          <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-task-details" className="h-7 px-2.5 text-[11px]" onClick={onTaskDetails}>
            Task details
          </Button>
        </div>
      </div>
    </header>
  );
}
