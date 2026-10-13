/**
 * Finding a run's position — the pure half of Stage 3
 * (docs/plans/check-gated-pipeline.md §6 and §7).
 *
 * A restart used to empty the run's history and launch the start step,
 * although the worktree and its commits were still there. With gates the
 * card's position can be read from evidence: {@link resolvePosition} walks
 * the steps from the start along the run's forward path and stops at the
 * first step whose gate is not satisfied NOW. Everything before it is kept;
 * the run resumes there with the handoff of the step before it.
 *
 * "Satisfied now" follows the order of trust in src/shared/checks.ts: a
 * built-in check is recomputed from the worktree, a reviewer's verdict is
 * bound to the head that is checked out, and the ledger is only believed
 * for a command check whose key (head, tree, definition) is unchanged. What
 * a step's agent said is context for the next step and proves nothing.
 *
 * The owner's two operations live here too, as data: a rewind writes `void`
 * lines to the ledger (append-only — history is never deleted), and feedback
 * is a note that the reopened steps' prompts carry while it applies.
 * src/bun/position.ts reads the worktree and the files;
 * src/bun/pipeline-runner.ts acts on the result. Nothing here touches git,
 * GitHub, a file or a clock.
 */
import { checkDefHash, reviewVerdictFinding, headApprovedFinding, type CheckKey } from "./checks.ts";
import { isFollowUpStepId, resolveStartStep } from "./pipeline.ts";
import type { CheckLedgerEntry, Handoff, PipelineGraph, PipelineStep, PipelineStepRecord, StepCheck, Task } from "./types.ts";

export const POSITION_LIMITS = {
  /** An owner's note, in characters. */
  note: 8000,
  /** Notes one step's prompt carries: the newest ones. */
  notesPerPrompt: 5,
} as const;

/** The check id of the ledger line that voids a whole step's visits (the
 *  step may have no check of its own: Understand). Not a valid check id
 *  (`CHECK_ID_RE`), so no declared check can collide with it. */
export const STEP_VOID_CHECK_ID = "(step)";

type Record_ = Pick<PipelineStepRecord, "seq" | "stepId" | "taskId" | "outcome" | "handoff" | "nextStepIds" | "endedAt">;

const finished = (r: Pick<PipelineStepRecord, "outcome" | "handoff">) =>
  (r.outcome === "succeeded" || r.outcome === "advanced-manually") && r.handoff != null;

// ---------------------------------------------------------------------------
// The path
// ---------------------------------------------------------------------------

/**
 * The run's forward path: the steps in the order a run that never goes back
 * visits them. From the start step, the next step is the one outgoing edge
 * that leads to a step not yet on the path (Review → Finish, not Review →
 * Build). Where a step has several such edges (Understand → Build, or →
 * Finish for a trivial change), or may end the run itself (`canFinish`, or
 * no outgoing edge), the path follows the one its last finished visit took;
 * with no such visit, or one that named no step ahead, the path ends there. Null when the graph is not one path with loops: no start
 * step, or a step on the way that fans out (`transition: "all"`) or joins
 * (`join: "all"`), which position resolution is not defined for.
 */
export function forwardPath(graph: PipelineGraph, history: readonly Record_[]): PipelineStep[] | null {
  const start = resolveStartStep(graph);
  if (!start) return null;
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const path: PipelineStep[] = [];
  const seen = new Set<string>();
  let at: PipelineStep | undefined = start;
  while (at) {
    if (at.transition === "all" || at.join === "all") return null;
    path.push(at);
    seen.add(at.id);
    const forward = [...new Set(graph.edges.filter((e) => e.from === at!.id && !seen.has(e.to) && !isFollowUpStepId(e.to)).map((e) => e.to))];
    let next: string | undefined;
    // A step that may end the run (Understand for a trivial change, Finish)
    // goes on only where its visit said so; so does one with several ways on.
    const mayEnd = at.canFinish === true || !graph.edges.some((e) => e.from === at!.id);
    if (forward.length === 1 && !mayEnd) {
      next = forward[0];
    } else if (forward.length > 0) {
      const last = history.filter((h) => h.stepId === at!.id && finished(h)).sort((a, b) => b.seq - a.seq)[0];
      const chosen = (last?.nextStepIds ?? []).filter((id) => forward.includes(id));
      next = chosen.length === 1 ? chosen[0] : undefined;
    }
    at = next ? byId.get(next) : undefined;
  }
  return path;
}

/** `stepId` and every step after it on the path; empty when it is not on it. */
export function stepsFrom(path: readonly PipelineStep[], stepId: string): PipelineStep[] {
  const i = path.findIndex((s) => s.id === stepId);
  return i === -1 ? [] : path.slice(i);
}

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

