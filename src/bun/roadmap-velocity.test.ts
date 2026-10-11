// The velocity ledger: what a roadmap pass writes, that it is bounded, that
// it tolerates restarts and gaps, and that it outlives the cards. Synthetic
// roadmap, fake cards; the files go to a scratch directory.
import { test, expect, afterAll } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { Task } from "../shared/types.ts";
import type { VelocityCard, VelocityGraphStep } from "../shared/velocity.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-velocity-"));
process.env.AGETOR_DATA_DIR ??= DATA_DIR;

afterAll(() => void rmTestDataDir(DATA_DIR));

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (min: number) => T0 + min * MIN;
const PROJECT = "/tmp/widgets";
const TRACKER = 600;

const g = (step: string, issue: number, preds: string[], o: Partial<VelocityGraphStep> = {}): VelocityGraphStep => ({ step, issue, title: `Widget task ${issue}`, stage: "M01", human: false, preds, status: "open", closedAt: null, ...o });
const closedAt = (s: VelocityGraphStep, min: number): VelocityGraphStep => ({ ...s, status: "complete", closedAt: at(min) });
/** A card that built for `minutes` from `from` and merged ten minutes later. */
const card = (id: string, issue: number, from: number, minutes: number, extra: { ts: number; text: string }[] = []): VelocityCard => ({
  cardId: id,
  runStartedAt: at(from),
  records: [
    { stepId: "build", name: "Build", startedAt: at(from), endedAt: at(from + minutes - 5), outcome: "succeeded", blocked: false, next: ["review"] },
    { stepId: "review", name: "Review", startedAt: at(from + minutes - 5), endedAt: at(from + minutes), outcome: "succeeded", blocked: false, next: [] },
  ],
  activity: [{ ts: at(from), text: `Autopilot started this as step ${issue - 10} of roadmap #${TRACKER}` }, { ts: at(from + minutes + 10), text: "PR #9 merged" }, ...extra],
});

function setup(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `agetor-velocity-${name}-`));
  const cards = new Map<number, VelocityCard[]>();
  const asked: number[][] = [];
  const io: import("./roadmap-velocity.ts").VelocityIo = {
    dir,
    cardsFor: (_p: string, issues: ReadonlySet<number>) => {
      asked.push([...issues]);
      return new Map([...cards].filter(([n]) => issues.has(n)));
    },
    activity: () => [],
  };
  return { dir, cards, asked, io };
}
const sample = (used: number, o: Partial<{ blocked: boolean; quota: boolean; ready: number; held: number }> = {}) => ({ max: 4, used, blocked: false, quota: false, ready: 0, held: 0, ...o });
const pass = (steps: VelocityGraphStep[], now: number, o: Record<string, unknown> = {}) => ({ tracker: TRACKER, project: PROJECT, now, maxInFlight: 4, steps, scope: null, sample: sample(2), live: new Map<number, Task>(), held: new Set<number>(), stuck: new Map(), ...o });
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

test("first pass: backfills the steps already complete, from the cards that still exist", async () => {
  const { recordVelocityPass, velocityFiles, readLedger } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("backfill");
  // Step 1 was worked by a card; step 2 was closed by hand; step 3 is open; step 4's card was deleted.
  cards.set(11, [card("c-11", 11, 0, 60)]);
  const steps = [closedAt(g("1", 11, []), 71), closedAt(g("2", 12, [], { human: true, stage: "H" }), 90), g("3", 13, ["1"]), closedAt(g("4", 14, ["1"]), 200)];
  const r = recordVelocityPass(pass(steps, at(300)), io);
  expect(r).toEqual({ facts: 3, sample: true, compacted: false });

  const files = velocityFiles(TRACKER, PROJECT, dir);
  const ledger = readLedger(files.ledger);
  // The run began when Autopilot first said so in a card's timeline.
  expect(ledger.run).toEqual({ t: at(300), began: at(0) });
  expect(ledger.facts.get(11)).toMatchObject({ how: "card", cardId: "c-11", startedAt: at(0), closedAt: at(71), closedFrom: "github", readyAt: at(0), reviewRounds: 1, backfilled: true, phases: { build: 55 * MIN, review: 5 * MIN, merge: 11 * MIN } });
  // Closed by hand: counted, nothing invented.
  expect(ledger.facts.get(12)).toMatchObject({ how: "no-card", human: true, startedAt: null, phases: null, closedAt: at(90), backfilled: true });
  // Its card is gone: the same — unknown, not guessed. Ready when step 1 closed.
  expect(ledger.facts.get(14)).toMatchObject({ how: "no-card", startedAt: null, phases: null, readyAt: at(71) });
  expect(ledger.facts.has(13)).toBe(false);
  expect(ledger.samples).toEqual([{ t: at(300), max: 4, used: 2, blocked: false, quota: false, ready: 0, held: 0 }]);
  // The snapshot holds the roadmap as the pass saw it.
  const snap = JSON.parse(readFileSync(files.snapshot, "utf8"));
  expect(snap).toMatchObject({ t: at(300), tracker: TRACKER, maxInFlight: 4, scope: null, open: [] });
  expect(snap.steps).toHaveLength(4);
});

