import { test, expect, describe } from "bun:test";
import {
  asksTheOwner,
  classifyBlock,
  DEFAULT_BLOCK_WAIT,
  dependencyRefIn,
  escalatedWait,
  escalationLine,
  issueRef,
  looksResourceBusy,
  looksTransient,
  parseBlockWaitConfig,
  parseWaitingOn,
  planWait,
  queuedWait,
  triedLine,
  waitHasTrigger,
  waitingInQueue,
  waitLine,
  waitsOnIssue,
  type BlockVerdict,
} from "./block-wait.ts";
import { normalizeHandoff, parseHandoff } from "./pipeline.ts";
import type { BlockWaitCategory, Handoff, PipelineBlockWait, PipelineRunState } from "./types.ts";

// Every reason below is synthetic.
const handoff = (over: Partial<Pick<Handoff, "reason" | "summary" | "openQuestions" | "waitingOn">> = {}) => ({ reason: "", summary: "", openQuestions: [] as string[], ...over });
const rig = (over: Partial<{ held: boolean; heldByOther: boolean; error: boolean }> = {}) => [{ label: "rig", held: false, heldByOther: false, error: false, ...over }];

describe("parseWaitingOn", () => {
  test("a bare string, in any spelling", () => {
    expect(parseWaitingOn({ waitingOn: "resource" })).toEqual({ on: "resource" });
    expect(parseWaitingOn({ waitingOn: "usage-limit" })).toEqual({ on: "usage_limit" });
    expect(parseWaitingOn({ waitingOn: "Usage Limit" })).toEqual({ on: "usage_limit" });
    expect(parseWaitingOn({ waitingOn: "USER" })).toEqual({ on: "owner" });
    expect(parseWaitingOn({ waitingOn: "the owner" })).toBeNull(); // not a kind we know: the classifier decides
    expect(parseWaitingOn({ waitingOn: "pull_request" })).toEqual({ on: "dependency" });
    expect(parseWaitingOn({ waiting_on: "env" })).toEqual({ on: "environment" });
  });

  test("an object, and sibling reference fields", () => {
    expect(parseWaitingOn({ waitingOn: { kind: "resource", ref: "rig" } })).toEqual({ on: "resource", ref: "rig" });
    expect(parseWaitingOn({ waitingOn: { on: "dependency", issue: 41 } })).toEqual({ on: "dependency", ref: "#41" });
    expect(parseWaitingOn({ waitingOn: { type: "dependency", pr: "#41" } })).toEqual({ on: "dependency", ref: "#41" });
    expect(parseWaitingOn({ waitingOn: "dependency", waitingRef: "#41" })).toEqual({ on: "dependency", ref: "#41" });
    expect(parseWaitingOn({ waitingOn: "other", until: "the nightly build at 02:00" })).toEqual({ on: "other", ref: "the nightly build at 02:00" });
    expect(parseWaitingOn({ waitingOn: "resource", ref: 7 })).toEqual({ on: "resource", ref: "7" });
  });

  test("anything unreadable is null, never a throw; the reference is one capped line", () => {
    for (const bad of [null, undefined, 3, "resource", [], {}, { waitingOn: 3 }, { waitingOn: ["owner"] }, { waitingOn: { ref: "rig" } }, { waitingOn: "soon" }, { waitingOn: "" }]) {
      expect(parseWaitingOn(bad)).toBeNull();
    }
    const long = parseWaitingOn({ waitingOn: "resource", waitingRef: `a\nb\u0000c ${"x".repeat(500)}` })!;
    expect(long.ref!.length).toBe(120);
    expect(long.ref!.startsWith("a b c x")).toBe(true);
    // An inherited key is not the handoff's.
    expect(parseWaitingOn(Object.create({ waitingOn: "resource" }))).toBeNull();
  });

  test("the handoff preserves declared waits and their references", () => {
    expect(normalizeHandoff({ status: "blocked", waitingOn: "resource", waitingRef: "rig" }).waitingOn).toEqual({ on: "resource", ref: "rig" });
    const parsed = parseHandoff('<handoff>\n{"schemaVersion":1,"summary":"s","reason":"r","next":null,"status":"blocked","waitingOn":{"kind":"dependency","ref":"#41"}}\n</handoff>');
    expect(parsed.ok && parsed.handoff.waitingOn).toEqual({ on: "dependency", ref: "#41" });
    // What the database gives back normalizes to itself.
    expect(normalizeHandoff({ status: "blocked", waitingOn: { on: "dependency", ref: "#41" } }).waitingOn).toEqual({ on: "dependency", ref: "#41" });
  });

  test("a contradictory done verdict stays blocked on its declared wait", () => {
    for (const [on, category] of [["resource", "resource"], ["dependency", "dependency"], ["owner", "owner"]] as const) {
      const input = { status: "done", waitingOn: { on, ref: on === "dependency" ? "#41" : "rig" } };
      const normalized = normalizeHandoff(input);
      expect(normalized).toMatchObject({ status: "blocked", waitingOn: input.waitingOn });
      expect(classifyBlock(normalized)).toMatchObject({ category, source: "declared" });
      const parsed = parseHandoff(`<handoff>${JSON.stringify(input)}</handoff>`);
      expect(parsed.ok && parsed.handoff).toEqual(normalized);
    }
  });

  test("an unreadable wait stays blocked and cannot erase an owner question", () => {
    for (const status of ["blocked", "done"] as const) {
      const normalized = normalizeHandoff({ status, waitingOn: "whenever" });
      expect(normalized).toMatchObject({ status: "blocked", waitingOn: { on: "other" } });
      expect(classifyBlock(normalized)).toMatchObject({ category: "unknown", source: "declared" });
      const withQuestion = normalizeHandoff({ status, waitingOn: "whenever", openQuestions: ["May I skip the rig test?"] });
      expect(withQuestion).toMatchObject({ status: "blocked", waitingOn: { on: "other" }, openQuestions: ["May I skip the rig test?"] });
      expect(classifyBlock(withQuestion)).toMatchObject({ category: "owner", source: "questions" });
    }
  });
});

