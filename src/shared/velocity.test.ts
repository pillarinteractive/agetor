// Velocity's metrics, each against numbers worked out by hand. Times are
// minutes from T0 unless a test says otherwise.
import { test, expect, describe } from "bun:test";
import {
  cardWindow,
  computeVelocity,
  DAY,
  distribution,
  fmtDuration,
  fmtRange,
  foldSamples,
  HOUR,
  mergeHours,
  MIN_FORECAST_STEPS,
  quantile,
  rng,
  simulateOnce,
  stepFacts,
  velocitySummary,
  type VelocityCard,
  type VelocityGraphStep,
  type VelocityInput,
  type VelocityRecord,
  type VelocityStepFacts,
} from "./velocity.ts";

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const MIN = 60_000;
const at = (min: number) => T0 + min * MIN;
const mins = (ms: number | undefined) => (ms ?? 0) / MIN;

const rec = (stepId: string, from: number, to: number | null, next: string[], o: Partial<VelocityRecord> = {}): VelocityRecord => ({
  stepId,
  name: stepId[0]!.toUpperCase() + stepId.slice(1),
  startedAt: at(from),
  endedAt: to == null ? null : at(to),
  outcome: to == null ? null : "succeeded",
  blocked: false,
  next,
  ...o,
});
const say = (min: number, text: string) => ({ ts: at(min), text });
const STEP = { step: "2", issue: 12, stage: "M01", human: false };

/** Understand, then three Build → Review rounds, then Finish. */
const threeRounds = (): VelocityCard => ({
  cardId: "card-a",
  runStartedAt: at(0),
  records: [
    rec("understand", 2, 10, ["build"]),
    rec("build", 10, 40, ["review"]),
    rec("review", 40, 45, ["build"]),
    rec("build", 45, 60, ["review"]),
    rec("review", 60, 62, ["build"]),
    rec("build", 62, 70, ["review"]),
    rec("review", 70, 73, ["finish"]),
    rec("finish", 73, 80, []),
  ],
  activity: [say(0, "Autopilot started this as step 2 of roadmap #600"), say(81, "PR #31 opened"), say(100, "PR #31 merged"), say(101, "Closed issue #12 (fixed by PR #31)")],
});

