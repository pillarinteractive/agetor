import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  followUpIssue,
  followUpKey,
  MAX_RUN_REROUTES,
  NO_COUNTERS,
  ownerHoldMarker,
  parseHardStop,
  parseOwnerHoldsMode,
  resolveOwnerHold,
  resolvingHold,
  stepRole,
  unresolvedItems,
  type LadderCounters,
  type OwnerHoldDecision,
  type OwnerHoldInput,
  type OwnerHoldKind,
} from "./owner-holds.ts";
import { DEFAULT_BLOCK_WAIT, NO_DEADLINE, planWait, waitLine } from "./block-wait.ts";
import { normalizeHandoff } from "./pipeline.ts";

const base = (over: Partial<OwnerHoldInput> = {}): OwnerHoldInput => ({
  mode: "resolve",
  unattended: true,
  userStopped: false,
  kind: "blocked",
  role: "build",
  hasSession: true,
  hardStop: null,
  external: null,
  counters: NO_COUNTERS,
  runReroutes: 0,
  rerouteTo: "build",
  closed: false,
  wrapUpAvailable: true,
  hasCommits: false,
  ...over,
});

const apply = (c: LadderCounters, d: OwnerHoldDecision): LadderCounters =>
  d.action === "answer" ? { ...c, answers: c.answers + 1 } : d.action === "fresh" ? { ...c, fresh: c.fresh + 1 } : d.action === "reroute" ? { ...c, reroutes: c.reroutes + 1 } : c;

/** Walk the ladder for one step execution until it closes; the actions taken. */
function walk(over: Partial<OwnerHoldInput>): string[] {
  let counters = NO_COUNTERS;
  let runReroutes = over.runReroutes ?? 0;
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    const d = resolveOwnerHold(base({ ...over, counters, runReroutes }));
    seen.push(d.action);
    if (d.action === "park" || d.action === "wait" || d.action.startsWith("close")) return seen;
    counters = apply(counters, d);
    if (d.action === "reroute") runReroutes++;
  }
  throw new Error(`the ladder did not close: ${seen.join(" → ")}`);
}

// ── One case per former owner path ────────────────────────────────────────

test("a blocked handoff the owner had to answer (owner verdict, escalated, taken, queue off) is answered in place, then a fresh Build session, then closed out", () => {
  expect(walk({ kind: "blocked", role: "build" })).toEqual(["answer", "fresh", "close-depend"]);
  expect(walk({ kind: "blocked", role: "build", hasCommits: true })).toEqual(["answer", "fresh", "close-publish"]);
});

test("a Review or Finish that still cannot proceed after its answer goes back to Build", () => {
  expect(walk({ kind: "blocked", role: "review" })).toEqual(["answer", "reroute", "fresh", "close-depend"]);
  expect(walk({ kind: "blocked", role: "finish", hasCommits: true })).toEqual(["answer", "reroute", "fresh", "close-publish"]);
  const d = resolveOwnerHold(base({ kind: "blocked", role: "finish", counters: { answers: 1, fresh: 0, reroutes: 0 } }));
  expect(d).toEqual({ action: "reroute", to: "build", why: "Build is the step that can act on it" });
});

test("a question a step asked in an unattended run gets the answer automatically, never a fresh session of a live step", () => {
  expect(walk({ kind: "question", role: "build" })).toEqual(["answer", "close-depend"]);
  expect(walk({ kind: "question", role: "review" })).toEqual(["answer", "reroute", "close-depend"]);
});

test("handoff missing after the reminder, and a failure whose retries are spent: one fresh session, then close", () => {
  expect(walk({ kind: "no-handoff", role: "build" })).toEqual(["fresh", "close-depend"]);
  expect(walk({ kind: "failed", role: "build", hasSession: false })).toEqual(["fresh", "close-depend"]);
  expect(walk({ kind: "failed", role: "finish", hasSession: false, hasCommits: true })).toEqual(["reroute", "fresh", "close-publish"]);
});

test("a failed check gate after its feedback turns and fresh session: one more retry with the checks first, Review/Finish go to Build", () => {
  expect(walk({ kind: "checks", role: "build" })).toEqual(["fresh", "close-depend"]);
  expect(walk({ kind: "checks", role: "review" })).toEqual(["reroute", "fresh", "close-depend"]);
});