test("later passes: a step that completes is written once, at the time, and survives its card", async () => {
  const { recordVelocityPass, velocityFiles, readLedger, velocityAnswer } = await import("./roadmap-velocity.ts");
  const { io, cards, asked, dir } = setup("later");
  const open = [g("1", 11, []), g("2", 12, ["1"])];
  cards.set(11, [card("c-11", 11, 0, 60)]);
  recordVelocityPass(pass(open, at(5)), io);
  expect(asked).toHaveLength(1); // the first pass looks at every card once, for the run's start

  const done = [closedAt(open[0]!, 71), open[1]!];
  expect(recordVelocityPass(pass(done, at(72)), io)).toMatchObject({ facts: 1 });
  expect(asked[1]).toEqual([11]); // only the step that completed
  const files = velocityFiles(TRACKER, PROJECT, dir);
  expect(readLedger(files.ledger).facts.get(11)).toMatchObject({ how: "card", startedAt: at(0), closedAt: at(71) });
  expect(readLedger(files.ledger).facts.get(11)!.backfilled).toBeUndefined();

  // The card is archived, then deleted: nothing is asked again and the facts stand.
  cards.clear();
  expect(recordVelocityPass(pass(done, at(80)), io)).toMatchObject({ facts: 0 });
  expect(asked).toHaveLength(2);
  const a = velocityAnswer({ roadmap: { issue: TRACKER }, project: PROJECT, maxInFlight: 4 }, { dir, now: at(81) });
  expect(a.available).toBe(true);
  if (a.available) {
    expect(a.cycle.all).toMatchObject({ n: 1, median: 71 * MIN });
    expect(a.totals).toMatchObject({ complete: 1, open: 1, runAgent: 1 });
    expect(a.forecast).toMatchObject({ ok: false, reason: "1 step completed with a measured cycle time — not enough for a forecast (it needs 5)" });
  }
});

test("a card from before the run isn't this run's work on the step", async () => {
  const { recordVelocityPass, velocityFiles, readLedger } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("old-card");
  // An abandoned attempt weeks ago (no roadmap entry), and the run's own card.
  const old: VelocityCard = { cardId: "old", runStartedAt: at(-30_000), records: [{ stepId: "build", name: "Build", startedAt: at(-30_000), endedAt: at(-29_000), outcome: "succeeded", blocked: false, next: [] }], activity: [] };
  cards.set(11, [old, card("c-11", 11, 0, 60)]);
  recordVelocityPass(pass([closedAt(g("1", 11, []), 71)], at(100)), io);
  expect(readLedger(velocityFiles(TRACKER, PROJECT, dir).ledger).facts.get(11)).toMatchObject({ cards: 1, cardId: "c-11", startedAt: at(0) });
});