describe("a card's time, split into phases", () => {
  test("three Build → Review rounds: every minute is counted once", () => {
    const f = stepFacts({ step: STEP, cards: [threeRounds()], closedAt: at(101), observedAt: at(105), readyAt: at(-30) });
    expect(f.how).toBe("card");
    expect(f.startedAt).toBe(at(0));
    expect(f.reviewRounds).toBe(3);
    expect(f.finishBounces).toBe(0);
    expect(f.fixCi).toBe(0);
    // slot 0–2 · understand 2–10 · build 30+15+8 · review 5+2+3 · finish 73–80 · merge 80–101
    expect({ slot: mins(f.phases!.slot), understand: mins(f.phases!.understand), build: mins(f.phases!.build), review: mins(f.phases!.review), finish: mins(f.phases!.finish), merge: mins(f.phases!.merge) }).toEqual({
      slot: 2,
      understand: 8,
      build: 53,
      review: 10,
      finish: 7,
      merge: 21,
    });
    expect(Object.values(f.phases!).reduce((a, b) => a + b, 0)).toBe(f.closedAt - f.startedAt!);
    expect(f.prOpenedAt).toBe(at(81));
    expect(f.mergedAt).toBe(at(100));
    expect(f.closedFrom).toBe("github");
  });

  test("held for the owner: from the hold to the sign-off, the rest of the wait is CI and the merge queue", () => {
    const card = threeRounds();
    card.activity = [say(81, "PR #31 opened"), say(85, "Autopilot: PR #31 changes sensitive code (billing/plan.ts) — left in In Review for you to sign off"), say(145, "Autopilot: signed off PR #31 for merging"), say(160, "PR #31 merged")];
    const f = stepFacts({ step: STEP, cards: [card], closedAt: at(161), observedAt: at(161), readyAt: null });
    expect(mins(f.phases!.owner)).toBe(60); // 85 → 145
    expect(mins(f.phases!.merge)).toBe(21); // 80 → 85 and 145 → 161
    expect(f.readyAt).toBeNull();
  });

  test("a hold the owner ends by hand stops when the card reaches the merge queue", () => {
    const card = threeRounds();
    card.activity = [say(85, "Autopilot: PR #31 changes sensitive code (a.sql) — left in In Review for you to sign off"), say(95, "Green — waiting up to 10 min to merge together with other PRs"), say(110, "Merged PR #31 into develop")];
    const f = stepFacts({ step: STEP, cards: [card], closedAt: at(111), observedAt: at(111), readyAt: null });
    expect(mins(f.phases!.owner)).toBe(10);
    expect(mins(f.phases!.merge)).toBe(21); // 80 → 85 and 95 → 111
  });

  test("a usage-limit wait between two attempts is its own phase", () => {
    const card: VelocityCard = {
      cardId: "card-q",
      runStartedAt: at(0),
      records: [rec("build", 0, 30, [], { outcome: "failed" }), rec("build", 90, 120, [])],
      activity: [say(30, "Build is waiting on a usage limit (resets 3pm) — retrying automatically at 3:00 PM")],
    };
    const w = cardWindow(card, at(130))!;
    expect({ build: mins(w.phases.build), quota: mins(w.phases.quota), merge: mins(w.phases.merge) }).toEqual({ build: 60, quota: 60, merge: 10 });
    expect(w.quotaHits).toBe(1);
  });

  test("what a pass observed wins over the step's open record: a quota wait and a block inside a step", () => {
    const card: VelocityCard = {
      cardId: "card-o",
      runStartedAt: at(0),
      records: [rec("build", 0, 100, [])],
      activity: [],
      observed: [
        { from: at(40), to: at(70), state: "quota" },
        { from: at(80), to: at(95), state: "blocked" },
      ],
    };
    const w = cardWindow(card, at(100))!;
    expect({ build: mins(w.phases.build), quota: mins(w.phases.quota), owner: mins(w.phases.owner) }).toEqual({ build: 55, quota: 30, owner: 15 });
  });

  test("a failed step waits on the owner — unless an automatic retry was announced", () => {
    const base = (activity: VelocityCard["activity"]): VelocityCard => ({ cardId: "c", runStartedAt: at(0), records: [rec("build", 0, 20, [], { outcome: "failed" }), rec("build", 50, 60, [])], activity });
    expect(mins(cardWindow(base([]), at(60))!.phases.owner)).toBe(30);
    const retried = cardWindow(base([say(20, "Build crashed (exit 1) — retrying automatically at 9:50 AM (1 of 3)")]), at(60))!;
    expect(mins(retried.phases.other)).toBe(30);
    expect(retried.phases.owner).toBeUndefined();
  });

  test("a 'blocked' handoff that still names the next step is not a wait on the owner", () => {
    const card: VelocityCard = { cardId: "c", runStartedAt: at(0), records: [rec("build", 0, 20, ["review"], { blocked: true }), rec("review", 22, 30, [])], activity: [] };
    expect(cardWindow(card, at(30))!.phases).toEqual({ build: 20 * MIN, slot: 2 * MIN, review: 8 * MIN });
  });

  test("Finish handing back to Build, follow-up steps and automatic Fix CI runs are counted", () => {
    const card: VelocityCard = {
      cardId: "c",
      runStartedAt: at(0),
      records: [rec("build", 0, 10, ["review"]), rec("review", 10, 12, ["finish"]), rec("finish", 12, 15, ["build"]), rec("build", 15, 20, ["review"]), rec("review", 20, 21, ["finish"]), rec("finish", 21, 25, []), rec("followup-1", 40, 50, [], { name: "Fix CI (#31) · auto 1/2" })],
      activity: [say(39, "Started Fix CI automatically (attempt 1 of 2)"), say(70, "PR #31 merged")],
    };
    const f = stepFacts({ step: STEP, cards: [card], closedAt: at(71), observedAt: at(71), readyAt: null });
    expect(f.finishBounces).toBe(1);
    expect(f.reviewRounds).toBe(2);
    expect(f.fixCi).toBe(1);
    expect(mins(f.phases!.fixup)).toBe(10);
    expect(mins(f.phases!.merge)).toBe(15 + 21); // 25 → 40 and 50 → 71
  });

  test("closed by hand, with no card: counted, with no cycle time and nothing guessed", () => {
    const f = stepFacts({ step: { ...STEP, human: true }, cards: [], closedAt: at(50), observedAt: at(55), readyAt: at(10) });
    expect(f).toMatchObject({ how: "no-card", startedAt: null, phases: null, reviewRounds: null, cardId: null, cards: 0, closedAt: at(50), readyAt: at(10) });
  });

  test("a card that only started after the issue closed isn't the step's work; GitHub's closing time wins, then the timeline's, then the pass", () => {
    const late = { ...threeRounds(), runStartedAt: at(200), records: [rec("build", 200, 210, [])] };
    expect(stepFacts({ step: STEP, cards: [late], closedAt: at(101), observedAt: at(300), readyAt: null }).how).toBe("no-card");
    expect(stepFacts({ step: STEP, cards: [threeRounds()], closedAt: null, observedAt: at(300), readyAt: null })).toMatchObject({ closedAt: at(101), closedFrom: "activity" });
    const silent = { ...threeRounds(), activity: [] };
    expect(stepFacts({ step: STEP, cards: [silent], closedAt: null, observedAt: at(300), readyAt: null })).toMatchObject({ closedAt: at(300), closedFrom: "observed" });
  });

  test("a step done again: the first card's time runs until the second starts", () => {
    const first: VelocityCard = { cardId: "one", runStartedAt: at(0), records: [rec("build", 0, 10, ["review"]), rec("review", 10, 12, [])], activity: [say(20, "PR #30 merged"), say(25, "Autopilot: step 2 (#12) — PR #30 merged but the issue is still open — close it or reopen the work. Not starting another card for it")] };
    const second: VelocityCard = { cardId: "two", runStartedAt: at(60), records: [rec("build", 60, 80, ["review"]), rec("review", 80, 85, [])], activity: [say(90, "PR #33 merged")] };
    const f = stepFacts({ step: STEP, cards: [second, first], closedAt: at(91), observedAt: at(91), readyAt: null });
    expect(f).toMatchObject({ cards: 2, cardId: "two", startedAt: at(0), reviewRounds: 2 });
    // merge 12–25 and 85–91; the owner's from the note (25) to the redo (60)
    expect({ build: mins(f.phases!.build), review: mins(f.phases!.review), merge: mins(f.phases!.merge), owner: mins(f.phases!.owner) }).toEqual({ build: 30, review: 7, merge: 19, owner: 35 });
  });

  test("a card with no step history has a cycle time and no breakdown", () => {
    const f = stepFacts({ step: STEP, cards: [{ cardId: "plain", runStartedAt: at(0), records: [], activity: [] }], closedAt: at(30), observedAt: at(30), readyAt: null });
    expect(f).toMatchObject({ how: "card", startedAt: at(0), phases: null, reviewRounds: null });
  });
});

