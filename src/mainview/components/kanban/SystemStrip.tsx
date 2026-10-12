import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { boardHealth, boardSignal, levelOf, waitGroups, type WaitGroup, type WaitingCard } from "@/lib/board-health";
import { cn } from "@/lib/utils";
import type { Harness, Task, TaskPrStatus } from "../../../shared/types.ts";

/** Cards named inline per group before the rest fold into "+N". */
const INLINE_CARDS = 8;

const DOT = {
  good: "bg-emerald-500",
  waiting: "bg-amber-400",
  blocked: "bg-red-500",
} as const;

function Dot({ level }: { level: keyof typeof DOT }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[level])} />;
}

/** "Issue #1265: Maintain…" → "#1265"; anything else keeps the start of its title. */
function shortName(task: Task): string {
  const issue = /#(\d+)/.exec(task.title ?? "");
  if (issue) return `#${issue[1]}`;
  const title = (task.title ?? "Untitled").trim();
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}

/**
 * The board in one light: green when nothing is held up, yellow when cards are
 * only waiting on something that clears by itself (CI, a free place, a usage
 * limit, a background command), red when a card stays put until someone acts.
 * The counts open a list of the causes, each with its cards and, where there
 * is one, the action that clears the whole group.
 *
 * Built from the board's cards and PR statuses (`board-health.ts`), plus the
 * preferences that hold the caps (shown in the tooltip).
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
  const signal = useMemo(() => boardSignal(groups), [groups]);
  const health = useMemo(() => {
    const label = (id: string) => harnesses.find((h) => h.id === id)?.label ?? id;
    return boardHealth(tasks, prs, preferences, Date.now(), label);
  }, [tasks, prs, preferences, harnesses]);

  // Nothing running and nothing held up: no light to show.
  if (signal.level === "good" && health.working === 0) return null;

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

  // The numbers behind the light, for anyone who hovers.
  const numbers = [
    `${health.working} of ${health.agentCap} agents working`,
    `${health.onCi} of ${health.ciCap} cards on CI${health.onCi >= health.ciCap ? " (at the cap: no new step starts)" : ""}`,
    health.queued > 0 ? `${health.queued} queued${health.queuedWhy ? `: ${health.queuedWhy}` : ""}` : null,
    health.baseFailing,
    health.fallback,
  ]
    .filter(Boolean)
    .join("\n");
  const held = signal.blocked + signal.waiting;

  return (
    <section data-testid="system-strip" data-level={signal.level} aria-label="Board status" className="mx-4 mt-3 rounded-md border border-border bg-muted/30 text-xs">
      <button
        type="button"
        data-testid="system-strip-toggle"
        aria-expanded={held > 0 ? open : undefined}
        aria-controls={held > 0 ? "system-strip-waiting" : undefined}
        disabled={held === 0}
        onClick={() => setOpen((v) => !v)}
        title={numbers}
        className="flex w-full items-center gap-4 rounded-md px-3 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        {signal.level === "good" && (
          <span className="flex items-center gap-1.5">
            <Dot level="good" />
            All good
          </span>
        )}
        {signal.blocked > 0 && (
          <span className="flex items-center gap-1.5">
            <Dot level="blocked" />
            <span className="font-medium tabular-nums">{signal.blocked}</span> blocked
          </span>
        )}
        {signal.waiting > 0 && (
          <span className="flex items-center gap-1.5">
            <Dot level="waiting" />
            <span className="font-medium tabular-nums">{signal.waiting}</span> waiting
          </span>
        )}
        {held > 0 && <ChevronDown className={cn("ml-auto size-3 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />}
      </button>
      {open && held > 0 && (
        <div id="system-strip-waiting" data-testid="system-strip-waiting" className="border-t border-border px-3 py-2">
          <ul className="flex flex-col gap-1.5">
            {groups.map((group) => (
              <li key={group.cause} data-testid="wait-group" data-cause={group.cause} className="flex items-center gap-3" title={group.clears}>
                <span className="flex w-56 shrink-0 items-center gap-1.5">
                  <Dot level={levelOf(group.cause)} />
                  <span className="truncate">{group.title}</span>
                  <span className="tabular-nums text-muted-foreground">{group.cards.length}</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-0.5">
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
                    </button>
                  ))}
                  {group.cards.length > INLINE_CARDS && <span className="text-muted-foreground">+{group.cards.length - INLINE_CARDS}</span>}
                </span>
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
                    Open
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