test("samples: written on a change and as a heartbeat; an identical state in between is not", async () => {
  const { recordVelocityPass, velocityFiles, readLedger, HEARTBEAT_MS } = await import("./roadmap-velocity.ts");
  const { io, dir } = setup("samples");
  const steps = [g("1", 11, [])];
  expect(recordVelocityPass(pass(steps, at(0)), io).sample).toBe(true);
  expect(recordVelocityPass(pass(steps, at(1)), io).sample).toBe(false); // nothing changed, a minute later
  expect(recordVelocityPass(pass(steps, at(2), { sample: sample(3) }), io).sample).toBe(true); // a slot filled
  expect(recordVelocityPass(pass(steps, at(2) + HEARTBEAT_MS, { sample: sample(3) }), io).sample).toBe(true); // heartbeat
  // More cards than slots (a priority card) is still at most `max`.
  recordVelocityPass(pass(steps, at(20), { sample: sample(9, { blocked: true }) }), io);
  const s = readLedger(velocityFiles(TRACKER, PROJECT, dir).ledger).samples;
  expect(s.map((x) => [x.t, x.used, x.blocked])).toEqual([
    [at(0), 2, false],
    [at(2), 3, false],
    [at(2) + HEARTBEAT_MS, 3, false],
    [at(20), 4, true],
  ]);
});

test("the app was closed for hours: the gap is unknown time, and the ledger carries on", async () => {
  const { recordVelocityPass, velocityAnswer } = await import("./roadmap-velocity.ts");
  const { io, dir } = setup("gap");
  const steps = [g("1", 11, [])];
  // Blocked when the app quit at minute 10; back three hours later.
  recordVelocityPass(pass(steps, at(0), { sample: sample(2) }), io);
  recordVelocityPass(pass(steps, at(5), { sample: sample(2) }), io);
  recordVelocityPass(pass(steps, at(10), { sample: sample(0, { blocked: true }) }), io);
  recordVelocityPass(pass(steps, at(190), { sample: sample(4) }), io);
  recordVelocityPass(pass(steps, at(195), { sample: sample(4) }), io);
  const a = velocityAnswer({ roadmap: { issue: TRACKER }, project: PROJECT, maxInFlight: 4 }, { dir, now: at(200) });
  if (!a.available) throw new Error(a.reason);
  expect(a.utilisation.knownMs).toBe(20 * MIN);
  expect(a.utilisation.unknownMs).toBe(180 * MIN);
  expect(a.utilisation.blockedShare).toBe(0); // the three hours are not "blocked"
  expect(a.utilisation.avgUsed).toBe(3); // (2×10 + 4×10) / 20
});

test("bounded: past its size limit the ledger is compacted — facts kept, old samples folded into hours", async () => {
  const { recordVelocityPass, velocityFiles, readLedger, velocityAnswer } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("bounded");
  io.limits = { maxBytes: 4_000, keepSamples: 12, keepHours: 6 };
  cards.set(11, [card("c-11", 11, 0, 60)]);
  const steps = [closedAt(g("1", 11, []), 71), g("2", 12, ["1"])];
  const files = velocityFiles(TRACKER, PROJECT, dir);
  let compactions = 0;
  let largest = 0;
  // Two days of passes, one every five minutes, alternating 1 and 3 slots in use.
  for (let i = 0; i < 576; i++) {
    const r = recordVelocityPass(pass(steps, at(100 + i * 5), { sample: sample(i % 2 ? 3 : 1) }), io);
    if (r.compacted) compactions++;
    largest = Math.max(largest, statSync(files.ledger).size);
  }
  expect(compactions).toBeGreaterThan(5);
  // Never more than the limit plus one pass's lines.
  expect(largest).toBeLessThan(4_000 + 400);
  const ledger = readLedger(files.ledger);
  expect(ledger.samples.length).toBeLessThanOrEqual(12 + 40);
  expect(ledger.hours.length).toBeLessThanOrEqual(6);
  expect(ledger.run).toEqual({ t: at(100), began: at(0) });
  expect(ledger.facts.get(11)).toMatchObject({ how: "card", closedAt: at(71) }); // the facts survive every compaction
  expect(lines(files.ledger).filter((l) => l.k === "step")).toHaveLength(1);
  // What is left still reads as 2 of 4 slots in use.
  const a = velocityAnswer({ roadmap: { issue: TRACKER }, project: PROJECT, maxInFlight: 4 }, { dir, now: at(100 + 576 * 5) });
  if (!a.available) throw new Error(a.reason);
  expect(a.utilisation.avgUsed).toBeCloseTo(2, 1);
  expect(a.utilisation.knownMs).toBeLessThanOrEqual(7 * HOUR + 12 * 5 * MIN);
  expect(JSON.stringify(a).length).toBeLessThan(40_000);
});