describe("statistics", () => {
  test("quantiles interpolate between order statistics", () => {
    expect(quantile([1, 2, 3, 10], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 10], 0.75)).toBe(4.75);
    expect(quantile([1, 2, 3, 10], 0.9)).toBeCloseTo(7.9, 10);
  });
  test("zero, one and two values", () => {
    expect(distribution([])).toBeNull();
    expect(distribution([7])).toEqual({ n: 1, median: 7, p75: 7, p90: 7, min: 7, max: 7, mean: 7 });
    expect(distribution([10, 20])).toEqual({ n: 2, median: 15, p75: 17.5, p90: 19, min: 10, max: 20, mean: 15 });
  });
  test("the generator is deterministic", () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(43)()).not.toBe(rng(42)());
  });
});

describe("slot samples", () => {
  const s = (min: number, used: number, o: Partial<{ max: number; blocked: boolean; quota: boolean }> = {}) => ({ t: at(min), max: 8, used, blocked: false, quota: false, ready: 0, held: 0, ...o });

  test("each sample holds until the next; hours are split at the hour", () => {
    // T0 is 09:00. 4 slots for 50 min, then 8 for 20 min (10 of them after 10:00).
    const hours = foldSamples([s(0, 4), s(15, 4), s(30, 4), s(45, 4), s(50, 8)], at(70));
    expect(hours).toEqual([
      { t: at(0), known: 60 * MIN, slotMs: 8 * 60 * MIN, usedMs: (4 * 50 + 8 * 10) * MIN, blockedMs: 0, quotaMs: 0 },
      { t: at(60), known: 10 * MIN, slotMs: 8 * 10 * MIN, usedMs: 8 * 10 * MIN, blockedMs: 0, quotaMs: 0 },
    ]);
  });

  test("the app was closed: a gap between samples is unknown — not idle, not blocked", () => {
    // Blocked at minute 10, then nothing for three hours.
    const hours = foldSamples([s(0, 4), s(5, 4), s(10, 2, { blocked: true }), s(190, 6), s(195, 6)], at(200));
    const known = hours.reduce((a, h) => a + h.known, 0);
    expect(known).toBe(20 * MIN); // 0–10 and 190–200
    expect(hours.reduce((a, h) => a + h.blockedMs, 0)).toBe(0);
    expect(hours.reduce((a, h) => a + h.usedMs, 0)).toBe((4 * 10 + 6 * 10) * MIN);
  });

  test("the last sample holds until now only while now is close", () => {
    expect(foldSamples([s(0, 4)], at(10))[0]!.known).toBe(10 * MIN);
    expect(foldSamples([s(0, 4)], at(600))).toEqual([]);
  });

  test("folded hours and fresh ones add up", () => {
    const a = foldSamples([s(0, 4)], at(10));
    const b = foldSamples([s(10, 8)], at(20));
    expect(mergeHours(a, b)).toEqual([{ t: at(0), known: 20 * MIN, slotMs: 8 * 20 * MIN, usedMs: 120 * MIN, blockedMs: 0, quotaMs: 0 }]);
  });
});

// ── The report ────────────────────────────────────────────────────────────

const g = (step: string, issue: number, preds: string[], o: Partial<VelocityGraphStep> = {}): VelocityGraphStep => ({ step, issue, title: `Widget task ${issue}`, stage: "M01", human: false, preds, status: "open", closedAt: null, ...o });
const fact = (step: string, issue: number, closedHoursAgo: number, o: Partial<VelocityStepFacts> = {}): VelocityStepFacts => ({
  step,
  issue,
  stage: "M01",
  human: false,
  closedAt: NOW - closedHoursAgo * HOUR,
  closedFrom: "github",
  readyAt: null,
  how: "card",
  cardId: `card-${issue}`,
  cards: 1,
  startedAt: NOW - closedHoursAgo * HOUR - 2 * HOUR,
  prOpenedAt: null,
  mergedAt: null,
  phases: { build: 90 * MIN, merge: 30 * MIN },
  reviewRounds: 1,
  finishBounces: 0,
  fixCi: 0,
  quotaHits: 0,
  ...o,
});
const NOW = T0 + 10 * DAY;
const input = (o: Partial<VelocityInput>): VelocityInput => ({ now: NOW, tracker: 600, asOf: NOW, maxInFlight: 2, runStartedAt: NOW - 2 * DAY, steps: [], scope: null, view: "current", facts: [], open: [], samples: [], hours: [], seed: 7, ...o });
const done = (step: string, issue: number, hoursAgo: number, o: Partial<VelocityGraphStep> = {}) => g(step, issue, [], { status: "complete", closedAt: NOW - hoursAgo * HOUR, ...o });

