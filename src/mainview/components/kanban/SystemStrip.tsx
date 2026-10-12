import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { boardHealth, waitGroups, type WaitGroup, type WaitingCard } from "@/lib/board-health";
import { cn } from "@/lib/utils";
import type { Harness, Task, TaskPrStatus } from "../../../shared/types.ts";

/** Cards named inline per group before the rest fold into "+N". */
const INLINE_CARDS = 8;

/** "Issue #1265: Maintain…" → "#1265"; anything else keeps the start of its title. */
function shortName(task: Task): string {
  const issue = /#(\d+)/.exec(task.title ?? "");
  if (issue) return `#${issue[1]}`;
  const title = (task.title ?? "Untitled").trim();
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}

function Stat({ label, value, note, tone, title }: { label: string; value: string; note?: string | null; tone?: "warning"; title?: string }) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", tone === "warning" && "text-warning")}>{value}</span>
      {note && <span className="max-w-[28ch] truncate text-muted-foreground">{note}</span>}
    </span>
  );
}

/**
 * The board's own status in one row — agents working, cards on CI against the
 * cap, the queue and why it is not moving, a failing base branch, a usage
 * limit and its backup — and, on demand, every card that is not moving grouped
 * by what it waits on, with the one action that clears a group.
 *
 * A card says why it waits on its own status line; this says it once for all
 * of them. Built from the board's cards and PR statuses (`board-health.ts`),
 * plus the preferences that hold the caps.
 */
export function SystemStrip({
  tasks,
  prs,
  harnesses,
  onOpen,
  onChanged,
}: {
  tasks: Task[];
  prs: ReadonlyMap<string, TaskPrStatus>;
  harnesses: Harness[];
  onOpen: (t: Task) => void;
  /** Called after a group action changed cards, so the board refetches. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The caps change rarely: once on mount, then every half minute.
  useEffect(() => {
    let alive = true;
    const load = () => void api.listPreferences().then((p) => alive && setPreferences(p)).catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const groups = useMemo(() => waitGroups(tasks, prs), [tasks, prs]);
  const health = useMemo(() => {
    const label = (id: string) => harnesses.find((h) => h.id === id)?.label ?? id;
    return boardHealth(tasks, prs, preferences, Date.now(), label);
  }, [tasks, prs, preferences, harnesses]);
  const waiting = groups.reduce((sum, g) => sum + g.cards.length, 0);

  if (waiting === 0 && health.working === 0 && !health.fallback) return null;

  const retryAll = async (group: WaitGroup) => {
    setBusy(group.cause);
    setNotice(null);
    const failed: string[] = [];
    for (const { task } of group.cards) {
      try {
        await api.retryPipeline(task.id);
      } catch (e) {
        failed.push(`${shortName(task)}: ${e instanceof ApiError ? e.message : "couldn't retry"}`);
      }
    }
    const done = group.cards.length - failed.length;
    setNotice(failed.length === 0 ? `Retried ${done} ${done === 1 ? "card" : "cards"}.` : `Retried ${done} of ${group.cards.length}. ${failed.join("; ")}`);
    setBusy(null);
    onChanged();
  };

  const ciFull = health.onCi >= health.ciCap;
  return (
    <section data-testid="system-strip" aria-label="Board status" className="mx-4 mt-3 rounded-md border border-border bg-muted/30 text-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5">
        <Stat label="Agents" value={`${health.working}/${health.agentCap}`} note="working" title="Steps with an agent working now, of the most allowed at once" />
        <Stat
          label="On CI"
          value={`${health.onCi}/${health.ciCap}`}
          tone={ciFull ? "warning" : undefined}
          note={ciFull ? "at the cap: no new step starts" : null}
          title="Cards waiting for GitHub CI, against the cap. At the cap, cards not already on CI start no further step."
        />
        {health.queued > 0 && <Stat label="Queued" value={String(health.queued)} note={health.queuedWhy} title={health.queuedWhy ?? undefined} />}
        {health.baseFailing && (
          <span data-testid="system-strip-base" className="max-w-[44ch] truncate font-medium text-warning" title={health.baseFailing}>
            {health.baseFailing}
          </span>
        )}
        {health.fallback && (
          <span data-testid="system-strip-fallback" className="max-w-[52ch] truncate text-info" title={health.fallback}>
            {health.fallback}
          </span>
        )}
        {waiting > 0 && (
          <button
            type="button"
            data-testid="system-strip-toggle"
            aria-expanded={open}
            aria-controls="system-strip-waiting"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              Waiting <span className="font-medium tabular-nums text-foreground">{waiting}</span>
              {health.needsYou > 0 && <span className="text-warning"> · {health.needsYou} on you</span>}
            </span>
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
          </button>
        )}
      </div>
      {open && waiting > 0 && (
        <div id="system-strip-waiting" data-testid="system-strip-waiting" className="border-t border-border px-3 py-2">
          <ul className="flex flex-col gap-1.5">
            {groups.map((group) => (
              <li key={group.cause} data-testid="wait-group" data-cause={group.cause} className="flex items-start gap-3">
                <div className="w-52 shrink-0">
                  <div className={cn("font-medium", group.cause === "you" && "text-warning")}>
                    {group.title} <span className="tabular-nums text-muted-foreground">· {group.cards.length}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{group.clears}</div>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-0.5 pt-px">
                  {group.cards.slice(0, INLINE_CARDS).map((card: WaitingCard) => (
                    <button
                      key={card.task.id}
                      type="button"
                      data-testid="wait-card"
                      onClick={() => onOpen(card.task)}
                      title={`${card.task.title}\n${card.detail}`}
                      className="rounded px-0.5 tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {shortName(card.task)}
                      {card.step && <span className="text-muted-foreground"> {card.step}</span>}
                    </button>
                  ))}
                  {group.cards.length > INLINE_CARDS && <span className="text-muted-foreground">+{group.cards.length - INLINE_CARDS}</span>}
                </div>
                {group.action === "retry" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="wait-group-action"
                    disabled={busy !== null}
                    onClick={() => void retryAll(group)}
                    className="h-6 shrink-0 px-2 text-[11px]"
                  >
                    {busy === group.cause ? "Retrying…" : group.cards.length === 1 ? "Retry" : `Retry all ${group.cards.length}`}
                  </Button>
                )}
                {group.action === "open" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="wait-group-action"
                    onClick={() => onOpen(group.cards[0]!.task)}
                    className="h-6 shrink-0 px-2 text-[11px]"
                  >
                    {group.cards.length === 1 ? "Open" : "Open first"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {notice && (
            <p role="status" className="mt-1.5 text-[11px] text-muted-foreground">
              {notice}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
