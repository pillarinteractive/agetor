import { memo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { ColumnId, Task } from "../../../shared/types.ts";
import { TaskCard } from "./TaskCard";

interface Props {
  id: ColumnId;
  label: string;
  tasks: Task[];
  homeDir: string;
  onStart: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
  /** Muted one-line hint shown in place of the (empty) task list, while
   *  onboarding's checklist is visible. Only rendered when `tasks.length ===
   *  0` — never overlays real cards. Non-interactive (`pointer-events-none`)
   *  and stays inside the existing droppable container so dnd-kit's drop
   *  zone is unaffected. */
  emptyHint?: string;
  /** Ready to Merge only: send a merge train now (src/bun/merge-queue.ts). */
  onMergeTogether?: () => void;
  /** Re-check this column's PRs now (Ready to Merge). */
  onRefresh?: () => Promise<unknown>;
  /** Id of the task currently open in the run panel (App.tsx's `selected`),
   *  or null/undefined when no panel is open. Threaded down to each
   *  `TaskCard` as `isOpen` so the unread dot is suppressed for the task
   *  being actively watched. */
  selectedTaskId?: string | null;
  /** Right-click on a card within this column — forwarded verbatim to every
   *  `TaskCard`. See `TaskCard`'s doc comment for the payload shape. */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
}

/** Array is considered unchanged when same length and every element is the
 *  same object reference at the same index. Relies on the caller (App.tsx's
 *  `reconcileById`) preserving task identity across polls for tasks that
 *  didn't actually change — that's what lets an unaffected column bail out
 *  below even though `visibleTasks.filter(...)` in App.tsx produces a new
 *  array reference on every render. */
function sameTasks(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

/** Done keeps piling up; show the newest few and fold the rest. */
const COLLAPSE_AFTER: Partial<Record<ColumnId, number>> = { done: 5 };

function ColumnImpl({ id, label, tasks, homeDir, onStart, onCancel, onDelete, onOpen, onDiff, onMarkDone, onArchive, onUnarchive, emptyHint, selectedTaskId, onContextMenu, onMergeTogether, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id });
  const [expanded, setExpanded] = useState(false);
  const limit = COLLAPSE_AFTER[id];
  const sorted = limit ? [...tasks].sort((a, b) => b.updatedAt - a.updatedAt) : tasks;
  const shown = limit && !expanded ? sorted.slice(0, limit) : sorted;
  const hidden = sorted.length - shown.length;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        // Columns share the board's width (wider cards wrap titles less, so
        // they're shorter), within a readable range.
        "flex min-w-[17rem] max-w-[26rem] flex-1 flex-col gap-3 rounded-lg border border-border/40 bg-muted/30 p-2.5",
        isOver && "border-primary/60 bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        {onRefresh && (
          <button
            type="button"
            data-testid="column-refresh"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void onRefresh().finally(() => setRefreshing(false));
            }}
            title="Check these PRs on GitHub now and take the next merge steps"
            aria-label="Refresh Ready to Merge"
            className={cn(
              "rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60",
              !(onMergeTogether && tasks.length >= 2) && "ml-auto mr-2",
              onMergeTogether && tasks.length >= 2 && "ml-auto",
            )}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        )}
        {onMergeTogether && tasks.length >= 2 && (
          <button
            type="button"
            data-testid="merge-together"
            onClick={onMergeTogether}
            title="Merge these PRs as one train now: one squashed commit per PR, CI runs once, then rebase-merged"
            className={cn("mr-2 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground", onRefresh ? "ml-1.5" : "ml-auto")}
          >
            Merge together
          </button>
        )}
        <Badge variant="outline">{tasks.length}</Badge>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.length === 0 && emptyHint && (
          <p className="pointer-events-none px-1 text-xs text-muted-foreground">{emptyHint}</p>
        )}
        {shown.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            homeDir={homeDir}
            onStart={onStart}
            onCancel={onCancel}
            onDelete={onDelete}
            onOpen={onOpen}
            onDiff={onDiff}
            onMarkDone={onMarkDone}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            isOpen={t.id === selectedTaskId}
            onContextMenu={onContextMenu}
          />
        ))}
        {limit && sorted.length > limit && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-dashed border-border/60 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        )}
      </div>
    </div>
  );
}

/** Custom comparator instead of the default shallow-props compare: `tasks`
 *  is an array, so the default `Object.is` per-prop check would see a new
 *  reference on every render (App.tsx's `visibleTasks.filter(...)` always
 *  allocates a fresh array) and re-render every column on every tick. With
 *  `sameTasks` doing an element-wise identity check instead, a column whose
 *  member tasks are all reference-unchanged bails out — so a single task
 *  update (which only changes that one task's object identity, per
 *  App.tsx's `reconcileById`) only re-renders the column(s) that actually
 *  contain the changed task.
 *
 *  `selectedTaskId` is compared explicitly (primitive, cheap). App passes
 *  the same value to every column, so opening/switching/closing the run
 *  panel re-renders every column — the inner `TaskCard` memo then keeps the
 *  actual DOM work to the card(s) whose `isOpen` flips. */
export const Column = memo(ColumnImpl, (prev, next) => (
  prev.id === next.id &&
  prev.label === next.label &&
  prev.homeDir === next.homeDir &&
  prev.onStart === next.onStart &&
  prev.onCancel === next.onCancel &&
  prev.onDelete === next.onDelete &&
  prev.onOpen === next.onOpen &&
  prev.onDiff === next.onDiff &&
  prev.onMarkDone === next.onMarkDone &&
  prev.onArchive === next.onArchive &&
  prev.onUnarchive === next.onUnarchive &&
  prev.emptyHint === next.emptyHint &&
  prev.selectedTaskId === next.selectedTaskId &&
  prev.onContextMenu === next.onContextMenu &&
  prev.onMergeTogether === next.onMergeTogether &&
  sameTasks(prev.tasks, next.tasks)
));
