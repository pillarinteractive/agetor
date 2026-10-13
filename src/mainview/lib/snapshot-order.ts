/**
 * Whether a task-list answer may replace what the board shows.
 *
 * The board changes a card at once (archive, move, mark done) and tells the
 * server afterwards. A list answer whose request was in flight across such a
 * change describes the server before it, so applying it puts the card back
 * until the next refresh: archive several cards quickly and each earlier
 * refresh un-archives the ones that followed. Two answers can also arrive out
 * of order.
 *
 *  - `stale`: a local change started or finished while the request was in
 *    flight, or one is still waiting for the server. Drop the answer and ask
 *    again.
 *  - `late`: a newer request's answer has already been applied. Drop it.
 *  - `apply`: neither.
 */
export function snapshotVerdict(o: { epochAtStart: number; epochNow: number; changesInFlight: number; seq: number; appliedSeq: number }): "apply" | "stale" | "late" {
  // In flight counts too: a request sent and answered entirely while the
  // server is still working on the change sees no bump, and predates it.
  if (o.changesInFlight > 0 || o.epochAtStart !== o.epochNow) return "stale";
  if (o.seq < o.appliedSeq) return "late";
  return "apply";
}

/** How many times a refresh asks again after a stale answer before it leaves
 *  the board as it is for the next poll. */
export const STALE_REFRESH_RETRIES = 3;