test("the step cap after its wrap-up, a used-up corrective route (three CI failures), profile-missing and join-incomplete close out directly", () => {
  for (const kind of ["step-cap", "edge-limit", "profile-missing", "join-incomplete"] as OwnerHoldKind[]) {
    expect(walk({ kind, role: "finish", rerouteTo: null, hasSession: kind === "edge-limit" })).toEqual(["close-depend"]);
    expect(walk({ kind, role: "finish", rerouteTo: null, hasCommits: true })).toEqual(["close-publish"]);
  }
});

test("an Agetor-run Finish that stopped (a diverged branch, CI that never started) goes to Build, then retries, then closes", () => {
  expect(walk({ kind: "publish", role: "finish", hasSession: false })).toEqual(["reroute", "fresh", "close-depend"]);
  // No Build step to send it to.
  expect(walk({ kind: "publish", role: "finish", hasSession: false, rerouteTo: null })).toEqual(["fresh", "close-depend"]);
});

test("a queue wait on something that clears by itself is never the owner's: it waits, whatever its rungs", () => {
  for (const external of ["dependency", "resource", "environment", "limit"] as const) {
    expect(resolveOwnerHold(base({ external, counters: { answers: 1, fresh: 1, reroutes: 1 } }))).toMatchObject({ action: "wait", category: external });
  }
  // An unknown block is not external: it goes through the ladder.
  expect(resolveOwnerHold(base({ external: "unknown" })).action).toBe("answer");
});

// ── Bounds ────────────────────────────────────────────────────────────────

test("the ladder never repeats a rung for the same step execution, and reroutes are capped for the run", () => {
  for (const kind of ["blocked", "question", "no-handoff", "failed", "checks", "publish", "edge-limit", "step-cap"] as OwnerHoldKind[]) {
    for (const role of ["build", "review", "finish", "other"] as const) {
      const seen = walk({ kind, role });
      const rungs = seen.filter((a) => !a.startsWith("close"));
      expect(new Set(rungs).size).toBe(rungs.length);
      expect(seen[seen.length - 1]!.startsWith("close")).toBe(true);
    }
  }
  expect(resolveOwnerHold(base({ role: "review", counters: { answers: 1, fresh: 0, reroutes: 0 }, runReroutes: MAX_RUN_REROUTES })).action).toBe("fresh");
});

test("once the run is closed out nothing goes back: a stop of the wrap-up is answered once, then it waits on the issue", () => {
  expect(walk({ kind: "blocked", role: "finish", closed: true, hasCommits: true })).toEqual(["answer", "close-depend"]);
  expect(walk({ kind: "publish", role: "finish", closed: true, hasCommits: true, hasSession: false })).toEqual(["close-depend"]);
  // The cap wrap-up already used: no second publish.
  expect(walk({ kind: "step-cap", role: "finish", wrapUpAvailable: false, hasCommits: true })).toEqual(["close-depend"]);
});

test("the step cap hit again after the wrap-up restarts the card once from its base; the second time it closes out on an issue", () => {
  const capAfterWrapUp = { kind: "step-cap" as const, role: "finish" as const, rerouteTo: null, hasSession: false, wrapUpAvailable: false, wrapUpUsed: true, hasCommits: true };
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, capRestartAvailable: true }))).toMatchObject({ action: "restart-from-base" });
  // Also when another stop closed the run out before (the loop is the thing).
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, capRestartAvailable: true, closed: true })).action).toBe("restart-from-base");
  // Restart used (by this run or the run it restarted from): today's close-out.
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, capRestartAvailable: false })).action).toBe("close-depend");
  expect(resolveOwnerHold(base({ ...capAfterWrapUp }))).toMatchObject({ action: "close-depend", why: "the step cap is spent" });
  // Wrap-up not used yet: never a restart.
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, wrapUpUsed: false, capRestartAvailable: true })).action).toBe("close-depend");
  // Only the step cap restarts: any other kind after the wrap-up goes its usual way.
  for (const kind of ["blocked", "no-handoff", "failed", "checks", "edge-limit", "profile-missing", "join-incomplete", "publish"] as OwnerHoldKind[]) {
    expect(resolveOwnerHold(base({ kind, role: "finish", wrapUpUsed: true, capRestartAvailable: true })).action).not.toBe("restart-from-base");
  }
  // Park mode, a person-run card and a user Stop: nothing changes.
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, capRestartAvailable: true, mode: "park" })).action).toBe("park");
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, capRestartAvailable: true, unattended: false })).action).toBe("park");
  expect(resolveOwnerHold(base({ ...capAfterWrapUp, capRestartAvailable: true, userStopped: true })).action).toBe("park");
});