describe("the prose matchers", () => {
  test("requests to the owner: decisions, credentials, permissions, hands", () => {
    for (const s of [
      "needs a product decision",
      "Awaiting sign-off on the new schema.",
      "The user must decide how to proceed.",
      "Blocked on authorization to rewrite the two commits.",
      "The operator is fixing the sandbox key.",
      "The deploy token is missing.",
      "It requires valid credentials for the staging registry.",
      "Permission denied when writing to the shared cache.",
      "This is outside the agent's permissions.",
      "A restart of the container runtime is required.",
      "This needs a manual check of the cable.",
      "Waiting for your confirmation before deleting the fixtures.",
    ]) {
      expect(asksTheOwner(s)).not.toBeNull();
    }
    for (const s of ["the fixture service did not come up", "the rig lease is held by another checkout", "waiting for #41 to merge", "the package registry timed out twice", "CI is queued"]) {
      expect(asksTheOwner(s)).toBeNull();
    }
  });

  test("transient failures", () => {
    for (const s of [
      "fetch failed with ECONNRESET",
      "The network connection timed out while cloning.",
      "GitHub returned 503 on both pushes.",
      "GitHub was unavailable for ten minutes.",
      "HTTP 502 from the artifact store",
      "Hit the secondary rate limit on the API.",
      "pnpm install failed: the registry was unreachable.",
      "The package registry timed out twice.",
      "The test runner process crashed with a segmentation fault.",
      "The verifier launch stopped without an exit code.",
    ]) {
      expect(looksTransient(s)).not.toBeNull();
    }
    expect(looksTransient("the unit test for retries fails")).toBeNull();
    expect(looksTransient("the assertion on line 12 is wrong")).toBeNull();
  });

  test("busy resources and named dependencies", () => {
    expect(looksResourceBusy("Both shared verification slots remained occupied.")).not.toBeNull();
    expect(looksResourceBusy("Waiting for a free slot.")).not.toBeNull();
    expect(looksResourceBusy("The lease is held by a different checkout.")).not.toBeNull();
    expect(looksResourceBusy("the slot machine example is wrong")).toBeNull();
    expect(dependencyRefIn("Blocked on #41: the parser must merge first.")).toBe(41);
    expect(dependencyRefIn("Waiting for PR #12 to land.")).toBe(12);
    expect(dependencyRefIn("This depends on issue 300 being closed.")).toBe(300);
    expect(dependencyRefIn("Fixes #41 and updates the docs.")).toBeNull();
    expect(dependencyRefIn("See #41 for background.")).toBeNull();
    expect(issueRef("#41")).toBe(41);
    expect(issueRef("PR 41")).toBe(41);
    expect(issueRef("the rig")).toBeNull();
  });
});

