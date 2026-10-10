import { describe, expect, test } from "bun:test";
import { blockerView, edgeGeometry, outside, panelPlacement, type Box } from "./blocker-lines.ts";
import type { RoadmapLinkStep, RoadmapStepLinks } from "../../shared/roadmap.ts";

const link = (step: string, issue: number, state: RoadmapLinkStep["state"], taskId: string | null, extra: Partial<RoadmapLinkStep> = {}): RoadmapLinkStep => ({ step, issue, title: `Widget task ${issue}`, milestone: "M01", state, taskId, ...extra });
const entry = (step: string, issue: number, taskId: string, predecessors: RoadmapLinkStep[], successors: RoadmapLinkStep[], extra: Partial<RoadmapStepLinks> = {}): RoadmapStepLinks => ({ step, issue, title: `Widget task ${issue}`, state: "backlog", taskId, predecessors, successors, ...extra });

// 2 → 3 → 5 → 6, and 4 → 5. Step 1 is the owner's (no card); step 7 is finished.
const CHAIN = new Map<string, RoadmapStepLinks>(
  [
    entry("2", 12, "c2", [], [link("3", 13, "backlog", "c3")], { state: "in-flight" }),
    entry("3", 13, "c3", [link("2", 12, "in-flight", "c2"), link("1", 11, "yours", null, { milestone: "H" })], [link("5", 15, "backlog", "c5")]),
    entry("4", 14, "c4", [link("7", 17, "complete", null)], [link("5", 15, "backlog", "c5")]),
    entry("5", 15, "c5", [link("3", 13, "backlog", "c3"), link("4", 14, "backlog", "c4", { note: "annual only" }), link("9", 19, "outside", null, { milestone: "M02" })], [link("6", 16, "backlog", "c6")], { morePredecessors: 2 }),
    entry("6", 16, "c6", [link("5", 15, "backlog", "c5")], []),
  ].map((e) => [e.taskId!, e]),
);
const edges = (v: ReturnType<typeof blockerView>) => v!.edges.map((e) => `${e.from}>${e.to}:${e.kind}:${e.depth}`);

