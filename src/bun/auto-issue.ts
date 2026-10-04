/**
 * Every board card has a GitHub issue. A card created without one (typed in
 * New task, made by the Conductor, …) in a project with a GitHub remote gets
 * an issue opened for it: the card's title, its prompt as the body. The card
 * is then linked — `issueUrl`, its title prefixed "Issue #N: ", "Fixes #N"
 * appended to its prompt — so it carries a number everywhere (tags,
 * dependencies, the Conductor) and the issue closes when its PR merges
 * (src/bun/pr-watch.ts).
 *
 * Skipped: cards that already have an issue, pipeline steps, the Conductor,
 * projects without a GitHub remote. `auto_issues=false` turns it off.
 */
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { createGitHubIssue } from "./github.ts";
import { recordActivity } from "./activity.ts";

// The Conductor's task id (src/bun/conductor.ts) — read by name to keep this
// module out of the conductor ↔ orchestrator import graph.
const CONDUCTOR_TASK_PREF = "conductor_task_id";

export const AUTO_ISSUES_PREF = "auto_issues";
const BODY_MAX = 60_000;

/** Does this card need an issue made for it? Pure; exported for tests. */
export function needsIssue(task: Pick<Task, "id" | "title" | "issueUrl" | "pipelineParentId" | "archivedAt">, conductorId: string | null): boolean {
  if (task.issueUrl || task.pipelineParentId || task.archivedAt != null) return false;
  if (conductorId && task.id === conductorId) return false;
  return !/^Issue #\d+:/.test(task.title);
}

export function issueBody(task: Pick<Task, "prompt">): string {
  const prompt = task.prompt.trim() || "_(no description)_";
  const clipped = prompt.length > BODY_MAX ? `${prompt.slice(0, BODY_MAX)}\n\n…(truncated)` : prompt;
  return `${clipped}\n\n---\n_Opened by Agetor for a board card._`;
}

/** Open the card's issue and link it. Never throws; returns the issue number. */
export async function ensureIssueForTask(taskId: string): Promise<number | null> {
  const pref = preferences.get(AUTO_ISSUES_PREF);
  if (pref === "false") return null;
  // Never open real issues from the test suite (its fixture repos can carry
  // GitHub-shaped remotes, and this machine's `gh` is signed in) unless a
  // test asks for it explicitly.
  if (process.env.NODE_ENV === "test" && pref !== "true") return null;
  const task = tasks.get(taskId);
  if (!task || !needsIssue(task, preferences.get(CONDUCTOR_TASK_PREF) ?? null)) return null;
  try {
    const r = await createGitHubIssue({ dir: task.workdir, title: task.title, body: issueBody(task) });
    if (!r.ok) return null; // no GitHub remote / not signed in — nothing to link
    const number = r.item.number;
    const fresh = tasks.get(taskId) ?? task;
    tasks.update(taskId, {
      issueUrl: r.item.htmlUrl,
      title: /^Issue #\d+:/.test(fresh.title) ? fresh.title : `Issue #${number}: ${fresh.title}`,
      prompt: /\bFixes #\d+\b/.test(fresh.prompt) ? fresh.prompt : `${fresh.prompt.trimEnd()}\n\nFixes #${number}`,
    });
    recordActivity(taskId, { kind: "task", text: `Opened issue #${number} for this card`, tone: "muted", url: r.item.htmlUrl });
    return number;
  } catch {
    return null;
  }
}

/** At startup: open issues for live cards made before this existed (or while
 *  GitHub was unreachable). Done cards are left alone. */
export async function backfillIssues(): Promise<number> {
  let n = 0;
  for (const t of tasks.list()) {
    if (t.column === "done") continue;
    if ((await ensureIssueForTask(t.id)) != null) n++;
  }
  return n;
}
