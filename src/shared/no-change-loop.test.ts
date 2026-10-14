import { expect, test } from "bun:test";
import { buildSettled, headKey, noChangeReviewNote, reviewSettled, sanitizeNoChangeLoop, type NoChangeLoopState } from "./no-change-loop.ts";

const H = { head: "e0c8e488", tree: "t1" };
const H2 = { head: "f1d2", tree: "t2" };

/** Review sends `at` back to Build, then Build ends on `end`. */
function round(s: NoChangeLoopState | undefined, at = H, end = H, now = 0) {
  const r = reviewSettled(s, at, true, now);
  const b = buildSettled(r.state, end, now);
  return { review: r.action, build: b.action, state: b.state };
}

test("two rounds on one unchanged head tell Review once; a third return goes to the wrap-up", () => {
  const first = buildSettled(undefined, H, 1); // Build's first visit: nothing before it
  expect(first).toEqual({ state: undefined, action: "none" });
  const one = round(first.state);
  expect(one).toMatchObject({ review: "none", build: "none", state: { key: "t1", rounds: 1, instructedAt: null } });
  const two = round(one.state, H, H, 50);
  expect(two).toMatchObject({ review: "none", build: "instruct", state: { rounds: 2, instructedAt: 50 } });
  // The told Review sends the same head back: wrap up.
  const third = reviewSettled(two.state, H, true, 60);
  expect(third).toMatchObject({ action: "wrap-up", state: { wrappedAt: 60 } });
  // Never twice.
  expect(reviewSettled(third.state, H, true, 70).action).toBe("none");
});

test("the instruction is given once: a further no-change round does not repeat it", () => {
  let s = round(round(undefined).state).state;
  expect(s?.instructedAt).not.toBeNull();
  const again = buildSettled(reviewSettled({ ...s!, instructedAt: 5 }, H, false, 0).state, H, 0);
  expect(again.action).toBe("none");
  s = { ...s!, rounds: 2 };
  expect(buildSettled(reviewSettled(s, H, true, 0).state, H, 0).action).toBe("none");
});

test("a Build that changes the head resets the count; so does a Review that approves", () => {
  const one = round(undefined);
  const changed = round(one.state, H, H2);
  expect(changed).toEqual({ review: "none", build: "none", state: undefined });
  // Starting again from the new head counts from one.
  expect(round(changed.state, H2, H2).state).toMatchObject({ key: "t2", rounds: 1 });
  expect(reviewSettled(one.state, H, false, 0)).toEqual({ state: undefined, action: "none" });
  // A different head reaching Review (e.g. the base merged in) starts over.
  expect(reviewSettled({ ...one.state!, rounds: 1 }, H2, true, 0).state).toMatchObject({ key: null, rounds: 0, reviewed: "t2" });
});

test("an empty or reworded commit is no change (same tree); no head known is never counted", () => {
  const r = reviewSettled(undefined, H, true, 0);
  expect(buildSettled(r.state, { head: "new-commit", tree: "t1" }, 0).state).toMatchObject({ rounds: 1 });
  expect(headKey({ head: "abc", tree: null })).toBe("abc");
  expect(reviewSettled(undefined, { head: null, tree: null }, true, 0)).toEqual({ state: undefined, action: "none" });
  expect(buildSettled(r.state, { head: null, tree: null }, 0)).toEqual({ state: undefined, action: "none" });
});

test("the state survives a reload; garbage is dropped", () => {
  const s = round(round(undefined).state).state!;
  expect(sanitizeNoChangeLoop(JSON.parse(JSON.stringify(s)))).toEqual(s);
  expect(sanitizeNoChangeLoop("x")).toBeUndefined();
  expect(sanitizeNoChangeLoop({ rounds: -1, key: 5 })).toEqual({ reviewed: null, key: null, rounds: 0, instructedAt: null, wrappedAt: null });
});

test("the note names what Review must not return, and what it must do instead", () => {
  const note = noChangeReviewNote(2);
  expect(note).toContain("Build ended 2 times in a row");
  expect(note).toContain("must not go back to Build again");
  expect(note).toContain("Approve the work that is done");
  expect(note).toContain("agent-followups");
  expect(note).toContain("`Refs`");
  expect(note).toContain("name that change");
});