test("what the passes saw a card doing ends up in its step's facts: blocked on the owner inside a step", async () => {
  const { recordVelocityPass, velocityFiles, readLedger } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("observed");
  const steps = [g("1", 11, [])];
  const task = (status: string, extra: Record<string, unknown> = {}) =>
    ({ id: "c-11", column: "running", pendingInteractionCount: 0, runId: "r", createdAt: at(0), pipelineRun: { status, startedAt: at(0), history: [{ seq: 1, stepId: "build", taskId: "s", startedAt: at(0), endedAt: null, outcome: null, handoff: null, nextStepIds: [] }], snapshot: null, active: [], blocked: [], ...extra } }) as never as Task;
  const live = (t: Task) => ({ live: new Map([[11, t]]) });
  recordVelocityPass(pass(steps, at(1), live(task("running"))), io);
  recordVelocityPass(pass(steps, at(20), live(task("blocked"))), io); // it asked a question
  recordVelocityPass(pass(steps, at(25), live(task("blocked"))), io); // still waiting: no new event
  recordVelocityPass(pass(steps, at(50), live(task("running"))), io); // answered
  recordVelocityPass(pass(steps, at(55), live(task("blocked", { autoRetry: { stepId: "build", kind: "quota", attempt: 1, at: at(70), reason: "limit" } }))), io);
  recordVelocityPass(pass(steps, at(70), live(task("running"))), io);
  const files = velocityFiles(TRACKER, PROJECT, dir);
  expect(lines(files.ledger).filter((l) => l.k === "c").map((l) => [l.t, l.state])).toEqual([
    [at(1), "building"],
    [at(20), "blocked"],
    [at(50), "building"],
    [at(55), "quota"],
    [at(70), "building"],
  ]);
  // The run's history shows one Build from 0 to 90 — the ledger knows better.
  cards.set(11, [{ cardId: "c-11", runStartedAt: at(0), records: [{ stepId: "build", name: "Build", startedAt: at(0), endedAt: at(90), outcome: "succeeded", blocked: false, next: [] }], activity: [{ ts: at(99), text: "PR #9 merged" }] }]);
  recordVelocityPass(pass([closedAt(steps[0]!, 100)], at(101)), io);
  expect(readLedger(files.ledger).facts.get(11)).toMatchObject({ phases: { build: 45 * MIN, owner: 30 * MIN, quota: 15 * MIN, merge: 10 * MIN } });
});

test("a card parked in the blocked-step wait queue is waiting, not blocked on the owner: its time isn't the owner's", async () => {
  const { recordVelocityPass, velocityFiles, readLedger, velocityAnswer } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("queued");
  const steps = [g("1", 11, []), g("2", 12, ["1"])];
  const wait = (state: string) => ({ stepId: "build", taskId: "s", category: "unknown", source: "none", what: "its own stated reason", ref: null, reason: "the fixture service did not come up", state, since: at(20), attempt: 0, max: 3, at: at(35), deadline: at(2000), tried: [] });
  const task = (status: string, extra: Record<string, unknown> = {}) =>
    ({ id: "c-11", column: status === "blocked" ? "blocked" : "running", pendingInteractionCount: 0, runId: "r", createdAt: at(0), pipelineRun: { status, startedAt: at(0), history: [{ seq: 1, stepId: "build", taskId: "s", startedAt: at(0), endedAt: null, outcome: null, handoff: null, nextStepIds: [] }], snapshot: null, active: [], blocked: [], ...extra } }) as never as Task;
  const live = (t: Task) => ({ live: new Map([[11, t]]) });
  recordVelocityPass(pass(steps, at(1), live(task("running"))), io);
  recordVelocityPass(pass(steps, at(20), live(task("blocked", { wait: wait("waiting") }))), io); // parked
  // While parked it shows as waiting — and not among what waits on the owner.
  const mid = velocityAnswer({ roadmap: { issue: TRACKER }, project: PROJECT, maxInFlight: 4 }, { dir, now: at(30) });
  if (!mid.available) throw new Error(mid.reason);
  expect(mid.bottlenecks.owner).toEqual([]);
  expect(mid.bottlenecks.critical.map((b) => [b.step, b.state, b.waitingOnYouMs])).toEqual([["1", "waiting", null]]);
  recordVelocityPass(pass(steps, at(35), live(task("running", { wait: wait("resuming") }))), io); // resumed
  recordVelocityPass(pass(steps, at(50), live(task("blocked", { wait: wait("escalated") }))), io); // gave up: the owner's
  recordVelocityPass(pass(steps, at(80), live(task("running"))), io);
  const files = velocityFiles(TRACKER, PROJECT, dir);
  expect(lines(files.ledger).filter((l) => l.k === "c").map((l) => [l.t, l.state])).toEqual([
    [at(1), "building"],
    [at(20), "waiting"],
    [at(35), "building"],
    [at(50), "blocked"],
    [at(80), "building"],
  ]);
  cards.set(11, [{ cardId: "c-11", runStartedAt: at(0), records: [{ stepId: "build", name: "Build", startedAt: at(0), endedAt: at(90), outcome: "succeeded", blocked: false, next: [] }], activity: [{ ts: at(99), text: "PR #9 merged" }] }]);
  recordVelocityPass(pass([closedAt(steps[0]!, 100), steps[1]!], at(101)), io);
  // 15 minutes in the queue are "other"; the 30 after it gave up are the owner's.
  expect(readLedger(files.ledger).facts.get(11)).toMatchObject({ phases: { build: 45 * MIN, other: 15 * MIN, owner: 30 * MIN, merge: 10 * MIN } });
});

