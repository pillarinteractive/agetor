/**
 * Roadmap mode for Autopilot (src/bun/autopilot.ts): a tracker issue whose
 * body lists every task as a numbered step with its predecessor steps. This
 * file is the pure part — parse the table, derive each step's status from its
 * issue's state, pick what may start — shared by the core, the board and the
 * CLI. No I/O.
 *
 * The tracker body has a section `## Numbered completion order` holding one
 * markdown table:
 *
 *   | Step | Task and outcome | Milestone | Predecessor steps |
 *   | --- | --- | --- | --- |
 *   | 1 | #12 [Human] Supply the reference profile | H | none |
 *   | 2.1 | #14 Implement the wire contract | M01 | 1, 2 |
 *
 * Step ids are strings (`78.1` is a step between 78 and 79). Predecessors
 * name steps (`1, 2`) or the steps' issues (`#12, #14`). A step is the
 * owner's to do when its title starts `[Human]` or its milestone is `H`.
 *
 * The heading may be any that contains "completion order", and the two
 * middle columns may be named differently (`Task`, `Stage`).
 */

export const ROADMAP_SECTION = "Numbered completion order";

export interface RoadmapStep {
  step: string;
  issue: number;
  title: string;
  /** Title starts with `[Human]`, or the milestone is `H`: never given to an agent. */
  human: boolean;
  milestone: string;
  /** Step ids, as written (an id that names no step is kept and reported). */
  predecessors: string[];
}

export type RoadmapProblemKind =
  | "missing-section"
  | "missing-table"
  | "no-rows"
  | "malformed-row"
  | "duplicate-step"
  | "duplicate-issue"
  | "unknown-predecessor"
  | "cycle";

export interface RoadmapProblem {
  kind: RoadmapProblemKind;
  message: string;
  /** The step it concerns, when the row got that far. */
  step?: string;
  /** 1-based line in the tracker body. */
  line?: number;
}

export interface ParsedRoadmap {
  /** Valid rows, in step order. Empty when `error` is set. */
  steps: RoadmapStep[];
  problems: RoadmapProblem[];
  /** Steps that must never start because of a problem: step id → why. */
  held: Record<string, string>;
  /** The roadmap can't be used at all (no section, no table, no valid row). */
  error: string | null;
}

const STEP_ID = /^\d+(?:\.\d+)?$/;

/** Order by integer part, then the fractional part read as an integer
 *  (78 < 78.1 < 78.2 < 78.10 < 79). */
export function compareStepIds(a: string, b: string): number {
  const [ai, af] = a.split(".");
  const [bi, bf] = b.split(".");
  return Number(ai) - Number(bi) || (af == null ? -1 : Number(af)) - (bf == null ? -1 : Number(bf));
}

