import { test, expect } from "bun:test";
import { computeVelocity, DAY, HOUR, type VelocityGraphStep, type VelocityStepFacts } from "../../shared/velocity.ts";
import { runRoadmap } from "./roadmap.ts";
import { parseVelocityArgs, velocityLines, velocityPath } from "./roadmap-velocity.ts";

process.env.NO_COLOR = "1";

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);
const MIN = 60_000;
const g = (step: string, issue: number, preds: string[], o: Partial<VelocityGraphStep> = {}): VelocityGraphStep => ({ step, issue, title: `Widget task ${issue}`, stage: "M01", human: false, preds, status: "open", closedAt: null, ...o });
const fact = (step: string, issue: number, hoursAgo: number, o: Partial<VelocityStepFacts> = {}): VelocityStepFacts => ({
  step, issue, stage: "M01", human: false, closedAt: NOW - hoursAgo * HOUR, closedFrom: "github", readyAt: NOW - hoursAgo * HOUR - 3 * HOUR, how: "card", cardId: `c-${issue}`, cards: 1,
  startedAt: NOW - hoursAgo * HOUR - 2 * HOUR, prOpenedAt: null, mergedAt: null, phases: { understand: 10 * MIN, build: 60 * MIN, review: 20 * MIN, merge: 24 * MIN, owner: 6 * MIN }, reviewRounds: 2, finishBounces: 0, fixCi: 0, quotaHits: 0, ...o,
});

function report(completed: number) {
  const closed = Array.from({ length: completed }, (_, i) => g(String(i + 1), 11 + i, [], { status: "complete", closedAt: NOW - (i + 1) * 4 * HOUR }));
  const open = [g("20", 40, []), g("21", 41, ["20"]), g("22", 42, ["21"], { human: true, stage: "H", title: "[Human] Approve the widgets" }), g("23", 43, ["22"], { stage: "M02" })];
  const base = NOW - 30 * MIN;
  return computeVelocity({
    now: NOW, tracker: 600, asOf: NOW - 2 * MIN, maxInFlight: 4, runStartedAt: NOW - 2 * DAY, steps: [...closed, ...open], scope: { label: "M01", steps: [...closed.map((s) => s.step), "20", "21"] }, view: "current",
    facts: closed.map((s) => fact(s.step, s.issue, (NOW - s.closedAt!) / HOUR)),
    open: [{ issue: 40, state: "building", cardId: "c-40", startedAt: NOW - 90 * MIN, since: null }],
    samples: [0, 5, 10, 15, 20, 25].map((m, i) => ({ t: base + m * MIN, max: 4, used: i < 3 ? 2 : 1, blocked: i >= 3, quota: false, ready: 0, held: 1 })),
    hours: [], seed: 3,
  });
}

test("arguments and the request they make", () => {
  expect(parseVelocityArgs([], "usage")).toEqual({ scope: "current", ownerDelayHours: null });
  expect(parseVelocityArgs(["--scope", "roadmap", "--owner-delay", "24"], "usage")).toEqual({ scope: "roadmap", ownerDelayHours: 24 });
  expect(velocityPath({ scope: "roadmap", ownerDelayHours: 24 })).toBe("/autopilot/roadmap/velocity?scope=roadmap&ownerDelayHours=24");
  expect(velocityPath({ scope: "current", ownerDelayHours: null })).toBe("/autopilot/roadmap/velocity?scope=current");
  expect(() => parseVelocityArgs(["--scope", "everything"], "usage")).toThrow("'--scope' is current or roadmap");
  expect(() => parseVelocityArgs(["--owner-delay", "soon"], "usage")).toThrow("needs a number of hours");
  expect(() => parseVelocityArgs(["--fast"], "usage")).toThrow("unknown option '--fast'");
});

test("no data: one line saying why", () => {
  expect(velocityLines({ available: false, reason: "No velocity data yet — it is collected from the first Autopilot pass on" })).toEqual(["No velocity data yet — it is collected from the first Autopilot pass on"]);
});

test("three steps completed: the numbers there are, and no forecast", () => {
  const text = velocityLines(report(3), NOW).join("\n");
  expect(text).toContain("Velocity — roadmap #600  M01 · as of");
  expect(text).toContain("3/5 complete in M01 · 1 in flight · 2 agent and 0 of your steps open");
  expect(text).toContain("since the run began    1.5/day agents (3 in 2.0d)");
  expect(text).toContain("median 2.0h · p75 2.0h · p90 2.0h · 2.0h–2.0h (3 steps)");
  expect(text).toContain("3 steps completed with a measured cycle time — not enough for a forecast (it needs 5)");
  expect(text).not.toContain("simulated");
});

test("a full report: throughput, cycle and lead time, the time table with percentages, rework, slots, bottlenecks, the forecast range and its caveats", () => {
  const lines = velocityLines(report(8), NOW);
  const text = lines.join("\n");
  // Throughput: 6 of the 8 closed within the last 24 hours (4h … 24h ago is 5; 24h is outside).
  expect(text).toContain("last 24 hours          5.0/day agents (5 in 1.0d)");
  expect(text).toContain("since the run began    4.0/day agents (8 in 2.0d)");
  expect(text).toContain("Lead time  (ready → issue closed; includes waiting for a slot or for the scope)");
  expect(text).toContain("median 3.0h");
  // Where the time goes: 8 steps × (10 + 60 + 20 active, 24 + 6 waiting) minutes.
  expect(text).toMatch(/Build\s+8\.0h\s+50%/);
  expect(text).toMatch(/CI and merge queue\s+3\.2h\s+20%/);
  expect(text).toMatch(/Held for you\s+48m\s+5%/);
  expect(text).toContain("Flow efficiency 75% — 12.0h in agent steps, 4.0h waiting");
  expect(text).toContain("2.0 review rounds per step on average · 0% approved first time (2×: 8)");
  // Slots: 2 of 4 for 15 minutes, then 1 of 4 and blocked for 15.
  expect(text).toContain("1.5 of 4 in use on average (38%) · blocked 50% of the time");
  expect(text).toContain("20    #40 Widget task 40");
  expect(text).toContain("3 steps wait behind it · in flight for 1.5h");
  expect(text).toContain("Forecast  (an estimate — a range, not a date)");
  expect(text).toContain("M01 — 2 agent steps left");
  expect(text).toContain("the whole roadmap — 3 agent steps left");
  expect(text).toContain("1 of your steps lies on the path — how long they take is unknown; try --owner-delay <hours>");
  expect(text).toContain("naive (remaining ÷ recent rate)");
  expect(text).toContain("Rests on 8 completed agent steps over 2.0 days. An estimate, not a date.");
  expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/); // never a date
  expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(330);
});

test("agetor roadmap velocity asks the API and prints the report; --json gives the data", async () => {
  const calls: string[] = [];
  const client = {
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return report(8) as never;
    },
    listPipelines: async () => [],
    listProjects: async () => [],
  };
  const r = await runRoadmap(client as never, ["velocity", "--scope", "roadmap", "--owner-delay", "12"]);
  expect(calls).toEqual(["GET /autopilot/roadmap/velocity?scope=roadmap&ownerDelayHours=12"]);
  expect((r.data as { available: boolean }).available).toBe(true);
  expect(r.lines[0]).toContain("Velocity — roadmap #600");
  await expect(runRoadmap(client as never, ["velocity", "--bogus"])).rejects.toThrow("unknown option '--bogus'");
});
