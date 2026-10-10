import { expect, test } from "bun:test";
import { acceptPicks, auditPrompt, nextPrompt, parseConfig } from "./autopilot.ts";
import { taggedJson } from "./codex-thread.ts";

test("parseConfig: defaults to off, 5 in flight, clamps to 10", () => {
  expect(parseConfig(null)).toMatchObject({ enabled: false, maxInFlight: 5, milestone: null });
  expect(parseConfig(JSON.stringify({ enabled: true, maxInFlight: 40, milestone: { number: 2, title: "1.0 / 2" } }))).toMatchObject({
    enabled: true,
    maxInFlight: 10,
    milestone: { number: 2, title: "1.0 / 2" },
  });
});

test("taggedJson reads the block the thread ends with", () => {
  const text = 'Thinking…\n<next-issues>[{"number": 12, "scope": "- do x"}]</next-issues>';
  expect(taggedJson<unknown>(text, "next-issues")).toEqual([{ number: 12, scope: "- do x" }]);
  expect(taggedJson<unknown>("no block", "next-issues")).toBeNull();
  expect(taggedJson<unknown>("<audit>{not json}</audit>", "audit")).toBeNull();
});

test("acceptPicks keeps open, unworked, unique picks within the free slots", () => {
  const open = new Set([1, 2, 3, 4]);
  const busy = new Set([2]);
  const picks = [{ number: 2, scope: "busy" }, { number: 9, scope: "closed" }, { number: 1, scope: "a" }, { number: 1, scope: "dup" }, { number: 3, scope: "b" }, { number: 4, scope: "c" }];
  expect(acceptPicks(picks, open, busy, 2)).toEqual([{ number: 1, scope: "a" }, { number: 3, scope: "b" }]);
  expect(acceptPicks("nope", open, busy, 2)).toEqual([]);
});

test("prompts ask for the machine-readable block and name the milestone", () => {
  const p = nextPrompt("1.0 / 2", [{ number: 5, title: "x" }], [], 3);
  expect(p).toContain('"1.0 / 2"');
  expect(p).toContain("#5 x");
  expect(p).toContain("<next-issues>");
  expect(auditPrompt("1.0 / 2")).toContain("<audit>");
});

test("a pass runs when a card stops building or reaches Done — not on other moves", async () => {
  const { freesSlot } = await import("./autopilot.ts");
  expect(freesSlot({ kind: "column", prev: "running", column: "review" })).toBe(true);
  expect(freesSlot({ kind: "column", prev: "blocked", column: "merge" })).toBe(true);
  expect(freesSlot({ kind: "column", prev: "merge", column: "done" })).toBe(true);
  expect(freesSlot({ kind: "column", prev: "ready", column: "running" })).toBe(false);
  expect(freesSlot({ kind: "column", prev: "review", column: "merge" })).toBe(false);
  expect(freesSlot({ kind: "run-status" })).toBe(false);
});

test("the next-issues prompt asks to fill every free slot", () => {
  expect(nextPrompt("m", [{ number: 1, title: "a" }], [], 4)).toContain("Pick 4 issue(s)");
});

test("run-last issues wait until they're the only ones open", async () => {
  const { startable } = await import("./autopilot.ts");
  const gate = { number: 561, labels: [{ name: "run-last" }] };
  const work = { number: 400, labels: [{ name: "testing" }] };
  expect(startable([gate, work]).map((i) => i.number)).toEqual([400]);
  expect(startable([gate]).map((i) => i.number)).toEqual([561]);
});

test("a pipeline run stopping on a block frees a slot", async () => {
  const { freesSlot } = await import("./autopilot.ts");
  expect(freesSlot({ kind: "pipeline", status: "blocked" })).toBe(true);
  expect(freesSlot({ kind: "pipeline", status: "running" })).toBe(false);
  expect(freesSlot({ kind: "column", prev: "running", column: "blocked" })).toBe(true);
});

