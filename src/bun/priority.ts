/**
 * Priority cards: the user marks a card to go first. Its pipeline steps take
 * a slot straight away — over the step-slot limits if need be (see
 * src/bun/step-slots.ts) — steps already queued for a slot launch at once, an
 * unblocked dependency resumes without waiting for a slot, and it moves to
 * the front of a lease's queue (the lab).
 *
 * Stored in the `priority_cards` preference as a JSON array of task ids. A
 * card stops being a priority once it's Done or archived.
 */
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";

export const PRIORITY_PREF = "priority_cards";

export function readPriority(raw: string | null | undefined = preferences.get(PRIORITY_PREF)): Set<string> {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Whether `taskId` (a card, or one of its pipeline steps) goes first.
 *  Reads only the card's id, parent, archived state and column: the board
 *  poll asks this for every row, and two full reads a row took 5 s a poll
 *  on the Pillar board (2026-10-14). */
export function isPriority(taskId: string, set: ReadonlySet<string> = readPriority()): boolean {
  if (set.size === 0) return false;
  const t = tasks.brief(taskId);
  const card = t?.pipelineParentId ? tasks.brief(t.pipelineParentId) : t;
  if (!card || !set.has(card.id)) return false;
  return card.archivedAt == null && card.column !== "done";
}

export function setPriority(taskId: string, on: boolean): { ok: true; priority: boolean } | { error: string } {
  const t = tasks.get(taskId);
  if (!t || t.pipelineParentId) return { error: "task not found" };
  const set = readPriority();
  // Drop cards that have finished while we're here.
  for (const id of [...set]) {
    const c = tasks.get(id);
    if (!c || c.archivedAt != null || c.column === "done") set.delete(id);
  }
  const was = set.has(taskId);
  if (on) set.add(taskId);
  else set.delete(taskId);
  preferences.set(PRIORITY_PREF, JSON.stringify([...set]));
  if (was !== on) {
    recordActivity(taskId, {
      kind: "task",
      text: on ? "Marked priority — takes a slot straight away and goes first for the lab" : "No longer priority",
      tone: on ? "info" : "muted",
    });
  }
  return { ok: true, priority: on };
}

/** Put priority entries first, keeping the existing order otherwise. */
export function priorityFirst<T>(list: T[], idOf: (x: T) => string, set: ReadonlySet<string> = readPriority()): T[] {
  const first = list.filter((x) => isPriority(idOf(x), set));
  return first.length ? [...first, ...list.filter((x) => !first.includes(x))] : list;
}
