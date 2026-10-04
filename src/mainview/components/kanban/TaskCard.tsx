import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, ArrowRight, Bot, CheckCircle2, CircleAlert, FolderOpen, GitCompare, GitPullRequest, ListTodo, Link2, Lock, LockOpen, MessageCircleQuestion, PauseCircle, Play, Square, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { abbreviateHome, cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { useCountdown, fxPausedBadgeText, fxPausedBadgeTitle } from "@/lib/fx-auto-resume";
import { taskTypeMeta, type Task } from "../../../shared/types.ts";
import { isTaskFxPaused } from "../../../shared/fx-recovery.ts";
import { shortPipelineName } from "@/components/pipelines/PipelineBadge";
import { useTaskLeaseInfo } from "@/lib/leases";
import { prBadge, useTaskPr } from "@/lib/prs";
import { cardStatus } from "@/lib/card-status";
import { ordinal } from "../../../shared/block-reason.ts";
import { progressFraction, progressLine, useTaskProgress } from "@/lib/progress";
import { blockerColor, shortCardName, splitCardTitle } from "@/lib/card-names";

// The theme's --destructive is a dark fill meant for buttons (30% lightness
// in dark mode) — unreadable as text on a dark card. Text uses a lighter red.
const DANGER_TEXT = "text-red-600 dark:text-red-400";


interface Props {
  task: Task;
  homeDir: string;
  onStart: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
  /** True when this task is the one currently open in the run panel — App.tsx
   *  passes `task.id === selected?.id`. Suppresses the unread dot while the
   *  user is actively watching the task (messages streamed while open are
   *  marked seen on close, not shown as unread in the meantime). */
  isOpen?: boolean;
  /** Right-click (or keyboard menu-key) on the card. `pos` is where App.tsx's
   *  task context menu should anchor — omitted entirely when the caller
   *  doesn't wire it up (no menu to open). */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
}

function TaskCardImpl({ task, homeDir, onStart, onCancel, onDelete, onOpen, onDiff, onMarkDone, onArchive, onUnarchive, isOpen, onContextMenu }: Props) {
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
  const prInfo = pr ? prBadge(pr) : null;
  // Live lab/E2E run progress in this card's checkout (src/bun/progress-watch.ts).
  const progress = useTaskProgress(task.id);
  // One plain sentence: what the card is doing, or what it's waiting on.
  const status = cardStatus(task, { pr, lease, now: Date.now(), progressActive: progress.some((p) => p.active) });
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first.
    disabled: archived,
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  // Button precedence: Answer > Stop > Open > Run.
  //  - Answer when at least one interaction (AskUserQuestion / ExitPlanMode /
  //    tool-approval) is pending OR codex flipped the task to
  //    `blocked` via the approval-prompt heuristic. Opens the run panel; Stop
  //    moves to a trailing icon slot so the user can still cancel.
  //  - Stop while the agent process is live (running OR blocked-awaiting-user).
  //  - Open once any run has reached succeeded/running/orphaned — there's
  //    something worth re-reading; Run stays reachable from inside the panel.
  //  - Run otherwise (no openable history yet, or only failed/cancelled).
  const active = task.column === "running" || task.column === "blocked";
  // A pipeline PARENT never gets its own `runId`/`hasOpenableRun` — only its
  // step tasks do — so `hasOpenableRun` alone would forever gate the button
  // on "Run" even once the pipeline has actually executed. Once any step
  // execution has landed in `pipelineRun.history`, there's something worth
  // opening the run view for; Retry/Restart live there, not on the card
  // (M15, docs/plans/pipelines.md review). Mirrored in `buildTaskContextMenu`.
  const hasOpenablePipelineRun = !!task.pipelineRun && task.pipelineRun.history.length > 0;
  const openable = task.hasOpenableRun || hasOpenablePipelineRun;
  // Stop is only honoured server-side for a pipeline PARENT while its run
  // is genuinely `running` (`POST /tasks/:id/pipeline/cancel` 409s
  // otherwise — e.g. a `blocked` run with nothing live), so the card's Stop
  // gates on `pipelineRun.status`, not the column (L-A1). Mirrored in
  // `buildTaskContextMenu`. Every other task keeps the column-based rule.
  const stoppable = task.pipelineId ? task.pipelineRun?.status === "running" : active;
  // Combine structured interactions with codex's narrative `blocked` signal.
  // The latter has no answerable payload — the user resolves it from the run
  // panel — but it represents the same "waiting on you" state to the user.
  // When the only signal is `blocked` (no structured questions), we label the
  // call-to-action "Review" instead of "Answer" to avoid promising a Q&A flow
  // the panel can't deliver.
  const pendingCount = task.pendingInteractionCount;
  // A card waiting on another card (src/bun/dependencies.ts) moves on by
  // itself when that lands — it isn't waiting on the user.
  const waitingOnCards = (task.blockedBy ?? []).some((d) => !d.satisfied);
  const blocked = task.column === "blocked" && !waitingOnCards;
  const awaiting = pendingCount > 0 || blocked;
  const awaitingLabel =
    pendingCount > 1 ? `Answer (${pendingCount})`
    : pendingCount === 1 ? "Answer"
    : "Review";

  // The one button a card shows: the user's next move, if there is one.
  // Running work and finished/merging cards need nothing from the user.
  const notStarted = !openable && !active && !archived && (task.column === "backlog" || task.column === "ready");
  const primary = archived ? (
    <Button size="sm" variant="secondary" className="h-7" onClick={() => onOpen(task)}>
      <FolderOpen className="size-3" /> Open
    </Button>
  ) : awaiting ? (
    <Button
      size="sm"
      className="h-7 gap-1 bg-amber-500 text-amber-950 hover:bg-amber-500/90 focus-visible:ring-amber-500"
      onClick={() => onOpen(task)}
      title={pendingCount > 0 ? "Open run panel to answer" : "Agent is waiting on you — open it"}
    >
      <MessageCircleQuestion className="size-3" />
      {awaitingLabel}
      <ArrowRight className="size-3" />
    </Button>
  ) : notStarted ? (
    <Button size="sm" className="h-7" onClick={() => onStart(task)}>
      <Play className="size-3" /> Run
    </Button>
  ) : task.column === "review" ? (
    <Button size="sm" variant="secondary" className="h-7" onClick={() => onOpen(task)}>
      <FolderOpen className="size-3" /> Review
    </Button>
  ) : null;

  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);
  const runningSubagents = task.runningSubagents ?? 0;
  const title = splitCardTitle(task.title);
  const waitingTags = (task.blockedBy ?? []).filter((d) => !d.satisfied);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative cursor-grab select-none border-border/60 border-l-4 hover:border-border transition-colors",
        type.borderClass,
        isDragging && "opacity-50",
        awaiting && "ring-2 ring-warning/60 ring-offset-2 ring-offset-background",
        archived && "cursor-default opacity-60",
      )}
      // `onClick` (open) stays untouched by the addition below — a
      // right-click never opens the panel, only `onContextMenu` fires for it.
      onClick={() => onOpen(task)}
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
    >
      {task.unread && !isOpen && (
        // Static dot for "has assistant messages you haven't read yet" —
        // deliberately unanimated (the amber awaiting-pulse ring is the only
        // animated attention state). Pinned to the corner so it coexists
        // with that ring (an outline) without visual conflict, and sits
        // above the header's row-1 harness badge in the DOM/paint order.
        <span
          // -1.5 offsets keep the dot's background halo clear of the
          // awaiting state's ring-offset outline instead of notching it.
          className="absolute -top-1.5 -right-1.5 size-2.5 rounded-full bg-info ring-2 ring-background"
          title="New messages"
          role="img"
          aria-label="New messages"
        />
      )}
      <CardHeader className="space-y-1 p-3 pb-2">
        <div className="flex items-start gap-1.5">
          <TypeIcon className={cn("mt-0.5 size-3.5 shrink-0", type.iconClass)} aria-label={type.label} />
          <CardTitle
            className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-snug line-clamp-3"
            title={[task.title, task.branch && `branch ${task.branch}`, task.model && `model ${task.model}`, abbreviateHome(task.workdir, homeDir)].filter(Boolean).join("\n")}
          >
            {title.issue && <span className="mr-1 font-mono font-medium text-muted-foreground">#{title.issue}</span>}
            {title.text}
          </CardTitle>
        </div>
        {/* Dependency tags: a card that blocks others wears its own color
         *  ("blocks 3"); each card waiting on it wears that same color with its
         *  short name ("#214"). */}
        {!archived && (waitingTags.length > 0 || (task.blocking?.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-1">
            {(task.blocking?.length ?? 0) > 0 && (
              <span
                className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1", blockerColor(task.id))}
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
                className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1", blockerColor(d.taskId))}
                data-testid="blocked-by-chip"
                title={`Waiting on "${d.title}" — ${d.detail}`}
              >
                <Link2 className="size-3" />
                waits on {d.ref ?? shortCardName(d.title)}
              </span>
            ))}
          </div>
        )}
        {!archived && (
          <p
            data-testid="card-status"
            data-tone={status.tone}
            title={status.needsYou ? `Needs you: ${status.needsYou.reason}` : status.line}
            className={cn(
              "flex items-start gap-1 text-xs leading-snug",
              status.tone === "danger" && DANGER_TEXT,
              status.tone === "warning" && "text-warning",
              status.tone === "success" && "text-success",
              status.tone === "info" && "text-info",
              status.tone === "muted" && "text-muted-foreground",
            )}
          >
            {status.needsYou && <CircleAlert className="mt-0.5 size-3 shrink-0" aria-label="Needs you" />}
            <span className="line-clamp-2">{status.line}</span>
          </p>
        )}
        {!archived &&
          progress.map((p) => {
            const line = progressLine(p);
            const fraction = p.active ? progressFraction(p.counts) : null;
            return (
              <div key={`${p.project}:${p.label}`} data-testid="card-progress" className="flex flex-col gap-1">
                <p
                  title={p.current ?? line.text}
                  className={cn(
                    "truncate text-xs leading-snug",
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
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {/* One row: the button for the user's next move (only when there is
         *  one), then a few quiet facts. Everything else is on hover (the
         *  strip at the top right) or in the right-click menu. */}
        <div className="flex min-h-6 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {primary}
          <div className="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
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
            {pr && prInfo && !status.line.includes(`#${pr.number}`) && (
              <span className="flex items-center gap-0.5" data-testid="pr-badge" data-tone={prInfo.tone} title={prInfo.title}>
                <GitPullRequest className="size-3" />#{pr.number}
              </span>
            )}
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
            {isTaskFxPaused(task) && task.fxRecovery && (
              <span className="flex items-center gap-0.5 text-warning" data-testid="fx-paused-badge" title={fxPausedBadgeTitle(task.fxRecovery)}>
                <PauseCircle className="size-3" />
                {fxPausedBadgeText(task.fxRecovery, fxAutoResumeCountdown)}
              </span>
            )}
            <span className="truncate" title={task.pipelineRun ? task.pipelineRun.pipelineName : task.agentProfile?.name ?? task.agent} data-testid="task-card-pipeline">
              {task.pipelineRun ? shortPipelineName(task.pipelineRun.pipelineName) : (task.agentProfile?.name ?? task.agent)}
            </span>
          </div>
        </div>
      </CardContent>
      {/* Secondary actions, on hover/focus only. */}
      <div
        className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md border border-border/60 bg-card/95 p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
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
      {/* The "waiting on you" glow. A separate overlay whose OPACITY pulses,
          rather than animating `filter: drop-shadow` on the card itself:
          filter animations re-rasterize the whole card on the CPU every
          frame (60–120 Hz, for as long as the card is awaiting), whereas an
          opacity animation is compositor-only. The shadow is static and
          paints outside the overlay's box, so the overlay is invisible over
          the card's own content and `pointer-events-none` keeps clicks and
          drags untouched. */}
      {awaiting && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] animate-awaiting-pulse motion-reduce:animate-none"
          style={{ boxShadow: "0 0 14px hsl(var(--warning) / 0.85)" }}
        />
      )}
    </Card>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, and every other prop is either a primitive (`homeDir`) or a
// `useCallback`-stabilized handler. dnd-kit's `useDraggable` lives inside
// the component body, so memoizing the outer function doesn't interfere
// with drag state — that's driven by dnd-kit's own context, not props.
export const TaskCard = memo(TaskCardImpl);
