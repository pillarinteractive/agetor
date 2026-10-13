import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, ArrowRight, Bot, CheckCircle2, GitCompare, ListTodo, Link2, Lock, LockOpen, Zap, PauseCircle, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { abbreviateHome, cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { useCountdown, fxPausedBadgeText, fxPausedBadgeTitle } from "@/lib/fx-auto-resume";
import { taskTypeMeta, type Task } from "../../../shared/types.ts";
import { isTaskFxPaused } from "../../../shared/fx-recovery.ts";
import { shortPipelineName } from "@/components/pipelines/PipelineBadge";
import { useTaskLeaseInfo } from "@/lib/leases";
import { useTaskPr } from "@/lib/prs";
import { formatElapsed, type CardAction } from "@/lib/card-state";
import { useCardState } from "@/lib/use-card-state";
import { columnLabel } from "@/lib/column-labels";
import { ordinal } from "../../../shared/block-reason.ts";
import { progressFraction, progressLine, useTaskProgress } from "@/lib/progress";
import { blockerColor, prNumberFromUrl, shortCardName, splitCardTitle } from "@/lib/card-names";
import { STATE_ICONS } from "./StateBadge";

// The theme's --destructive is a dark fill meant for buttons (30% lightness
// in dark mode) — unreadable as text on a dark card. Text uses a lighter red.
const DANGER_TEXT = "text-red-600 dark:text-red-400";


interface Props {
  task: Task;
  homeDir: string;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  /** A single click, or Enter/Space on the focused card: select it, which
   *  opens the inspector under the board (App.tsx `inspectedId`). */
  onSelect: (t: Task) => void;
  /** A double click: the full view (run panel, or a pipeline's run view). */
  onOpen: (t: Task) => void;
  /** The card's one button (src/mainview/lib/card-state.ts `CardAction`). */
  onAction: (t: Task, action: CardAction) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
  /** True when this task is the one currently open in the run panel — App.tsx
   *  passes `task.id === selected?.id`. Suppresses the unread dot while the
   *  user is actively watching the task (messages streamed while open are
   *  marked seen on close, not shown as unread in the meantime). */
  isOpen?: boolean;
  /** True when this card is the one the inspector shows. */
  selected?: boolean;
  /** Right-click (or keyboard menu-key) on the card. `pos` is where App.tsx's
   *  task context menu should anchor — omitted entirely when the caller
   *  doesn't wire it up (no menu to open). */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
}

function TaskCardImpl({ task, homeDir, onCancel, onDelete, onSelect, onOpen, onAction, onDiff, onMarkDone, onArchive, onUnarchive, isOpen, selected, onContextMenu }: Props) {
  const archived = task.archivedAt != null;
  // `fx-paused-badge`'s live countdown (see the badge below) — called
  // unconditionally, before any conditional return, so hook order stays
  // stable whether or not this task is actually paused right now; ticks
  // only while `task.fxRecovery.autoResume.at` is actually set (see
  // `useCountdown`'s own doc comment). `task.fxRecovery` is server-managed
  // — this card never inspects `task.agent` to decide whether to show it.
  const fxAutoResumeAt = task.fxRecovery?.autoResume?.at ?? null;
  const fxAutoResumeCountdown = useCountdown(fxAutoResumeAt);
  const lease = useTaskLeaseInfo(task);
  const pr = useTaskPr(task.id);
  // Live lab/E2E run progress in this card's checkout (src/bun/progress-watch.ts).
  const progress = useTaskProgress(task.id);
  // The card's state, step and button: read from the run, the PR and the
  // leases (src/mainview/lib/card-state.ts), not from the column it is in.
  const state = useCardState(task);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first.
    disabled: archived,
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const active = task.column === "running" || task.column === "blocked";
  // Stop is only honoured server-side for a pipeline PARENT while its run
  // is genuinely `running` (`POST /tasks/:id/pipeline/cancel` 409s
  // otherwise — e.g. a `blocked` run with nothing live), so the card's Stop
  // gates on `pipelineRun.status`, not the column (L-A1). Mirrored in
  // `buildTaskContextMenu`. Every other task keeps the column-based rule.
  const stoppable = task.pipelineId ? task.pipelineRun?.status === "running" : active;

  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);
  const StateIcon = STATE_ICONS[state.icon];
  const runningSubagents = task.runningSubagents ?? 0;
  const title = splitCardTitle(task.title);
  const prNumber = pr?.number ?? prNumberFromUrl(task.prUrl);
  const waitingTags = (task.blockedBy ?? []).filter((d) => !d.satisfied);
  const action = state.action;
  // Who is (or was last) on it: the current step's agent for a pipeline, with
  // the pipeline's name beside it; the task's own agent otherwise.
  const run = task.pipelineRun;
  const stepProfileId = run?.snapshot?.graph.steps.find((s) => s.id === state.step?.id)?.agentProfileId;
  const stepAgent = stepProfileId ? run?.snapshot?.profiles[stepProfileId]?.name : undefined;
  const owner = run ? (stepAgent ?? shortPipelineName(run.pipelineName)) : (task.agentProfile?.name ?? task.agent);
  const stepText = state.step ? `${state.step.name}${state.step.round ? `, round ${state.step.round}` : ""}` : task.pipelineId ? "not started" : "none";
  const showFxPaused = isTaskFxPaused(task) && !!task.fxRecovery;
  const hasChips =
    !archived &&
    (task.priority || waitingTags.length > 0 || (task.blocking?.length ?? 0) > 0 || lease.holds.length > 0 || lease.waiting.length > 0 || runningSubagents > 0 || showFxPaused ||
      (!!task.todoProgress && task.todoProgress.total > 0 && task.column === "running"));

  return (
    <div
      ref={setNodeRef}
      style={style}
      // Lets the board's blocker lines (BlockerLines.tsx) find this card.
      data-task-id={task.id}
      data-testid="task-card"
      // Names the state once; the band, the strip and the button below read
      // its colours from here (index.css `[data-state]`).
      data-state={state.state}
      data-state-kind={state.kind}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group relative cursor-grab select-none rounded-lg border border-board-line bg-board-card text-card-foreground",
        // `[outline-style:solid]`, not `outline`: tailwind-merge (in `cn`)
        // reads `outline` and `outline-2` as the same property and keeps one.
        "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ring focus-visible:[outline-style:solid]",
        // The two states that wait on a person carry their colour on the frame too.
        (state.state === "needs" || state.state === "failed") && "border-state",
        selected && "outline-2 outline-offset-1 outline-state-waiting [outline-style:solid]",
        isDragging && "opacity-50",
        archived && "cursor-default opacity-60",
      )}
      // A right-click never selects or opens, only `onContextMenu` fires for it.
      onClick={() => onSelect(task)}
      onDoubleClick={() => onOpen(task)}
      // Enter or Space on the card itself selects it, like a click. Keys
      // pressed on a button inside the card are that button's.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onSelect(task);
      }}
      // dnd-kit's `useDraggable` above is unaffected by right-click: its
      // `PointerSensor` bails on `event.button !== 0`, so a right-click can
      // never arm a drag — `{...listeners}` and this handler don't fight.
      onContextMenu={(e) => {
        e.preventDefault();
        if (!onContextMenu) return;
        // Keyboard-invoked context menus (Shift+F10 / the menu key) report
        // clientX/Y = 0,0 — anchor those to the card instead of the
        // viewport corner.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        const r = e.currentTarget.getBoundingClientRect();
        onContextMenu(task, fromKeyboard ? { x: r.left, y: r.top } : { x: e.clientX, y: e.clientY });
      }}
      // The card is focusable (dnd-kit's `attributes` below add
      // `tabIndex=0`), so a right-click would otherwise focus it and WebKit
      // scrolls a partially-visible card into view inside `.kanban-scroll`;
      // the board would visibly jump (and focus would land on the card)
      // under the freshly-opened menu. Only suppress the default for the
      // right button — left-click focus/drag
      // behavior (dnd-kit's `PointerSensor`, wired via `{...listeners}`
      // below as `onPointerDown`, so there's no prop collision here) is
      // untouched, and `contextmenu` still fires after a default-prevented
      // `mousedown`.
      onMouseDown={(e) => {
        if (e.button === 2) e.preventDefault();
      }}
      {...listeners}
      {...attributes}
      aria-label={`${task.title}. Status: ${columnLabel(task.column)}. Step: ${stepText}. State: ${state.label}. ${state.reason}`}
      aria-pressed={!!selected}
    >
      {task.unread && !isOpen && (
        // Static dot for "has assistant messages you haven't read yet".
        // Pinned to the corner, outside the frame, so it reads on any state
        // band and never sits under the selection outline's 1px offset.
        <span
          className="absolute -right-1.5 -top-1.5 z-10 size-2.5 rounded-full bg-info ring-2 ring-background"
          title="New messages"
          role="img"
          aria-label="New messages"
        />
      )}
      {/* State: what is happening right now. Label and icon carry it; the
       *  colour repeats it. */}
      <div data-testid="card-state" className="flex items-center gap-1.5 rounded-t-[7px] bg-state-bg p-[9px] text-xs font-[650] leading-[1.3] text-state">
        <StateIcon className="size-[15px] shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{state.label}</span>
      </div>
      <div className="px-[9px] pb-2 pt-[9px]">
        <div className="mb-2 flex items-center justify-between gap-1.5 text-[11px] tabular-nums text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1">
            <TypeIcon className={cn("size-3 shrink-0", type.iconClass)} aria-label={type.label} />
            {title.issue && <span>#{title.issue}</span>}
          </span>
          {prNumber != null && (
            <span className="shrink-0" data-testid="card-pr-number" title={`Pull request #${prNumber}`}>
              PR {prNumber}
            </span>
          )}
        </div>
        <h3
          className="mb-1.5 line-clamp-2 min-h-[34px] text-xs font-semibold leading-[1.4] [overflow-wrap:anywhere]"
          title={[task.title, task.branch && `branch ${task.branch}`, task.model && `model ${task.model}`, abbreviateHome(task.workdir, homeDir)].filter(Boolean).join("\n")}
        >
          {title.text}
        </h3>
        {/* Step: where the pipeline is. A task without a pipeline has none. */}
        <div data-testid="card-step" className="flex items-center gap-[5px] text-[11px] text-muted-foreground">
          {state.step ? (
            <>
              <span>Step</span>
              <strong className="min-w-0 truncate font-semibold text-foreground">{state.step.name}</strong>
              {state.step.round != null && <span className="shrink-0">· round {state.step.round}</span>}
            </>
          ) : (
            <span>{task.pipelineId ? "Step not started" : "No pipeline"}</span>
          )}
          {state.elapsedMs != null && (
            <span className="ml-auto shrink-0 tabular-nums" title={state.state === "working" || state.kind === "quiet" ? "Running for" : "Waiting for"}>
              {formatElapsed(state.elapsedMs)}
            </span>
          )}
        </div>
        {state.strip && (
          <div
            data-testid="card-strip"
            role="img"
            aria-label={`Pipeline steps: ${state.strip.map((s) => `${s.name} ${s.status === "todo" ? "to do" : s.status}`).join(", ")}`}
            className="my-2 grid grid-flow-col auto-cols-fr gap-1"
          >
            {state.strip.map((s) => (
              <span
                key={s.id}
                data-status={s.status}
                title={`${s.name}${s.status === "current" ? " · current step" : s.status === "done" ? " · done" : ""}`}
                className={cn("h-1 rounded-[1px]", s.status === "done" ? "bg-state-working" : s.status === "current" ? "bg-state" : "bg-state-neutral")}
              />
            ))}
          </div>
        )}
        <p
          data-testid="card-status"
          title={state.reason}
          className={cn("line-clamp-2 min-h-[31px] text-[11px] leading-[1.4] text-muted-foreground [overflow-wrap:anywhere]", !state.strip && "mt-2")}
        >
          {state.reason}
        </p>
        {/* Facts that are true whatever the state: priority, what it blocks
         *  or waits on, leases, background agents. A card that blocks others
         *  wears its own color ("blocks 3"); each card waiting on it wears
         *  that same color with its short name ("#214"). */}
        {hasChips && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            {task.priority && (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 font-semibold text-warning ring-1 ring-warning/40"
                data-testid="priority-tag"
                title="Priority: takes a slot straight away and goes first for the lab"
              >
                <Zap className="size-3" />
                Priority
              </span>
            )}
            {(task.blocking?.length ?? 0) > 0 && (
              <span
                className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold ring-1", blockerColor(task.id))}
                data-testid="blocks-tag"
                title={`Blocks: ${task.blocking!.map((b) => b.title).join(", ")}`}
              >
                <Link2 className="size-3" />
                {shortCardName(task.title, { issueUrl: task.issueUrl, prNumber: pr?.number ?? null })} · blocks {task.blocking!.length}
              </span>
            )}
            {waitingTags.map((d) => (
              <span
                key={d.taskId}
                className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold ring-1", blockerColor(d.taskId))}
                data-testid="blocked-by-chip"
                title={`Waiting on "${d.title}" — ${d.detail}`}
              >
                <Link2 className="size-3" />
                waits on {d.ref ?? shortCardName(d.title)}
              </span>
            ))}
            {lease.holds.map((label) => (
              <span key={label} className="flex items-center gap-0.5 text-info" data-testid="lease-badge" title={`Holds the ${label} lease`}>
                <Lock className="size-3" />
                {label}
              </span>
            ))}
            {lease.waiting.map((w) => (
              <span
                key={w.label}
                className={cn("flex items-center gap-0.5", w.free ? "text-success" : "text-warning")}
                data-testid="lease-wait-hint"
                title={w.free ? `${w.label} is free` : `${w.label} held by ${w.heldBy}`}
              >
                {w.free ? <LockOpen className="size-3" /> : <Lock className="size-3" />}
                {ordinal(w.position)} in line
              </span>
            ))}
            {runningSubagents > 0 && (
              <span className="flex items-center gap-0.5" title={`${runningSubagents} background task${runningSubagents > 1 ? "s" : ""} running`}>
                <Bot className="size-3" />
                {runningSubagents}
              </span>
            )}
            {task.todoProgress && task.todoProgress.total > 0 && task.column === "running" && (
              <span className="flex items-center gap-0.5" title={`${task.todoProgress.completed} of ${task.todoProgress.total} tasks done`}>
                <ListTodo className="size-3" />
                {task.todoProgress.completed}/{task.todoProgress.total}
              </span>
            )}
            {showFxPaused && (
              <span className="flex items-center gap-0.5 text-warning" data-testid="fx-paused-badge" title={fxPausedBadgeTitle(task.fxRecovery!)}>
                <PauseCircle className="size-3" />
                {fxPausedBadgeText(task.fxRecovery!, fxAutoResumeCountdown)}
              </span>
            )}
          </div>
        )}
        {!archived &&
          progress.map((p) => {
            const line = progressLine(p);
            const fraction = p.active ? progressFraction(p.counts) : null;
            return (
              <div key={`${p.project}:${p.label}`} data-testid="card-progress" className="mt-1.5 flex flex-col gap-1">
                <p
                  title={p.current ?? line.text}
                  className={cn(
                    "truncate text-[11px] leading-snug",
                    line.tone === "danger" && DANGER_TEXT,
                    line.tone === "success" && "text-success",
                    line.tone === "info" && "text-info",
                    line.tone === "muted" && "text-muted-foreground",
                  )}
                >
                  {p.active ? "▶ " : ""}
                  {line.text}
                </p>
                {fraction != null && (
                  <div className="h-1 overflow-hidden rounded bg-muted">
                    <div
                      className={cn("h-full", line.tone === "danger" ? "bg-destructive" : "bg-info")}
                      style={{ width: `${Math.round(fraction * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
      </div>
      {/* The footer is the user's next move when there is one, and otherwise
       *  who is on the card. Everything else is on hover (the strip at the
       *  top right), in the right-click menu, or in the inspector. */}
      {action ? (
        <button
          type="button"
          data-testid="card-action"
          data-action={action.kind}
          aria-label={`${action.label}: ${title.issue ? `#${title.issue}` : title.text}`}
          className="flex min-h-8 w-full items-center justify-between gap-1 rounded-b-[7px] bg-state-bg px-[9px] py-2 text-left text-[11px] font-semibold text-state hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-state dark:hover:brightness-110"
          onClick={(e) => {
            e.stopPropagation();
            onAction(task, action);
          }}
          // A double click on the button is two presses of the button, not
          // a request to open the card.
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="min-w-0 truncate">{action.label}</span>
          <ArrowRight className="size-[13px] shrink-0" aria-hidden />
        </button>
      ) : (
        <div className="flex justify-between gap-1.5 border-t border-board-line px-[9px] py-[7px] text-[11px] text-muted-foreground">
          <span className="truncate" title={run ? run.pipelineName : owner} data-testid="task-card-pipeline">
            {owner}
          </span>
          {run && stepAgent && <span className="max-w-[45%] shrink-0 truncate">{shortPipelineName(run.pipelineName)}</span>}
        </div>
      )}
      {/* Secondary actions, on hover/focus only. After the footer in the
       *  document, so Tab goes from the card to its button first. */}
      <div
        className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md border border-board-line bg-board-card p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {!archived && stoppable && (
          <Button size="icon" variant="ghost" className="size-6" onClick={() => onCancel(task)} title="Stop">
            <Square className="size-3" />
          </Button>
        )}
        {!archived && (task.column === "review" || task.column === "merge") && (
          <Button size="icon" variant="ghost" className="size-6" onClick={() => onMarkDone(task)} title="Mark done">
            <CheckCircle2 className="size-3" />
          </Button>
        )}
        {!archived && (task.column === "done" || active) && (
          <Button size="icon" variant="ghost" className="size-6" onClick={() => onArchive(task)} title={active ? "Stop the running agent and archive" : "Archive"}>
            <Archive className="size-3" />
          </Button>
        )}
        {archived && (
          <Button size="icon" variant="ghost" className="size-6" onClick={() => onUnarchive(task)} title="Unarchive">
            <ArchiveRestore className="size-3" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="size-6" onClick={() => onDiff(task)} title="View changes (git diff)">
          <GitCompare className="size-3" />
        </Button>
        <Button size="icon" variant="ghost" className="size-6" onClick={() => onDelete(task)} title="Delete">
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, and every other prop is either a primitive (`homeDir`,
// `isOpen`, `selected`) or a
// `useCallback`-stabilized handler. dnd-kit's `useDraggable` lives inside
// the component body, so memoizing the outer function doesn't interfere
// with drag state — that's driven by dnd-kit's own context, not props.
export const TaskCard = memo(TaskCardImpl);
