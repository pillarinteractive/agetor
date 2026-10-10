import { useContext, useEffect, useMemo, useState } from "react";
import { ChevronDown, CircleAlert, Sparkles } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cardStatus, needsYouList, roadmapNeedsYou, type NeedsYouAction, type RoadmapNeedsYou } from "@/lib/card-status";
import { leaseInfoForTask } from "@/lib/leases";
import { ProgressContext } from "@/lib/progress";
import { cn } from "@/lib/utils";
import type { LeaseStatus, Task, TaskPrStatus } from "../../../shared/types.ts";

const COLLAPSED_COUNT = 4;

/**
 * "Needs you": the board cards whose next move is the user's — a question to
 * answer, a block to retry, a PR to fix or merge, a result to review — each
 * with its reason and the one button that settles it. Empty means nothing is
 * waiting on you. Built from the same `cardStatus` the cards' status lines use.
 *
 * Roadmap steps waiting on the user (Autopilot's roadmap mode) have no card:
 * they're listed first, each opening its issue. `roadmapOnly` shows just
 * those — cards already say what needs you on their own status line.
 */
export function NeedsYouBar({
  tasks,
  prs,
  leases,
  onOpen,
  onRetry,
  onOpenPr,
  roadmapOnly = false,
}: {
  tasks: Task[];
  prs: ReadonlyMap<string, TaskPrStatus>;
  leases: LeaseStatus[];
  onOpen: (t: Task) => void;
  onRetry: (t: Task) => void;
  onOpenPr: (url: string) => void;
  roadmapOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Orchestrator suggestions (src/bun/suggestions.ts), refetched whenever a
  // card, PR or lease changes.
  type Suggestion = Awaited<ReturnType<typeof api.getSuggestions>>[number];
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changeKey = useMemo(
    () => `${tasks.map((t) => `${t.id}:${t.updatedAt}:${t.column}`).join(",")}|${[...prs.values()].map((p) => `${p.number}:${p.checks}:${p.behindBy ?? ""}`).join(",")}|${leases.map((l) => `${l.label}:${l.held}`).join(",")}`,
    [tasks, prs, leases],
  );
  useEffect(() => {
    if (roadmapOnly) return;
    let alive = true;
    api.getSuggestions().then((s) => alive && setSuggestions(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [changeKey, roadmapOnly]);
  // Roadmap steps waiting on the user: refetched when a card moves (a pass
  // follows) and once a minute (the owner's steps change on GitHub).
  const [roadmap, setRoadmap] = useState<RoadmapNeedsYou[]>([]);
  const columnsKey = useMemo(() => tasks.map((t) => `${t.id}:${t.column}`).join(","), [tasks]);
  useEffect(() => {
    let alive = true;
    const load = () => void api.getAutopilot().then((a) => alive && setRoadmap(roadmapNeedsYou(a))).catch(() => {});
    load();
    const soon = setTimeout(load, 10_000); // after the pass the move triggers
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearTimeout(soon);
      clearInterval(timer);
    };
  }, [columnsKey]);

  const apply = async (s: Suggestion) => {
    if (s.apply.kind === "open") {
      const t = tasks.find((x) => x.id === s.taskId);
      if (t) onOpen(t);
      return;
    }
    setBusy(s.id);
    setNotice(null);
    try {
      const r = await api.applySuggestion(s.taskId, s.id);
      setNotice(`${s.taskTitle}: ${r.message}`);
      setSuggestions((cur) => cur.filter((x) => x.id !== s.id));
    } catch (e) {
      setNotice(`${s.taskTitle}: ${e instanceof ApiError ? e.message : "couldn't apply that"}`);
    } finally {
      setBusy(null);
    }
  };
  const progress = useContext(ProgressContext);
  const items = useMemo(() => {
    if (roadmapOnly) return [];
    const now = Date.now();
    const live = new Set(progress.filter((p) => p.active).map((p) => p.taskId));
    return needsYouList(
      tasks.map((task) => ({
        task,
        status: cardStatus(task, { pr: prs.get(task.id) ?? null, lease: leaseInfoForTask(task, leases), now, progressActive: live.has(task.id) }),
      })),
    );
  }, [tasks, prs, leases, progress, roadmapOnly]);

  if (items.length === 0 && suggestions.length === 0 && roadmap.length === 0 && !notice) return null;
  // A card with a suggestion shows it instead of its plain Needs-you line.
  const suggested = new Set(suggestions.map((s) => s.taskId));
  const rest = items.filter((i) => !suggested.has(i.task.id));
  const shown = expanded ? rest : rest.slice(0, COLLAPSED_COUNT);

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
        Needs you · {suggestions.length + rest.length + roadmap.length}
      </div>
      {roadmap.length > 0 && (
        <ul className="mb-1 flex flex-col gap-1" data-testid="roadmap-needs-you">
          {roadmap.map((r) => (
            <li key={r.key} data-testid="roadmap-needs-you-item" className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={`${r.title} — ${r.reason}`}>
                <span className="font-medium">{r.title}</span>
                <span className="text-muted-foreground"> — {r.reason}</span>
              </span>
              {r.url && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="roadmap-needs-you-action"
                  onClick={() => onOpenPr(r.url!)}
                  className="h-6 shrink-0 px-2 text-[11px]"
                >
                  Open issue
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 0 && (
        <ul className="mb-1 flex flex-col gap-1" data-testid="suggestions">
          {suggestions.map((s) => (
            <li key={s.id} data-testid="suggestion" className="flex items-center gap-2 text-xs">
              <Sparkles className="size-3 shrink-0 text-info" aria-hidden />
              <button
                type="button"
                onClick={() => {
                  const t = tasks.find((x) => x.id === s.taskId);
                  if (t) onOpen(t);
                }}
                className="min-w-0 flex-1 truncate text-left hover:underline"
                title={`${s.taskTitle} — ${s.title}\n${s.detail}`}
              >
                <span className="font-medium">{s.taskTitle}</span>
                <span className="text-muted-foreground"> — {s.title}</span>
              </button>
              <Button
                type="button"
                size="sm"
                data-testid="suggestion-apply"
                disabled={busy !== null}
                onClick={() => void apply(s)}
                className="h-6 shrink-0 px-2 text-[11px]"
              >
                {busy === s.id ? "Applying…" : s.apply.kind === "open" ? "Open" : "Apply"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="mb-1 text-[11px] text-muted-foreground">{notice}</p>}
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
      {rest.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all ${rest.length}`}
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}
