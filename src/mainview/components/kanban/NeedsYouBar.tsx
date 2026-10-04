import { useMemo, useState } from "react";
import { ChevronDown, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cardStatus, needsYouList, type NeedsYouAction } from "@/lib/card-status";
import { leaseInfoForTask } from "@/lib/leases";
import { cn } from "@/lib/utils";
import type { LeaseStatus, Task, TaskPrStatus } from "../../../shared/types.ts";

const COLLAPSED_COUNT = 4;

/**
 * "Needs you": the board cards whose next move is the user's — a question to
 * answer, a block to retry, a PR to fix or merge, a result to review — each
 * with its reason and the one button that settles it. Empty means nothing is
 * waiting on you. Built from the same `cardStatus` the cards' status lines use.
 */
export function NeedsYouBar({
  tasks,
  prs,
  leases,
  onOpen,
  onRetry,
  onOpenPr,
}: {
  tasks: Task[];
  prs: ReadonlyMap<string, TaskPrStatus>;
  leases: LeaseStatus[];
  onOpen: (t: Task) => void;
  onRetry: (t: Task) => void;
  onOpenPr: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => {
    const now = Date.now();
    return needsYouList(
      tasks.map((task) => ({
        task,
        status: cardStatus(task, { pr: prs.get(task.id) ?? null, lease: leaseInfoForTask(task, leases), now }),
      })),
    );
  }, [tasks, prs, leases]);

  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, COLLAPSED_COUNT);

  const act = (task: Task, action: NeedsYouAction) => {
    if (action === "retry") onRetry(task);
    else if (action === "open-pr") {
      const url = prs.get(task.id)?.url;
      if (url) onOpenPr(url);
    } else onOpen(task);
  };

  return (
    <div data-testid="needs-you-bar" className="mx-4 mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-warning">
        <CircleAlert className="size-3.5" aria-hidden />
        Needs you · {items.length}
      </div>
      <ul className="flex flex-col gap-1">
        {shown.map(({ task, status }) => (
          <li key={task.id} data-testid="needs-you-item" className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => onOpen(task)}
              className="min-w-0 flex-1 truncate text-left hover:underline"
              title={`${task.title} — ${status.line}`}
            >
              <span className="font-medium">{task.title}</span>
              <span className="text-muted-foreground"> — {status.needsYou!.reason}</span>
            </button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="needs-you-action"
              onClick={() => act(task, status.needsYou!.action)}
              className={cn("h-6 shrink-0 px-2 text-[11px]")}
            >
              {status.needsYou!.actionLabel}
            </Button>
          </li>
        ))}
      </ul>
      {items.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all ${items.length}`}
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}