/** A table row's cells; `\|` is a literal pipe. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const isTableLine = (line: string) => line.trim().startsWith("|");
const isSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());

export function parseRoadmap(body: string): ParsedRoadmap {
  const fail = (kind: RoadmapProblemKind, message: string): ParsedRoadmap => ({ steps: [], problems: [{ kind, message }], held: {}, error: message });
  const lines = (body ?? "").split(/\r?\n/);
  const heading = lines.findIndex((l) => /^#{1,6}\s+.*\bcompletion order\b/i.test(l.trim()));
  if (heading < 0) return fail("missing-section", `the tracker has no "completion order" section`);

  // The section's first table: a header row followed by a separator row.
  let header = -1;
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) break; // next section
    if (isTableLine(lines[i]!) && i + 1 < lines.length && isSeparator(lines[i + 1]!)) {
      header = i;
      break;
    }
  }
  if (header < 0) return fail("missing-table", `the "${ROADMAP_SECTION}" section has no table`);
  const head = cells(lines[header]!).map((c) => c.toLowerCase());
  if (head.length !== 4 || !head[0]!.startsWith("step") || !head[3]!.startsWith("predecessor")) {
    return fail("missing-table", `the "${ROADMAP_SECTION}" table needs the columns Step | Task and outcome | Milestone | Predecessor steps`);
  }

  const problems: RoadmapProblem[] = [];
  const held: Record<string, string> = {};
  const hold = (step: string, why: string) => {
    held[step] ??= why;
  };
  const steps: RoadmapStep[] = [];
  const byStep = new Map<string, RoadmapStep>();
  const byIssue = new Map<number, RoadmapStep>();

  for (let i = header + 2; i < lines.length && isTableLine(lines[i]!); i++) {
    const line = i + 1;
    const row = cells(lines[i]!);
    const malformed = (why: string, step?: string) => problems.push({ kind: "malformed-row", message: `line ${line}: ${why}`, line, ...(step ? { step } : {}) });
    if (row.length !== 4) {
      malformed(`expected 4 cells, found ${row.length}`);
      continue;
    }
    const [step, task, milestone, preds] = row as [string, string, string, string];
    if (!STEP_ID.test(step)) {
      malformed(`"${step.slice(0, 40)}" is not a step id`);
      continue;
    }
    const m = task.match(/^\[?#(\d+)\]?(?:\([^)]*\))?\s+(\S.*)$/);
    if (!m) {
      malformed(`step ${step}: the task must start with its issue (#123) and a title`, step);
      continue;
    }
    if (byStep.has(step)) {
      problems.push({ kind: "duplicate-step", message: `line ${line}: step ${step} is listed twice — the later row is ignored`, step, line });
      continue;
    }
    const issue = Number(m[1]);
    const title = m[2]!.trim();
    const none = /^(none|n\/a|-|—|)$/i.test(preds);
    const s: RoadmapStep = {
      step,
      issue,
      title,
      human: /^\[human\]/i.test(title) || /^H$/i.test(milestone),
      milestone,
      predecessors: none ? [] : preds.split(",").map((p) => p.trim()).filter(Boolean),
    };
    const first = byIssue.get(issue);
    if (first) {
      problems.push({ kind: "duplicate-issue", message: `line ${line}: step ${step} names #${issue}, which step ${first.step} already uses`, step, line });
      hold(step, `names #${issue}, which step ${first.step} already uses`);
    } else {
      byIssue.set(issue, s);
    }
    byStep.set(step, s);
    steps.push(s);
  }
  if (steps.length === 0) {
    const message = `the "${ROADMAP_SECTION}" table has no valid rows`;
    return { steps: [], problems: [{ kind: "no-rows", message }, ...problems], held: {}, error: message };
  }
  steps.sort((a, b) => compareStepIds(a.step, b.step));

  // A predecessor written as an issue (`#12`) means the step for that issue.
  for (const s of steps) {
    s.predecessors = s.predecessors.map((p) => {
      const m = p.match(/^#(\d+)$/);
      return (m && byIssue.get(Number(m[1]))?.step) || p;
    });
  }

  for (const s of steps) {
    const unknown = s.predecessors.filter((p) => !byStep.has(p));
    if (unknown.length === 0) continue;
    const why = `predecessor ${unknown.join(", ")} names no step`;
    problems.push({ kind: "unknown-predecessor", message: `step ${s.step}: ${why}`, step: s.step });
    hold(s.step, why);
  }

  // Cycles: drop steps with no predecessor left and steps nothing left
  // depends on, until nothing changes. What remains lies on a cycle (or
  // between two).
  const left = new Set(steps.map((s) => s.step));
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of steps) {
      if (!left.has(s.step)) continue;
      const hasPred = s.predecessors.some((p) => left.has(p));
      const hasSucc = steps.some((o) => left.has(o.step) && o.predecessors.includes(s.step));
      if (!hasPred || !hasSucc) {
        left.delete(s.step);
        changed = true;
      }
    }
  }
  if (left.size > 0) {
    const members = steps.filter((s) => left.has(s.step)).map((s) => s.step);
    problems.push({ kind: "cycle", message: `dependency cycle among steps ${members.join(", ")}`, step: members[0] });
    for (const id of members) hold(id, "is part of a dependency cycle");
  }

  return { steps, problems, held, error: null };
}

// ── Status ────────────────────────────────────────────────────────────────

/** An issue's state as GitHub's GraphQL API reports it. */
export interface RoadmapIssueState {
  state: "OPEN" | "CLOSED";
  /** COMPLETED | NOT_PLANNED | DUPLICATE | REOPENED | null */
  stateReason: string | null;
  url?: string | null;
}

