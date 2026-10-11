/**
 * Issue queue: a project's open issues as a work list, and "Fix with
 * <pipeline>" to turn one into a running pipeline task. The task is built the
 * same way `agetor add --issue` builds one (title, prompt and type from the
 * issue thread, the thread attached as a snapshot), plus a line asking the PR
 * to say `Fixes #n` so merging it closes the issue.
 */
import type { GitHubListItem, Task } from "../shared/types.ts";
import {
  buildIssueTaskPrompt,
  inferTaskTypeFromLabels,
  issueTaskTitle,
  renderIssueThreadMarkdown,
  sameIssueUrl,
} from "../shared/issue-task.ts";
import { tasks } from "./db.ts";
import * as gitHost from "./git-host.ts";
import { createTask, startTask, isTaskRunLive } from "./orchestrator.ts";
import { claimIssue, releaseIssue } from './dispatch-claims.ts';

export interface IssueQueueItem {
  item: GitHubListItem;
  /** The newest live task already working on this issue, if any. */
  task: { id: string; title: string; column: Task["column"] } | null;
}

/** The task already working on an issue: newest non-archived match. */
export function taskForIssue(htmlUrl: string, list: Task[]): Task | null {
  return (
    list
      .filter((t) => t.archivedAt == null && !t.pipelineParentId && sameIssueUrl(t.issueUrl, htmlUrl))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

export async function listIssueQueue(input: {
  dir: string;
  labels?: string[];
  query?: string;
  page?: number;
}): Promise<{ ok: true; repo: string; items: IssueQueueItem[]; hasMore: boolean } | { ok: false; error: string }> {
  const res = await gitHost.listItems({
    dir: input.dir,
    kind: "issues",
    state: "open",
    labels: input.labels,
    query: input.query,
    page: input.page,
    sort: "created",
    direction: "desc",
  });
  if (!res.ok) return res;
  const all = tasks.list();
  return {
    ok: true,
    repo: res.repo,
    items: res.items.map((item) => {
      const t = taskForIssue(item.htmlUrl, all);
      return { item, task: t ? { id: t.id, title: t.title, column: t.column } : null };
    }),
    hasMore: res.hasMore,
  };
}

export function fixesLine(number: number): string {
  return (
    `When this work is opened as a pull request, include "Fixes #${number}" in the PR description so merging it closes the issue — ` +
    `but only if the PR fully resolves it. If acceptance is still pending after it merges (a deployed or live run not done yet, ` +
    `blocked parts, follow-ups), write "Refs #${number}" instead and say what's left; the issue then stays open.`
  );
}

/**
 * Create (and by default start) a pipeline task for an issue. Refuses when
 * a live task is already on it, so a double click can't start two runs.
 *
 * With `start: false` the card lands in Backlog and nothing else happens: one
 * read of the issue thread from GitHub, a few read-only `git rev-parse` calls
 * (the base commit, a free branch name), the task row, its base-branch
 * preference entry and the thread snapshot file under the data dir. No
 * worktree, no branch, no setup command, no agent session and no write to
 * GitHub until the card is started — Autopilot's tracker mode makes one such
 * card per open step of a milestone (src/bun/autopilot.ts).
 */
export async function createTaskFromIssue(input: {
  dir: string;
  number: number;
  pipelineId: string;
  start?: boolean;
  /** Appended to the prompt (e.g. Autopilot's scope clarification). */
  extraPrompt?: string;
  /** A Done card on the issue doesn't count as "already working on it" (a
   *  reopened issue gets a new card). */
  allowAfterDone?: boolean;
  /** Revalidate source/state/claims after awaited preparation before spawn. */
  validate?: () => Promise<string | null>;
  onCreated?: (task:Task)=>void;
}, deps: { issueThread: typeof gitHost.issueThread } = gitHost): Promise<{ task: Task } | { error: string; status: 400 | 409 | 502 }> {
  const thread = await deps.issueThread({ dir: input.dir, number: input.number, includeComments: true });
  if (!thread.ok) return { error: thread.error, status: 502 };
  const existing = taskForIssue(
    thread.item.htmlUrl,
    tasks.list().filter((t) => !input.allowAfterDone || t.column !== "done"),
  );
  if (existing) return { error: `"${existing.title}" is already working on this issue`, status: 409 };

  const claimed = claimIssue(thread.item.htmlUrl,isTaskRunLive);
  if ('error' in claimed) return {error:claimed.error,status:409};
  try {
  // Reread while owning the durable canonical claim: a concurrent manual
  // create may have completed while the issue thread was being fetched.
  const freshExisting=taskForIssue(thread.item.htmlUrl,tasks.list().filter(t=>!input.allowAfterDone||t.column!=='done'));
  if(freshExisting) return {error:`"${freshExisting.title}" is already working on this issue`,status:409};
  if(input.validate) {const error=await input.validate();if(error)return {error,status:409};}

  const prompt =
    `${buildIssueTaskPrompt({ ...thread, snapshotAttached: true }).prompt}\n\n${fixesLine(thread.item.number)}` +
    (input.extraPrompt ? `\n\n${input.extraPrompt}` : "");
  const start = input.start !== false;
  const created = await createTask({
    title: issueTaskTitle(thread.item),
    prompt,
    workdir: input.dir,
    isolation: "worktree",
    taskType: inferTaskTypeFromLabels(thread.item.labels),
    pipelineId: input.pipelineId,
    issueUrl: thread.item.htmlUrl,
    issueSnapshot: renderIssueThreadMarkdown(thread),
    column: start ? "ready" : "backlog",
  }, { reservedTaskId: claimed.claim.taskId });
  if ("error" in created) return { error: created.error, status: 400 };
  input.onCreated?.(created.task);
  if (start) {
    const started = await startTask(created.task.id, {validate:input.validate});
    if ("error" in started) return { error: `created, but it didn't start: ${started.error}`, status: 409 };
  }
  return { task: tasks.get(created.task.id) ?? created.task };
  } finally { releaseIssue(claimed.key,claimed.claim.token); }
}
