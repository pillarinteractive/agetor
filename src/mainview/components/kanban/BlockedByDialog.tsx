import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { api, ApiError } from "@/lib/api";
import type { Task } from "../../../shared/types.ts";

const TITLE_ID = "blocked-by-dialog-title";

/** Pick the cards a card is blocked by (src/bun/dependencies.ts). When they
 *  all land — Done, archived, or their PR merged — the card moves on by
 *  itself: started if it never ran, told to carry on if it's waiting. */
export function BlockedByDialog({ task, tasks, onClose }: { task: Task | null; tasks: Task[]; onClose: () => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setIds((task?.blockedBy ?? []).filter((d) => !d.satisfied).map((d) => d.taskId));
    setError(null);
  }, [task?.id]);
  if (!task) return null;

  const items = tasks
    .filter((t) => t.id !== task.id && !t.pipelineParentId && t.archivedAt == null && t.column !== "done")
    .map((t) => ({ value: t.id, label: t.title, hint: `${t.column}${t.branch ? ` · ${t.branch}` : ""}` }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setBlockedBy(task.id, ids);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <Dialog open onClose={onClose} labelledBy={TITLE_ID} className="flex w-full max-w-lg flex-col p-0">
      <div data-testid="blocked-by-dialog" className="flex flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
              <Link2 className="size-4 shrink-0 text-muted-foreground" />
              Blocked by…
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={task.title}>{task.title}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex flex-col gap-2 p-3 text-xs">
          <MultiSearchSelect
            values={ids}
            onChange={setIds}
            items={items}
            placeholder="Search cards…"
            emptyLabel="Not blocked by any card"
            placement="bottom"
          />
          <p className="text-muted-foreground">
            When every card here is done or its PR merges, this card moves on by itself — it starts if it hasn't
            run yet, or its waiting step is told to merge the base branch and carry on.
          </p>
          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border/60 p-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>Save</Button>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
