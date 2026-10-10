import { describe, expect, test } from "bun:test";
import {
  compareStepIds,
  parseRoadmap,
  pickRoadmap,
  roadmapFinished,
  roadmapStatus,
  roadmapStepPrompt,
  summarizeRoadmap,
  type RoadmapIssueState,
} from "./roadmap.ts";

const table = (...rows: string[]) =>
  ["# Tracker", "", "## Numbered completion order", "Intro text.", "", "| Step | Task and outcome | Milestone | Predecessor steps |", "| --- | --- | --- | --- |", ...rows].join("\n");

const BODY = table(
  "| 1 | #101 [Human] Supply the reference gadget | H | none |",
  "| 2 | #102 Inventory the gadget surfaces | M01 | none |",
  "| 3 | #103 Implement the gadget contract | M02 | 1, 2 |",
  "| 3.1 | #110 Add the gadget controller | M02 | 3 |",
  "| 3.10 | #112 Add the gadget cache | M02 | 3 |",
  "| 3.2 | #111 Add the gadget log | M02 | 3.1 |",
  "| 4 | #104 Ship the gadget page | M03 | 3.2, 3.10 |",
);

const OPEN: RoadmapIssueState = { state: "OPEN", stateReason: null };
const DONE: RoadmapIssueState = { state: "CLOSED", stateReason: "COMPLETED" };
const NO_GO: RoadmapIssueState = { state: "CLOSED", stateReason: "NOT_PLANNED" };
const states = (o: Record<number, RoadmapIssueState>, all = [101, 102, 103, 104, 110, 111, 112]) =>
  new Map(all.map((n) => [n, o[n] ?? OPEN] as const));

describe("parseRoadmap", () => {
  test("rows become steps: issue, title, human, milestone, predecessors", () => {
    const r = parseRoadmap(BODY);
    expect(r.error).toBeNull();
    expect(r.problems).toEqual([]);
    expect(r.steps[0]).toEqual({ step: "1", issue: 101, title: "[Human] Supply the reference gadget", human: true, milestone: "H", predecessors: [] });
    expect(r.steps[2]).toEqual({ step: "3", issue: 103, title: "Implement the gadget contract", human: false, milestone: "M02", predecessors: ["1", "2"] });
    expect(r.steps.filter((s) => s.human).map((s) => s.step)).toEqual(["1"]);
  });

  test("decimal step ids are strings ordered by integer part, then the fraction as an integer", () => {
    expect(parseRoadmap(BODY).steps.map((s) => s.step)).toEqual(["1", "2", "3", "3.1", "3.2", "3.10", "4"]);
    expect(["78.1", "9", "78", "149.3", "78.10", "78.2"].sort(compareStepIds)).toEqual(["9", "78", "78.1", "78.2", "78.10", "149.3"]);
  });

  test("parsing stops at the end of the section's table", () => {
    const r = parseRoadmap(`${BODY}\n\n## Requirement coverage\n| Step | Task and outcome | Milestone | Predecessor steps |\n| --- | --- | --- | --- |\n| 9 | #999 Not a step | M | none |\n\n| 10 | #998 Nor this | M | none |`);
    expect(r.steps.length).toBe(7);
    expect(r.problems).toEqual([]);
  });

  test("no section, no table, or no valid row: an error and no steps", () => {
    expect(parseRoadmap("## Summary\nnothing")).toMatchObject({ steps: [], error: expect.stringContaining("completion order"), problems: [{ kind: "missing-section" }] });
    expect(parseRoadmap("## Numbered completion order\nJust prose.\n## Next\n| Step | Task and outcome | Milestone | Predecessor steps |\n| --- | --- | --- | --- |")).toMatchObject({
      steps: [],
      problems: [{ kind: "missing-table" }],
    });
    const empty = parseRoadmap(table("| one | 101 no issue ref | M | none |"));
    expect(empty.steps).toEqual([]);
    expect(empty.error).toContain("no valid rows");
    expect(empty.problems.map((p) => p.kind)).toEqual(["no-rows", "malformed-row"]);
  });

  test("malformed rows are reported and skipped", () => {
    const r = parseRoadmap(table("| 1 | #101 Good | M | none |", "| x | #102 Bad step id | M | none |", "| 3 | no issue here | M | none |", "| 4 | #104 Too few cells | M |", "| 5 | #105 Fine | M | 1 |"));
    expect(r.steps.map((s) => s.step)).toEqual(["1", "5"]);
    expect(r.problems.map((p) => p.kind)).toEqual(["malformed-row", "malformed-row", "malformed-row"]);
    expect(r.problems[0]).toMatchObject({ line: 9 });
    expect(r.problems[1]).toMatchObject({ step: "3" });
  });

  test("a duplicate step id: the later row is ignored and reported", () => {
    const r = parseRoadmap(table("| 1 | #101 First | M | none |", "| 1 | #102 Again | M | none |"));
    expect(r.steps.map((s) => s.issue)).toEqual([101]);
    expect(r.problems).toEqual([expect.objectContaining({ kind: "duplicate-step", step: "1" })]);
  });

  test("a duplicate issue: the later step is reported and held", () => {
    const r = parseRoadmap(table("| 1 | #101 First | M | none |", "| 2 | #101 Same issue | M | none |"));
    expect(r.problems).toEqual([expect.objectContaining({ kind: "duplicate-issue", step: "2" })]);
    expect(Object.keys(r.held)).toEqual(["2"]);
  });

  test("a predecessor that names no step holds the step", () => {
    const r = parseRoadmap(table("| 1 | #101 First | M | none |", "| 2 | #102 Second | M | 1, 7, #999 |"));
    expect(r.problems).toEqual([expect.objectContaining({ kind: "unknown-predecessor", step: "2", message: "step 2: predecessor 7, #999 names no step" })]);
    const views = roadmapStatus(r, states({ 101: DONE }, [101, 102]));
    expect(views[1]).toMatchObject({ status: "held", waitingOn: ["7", "#999"] });
    expect(pickRoadmap(views, { busy: new Set(), free: 5 }).start).toEqual([]);
  });

  test("a dependency cycle is reported and its steps held — not the steps around it", () => {
    const r = parseRoadmap(table("| 1 | #101 Root | M | none |", "| 2 | #102 A | M | 1, 4 |", "| 3 | #103 B | M | 2 |", "| 4 | #104 C | M | 3 |", "| 5 | #105 After | M | 4 |", "| 6 | #106 Self | M | 6 |"));
    expect(r.problems.map((p) => p.kind)).toEqual(["cycle"]);
    expect(r.problems[0]!.message).toBe("dependency cycle among steps 2, 3, 4, 6");
    expect(Object.keys(r.held).sort()).toEqual(["2", "3", "4", "6"]);
  });
});

