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
  | "cycle"
  /** Not from the table alone: a step's milestone column and its issue's
   *  GitHub milestone disagree (reported when a milestone limits the run). */
  | "milestone-mismatch";

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
  /** The issue's GitHub milestone; null when it has none, undefined when the
   *  reader didn't ask. */
  milestone?: { number: number; title: string } | null;
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

// ── Milestone scope ───────────────────────────────────────────────────────

/** A GitHub milestone limiting which steps Autopilot works. */
export interface RoadmapMilestone {
  number: number;
  title: string;
}

/** The code a milestone title starts with: `M01 — Inventory` → `M01`,
 *  `X07 · Apple TV` → `X07`, `H — Human decisions` → `H`. Null when the
 *  title doesn't start with one. */
export function milestoneCode(title: string): string | null {
  const m = title.trim().match(/^([A-Za-z]{1,4}\d{0,4})(?=$|[\s—–·:.\-])/);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * The steps in a milestone's scope: those whose issue is in that GitHub
 * milestone — what the user sees on GitHub, whatever the table's milestone
 * column says. Only when an issue's milestone wasn't read (its state is
 * unknown) does the table's code decide, compared with the code the
 * milestone's title starts with.
 */
export function roadmapScope(steps: RoadmapStep[], states: ReadonlyMap<number, RoadmapIssueState>, milestone: RoadmapMilestone): Set<string> {
  const code = milestoneCode(milestone.title);
  const out = new Set<string>();
  for (const s of steps) {
    const m = states.get(s.issue)?.milestone;
    if (m !== undefined ? m?.number === milestone.number : code != null && s.milestone.trim().toUpperCase() === code) out.add(s.step);
  }
  return out;
}

/** Steps whose table milestone code and GitHub milestone disagree about
 *  being in `milestone` (the GitHub milestone wins; this is only reported). */
export function scopeDrift(steps: RoadmapStep[], states: ReadonlyMap<number, RoadmapIssueState>, milestone: RoadmapMilestone): RoadmapStep[] {
  const code = milestoneCode(milestone.title);
  if (!code) return [];
  return steps.filter((s) => {
    const m = states.get(s.issue)?.milestone;
    return m !== undefined && (m?.number === milestone.number) !== (s.milestone.trim().toUpperCase() === code);
  });
}

/**
 * What stands between a set of steps and being startable: every step that
 * isn't complete among their predecessors, followed transitively.
 */
export function unfinishedAncestors(views: RoadmapStepView[], of: RoadmapStepView[]): RoadmapStepView[] {
  const byStep = new Map(views.map((v) => [v.step, v]));
  const seen = new Set<string>();
  const stack = of.flatMap((v) => v.waitingOn);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const v = byStep.get(id);
    if (v && v.status !== "complete") stack.push(...v.waitingOn);
  }
  return views.filter((v) => seen.has(v.step) && v.status !== "complete");
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

const STEP_PROMPT_HEADING = "## Roadmap step ";

/**
 * What a card is told about its step. `pending` names the predecessor steps
 * that weren't complete when this was written — for a backlog card made
 * before its step is ready; Autopilot rewrites the section when it starts
 * the card, by which time there are none.
 */
export function roadmapStepPrompt(tracker: number, step: RoadmapStep, all: RoadmapStep[], opts: { pending?: readonly string[] } = {}): string {
  const label = (s: RoadmapStep) => `${s.step} (#${s.issue})`;
  const preds = step.predecessors.map((p) => all.find((s) => s.step === p)).filter((s): s is RoadmapStep => !!s);
  const pending = preds.filter((s) => opts.pending?.includes(s.step));
  const predLine =
    preds.length === 0
      ? "It has no predecessor steps."
      : pending.length === 0
        ? `Its predecessor steps are finished and already merged into the base: ${preds.map(label).join(", ")}. Build on them.`
        : `Its predecessor steps are ${preds.map(label).join(", ")}. When this card was created, ${pending.map(label).join(", ")} ${pending.length === 1 ? "was" : "were"} not finished: before building on them, check that their issues are closed and their work is merged into the base.`;
  return [
    `${STEP_PROMPT_HEADING}${step.step} (${step.milestone})`,
    "",
    `This is step ${step.step} of the roadmap in tracker issue #${tracker}.`,
    predLine,
    `Later steps start only once #${step.issue} is closed, so finish the whole definition of done in this PR and say "Fixes #${step.issue}" in its description.`,
    `If part of it can't be done here, say "Refs #${step.issue}" and list what's left: the step then stays open for the owner and nothing after it starts.`,
  ].join("\n");
}

/** A card prompt with its roadmap step section replaced by `section`
 *  (appended when it has none). The section is always the prompt's last. */
export function withRoadmapStepPrompt(prompt: string, section: string): string {
  const at = prompt.lastIndexOf(`\n${STEP_PROMPT_HEADING}`);
  const head = (at >= 0 ? prompt.slice(0, at) : prompt).trimEnd();
  return `${head}\n\n${section}`;
}

// ── Summary (API, board, CLI) ─────────────────────────────────────────────

export interface RoadmapStepRef {
  step: string;
  issue: number;
  title: string;
  url: string | null;
}

/** What a never-started backlog card says about its step (the card's status
 *  line on the board). */
export interface RoadmapCardInfo {
  taskId: string;
  step: string;
  issue: number;
  /** The owner's step: Autopilot never starts this card. */
  human: boolean;
  line: string;
  tone: "muted" | "info" | "warning";
}

export interface RoadmapStatus {
  /** The tracker issue. */
  issue: number;
  url: string | null;
  fetchedAt: number;
  /** The milestone that limits which steps are worked; null = the whole
   *  roadmap. Everything below counts the steps in scope only. */
  scope: (RoadmapMilestone & { roadmapTotal: number }) | null;
  /** Every step in scope is in exactly one of complete / declined / inFlight
   *  / ready / waiting. `backlog` overlaps ready and waiting. */
  counts: {
    total: number;
    complete: number;
    declined: number;
    /** Open steps with a live card that has started. */
    inFlight: number;
    /** Ready, not started (the owner's `[Human]` steps included). */
    ready: number;
    /** Everything else: waiting on predecessors, held, or needing the user. */
    waiting: number;
    /** Open steps whose card sits in the backlog, never started. */
    backlog: number;
  };
  /** Ready owner steps: only the owner can do them. With a scope: the ones
   *  in it, and the ones outside it that a step in it waits on. */
  humanReady: RoadmapStepRef[];
  /** Steps Autopilot won't start again by itself. */
  needsUser: (RoadmapStepRef & { reason: string })[];
  /** With a scope: unfinished agent steps of other milestones that steps in
   *  scope wait on (directly or through other steps). This run never starts
   *  them. */
  blockedOutside: (RoadmapStepRef & { milestone: string })[];
  /** The first few steps that can't start yet, and why. */
  nextWaiting: (RoadmapStepRef & { waitingOn: string[]; reason: string | null })[];
  /** The never-started backlog cards of open steps. */
  cards: RoadmapCardInfo[];
  problems: RoadmapProblem[];
  /** Why nothing is running, when nothing is. */
  idleReason: string | null;
}

const ref = (v: RoadmapStepView): RoadmapStepRef => ({ step: v.step, issue: v.issue, title: v.title, url: v.url });
const names = (xs: { step: string; issue: number }[], max = 6) =>
  xs.slice(0, max).map((x) => `${x.step} (#${x.issue})`).join(", ") + (xs.length > max ? ` and ${xs.length - max} more` : "");

/** A never-started backlog card's status line: its step, and what it waits
 *  on. Pure. */
export function roadmapCardLine(v: RoadmapStepView, all: RoadmapStepView[]): { line: string; tone: RoadmapCardInfo["tone"] } {
  const waits = v.waitingOn.map((p) => all.find((s) => s.step === p)).filter((s): s is RoadmapStepView => !!s);
  const on = `step${waits.length === 1 ? "" : "s"} ${names(waits, 4)}`;
  const head = `Step ${v.step}`;
  if (v.status === "held") return { line: `${head} · held — ${v.reason ?? "a roadmap problem"}`, tone: "warning" };
  if (v.human) {
    return waits.length === 0
      ? { line: `${head} · yours to do — open the issue`, tone: "warning" }
      : { line: `${head} · yours to do, after ${on}`, tone: "muted" };
  }
  if (waits.length === 0) return { line: `${head} · ready — waiting for a slot`, tone: "info" };
  return { line: `${head} · waits on ${on}`, tone: "muted" };
}

export function summarizeRoadmap(input: {
  issue: number;
  url: string | null;
  parsed: ParsedRoadmap;
  /** Every step of the roadmap. */
  views: RoadmapStepView[];
  /** The milestone and its steps, when one limits the run. */
  scope?: { milestone: RoadmapMilestone; steps: ReadonlySet<string> } | null;
  /** Issues with a live card that has started. */
  busy: ReadonlySet<number>;
  /** Issues whose card is in the backlog, never started: issue → card id. */
  backlog?: ReadonlyMap<number, string>;
  /** Issues Autopilot won't start again: issue → why. */
  needsUser: ReadonlyMap<number, string>;
  now: number;
  nextWaiting?: number;
}): RoadmapStatus {
  const { busy, needsUser, scope } = input;
  const views = scope ? input.views.filter((v) => scope.steps.has(v.step)) : input.views;
  const open = views.filter((v) => v.status !== "complete" && v.status !== "declined");
  const inFlight = open.filter((v) => busy.has(v.issue));
  const idle = open.filter((v) => !busy.has(v.issue));
  const stuck = idle.filter((v) => needsUser.has(v.issue));
  const ready = idle.filter((v) => v.status === "ready" && !needsUser.has(v.issue));
  const waiting = idle.filter((v) => v.status !== "ready" && !needsUser.has(v.issue));
  const complete = views.filter((v) => v.status === "complete").length;
  const declined = views.filter((v) => v.status === "declined");
  const carded = idle.filter((v) => input.backlog?.has(v.issue));

  // What the steps in scope wait on outside it: the owner's ready steps need
  // the owner; agent steps need their own milestone to be run.
  const ancestors = scope ? unfinishedAncestors(input.views, open).filter((v) => !scope.steps.has(v.step)) : [];
  const humanReady = [...ready.filter((v) => v.human), ...ancestors.filter((v) => v.human && v.status === "ready")].sort((a, b) => compareStepIds(a.step, b.step));
  const outside = ancestors.filter((v) => !v.human && v.status !== "declined");

  let idleReason: string | null = null;
  if (open.length > 0 && inFlight.length === 0 && ready.every((v) => v.human)) {
    const parts: string[] = [];
    if (humanReady.length) parts.push(`waiting on you to do ${humanReady.length === 1 ? "human step" : "human steps"} ${names(humanReady)}`);
    if (stuck.length) parts.push(`${stuck.length === 1 ? "step" : "steps"} ${names(stuck)} ${stuck.length === 1 ? "needs" : "need"} you`);
    if (outside.length) {
      const codes = [...new Set(outside.map((v) => v.milestone).filter(Boolean))];
      parts.push(
        `${outside.length === 1 ? "step" : "steps"} ${names(outside)} of ${codes.length === 1 ? `milestone ${codes[0]}` : `other milestones (${codes.join(", ")})`} must finish first — run ${codes.length === 1 ? "that milestone" : "those milestones"}`,
      );
    }
    const heldSteps = waiting.filter((v) => v.status === "held");
    if (heldSteps.length) parts.push(`held by roadmap problems: ${names(heldSteps)}`);
    const declinedIds = new Set(input.views.filter((v) => v.status === "declined").map((v) => v.step));
    const behindDeclined = waiting.filter((v) => v.waitingOn.some((p) => declinedIds.has(p)));
    if (behindDeclined.length) parts.push(`${names(behindDeclined)} wait on a declined step`);
    idleReason = parts.length ? `Nothing can start: ${parts.join("; ")}` : "Nothing can start: every open step waits on an unfinished predecessor";
  }

  return {
    issue: input.issue,
    url: input.url,
    fetchedAt: input.now,
    scope: scope ? { number: scope.milestone.number, title: scope.milestone.title, roadmapTotal: input.views.length } : null,
    counts: { total: views.length, complete, declined: declined.length, inFlight: inFlight.length, ready: ready.length, waiting: waiting.length + stuck.length, backlog: carded.length },
    humanReady: humanReady.map(ref),
    needsUser: stuck.map((v) => ({ ...ref(v), reason: needsUser.get(v.issue)! })),
    blockedOutside: outside.map((v) => ({ ...ref(v), milestone: v.milestone })),
    nextWaiting: waiting.slice(0, input.nextWaiting ?? 8).map((v) => ({ ...ref(v), waitingOn: v.waitingOn, reason: v.reason })),
    cards: carded.map((v) => ({ taskId: input.backlog!.get(v.issue)!, step: v.step, issue: v.issue, human: v.human, ...roadmapCardLine(v, input.views) })),
    problems: input.parsed.problems,
    idleReason,
  };
}

/** Every step is complete or declined (and no row was dropped on the way).
 *  `views` are the steps in scope. */
export function roadmapFinished(parsed: ParsedRoadmap, views: RoadmapStepView[]): boolean {
  if (parsed.error || views.length === 0) return false;
  if (parsed.problems.some((p) => p.kind === "malformed-row" || p.kind === "duplicate-step")) return false;
  return views.every((v) => v.status === "complete" || v.status === "declined");
}

/** The status that belongs to the run configured now — not to another
 *  tracker's or another milestone's. */
export function currentRoadmapStatus(
  config: { roadmap: { issue: number } | null; milestone: { number: number } | null },
  status: RoadmapStatus | null | undefined,
): RoadmapStatus | null {
  if (!config.roadmap || !status || status.issue !== config.roadmap.issue) return null;
  return (status.scope?.number ?? null) === (config.milestone?.number ?? null) ? status : null;
}