describe("classifyBlock", () => {
  const cat = (v: BlockVerdict) => `${v.category}/${v.source}`;

  test("each category from the step's own declaration", () => {
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "owner" } })))).toBe("owner/declared");
    expect(classifyBlock(handoff({ waitingOn: { on: "resource", ref: "RIG" } }), { leases: rig() })).toMatchObject({ category: "resource", source: "declared", what: "the rig", ref: "rig" });
    expect(classifyBlock(handoff({ waitingOn: { on: "resource" } }))).toMatchObject({ category: "resource", what: "a shared resource", ref: null });
    expect(classifyBlock(handoff({ waitingOn: { on: "dependency", ref: "PR #41" } }))).toMatchObject({ category: "dependency", what: "#41", ref: "#41" });
    expect(classifyBlock(handoff({ waitingOn: { on: "dependency", ref: "the schema change" } }))).toMatchObject({ category: "dependency", what: "the schema change", ref: "the schema change" });
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "environment" } })))).toBe("environment/declared");
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "usage_limit" } })))).toBe("limit/declared");
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "other" } })))).toBe("unknown/declared");
  });

  test("each category from signals and, last, from its words", () => {
    expect(classifyBlock(handoff({ reason: "the rig is in use" }), { leases: rig({ held: true, heldByOther: true }) })).toMatchObject({ category: "resource", source: "signal", ref: "rig" });
    // Held by this very card, or the probe failing: no signal.
    expect(cat(classifyBlock(handoff({ reason: "the rig is in use" }), { leases: rig({ held: true, heldByOther: false }) }))).toBe("unknown/none");
    expect(cat(classifyBlock(handoff({ reason: "the rig is in use" }), { leases: rig({ held: true, heldByOther: true, error: true }) }))).toBe("unknown/none");
    // A held lease the block doesn't name is not what it waits on.
    expect(cat(classifyBlock(handoff({ reason: "the fixture service did not come up" }), { leases: rig({ held: true, heldByOther: true }) }))).toBe("unknown/none");
    expect(classifyBlock(handoff({ reason: "CI cannot pass until the base is fixed" }), { baseCiRed: { baseRef: "develop" } })).toMatchObject({ category: "dependency", source: "signal", ref: "base-ci", what: "develop's CI" });
    expect(cat(classifyBlock(handoff({ reason: "the fixture service did not come up" }), { baseCiRed: { baseRef: "develop" } }))).toBe("unknown/none");
    expect(classifyBlock(handoff({ reason: "Waiting for #41 to merge before the import can be removed." }))).toMatchObject({ category: "dependency", source: "text", ref: "#41" });
    expect(classifyBlock(handoff({ reason: "Both shared verification slots remained occupied." }))).toMatchObject({ category: "resource", source: "text", what: "a slot" });
    expect(classifyBlock(handoff({ reason: "The CI workflow is still queued; no runner is available." }))).toMatchObject({ category: "dependency", source: "text", ref: "ci" });
    expect(cat(classifyBlock(handoff({ reason: "The package registry timed out twice." })))).toBe("environment/text");
    expect(classifyBlock(handoff({ reason: "the fixture service did not come up" }))).toMatchObject({ category: "unknown", source: "none" });
    expect(cat(classifyBlock(handoff()))).toBe("unknown/none");
  });

  test("the owner wins: over a declaration, over the words, over everything but a lease the watcher sees held", () => {
    // Open questions beat what the step declares.
    for (const on of ["resource", "dependency", "environment", "usage_limit", "other"] as const) {
      expect(cat(classifyBlock(handoff({ waitingOn: { on }, openQuestions: ["May I skip the rig test?"] })))).toBe("owner/questions");
    }
    // A request in the reason beats a declaration too.
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "environment" }, reason: "The deploy token is missing." })))).toBe("owner/text");
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "dependency", ref: "#41" }, reason: "The user must decide whether #41 is in scope." })))).toBe("owner/text");
    // …and beats every pattern.
    expect(cat(classifyBlock(handoff({ reason: "The package registry timed out twice.", openQuestions: ["Use the mirror?"] })))).toBe("owner/questions");
    expect(cat(classifyBlock(handoff({ reason: "Waiting for #41 to merge; it also needs a product decision." })))).toBe("owner/text");
    // Declared owner beats even the held lease.
    expect(cat(classifyBlock(handoff({ waitingOn: { on: "owner" }, reason: "the rig is in use" }), { leases: rig({ held: true, heldByOther: true }) }))).toBe("owner/declared");
    // The one thing ahead of open questions: the lease watcher's own signal
    // (the card has always read "Waiting for the rig" then).
    expect(cat(classifyBlock(handoff({ reason: "the rig is in use", openQuestions: ["Can the rig suite run later?"] }), { leases: rig({ held: true, heldByOther: true }) }))).toBe("resource/signal");
    // Blank questions aren't questions.
    expect(cat(classifyBlock(handoff({ reason: "the fixture service did not come up", openQuestions: ["", "  "] })))).toBe("unknown/none");
  });

  test("declaredOutranksQuestions (off by default): notes beside a declaration don't park the card for the owner; a real request still does", () => {
    const notes = handoff({ waitingOn: { on: "dependency", ref: "#41" }, openQuestions: ["The import in the adapter goes once #41 lands."] });
    expect(cat(classifyBlock(notes))).toBe("owner/questions");
    expect(cat(classifyBlock(notes, {}, { declaredOutranksQuestions: true }))).toBe("dependency/declared");
    const ask = handoff({ waitingOn: { on: "dependency", ref: "#41" }, openQuestions: ["Waiting for your approval to drop the old endpoint."] });
    expect(cat(classifyBlock(ask, {}, { declaredOutranksQuestions: true }))).toBe("owner/questions");
    // Without a declaration the option changes nothing.
    expect(cat(classifyBlock(handoff({ reason: "the fixture service did not come up", openQuestions: ["A note."] }), {}, { declaredOutranksQuestions: true }))).toBe("owner/questions");
  });
});

