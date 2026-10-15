import { expect, test } from "bun:test";
import { BUG_LANE_DEFAULT, bugParent, parseBugLane, pickBugs } from "./bug-lane.ts";

test("the lane is on by default and can be turned off or resized", () => {
  expect(parseBugLane(null)).toEqual(BUG_LANE_DEFAULT);
  expect(parseBugLane("off")).toBeNull();
  expect(parseBugLane(JSON.stringify({ enabled: false }))).toBeNull();
  expect(parseBugLane(JSON.stringify({ max: 0 }))).toBeNull();
  expect(parseBugLane(JSON.stringify({ max: 3, label: "defect" }))).toEqual({ ...BUG_LANE_DEFAULT, max: 3, label: "defect" });
  expect(parseBugLane(JSON.stringify({ max: 99 }))!.max).toBe(8);
  expect(parseBugLane("not json")).toEqual(BUG_LANE_DEFAULT);
});

test("picks oldest bugs without a card, within the lane's room and the free slots", () => {
  const bug = (number: number, labels = ["bug"]) => ({ number, title: `#${number}`, labels });
  const open = [bug(9), bug(5), bug(7), bug(3, ["bug", "manual"]), bug(4, ["follow-up"]), bug(2)];
  const base = { open, config: BUG_LANE_DEFAULT, roadmap: new Set([2]), cards: [] as { issue: number; live: boolean }[], free: 8 };
  expect(pickBugs(base).start.map((b) => b.number)).toEqual([5, 7]);
  expect(pickBugs({ ...base, free: 1 }).start.map((b) => b.number)).toEqual([5]);
  expect(pickBugs({ ...base, cards: [{ issue: 5, live: true }] })).toEqual({ start: [bug(7)], running: 1, held: [] });
  expect(pickBugs({ ...base, cards: [{ issue: 5, live: true }, { issue: 7, live: true }] }).start).toEqual([]);
  // A finished card whose issue is still open is the owner's to settle.
  expect(pickBugs({ ...base, cards: [{ issue: 5, live: false }] }).start.map((b) => b.number)).toEqual([7, 9]);
});

test("a bug's parent: the close-out title, its body, or a dependency it names", () => {
  expect(bugParent({ number: 1683, title: "Bug (from #1124): R1124-CI-LIVE-INPUTS — retained unresolved finding" })).toBe(1124);
  expect(bugParent({ number: 9, title: "Bug (P1) (from 12): x" })).toBe(12);
  expect(bugParent({ number: 9, title: "Flaky test", body: "Review finding **R1** on #44 came back after 2 fix attempts" })).toBe(44);
  expect(bugParent({ number: 9, title: "Flaky test", body: "Blocked by #51 until it merges." })).toBe(51);
  expect(bugParent({ number: 9, title: "Flaky test", body: "Seen in CI on #51." })).toBeNull();
  expect(bugParent({ number: 9, title: "Bug (from #9): itself" })).toBeNull();
});

test("a bug filed from unlanded work waits until its parent lands, and takes no room meanwhile", () => {
  const bug = (number: number, title = `#${number}`) => ({ number, title, labels: ["bug"] });
  const open = [bug(1683, "Bug (from #1124): finding"), bug(1700, "Bug (from #1650): other"), bug(1701, "Bug (from #1651): pr"), bug(1702)];
  const base = { open, config: BUG_LANE_DEFAULT, roadmap: new Set<number>(), cards: [] as { issue: number; live: boolean }[], free: 8 };
  // No landing information: parents aren't checked (as before).
  expect(pickBugs(base).start.map((b) => b.number)).toEqual([1683, 1700]);
  const parents = new Map([[1124, "open" as const], [1650, "landed" as const], [1651, "unlanded" as const]]);
  const pick = pickBugs({ ...base, parents });
  expect(pick.start.map((b) => b.number)).toEqual([1700, 1702]);
  expect(pick.held.map((h) => [h.issue, h.parent])).toEqual([[1683, 1124], [1701, 1651]]);
  expect(pick.held[0]!.reason).toContain("#1124, which is still open");
  // A parent whose state wasn't read holds its bug too.
  expect(pickBugs({ ...base, parents: new Map() }).start.map((b) => b.number)).toEqual([1702]);
  // Once the parent lands, the bug starts.
  expect(pickBugs({ ...base, parents: new Map([[1124, "landed" as const]]) }).start.map((b) => b.number)).toEqual([1683, 1702]);
});