describe("roadmapStatus", () => {
  test("complete vs declined vs open; ready needs every predecessor complete", () => {
    const parsed = parseRoadmap(BODY);
    const v = roadmapStatus(parsed, states({ 101: DONE, 102: DONE, 103: DONE, 110: NO_GO }));
    const by = Object.fromEntries(v.map((s) => [s.step, s]));
    expect(by["1"]!.status).toBe("complete");
    expect(by["3.1"]!.status).toBe("declined"); // a no-go: unlocks nothing
    expect(by["3.10"]).toMatchObject({ status: "ready", waitingOn: [] });
    expect(by["3.2"]).toMatchObject({ status: "waiting", waitingOn: ["3.1"] });
    expect(by["4"]).toMatchObject({ status: "waiting", waitingOn: ["3.2", "3.10"] });
  });

  test("closed for any reason other than completed is declined; an unread issue holds its step", () => {
    const parsed = parseRoadmap(BODY);
    const v = roadmapStatus(parsed, new Map([[101, { state: "CLOSED", stateReason: "DUPLICATE" }], [102, { state: "CLOSED", stateReason: null }]]));
    expect(v[0]!.status).toBe("declined");
    expect(v[1]!.status).toBe("declined");
    expect(v[2]).toMatchObject({ status: "held", reason: "the state of #103 couldn't be read", waitingOn: ["1", "2"] });
  });

  test("finished only when every step is complete or declined", () => {
    const parsed = parseRoadmap(BODY);
    const all = { 101: DONE, 102: DONE, 103: DONE, 110: DONE, 111: NO_GO, 112: DONE };
    expect(roadmapFinished(parsed, roadmapStatus(parsed, states(all)))).toBe(false); // #104 open (and stuck behind a no-go)
    expect(roadmapFinished(parsed, roadmapStatus(parsed, states({ ...all, 104: NO_GO })))).toBe(true);
    // A dropped row means the roadmap isn't what it says: never "done".
    const dropped = parseRoadmap(table("| 1 | #101 Good | M | none |", "| x | #102 Bad | M | none |"));
    expect(roadmapFinished(dropped, roadmapStatus(dropped, states({ 101: DONE }, [101])))).toBe(false);
  });
});

