import { Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { pipelineStepProgress } from "../../../shared/pipeline.ts";
import type { PipelineRunState, PipelineRunStatus } from "../../../shared/types.ts";

const STATUS_CLASSES: Record<PipelineRunStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-info/15 text-info",
  blocked: "bg-warning/15 text-warning",
  done: "bg-success/15 text-success",
  cancelled: "bg-muted text-muted-foreground",
};

interface PipelineBadgeProps {
  run: PipelineRunState;
  className?: string;
}

/**
 * Board-card badge for a pipeline task: the pipeline name plus step
 * progress (`"<completed>/<total> · <active step name>"`), colored by the
 * run's overall status. See `pipelineStepProgress` (`src/shared/
 * pipeline.ts`) for the label format.
 */
/** "Bugfix: Reproduce, Fix, Verify, Finish" → "Bugfix" — the part before a
 *  colon names the pipeline; the rest lists its steps, which the progress
 *  label already covers. */
export function shortPipelineName(name: string): string {
  const head = name.split(":")[0]!.trim();
  return head || name;
}

export function PipelineBadge({ run, className }: PipelineBadgeProps) {
  const progress = pipelineStepProgress(run);
  return (
    <Badge
      variant="secondary"
      data-testid="task-card-pipeline"
      data-status={run.status}
      title={`${run.pipelineName} — ${progress.label}`}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border-transparent px-1.5 py-0.5 text-[11px] font-medium leading-tight",
        STATUS_CLASSES[run.status],
        className,
      )}
    >
      <Workflow className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{shortPipelineName(run.pipelineName)}</span>
      <span className="shrink-0 opacity-90">· {progress.label}</span>
    </Badge>
  );
}