/** The newest visit (`seq`) of `stepId` whose evidence an owner's rewind
 *  voided: only a visit after it counts. 0 when nothing was voided. */
export function voidedThrough(ledger: readonly CheckLedgerEntry[], stepId: string): number {
  let seq = 0;
  for (const e of ledger) if (e.stepId === stepId && e.outcome === "void" && e.seq > seq) seq = e.seq;
  return seq;
}

/**
 * The ledger lines a rewind appends: for each step, one line that voids the
 * step's visits up to `seq` (the run's step count now), and one per check
 * that has a result on record, carrying that result's key — so a recorded
 * pass for the same head and tree is not reused either (`reusablePass`).
 * Nothing already in the ledger is changed.
 */
export function voidEntries(input: {
  at: number; seq: number; why: string; steps: readonly { step: Pick<PipelineStep, "id" | "name">; checks: readonly StepCheck[] }[];
  ledger: readonly CheckLedgerEntry[];
}): CheckLedgerEntry[] {
  const out: CheckLedgerEntry[] = [];
  const nothing = { head: null, tree: null, baseTip: null };
  for (const { step, checks } of input.steps) {
    const line = (checkId: string, description: string, required: boolean, key: CheckLedgerEntry["key"]): CheckLedgerEntry => ({
      at: input.at, stepId: step.id, stepName: step.name, seq: input.seq, turn: 1, checkId, description, required,
      outcome: "void", satisfied: false, key, exitCode: null, detail: input.why, outputTail: "", outputPath: null,
    });
    out.push(line(STEP_VOID_CHECK_ID, `Every visit of ${step.name} up to step ${input.seq} of this run.`, true, { ...nothing, def: "" }));
    const declared = new Map(checks.map((c) => [c.id, c]));
    const newest = new Map<string, CheckLedgerEntry>();
    for (const e of input.ledger) if (e.stepId === step.id && e.outcome !== "void" && e.checkId !== STEP_VOID_CHECK_ID) newest.set(e.checkId, e);
    for (const [checkId, e] of newest) {
      const c = declared.get(checkId);
      out.push(line(checkId, c?.description ?? e.description, c?.required ?? e.required, e.key));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The position
// ---------------------------------------------------------------------------

/** What is known about one step when the position is resolved. */
export interface StepEvidence {
  /** The checks that decide the step: its gate's, or — for Build and Review
   *  of a reviewed pipeline whose run adopted only the `publish` gate — the
   *  defaults. Empty for a step with no gate (Understand). */
  checks: readonly StepCheck[];
  /** Each built-in recomputed from the worktree now, by check id. A built-in
   *  that is missing here could not be evaluated and is not satisfied.
   *  (`review-verdict` and `head-approved` are judged here, from the run's
   *  own records, and need no entry.) */
  now: Readonly<Record<string, { satisfied: boolean; detail: string }>>;
}

export interface PositionInput {
  graph: PipelineGraph;
  /** The run's records, any order. */
  history: readonly Record_[];
  ledger: readonly CheckLedgerEntry[];
  /** HEAD and its tree as the worktree has them now. */
  key: CheckKey;
  /** By step id; a step without an entry has no checks. */
  evidence: Readonly<Record<string, StepEvidence>>;
  /** The step Agetor publishes (Finish under the `publish` gate), with what
   *  it published and whether the pull request's required check passed for
   *  HEAD when read now; null when no step is run by Agetor. */
  publish?: { stepId: string; head: string | null; approvedHead: string | null; carried: number; requiredPassed: boolean } | null;
  /** What the start step worked from. `goalUnchanged`: the card's goal is
   *  the one its last finished visit was given. `issueChangedAt`: when the
   *  card's issue contract was last seen to change, or null. */
  inputs: { goalUnchanged: boolean; issueChangedAt: number | null };
}

export interface SatisfiedStep {
  stepId: string;
  /** The visit that satisfies it. */
  seq: number;
  why: string;
}

export type Position =
  /** Resume here: the first step whose gate is not satisfied. `arrivals` is
   *  what its launch is handed — the visit that sends the work to it. */
  | { kind: "step"; stepId: string; why: string; arrivals: { stepId: string; seq: number; handoff: Handoff }[]; satisfied: SatisfiedStep[]; path: string[] }
  /** Every step on the path is satisfied: there is nothing to resume. */
  | { kind: "complete"; satisfied: SatisfiedStep[]; path: string[] }
  /** Not one path with loops: resolution is not defined for this graph. */
  | { kind: "unsupported"; why: string };

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "unknown");

/** The newest pass of a command check for exactly this head, tree and
 *  definition that nothing recorded afterwards takes back (a later fail,
 *  waiver or void of the same check for the same key). The base tip is not
 *  part of it: a moved base voids `merges-with-base` and CI freshness, which
 *  are recomputed, not what a command saw in the tree. */
function standingPass(check: StepCheck, stepId: string, key: CheckKey, ledger: readonly CheckLedgerEntry[]): CheckLedgerEntry | null {
  if (!key.head || !key.tree) return null;
  const def = checkDefHash(check);
  for (let i = ledger.length - 1; i >= 0; i--) {
    const e = ledger[i]!;
    if (e.stepId !== stepId || e.checkId !== check.id) continue;
    if (e.key.def !== def || e.key.head !== key.head || e.key.tree !== key.tree) continue;
    if (e.outcome === "skip" && e.satisfied) continue;
    return e.outcome === "pass" ? e : null;
  }
  return null;
}

/**
 * Where a run stands. Walks {@link forwardPath} from the start; a step is
 * satisfied when all of these hold, and the first one that is not is the
 * position:
 *
 * 1. It has a finished visit (succeeded, or advanced by the owner) with a
 *    handoff, later than the visit that satisfied the step before it and
 *    later than anything a rewind voided.
 * 2. Every required check of its gate holds now: a built-in recomputed from
 *    the worktree (`evidence.now`), `review-verdict` and `head-approved`
 *    recomputed from the run's records against HEAD, a command check by a
 *    standing ledger pass for HEAD's commit, tree and the check's definition.
 * 3. The start step, which has no gate: the card's goal is the one that
 *    visit was given, and its issue contract has not changed since the
 *    visit ended.
 * 4. The step Agetor publishes: what it published is HEAD and the pull
 *    request's required check passed for it.
 *
 * A satisfied step whose visit sent the work BACK (Review, "changes
 * requested" for this head) makes the step it named the position, with that
 * visit as the arrival.
 *
 * So a new commit voids Review and everything after it (the verdict names
 * another head); a changed check definition voids that check; a rewind voids
 * what it names; a moved base voids only what is recomputed against it; and
 * changed instruction text voids nothing — text is not evidence.
 */
export function resolvePosition(input: PositionInput): Position {
  const path = forwardPath(input.graph, input.history);
  if (!path) return { kind: "unsupported", why: "the pipeline is not one path with loops (it has no start step, or a step that fans out or joins)" };
  const ids = path.map((s) => s.id);
  const satisfied: SatisfiedStep[] = [];
  const sorted = [...input.history].sort((a, b) => a.seq - b.seq);
  let prev: { step: PipelineStep; rec: Record_ } | null = null;

  for (let i = 0; i < path.length; i++) {
    const step = path[i]!;
    const here = (why: string): Position => ({
      kind: "step", stepId: step.id, why, satisfied, path: ids,
      arrivals: prev ? [{ stepId: prev.step.id, seq: prev.rec.seq, handoff: prev.rec.handoff! }] : [],
    });
    const voided = voidedThrough(input.ledger, step.id);
    const after = Math.max(prev?.rec.seq ?? 0, voided);
    const rec = sorted.filter((h) => h.stepId === step.id && finished(h) && h.seq > after).at(-1);
    if (!rec) {
      const any = sorted.some((h) => h.stepId === step.id && finished(h));
      if (!any) return here(`${step.name} has not finished in this run`);
      if (voided > 0 && !sorted.some((h) => h.stepId === step.id && finished(h) && h.seq > voided)) return here(`${step.name} was rewound: its earlier visits no longer count`);
      return here(`${step.name} has not run since ${prev!.step.name} last finished`);
    }

    if (i === 0) {
      if (!input.inputs.goalUnchanged) return here(`the card's goal changed since ${step.name} read it`);
      if (input.inputs.issueChangedAt != null && input.inputs.issueChangedAt > (rec.endedAt ?? 0)) {
        return here(`the card's issue changed after ${step.name} finished`);
      }
    }

    const ev = input.evidence[step.id];
    // The head a verdict has to name: HEAD, or — when Agetor merged the base
    // into the approved head with the change's own diff unchanged — that head.
    const p = input.publish;
    const verdictHead = p && p.carried > 0 && p.approvedHead && p.head === input.key.head ? p.approvedHead : input.key.head;
    for (const check of ev?.checks ?? []) {
      if (!check.required) continue;
      let found: { satisfied: boolean; detail: string };
      if (check.run.kind === "command") {
        found = standingPass(check, step.id, input.key, input.ledger)
          ? { satisfied: true, detail: "passed for this head" }
          : { satisfied: false, detail: `has no recorded pass for HEAD ${short(input.key.head)} with its present definition` };
      } else if (check.run.name === "review-verdict") {
        found = reviewVerdictFinding(rec.handoff, verdictHead);
      } else if (check.run.name === "head-approved") {
        const review = sorted.filter((h) => finished(h) && h.handoff?.reviewApproval).at(-1);
        found = headApprovedFinding(review?.handoff ?? null, verdictHead);
      } else {
        found = ev!.now[check.id] ?? { satisfied: false, detail: "could not be evaluated now" };
      }
      if (!found.satisfied) return here(`${step.name}'s check \`${check.id}\` does not hold now: ${found.detail}`);
    }

    // Where the visit sent the work: on along the path, or back.
    const next = path[i + 1];
    const back = rec.nextStepIds.find((id) => ids.indexOf(id) !== -1 && ids.indexOf(id) <= i);
    if (back !== undefined && !(next && rec.nextStepIds.includes(next.id))) {
      const target = path[ids.indexOf(back)]!;
      return {
        kind: "step", stepId: target.id, why: `${step.name} sent the work back to ${target.name} for this head, and ${target.name} has not run since`,
        arrivals: [{ stepId: step.id, seq: rec.seq, handoff: rec.handoff! }], satisfied: satisfied.filter((s) => ids.indexOf(s.stepId) < ids.indexOf(back)), path: ids,
      };
    }

    if (p && p.stepId === step.id) {
      if (!p.head || !input.key.head || p.head.toLowerCase() !== input.key.head.toLowerCase()) {
        return here(`${step.name} published ${short(p.head)}, but HEAD is ${short(input.key.head)}`);
      }
      if (!p.requiredPassed) return here(`the pull request's required check has not passed for HEAD ${short(input.key.head)}`);
    }

    satisfied.push({
      stepId: step.id, seq: rec.seq,
      why: (ev?.checks.length ?? 0) > 0 || p?.stepId === step.id ? `its checks hold for HEAD ${short(input.key.head)}` : `finished as step ${rec.seq}; its handoff is kept`,
    });

    prev = { step, rec };
  }
  return { kind: "complete", satisfied, path: ids };
}

/** One line for the card's timeline and a dialog: where the run resumes and
 *  what is kept. */
export function positionLine(position: Position, nameOf: (stepId: string) => string): string {
  if (position.kind === "unsupported") return `The position cannot be resolved: ${position.why}`;
  const kept = position.satisfied.map((s) => nameOf(s.stepId));
  const keeping = kept.length > 0 ? `${kept.join(", ")} ${kept.length === 1 ? "is" : "are"} still satisfied and ${kept.length === 1 ? "is" : "are"} not run again` : "nothing earlier can be kept";
  if (position.kind === "complete") return `Every step is still satisfied (${kept.join(", ")}): there is nothing to resume`;
  return `Resumes at ${nameOf(position.stepId)} — ${position.why}; ${keeping}`;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** A note the owner sent to a step of the run (`POST …/pipeline/feedback`). */
export interface OwnerFeedback {
  id: string;
  at: number;
  /** The step it reopens the run from. */
  fromStepId: string;
  note: string;
  /** Sent with the evidence voided, as a rewind does. */
  invalidate: boolean;
  /** The run's step count when it was sent: visits after it carry the note. */
  seq: number;
}

/** A feedback file's text (one JSON object per line, append-only). A line
 *  that is not a note is left out. */
export function parseFeedbackLog(text: string): OwnerFeedback[] {
  const out: OwnerFeedback[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || typeof o.fromStepId !== "string" || !o.fromStepId || typeof o.note !== "string" || !o.note.trim()) continue;
    if (typeof o.at !== "number" || !Number.isFinite(o.at) || !Number.isSafeInteger(o.seq) || (o.seq as number) < 0) continue;
    out.push({ id: o.id, at: o.at, fromStepId: o.fromStepId, note: o.note, invalidate: o.invalidate === true, seq: o.seq as number });
  }
  return out;
}

/** An owner's note as it is stored: trimmed, or why it is refused. */
export function validateFeedbackNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "note (the feedback's text) is required" };
  const note = raw.trim();
  if (note.length > POSITION_LIMITS.note) return { ok: false, error: `note exceeds ${POSITION_LIMITS.note} characters` };
  if (note.includes("\u0000")) return { ok: false, error: "note contains a NUL character" };
  return { ok: true, note };
}

