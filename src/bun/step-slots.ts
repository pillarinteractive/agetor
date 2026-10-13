/**
 * Step slots: how many pipeline steps may run at once on this Mac, and how
 * many of the heavy ones (full verification — Finish, Open PR, Fix CI…).
 * Five builds plus their test suites at once starve each other and time out;
 * a step over the limit waits (a `slot-wait` block, which reads as running,
 * not blocked) and starts by itself, oldest first, when a slot frees.
 *
 * Configured with the `step_slots` preference:
 *   {"max": 3, "heavy": {"max": 1, "steps": ["Finish", "Open PR", …]}}
 * Plain tasks also reserve global runner capacity; heavy task titles count
 * toward the same verification cap as named pipeline steps.
 */
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { isQuotaPaused } from "./usage-limit.ts";

export const STEP_SLOTS_PREF = "step_slots";

export interface StepSlots {
  max: number;
  heavy: { max: number; steps: string[] };
  /** Cards allowed to wait on GitHub CI at once (`ci-wait`). At the cap no
   *  further step starts, except the `exempt` ones (they push nothing), so
   *  the runners are not handed more pushes than they can work through. */
  ci?: { max: number; exempt: string[] };
}

export const DEFAULT_CI_SLOTS = { max: 6, exempt: ["Understand"] };
export function ciSlots(slots: StepSlots): { max: number; exempt: string[] } {
  return slots.ci ?? DEFAULT_CI_SLOTS;
}
/** Whether the CI cap applies to a step called `name`. */
export function ciGated(name: string, slots: StepSlots): boolean {
  const n = name.trim().toLowerCase();
  return !ciSlots(slots).exempt.some((s) => n.startsWith(s.trim().toLowerCase()));
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
  const parsed: StepSlots = { max: n(o.max, DEFAULT_STEP_SLOTS.max), heavy: { max: n(h.max, DEFAULT_STEP_SLOTS.heavy.max), steps } };
  // Only when configured: an absent `ci` means the defaults (`ciSlots`).
  if (o.ci && typeof o.ci === "object" && !Array.isArray(o.ci)) {
    const c = o.ci as Record<string, unknown>;
    const exempt = Array.isArray(c.exempt) ? c.exempt.filter((s): s is string => typeof s === "string" && !!s.trim()) : DEFAULT_CI_SLOTS.exempt;
    parsed.ci = { max: n(c.max, DEFAULT_CI_SLOTS.max), exempt };
  }
  return parsed;
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
 *  doesn't count; neither does a step parked on a remote wait (CI). */
let parkedOnRemoteProbe: (card: Task) => boolean = () => false;
/** How `slotUse` learns that a card's outstanding awaits only watch remote
 *  work (CI). Set by dispatch-claims.ts, which knows the awaits; a setter
 *  because awaits.ts imports this module. */
export function setParkedOnRemoteProbe(probe: (card: Task) => boolean): void {
  parkedOnRemoteProbe = probe;
}

export function slotUse(
  isLive: (taskId: string) => boolean,
  slots: StepSlots = currentSlots(),
  list: Task[] = tasks.listLive(),
  quotaPaused: (taskId: string) => boolean = isQuotaPaused,
  parkedOnRemote: (card: Task) => boolean = parkedOnRemoteProbe,
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
        // Ended its turn to wait for CI: its session may still be open, but
        // it is working neither an agent nor this machine, so a Fix CI or
        // Finish parked on GitHub must not keep the next one from starting.
        if (run.blocked.some((b) => b.taskId === a.taskId && b.kind === "await") && parkedOnRemote(t)) continue;
        if (waiting(a.taskId)) continue;
        total++;
        const name = run.snapshot?.graph.steps.find((s) => s.id === a.stepId)?.name ?? "";
        if (isHeavyStep(name, slots)) heavy++;
      }
    } else if (!t.pipelineParentId && t.column === "running" && !waiting(t.id)) {
      total++;
      if (isHeavyStep(t.title ?? '', slots)) heavy++;
    }
  }
  return { total, heavy };
}
