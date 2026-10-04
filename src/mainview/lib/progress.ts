import { createContext, useContext } from "react";
import type { ProgressCounts, TaskProgress } from "../../shared/types.ts";

/** Every card's live run progress (src/bun/progress-watch.ts), provided once
 *  by App.tsx so cards and the run view read it without prop threading. */
export const ProgressContext = createContext<TaskProgress[]>([]);

export function useTaskProgress(taskId: string): TaskProgress[] {
  return useContext(ProgressContext).filter((p) => p.taskId === taskId);
}

export function countsSummary(c: ProgressCounts | null): string {
  if (!c) return "";
  const done = c.passed + c.failed + c.skipped + c.errors;
  const head = c.total ? `${done}/${c.total}` : `${done}`;
  const bad = c.failed + c.errors;
  return bad ? `${head} · ${bad} failed` : head;
}

/** One line for the card: what the run is doing now, or how it ended. */
export function progressLine(p: TaskProgress): { text: string; tone: "info" | "success" | "danger" | "muted" } {
  const name = p.label;
  if (p.active) {
    const counts = p.counts ? countsSummary(p.counts) : "";
    const bad = p.counts ? p.counts.failed + p.counts.errors : 0;
    return { text: `${name}: ${p.phase}${counts ? ` ${counts}` : ""}`, tone: bad ? "danger" : "info" };
  }
  if (p.last?.result) {
    const counts = countsSummary(p.last.counts);
    return { text: `${name}: ${p.last.result}${counts ? ` ${counts}` : ""}`, tone: p.last.result === "passed" ? "success" : "danger" };
  }
  return { text: `${name}: idle`, tone: "muted" };
}

/** Fraction of tests done, or null when the total isn't known yet. */
export function progressFraction(c: ProgressCounts | null): number | null {
  if (!c?.total) return null;
  return Math.min(1, (c.passed + c.failed + c.skipped + c.errors) / c.total);
}

export function elapsedSince(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