/**
 * The notes a launch of `stepId` carries, oldest first. A note applies to
 * the step it was sent to and to every step after it on the path, until
 * that step has finished a visit launched after the note: Build reads it
 * once, then Review, then Finish — a later round between Build and Review
 * does not repeat it. At most the newest {@link POSITION_LIMITS.notesPerPrompt}.
 */
export function applicableFeedback(notes: readonly OwnerFeedback[], path: readonly Pick<PipelineStep, "id">[], history: readonly Record_[], stepId: string): OwnerFeedback[] {
  const ids = path.map((s) => s.id);
  const at = ids.indexOf(stepId);
  if (at === -1) return [];
  return notes
    .filter((n) => {
      const from = ids.indexOf(n.fromStepId);
      if (from === -1 || from > at) return false;
      return !history.some((h) => h.stepId === stepId && finished(h) && h.seq > n.seq);
    })
    .sort((a, b) => a.at - b.at)
    .slice(-POSITION_LIMITS.notesPerPrompt);
}

/** The section a reopened step's prompt gets for the owner's notes. The
 *  owner's words are instructions — unlike a handoff, which is another
 *  agent's and untrusted. */
export function renderOwnerFeedback(notes: readonly OwnerFeedback[], ctx: { stepId: string; nameOf: (stepId: string) => string }): string {
  if (notes.length === 0) return "";
  const lines = [
    "## Feedback from the owner",
    "The card's owner reopened this run and wrote the following. It is an instruction from the owner, not another step's report: act on it, " +
      "and where it disagrees with an earlier handoff or with a check's wording about scope, the owner's note is what is wanted.",
  ];
  for (const n of notes) {
    const to = n.fromStepId === ctx.stepId ? "sent to this step" : `sent to ${ctx.nameOf(n.fromStepId)}, and passed on to the steps after it`;
    lines.push("", `### Note (${to})`, "", n.note, "",
      n.invalidate
        ? "The owner voided the earlier results of this step with it: do the step again in full with the note in mind; the work in the worktree is the starting point, not a finished result."
        : n.fromStepId === ctx.stepId
          ? "This is a refinement: the earlier work passed its checks and stays. Make the change the note asks for and nothing else, then finish the step as its instructions say."
          : "This is a refinement of work that had passed: do your step for what changed because of the note, and confirm the rest still holds.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// What the routes answer
// ---------------------------------------------------------------------------

/** Where a restarted run resumed, and what it kept (`resumed` in the answer
 *  of `POST /tasks/:id/pipeline/restart`; absent for a restart from the
 *  beginning). */
export interface PipelineResume {
  stepId: string;
  stepName: string;
  why: string;
  kept: { stepId: string; stepName: string }[];
}

/** `GET /tasks/:id/pipeline/position`. */
export interface PipelinePositionView {
  /** False: the run has no check gates, and nothing here applies to it. */
  gated: boolean;
  position: Position | null;
  /** One line: where a restart would resume and what it would keep. */
  line: string | null;
  /** The run's forward path, for choosing a step to rewind or send feedback
   *  to. `reached`: the step before it has finished once, so it can be reopened. */
  steps: { id: string; name: string; reached: boolean }[];
}

/** `POST /tasks/:id/pipeline/rewind`. */
export interface PipelineReopenResult {
  task: Task;
  stepId: string;
  stepName: string;
  /** Steps whose gate evidence was voided in the ledger. */
  voided: string[];
  /** Steps that were under way and were stopped. */
  stopped: string[];
  /** Commits the remote does not have, as last fetched. Nothing was done to them. */
  unpushed: { count: number | null; head: string | null; remoteHead: string | null };
}

/** `POST /tasks/:id/pipeline/feedback`. */
export interface PipelineSteerResult extends PipelineReopenResult {
  feedbackId: string;
  invalidated: boolean;
}

/** The steps a rewind or feedback form offers: those already reached. */
export function reopenChoices(view: Pick<PipelinePositionView, "steps"> | null | undefined): { id: string; name: string }[] {
  return (view?.steps ?? []).filter((s) => s.reached).map((s) => ({ id: s.id, name: s.name }));
}

/** What Restart does for a run with gates, for the button that offers it:
 *  the step it resumes at and what it keeps — or null when a restart begins
 *  at the first step anyway (no gates, nothing to keep, nothing to resume). */
export function resumeOffer(view: PipelinePositionView | null | undefined): { stepId: string; stepName: string; kept: string[]; why: string } | null {
  const p = view?.gated ? view.position : null;
  if (!p || p.kind !== "step" || p.satisfied.length === 0) return null;
  const name = (id: string) => view!.steps.find((s) => s.id === id)?.name ?? id;
  return { stepId: p.stepId, stepName: name(p.stepId), kept: p.satisfied.map((s) => name(s.stepId)), why: p.why };
}