describe("parseBlockWaitConfig", () => {
  test("defaults, overrides and limits", () => {
    expect(parseBlockWaitConfig(null)).toEqual(DEFAULT_BLOCK_WAIT);
    expect(parseBlockWaitConfig("not json")).toEqual(DEFAULT_BLOCK_WAIT);
    expect(parseBlockWaitConfig("[1]")).toEqual(DEFAULT_BLOCK_WAIT);
    expect(DEFAULT_BLOCK_WAIT.backoffMin.unknown).toEqual([15, 45, 120]);
    expect(DEFAULT_BLOCK_WAIT.backoffMin.environment).toEqual([1, 5, 15, 30]);
    const c = parseBlockWaitConfig(JSON.stringify({ unknownBackoffMin: [5, 10], backoffMin: { resource: [3] }, maxPerPass: 99, maxResumes: -4, maxWaitHours: 1e9, jitter: 3, enabled: false, declaredOutranksQuestions: true }));
    expect(c.backoffMin.unknown).toEqual([5, 10]);
    expect(c.backoffMin.resource).toEqual([3]);
    expect(c.backoffMin.dependency).toEqual(DEFAULT_BLOCK_WAIT.backoffMin.dependency);
    expect(c).toMatchObject({ maxPerPass: 10, maxResumes: 0, maxWaitHours: 14 * 24, jitter: 0.5, enabled: false, declaredOutranksQuestions: true });
    // Nonsense entries are dropped; a list of only nonsense keeps the default; [] means no retries.
    expect(parseBlockWaitConfig(JSON.stringify({ unknownBackoffMin: [10, "x", -1, 99999] })).backoffMin.unknown).toEqual([10, 24 * 60]);
    expect(parseBlockWaitConfig(JSON.stringify({ unknownBackoffMin: ["x"] })).backoffMin.unknown).toEqual([15, 45, 120]);
    expect(parseBlockWaitConfig(JSON.stringify({ unknownBackoffMin: [] })).backoffMin.unknown).toEqual([]);
    expect(parseBlockWaitConfig(JSON.stringify({ unknownBackoffMin: Array(40).fill(1) })).backoffMin.unknown.length).toBe(12);
  });
});