describe("blockerView", () => {
  test("direct links only by default: a line to every unfinished predecessor with a card, and to every successor with one", () => {
    const v = blockerView("c5", CHAIN, null)!;
    expect(v.step).toBe("5");
    // Lines run the way the work flows: from what must finish to what waits.
    expect(edges(v)).toEqual(["c3>c5:waits:1", "c4>c5:waits:1", "c5>c6:blocks:1"]);
    expect(v.edges[0]!.label).toBe("step 3 · #13");
    // The panel lists every predecessor — also the one with no card, which can't have a line.
    expect(v.waits.map((r) => [r.text, r.state, r.taskId, r.done])).toEqual([
      ["3 · #13 Widget task 13", "in the backlog", "c3", false],
      ["4 · #14 Widget task 14", "in the backlog — noted: annual only", "c4", false],
      ["9 · #19 Widget task 19", "open in another milestone (M02)", null, false],
    ]);
    expect(v.blocks.map((r) => r.text)).toEqual(["6 · #16 Widget task 16"]);
    expect(v.moreWaits).toBe(2);
    expect(v.hasChain).toBe(true); // step 3 waits on step 2
  });

  test("a finished predecessor and the owner's step are listed without a line", () => {
    const three = blockerView("c3", CHAIN, null)!;
    expect(edges(three)).toEqual(["c2>c3:waits:1", "c3>c5:blocks:1"]);
    expect(three.waits.map((r) => [r.state, r.taskId, r.done])).toEqual([["in flight", "c2", false], ["yours to do", null, false]]);
    const four = blockerView("c4", CHAIN, null)!;
    expect(edges(four)).toEqual(["c4>c5:blocks:1"]); // its one predecessor is complete
    expect(four.waits).toEqual([{ key: "waits:7", text: "7 · #17 Widget task 17", state: "complete", taskId: null, done: true }]);
  });

  test("holding the modifier follows the whole chain, both ways, without looping", () => {
    expect(edges(blockerView("c5", CHAIN, null, { transitive: true }))).toEqual(["c3>c5:waits:1", "c2>c3:waits:2", "c4>c5:waits:1", "c5>c6:blocks:1"]);
    expect(edges(blockerView("c2", CHAIN, null, { transitive: true }))).toEqual(["c2>c3:blocks:1", "c3>c5:blocks:2", "c5>c6:blocks:3"]);
    expect(blockerView("c6", CHAIN, null)!.hasChain).toBe(true);
    expect(blockerView("c2", CHAIN, null)!.hasChain).toBe(true);
    expect(blockerView("c4", CHAIN, null)!.hasChain).toBe(true); // 5 blocks 6
    // A cycle in the data (a broken tracker) ends instead of spinning.
    const loop = new Map<string, RoadmapStepLinks>([
      ["a", entry("1", 1, "a", [link("2", 2, "backlog", "b")], [])],
      ["b", entry("2", 2, "b", [link("1", 1, "backlog", "a")], [])],
    ]);
    expect(edges(blockerView("a", loop, null, { transitive: true }))).toEqual(["b>a:waits:1", "a>b:waits:2"]);
  });

  test("a card's manual dependencies are drawn the same way; a card with no links shows nothing", () => {
    const manual = { blockedBy: [{ taskId: "x", title: "Fix the widget flake", satisfied: false, detail: "PR #9 · checks running", ref: "PR #9" }, { taskId: "y", title: "Old", satisfied: true, detail: "done" }], blocking: [{ taskId: "z", title: "Ship the widget docs" }] };
    const v = blockerView("free", CHAIN, manual)!;
    expect(v.step).toBeNull();
    expect(edges(v)).toEqual(["x>free:waits:1", "free>z:blocks:1"]);
    expect(v.waits).toEqual([{ key: "dep:x", text: "Fix the widget flake", state: "PR #9 · checks running", taskId: "x", done: false }]);
    expect(v.blocks).toEqual([{ key: "dep:z", text: "Ship the widget docs", state: "waits on this card", taskId: "z", done: false }]);
    // Both kinds on one card; a manual link that repeats a roadmap one isn't drawn or listed twice.
    const both = blockerView("c5", CHAIN, { blockedBy: [{ taskId: "c3", title: "Widget task 13", satisfied: false, detail: "running" }, { taskId: "x", title: "Fix the widget flake", satisfied: false, detail: "running" }] })!;
    expect(edges(both)).toEqual(["c3>c5:waits:1", "c4>c5:waits:1", "c5>c6:blocks:1", "x>c5:waits:1"]);
    expect(both.waits.map((r) => r.key)).toEqual(["waits:3", "waits:4", "waits:9", "dep:x"]);
    expect(blockerView("free", CHAIN, null)).toBeNull();
    expect(blockerView("free", CHAIN, { blockedBy: [{ taskId: "y", title: "Old", satisfied: true, detail: "done" }] })).toBeNull();
  });
});

