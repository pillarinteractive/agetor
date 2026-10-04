/**
 * When a running card's agents last produced anything — the newest run event
 * (transcript line, tool call, status chunk) of the running task, or for a
 * running pipeline the *quietest* active step (the one most likely stuck).
 * Harness-agnostic, unlike the Claude-only turn-stall watchdog. Decorated onto
 * running cards by `/tasks` and read by the board digest; drives the card's
 * "quiet for …" warning (`cardStatus`).
 */
import type { Task } from "../shared/types.ts";
import { db, tasks } from "./db.ts";

const lastEventStmt = () =>
  db.query<{ ts: number }, [string]>(`SELECT ts FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 1`);
const runStartStmt = () => db.query<{ started_at: number }, [string]>(`SELECT started_at FROM runs WHERE id = ?`);

function lastForRun(runId: string): number | null {
  return lastEventStmt().get(runId)?.ts ?? runStartStmt().get(runId)?.started_at ?? null;
}

export function lastActivityAt(task: Task, byId?: (id: string) => Task | null | undefined): number | null {
  const get = byId ?? ((id: string) => tasks.get(id));
  const run = task.pipelineRun;
  if (run) {
    if (run.status !== "running") return null;
    let quietest: number | null = null;
    for (const a of run.active) {
      const runId = get(a.taskId)?.runId;
      const at = runId ? lastForRun(runId) : null;
      if (at != null && (quietest == null || at < quietest)) quietest = at;
    }
    return quietest;
  }
  if (task.column !== "running" || !task.runId) return null;
  return lastForRun(task.runId);
}