const NOW = new Date(2031, 2, 4, 15, 0, 0).getTime();
const MIN = 60_000;
const verdict = (category: BlockWaitCategory): BlockVerdict & { category: BlockWaitCategory } => ({ category, source: "none", what: "its own stated reason", ref: null, why: "no known reason matched" });
const plan = (category: BlockWaitCategory, prev: PipelineBlockWait | null, now = NOW, rng = () => 0, config = DEFAULT_BLOCK_WAIT) =>
  planWait({ stepId: "build", taskId: "t1", verdict: verdict(category), reason: "the fixture service did not come up", prev, config, now, rng });
/** The entry as the queue leaves it after resuming the step. */
const resumed = (w: PipelineBlockWait, at: number): PipelineBlockWait => ({ ...w, state: "resuming", attempt: w.attempt + 1, at: null, tried: [...w.tried, { at, trigger: "its retry time came" }] });

describe("planWait", () => {
  test("unknown: 15 min, 45 min, 2 h, then the owner — with what was tried", () => {
    let w = plan("unknown", null);
    const delays: number[] = [];
    let now = NOW;
    while (w.state === "waiting") {
      delays.push((w.at! - now) / MIN);
      now = w.at!;
      w = plan("unknown", resumed(w, now), now);
    }
    expect(delays).toEqual([15, 45, 120]);
    expect(w).toMatchObject({ state: "escalated", attempt: 3, max: 3, at: null, escalatedAt: now, escalation: "still blocked after 3 automatic retries", since: NOW });
    expect(w.tried.map((t) => (t.at - NOW) / MIN)).toEqual([15, 60, 180]);
    expect(triedLine(w, now)).toBe("retried 3 times (3:15 PM, 4:00 PM, 6:00 PM)");
    expect(escalationLine("Build", w, now)).toEqual({
      line: "Build still blocked after 3 automatic retries: the fixture service did not come up",
      reason: "Build still blocked after 3 automatic retries — retried 3 times (3:15 PM, 4:00 PM, 6:00 PM); it says: the fixture service did not come up",
    });
  });

  test("the other schedules", () => {
    const first = (c: BlockWaitCategory) => [(plan(c, null).at! - NOW) / MIN, plan(c, null).max];
    expect(first("environment")).toEqual([1, 4]);
    expect(first("limit")).toEqual([15, 3]);
    expect(first("resource")).toEqual([10, 6]);
    expect(first("dependency")).toEqual([30, 4]);
    // The transient backoff, in full.
    let w = plan("environment", null);
    const delays: number[] = [];
    let now = NOW;
    while (w.state === "waiting") {
      delays.push((w.at! - now) / MIN);
      now = w.at!;
      w = plan("environment", resumed(w, now), now);
    }
    expect(delays).toEqual([1, 5, 15, 30]);
  });

  test("jitter only ever lengthens a wait, by at most the configured share", () => {
    expect((plan("unknown", null, NOW, () => 0).at! - NOW) / MIN).toBe(15);
    expect((plan("unknown", null, NOW, () => 0.5).at! - NOW) / MIN).toBe(15.75);
    expect((plan("unknown", null, NOW, () => 0.9999999).at! - NOW) / MIN).toBeLessThanOrEqual(16.5);
    expect((plan("unknown", null, NOW, () => 7).at! - NOW) / MIN).toBeLessThanOrEqual(16.5); // a bad rng can't stretch it further
  });

  test("attempts carry over when what it waits on changes; maxResumes bounds the total; the deadline bounds the time", () => {
    // Two unknown resumes, then the step says it waits on a dependency.
    let w = plan("unknown", null);
    w = plan("unknown", resumed(w, NOW + 15 * MIN), NOW + 15 * MIN);
    w = plan("dependency", resumed(w, NOW + 60 * MIN), NOW + 60 * MIN);
    expect(w).toMatchObject({ category: "dependency", state: "waiting", attempt: 2, max: 4, since: NOW });
    expect((w.at! - (NOW + 60 * MIN)) / MIN).toBe(120); // the third dependency interval

    const tight = { ...DEFAULT_BLOCK_WAIT, maxResumes: 2 };
    const capped = plan("resource", { ...plan("resource", null), attempt: 2, state: "resuming" }, NOW, () => 0, tight);
    expect(capped).toMatchObject({ state: "escalated", max: 2, escalation: "still blocked after 2 automatic retries" });

    // Still parked a day later: the owner's, whatever is left.
    const old = { ...plan("dependency", null), state: "resuming" as const, attempt: 1 };
    const late = plan("dependency", old, NOW + 25 * 60 * MIN);
    expect(late).toMatchObject({ state: "escalated", escalation: "still waiting after 25h" });
    // A wait never runs past the deadline.
    const near = plan("dependency", old, NOW + 23.9 * 60 * MIN);
    expect(near.at).toBe(old.deadline);

    // A different execution's entry is not this one's history.
    expect(plan("unknown", { ...plan("unknown", null), taskId: "other", attempt: 2 }).attempt).toBe(0);
    // No retries configured: straight to the owner, said plainly.
    expect(plan("unknown", null, NOW, () => 0, { ...DEFAULT_BLOCK_WAIT, backoffMin: { ...DEFAULT_BLOCK_WAIT.backoffMin, unknown: [] } })).toMatchObject({
      state: "escalated",
      attempt: 0,
      escalation: "automatic retries are turned off for this kind of block",
    });
  });

  test("a wait on a numbered issue or PR has no timer and spends no attempt while it waits", () => {
    const dep = (ref: string | null) => ({ ...verdict("dependency"), what: ref ?? "another change", ref });
    const at = (ref: string | null, endless = false, prev: PipelineBlockWait | null = null, now = NOW) =>
      planWait({ stepId: "build", taskId: "t1", verdict: dep(ref), reason: "waits on #1662 to merge", prev, config: DEFAULT_BLOCK_WAIT, now, rng: () => 0, endless });
    expect(at("#1662")).toMatchObject({ state: "waiting", at: null, attempt: 0, max: 4 });
    expect(at("#1662", true)).toMatchObject({ state: "waiting", at: null, deadline: Number.MAX_SAFE_INTEGER });
    // Even after its retries are spent, endless re-checks are GitHub's, not a timer's.
    expect(at("#1662", true, { ...at("#1662", true), state: "resuming", attempt: 4 })).toMatchObject({ state: "waiting", at: null, attempt: 4 });
    // Not endless: the owner still gets it at the deadline.
    expect(at("#1662", false, { ...at("#1662"), state: "resuming", attempt: 1 }, NOW + 25 * 60 * MIN)).toMatchObject({ state: "escalated" });
    // CI on the base branch and an unnamed change keep their timers.
    expect(at("base-ci").at).toBe(NOW + 30 * MIN);
    expect(at(null).at).toBe(NOW + 30 * MIN);
    expect([waitsOnIssue({ category: "dependency", ref: "#7" }), waitsOnIssue({ category: "dependency", ref: "PR 7" }), waitsOnIssue({ category: "dependency", ref: "base-ci" }), waitsOnIssue({ category: "resource", ref: "#7" })]).toEqual([true, true, false, false]);
  });

  test("the reason is one capped line", () => {
    const w = planWait({ stepId: "s", taskId: "t", verdict: verdict("unknown"), reason: `- first point ${"x".repeat(400)}\n- second point`, config: DEFAULT_BLOCK_WAIT, now: NOW, rng: () => 0 });
    expect(w.reason.startsWith("first point x")).toBe(true);
    expect(w.reason.length).toBe(240);
    expect(planWait({ stepId: "s", taskId: "t", verdict: verdict("unknown"), reason: " \n ", config: DEFAULT_BLOCK_WAIT, now: NOW }).reason).toBe("no reason given");
  });
});