describe("edgeGeometry", () => {
  const view = { width: 1000, height: 600 };
  const box = (left: number, top: number): Box => ({ left, top, right: left + 280, bottom: top + 90 });

  test("cards in different columns are joined across the gutter, arrow at the waiting card", () => {
    const g = edgeGeometry(box(340, 100), box(20, 300), view); // from the right column to the left one
    expect(g.start).toEqual({ x: 340, y: 145 });
    expect(g.end).toEqual({ x: 300, y: 345 });
    expect(g.d).toBe("M 340 145 C 320 145, 320 345, 300 345");
    expect(g.arrow).toBe("M 300 345 L 309 340.5 L 309 349.5 Z"); // the tip touches the card's right edge
    expect(g.clipped).toBeNull();
    const r = edgeGeometry(box(20, 300), box(340, 100), view);
    expect(r.start).toEqual({ x: 300, y: 345 });
    expect(r.end).toEqual({ x: 340, y: 145 });
    expect(r.arrow).toBe("M 340 145 L 331 140.5 L 331 149.5 Z");
  });

  test("cards in the same column are joined by a bracket on their right edge — wider for cards further apart", () => {
    const g = edgeGeometry(box(20, 100), box(20, 300), view);
    expect(g.start).toEqual({ x: 300, y: 145 });
    expect(g.end).toEqual({ x: 300, y: 345 });
    expect(g.d).toBe("M 300 145 C 324.3 145, 324.3 345, 300 345"); // swings out, never across a card
    expect(g.arrow).toBe("M 300 345 L 309 340.5 L 309 349.5 Z");
    expect(edgeGeometry(box(20, 100), box(20, 200), view).d).toBe("M 300 145 C 317.1 145, 317.1 245, 300 245");
    expect(edgeGeometry(box(20, 0), box(20, 500), view).d).toBe("M 300 45 C 328 45, 328 545, 300 545"); // never past the gutter
  });

  test("the ends can sit higher or lower on a card, so lines in and lines out don't share a point", () => {
    const into = edgeGeometry(box(20, 100), box(20, 300), view, { to: 0.34 });
    const out = edgeGeometry(box(20, 300), box(20, 500), view, { from: 0.66 });
    expect(into.end.y).toBeCloseTo(330.6);
    expect(out.start.y).toBeCloseTo(359.4);
  });

  test("an end scrolled out of view stops at the edge of the board and says which way it went", () => {
    expect(outside(box(20, 700), view)).toBe("bottom");
    expect(outside(box(20, -200), view)).toBe("top");
    expect(outside(box(1100, 100), view)).toBe("right");
    expect(outside(box(-400, 100), view)).toBe("left");
    expect(outside(box(20, 560), view)).toBeNull(); // partly visible still counts as there
    const below = edgeGeometry(box(20, 900), box(20, 100), view); // the blocker is far down the column
    expect(below.clipped).toEqual({ end: "from", side: "bottom", x: 300, y: 590 });
    expect(below.start).toEqual({ x: 300, y: 590 });
    expect(below.end).toEqual({ x: 300, y: 145 });
    const right = edgeGeometry(box(20, 100), box(1400, 100), view); // what it blocks is off to the right
    expect(right.clipped).toEqual({ end: "to", side: "right", x: 990, y: 145 });
    expect(right.end.x).toBe(990);
    // A partly visible card is anchored on the part that shows.
    const peek = edgeGeometry(box(340, 100), box(20, 560), view);
    expect(peek.end).toEqual({ x: 300, y: 580 });
    expect(peek.clipped).toBeNull();
  });
});

describe("panelPlacement", () => {
  const view = { width: 1000, height: 600 };
  const box = (left: number, top: number): Box => ({ left, top, right: left + 280, bottom: top + 90 });
  const size = { width: 320, height: 150 };

  test("under the card when nothing is there; kept inside the board", () => {
    expect(panelPlacement(box(20, 100), view, size)).toEqual({ left: 20, top: 198 });
    expect(panelPlacement(box(800, 100), view, size).left).toBe(672);
  });

  test("never on a card a line runs to when there is room elsewhere", () => {
    // The card it waits on is right below, the one it blocks right above: the panel goes beside.
    const beside = panelPlacement(box(20, 250), view, size, { linked: [box(20, 350), box(20, 150)] });
    expect(beside).toEqual({ left: 332, top: 250 });
    // A linked card beside it too: over or under is unavoidable — it takes the spot that covers least.
    const linked = [box(20, 350), box(340, 240)];
    expect(panelPlacement(box(20, 250), view, size, { linked })).toEqual({ left: 20, top: 92 });
    // Other cards count, but far less than linked ones.
    expect(panelPlacement(box(20, 250), view, size, { linked: [box(20, 350)], others: [box(20, 150)] })).toEqual({ left: 332, top: 250 });
    // At the bottom of the board there is no room under: it goes over.
    expect(panelPlacement(box(20, 500), view, size, { linked: [box(340, 500)] })).toEqual({ left: 20, top: 342 });
  });
});