test("the snapshot lists what is in flight and what waits on the owner", async () => {
  const { recordVelocityPass, velocityAnswer } = await import("./roadmap-velocity.ts");
  const { io, dir } = setup("open");
  const steps = [g("1", 11, []), g("2", 12, ["1"]), g("3", 13, []), g("4", 14, ["3"]), g("5", 15, ["3"])];
  const run = { status: "done", startedAt: at(0), history: [{ seq: 1, stepId: "build", taskId: "s", startedAt: at(0), endedAt: at(30), outcome: "succeeded", handoff: null, nextStepIds: [] }], snapshot: null, active: [], blocked: [] };
  const held = { id: "c-11", column: "review", pendingInteractionCount: 0, runId: "r", createdAt: at(0), pipelineRun: run } as never as Task;
  io.activity = () => [{ ts: at(40), text: "Autopilot: PR #7 changes sensitive code (auth/login.ts) — left in In Review for you to sign off" }] as never;
  recordVelocityPass(pass(steps, at(100), { live: new Map([[11, held]]), held: new Set([11]), stuck: new Map([[13, { at: at(60), cardId: "c-13" }]]) }), io);
  const a = velocityAnswer({ roadmap: { issue: TRACKER }, project: PROJECT, maxInFlight: 4 }, { dir, now: at(100) });
  if (!a.available) throw new Error(a.reason);
  expect(a.bottlenecks.owner.map((b) => [b.step, b.state, b.waitingOnYouMs, b.successors])).toEqual([
    ["1", "held", 60 * MIN, 1],
    ["3", "stuck", 40 * MIN, 2],
  ]);
  expect(a.bottlenecks.critical.map((b) => b.step)).toEqual(["3", "1"]);
  expect(a.totals.inFlight).toBe(1);
});

test("restarts and damage: a torn last line is skipped, and nothing is written twice", async () => {
  const { recordVelocityPass, velocityFiles, readLedger } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("torn");
  cards.set(11, [card("c-11", 11, 0, 60)]);
  const steps = [closedAt(g("1", 11, []), 71)];
  recordVelocityPass(pass(steps, at(80)), io);
  const files = velocityFiles(TRACKER, PROJECT, dir);
  appendFileSync(files.ledger, '{"k":"s","t":123,"ma'); // the core stopped mid-write
  appendFileSync(files.ledger, "\n");
  // A "restart": everything is read back from the file.
  expect(recordVelocityPass(pass(steps, at(90)), io)).toMatchObject({ facts: 0 });
  const ledger = readLedger(files.ledger);
  expect(ledger.facts.size).toBe(1);
  expect(ledger.samples.map((s) => s.t)).toEqual([at(80), at(90)]);
  expect(lines(files.ledger).filter((l) => l.k === "run")).toHaveLength(1);
});