describe("throughput", () => {
  // The run began two days ago. Agent steps closed 1h, 5h, 30h and 40h ago;
  // one of the owner's 3h ago; one agent step closed three days ago — before
  // the run.
  const steps = [done("1", 11, 1), done("2", 12, 5), done("3", 13, 30), done("4", 14, 40), done("5", 15, 3, { human: true, stage: "H" }), done("6", 16, 72), g("7", 17, ["1"])];
  const facts = [fact("1", 11, 1), fact("2", 12, 5), fact("3", 13, 30), fact("4", 14, 40), fact("5", 15, 3, { human: true, stage: "H", how: "no-card", startedAt: null, phases: null, reviewRounds: null, cardId: null }), fact("6", 16, 72)];
  const r = computeVelocity(input({ steps, facts }));

  test("per day, for agents and for the owner, in each window clipped to the run's age", () => {
    const w = Object.fromEntries(r.throughput.windows.map((x) => [x.key, x]));
    expect(w["24h"]).toMatchObject({ days: 1, agent: 2, owner: 1, agentPerDay: 2, ownerPerDay: 1 });
    expect(w["3d"]).toMatchObject({ days: 2, agent: 4, owner: 1, agentPerDay: 2, ownerPerDay: 0.5 });
    expect(w["7d"]).toMatchObject({ days: 2, agent: 4, agentPerDay: 2 });
    expect(w.all).toMatchObject({ days: 2, agent: 4, owner: 1 });
  });

  test("per hour over the last 24, and what the totals count", () => {
    expect(r.throughput.agentPerHour24).toBeCloseTo(2 / 24, 10);
    expect(r.throughput.hourly24[22]).toBe(1); // 1h ago
    expect(r.throughput.hourly24[18]).toBe(1); // 5h ago
    expect(r.throughput.hourly24.reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.totals).toMatchObject({ total: 7, complete: 6, open: 1, openAgent: 1, runAgent: 4, runOwner: 1, runNoCard: 1 });
  });

  test("by stage, and the burn-up starts from what was done before the run", () => {
    expect(r.throughput.byStage).toEqual([
      { stage: "M01", total: 6, complete: 5, inRun: 4, open: 1 },
      { stage: "H", total: 1, complete: 1, inRun: 1, open: 0 },
    ]);
    expect(r.burnup.total).toBe(7);
    expect(r.burnup.points[0]).toEqual({ t: NOW - 2 * DAY, done: 1 });
    expect(r.burnup.points.at(-1)).toEqual({ t: NOW, done: 6 });
    expect(r.burnup.points.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 6]);
  });

  test("a step closed by hand counts for throughput and has no cycle time", () => {
    expect(r.cycle.all!.n).toBe(4);
    expect(r.recent.find((x) => x.issue === 15)).toMatchObject({ how: "no-card", cycleMs: null });
  });

  test("an archived or deleted card changes nothing: the facts are the ledger's", () => {
    // Nothing in `open`, no card anywhere — the report rests on the facts alone.
    expect(r.cycle.all).toMatchObject({ n: 4, median: 2 * HOUR, min: 2 * HOUR, max: 2 * HOUR });
  });

  test("a reopened step, or one no longer in the tracker, is not counted", () => {
    const again = computeVelocity(input({ steps: steps.map((s) => (s.issue === 11 ? { ...s, status: "open" as const } : s)).filter((s) => s.issue !== 12), facts }));
    expect(again.totals.runAgent).toBe(2);
  });
});

