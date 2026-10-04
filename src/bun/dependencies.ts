/**
 * Card dependencies: "this card is blocked by those cards". A dependency is
 * satisfied once its card is Done or archived, or its pull request merged.
 * While any isn't, the card says what it's waiting on; when the last one is
 * satisfied, the watcher moves the card on by itself:
 *
 * - a card that never started → started;
 * - a pipeline blocked on a step → that step is told the dependency landed
 *   (merge the base branch, re-verify, carry on);
 * - an idle single-agent card (review/blocked) → told the same.
 *
 * Stored in the `card_dependencies` preference as `{ taskId: [depTaskId…] }`;
 * a card's entry is cleared once acted on.
 */
import type { Task, TaskDependency } from "../shared/types.ts";
import { preferences, runs, tasks } from "./db.ts";
import { prStatusForTask } from "./pr-watch.ts";
import { recordActivity } from "./activity.ts";
import { sendInput, startTask } from "./orchestrator.ts";
import { prBadge } from "../mainview/lib/prs.ts";
import { shortCardName } from "../mainview/lib/card-names.ts";

export const DEPENDENCIES_PREF = "card_dependencies";
const TICK_MS = 15_000;

type DepMap = Record<string, string[]>;

export function readDependencies(raw: string | null | undefined = preferences.get(DEPENDENCIES_PREF)): DepMap {
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: DepMap = {};
    for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        const clean = ids.filter((x): x is string => typeof x === "string" && x !== k);
        if (clean.length) out[k] = [...new Set(clean)];
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeDependencies(map: DepMap): void {
  preferences.set(DEPENDENCIES_PREF, JSON.stringify(map));
}

/** Would `taskId` → `deps` close a loop (A waits on B waits on A)? */
export function createsCycle(map: DepMap, taskId: string, deps: string[]): boolean {
  const next = { ...map, [taskId]: deps };
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next[id] ?? []));
  }
  return false;
}

/** Replace a card's dependencies (empty clears them). */
export function setDependencies(taskId: string, ids: string[]): { ok: true; deps: string[] } | { error: string } {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found" };
  const deps = [...new Set(ids.filter((id) => id !== taskId))];
  for (const id of deps) {
    const dep = tasks.get(id);
    if (!dep || dep.pipelineParentId) return { error: `no card ${id}` };
  }
  const map = readDependencies();
  if (createsCycle(map, taskId, deps)) return { error: "that would make the cards wait on each other" };
  const before = new Set(map[taskId] ?? []);
  if (deps.length) map[taskId] = deps;
  else delete map[taskId];
  writeDependencies(map);
  const added = deps.filter((d) => !before.has(d)).map((d) => tasks.get(d)!.title);
  if (added.length) recordActivity(taskId, { kind: "task", text: `Blocked by ${added.map((t) => `"${t}"`).join(", ")}`, tone: "muted" });
  return { ok: true, deps };
}

/** One dependency's state, as the card shows it. */
export function dependencyOf(dep: Task | null, depId: string, pr = dep ? prStatusForTask(dep.id) : null): TaskDependency {
  if (!dep) return { taskId: depId, title: "a deleted card", satisfied: true, detail: "deleted" };
  return { ...dependencyState(dep, pr), ref: shortCardName(dep.title, { issueUrl: dep.issueUrl, prNumber: pr?.number ?? null }) };
}

function dependencyState(dep: Task, pr: ReturnType<typeof prStatusForTask>): TaskDependency {
  if (pr?.state === "merged") return { taskId: dep.id, title: dep.title, satisfied: true, detail: `PR #${pr.number} merged` };
  if (dep.archivedAt != null || dep.column === "done") return { taskId: dep.id, title: dep.title, satisfied: true, detail: "done" };
  const detail = pr ? prBadge(pr).text : dep.column;
  return { taskId: dep.id, title: dep.title, satisfied: false, detail };
}