describe("reading the queue", () => {
  const w = (over: Partial<PipelineBlockWait> = {}): PipelineBlockWait => ({ ...plan("unknown", null), ...over });
  const run = (status: PipelineRunState["status"], wait?: PipelineBlockWait) => ({ status, wait }) as PipelineRunState;

  test("the status line says what it waits on, when it is retried, and which attempt", () => {
    expect(waitLine("Build", w({ category: "resource", what: "the lab", ref: "lab", max: 3, attempt: 1, at: NOW + 40 * MIN }), NOW, true)).toBe("Build waiting for the lab — retrying when it frees or at 3:40 PM · attempt 2 of 3");
    expect(waitLine("Build", w({ category: "resource", what: "a slot", max: 6, at: NOW + 10 * MIN }), NOW)).toBe("Build waiting for a slot — retrying at 3:10 PM · attempt 1 of 6");
    // A numbered issue or PR has no timer, even on an entry an older build parked with one.
    expect(waitLine("Finish", w({ category: "dependency", what: "#41", ref: "#41", max: 4, at: NOW + 30 * MIN }), NOW, true)).toBe("Finish waiting on #41 — resumes when it is closed · attempt 1 of 4");
    expect(waitLine("Finish", w({ category: "dependency", what: "develop's CI", ref: "base-ci", max: 4, at: NOW + 30 * MIN }), NOW, true)).toBe("Finish waiting on develop's CI — retrying when it passes or at 3:30 PM · attempt 1 of 4");
    expect(waitLine("Build", w({ category: "environment", max: 4, at: NOW + MIN }), NOW)).toBe("Build hit a transient failure — retrying at 3:01 PM · attempt 1 of 4");
    expect(waitLine("Build", w({ category: "limit", at: NOW + 15 * MIN }), NOW)).toBe("Build waiting on a usage limit — retrying at 3:15 PM · attempt 1 of 3");
    expect(waitLine("Build", w({ at: NOW + 15 * MIN }), NOW)).toBe("Build blocked — retrying at 3:15 PM · attempt 1 of 3");
    // Tomorrow says so.
    expect(waitLine("Build", w({ at: NOW + 20 * 60 * MIN }), NOW)).toMatch(/^Build blocked — retrying at Wed 11:00 AM · attempt 1 of 3$/);
    expect(waitLine("Build", w({ state: "resuming", attempt: 2, at: null }), NOW)).toBe("Build resumed to check whether its block has cleared · attempt 2 of 3");
  });

  test("waiting in the queue, resuming and given up are told apart", () => {
    expect(waitingInQueue(run("blocked", w()))).toBe(true);
    expect(waitingInQueue(run("blocked"))).toBe(false);
    expect(waitingInQueue(run("blocked", w({ state: "escalated" })))).toBe(false);
    expect(waitingInQueue(run("running", w({ state: "resuming" })))).toBe(false);
    expect(queuedWait(run("running", w({ state: "resuming" })))).not.toBeNull();
    expect(queuedWait(run("blocked", w({ state: "escalated" })))).toBeNull();
    expect(escalatedWait(run("blocked", w({ state: "escalated" })))).not.toBeNull();
    expect(escalatedWait(run("blocked", w()))).toBeNull();
    expect(waitingInQueue(null)).toBe(false);
  });

  test("what the queue can watch", () => {
    expect(waitHasTrigger({ category: "resource", ref: "Rig" }, ["rig"])).toBe(true);
    expect(waitHasTrigger({ category: "resource", ref: "rig" }, [])).toBe(false);
    expect(waitHasTrigger({ category: "resource", ref: null }, ["rig"])).toBe(false);
    expect(waitHasTrigger({ category: "dependency", ref: "#41" })).toBe(true);
    expect(waitHasTrigger({ category: "dependency", ref: "base-ci" })).toBe(true);
    expect(waitHasTrigger({ category: "dependency", ref: "ci" })).toBe(false);
    expect(waitHasTrigger({ category: "unknown", ref: "#41" })).toBe(false);
  });
});
