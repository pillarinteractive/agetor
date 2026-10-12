/**
 * What the board as a whole is doing, and what every card that is not moving
 * is waiting on — for the system strip above the columns and its "waiting on"
 * panel. Cards already say this one at a time on their status lines; the same
 * cause on fifteen cards reads as fifteen problems until it is grouped.
 *
 * Pure over the board's own data (cards, their PR status, preferences): no
 * request of its own, so it costs nothing to keep current.
 */
import type { PipelineBlock, Task, TaskPrStatus } from "../../shared/types.ts";

/** Why a card is not moving, most actionable first (the panel's order). */
export type WaitCause =
  | "you" // a question or decision only the owner can give
  | "failed" // a step crashed or could not start
  | "no-handoff" // a step ended without saying what happens next
  | "step-cap" // the run reached its step limit
  | "limit" // a provider usage limit
  | "base" // the base branch fails the same checks
  | "blocked" // the step says it is blocked on something else
  | "slot" // queued for an agent or CI place
  | "ci" // waiting for GitHub CI
  | "command"; // waiting for a background command on this machine

export interface WaitingCard {
  task: Task;
  /** The step the wait belongs to, when one does. */
  step: string | null;
  /** The card's own words for it, first line only. */
  detail: string;
}

export interface WaitGroup {
  cause: WaitCause;
  title: string;
  /** What clears it, in one line. */
  clears: string;
  /** The one thing to do for the whole group, when there is one. */
  action: "retry" | "open" | null;
  cards: WaitingCard[];
}

const GROUPS: Record<WaitCause, Pick<WaitGroup, "title" | "clears" | "action">> = {
  you: { title: "Needs your decision", clears: "Answer on the card", action: "open" },
  failed: { title: "A step failed", clears: "Retry starts the step again", action: "retry" },
  "no-handoff": { title: "Ended without a handoff", clears: "Retry asks the step to finish", action: "retry" },
  "step-cap": { title: "Reached the step limit", clears: "Retry lets the run continue", action: "retry" },
  limit: { title: "At a usage limit", clears: "Resumes at the reset or on the backup", action: null },
  base: { title: "Base branch is failing", clears: "Clears when the base branch is fixed", action: null },
  blocked: { title: "Step reports it is blocked", clears: "Open the card to see what it waits on", action: "open" },
  slot: { title: "Queued for a place", clears: "Starts by itself when one frees", action: null },
  ci: { title: "Waiting on CI", clears: "Wakes when the checks finish", action: null },
  command: { title: "Waiting on a local command", clears: "Wakes when the command exits", action: null },
};
const ORDER = Object.keys(GROUPS) as WaitCause[];

