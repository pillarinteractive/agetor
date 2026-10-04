import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { formatAge } from "@/lib/card-status";
import { cn } from "@/lib/utils";
import { ExternalLink } from "../kanban/md-components";

type Entry = Awaited<ReturnType<typeof api.getActivity>>[number];

const SHOWN = 12;

/**
 * What happened on this card and when, newest first: steps starting, handing
 * off and blocking; the PR opening, CI going red or green, review comments, a
 * merge; a lease taken or released; automatic Fix CI. `refreshKey` changes
 * whenever the run or the PR does, so the list stays live.
 */
export function ActivityTimeline({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getActivity(taskId)
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [taskId, refreshKey]);

  if (!entries || entries.length === 0) return null;
  const now = Date.now();
  const shown = all ? entries : entries.slice(0, SHOWN);

  return (
    <div data-testid="activity-timeline" className="mb-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Activity</p>
      <ol className="relative ml-1.5 border-l border-border">
        {shown.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="relative pb-2 pl-3 text-xs">
            <span
              className={cn(
                "absolute -left-[4.5px] top-1 size-2 rounded-full",
                e.tone === "danger" && "bg-destructive",
                e.tone === "warning" && "bg-warning",
                e.tone === "success" && "bg-success",
                e.tone === "info" && "bg-info",
                e.tone === "muted" && "bg-muted-foreground/50",
              )}
              aria-hidden
            />
            <span className="block leading-snug">
              {e.url ? (
                <ExternalLink href={e.url} className="text-foreground">
                  {e.text}
                </ExternalLink>
              ) : (
                e.text
              )}
            </span>
            <span className="text-[10px] text-muted-foreground" title={new Date(e.ts).toLocaleString()}>
              {formatAge(now - e.ts) === "just now" ? "just now" : `${formatAge(now - e.ts)} ago`}
            </span>
          </li>
        ))}
      </ol>
      {entries.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {all ? "Show less" : `Show all ${entries.length}`}
          <ChevronDown className={cn("size-3 transition-transform", all && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}
