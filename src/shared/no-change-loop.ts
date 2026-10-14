/**
 * The no-change Build ↔ Review loop guard (docs/plans/no-owner-holds.md,
 * "A Build that changes nothing").
 *
 * Seen 2026-10-14: an unattended card went Build → Review → Build → Review
 * eight times in twelve minutes on one unchanged commit. Each Build said "no
 * code change possible" for a finding that needs evidence only an authorized
 * host run can produce; each Review sent it back again, and the loop burned
 * the step cap.
 *
 * A round is a Review that sent the work to Build on a head, followed by a
 * Build that ended on that same head (or the same tree: an empty commit is
 * no change). On the second such round in a row the next Review is told, by
 * the runner, to stop returning what Build cannot fix (`instruct`); if that
 * Review sends the same head back to Build again, the run finishes through
 * the step-cap wrap-up instead (`wrap-up`): published unapproved, one issue
 * per unresolved finding, verdict Refs. Never merged, never approved.
 *
 * Pure. The runner (src/bun/pipeline-runner.ts, `guardNoChangeLoop`) reads
 * the head at each Build and Review settle of an unattended run whose owner
 * holds are resolved, keeps this state on the run (`run.noChangeLoop`) and
 * carries the action out.
 */

export interface HeadAt {
  head: string | null;
  tree: string | null;
}

export interface NoChangeLoopState {
  /** The head (tree, else commit) the last Review sent back to Build; null
   *  once a Build has settled after it. */
  reviewed: string | null;
  /** The head Build left unchanged, and how many rounds in a row. */
  key: string | null;
  rounds: number;
  /** When the runner told Review to stop returning it (once per run). */
  instructedAt: number | null;
  /** When the loop was sent to the wrap-up. */
  wrappedAt: number | null;
}

/** Rounds in a row before Review is told. */
export const NO_CHANGE_ROUNDS = 2;

/** The identity of a head: its tree when known (an empty or reworded commit
 *  changes nothing), else the commit. */
export const headKey = (at: HeadAt): string | null => at.tree || at.head || null;

const fresh = (): NoChangeLoopState => ({ reviewed: null, key: null, rounds: 0, instructedAt: null, wrappedAt: null });

/** A Review settled. `toBuild`: it sent the work back to Build. */
export function reviewSettled(
  state: NoChangeLoopState | undefined,
  at: HeadAt,
  toBuild: boolean,
  now: number,
): { state: NoChangeLoopState | undefined; action: "none" | "wrap-up" } {
  const key = headKey(at);
  if (!toBuild || !key) return { state: undefined, action: "none" };
  const s = state ?? fresh();
  if (s.key !== null && s.key !== key) return { state: { ...fresh(), reviewed: key }, action: "none" };
  if (s.instructedAt != null && s.wrappedAt == null && s.key === key) {
    return { state: { ...s, reviewed: key, wrappedAt: now }, action: "wrap-up" };
  }
  return { state: { ...s, reviewed: key }, action: "none" };
}

/** A Build settled, on `at`. */
export function buildSettled(
  state: NoChangeLoopState | undefined,
  at: HeadAt,
  now: number,
): { state: NoChangeLoopState | undefined; action: "none" | "instruct" } {
  const key = headKey(at);
  // Not straight after a Review that sent this head back, or it changed it.
  if (!state?.reviewed || !key || key !== state.reviewed) return { state: undefined, action: "none" };
  const rounds = (state.key === key ? state.rounds : 0) + 1;
  const next: NoChangeLoopState = { ...state, reviewed: null, key, rounds };
  if (rounds >= NO_CHANGE_ROUNDS && state.instructedAt == null) return { state: { ...next, instructedAt: now }, action: "instruct" };
  return { state: next, action: "none" };
}

/** What the next Review is told, as a section of its prompt. */
export function noChangeReviewNote(rounds: number): string {
  return [
    "## Build made no change — decide what Build can still fix",
    `Build ended ${rounds} times in a row on the same head you sent back, without a change: the findings it was sent ` +
      "cannot be fixed by Build. This card runs unattended; Agetor wrote this, not the owner.",
    "- A finding that needs resources, hardware, a host or lab run, an external receipt or the owner's authority, " +
      "which no step of this run can supply, must not go back to Build again.",
    "- Approve the work that is done. File one follow-up issue per such finding (agent-followups mode: search first " +
      "and reuse an open one) with what is needed and the evidence so far, list the issue numbers in your summary, and " +
      "say the closing verdict is `Refs`, not `Fixes`, because the issue's criteria are not all met.",
    "- Return to Build only for a finding Build can fix with a code or file change, and name that change in your handoff.",
    "- If you send this same head back to Build again, Agetor finishes the run through Finish: published unapproved, " +
      "with an issue per unresolved finding. It is never merged.",
  ].join("\n");
}

/** Read leniently: an unreadable record is dropped (the guard starts over). */
export function sanitizeNoChangeLoop(raw: unknown): NoChangeLoopState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 && x.length <= 128 ? x : null);
  const at = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const rounds = Number.isSafeInteger(r.rounds) && (r.rounds as number) >= 0 ? Math.min(r.rounds as number, 1000) : 0;
  return { reviewed: str(r.reviewed), key: str(r.key), rounds, instructedAt: at(r.instructedAt), wrappedAt: at(r.wrappedAt) };
}
