import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, CircleDot, ExternalLink as ExternalLinkIcon, Milestone, Play, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { usePipelines } from "@/lib/pipelines";
import { cn } from "@/lib/utils";
import { ExternalLink } from "../kanban/md-components";
import { groupByMilestone, milestoneProgress } from "@/lib/milestone-groups";
import type { GitHubListItem, GitHubRepoMilestone, Project, Task } from "../../../shared/types.ts";

type Row = { item: GitHubListItem; task: { id: string; title: string; column: Task["column"] } | null };

const PROJECT_KEY = "agetor.issues.project";
const PIPELINE_KEY = "agetor.issues.pipeline";
const LABELS_KEY = "agetor.issues.labels";
const GROUP_KEY = "agetor.issues.groupByMilestone";
/** Pages of open issues loaded at most (50 each). */
const MAX_PAGES = 6;

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
  const [grouped, setGrouped] = useState(() => remembered(GROUP_KEY) !== "false");
  const [milestones, setMilestones] = useState<GitHubRepoMilestone[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Every label seen this session, so filtering by one doesn't hide the rest.
  const [seenLabels, setSeenLabels] = useState<string[]>([]);

  // Default to the first project once projects load, and the first pipeline.
  useEffect(() => {
    if (!projects.some((p) => p.path === projectPath) && projects[0]) setProjectPath(projects[0].path);
  }, [projects, projectPath]);
  // First visit (or the remembered pipeline was retired): the board's default
  // pipeline (`default_pipeline` preference), else one named Change/Bugfix,
  // else whatever sorts first.
  const [defaultPipelineId, setDefaultPipelineId] = useState<string | null>(null);
  useEffect(() => {
    void api.listPreferences().then((prefs) => setDefaultPipelineId(prefs.default_pipeline || null)).catch(() => {});
  }, []);
  useEffect(() => {
    if (pipelines.some((p) => p.id === pipelineId) || !pipelines[0]) return;
    const pick =
      pipelines.find((p) => p.id === defaultPipelineId) ??
      pipelines.find((p) => /^change\b|bug ?fix/i.test(p.name)) ??
      pipelines[0];
    setPipelineId(pick.id);
  }, [pipelines, pipelineId, defaultPipelineId]);
  useEffect(() => remember(PROJECT_KEY, projectPath), [projectPath]);
  useEffect(() => setSeenLabels([]), [projectPath]);
  useEffect(() => remember(PIPELINE_KEY, pipelineId), [pipelineId]);
  useEffect(() => remember(LABELS_KEY, JSON.stringify(labels)), [labels]);
  useEffect(() => remember(GROUP_KEY, String(grouped)), [grouped]);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      // Every page, so a milestone's group isn't missing issues past the first 50.
      let res = await api.getIssueQueue(projectPath, { labels, q: appliedQuery || undefined });
      const items = [...res.items];
      for (let page = 2; res.hasMore && page <= MAX_PAGES; page++) {
        res = await api.getIssueQueue(projectPath, { labels, q: appliedQuery || undefined, page });
        items.push(...res.items);
      }
      setRows(items);
      setRepo(res.repo);
      setSeenLabels((cur) => [...new Set([...cur, ...items.flatMap((r) => r.item.labels.map((l) => l.name))])]);
      void api
        .listGitHubMilestones({ path: projectPath })
        .then((m) => setMilestones(m.milestones))
        .catch(() => setMilestones([]));
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
  const labelChoices = useMemo(
    () => [...new Set([...seenLabels, ...labels])].sort((a, b) => a.localeCompare(b)),
    [seenLabels, labels],
  );

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

  const renderRow = ({ item, task }: Row) => (
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
);

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
          <Button
            type="button"
            variant={grouped ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setGrouped((g) => !g)}
            aria-pressed={grouped}
            data-testid="issues-group-milestone"
            className="h-8 gap-1.5 text-xs"
            title="Group issues by milestone"
          >
            <Milestone className="size-3.5" aria-hidden />
            By milestone
          </Button>
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
        {grouped
          ? groupByMilestone(rows ?? [], milestones).map((g) => {
              const key = String(g.number ?? "none");
              const open = !collapsed.has(key);
              const progress = milestoneProgress(g.milestone);
              if (labels.length + appliedQuery.length > 0 && g.rows.length === 0) return null;
              return (
                <li key={key} data-testid="milestone-group">
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs backdrop-blur">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((cur) => {
                          const next = new Set(cur);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      aria-expanded={open}
                      className="flex min-w-0 items-center gap-1.5 font-semibold"
                    >
                      {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                      <Milestone className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="truncate">{g.title}</span>
                    </button>
                    <span className="text-muted-foreground">{g.rows.length} open</span>
                    {progress && progress.total > 0 && (
                      <span className="flex items-center gap-1.5 text-muted-foreground" title={`${progress.done} of ${progress.total} issues closed`}>
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
                          <span className="block h-full bg-success" style={{ width: `${progress.pct}%` }} />
                        </span>
                        {progress.pct}%
                      </span>
                    )}
                    {g.milestone?.htmlUrl && (
                      <ExternalLink href={g.milestone.htmlUrl} className="ml-auto text-muted-foreground" aria-label="Open milestone on GitHub">
                        <ExternalLinkIcon className="size-3" />
                      </ExternalLink>
                    )}
                  </div>
                  {open && <ul className="divide-y divide-border">{g.rows.map(renderRow)}</ul>}
                </li>
              );
            })
          : rows?.map(renderRow)}
      </ul>
    </div>
  );
}