test("a hard stop goes straight to the close-out once its answer confirmed it", () => {
  const hardStop = { kind: "credentials" as const, detail: "no npm token" };
  expect(walk({ kind: "blocked", role: "review", hardStop })).toEqual(["answer", "close-depend"]);
  expect(walk({ kind: "blocked", role: "finish", hardStop, hasCommits: true })).toEqual(["answer", "close-publish"]);
  // No session to confirm it in: straight to the close-out.
  expect(walk({ kind: "failed", hardStop, hasSession: false })).toEqual(["close-depend"]);
  expect(resolveOwnerHold(base({ hardStop, counters: { answers: 1, fresh: 0, reroutes: 0 } })).why).toContain("credentials or access");
});

test('the preference "park", a person-run card and a user Stop restore the old outcome: the card waits', () => {
  for (const kind of ["blocked", "question", "no-handoff", "failed", "checks", "edge-limit", "step-cap", "publish"] as OwnerHoldKind[]) {
    expect(resolveOwnerHold(base({ kind, mode: "park" })).action).toBe("park");
    expect(resolveOwnerHold(base({ kind, unattended: false })).action).toBe("park");
    expect(resolveOwnerHold(base({ kind, userStopped: true })).action).toBe("park");
  }
  expect(resolveOwnerHold(base({ mode: "park", external: "dependency" })).action).toBe("park");
});

// ── The preference and the hard-stop field ────────────────────────────────

test("owner_holds is resolve unless it says park", () => {
  expect(parseOwnerHoldsMode(null)).toBe("resolve");
  expect(parseOwnerHoldsMode("")).toBe("resolve");
  expect(parseOwnerHoldsMode("park")).toBe("park");
  expect(parseOwnerHoldsMode('"park"')).toBe("park");
  expect(parseOwnerHoldsMode(' {"mode":"PARK"} ')).toBe("park");
  expect(parseOwnerHoldsMode('"resolve"')).toBe("resolve");
  expect(parseOwnerHoldsMode("{not json")).toBe("resolve");
});

test("hardStop is read leniently and makes the handoff blocked", () => {
  expect(parseHardStop({ hardStop: { kind: "credentials", detail: "no deploy key" } })).toEqual({ kind: "credentials", detail: "no deploy key" });
  expect(parseHardStop({ hard_stop: { type: "Irreversible", reason: "drops the table" } })).toEqual({ kind: "destructive", detail: "drops the table" });
  expect(parseHardStop({ hardstop: "main", reason: "would push to main" })).toEqual({ kind: "protected", detail: "would push to main" });
  expect(parseHardStop({ hardStop: { kind: "production" } })).toEqual({ kind: "protected", detail: "protected" });
  expect(parseHardStop({ hardStop: { kind: "vibes", detail: "x" } })).toBeNull();
  expect(parseHardStop({ hardStop: false })).toBeNull();
  expect(parseHardStop(null)).toBeNull();
  const h = normalizeHandoff({ schemaVersion: 1, summary: "s", reason: "r", status: "done", hardStop: { kind: "secret", detail: "no token\nat all" } });
  expect(h.status).toBe("blocked");
  expect(h.hardStop).toEqual({ kind: "credentials", detail: "no token at all" });
  expect(normalizeHandoff({ summary: "s", status: "done" }).hardStop).toBeUndefined();
});

// ── Follow-up issues ──────────────────────────────────────────────────────

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

test("follow-up issues are deduplicated: the same item of the same card keys the same issue, whatever its spacing or case", () => {
  const a = followUpKey({ source: "https://github.com/o/r/issues/7", step: "Finish", question: "Publish from a new branch?" }, hash);
  const b = followUpKey({ source: "https://github.com/o/r/issues/7", step: "finish", question: "  publish   from a NEW branch? " }, hash);
  const c = followUpKey({ source: "https://github.com/o/r/issues/8", step: "Finish", question: "Publish from a new branch?" }, hash);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[0-9a-f]{16}$/);
});