/**
 * complete — closed as completed: unlocks its successors.
 * declined — closed any other way (not planned, duplicate): a no-go. Not
 *            complete, unlocks nothing, never started.
 * ready    — open and every predecessor complete.
 * waiting  — open, some predecessor not complete (`waitingOn`).
 * held     — open but must not start: a roadmap problem, or its issue's
 *            state couldn't be read (`reason`).
 */
export type RoadmapStepStatus = "complete" | "declined" | "ready" | "waiting" | "held";

export interface RoadmapStepView extends RoadmapStep {
  status: RoadmapStepStatus;
  /** Predecessor steps that aren't complete (empty unless waiting/held). */
  waitingOn: string[];
  /** Why a held step is held. */
  reason: string | null;
  url: string | null;
}

export function roadmapStatus(parsed: ParsedRoadmap, states: ReadonlyMap<number, RoadmapIssueState>): RoadmapStepView[] {
  const closedAs = (s: RoadmapStep): "complete" | "declined" | null => {
    const st = states.get(s.issue);
    if (!st || st.state !== "CLOSED") return null;
    return st.stateReason === "COMPLETED" ? "complete" : "declined";
  };
  const done = new Set(parsed.steps.filter((s) => closedAs(s) === "complete").map((s) => s.step));
  return parsed.steps.map((s) => {
    const st = states.get(s.issue);
    const base = { ...s, url: st?.url ?? null };
    const closed = closedAs(s);
    if (closed) return { ...base, status: closed, waitingOn: [], reason: null };
    const waitingOn = s.predecessors.filter((p) => !done.has(p));
    const reason = parsed.held[s.step] ?? (st ? null : `the state of #${s.issue} couldn't be read`);
    if (reason) return { ...base, status: "held" as const, waitingOn, reason };
    return { ...base, status: waitingOn.length === 0 ? ("ready" as const) : ("waiting" as const), waitingOn, reason: null };
  });
}

/**
 * What may start now: ready agent steps, in step order, whose issue has no
 * live card (`busy`) and isn't set aside (`exclude`), up to `free` of them.
 * Ready `[Human]` steps are never started and never use a slot — they come
 * back separately.
 */
export function pickRoadmap(
  views: RoadmapStepView[],
  opts: { busy: ReadonlySet<number>; free: number; exclude?: ReadonlySet<number> },
): { start: RoadmapStepView[]; human: RoadmapStepView[] } {
  const ready = views.filter((v) => v.status === "ready").sort((a, b) => compareStepIds(a.step, b.step));
  return {
    start: ready.filter((v) => !v.human && !opts.busy.has(v.issue) && !opts.exclude?.has(v.issue)).slice(0, Math.max(0, opts.free)),
    human: ready.filter((v) => v.human),
  };
}

/** What a started card is told about its step. */
export function roadmapStepPrompt(tracker: number, step: RoadmapStep, all: RoadmapStep[]): string {
  const preds = step.predecessors
    .map((p) => all.find((s) => s.step === p))
    .filter((s): s is RoadmapStep => !!s)
    .map((s) => `${s.step} (#${s.issue})`);
  return [
    `## Roadmap step ${step.step} (${step.milestone})`,
    "",
    `This is step ${step.step} of the roadmap in tracker issue #${tracker}.`,
    preds.length ? `Its predecessor steps are finished and already merged into the base: ${preds.join(", ")}. Build on them.` : "It has no predecessor steps.",
    `Later steps start only once #${step.issue} is closed, so finish the whole definition of done in this PR and say "Fixes #${step.issue}" in its description.`,
    `If part of it can't be done here, say "Refs #${step.issue}" and list what's left: the step then stays open for the owner and nothing after it starts.`,
  ].join("\n");
}

// ── Summary (API, board, CLI) ─────────────────────────────────────────────

export interface RoadmapStepRef {
  step: string;
  issue: number;
  title: string;
  url: string | null;
}