test("only progressing cards hold slots; stopped ones keep their issue busy", async () => {
  const { slotCounts } = await import("./autopilot.ts");
  type T = import("../shared/types.ts").Task;
  const card = (id: string, n: number, column: string, extra: Record<string, unknown> = {}) =>
    ({ id, issueUrl: `https://github.com/o/r/issues/${n}`, column, archivedAt: null, pipelineParentId: null, pendingInteractionCount: 0, pipelineRun: null, ...extra }) as never as T;
  const run = (status: string, autoRetry?: unknown) => ({ status, active: [{ stepId: "build", taskId: `step-${status}`, seq: 1 }], blocked: [], history: [], joins: {}, autoRetry });
  const all = [
    card("a", 1, "running", { pipelineRun: run("running") }), // progressing
    card("b", 2, "blocked", { pipelineRun: run("blocked") }), // blocked column
    card("c", 3, "running", { pipelineRun: run("blocked") }), // run blocked, column lagging
    card("d", 4, "running", { pipelineRun: run("running"), pendingInteractionCount: 1 }), // asks the user
    card("e", 5, "ready"), // queued, progressing
    card("f", 6, "review"),
    card("g", 7, "running", { archivedAt: 1 }),
  ];
  const open = [1, 2, 3, 4, 5, 6, 7, 8].map((number) => ({ number, title: `#${number}` }));
  const c = slotCounts(all, all.slice(0, 5), open);
  expect([...c.busyIssues].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  expect(c.inFlight.map((i) => i.number)).toEqual([1, 5]);
  expect(c.ownLive).toBe(2);
  expect(c.ownUnfinished).toBe(5);
  expect(c.quotaWait).toBe(false);

  // Waiting for a usage-limit reset: no slot, and Autopilot holds new starts.
  const waiting = card("h", 8, "blocked", { pipelineRun: run("blocked", { stepId: "build", kind: "quota", attempt: 1, at: Date.now() + 60_000, reason: "limit" }) });
  const q = slotCounts([...all, waiting], [waiting], open);
  expect(q.ownLive).toBe(0);
  expect(q.busyIssues.has(8)).toBe(true);
  expect(q.quotaWait).toBe(true);

  // A live session paused mid-turn on claude's limit counts the same.
  const paused = slotCounts(all, all.slice(0, 1), open, (t) => t.pipelineRun?.active[0]?.taskId === "step-running");
  expect(paused.ownLive).toBe(0);
  expect(paused.quotaWait).toBe(true);
});

test("a Codex usage-limit answer from the thread backs off to the reset", async () => {
  const { threadLimit } = await import("./codex-thread.ts");
  const now = new Date(2026, 9, 6, 22, 0).getTime();
  const l = threadLimit("ERROR: You've hit your usage limit. Try again at 11:45 PM.", now)!;
  expect(l.until).toBe(new Date(2026, 9, 6, 23, 50).getTime());
  expect(threadLimit("ERROR: You've hit your usage limit. Try again later.", now)!.until).toBe(now + 30 * 60_000);
  expect(threadLimit("thread not found", now)).toBeNull();
});

// ── Cards that end with nothing to build (#405, #407) ──────────────────────
type TaskT = import("../shared/types.ts").Task;
type Deps = import("./autopilot.ts").NoWorkDeps;

const handoffRun = (status = "done") => ({
  status,
  active: [],
  blocked: [],
  joins: {},
  history: [{ stepId: "u", taskId: "s", seq: 1, outcome: "succeeded", handoff: { summary: "Acceptance is owned by #410's deployed run", reason: "Nothing to build", openQuestions: ["Is the live setup done?"], next: null } }],
});
const noWorkCard = (id: string, n: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Issue #${n}`, issueUrl: `https://github.com/o/r/issues/${n}`, column: "review", archivedAt: null, pipelineParentId: null, prUrl: null, pipelineRun: handoffRun(), worktreePath: "/wt", baseRef: "abc", ...extra }) as never as TaskT;

function fakeDeps(answers: (string | { ok: false; busy?: boolean; error: string })[], over: Partial<Deps> = {}) {
  const log = { asked: [] as string[], gh: [] as string[][], started: [] as { number: number; scope: string }[], done: [] as string[], activity: [] as string[] };
  const deps: Deps = {
    aheadCount: async () => 0,
    hasNoPr: () => true,
    ask: async (prompt) => {
      log.asked.push(prompt);
      const a = answers.shift() ?? "no answer";
      return typeof a === "string" ? { ok: true, text: a } : { text: "", ...a };
    },
    gh: async (args) => {
      log.gh.push(args);
      return { ok: true, stdout: args[1] === "view" ? "CLOSED" : "" };
    },
    startCard: async ({ number, scope }) => {
      log.started.push({ number, scope });
      return { task: { id: `rework-${number}` } as TaskT };
    },
    moveToDone: (t) => void log.done.push(t.id),
    activity: (_id, text) => void log.activity.push(text),
    now: () => 1_000_000,
    ...over,
  };
  return { deps, log };
}

const cfg = { enabled: true, threadId: "th", project: "/repo", milestone: { number: 2, title: "M2" }, maxInFlight: 5, pipelineId: "p", roadmap: null };
const freshState = async () => {
  const { readState } = await import("./autopilot.ts");
  return { ...readState(), noWork: {}, waits: {}, reworked: [] as number[], cards: [] as string[] };
};
const open = [405, 407, 410, 411].map((number) => ({ number, title: `t${number}` }));

test("no-work detection: done run, no PR, no commits beyond base — nothing else", async () => {
  const { isNoWorkCard } = await import("./autopilot.ts");
  const deps = { aheadCount: async () => 0, hasNoPr: () => true };
  expect(await isNoWorkCard(noWorkCard("a", 405), deps)).toBe(true);
  expect(await isNoWorkCard(noWorkCard("a", 405), { ...deps, aheadCount: async () => 2 })).toBe(false); // has commits: pr-watch opens its PR
  expect(await isNoWorkCard(noWorkCard("a", 405), { ...deps, aheadCount: async () => null })).toBe(false); // unknown: leave it
  expect(await isNoWorkCard(noWorkCard("a", 405), { ...deps, hasNoPr: () => false })).toBe(false);
  expect(await isNoWorkCard(noWorkCard("a", 405, { prUrl: "https://github.com/o/r/pull/1" }), deps)).toBe(false);
  expect(await isNoWorkCard(noWorkCard("a", 405, { pipelineRun: handoffRun("blocked") }), deps)).toBe(false);
  expect(await isNoWorkCard(noWorkCard("a", 405, { column: "done" }), deps)).toBe(false);
});

test("close: the card goes to Done, the thread sees the handoff, the issue is closed with its comment", async () => {
  const { processNoWork } = await import("./autopilot.ts");
  const state = await freshState();
  const { deps, log } = fakeDeps(['ok <no-work>{"action":"close","comment":"Owned by #410 (PR #412) and the deployed run in #411."}</no-work>']);
  const parked = await processNoWork(cfg, state, [noWorkCard("c1", 405)], open, deps);
  expect(log.done).toEqual(["c1"]);
  expect(log.asked[0]).toContain("Acceptance is owned by #410's deployed run");
  expect(log.asked[0]).toContain("Is the live setup done?");
  expect(log.asked[0]).toContain('"action": "rework"');
  expect(log.gh).toEqual([["issue", "close", "405", "--comment", "Owned by #410 (PR #412) and the deployed run in #411."]]);
  expect(state.noWork).toEqual({});
  expect(parked.size).toBe(0);
});

test("wait: the issue isn't a candidate until every blocker closes (state, not labels)", async () => {
  const { processNoWork } = await import("./autopilot.ts");
  const state = await freshState();
  const { deps, log } = fakeDeps(['<no-work>{"action":"wait","blockedBy":[410, 999]}</no-work>']);
  // #410 is still open in the milestone: held.
  expect([...(await processNoWork(cfg, state, [noWorkCard("c1", 407)], open, deps))]).toEqual([407]);
  expect(state.waits).toEqual({ "407": [410, 999] });
  expect(log.gh.some((a) => a[0] === "issue" && a[1] === "label")).toBe(false);
  // #410 closed (gone from the open list) and #999 reports CLOSED: released.
  const later = await processNoWork(cfg, state, [], open.filter((i) => i.number !== 410), deps);
  expect(later.has(407)).toBe(false);
  expect(state.waits).toEqual({});
  expect(log.gh.at(-1)).toEqual(["issue", "view", "999", "--json", "state", "-q", ".state"]);
});

test("rework starts one new card with the scope — once per issue; a second no-work result waits", async () => {
  const { processNoWork } = await import("./autopilot.ts");
  const state = await freshState();
  const rework = '<no-work>{"action":"rework","scope":"- wire the retry path"}</no-work>';
  const { deps, log } = fakeDeps([rework, rework]);
  await processNoWork(cfg, state, [noWorkCard("c1", 405)], open, deps);
  expect(log.started).toEqual([{ number: 405, scope: "- wire the retry path" }]);
  expect(state.reworked).toEqual([405]);
  expect(state.cards).toEqual(["rework-405"]);

  // The rework card also finds nothing: rework isn't offered, and a rework answer becomes a wait.
  const parked = await processNoWork(cfg, state, [noWorkCard("rework-405", 405)], open, deps);
  expect(log.asked[1]).toContain("rework isn't available");
  expect(log.started.length).toBe(1);
  expect(state.waits).toEqual({ "405": [] });
  expect(parked.has(405)).toBe(true);
  expect(log.activity.some((l) => l.includes("not starting another"))).toBe(true);
});

test("a malformed answer or a busy thread keeps the issue out of the candidates and asks again later", async () => {
  const { processNoWork, parseNoWorkDecision } = await import("./autopilot.ts");
  const state = await freshState();
  let now = 1_000_000;
  const { deps, log } = fakeDeps(
    ["I think it should close.", { ok: false, busy: true, error: "busy" }, '<no-work>{"action":"close","comment":"Owned by #410."}</no-work>'],
    { now: () => now },
  );
  expect((await processNoWork(cfg, state, [noWorkCard("c1", 405)], open, deps)).has(405)).toBe(true);
  // Not re-asked before its backoff.
  expect((await processNoWork(cfg, state, [], open, deps)).has(405)).toBe(true);
  expect(log.asked.length).toBe(1);
  now += 21 * 60_000;
  expect((await processNoWork(cfg, state, [], open, deps)).has(405)).toBe(true); // busy
  now += 6 * 60_000;
  expect((await processNoWork(cfg, state, [], open, deps)).has(405)).toBe(false); // answered: closed
  expect(log.asked.length).toBe(3);
  // A close that names no owning issue/PR is malformed.
  expect(parseNoWorkDecision('<no-work>{"action":"close","comment":"done elsewhere"}</no-work>')).toBeNull();
  expect(parseNoWorkDecision('<no-work>{"action":"wait","blockedBy":[]}</no-work>')).toBeNull();
});

// ── Roadmap mode ───────────────────────────────────────────────────────────
type RDeps = import("./autopilot.ts").RoadmapDeps;
type IssueState = import("../shared/roadmap.ts").RoadmapIssueState;

test("parseConfig: roadmap mode needs no milestone or thread; a bad issue is no roadmap", () => {
  expect(parseConfig(JSON.stringify({ enabled: true, project: "/repo", roadmap: { issue: 639 } }))).toMatchObject({
    enabled: true,
    threadId: "",
    milestone: null,
    roadmap: { issue: 639 },
  });
  expect(parseConfig(null).roadmap).toBeNull();
  expect(parseConfig(JSON.stringify({ roadmap: { issue: "639" } })).roadmap).toBeNull();
  expect(parseConfig(JSON.stringify({ roadmap: { issue: 0 } })).roadmap).toBeNull();
  expect(parseConfig(JSON.stringify({ roadmap: 639 })).roadmap).toBeNull();
});

const ROADMAP_BODY = [
  "## Numbered completion order",
  "| Step | Task and outcome | Milestone | Predecessor steps |",
  "| --- | --- | --- | --- |",
  "| 1 | #11 [Human] Provide the sample device | H | none |",
  "| 2 | #12 Inventory the widgets | M01 | none |",
  "| 3 | #13 Build the widget store | M01 | 2 |",
  "| 4 | #14 Wire the widget API | M02 | 2 |",
  "| 5 | #15 Ship the widget page | M02 | 3, 4 |",
  "| 6 | #16 Calibrate against the device | M02 | 1 |",
].join("\n");
const OPEN: IssueState = { state: "OPEN", stateReason: null };
const COMPLETED: IssueState = { state: "CLOSED", stateReason: "COMPLETED" };
const roadmapCfg = { ...cfg, threadId: "", milestone: null, maxInFlight: 2, roadmap: { issue: 600 } };
const NOW = 10_000_000;
const roadmapCard = (id: string, n: number, column: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Issue #${n}`, issueUrl: `https://github.com/o/r/issues/${n}`, column, archivedAt: null, pipelineParentId: null, pendingInteractionCount: 0, prUrl: null, pipelineRun: null, worktreePath: "/wt", baseRef: "abc", updatedAt: 0, ...extra }) as never as TaskT;

function roadmapDeps(states: Record<number, IssueState>, over: Partial<RDeps> = {}) {
  const log = { started: [] as { number: number; extraPrompt: string }[], notified: [] as string[], activity: [] as string[], rechecks: 0 };
  const deps: RDeps = {
    loadTracker: async () => ({ body: ROADMAP_BODY, url: "https://github.com/o/r/issues/600" }),
    loadStates: async (_p, numbers) => new Map(numbers.map((n) => [n, { ...(states[n] ?? OPEN), url: `https://github.com/o/r/issues/${n}` }])),
    aheadCount: async () => 0,
    hasNoPr: () => true,
    mergedPr: () => null,
    quotaPaused: () => false,
    pipelineId: () => "p",
    startCard: async ({ number, extraPrompt }) => {
      log.started.push({ number, extraPrompt });
      return { task: roadmapCard(`new-${number}`, number, "ready") };
    },
    notify: (n) => {
      log.notified.push(n.body);
      return true;
    },
    activity: (_id, text) => void log.activity.push(text),
    recheck: () => void log.rechecks++,
    now: () => NOW,
    ...over,
  };
  return { deps, log };
}
const roadmapState = async (): Promise<import("./autopilot.ts").AutopilotState> => ({ ...(await freshState()), roadmap: null, roadmapStuck: {}, notifiedHuman: [], lastError: null });

test("roadmap: starts the ready agent steps in step order; the human step is announced once, never started", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const state = await roadmapState();
  const { deps, log } = roadmapDeps({});
  await roadmapPass(roadmapCfg, state, [], [], deps);
  expect(log.started.map((s) => s.number)).toEqual([12]); // #11 is human; 3–6 wait
  expect(log.started[0]!.extraPrompt).toContain("Roadmap step 2 (M01)");
  expect(log.started[0]!.extraPrompt).toContain("tracker issue #600");
  expect(log.started[0]!.extraPrompt).toContain('"Fixes #12"');
  expect(state.cards).toEqual(["new-12"]);
  expect(state.phase).toBe("running");
  expect(state.roadmap!.counts).toEqual({ total: 6, complete: 0, declined: 0, inFlight: 1, ready: 1, waiting: 4 });
  expect(state.roadmap!.humanReady).toEqual([{ step: "1", issue: 11, title: "[Human] Provide the sample device", url: "https://github.com/o/r/issues/11" }]);
  expect(log.notified).toEqual(["Step 1 · #11 [Human] Provide the sample device"]);

  // The ledger keeps it to one notification.
  await roadmapPass(roadmapCfg, state, [roadmapCard("new-12", 12, "running")], [roadmapCard("new-12", 12, "running")], deps);
  expect(log.notified.length).toBe(1);
  expect(log.started.length).toBe(1); // #12 has a live card
});

test("roadmap: free slots bound the starts, predecessors' issues go into the prompt", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const state = await roadmapState();
  const { deps, log } = roadmapDeps({ 11: COMPLETED, 12: COMPLETED, 13: COMPLETED });
  // One slot of two is taken by someone else's card on a roadmap issue.
  const other = roadmapCard("other", 16, "running");
  await roadmapPass(roadmapCfg, state, [other], [], deps);
  expect(log.started.map((s) => s.number)).toEqual([14]);
  expect(log.started[0]!.extraPrompt).toContain("2 (#12)");
  expect(state.roadmap!.counts).toMatchObject({ complete: 3, inFlight: 2, ready: 0, waiting: 1 });
  expect(state.roadmap!.nextWaiting).toEqual([expect.objectContaining({ step: "5", waitingOn: ["4"] })]);
});

test("roadmap restart guard: a finished card on a still-open issue is never started again", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const state = await roadmapState();
  state.notifiedHuman = [11];
  const { deps, log } = roadmapDeps({}, { mergedPr: () => 77 });
  // The card for #12 is Done (its PR merged with "Refs #12"), the issue is open.
  const done = roadmapCard("c12", 12, "done", { updatedAt: NOW - 10 * 60_000 });
  await roadmapPass(roadmapCfg, state, [done], [done], deps);
  expect(log.started).toEqual([]);
  expect(state.roadmapStuck["12"]).toMatchObject({ cardId: "c12" });
  expect(state.roadmap!.needsUser).toEqual([expect.objectContaining({ step: "2", issue: 12, reason: "PR #77 merged but the issue is still open — close it or reopen the work" })]);
  expect(state.phase).toBe("idle");
  expect(state.roadmap!.idleReason).toContain("human step 1 (#11)");
  expect(state.roadmap!.idleReason).toContain("step 2 (#12) needs you");
  expect(log.activity.length).toBe(1);

  // Still guarded after the card is archived (gone from the board), and not logged twice.
  await roadmapPass(roadmapCfg, state, [], [], deps);
  expect(log.started).toEqual([]);
  expect(log.activity.length).toBe(1);

  // Once the issue closes the guard lifts and its successors start.
  const closed = roadmapDeps({ 12: COMPLETED });
  await roadmapPass(roadmapCfg, state, [], [], closed.deps);
  expect(state.roadmapStuck).toEqual({});
  expect(closed.log.started.map((s) => s.number)).toEqual([13, 14]);
});