test("the issue carries the question, options, provisional choice, evidence, card and PR, and its marker", () => {
  const [item] = unresolvedItems({ openQuestions: ["Which runner should CI use: (a) gc-1 (b) GitHub-hosted"], reason: "r", fallback: "f" });
  expect(item!.options).toEqual(["gc-1", "GitHub-hosted"]);
  const { title, body } = followUpIssue({
    key: "abc", cardTitle: "Fix the importer", cardId: "card-1", step: "Review", item: item!, reason: "Blocked on a runner choice", hardStop: null,
    tried: ["answered Review in its own session"], issueUrl: "https://github.com/o/r/issues/7", prUrl: "https://github.com/o/r/pull/9", close: "depend",
  });
  expect(title.startsWith('Owner decision: Review on "Fix the importer"')).toBe(true);
  expect(title.length).toBeLessThanOrEqual(120);
  for (const s of ["Which runner should CI use", "- gc-1", "- GitHub-hosted", "provisional", "Blocked on a runner choice", "answered Review in its own session", "issues/7", "pull/9", ownerHoldMarker("abc"), "close the issue"]) {
    expect(body).toContain(s);
  }
  expect(unresolvedItems({ openQuestions: [], reason: "", fallback: "the block" })).toEqual([{ question: "the block", options: [] }]);
});

test("stepRole reads Build, Review and Finish from the name or id", () => {
  expect([stepRole("Build"), stepRole("review"), stepRole("x", "finish-2"), stepRole("Understand")]).toEqual(["build", "review", "finish", "other"]);
});

// ── The wait queue without a deadline ─────────────────────────────────────

const verdict = (category: "dependency" | "unknown") => ({ category, source: "declared" as const, what: "#77", ref: "#77", why: "w" });

test("a dependency wait no longer escalates at 24 hours when holds are resolved; it is re-checked at the long interval", () => {
  const now = 1_000_000;
  const spent = { stepId: "s", taskId: "t", category: "dependency" as const, source: "declared" as const, what: "#77", ref: "#77", reason: "r", state: "resuming" as const, since: now - 30 * 3_600_000, attempt: 4, max: 4, at: null, deadline: now - 6 * 3_600_000, tried: [] };
  const endless = planWait({ stepId: "s", taskId: "t", verdict: verdict("dependency"), reason: "waits on #77", prev: spent, config: DEFAULT_BLOCK_WAIT, now, rng: () => 0, endless: true });
  expect(endless.state).toBe("waiting");
  expect(endless.deadline).toBe(NO_DEADLINE);
  expect(endless.endless).toBe(true);
  expect(endless.at).toBe(now + DEFAULT_BLOCK_WAIT.longBackoffMin * 60_000);
  expect(waitLine("Build", endless, now, true)).toContain("re-checking until it clears");
  // Today's behaviour without it (and for what does not clear by itself).
  expect(planWait({ stepId: "s", taskId: "t", verdict: verdict("dependency"), reason: "r", prev: spent, config: DEFAULT_BLOCK_WAIT, now }).state).toBe("escalated");
  expect(planWait({ stepId: "s", taskId: "t", verdict: verdict("unknown"), reason: "r", prev: { ...spent, category: "unknown", attempt: 3, max: 3 }, config: DEFAULT_BLOCK_WAIT, now, endless: true }).state).toBe("escalated");
});

test("a closed-out card reads as waiting on its issue", () => {
  const w = { stepId: "s", taskId: "", category: "dependency" as const, source: "signal" as const, what: "#12", ref: "#12", reason: "r", state: "waiting" as const, since: 0, attempt: 0, max: 0, at: 0, deadline: NO_DEADLINE, tried: [], endless: true as const, closeout: true as const };
  expect(waitLine("Finish", w, 0, true)).toBe("Finish waiting on #12 (filed for the owner) — resumes when it is closed");
  expect(resolvingHold({ status: "blocked", ladder: { resolving: { since: 1, note: "n" } } })).toEqual({ since: 1, note: "n" });
  expect(resolvingHold({ status: "running", ladder: { resolving: { since: 1, note: "n" } } })).toBeNull();
});