const firstLine = (text: string) => text.split("\n")[0]!.replace(/\s+/g, " ").trim();
/** `step "Review" reported it is blocked: - Waiting for …` → `Waiting for …`. */
const said = (message: string) => firstLine(message.replace(/^step "[^"]*" reported it is blocked:\s*/i, "")).replace(/^[-–]\s*/, "");

function causeOf(block: PipelineBlock, task: Task): WaitCause {
  switch (block.kind) {
    case "slot-wait":
      return "slot";
    case "await":
      return /waiting on "ci[^"]*"|ci-wait|GitHub CI/i.test(block.message) ? "ci" : "command";
    case "handoff-missing":
    case "handoff-invalid":
      return "no-handoff";
    case "step-cap":
      return "step-cap";
    case "step-failed":
      return /usage limit|out of (usage )?credits|quota exceeded/i.test(block.message) ? "limit" : "failed";
    case "step-blocked":
      if ((task.pendingInteractionCount ?? 0) > 0 || /\(open questions:/i.test(block.message) || /owner decision|only the (owner|user) can/i.test(block.message)) return "you";
      if ((/\b(develop|base branch)\b/i.test(block.message) && /\b(fix|fails?|failing|failure|lands?|broken)\b/i.test(block.message)) || /same checks fail/i.test(block.message)) return "base";
      if (/waiting (for|on) (the )?(ci|required|github ci|ci'?s)/i.test(block.message)) return "ci";
      return "blocked";
    default:
      return "blocked";
  }
}

/** The cards that are not moving, grouped by what they wait on. A card with
 *  several blocks counts once, under its most actionable cause. */
export function waitGroups(tasks: Task[], prs: ReadonlyMap<string, TaskPrStatus>): WaitGroup[] {
  const byCause = new Map<WaitCause, WaitingCard[]>();
  const add = (cause: WaitCause, card: WaitingCard) => byCause.set(cause, [...(byCause.get(cause) ?? []), card]);
  for (const task of tasks) {
    if (task.archivedAt != null || task.pipelineParentId) continue;
    if (task.column !== "running" && task.column !== "blocked" && task.column !== "merge") continue;
    const run = task.pipelineRun;
    const names = new Map((run?.snapshot?.graph.steps ?? []).map((s) => [s.id, s.name]));
    const blocks = run?.blocked ?? [];
    if (blocks.length > 0) {
      const ranked = blocks
        .map((block) => ({ block, cause: causeOf(block, task) }))
        .sort((a, b) => ORDER.indexOf(a.cause) - ORDER.indexOf(b.cause))[0]!;
      const { block, cause } = ranked;
      const detail = block.kind === "step-blocked" ? said(block.message) : firstLine(block.message);
      add(cause, { task, step: block.stepId ? (names.get(block.stepId) ?? null) : null, detail });
      continue;
    }
    // No block of its own: a PR that inherits the base branch's failures.
    const pr = prs.get(task.id);
    if (pr?.state === "open" && pr.checks === "failure" && pr.failingChecks.length > 0 && pr.failingChecks.every((c) => c.alsoOnBase)) {
      add("base", { task, step: null, detail: `${pr.baseRef ?? "The base"} fails ${pr.failingChecks.map((c) => c.name).slice(0, 2).join(", ")}` });
    } else if (task.column === "merge" && pr?.state === "open" && pr.checks === "pending") {
      add("ci", { task, step: null, detail: `PR #${pr.number}: checks running` });
    }
  }
  return ORDER.filter((cause) => byCause.has(cause)).map((cause) => ({ cause, ...GROUPS[cause], cards: byCause.get(cause)! }));
}

/** Why one card is not moving, in the card's own view: the cause, what clears
 *  it, and the step's own words in full. Null when the card is moving. */
export function whyStopped(
  task: Task,
  pr: TaskPrStatus | null = null,
): (Pick<WaitGroup, "cause" | "title" | "clears" | "action"> & { step: string | null; lines: string[] }) | null {
  const group = waitGroups([task], pr ? new Map([[task.id, pr]]) : new Map())[0];
  if (!group) return null;
  const card = group.cards[0]!;
  const names = new Map((task.pipelineRun?.snapshot?.graph.steps ?? []).map((st) => [st.id, st.name]));
  const block = (task.pipelineRun?.blocked ?? []).find((b) => (b.stepId ? (names.get(b.stepId) ?? null) : null) === card.step && firstLine(b.message).length > 0);
  const text = block ? block.message.replace(/^step "[^"]*" reported it is blocked:\s*/i, "") : card.detail;
  const lines = text
    .split(/\n|(?<=\.)\s+(?=- )/)
    .map((l) => l.replace(/^[-–]\s*/, "").trim())
    .filter(Boolean);
  return { cause: group.cause, title: group.title, clears: group.clears, action: group.action, step: card.step, lines };
}

/** Red or yellow: a cause that stays until someone acts, or one that clears by itself. */
export type WaitLevel = "blocked" | "waiting";
const SELF_CLEARING: ReadonlySet<WaitCause> = new Set(["limit", "slot", "ci", "command"]);
export const levelOf = (cause: WaitCause): WaitLevel => (SELF_CLEARING.has(cause) ? "waiting" : "blocked");

/** The board in one light: red when any card is blocked, yellow when cards are
 *  only waiting on something that clears by itself, green otherwise. */
export function boardSignal(groups: WaitGroup[]): { level: "good" | WaitLevel; blocked: number; waiting: number } {
  let blocked = 0;
  let waiting = 0;
  for (const g of groups) {
    if (levelOf(g.cause) === "blocked") blocked += g.cards.length;
    else waiting += g.cards.length;
  }
  return { level: blocked > 0 ? "blocked" : waiting > 0 ? "waiting" : "good", blocked, waiting };
}

export interface BoardHealth {
  /** Steps with an agent working right now. */
  working: number;
  /** The most agents allowed at once (`step_slots.max`). */
  agentCap: number;
  /** Cards parked on GitHub CI, and the most allowed before nothing new starts. */
  onCi: number;
  ciCap: number;
  /** Cards queued for a place, and the reason the queue gives most often. */
  queued: number;
  queuedWhy: string | null;
  /** The base branch fails checks that open PRs inherit. */
  baseFailing: string | null;
  /** A usage limit in effect and the backup it routes to, e.g. "Claude Code → Claude Code via DeepSeek until 11:50 PM". */
  fallback: string | null;
  /** Cards that are waiting on the owner. */
  needsYou: number;
}

function parse<T>(raw: string | null | undefined, fallback: T): T {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The strip's numbers. `harnessLabel` turns a harness id into its name. */
export function boardHealth(
  tasks: Task[],
  prs: ReadonlyMap<string, TaskPrStatus>,
  preferences: Readonly<Record<string, string>>,
  now: number,
  harnessLabel: (id: string) => string = (id) => id,
): BoardHealth {
  const slots = parse<{ max?: number; ci?: { max?: number } }>(preferences.step_slots, {});
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let working = 0;
  for (const task of tasks) {
    if (task.archivedAt != null) continue;
    if (task.pipelineParentId) continue;
    const run = task.pipelineRun;
    if (run) working += run.active.filter((a) => byId.get(a.taskId)?.column === "running").length;
    else if (task.column === "running") working += 1;
  }
  const groups = waitGroups(tasks, prs);
  const count = (cause: WaitCause) => groups.find((g) => g.cause === cause)?.cards.length ?? 0;
  const queue = groups.find((g) => g.cause === "slot")?.cards ?? [];
  const reasons = new Map<string, number>();
  for (const card of queue) {
    const why = card.detail.split("—").slice(1).join("—").trim();
    if (why) reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const queuedWhy = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const base = groups.find((g) => g.cause === "base")?.cards[0];
  const fallbackConfig = parse<{ enabled?: boolean; harness?: string }>(preferences.quota_fallback, {});
  const until = parse<Record<string, number>>(preferences.quota_fallback_until, {});
  const limited = Object.entries(until).filter(([, at]) => typeof at === "number" && at > now).sort((a, b) => b[1] - a[1])[0];
  let fallback: string | null = null;
  if (limited) {
    const when = new Date(limited[1]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const to = fallbackConfig.enabled && fallbackConfig.harness && fallbackConfig.harness !== limited[0] ? ` → ${harnessLabel(fallbackConfig.harness)}` : "";
    fallback = `${harnessLabel(limited[0])} at its limit${to} until ${when}`;
  }
  return {
    working,
    agentCap: typeof slots.max === "number" ? slots.max : 3,
    onCi: count("ci"),
    ciCap: typeof slots.ci?.max === "number" ? slots.ci.max : 6,
    queued: queue.length,
    queuedWhy,
    baseFailing: base ? base.detail : null,
    fallback,
    needsYou: count("you"),
  };
}
