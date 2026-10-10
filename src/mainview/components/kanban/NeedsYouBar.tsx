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
 * Roadmap steps waiting on the user (Autopilot's roadmap mode) are listed
 * first: the owner's own steps (open the issue), cards held in In Review
 * for sign-off (open the PR or the card), and steps whose card finished
 * while the issue stayed open — those open a panel that shows what the
 * merged PR said, and only from there can the issue be closed as completed
 * or the step be done again. `roadmapOnly` shows just the roadmap entries —
 * cards already say what needs you on their own status line.
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
  // The stuck step whose resolve panel is open, and the answer being sent.
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveBusy, setResolveBusy] = useState<"close" | "redo" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
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
  }, [columnsKey, reloadKey]);

  // The owner's answer to a step whose card finished with the issue still
  // open. Reached only through the panel that shows the PR's own words.
  const resolve = async (r: RoadmapNeedsYou, action: "close" | "redo") => {
    setResolveBusy(action);
    setNotice(null);
    try {
      const res = await api.resolveRoadmapStep(r.issue, action);
      setNotice(res.message);
      setRoadmap(roadmapNeedsYou(res));
      setResolving(null);
    } catch (e) {
      setNotice(`Step ${r.step} (#${r.issue}): ${e instanceof ApiError ? e.message : "couldn't do that"}`);
    } finally {
      setResolveBusy(null);
      setReloadKey((k) => k + 1);
    }
  };

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
          {roadmap.map((r) => {
            const card = r.taskId ? tasks.find((t) => t.id === r.taskId) : undefined;
            const open = resolving === r.key;
            const small = "h-6 shrink-0 px-2 text-[11px]";
            return (
              <li key={r.key} data-testid="roadmap-needs-you-item" data-kind={r.kind} className="flex flex-col gap-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={`${r.title} — ${r.reason}${r.detail ? `\n${r.detail}` : ""}`}>
                    <span className="font-medium">{r.title}</span>
                    <span className="text-muted-foreground"> — {r.reason}</span>
                  </span>
                  {r.kind !== "human" && r.prUrl && (
                    <Button type="button" size="sm" variant="outline" data-testid="roadmap-needs-you-pr" onClick={() => onOpenPr(r.prUrl!)} className={small}>
                      Open PR{r.pr != null ? ` #${r.pr}` : ""}
                    </Button>
                  )}
                  {r.kind === "held" && card && (
                    <Button type="button" size="sm" variant="outline" data-testid="roadmap-needs-you-card" onClick={() => onOpen(card)} className={small}>
                      Open card
                    </Button>
                  )}
                  {r.kind === "stuck" && (
                    <Button
                      type="button"
                      size="sm"
                      variant={open ? "secondary" : "outline"}
                      data-testid="roadmap-needs-you-resolve"
                      aria-expanded={open}
                      onClick={() => setResolving(open ? null : r.key)}
                      className={small}
                    >
                      Resolve…
                    </Button>
                  )}
                  {r.kind === "human" && r.url && (
                    <Button type="button" size="sm" variant="outline" data-testid="roadmap-needs-you-action" onClick={() => onOpenPr(r.url!)} className={small}>
                      Open issue
                    </Button>
                  )}
                </div>
                {r.kind === "held" && r.detail && <p className="break-words pl-0.5 text-[11px] text-muted-foreground">Sensitive files: {r.detail}</p>}
                {r.kind === "stuck" && open && (
                  <div data-testid="roadmap-resolve-panel" className="rounded border border-border bg-background/60 px-2 py-1.5">
                    <p className="text-[11px] font-medium">Why #{r.issue} is still open</p>
                    {/* Text from the PR description: rendered as text, nothing in it is followed. */}
                    <p data-testid="roadmap-resolve-detail" className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                      {r.detail ?? "The PR's description hasn't been read yet — open the PR to see what it left."}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        data-testid="roadmap-resolve-close"
                        disabled={resolveBusy !== null}
                        onClick={() => void resolve(r, "close")}
                        className={small}
                        title={`Closes issue #${r.issue} on GitHub as completed, with a comment saying you accepted the step. The steps waiting on it start.`}
                      >
                        {resolveBusy === "close" ? "Closing…" : `Accept: close #${r.issue} as completed`}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="roadmap-resolve-redo"
                        disabled={resolveBusy !== null}
                        onClick={() => void resolve(r, "redo")}
                        className={small}
                        title="Autopilot starts a fresh card for this step, told about the earlier PR and what it left."
                      >
                        {resolveBusy === "redo" ? "Starting…" : "Do the step again"}
                      </Button>
                      {r.url && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => onOpenPr(r.url!)} className={small}>
                          Open issue
                        </Button>
                      )}
                      <Button type="button" size="sm" variant="ghost" disabled={resolveBusy !== null} onClick={() => setResolving(null)} className={small}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
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
