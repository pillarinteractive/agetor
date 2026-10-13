import { memo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ColumnId, Task } from "../../../shared/types.ts";
import type { CardAction } from "@/lib/card-state";
import { useColumnSummary } from "@/lib/use-card-state";
import { TaskCard } from "./TaskCard";

interface Props {
  id: ColumnId;
  label: string;
  tasks: Task[];
  homeDir: string;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  /** Click, double click and the card's own button — see `TaskCard`. */
  onSelect: (t: Task) => void;
  onOpen: (t: Task) => void;
  onAction: (t: Task, action: CardAction) => void;
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
  /** Id of the card the inspector shows (App.tsx's `inspectedId`), threaded
   *  down as each card's `selected`. */
  inspectedTaskId?: string | null;
  /** Right-click on a card within this column — forwarded verbatim to every
   *  `TaskCard`. See `TaskCard`'s doc comment for the payload shape. */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
  /** A folding column (Done) starts unfolded, and says when it folds or
   *  unfolds: the board is unmounted while a full-page view is open, and
   *  App.tsx puts it back as it was (`boardMemoryRef`). Read on mount only. */
  initialExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
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

function ColumnImpl({ id, label, tasks, homeDir, onCancel, onDelete, onSelect, onOpen, onAction, onDiff, onMarkDone, onArchive, onUnarchive, emptyHint, selectedTaskId, inspectedTaskId, onContextMenu, onMergeTogether, onRefresh, initialExpanded, onExpandedChange }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id });
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const limit = COLLAPSE_AFTER[id];
  const sorted = limit ? [...tasks].sort((a, b) => b.updatedAt - a.updatedAt) : tasks;
  const shown = limit && !expanded ? sorted.slice(0, limit) : sorted;
  const hidden = sorted.length - shown.length;
  // What the column's cards are doing, counted by state ("2 working · 1 needs you").
  const summary = useColumnSummary(tasks);
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      data-column-id={id}
      className={cn(
        // Columns share the board's width down to a narrow minimum; below
        // that the board scrolls sideways rather than wrapping.
        "flex min-w-[11.5rem] max-w-[26rem] flex-1 flex-col rounded-[9px] bg-lane px-1.5 pb-2.5 pt-2 outline-2 -outline-offset-2 outline-primary/60",
        isOver && "[outline-style:solid]",
      )}
    >
      <div className="flex items-center justify-between gap-1 px-[3px] pb-1 pt-[5px]">
        <h2 className="min-w-0 truncate text-xs font-[650] leading-[1.3] text-foreground">{label}</h2>
        <span data-testid="column-count" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
      </div>
      {/* The summary line; Ready to Merge's two buttons sit at its end, so
       *  every column's cards start at the same height. */}
      <div className="flex min-h-[27px] items-start gap-1 px-[3px] pb-2">
        <p data-testid="column-summary" className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={summary}>
          {summary}
        </p>
        {onRefresh && (
          <button
            type="button"
            data-testid="column-refresh"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void onRefresh().finally(() => setRefreshing(false));
            }}
            title={refreshing ? "Refreshing…" : "Check these PRs on GitHub now and take the next merge steps"}
            aria-label="Refresh Ready to Merge"
            aria-busy={refreshing}
            className="-mt-0.5 shrink-0 rounded-md border border-board-line p-[3px] text-muted-foreground hover:bg-board-card hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className="size-3" aria-hidden />
          </button>
        )}
        {onMergeTogether && tasks.length >= 2 && (
          <button
            type="button"
            data-testid="merge-together"
            onClick={onMergeTogether}
            title="Merge these PRs as one train now: one squashed commit per PR, CI runs once, then rebase-merged"
            className="-mt-0.5 shrink-0 rounded-md border border-board-line px-1.5 py-px text-[11px] font-medium leading-[1.3] text-muted-foreground hover:bg-board-card hover:text-foreground"
          >
            Merge together
          </button>
        )}
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
            onCancel={onCancel}
            onDelete={onDelete}
            onSelect={onSelect}
            onOpen={onOpen}
            onAction={onAction}
            onDiff={onDiff}
            onMarkDone={onMarkDone}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            isOpen={t.id === selectedTaskId}
            selected={t.id === inspectedTaskId}
            onContextMenu={onContextMenu}
          />
        ))}
        {limit && sorted.length > limit && (
          <button
            type="button"
            data-testid="column-fold"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded(!expanded);
              onExpandedChange?.(!expanded);
            }}
            className="rounded-md border border-dashed border-board-line px-2 py-1.5 text-xs text-muted-foreground hover:bg-board-card hover:text-foreground"
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        )}
      </div>
    </section>
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
 *  `selectedTaskId` and `inspectedTaskId` are compared explicitly
 *  (primitives, cheap). App passes the same values to every column, so
 *  opening/switching/closing the run panel, or selecting a card, re-renders
 *  every column — the inner `TaskCard` memo then keeps the actual DOM work
 *  to the card(s) whose `isOpen` or `selected` flips.
 *
 *  The summary line reads the board's contexts (PRs, leases, progress), and
 *  a context change re-renders its consumers whatever this comparator says,
 *  so the counts stay current without widening it. */
export const Column = memo(ColumnImpl, (prev, next) => (
  prev.id === next.id &&
  prev.label === next.label &&
  prev.homeDir === next.homeDir &&
  prev.onCancel === next.onCancel &&
  prev.onDelete === next.onDelete &&
  prev.onSelect === next.onSelect &&
  prev.onOpen === next.onOpen &&
  prev.onAction === next.onAction &&
  prev.onDiff === next.onDiff &&
  prev.onMarkDone === next.onMarkDone &&
  prev.onArchive === next.onArchive &&
  prev.onUnarchive === next.onUnarchive &&
  prev.emptyHint === next.emptyHint &&
  prev.selectedTaskId === next.selectedTaskId &&
  prev.inspectedTaskId === next.inspectedTaskId &&
  prev.onContextMenu === next.onContextMenu &&
  prev.onMergeTogether === next.onMergeTogether &&
  prev.onRefresh === next.onRefresh &&
  prev.onExpandedChange === next.onExpandedChange &&
  sameTasks(prev.tasks, next.tasks)
));