describe("cycle time, lead time, rework and where the time goes", () => {
  // Cycle times of 1h, 2h, 3h and 10h; ready 30 min before each started.
  const mk = (issue: number, cycleH: number, closedHoursAgo: number, o: Partial<VelocityStepFacts> = {}) => {
    const closedAt = NOW - closedHoursAgo * HOUR;
    return fact(String(issue), issue, closedHoursAgo, { startedAt: closedAt - cycleH * HOUR, readyAt: closedAt - cycleH * HOUR - 30 * MIN, phases: { build: cycleH * HOUR * 0.5, review: cycleH * HOUR * 0.25, merge: cycleH * HOUR * 0.25 }, ...o });
  };
  const facts = [mk(11, 1, 2, { reviewRounds: 1 }), mk(12, 2, 4, { reviewRounds: 3, fixCi: 2 }), mk(13, 3, 6, { reviewRounds: 2, finishBounces: 1, stage: "M02" }), mk(14, 10, 8, { reviewRounds: 2, quotaHits: 1, stage: "M02" })];
  const steps = facts.map((f) => done(f.step, f.issue, (NOW - f.closedAt) / HOUR, { stage: f.stage }));
  const r = computeVelocity(input({ steps, facts }));

  test("cycle time: median, p75, p90, min and max; and per stage", () => {
    expect(r.cycle.all).toMatchObject({ n: 4, median: 2.5 * HOUR, p75: 4.75 * HOUR, min: HOUR, max: 10 * HOUR, mean: 4 * HOUR });
    expect(r.cycle.all!.p90).toBeCloseTo(7.9 * HOUR, 3);
    expect(r.cycle.byStage.map((s) => [s.stage, s.n, s.median / HOUR])).toEqual([
      ["M01", 2, 1.5],
      ["M02", 2, 6.5],
    ]);
    expect(r.cycle.histogram.filter((b) => b.count > 0).map((b) => [b.label, b.count])).toEqual([
      ["1–2h", 1],
      ["2–3h", 1],
      ["3–4h", 1],
      ["8–12h", 1],
    ]);
  });

  test("lead time is half an hour longer than each cycle", () => {
    expect(r.lead.all).toMatchObject({ n: 4, median: 3 * HOUR, min: 1.5 * HOUR, max: 10.5 * HOUR });
  });

  test("where the time goes: shares of the summed time, and flow efficiency", () => {
    const p = Object.fromEntries(r.time.phases.map((x) => [x.phase, x]));
    expect(r.time.n).toBe(4);
    expect(p.build).toMatchObject({ totalMs: 8 * HOUR, share: 0.5, active: true, medianMs: 1.25 * HOUR });
    expect(p.review).toMatchObject({ totalMs: 4 * HOUR, share: 0.25, active: true });
    expect(p.merge).toMatchObject({ totalMs: 4 * HOUR, share: 0.25, active: false });
    expect(r.time).toMatchObject({ activeMs: 12 * HOUR, waitingMs: 4 * HOUR, flowEfficiency: 0.75, stepsWithQuota: 1 });
  });

  test("rework: rounds per step, the share approved first time, bounces and Fix CI runs", () => {
    expect(r.rework).toEqual({
      n: 4,
      roundsAvg: 2,
      firstPass: 0.25,
      roundsDist: [
        { rounds: 1, steps: 1 },
        { rounds: 2, steps: 2 },
        { rounds: 3, steps: 1 },
      ],
      finishBounces: 1,
      stepsWithBounce: 1,
      fixCiRuns: 2,
      stepsWithFixCi: 1,
    });
  });

  test("nothing completed: every statistic is empty, nothing divides by zero", () => {
    const empty = computeVelocity(input({ steps: [g("1", 11, [])], facts: [] }));
    expect(empty.cycle.all).toBeNull();
    expect(empty.lead.all).toBeNull();
    expect(empty.time).toMatchObject({ n: 0, flowEfficiency: null });
    expect(empty.rework).toMatchObject({ n: 0, roundsAvg: null, firstPass: null });
    expect(empty.utilisation).toMatchObject({ avgUsed: null, share: null, blockedShare: null });
    expect(empty.forecast).toMatchObject({ ok: false });
    expect(JSON.stringify(empty)).not.toContain("NaN");
  });

  test("one and two completed steps", () => {
    const one = computeVelocity(input({ steps: steps.slice(0, 1), facts: facts.slice(0, 1) }));
    expect(one.cycle.all).toMatchObject({ n: 1, median: HOUR, p90: HOUR });
    const two = computeVelocity(input({ steps: steps.slice(0, 2), facts: facts.slice(0, 2) }));
    expect(two.cycle.all).toMatchObject({ n: 2, median: 1.5 * HOUR, p75: 1.75 * HOUR, p90: 1.9 * HOUR });
    expect(two.forecast.ok).toBe(false);
  });
});

describe("utilisation", () => {
  test("average slots in use, time-weighted, and how often the run was blocked", () => {
    const base = NOW - 15 * MIN;
    const samples = [
      { t: base, max: 8, used: 4, blocked: false, quota: false, ready: 0, held: 0 },
      { t: base + 5 * MIN, max: 8, used: 8, blocked: false, quota: false, ready: 1, held: 0 },
      { t: base + 10 * MIN, max: 8, used: 2, blocked: true, quota: false, ready: 0, held: 1 },
    ];
    const u = computeVelocity(input({ steps: [g("1", 11, [])], samples })).utilisation;
    expect(u.knownMs).toBe(15 * MIN);
    expect(u.unknownMs).toBe(0);
    expect(u.avgUsed).toBeCloseTo(14 / 3, 10);
    expect(u.avgMax).toBe(8);
    expect(u.share).toBeCloseTo(14 / 24, 10);
    expect(u.blockedShare).toBeCloseTo(1 / 3, 10);
    expect(u.series).toHaveLength(48);
  });

  test("three hours with the app closed are unknown, and don't count as blocked", () => {
    const base = NOW - 200 * MIN;
    const s = (min: number, used: number, blocked = false) => ({ t: base + min * MIN, max: 8, used, blocked, quota: false, ready: 0, held: 0 });
    const u = computeVelocity(input({ steps: [g("1", 11, [])], samples: [s(0, 4), s(5, 4), s(10, 2, true), s(190, 6), s(195, 6)] })).utilisation;
    expect(u.knownMs).toBe(20 * MIN);
    expect(u.unknownMs).toBe(180 * MIN);
    expect(u.blockedShare).toBe(0);
    expect(u.avgUsed).toBe(5);
  });
});