/** A card's dependencies, for decorating it in API responses. */
export function blockedByFor(taskId: string, map: DepMap = readDependencies()): TaskDependency[] | undefined {
  const ids = map[taskId];
  if (!ids?.length) return undefined;
  return ids.map((id) => dependencyOf(tasks.get(id), id));
}

/** Cards still waiting on `taskId` (dependencies cleared once acted on, so
 *  every entry is a live wait). */
export function blockingFor(taskId: string, map: DepMap = readDependencies()): { taskId: string; title: string }[] | undefined {
  const out = Object.entries(map)
    .filter(([, ids]) => ids.includes(taskId))
    .flatMap(([id]) => {
      const t = tasks.get(id);
      return t && t.archivedAt == null ? [{ taskId: id, title: t.title }] : [];
    });
  return out.length ? out : undefined;
}

export function unblockedMessage(deps: TaskDependency[]): string {
  const list = deps.map((d) => `"${d.title}" (${d.detail})`).join(", ");
  return (
    `What this card was waiting on has landed: ${list}. ` +
    "Bring the base branch into this branch (commit your work, then `git merge --no-edit origin/<base>` — no rebase), " +
    "re-run the verification, and carry on with your step."
  );
}

/** What to do with a card whose dependencies are all satisfied. Pure. */
export function unblockAction(task: Task): "start" | "message-step" | "message-task" | "none" {
  const run = task.pipelineRun;
  if (run) {
    if (run.status === "blocked") return "message-step";
    if (run.history.length === 0 && (task.column === "ready" || task.column === "backlog")) return "start";
    return "none";
  }
  if (!task.runId && (task.column === "ready" || task.column === "backlog")) return "start";
  if (task.runId && (task.column === "blocked" || task.column === "review")) return "message-task";
  return "none";
}

async function act(task: Task, deps: TaskDependency[]): Promise<string> {
  const action = unblockAction(task);
  if (action === "start") {
    const r = await startTask(task.id);
    return "error" in r ? `couldn't start it: ${r.error}` : "started it";
  }
  if (action === "message-step") {
    const block = task.pipelineRun!.blocked.find((b) => b.taskId);
    const runId = block?.taskId ? (tasks.get(block.taskId)?.runId ?? runs.listForTask(block.taskId)[0]?.id ?? null) : null;
    if (!runId) return "nothing to resume";
    const sent = await sendInput(runId, unblockedMessage(deps));
    return sent.delivered ? "told the blocked step to carry on" : `couldn't reach the step: ${sent.reason ?? "?"}`;
  }
  if (action === "message-task") {
    const sent = await sendInput(task.runId!, unblockedMessage(deps));
    return sent.delivered ? "told it to carry on" : `couldn't reach it: ${sent.reason ?? "?"}`;
  }
  return "nothing to do — it's already moving";
}

/** One pass: act on every card whose dependencies are now all satisfied,
 *  then clear them. Exported for tests. */
export async function dependencyTick(): Promise<string[]> {
  const map = readDependencies();
  const acted: string[] = [];
  let changed = false;
  for (const [taskId, ids] of Object.entries(map)) {
    const task = tasks.get(taskId);
    if (!task || task.archivedAt != null) {
      delete map[taskId];
      changed = true;
      continue;
    }
    const deps = ids.map((id) => dependencyOf(tasks.get(id), id));
    if (!deps.every((d) => d.satisfied)) continue;
    delete map[taskId];
    writeDependencies(map);
    const what = await act(task, deps).catch((e: Error) => `failed: ${e.message}`);
    recordActivity(taskId, {
      kind: "task",
      text: `Unblocked — ${deps.map((d) => `"${d.title}" ${d.detail}`).join(", ")}; ${what}`,
      tone: "success",
    });
    acted.push(taskId);
  }
  if (changed) writeDependencies(map);
  return acted;
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startDependencyLoop(): void {
  if (loop) return;
  loop = setInterval(() => void dependencyTick().catch(() => undefined), TICK_MS);
  loop.unref?.();
}