describe("pickRoadmap", () => {
  const parsed = parseRoadmap(BODY);
  const views = roadmapStatus(parsed, states({ 101: DONE, 102: DONE, 103: DONE }));

  test("ready agent steps in step order, within the free slots", () => {
    expect(pickRoadmap(views, { busy: new Set(), free: 5 }).start.map((v) => v.step)).toEqual(["3.1", "3.10"]);
    expect(pickRoadmap(views, { busy: new Set(), free: 1 }).start.map((v) => v.step)).toEqual(["3.1"]);
    expect(pickRoadmap(views, { busy: new Set(), free: 0 }).start).toEqual([]);
    expect(pickRoadmap(views, { busy: new Set(), free: -2 }).start).toEqual([]);
  });

  test("a step with a live card, or one set aside, isn't picked", () => {
    expect(pickRoadmap(views, { busy: new Set([110]), free: 5 }).start.map((v) => v.step)).toEqual(["3.10"]);
    expect(pickRoadmap(views, { busy: new Set(), exclude: new Set([112]), free: 5 }).start.map((v) => v.step)).toEqual(["3.1"]);
  });

  test("ready human steps are never picked and use no slot", () => {
    const fresh = roadmapStatus(parsed, states({}));
    const p = pickRoadmap(fresh, { busy: new Set(), free: 1 });
    expect(p.start.map((v) => v.step)).toEqual(["2"]);
    expect(p.human.map((v) => v.step)).toEqual(["1"]);
    expect(pickRoadmap(fresh, { busy: new Set(), free: 0 }).human.map((v) => v.step)).toEqual(["1"]);
  });
});

test("the step prompt names the step, tracker, predecessors' issues and the Fixes line", () => {
  const parsed = parseRoadmap(BODY);
  const p = roadmapStepPrompt(639, parsed.steps.find((s) => s.step === "4")!, parsed.steps);
  expect(p).toContain("Roadmap step 4 (M03)");
  expect(p).toContain("tracker issue #639");
  expect(p).toContain("3.2 (#111), 3.10 (#112)");
  expect(p).toContain('"Fixes #104"');
  expect(roadmapStepPrompt(639, parsed.steps[1]!, parsed.steps)).toContain("no predecessor steps");
});

describe("summarizeRoadmap", () => {
  const parsed = parseRoadmap(BODY);
  const sum = (o: Record<number, RoadmapIssueState>, busy: number[] = [], needsUser: [number, string][] = []) =>
    summarizeRoadmap({ issue: 639, url: "u", parsed, views: roadmapStatus(parsed, states(o)), busy: new Set(busy), needsUser: new Map(needsUser), now: 5 });

  test("every step is counted once", () => {
    const s = sum({ 102: DONE, 110: NO_GO }, [103]);
    expect(s.counts).toEqual({ total: 7, complete: 1, declined: 1, inFlight: 1, ready: 1, waiting: 3 });
    expect(s.humanReady).toEqual([{ step: "1", issue: 101, title: "[Human] Supply the reference gadget", url: null }]);
    expect(s.nextWaiting.map((w) => [w.step, w.waitingOn])).toEqual([["3.2", ["3.1"]], ["3.10", ["3"]], ["4", ["3.2", "3.10"]]]);
    expect(s.idleReason).toBeNull(); // #103 is in flight
  });

  test("idle with a reason: human steps, steps needing the user, steps behind a declined one", () => {
    expect(sum({ 102: DONE }).idleReason).toBe("Nothing can start: waiting on you to do human step 1 (#101)");
    const s = sum({ 101: DONE, 102: DONE, 110: NO_GO, 112: DONE }, [], [[103, "PR #9 merged but the issue is still open"]]);
    expect(s.needsUser).toEqual([{ step: "3", issue: 103, title: "Implement the gadget contract", url: null, reason: "PR #9 merged but the issue is still open" }]);
    expect(s.counts).toMatchObject({ ready: 0, waiting: 3 });
    expect(s.idleReason).toBe("Nothing can start: step 3 (#103) needs you; 3.2 (#111) wait on a declined step");
    // An agent step that's ready is not an idle roadmap.
    expect(sum({ 101: DONE, 102: DONE }).idleReason).toBeNull();
  });
});

test("the table may name predecessors by issue, mark the owner's steps by milestone H, and sit under another 'completion order' heading", () => {
  const body = [
    "## Single completion order",
    "",
    "| Step | Task | Stage | Predecessors |",
    "| --- | --- | --- | --- |",
    "| 1 | #806 Inventory surfaces | M01 | — |",
    "| 2 | #807 Validate records | M01 | #806 |",
    "| 3 | #1200 Review the dossier | H | #806, #807 |",
    "| 4 | #808 Build on a missing one | M01 | #999 |",
  ].join("\n");
  const r = parseRoadmap(body);
  expect(r.error).toBeNull();
  expect(r.steps.map((s) => s.predecessors)).toEqual([[], ["1"], ["1", "2"], ["#999"]]);
  expect(r.steps.map((s) => s.human)).toEqual([false, false, true, false]);
  expect(r.problems.map((p) => p.kind)).toEqual(["unknown-predecessor"]);
  expect(r.held["4"]).toContain("#999");
});