test("no tracker, or no pass yet: the answer says so", async () => {
  const { velocityAnswer, velocityFiles } = await import("./roadmap-velocity.ts");
  const { dir } = setup("none");
  expect(velocityAnswer({ roadmap: null, project: PROJECT, maxInFlight: 4 }, { dir })).toEqual({ available: false, reason: "Autopilot isn't working a roadmap — set a tracker issue first" });
  expect(velocityAnswer({ roadmap: { issue: TRACKER }, project: PROJECT, maxInFlight: 4 }, { dir })).toMatchObject({ available: false });
  // Another project's tracker #600 is another ledger.
  expect(velocityFiles(TRACKER, "/tmp/widgets/", dir).ledger).toBe(velocityFiles(TRACKER, PROJECT, dir).ledger);
  expect(velocityFiles(TRACKER, "/tmp/gadgets", dir).ledger).not.toBe(velocityFiles(TRACKER, PROJECT, dir).ledger);
  expect(existsSync(velocityFiles(TRACKER, PROJECT, dir).ledger)).toBe(false);
});

// ── Through a real roadmap pass ───────────────────────────────────────────

test("a roadmap pass writes the ledger: the slots as they stand, blocked or not, and the step that completed — within its bounds", async () => {
  const { roadmapPass, readState } = await import("./autopilot.ts");
  const { recordVelocityPass, velocityFiles, readLedger, velocityAnswer } = await import("./roadmap-velocity.ts");
  const { io, cards, dir } = setup("pass");
  io.limits = { maxBytes: 3_000, keepSamples: 10, keepHours: 4 };
  const BODY = [
    "## Numbered completion order",
    "| Step | Task and outcome | Milestone | Predecessor steps |",
    "| --- | --- | --- | --- |",
    "| 1 | #11 [Human] Provide the sample device | H | none |",
    "| 2 | #12 Inventory the widgets | M01 | none |",
    "| 3 | #13 Build the widget store | M01 | 2 |",
    "| 4 | #14 Wire the widget API | M01 | 2 |",
    "| 5 | #15 Ship the widget page | M01 | 3, 4 |",
  ].join("\n");
  type State = import("../shared/roadmap.ts").RoadmapIssueState;
  const states: Record<number, State> = {};
  let now = at(10);
  const started: number[] = [];
  const running = (id: string, n: number, from: number) =>
    ({ id, title: `Issue #${n}`, prompt: "", workdir: PROJECT, runId: "r", issueUrl: `https://github.com/o/r/issues/${n}`, column: "running", archivedAt: null, pipelineParentId: null, pendingInteractionCount: 0, prUrl: null, worktreePath: "/wt", baseRef: "abc", createdAt: at(from), updatedAt: at(from), pipelineRun: { status: "running", startedAt: at(from), active: [{ stepId: "build", taskId: "s", seq: 1 }], blocked: [], joins: {}, snapshot: null, history: [{ seq: 1, stepId: "build", taskId: "s", startedAt: at(from), endedAt: null, outcome: null, handoff: null, nextStepIds: [] }] } }) as never as Task;
  const deps: import("./autopilot.ts").RoadmapDeps = {
    loadTracker: async () => ({ body: BODY, url: "https://github.com/o/r/issues/600" }),
    loadStates: async (_p, numbers) => new Map(numbers.map((n) => [n, { milestone: null, ...(states[n] ?? { state: "OPEN" as const, stateReason: null }), url: `https://github.com/o/r/issues/${n}` }])),
    aheadCount: async () => 0,
    hasNoPr: () => true,
    mergedPr: () => null,
    prBody: async () => null,
    handsOff: () => new Set<string>(),
    quotaPaused: () => false,
    pipelineId: () => "p",
    startCard: async ({ number }) => {
      started.push(number);
      return { task: running(`c-${number}`, number, (now - T0) / MIN) };
    },
    createBacklogCard: async () => ({ error: "not in this test" }),
    startExisting: async () => ({ ok: true }),
    moveToDone: () => {},
    save: () => {},
    outdated: () => false,
    setScope: () => true,
    notify: () => true,
    activity: () => {},
    recheck: () => {},
    velocity: (input) => void recordVelocityPass(input, io),
    now: () => now,
  };
  const cfg = { enabled: true, threadId: "", project: PROJECT, milestone: null, milestones: [], maxInFlight: 2, pipelineId: "p", roadmap: { issue: TRACKER }, autoContinue: false };
  const state = { ...readState(), phase: "idle" as const, cards: [] as string[] };
  const files = velocityFiles(TRACKER, PROJECT, dir);

  // Pass 1: nothing is running; step 2 is the only agent step that can start.
  await roadmapPass(cfg, state, [], [], deps);
  expect(started).toEqual([12]);
  expect(readLedger(files.ledger).samples).toEqual([{ t: at(10), max: 2, used: 1, blocked: true, quota: false, ready: 0, held: 1 }]);

  // Passes 2…: step 2 builds for an hour. One slot is idle and nothing can
  // fill it — steps 3 and 4 wait on step 2 — so the run reads as blocked.
  const c12 = running("c-12", 12, 10);
  for (let i = 1; i <= 12; i++) {
    now = at(10 + i * 5);
    await roadmapPass(cfg, state, [c12], [c12], deps);
  }
  let ledger = readLedger(files.ledger);
  expect(ledger.samples.every((s) => s.used === 1 && s.blocked && s.max === 2)).toBe(true);
  expect(ledger.cards.get(12)).toEqual([{ t: at(15), state: "building" }]);
  expect(JSON.parse(readFileSync(files.snapshot, "utf8")).open).toEqual([{ issue: 12, state: "building", cardId: "c-12", startedAt: at(10), since: null }]);

  // Step 2's PR merges and its issue closes: GitHub says when.
  states[12] = { state: "CLOSED", stateReason: "COMPLETED", closedAt: at(72) };
  cards.set(12, [{ cardId: "c-12", runStartedAt: at(10), records: [{ stepId: "build", name: "Build", startedAt: at(10), endedAt: at(60), outcome: "succeeded", blocked: false, next: [] }], activity: [{ ts: at(71), text: "PR #9 merged" }] }]);
  now = at(75);
  await roadmapPass(cfg, state, [{ ...c12, column: "done" } as Task], [{ ...c12, column: "done" } as Task], deps);
  expect(started).toEqual([12, 13, 14]); // its successors start, and fill both slots
  ledger = readLedger(files.ledger);
  expect(ledger.samples.at(-1)).toEqual({ t: at(75), max: 2, used: 2, blocked: false, quota: false, ready: 0, held: 1 });
  expect(ledger.facts.get(12)).toMatchObject({ step: "2", stage: "M01", how: "card", startedAt: at(10), closedAt: at(72), closedFrom: "github", readyAt: at(10), phases: { build: 50 * MIN, merge: 12 * MIN } });

  // Two more days of passes: the file stays within its bounds.
  const c13 = running("c-13", 13, 75);
  const c14 = running("c-14", 14, 75);
  let largest = 0;
  for (let i = 1; i <= 576; i++) {
    now = at(75 + i * 5);
    await roadmapPass(cfg, state, [c13, c14], [c13, c14], deps);
    largest = Math.max(largest, statSync(files.ledger).size);
  }
  expect(largest).toBeLessThan(3_000 + 400);
  ledger = readLedger(files.ledger);
  expect(ledger.facts.get(12)).toMatchObject({ how: "card", closedAt: at(72) });
  expect(ledger.hours.length).toBeLessThanOrEqual(4);

  const a = velocityAnswer(cfg, { dir, now });
  if (!a.available) throw new Error(a.reason);
  expect(a.totals).toMatchObject({ total: 5, complete: 1, inFlight: 2, runAgent: 1, openOwner: 1 });
  expect(a.cycle.all).toMatchObject({ n: 1, median: 62 * MIN });
  expect(a.utilisation.share).toBe(1); // what is left of the samples: both slots busy
  expect(a.bottlenecks.critical.map((b) => [b.step, b.state, b.successors])).toEqual([
    ["3", "building", 1],
    ["4", "building", 1],
  ]);
  expect(a.bottlenecks.owner.map((b) => [b.step, b.state])).toEqual([["1", "yours"]]);
});
