/**
 * A card's activity timeline: what happened and when, in plain words. Pipeline
 * steps (started, handed off, blocked, failed) are derived from the run's own
 * history; events that live nowhere else — the PR opening, CI turning red or
 * green, review comments, a merge, a lease taken or released, an automatic
 * Fix CI — are appended here as they happen (`recordActivity`), one JSONL file
 * per task under `<dataDir>/activity/`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { handoffHeadline } from "../shared/pipeline.ts";
import { dataDir } from "./db.ts";

export interface ActivityEntry {
  ts: number;
  kind: "step" | "pr" | "ci" | "review" | "lease" | "auto" | "task" | "progress";
  text: string;
  tone: "muted" | "info" | "success" | "warning" | "danger";
  url?: string;
}

const MAX_READ = 500;

function fileFor(taskId: string): string {
  return path.join(dataDir, "activity", `${taskId.replace(/[^A-Za-z0-9-]/g, "")}.jsonl`);
}

/** Append one event to a task's timeline. Never throws — the timeline is a
 *  convenience, never a reason for the watcher that noticed the event to fail. */
export function recordActivity(taskId: string, entry: Omit<ActivityEntry, "ts"> & { ts?: number }): void {
  try {
    const file = fileFor(taskId);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: entry.ts ?? Date.now(), ...entry })}\n`);
  } catch {
    // best-effort
  }
}

/** Append unless the timeline already has this exact entry — for watchers
 *  that re-derive state from scratch after a restart (the PR watcher sees
 *  every PR "open" and "merged" again) and shouldn't log it twice. */
export function recordActivityOnce(taskId: string, entry: Omit<ActivityEntry, "ts">): void {
  if (readLogged(taskId).some((e) => e.kind === entry.kind && e.text === entry.text)) return;
  recordActivity(taskId, entry);
}

function readLogged(taskId: string): ActivityEntry[] {
  const file = fileFor(taskId);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_READ)
      .flatMap((l) => {
        try {
          const e = JSON.parse(l) as ActivityEntry;
          return typeof e.ts === "number" && typeof e.text === "string" ? [e] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Entries derived from a pipeline task's run history. Exported for tests. */
export function pipelineActivity(task: Task): ActivityEntry[] {
  const run = task.pipelineRun;
  if (!run) return [];
  const name = (id: string) => run.snapshot?.graph.steps.find((s) => s.id === id)?.name ?? id;
  const out: ActivityEntry[] = [];
  for (const r of run.history) {
    out.push({ ts: r.startedAt, kind: "step", text: `${name(r.stepId)} started`, tone: "info" });
    if (r.endedAt == null) continue;
    const headline = handoffHeadline(r.handoff);
    const detail = headline ? `: ${headline}` : "";
    if (r.handoff?.status === "blocked") {
      out.push({ ts: r.endedAt, kind: "step", text: `${name(r.stepId)} blocked${detail}`, tone: "danger" });
    } else if (r.outcome === "failed") {
      out.push({ ts: r.endedAt, kind: "step", text: `${name(r.stepId)} failed`, tone: "danger" });
    } else if (r.outcome === "cancelled") {
      out.push({ ts: r.endedAt, kind: "step", text: `${name(r.stepId)} stopped`, tone: "muted" });
    } else {
      const next = r.nextStepIds.length ? ` → ${r.nextStepIds.map(name).join(", ")}` : " (end of run)";
      out.push({ ts: r.endedAt, kind: "step", text: `${name(r.stepId)} finished${next}${detail}`, tone: "success" });
    }
  }
  return out;
}

/** The whole timeline, newest first. */
export function listActivity(task: Task): ActivityEntry[] {
  const created: ActivityEntry = { ts: task.createdAt, kind: "task", text: "Card created", tone: "muted" };
  return [created, ...pipelineActivity(task), ...readLogged(task.id)].sort((a, b) => b.ts - a.ts);
}