describe("bottlenecks", () => {
  // 1 → 2 → 3, 1 → 4; 5 is the owner's and gates 6; 7 stands alone.
  const steps = [g("1", 11, []), g("2", 12, ["1"]), g("3", 13, ["2"]), g("4", 14, ["1"]), g("5", 15, [], { human: true, stage: "H" }), g("6", 16, ["5"]), g("7", 17, [])];
  const r = computeVelocity(input({ steps, open: [{ issue: 11, state: "building", cardId: "c", startedAt: NOW - 3 * HOUR, since: null }], runStartedAt: NOW - 5 * HOUR }));

  test("the open steps that could move now, by how many steps wait behind them", () => {
    expect(r.bottlenecks.critical.map((b) => [b.step, b.successors, b.state])).toEqual([
      ["1", 3, "building"],
      ["5", 1, "yours"],
    ]);
    expect(r.bottlenecks.critical[0]!.inFlightMs).toBe(3 * HOUR);
  });

  test("steps waiting on the owner, and for how long", () => {
    expect(r.bottlenecks.owner.map((b) => [b.step, b.state, b.waitingOnYouMs])).toEqual([["5", "yours", 5 * HOUR]]);
    const held = computeVelocity(input({ steps, open: [{ issue: 11, state: "held", cardId: "c", startedAt: NOW - 3 * HOUR, since: NOW - HOUR }] }));
    expect(held.bottlenecks.owner.find((b) => b.step === "1")).toMatchObject({ state: "held", waitingOnYouMs: HOUR, successors: 3 });
  });
});

describe("the simulation", () => {
  const two = [{ cycle: 2 * HOUR, slot: 2 * HOUR }];
  const s = (id: string, preds: string[], o: Partial<{ human: boolean; elapsed: number | null }> = {}) => ({ id, human: false, preds, elapsed: null, ...o });

  test("a chain takes the sum; independent steps are limited by the slots", () => {
    expect(simulateOnce([s("a", []), s("b", ["a"]), s("c", ["b"])], 3, two, 0, rng(1))).toBe(6 * HOUR);
    expect(simulateOnce([s("a", []), s("b", []), s("c", [])], 3, two, 0, rng(1))).toBe(2 * HOUR);
    expect(simulateOnce([s("a", []), s("b", []), s("c", [])], 2, two, 0, rng(1))).toBe(4 * HOUR);
    expect(simulateOnce([s("a", []), s("b", []), s("c", [])], 1, two, 0, rng(1))).toBe(6 * HOUR);
  });

  test("a slot is free again once the card leaves it, before the step completes", () => {
    // One slot, held for 1h of a 2h cycle: starts at 0, 1h, 2h; the last completes at 4h.
    expect(simulateOnce([s("a", []), s("b", []), s("c", [])], 1, [{ cycle: 2 * HOUR, slot: HOUR }], 0, rng(1))).toBe(4 * HOUR);
  });

  test("the owner's step takes the assumed delay and no slot", () => {
    const chain = [s("a", []), s("h", ["a"], { human: true }), s("b", ["h"])];
    expect(simulateOnce(chain, 1, two, 0, rng(1))).toBe(4 * HOUR);
    expect(simulateOnce(chain, 1, two, 5 * HOUR, rng(1))).toBe(9 * HOUR);
    // It doesn't take the only slot: `x` runs alongside it.
    expect(simulateOnce([s("h", [], { human: true }), s("x", [])], 1, two, 2 * HOUR, rng(1))).toBe(2 * HOUR);
  });

  test("a step already in flight needs what is left of a longer cycle", () => {
    const samples = [{ cycle: HOUR, slot: HOUR }, { cycle: 3 * HOUR, slot: 3 * HOUR }];
    // 2h in: only the 3h sample is still possible → 1h left.
    expect(simulateOnce([s("a", [], { elapsed: 2 * HOUR })], 1, samples, 0, rng(1))).toBe(HOUR);
    // Longer than anything seen: a quarter of the time so far.
    expect(simulateOnce([s("a", [], { elapsed: 4 * HOUR })], 1, samples, 0, rng(1))).toBe(HOUR);
  });

  test("a step whose predecessor isn't among the steps given just starts", () => {
    expect(simulateOnce([s("b", ["gone"])], 1, two, 0, rng(1))).toBe(2 * HOUR);
  });
});

