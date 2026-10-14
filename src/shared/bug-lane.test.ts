import { expect, test } from "bun:test";
import { BUG_LANE_DEFAULT, parseBugLane, pickBugs } from "./bug-lane.ts";

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
  expect(pickBugs({ ...base, cards: [{ issue: 5, live: true }] })).toEqual({ start: [bug(7)], running: 1 });
  expect(pickBugs({ ...base, cards: [{ issue: 5, live: true }, { issue: 7, live: true }] }).start).toEqual([]);
  // A finished card whose issue is still open is the owner's to settle.
  expect(pickBugs({ ...base, cards: [{ issue: 5, live: false }] }).start.map((b) => b.number)).toEqual([7, 9]);
});
