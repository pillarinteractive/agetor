/**
 * The board in one read: every live card with its status line (the same
 * sentence the card shows), what it's waiting on, its PR, lease and live run
 * progress, plus the pending suggestions. Served as JSON and as plain text
 * (`GET /board/digest`, `agetor board`) — the text form is what the Conductor
 * agent reads, so it's written for a reader, not a parser.
 */
import type { Task } from "../shared/types.ts";
import type { RoadmapCardInfo } from "../shared/roadmap.ts";
import { cardStatus, formatAge } from "../mainview/lib/card-status.ts";
import { leaseInfoForTask } from "../mainview/lib/leases.ts";
import { progressLine } from "../mainview/lib/progress.ts";
import { prBadge } from "../mainview/lib/prs.ts";
import { tasks } from "./db.ts";
import { listLeases } from "./lease-watch.ts";
import { prStatusForTask } from "./pr-watch.ts";
import { listProgress } from "./progress-watch.ts";
import { listSuggestions, type Suggestion } from "./suggestions.ts";
import { lastActivityAt } from "./activity-clock.ts";
import { blockedByFor } from "./dependencies.ts";

export interface DigestCard {
  id: string;
  title: string;
  column: string;
  project: string;
  branch: string | null;
  pipeline: { status: string; steps: number } | null;
  status: string;
  tone: string;
  needsYou: string | null;
  pr: string | null;
  prUrl: string | null;
  leases: string[];
  progress: string[];
  updated: string;
}

export interface BoardDigest {
  generatedAt: number;
  cards: DigestCard[];
  suggestions: Pick<Suggestion, "id" | "taskId" | "taskTitle" | "title" | "detail">[];
  leases: { project: string; label: string; held: boolean; holder: string | null }[];
}

/** Live top-level cards, minus any the caller hides (the Conductor itself). */
export function buildBoardDigest(
  opts: {
    exclude?: Set<string>;
    now?: number;
    /** Autopilot's word on its never-started backlog cards, by card id
     *  (src/mainview/lib/card-status.ts `roadmapCardInfo`). */
    roadmap?: ReadonlyMap<string, RoadmapCardInfo>;
  } = {},
): BoardDigest {
  const now = opts.now ?? Date.now();
  const leases = listLeases();
  const progress = listProgress();
  const cards = tasks
    .list()
    .filter((t) => t.archivedAt == null && !t.pipelineParentId && !opts.exclude?.has(t.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => digestCard(t, { leases, progress, now, roadmap: opts.roadmap }));
  return {
    generatedAt: now,
    cards,
    suggestions: listSuggestions()
      .filter((s) => !opts.exclude?.has(s.taskId))
      .map(({ id, taskId, taskTitle, title, detail }) => ({ id, taskId, taskTitle, title, detail })),
    leases: leases.map((l) => ({ project: l.project, label: l.label, held: l.held, holder: l.holderTitle ?? l.owner })),
  };
}

function digestCard(
  t: Task,
  ctx: { leases: ReturnType<typeof listLeases>; progress: ReturnType<typeof listProgress>; now: number; roadmap?: ReadonlyMap<string, RoadmapCardInfo> },
): DigestCard {
  const pr = prStatusForTask(t.id);
  const lease = leaseInfoForTask(t, ctx.leases);
  const progressActive = ctx.progress.some((p) => p.taskId === t.id && p.active);
  const blockedBy = blockedByFor(t.id);
  const status = cardStatus({ ...t, lastActivityAt: lastActivityAt(t), blockedBy }, { pr, lease, now: ctx.now, progressActive, roadmap: ctx.roadmap?.get(t.id) });
  return {
    id: t.id,
    title: t.title,
    column: t.column,
    project: t.workdir,
    branch: t.branch,
    pipeline: t.pipelineRun ? { status: t.pipelineRun.status, steps: t.pipelineRun.stepCount } : null,
    status: status.line,
    tone: status.tone,
    needsYou: status.needsYou ? `${status.needsYou.reason} → ${status.needsYou.actionLabel}` : null,
    pr: pr ? prBadge(pr).title : null,
    prUrl: pr?.url ?? t.prUrl ?? null,
    leases: [
      ...lease.holds.map((l) => `holds the ${l}`),
      ...(blockedBy ?? []).filter((d) => !d.satisfied).map((d) => `blocked by "${d.title}" [${d.taskId.slice(0, 8)}] (${d.detail})`),
    ],
    progress: ctx.progress.filter((p) => p.taskId === t.id).map((p) => progressLine(p).text),
    updated: formatAge(ctx.now - t.updatedAt),
  };
}

const COLUMN_ORDER = ["running", "blocked", "review", "ready", "backlog", "done"];

/** Plain-text rendering, grouped by column, newest first within each. */
export function renderBoardDigest(d: BoardDigest): string {
  const lines: string[] = [];
  const needs = d.cards.filter((c) => c.needsYou);
  if (needs.length) {
    lines.push("## Needs the user");
    for (const c of needs) lines.push(`- ${c.title} [${c.id.slice(0, 8)}]: ${c.needsYou}`);
    lines.push("");
  }
  if (d.suggestions.length) {
    lines.push("## Suggestions (apply with `agetor suggestions apply <taskId> <id>`)");
    for (const s of d.suggestions) lines.push(`- ${s.taskTitle} [${s.taskId.slice(0, 8)}] ${s.id}: ${s.title} — ${s.detail}`);
    lines.push("");
  }
  const columns = [...new Set([...COLUMN_ORDER, ...d.cards.map((c) => c.column)])];
  for (const col of columns) {
    const cards = d.cards.filter((c) => c.column === col);
    if (!cards.length) continue;
    lines.push(`## ${col} (${cards.length})`);
    for (const c of cards) {
      const extras = [
        c.pipeline ? `pipeline ${c.pipeline.status}, ${c.pipeline.steps} steps` : null,
        c.pr,
        ...c.leases,
        ...c.progress,
        c.branch ? `branch ${c.branch}` : null,
        `updated ${c.updated}`,
      ].filter(Boolean);
      lines.push(`- ${c.title} [${c.id.slice(0, 8)}] — ${c.status}`);
      if (extras.length) lines.push(`  ${extras.join(" · ")}`);
    }
    lines.push("");
  }
  if (d.leases.length) {
    lines.push("## Leases");
    for (const l of d.leases) lines.push(`- ${l.label}: ${l.held ? `held by ${l.holder ?? "someone"}` : "free"}`);
  }
  return lines.join("\n").trim() || "The board is empty.";
}