describe("the forecast", () => {
  // Five steps done, each in 2h (90 min building, 30 in the merge queue); a
  // chain of four agent steps left, then the owner's, then the release.
  const closed = [1, 2, 3, 4, 5].map((n) => done(String(n), 10 + n, n * 4));
  const facts = closed.map((s) => fact(s.step, s.issue, (NOW - s.closedAt!) / HOUR));
  const open = [g("6", 16, ["5"]), g("7", 17, ["6"]), g("8", 18, ["7"]), g("9", 19, ["8"]), g("10", 20, ["9"], { human: true, stage: "H", title: "[Human] Approve the widgets" }), g("11", 21, ["10"], { title: "Publish the main release", stage: "M02" })];
  const base = () => input({ steps: [...closed, ...open], facts, scope: { label: "M01", steps: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }, maxInFlight: 2 });

  test("below the minimum sample there is no forecast, and it says why", () => {
    const few = computeVelocity({ ...base(), facts: facts.slice(0, MIN_FORECAST_STEPS - 1) });
    expect(few.forecast.ok).toBe(false);
    expect(few.forecast.reason).toBe("4 steps completed with a measured cycle time — not enough for a forecast (it needs 5)");
    expect(few.forecast.targets).toEqual([]);
    expect(velocitySummary(few)).toBe("4 done · 2.0/day");
    // Enough steps, all in the three hours since the run began.
    const quick = closed.map((c, i) => ({ ...c, closedAt: NOW - (i + 1) * 30 * MIN }));
    const young = computeVelocity({ ...base(), runStartedAt: NOW - 3 * HOUR, steps: [...quick, ...open], facts: quick.map((c) => fact(c.step, c.issue, (NOW - c.closedAt) / HOUR)) });
    expect(young.forecast).toMatchObject({ ok: false, reason: "Only 3.0 hours of history — not enough for a forecast (it needs 6)" });
  });

  test("at the minimum: the scope, the release gate and the whole roadmap, each a range", () => {
    const f = computeVelocity(base()).forecast;
    expect(f.ok).toBe(true);
    expect(f.sample).toEqual({ steps: 5, days: 2 });
    expect(f.targets.map((t) => t.key)).toEqual(["scope", "gate", "roadmap"]);
    const [scope, gate, roadmap] = f.targets;
    // Four 2h steps in a chain: 8h, whatever the draw — every sample is 2h.
    expect(scope).toMatchObject({ label: "M01", remainingAgent: 4, ownerSteps: 0, ancestorsOutside: 0, unreachable: 0 });
    expect(scope!.sim).toMatchObject({ low: 8 * HOUR, high: 8 * HOUR });
    expect(scope!.simWithOwner).toBeNull();
    // The gate: those four, the owner's step, then itself — five agent steps.
    expect(gate).toMatchObject({ label: "the main-release gate (step 11)", remainingAgent: 5, ownerSteps: 1, ancestorsOutside: 4 });
    expect(gate!.sim).toMatchObject({ low: 10 * HOUR, high: 10 * HOUR });
    expect(roadmap).toMatchObject({ remainingAgent: 5, ownerSteps: 1 });
  });

  test("naive: remaining ÷ the recent rate, widened by its counting noise", () => {
    // 5 in 2 days (both windows): (5 ± √5) / 2 per day; 4 steps left.
    const naive = computeVelocity(base()).forecast.targets[0]!.naive!;
    expect(naive.method).toBe("rate-band");
    expect(naive.low / DAY).toBeCloseTo(4 / ((5 + Math.sqrt(5)) / 2), 10);
    expect(naive.high! / DAY).toBeCloseTo(4 / ((5 - Math.sqrt(5)) / 2), 10);
  });

  test("the owner's steps: counted on the path; no time unless assumed, the observed median once there are three", () => {
    const f = computeVelocity(base()).forecast;
    expect(f).toMatchObject({ ownerDelayMs: null, ownerDelayFrom: "unknown", ownerSample: 0 });
    expect(f.targets[1]!.simWithOwner).toBeNull();

    const set = computeVelocity({ ...base(), ownerDelayMs: 24 * HOUR }).forecast;
    expect(set).toMatchObject({ ownerDelayMs: 24 * HOUR, ownerDelayFrom: "you" });
    expect(set.targets[1]!.simWithOwner).toMatchObject({ low: 34 * HOUR, high: 34 * HOUR });
    expect(set.targets[1]!.sim).toMatchObject({ low: 10 * HOUR }); // still shown with no time

    // Three of the owner's steps finished 2h, 4h and 9h after they were ready.
    const owners = [2, 4, 9].map((h, i) => ({ step: g(String(20 + i), 40 + i, [], { human: true, stage: "H", status: "complete", closedAt: NOW - HOUR }), lead: h }));
    const seen = computeVelocity({ ...base(), steps: [...closed, ...open, ...owners.map((o) => o.step)], facts: [...facts, ...owners.map((o) => fact(o.step.step, o.step.issue, 1, { human: true, how: "no-card", startedAt: null, phases: null, reviewRounds: null, readyAt: NOW - HOUR - o.lead * HOUR }))] }).forecast;
    expect(seen).toMatchObject({ ownerDelayMs: 4 * HOUR, ownerDelayFrom: "observed", ownerSample: 3 });
    expect(seen.targets[1]!.simWithOwner).toMatchObject({ low: 14 * HOUR });
  });

  test("bracketed by how many slots have really been busy", () => {
    // Six independent steps, two slots, 90 min in a slot each (2h cycles).
    const wide = [1, 2, 3, 4, 5, 6].map((n) => g(String(20 + n), 40 + n, []));
    const samples = [0, 1].map((i) => ({ t: NOW - 7 * HOUR + i * 5 * MIN, max: 2, used: 1, blocked: false, quota: false, ready: 0, held: 0 }));
    const hours = Array.from({ length: 7 }, (_, i) => ({ t: Math.floor(NOW / HOUR) * HOUR - (i + 1) * HOUR, known: HOUR, slotMs: 2 * HOUR, usedMs: HOUR, blockedMs: 0, quotaMs: 0 }));
    const f = computeVelocity({ ...base(), steps: [...closed, ...wide], scope: null, samples, hours }).forecast;
    expect(f.busySlots).toMatchObject({ max: 2, from: "samples" });
    expect(f.busySlots!.avg).toBeCloseTo(1, 1);
    const t = f.targets[0]!;
    // Two slots: starts at 0, 0, 1.5h, 1.5h, 3h, 3h → done at 5h. One slot: the last starts at 7.5h → 9.5h.
    expect(t.sim).toMatchObject({ low: 5 * HOUR, high: 9.5 * HOUR, full: { low: 5 * HOUR, high: 5 * HOUR }, observed: { low: 9.5 * HOUR, high: 9.5 * HOUR } });
  });

  test("deterministic: the same input gives the same forecast; the seed decides the draw", () => {
    // Uneven cycle times, so the draw matters.
    const uneven = facts.map((f, i) => ({ ...f, startedAt: f.closedAt - (i + 1) * HOUR, phases: null }));
    const a = computeVelocity({ ...base(), facts: uneven });
    const b = computeVelocity({ ...base(), facts: uneven });
    expect(JSON.stringify(a.forecast)).toBe(JSON.stringify(b.forecast));
    expect(a.forecast.targets[0]!.sim!.low).toBeLessThan(a.forecast.targets[0]!.sim!.high);
    const other = computeVelocity({ ...base(), facts: uneven, seed: 8 });
    expect(JSON.stringify(other.forecast.targets[0]!.sim)).not.toBe(JSON.stringify(a.forecast.targets[0]!.sim));
    // Without a seed given, it is derived from the roadmap's state — still the same twice.
    const { seed: _s, ...unseeded } = { ...base(), facts: uneven };
    expect(JSON.stringify(computeVelocity(unseeded).forecast)).toBe(JSON.stringify(computeVelocity(unseeded).forecast));
  });

  test("steps behind a declined step can never start: left out, and said", () => {
    const steps = [...closed, g("6", 16, ["5"], { status: "declined" }), g("7", 17, ["6"]), g("8", 18, ["5"])];
    const f = computeVelocity({ ...base(), steps, scope: null }).forecast;
    expect(f.targets[0]).toMatchObject({ key: "roadmap", remainingAgent: 1, unreachable: 1 });
    expect(f.notes.join(" ")).toContain("behind a declined step");
  });

  test("the gate can be named by issue; a finished roadmap has nothing to forecast", () => {
    const named = computeVelocity({ ...base(), gateIssue: 18 }).forecast.targets.find((t) => t.key === "gate")!;
    expect(named).toMatchObject({ label: "the main-release gate (step 8)", remainingAgent: 3 });
    const finished = computeVelocity({ ...base(), steps: closed, scope: null }).forecast;
    expect(finished).toMatchObject({ ok: false, reason: "Every step is complete or declined — nothing left to forecast" });
  });

  test("the summary line quotes a range, never a date", () => {
    expect(velocitySummary(computeVelocity(base()))).toBe("5 done · 2.5/day · M01 ≈ 8 hours");
    expect(velocitySummary(computeVelocity({ ...base(), scope: null }))).toMatch(/^5 done · 2\.5\/day · release gate ≈ /);
  });
});

describe("words", () => {
  test("durations and ranges", () => {
    expect([fmtDuration(20_000), fmtDuration(42 * MIN), fmtDuration(3.5 * HOUR), fmtDuration(50 * HOUR), fmtDuration(null)]).toEqual(["<1m", "42m", "3.5h", "2.1d", "—"]);
    expect(fmtRange(2 * DAY, 4 * DAY)).toBe("2–4 days");
    expect(fmtRange(2 * DAY, 2.1 * DAY)).toBe("about 2 days");
    expect(fmtRange(3 * HOUR, 5 * HOUR)).toBe("3–5 hours");
    expect(fmtRange(8 * HOUR, 8 * HOUR)).toBe("about 8 hours");
    expect(fmtRange(10 * MIN, 20 * MIN)).toBe("about 1 hour");
    expect(fmtRange(5 * HOUR, 3 * DAY)).toBe("up to 3 days");
    expect(fmtRange(12 * DAY, null)).toBe("12 days or more");
    expect(fmtRange(11.6 * DAY, 30.2 * DAY)).toBe("12–30 days");
  });
});
