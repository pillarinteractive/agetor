import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleDot, ExternalLink as ExternalLinkIcon, Play, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { usePipelines } from "@/lib/pipelines";
import { cn } from "@/lib/utils";
import { ExternalLink } from "../kanban/md-components";
import type { GitHubListItem, Project, Task } from "../../../shared/types.ts";

type Row = { item: GitHubListItem; task: { id: string; title: string; column: Task["column"] } | null };

const PROJECT_KEY = "agetor.issues.project";
const PIPELINE_KEY = "agetor.issues.pipeline";
const LABELS_KEY = "agetor.issues.labels";

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

/**
 * Issue queue: a project's open issues as a work list. Filter by labels
 * (e.g. `simplification`, `severity: low`) or text, pick a pipeline, and
 * "Fix" an issue to create and start a pipeline task for it — the PR it
 * opens says `Fixes #n`, so merging closes the issue. Issues that already
 * have a task show it instead (click to open). See src/bun/issue-queue.ts.
 */
export function IssuesPage({
  projects,
  onBack,
  onOpenTask,
}: {
  projects: Project[];
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { pipelines } = usePipelines();
  const [projectPath, setProjectPath] = useState<string>(() => remembered(PROJECT_KEY) ?? "");
  const [pipelineId, setPipelineId] = useState<string>(() => remembered(PIPELINE_KEY) ?? "");
  const [labels, setLabels] = useState<string[]>(() => {
    try {
      return JSON.parse(remembered(LABELS_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyNumber, setBusyNumber] = useState<number | null>(null);

  // Default to the first project once projects load, and the first pipeline.
  useEffect(() => {
    if (!projects.some((p) => p.path === projectPath) && projects[0]) setProjectPath(projects[0].path);
  }, [projects, projectPath]);
  useEffect(() => {
    if (!pipelines.some((p) => p.id === pipelineId) && pipelines[0]) setPipelineId(pipelines[0].id);
  }, [pipelines, pipelineId]);
  useEffect(() => remember(PROJECT_KEY, projectPath), [projectPath]);
  useEffect(() => remember(PIPELINE_KEY, pipelineId), [pipelineId]);
  useEffect(() => remember(LABELS_KEY, JSON.stringify(labels)), [labels]);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getIssueQueue(projectPath, { labels, q: appliedQuery || undefined });
      setRows(res.items);
      setRepo(res.repo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load issues.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, labels, appliedQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  // Label chips: the ones in use on the loaded issues, plus any active filter.
  const labelChoices = useMemo(() => {
    const names = new Set(labels);
    for (const r of rows ?? []) for (const l of r.item.labels) names.add(l.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rows, labels]);

  const toggleLabel = (name: string) =>
    setLabels((cur) => (cur.includes(name) ? cur.filter((l) => l !== name) : [...cur, name]));

  const fix = async (number: number) => {
    if (!pipelineId) return;
    setBusyNumber(number);
    setError(null);
    try {
      const task = await api.fixIssue(projectPath, number, pipelineId);
      setRows((cur) =>
        (cur ?? []).map((r) => (r.item.number === number ? { ...r, task: { id: task.id, title: task.title, column: task.column } } : r)),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start a task for that issue.");
    } finally {
      setBusyNumber(null);
    }
  };

  return (
    <div data-testid="issues-page" className="flex h-full min-h-0 w-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to board
        </Button>
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <CircleDot className="size-4" aria-hidden />
          Issues {repo && <span className="text-muted-foreground">· {repo}</span>}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            aria-label="Project"
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          >
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Fix with
            <select
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              aria-label="Pipeline to fix issues with"
              data-testid="issues-pipeline"
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="ghost" size="icon" onClick={() => void load()} aria-label="Refresh" title="Refresh">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQuery(query.trim());
          }}
          className="mr-2"
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search issues…"
            className="h-7 w-56 text-xs"
          />
        </form>
        {labelChoices.map((name) => {
          const on = labels.includes(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggleLabel(name)}
              data-testid="issues-label"
              data-active={on}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                on ? "border-info bg-info/15 text-info" : "border-border text-muted-foreground hover:bg-accent/40",
              )}
            >
              {name}
              {on && <X className="size-3" aria-hidden />}
            </button>
          );
        })}
      </div>

      {error && <p className="px-4 py-2 text-xs text-destructive">{error}</p>}

      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {rows?.length === 0 && !loading && (
          <li className="px-4 py-6 text-center text-xs text-muted-foreground">No open issues match.</li>
        )}
        {rows?.map(({ item, task }) => (
          <li key={item.number} data-testid="issue-row" className="flex items-start gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">#{item.number}</span>
                <span className="truncate">{item.title}</span>
                <ExternalLink href={item.htmlUrl} className="shrink-0 text-muted-foreground" aria-label="Open on GitHub">
                  <ExternalLinkIcon className="size-3" />
                </ExternalLink>
              </div>
              {item.labels.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.labels.map((l) => (
                    <Badge key={l.name} variant="outline" className="text-[10px]">
                      {l.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            {task ? (
              <button
                type="button"
                onClick={() => onOpenTask(task.id)}
                data-testid="issue-task"
                className="shrink-0 rounded-md border border-border px-2 py-1 text-left text-[11px] hover:bg-accent/40"
                title="Open the task working on this issue"
              >
                <span className="block max-w-56 truncate">{task.title}</span>
                <span className="text-muted-foreground">{task.column}</span>
              </button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="issue-fix"
                disabled={!pipelineId || busyNumber !== null}
                onClick={() => void fix(item.number)}
                className="h-7 shrink-0 gap-1 text-xs"
              >
                <Play className="size-3" aria-hidden />
                {busyNumber === item.number ? "Starting…" : "Fix"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