test("roadmap restart guard: a done run with no PR and no commits waits for the user, and its card stays put", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const state = await roadmapState();
  const { deps, log } = roadmapDeps({});
  const card = roadmapCard("c12", 12, "review", { pipelineRun: handoffRun() });
  await roadmapPass(roadmapCfg, state, [card], [card], deps);
  expect(log.started).toEqual([]);
  expect(state.roadmapStuck["12"]!.reason).toContain("nothing to build");
  // …and after the user moves that card to Done or archives it.
  await roadmapPass(roadmapCfg, state, [], [], deps);
  expect(log.started).toEqual([]);
  expect(state.roadmap!.needsUser.map((n) => n.issue)).toEqual([12]);
});

test("roadmap: a card that just reached Done gets time for its issue to close", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const state = await roadmapState();
  const { deps, log } = roadmapDeps({});
  const done = roadmapCard("c12", 12, "done", { updatedAt: NOW - 5_000 });
  await roadmapPass(roadmapCfg, state, [done], [done], deps);
  expect(log.started).toEqual([]);
  expect(state.roadmapStuck).toEqual({});
  expect(log.rechecks).toBe(1);
});

test("roadmap: done only when every step is complete or declined; an unreadable roadmap starts nothing", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const all = { 11: COMPLETED, 12: COMPLETED, 13: COMPLETED, 14: COMPLETED, 15: COMPLETED };
  const waiting = await roadmapState();
  const w = roadmapDeps({ ...all, 12: { state: "CLOSED", stateReason: "NOT_PLANNED" }, 16: OPEN });
  await roadmapPass(roadmapCfg, waiting, [], [], w.deps);
  expect(w.log.started.map((s) => s.number)).toEqual([16]);
  expect(waiting.phase).toBe("running");

  const finished = await roadmapState();
  await roadmapPass(roadmapCfg, finished, [], [], roadmapDeps({ ...all, 12: { state: "CLOSED", stateReason: "NOT_PLANNED" }, 16: COMPLETED }).deps);
  expect(finished.phase).toBe("done");
  expect(finished.roadmap!.counts).toMatchObject({ total: 6, complete: 5, declined: 1 });

  const broken = await roadmapState();
  const b = roadmapDeps({}, { loadTracker: async () => ({ body: "## Something else\n", url: null }) });
  await roadmapPass(roadmapCfg, broken, [], [], b.deps);
  expect(b.log.started).toEqual([]);
  expect(broken.lastError).toContain("Numbered completion order");
  expect(broken.roadmap!.problems[0]!.kind).toBe("missing-section");
});

test("roadmap: holds new starts while a card waits for a usage limit", async () => {
  const { roadmapPass } = await import("./autopilot.ts");
  const state = await roadmapState();
  const { deps, log } = roadmapDeps({ 12: COMPLETED });
  const waiting = roadmapCard("q", 13, "blocked", { pipelineRun: { status: "blocked", active: [], blocked: [], history: [], joins: {}, autoRetry: { stepId: "b", kind: "quota", attempt: 1, at: NOW + 60_000, reason: "limit" } } });
  await roadmapPass(roadmapCfg, state, [waiting], [waiting], deps);
  expect(log.started).toEqual([]);
});
