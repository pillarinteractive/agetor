import { expect, test } from "bun:test";
import { landedHead } from "./branch-sweep.ts";

const card = (o: Record<string, unknown> = {}) =>
  ({ id: "c", column: "done", archivedAt: null, pipelineParentId: null, branch: "fix/x", ...o }) as never;
const pr = (state: "OPEN" | "CLOSED" | "MERGED", number = 7) => ({ number, state, headRefOid: "abc" });

test("a merged PR's branch goes, at the PR's final head", () => {
  expect(landedHead(card(), [pr("MERGED")], {})).toEqual({ head: "abc", pr: 7 });
});

test("a PR closed by a merge train Agetor landed counts as landed; any other closed PR doesn't", () => {
  expect(landedHead(card(), [pr("CLOSED")], { c: { pr: 9 } })).toEqual({ head: "abc", pr: 7 });
  expect(landedHead(card(), [pr("CLOSED")], {})).toBeNull();
});

test("never while the card is unfinished, a PR is still open, or for a pipeline step", () => {
  expect(landedHead(card({ column: "merge" }), [pr("MERGED")], {})).toBeNull();
  expect(landedHead(card(), [pr("MERGED", 7), pr("OPEN", 8)], {})).toBeNull();
  expect(landedHead(card({ pipelineParentId: "p" }), [pr("MERGED")], {})).toBeNull();
  expect(landedHead(card({ archivedAt: 1, column: "review" }), [pr("MERGED")], {})).toEqual({ head: "abc", pr: 7 });
});
