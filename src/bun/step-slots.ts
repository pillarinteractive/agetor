/**
 * Step slots: how many pipeline steps may run at once on this Mac, and how
 * many of the heavy ones (full verification — Finish, Open PR, Fix CI…).
 * Five builds plus their test suites at once starve each other and time out;
 * a step over the limit waits (a `slot-wait` block, which reads as running,
 * not blocked) and starts by itself, oldest first, when a slot frees.
 *
 * Configured with the `step_slots` preference:
 *   {"max": 3, "heavy": {"max": 1, "steps": ["Finish", "Open PR", …]}}
 * A plain (non-pipeline) task the user starts is never held, but it does
 * count toward `max`.
 */
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { isQuotaPaused } from "./usage-limit.ts";

export const STEP_SLOTS_PREF = "step_slots";

export interface StepSlots {
  max: number;
  heavy: { max: number; steps: string[] };
}

export const DEFAULT_STEP_SLOTS: StepSlots = {
  max: 3,
  heavy: { max: 1, steps: ["Finish", "Open PR", "Fix CI", "Resolve merge conflicts", "Run VM tests", "Run E2E"] },
};

export function parseStepSlots(raw: string | null | undefined): StepSlots {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const n = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) && x >= 1 ? Math.floor(x) : d);
  const h = o.heavy && typeof o.heavy === "object" ? (o.heavy as Record<string, unknown>) : {};
  const steps = Array.isArray(h.steps) ? h.steps.filter((s): s is string => typeof s === "string" && !!s.trim()) : DEFAULT_STEP_SLOTS.heavy.steps;
  return { max: n(o.max, DEFAULT_STEP_SLOTS.max), heavy: { max: n(h.max, DEFAULT_STEP_SLOTS.heavy.max), steps } };
}

/** A heavy step: its name starts with one of the configured names
 *  (case-insensitive) — follow-up names like "Fix CI" or "Resolve merge
 *  conflicts with develop" match too. */
export function isHeavyStep(name: string, slots: StepSlots): boolean {
  const n = name.trim().toLowerCase();
  return slots.heavy.steps.some((s) => n.startsWith(s.trim().toLowerCase()));
}

export interface SlotUse {
  total: number;
  heavy: number;
}

/** Whether a step called `name` may start now, given what's running. */
export function slotDecision(name: string, use: SlotUse, slots: StepSlots): { ok: true } | { ok: false; why: string } {
  if (use.total >= slots.max) return { ok: false, why: `waiting for a slot — ${use.total} of ${slots.max} agents busy` };
  if (isHeavyStep(name, slots) && use.heavy >= slots.heavy.max) {
    return { ok: false, why: `waiting for a verification slot — ${use.heavy} of ${slots.heavy.max} in use` };
  }
  return { ok: true };
}

export function currentSlots(): StepSlots {
  return parseStepSlots(preferences.get(STEP_SLOTS_PREF));
}

/** What's running now: every in-flight pipeline step (heavy ones counted
 *  too) plus every running plain task. A step is in flight from launch —
 *  an active execution with no outcome yet and no block — or while its
 *  process is live, so two launches a moment apart can't both take the
 *  last slot while the first is still spawning. A live step that's only
 *  waiting — on the user (a question/permission card) or on claude's
 *  usage-limit pause (`isQuotaPaused`) — isn't working the machine, so it
 *  doesn't count. */
export function slotUse(
  isLive: (taskId: string) => boolean,
  slots: StepSlots = currentSlots(),
  list: Task[] = tasks.list(),
  quotaPaused: (taskId: string) => boolean = isQuotaPaused,
): SlotUse {
  let total = 0;
  let heavy = 0;
  const byId = new Map(list.map((t) => [t.id, t]));
  const waiting = (id: string) => (byId.get(id)?.pendingInteractionCount ?? 0) > 0 || quotaPaused(id);
  for (const t of list) {
    if (t.archivedAt != null) continue;
    const run = t.pipelineRun;
    if (run) {
      for (const a of run.active) {
        const settled = run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq)?.outcome != null;
        const blocked = run.blocked.some((b) => b.taskId === a.taskId);
        if (!isLive(a.taskId) && (settled || blocked)) continue;
        if (waiting(a.taskId)) continue;
        total++;
        const name = run.snapshot?.graph.steps.find((s) => s.id === a.stepId)?.name ?? "";
        if (isHeavyStep(name, slots)) heavy++;
      }
    } else if (!t.pipelineParentId && t.column === "running" && !waiting(t.id)) {
      total++;
    }
  }
  return { total, heavy };
}