export interface RoadmapStatus {
  /** The tracker issue. */
  issue: number;
  url: string | null;
  fetchedAt: number;
  /** Every step is in exactly one of complete / declined / inFlight / ready / waiting. */
  counts: {
    total: number;
    complete: number;
    declined: number;
    /** Open steps with a live card. */
    inFlight: number;
    /** Ready, no live card (the owner's `[Human]` steps included). */
    ready: number;
    /** Everything else: waiting on predecessors, held, or needing the user. */
    waiting: number;
  };
  /** Ready `[Human]` steps: only the owner can do them. */
  humanReady: RoadmapStepRef[];
  /** Steps Autopilot won't start again by itself. */
  needsUser: (RoadmapStepRef & { reason: string })[];
  /** The first few steps that can't start yet, and why. */
  nextWaiting: (RoadmapStepRef & { waitingOn: string[]; reason: string | null })[];
  problems: RoadmapProblem[];
  /** Why nothing is running, when nothing is. */
  idleReason: string | null;
}

const ref = (v: RoadmapStepView): RoadmapStepRef => ({ step: v.step, issue: v.issue, title: v.title, url: v.url });
const names = (xs: { step: string; issue: number }[], max = 6) =>
  xs.slice(0, max).map((x) => `${x.step} (#${x.issue})`).join(", ") + (xs.length > max ? ` and ${xs.length - max} more` : "");

export function summarizeRoadmap(input: {
  issue: number;
  url: string | null;
  parsed: ParsedRoadmap;
  views: RoadmapStepView[];
  /** Issues with a live card. */
  busy: ReadonlySet<number>;
  /** Issues Autopilot won't start again: issue → why. */
  needsUser: ReadonlyMap<number, string>;
  now: number;
  nextWaiting?: number;
}): RoadmapStatus {
  const { views, busy, needsUser } = input;
  const open = views.filter((v) => v.status !== "complete" && v.status !== "declined");
  const inFlight = open.filter((v) => busy.has(v.issue));
  const idle = open.filter((v) => !busy.has(v.issue));
  const stuck = idle.filter((v) => needsUser.has(v.issue));
  const ready = idle.filter((v) => v.status === "ready" && !needsUser.has(v.issue));
  const waiting = idle.filter((v) => v.status !== "ready" && !needsUser.has(v.issue));
  const humanReady = ready.filter((v) => v.human);
  const complete = views.filter((v) => v.status === "complete").length;
  const declined = views.filter((v) => v.status === "declined");

  let idleReason: string | null = null;
  if (open.length > 0 && inFlight.length === 0 && ready.every((v) => v.human)) {
    const parts: string[] = [];
    if (humanReady.length) parts.push(`waiting on you to do ${humanReady.length === 1 ? "human step" : "human steps"} ${names(humanReady)}`);
    if (stuck.length) parts.push(`${stuck.length === 1 ? "step" : "steps"} ${names(stuck)} ${stuck.length === 1 ? "needs" : "need"} you`);
    const heldSteps = waiting.filter((v) => v.status === "held");
    if (heldSteps.length) parts.push(`held by roadmap problems: ${names(heldSteps)}`);
    const declinedIds = new Set(declined.map((v) => v.step));
    const behindDeclined = waiting.filter((v) => v.waitingOn.some((p) => declinedIds.has(p)));
    if (behindDeclined.length) parts.push(`${names(behindDeclined)} wait on a declined step`);
    idleReason = parts.length ? `Nothing can start: ${parts.join("; ")}` : "Nothing can start: every open step waits on an unfinished predecessor";
  }

  return {
    issue: input.issue,
    url: input.url,
    fetchedAt: input.now,
    counts: { total: views.length, complete, declined: declined.length, inFlight: inFlight.length, ready: ready.length, waiting: waiting.length + stuck.length },
    humanReady: humanReady.map(ref),
    needsUser: stuck.map((v) => ({ ...ref(v), reason: needsUser.get(v.issue)! })),
    nextWaiting: waiting.slice(0, input.nextWaiting ?? 8).map((v) => ({ ...ref(v), waitingOn: v.waitingOn, reason: v.reason })),
    problems: input.parsed.problems,
    idleReason,
  };
}

/** Every step is complete or declined (and no row was dropped on the way). */
export function roadmapFinished(parsed: ParsedRoadmap, views: RoadmapStepView[]): boolean {
  if (parsed.error || views.length === 0) return false;
  if (parsed.problems.some((p) => p.kind === "malformed-row" || p.kind === "duplicate-step")) return false;
  return views.every((v) => v.status === "complete" || v.status === "declined");
}
