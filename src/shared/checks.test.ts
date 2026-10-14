import { describe, expect, test } from "bun:test";
import type { CheckLedgerEntry, Handoff, PipelineStep, StepCheck } from "./types.ts";
import {
  BUILTIN_CHECKS, CHECK_LIMITS, COMPOSED_HANDOFF_MARK, builtinCheck, checkDefHash, checkRoster, composedHandoff, defaultStepChecks, exhaustedHandoff,
  gateFailureLine, gateVerdict, headApprovedFinding, ledgerEntry, ledgerEvaluations, orderChecks, outputTail, parseCheckLedger, planCheck, prRequiredFinding,
  renderCheckFailures, reusablePass, reviewVerdictFinding, unrunResult, validateStepChecks, type CheckKey, type CheckResult,
} from "./checks.ts";
import {
  CHECK_FEEDBACK_MARKER, composeCheckFeedback, composeStepPrompt, defaultChecksOf, newStep, normalizeHandoff, stepGate, updatedPipelineGates, validatePipelineGraph,
} from "./pipeline.ts";
import { parsePipelineGate, publishGateOn } from "./publish.ts";

const cmd = (id: string, o: Partial<StepCheck> = {}): StepCheck => ({
  id, description: `${id} passes`, run: { kind: "command", command: `run-${id}` }, required: true, timeoutSec: 120, ...o,
});
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const KEY: CheckKey = { head: HEAD, tree: "t".repeat(40), baseTip: "c".repeat(40) };
const result = (check: StepCheck, outcome: CheckResult["outcome"], o: Partial<CheckResult> = {}): CheckResult => ({
  check, outcome, satisfied: outcome === "pass", exitCode: null, detail: outcome, output: "", outputPath: null, ...o,
});
const entry = (check: StepCheck, outcome: CheckLedgerEntry["outcome"], o: Partial<CheckLedgerEntry> = {}): CheckLedgerEntry => ({
  ...ledgerEntry({ at: 1, stepId: "build", stepName: "Build", seq: 1, turn: 1, key: KEY, result: result(check, "pass") }),
  outcome, satisfied: outcome === "pass", ...o,
});

describe("validateStepChecks", () => {
  test("defaults: a built-in's description, required, the default timeout", () => {
    const v = validateStepChecks([{ id: "tree-clean", run: { kind: "builtin", name: "tree-clean" } }, { id: "unit", description: "unit tests pass", run: { kind: "command", command: " true " }, required: false, timeoutSec: 30, dependsOn: ["tree-clean", "tree-clean"], skipWhen: "unchanged-since-pass" }], "Build");
    expect(v).toEqual({
      ok: true,
      checks: [
        builtinCheck("tree-clean"),
        { id: "unit", description: "unit tests pass", run: { kind: "command", command: "true" }, dependsOn: ["tree-clean"], skipWhen: "unchanged-since-pass", required: false, timeoutSec: 30 },
      ],
    });
  });

  const ok = { id: "a", description: "a", run: { kind: "command", command: "true" } };
  const rejected: [string, unknown, string][] = [
    ["not a list", {}, "checks must be an array"],
    ["too many", Array.from({ length: CHECK_LIMITS.perStep + 1 }, (_, i) => ({ ...ok, id: `c${i}` })), "exceed the limit"],
    ["an entry that is not an object", ["tree-clean"], "not an object"],
    ["no id", [{ ...ok, id: "" }], "invalid id"],
    ["an id with a space", [{ ...ok, id: "a b" }], "invalid id"],
    ["a duplicate id, whatever its case", [ok, { ...ok, id: "A" }], 'two checks called "A"'],
    ["no run", [{ id: "a", description: "a" }], 'has no "run"'],
    ["an unknown built-in", [{ id: "a", run: { kind: "builtin", name: "lint" } }], "unknown built-in"],
    ["an empty command", [{ ...ok, run: { kind: "command", command: "  " } }], "empty command"],
    ["another kind of run", [{ ...ok, run: { kind: "script" } }], 'must be "builtin" or "command"'],
    ["a command with no description", [{ id: "a", run: { kind: "command", command: "true" } }], "needs a description"],
    ["a description of several lines", [{ ...ok, description: "a\nb\u0007" }], "one line"],
    ["a required that is not a boolean", [{ ...ok, required: "yes" }], "required must be"],
    ["another skipWhen", [{ ...ok, skipWhen: "always" }], "skipWhen"],
    ["a timeout over the cap", [{ ...ok, timeoutSec: CHECK_LIMITS.timeoutMaxSec + 1 }], "timeoutSec"],
    ["a fractional timeout", [{ ...ok, timeoutSec: 1.5 }], "timeoutSec"],
    ["dependsOn that is not a list of ids", [{ ...ok, dependsOn: "b" }], "dependsOn must be"],
    ["a dependency on itself", [{ ...ok, dependsOn: ["a"] }], "depends on itself"],
    ["a dependency that is not there", [{ ...ok, dependsOn: ["b"] }], 'depends on "b"'],
    ["a cycle", [{ ...ok, dependsOn: ["b"] }, { ...ok, id: "b", dependsOn: ["a"] }], "cycle"],
  ];
  test.each(rejected)("rejects %s", (_name, raw, message) => {
    const v = validateStepChecks(raw, "Build");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(message);
    if (!v.ok) expect(v.error).toStartWith('step "Build" ');
  });

  test("every built-in name is accepted and has a description", () => {
    for (const name of BUILTIN_CHECKS) expect(validateStepChecks([{ id: name, run: { kind: "builtin", name } }], "S").ok).toBe(true);
  });
});

describe("the pipeline validator keeps a step's gate", () => {
  const graph = (step: Record<string, unknown>) => ({ steps: [{ id: "s", name: "Build", position: { x: 0, y: 0 }, ...step }], edges: [], startStepId: null });
  test("goal, checks and maxTurns survive a save; a graph without them is unchanged", () => {
    const v = validatePipelineGraph(graph({ goal: "  The change is committed.  ", checks: [{ id: "unit", description: "unit", run: { kind: "command", command: "true" } }], maxTurns: 3 }));
    expect(v.ok && v.graph.steps[0]).toMatchObject({ goal: "The change is committed.", maxTurns: 3, checks: [{ id: "unit", required: true, timeoutSec: 120 }] });
    const plain = validatePipelineGraph(graph({}));
    expect(plain.ok && Object.keys(plain.graph.steps[0]!).sort()).toEqual(["agentProfileId", "id", "instructions", "join", "name", "position", "subagents", "transition"]);
  });
  test("an empty list is kept: it says no gate, where an absent one says the defaults", () => {
    const v = validatePipelineGraph(graph({ checks: [], maxTurns: 0, goal: "" }));
    expect(v.ok && v.graph.steps[0]).toMatchObject({ checks: [], maxTurns: 0 });
    expect(v.ok && "goal" in v.graph.steps[0]!).toBe(false);
  });
  test.each([
    [{ checks: [{ id: "x" }] }, 'has no "run"'],
    [{ maxTurns: 6 }, "maxTurns must be an integer between 0 and 5"],
    [{ maxTurns: -1 }, "maxTurns"],
    [{ goal: 3 }, "goal must be text"],
    [{ goal: "x".repeat(CHECK_LIMITS.goal + 1) }, "goal exceeds"],
  ] as [Record<string, unknown>, string][])("rejects %j", (step, message) => {
    const v = validatePipelineGraph(graph(step));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(message);
  });
});

describe("the switch", () => {
  const card = { id: "card-1", pipelineId: "p1", pipelineName: "Change" };
  const cases: [string, string | null, boolean, boolean][] = [
    ["nothing set", null, false, false],
    ["not JSON", "{", false, false],
    ["steps for the pipeline", '{"steps":{"pipelines":["change"]}}', false, true],
    ["steps for a list of cards that names it", '{"steps":{"pipelines":["Change"],"cards":["card-1","card-2"]}}', false, true],
    ["steps for a list of cards that does not", '{"steps":{"pipelines":["Change"],"cards":["card-9"]}}', false, false],
    ["an unreadable card list allows no card", '{"steps":{"pipelines":["Change"],"cards":"card-1"}}', false, false],
    ["cards without pipelines", '{"steps":{"cards":["card-1"]}}', false, false],
    ["publish alone leaves steps off", '{"publish":{"pipelines":["Change"]}}', true, false],
    ["both, each with its own list", '{"publish":{"pipelines":["p1"],"cards":["card-9"]},"steps":{"pipelines":["p1"]}}', false, true],
  ];
  test.each(cases)("%s", (_name, raw, publish, steps) => {
    expect(publishGateOn(parsePipelineGate(raw, "publish"), card)).toBe(publish);
    expect(publishGateOn(parsePipelineGate(raw, "steps"), card)).toBe(steps);
  });
});

describe("stepGate", () => {
  const build = newStep({ id: "b", name: "Build" }), review = newStep({ id: "r", name: "Review" }), finish = newStep({ id: "f", name: "Finish", canFinish: true });
  const understand = newStep({ id: "u", name: "Understand" });
  const edges = [{ id: "e0", from: "u", to: "b", label: "" }, { id: "e1", from: "b", to: "r", label: "" }, { id: "e2", from: "r", to: "f", label: "approved" }, { id: "e3", from: "r", to: "b", label: "changes requested" }];
  const snap = (steps: PipelineStep[], gates?: { steps?: true; publish?: true }) => ({ graph: { steps, edges, startStepId: "u" }, ...(gates ? { gates } : {}) });
  const on = snap([understand, build, review, finish], { steps: true });

  test("off unless the run adopted the gate", () => {
    expect(stepGate(snap([understand, build, review, finish]), build)).toBeNull();
    expect(stepGate(snap([understand, build, review, finish], { publish: true }), build)).toBeNull();
    expect(stepGate(null, build)).toBeNull();
  });
  test("the Change pipeline's defaults are built-ins only: Build and Review are gated, nothing else is", () => {
    expect(stepGate(on, build)).toEqual({ checks: [builtinCheck("tree-clean"), builtinCheck("diff-nonempty")], goal: null, maxTurns: 2 });
    expect(stepGate(on, review)!.checks.map((c) => c.id)).toEqual(["tree-clean", "review-verdict"]);
    expect(stepGate(on, understand)).toBeNull();
    expect(stepGate(on, finish)).toBeNull();
    for (const role of ["build", "review"] as const) expect(defaultStepChecks(role).every((c) => c.run.kind === "builtin" && c.required)).toBe(true);
    expect(defaultStepChecks(null)).toEqual([]);
  });
  // The trivial change, as the board's graph routes it today (→ Finish) and
  // as Pillar's instruction policy routes it (→ Review).
  const trivial = (to: "f" | "r") => ({ graph: { steps: [understand, build, review, finish], edges: [...edges, { id: "e4", from: "u", to, label: "trivial change made" }, { id: "e5", from: "f", to: "b", label: "verification failed" }], startStepId: "u" }, gates: { steps: true as const } });
  const visit = (seq: number, stepId: string, next: string[], outcome: "succeeded" | "advanced-manually" | "failed" | null = "succeeded") => ({ seq, stepId, outcome, nextStepIds: next });
  const required = (gate: ReturnType<typeof stepGate>) => gate!.checks.map((c) => [c.id, c.required]);
  test("trivial change → Finish: Review is only ever handed the work by Build, and both its defaults are required", () => {
    const snap = trivial("f");
    for (const history of [[], [visit(1, "u", ["b"]), visit(2, "b", ["r"])], [visit(1, "u", ["f"]), visit(2, "f", ["b"]), visit(3, "b", ["r"])]]) {
      expect(required(stepGate(snap, review, history))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    }
    expect(required(stepGate(snap, build, [visit(1, "u", ["f"]), visit(2, "f", ["b"])]))).toEqual([["tree-clean", true], ["diff-nonempty", true]]);
    expect(stepGate(snap, understand)).toBeNull();
    expect(stepGate(snap, finish)).toBeNull();
  });
  test("trivial change → Review: a visit Understand handed the work to reports `tree-clean` and is held by its verdict alone", () => {
    const snap = trivial("r");
    expect(required(stepGate(snap, review, [visit(1, "u", ["r"])]))).toEqual([["tree-clean", false], ["review-verdict", true]]);
    expect(required(stepGate(snap, review, [visit(1, "u", ["r"], "advanced-manually")]))).toEqual([["tree-clean", false], ["review-verdict", true]]);
    // Review's own visits do not change who handed it the work.
    expect(required(stepGate(snap, review, [visit(1, "u", ["r"]), visit(2, "r", ["f"]), visit(3, "f", [])]))).toEqual([["tree-clean", false], ["review-verdict", true]]);
    // Build's gate has passed since: the check is Review's to hold again.
    expect(required(stepGate(snap, review, [visit(1, "u", ["r"]), visit(2, "r", ["b"]), visit(3, "b", ["r"])]))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    expect(required(stepGate(snap, review, [visit(1, "u", ["r"]), visit(2, "r", ["f"]), visit(3, "f", ["b"]), visit(4, "b", ["r"])]))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    // The ordinary card on the same graph, a visit that did not finish, and no history at all.
    expect(required(stepGate(snap, review, [visit(1, "u", ["b"]), visit(2, "b", ["r"])]))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    expect(required(stepGate(snap, review, [visit(1, "u", ["b"]), visit(2, "b", ["r"]), visit(3, "u", ["r"], "failed")]))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    expect(required(stepGate(snap, review))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    // Build is gated as on any card; a Review that declares its checks keeps them as written.
    expect(required(stepGate(snap, build, [visit(1, "u", ["r"]), visit(2, "r", ["b"])]))).toEqual([["tree-clean", true], ["diff-nonempty", true]]);
    const own = { ...review, checks: [builtinCheck("tree-clean"), builtinCheck("review-verdict")] };
    expect(required(stepGate({ ...snap, graph: { ...snap.graph, steps: [understand, build, own, finish] } }, own, [visit(1, "u", ["r"])]))).toEqual([["tree-clean", true], ["review-verdict", true]]);
    expect(defaultChecksOf(snap.graph, review, [visit(1, "u", ["r"])]).map((c) => [c.id, c.required])).toEqual([["tree-clean", false], ["review-verdict", true]]);
    expect(defaultChecksOf(snap.graph, understand, [visit(1, "u", ["r"])])).toEqual([]);
  });
  test("a step's own checks, goal and turns win; an empty list is no gate; a follow-up never has one", () => {
    const own = { ...build, checks: [cmd("unit")], goal: " Committed. ", maxTurns: 4 };
    expect(stepGate(snap([understand, own, review, finish], { steps: true }), own)).toEqual({ checks: [cmd("unit")], goal: "Committed.", maxTurns: 4 });
    const none = { ...build, checks: [] };
    expect(stepGate(snap([understand, none, review, finish], { steps: true }), none)).toBeNull();
    const followUp = newStep({ id: "followup-1", name: "Fix CI", checks: [cmd("unit")] });
    expect(stepGate(snap([followUp], { steps: true }), followUp)).toBeNull();
    // Outside a reviewed pipeline a step called Build has no defaults.
    expect(stepGate({ graph: { steps: [build], edges: [], startStepId: null }, gates: { steps: true } }, build)).toBeNull();
  });
  test("updatedPipelineGates copies only the gate, by step id", () => {
    const run = { steps: [{ ...build, instructions: "old text", checks: [cmd("stale")] }, review], edges, startStepId: "b" };
    const template = { steps: [{ ...build, instructions: "new text", goal: "Committed.", checks: [cmd("unit")], maxTurns: 1 }, { ...review, id: "other" }], edges, startStepId: "b" };
    const next = updatedPipelineGates(run, template);
    expect(next.steps[0]).toMatchObject({ instructions: "old text", goal: "Committed.", checks: [cmd("unit")], maxTurns: 1 });
    expect(next.steps[1]).toBe(review);
    expect(updatedPipelineGates(next, template)).toBe(next); // nothing differs: the same graph
    const cleared = updatedPipelineGates(next, { ...template, steps: [build] });
    expect("checks" in cleared.steps[0]! || "goal" in cleared.steps[0]! || "maxTurns" in cleared.steps[0]!).toBe(false);
  });
});

describe("planning", () => {
  test("orderChecks: declaration order, dependencies first", () => {
    const order = (checks: StepCheck[]) => orderChecks(checks).map((c) => c.id);
    expect(order([cmd("a"), cmd("b"), cmd("c")])).toEqual(["a", "b", "c"]);
    expect(order([cmd("slow", { dependsOn: ["cheap"] }), cmd("cheap"), cmd("last", { dependsOn: ["slow"] })])).toEqual(["cheap", "slow", "last"]);
    // A cycle or a missing dependency is left out, never looped on.
    expect(order([cmd("a", { dependsOn: ["b"] }), cmd("b", { dependsOn: ["a"] }), cmd("c")])).toEqual(["c"]);
    expect(order([cmd("a", { dependsOn: ["gone"] })])).toEqual([]);
  });

  test("planCheck: blocked by what it depends on, else a reusable pass, else run", () => {
    const a = cmd("a"), b = cmd("b", { dependsOn: ["a"] });
    const done = (r: CheckResult) => new Map([["a", r]]);
    expect(planCheck(a, new Map(), null)).toEqual({ action: "run" });
    expect(planCheck(b, done(result(a, "pass")), null)).toEqual({ action: "run" });
    expect(planCheck(b, done(result(a, "fail")), null)).toEqual({ action: "blocked", by: ["a"], halted: false });
    expect(planCheck(b, done(result(a, "halt")), null)).toEqual({ action: "blocked", by: ["a"], halted: true });
    expect(planCheck(b, done(result(a, "skip", { satisfied: true })), null)).toEqual({ action: "run" });
    const from = entry(b, "pass");
    expect(planCheck(b, done(result(a, "pass")), from)).toEqual({ action: "reuse", from });
    // A dependency that did not pass wins over a recorded pass.
    expect(planCheck(b, done(result(a, "fail")), from).action).toBe("blocked");
    expect(unrunResult(b, { action: "reuse", from })).toMatchObject({ outcome: "skip", satisfied: true });
    expect(unrunResult(b, { action: "blocked", by: ["a"], halted: false })).toMatchObject({ outcome: "skip", satisfied: false, detail: 'not run: "a" did not pass' });
    expect(unrunResult(b, { action: "blocked", by: ["a"], halted: true })).toMatchObject({ outcome: "halt", satisfied: false });
  });

  test("reusablePass: only for skipWhen, only the newest result for exactly this key and definition", () => {
    const c = cmd("unit", { skipWhen: "unchanged-since-pass" });
    const passed = entry(c, "pass");
    const cases: [string, StepCheck, CheckKey, CheckLedgerEntry[], boolean][] = [
      ["a recorded pass for the same key", c, KEY, [passed], true],
      ["no skipWhen", cmd("unit"), KEY, [passed], false],
      ["another head", c, { ...KEY, head: OTHER }, [passed], false],
      ["another tree", c, { ...KEY, tree: "x" }, [passed], false],
      ["the base moved", c, { ...KEY, baseTip: OTHER }, [passed], false],
      ["HEAD unknown", c, { ...KEY, head: null }, [passed], false],
      ["the command changed", { ...c, run: { kind: "command", command: "other" } }, KEY, [passed], false],
      ["a pass on another step", c, KEY, [entry(c, "pass", { stepId: "review" })], false],
      ["failed since", c, KEY, [passed, entry(c, "fail")], false],
      ["voided since", c, KEY, [passed, entry(c, "void")], false],
      ["waived since", c, KEY, [passed, entry(c, "waived")], false],
      ["passed again after a failure", c, KEY, [entry(c, "fail"), passed], true],
      ["a reuse recorded since is looked past", c, KEY, [passed, entry(c, "skip", { satisfied: true })], true],
      ["a failure for another head does not cancel it", c, KEY, [passed, entry(c, "fail", { key: { ...passed.key, head: OTHER } })], true],
    ];
    for (const [name, check, key, ledger, reuse] of cases) expect([name, reusablePass(check, "build", key, ledger) !== null]).toEqual([name, reuse]);
  });

  test("the definition hash covers what a check does, not how it is described", () => {
    const c = cmd("unit");
    expect(checkDefHash(c)).toBe(checkDefHash({ ...c, description: "other words", required: false, timeoutSec: 5 }));
    expect(checkDefHash(c)).not.toBe(checkDefHash({ ...c, run: { kind: "command", command: "other" } }));
    expect(checkDefHash(c)).not.toBe(checkDefHash({ ...c, id: "unit2" }));
    expect(checkDefHash(builtinCheck("tree-clean"))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("gateVerdict", () => {
  const a = cmd("a"), opt = cmd("opt", { required: false }), dep = cmd("dep", { dependsOn: ["opt"] });
  const cases: [string, CheckResult[], "pass" | "fail" | "halt", string[], string[]][] = [
    ["no checks", [], "pass", [], []],
    ["all pass", [result(a, "pass"), result(opt, "pass")], "pass", [], []],
    ["a reused pass counts", [result(a, "skip", { satisfied: true })], "pass", [], []],
    ["an optional failure does not gate", [result(a, "pass"), result(opt, "fail")], "pass", [], []],
    ["a required failure", [result(a, "fail")], "fail", ["a"], []],
    ["a required check that could not be evaluated", [result(a, "halt")], "halt", [], ["a"]],
    ["a failure and a halt: the failure is the step's to fix", [result(a, "fail"), result(cmd("b"), "halt")], "fail", ["a"], ["b"]],
    ["a required check blocked by an optional failure", [result(opt, "fail"), result(dep, "skip")], "fail", ["opt"], ["dep"]],
    ["a required check blocked by something unevaluated", [result(opt, "halt"), result(dep, "halt")], "halt", [], ["dep"]],
  ];
  test.each(cases)("%s", (_name, results, state, failed, unmet) => {
    const v = gateVerdict(results);
    expect({ state: v.state, failed: v.failed.map((r) => r.check.id), unmet: v.unmet.map((r) => r.check.id) }).toEqual({ state, failed, unmet });
  });
  test("one line for a block", () => {
    expect(gateFailureLine(gateVerdict([result(a, "fail", { detail: "exit 1" }), result(cmd("b"), "halt", { detail: "GitHub could not be read" })]))).toBe("a (exit 1); b (GitHub could not be read)");
  });
});

describe("built-ins judged from what was read", () => {
  const approval = (o: Partial<NonNullable<Handoff["reviewApproval"]>> = {}) => ({
    reviewApproval: { verdict: "approved" as const, headSha: HEAD, issueUrl: "https://github.com/o/r/issues/3", acceptanceComplete: true, findings: [], ...o },
  });
  const verdicts: [string, Pick<Handoff, "reviewApproval"> | null, string | null, string, string][] = [
    ["approved for HEAD", approval(), HEAD, "pass", "approved for aaaaaaaa"],
    ["changes requested for HEAD is a judgement, and passes", approval({ verdict: "changes-requested", acceptanceComplete: false, findings: ["x"] }), HEAD, "pass", "changes-requested"],
    ["a verdict for another head", approval({ headSha: OTHER }), HEAD, "fail", "the verdict is for bbbbbbbb, but HEAD is aaaaaaaa"],
    ["the sha compares without case", approval({ headSha: HEAD.toUpperCase() }), HEAD, "pass", "approved"],
    ["approved with findings", approval({ findings: ["x"] }), HEAD, "fail", '"approved" with 1 finding(s)'],
    ["approved with acceptance incomplete", approval({ acceptanceComplete: false }), HEAD, "fail", "acceptanceComplete false"],
    ["a handoff without a verdict", {}, HEAD, "fail", 'no readable "reviewApproval"'],
    ["no handoff at all", null, HEAD, "fail", "ended without a handoff"],
    ["HEAD unreadable", approval(), null, "halt", "HEAD could not be read"],
  ];
  test.each(verdicts)("review-verdict: %s", (_name, handoff, head, outcome, detail) => {
    const f = reviewVerdictFinding(handoff, head, "https://github.com/o/r/issues/3");
    expect(f.outcome).toBe(outcome as typeof f.outcome);
    expect(f.satisfied).toBe(outcome === "pass");
    expect(f.detail).toContain(detail);
  });
  test("review-verdict: a missing verdict's output is the exact shape to write", () => {
    expect(reviewVerdictFinding({}, HEAD, "https://github.com/o/r/issues/3").output).toContain('"issueUrl":"https://github.com/o/r/issues/3"');
  });
  test("a verdict that normalizeHandoff drops is a missing verdict", () => {
    const h = normalizeHandoff({ summary: "ok", reviewApproval: { verdict: "approved", headSha: "abc", issueUrl: "", acceptanceComplete: true, findings: [] } });
    expect(reviewVerdictFinding(h, HEAD).outcome).toBe("fail");
  });

  test.each([
    ["approved head", approval(), HEAD, "pass"],
    ["a commit after the approval", approval(), OTHER, "fail"],
    ["the last Review asked for changes", approval({ verdict: "changes-requested" }), HEAD, "fail"],
    ["no Review recorded a verdict", null, HEAD, "fail"],
    ["HEAD unreadable", approval(), null, "halt"],
  ] as [string, Pick<Handoff, "reviewApproval"> | null, string | null, string][])("head-approved: %s", (_name, last, head, outcome) => {
    expect(headApprovedFinding(last, head).outcome).toBe(outcome as "pass");
  });

  const pull = (o: Partial<{ number: number; headSha: string | null; state: string }> = {}) => ({ number: 7, headSha: HEAD, state: "open", ...o });
  const seen = (state: "none" | "pending" | "success" | "failure", p: ReturnType<typeof pull> | null = pull(), failing: string[] = []) => ({ readable: true as const, pull: p, state, failing });
  const required: [string, Parameters<typeof prRequiredFinding>[0], string, boolean][] = [
    ["no pull request: it does not apply", seen("none", null), "skip", true],
    ["passed for HEAD", seen("success"), "pass", true],
    ["failed for HEAD", seen("failure", pull(), ["web"]), "fail", false],
    ["still running", seen("pending"), "halt", false],
    ["nothing reported yet", seen("none"), "halt", false],
    ["the pull request is at another head", seen("success", pull({ headSha: OTHER })), "fail", false],
    ["the pull request was closed", seen("success", pull({ state: "closed" })), "halt", false],
    ["GitHub could not be read", { readable: false }, "halt", false],
  ];
  test.each(required)("pr-required-check: %s", (_name, input, outcome, satisfied) => {
    const f = prRequiredFinding(input, HEAD);
    expect([f.outcome, f.satisfied]).toEqual([outcome as "pass", satisfied]);
  });
});

describe("the ledger", () => {
  test("a line round-trips; a torn or foreign line is left out", () => {
    const c = cmd("unit");
    const line = ledgerEntry({ at: 5, stepId: "build", stepName: "Build", seq: 3, turn: 2, key: KEY, result: result(c, "fail", { exitCode: 2, detail: "exit 2", output: "boom", outputPath: "/tmp/x.log" }) });
    expect(line).toMatchObject({ checkId: "unit", outcome: "fail", satisfied: false, exitCode: 2, outputTail: "boom", key: { head: HEAD, def: checkDefHash(c) } });
    const text = [JSON.stringify(line), "{not json", JSON.stringify({ at: 1 }), JSON.stringify({ ...line, outcome: "great" }), "", JSON.stringify({ ...line, seq: 4 }).slice(0, 40)].join("\n");
    expect(parseCheckLedger(text)).toEqual([line]);
  });
  test("evaluations of one step, newest first", () => {
    const c = cmd("unit"), d = cmd("lint");
    const ledger = [
      entry(c, "fail", { seq: 2, turn: 1, at: 10 }), entry(d, "pass", { seq: 2, turn: 1, at: 10 }),
      entry(c, "pass", { seq: 2, turn: 2, at: 20 }), entry(c, "pass", { seq: 5, turn: 1, at: 30 }), entry(c, "pass", { stepId: "review", seq: 3, turn: 1, at: 15 }),
    ];
    expect(ledgerEvaluations(ledger, "build").map((g) => [g.seq, g.turn, g.entries.map((e) => `${e.checkId}:${e.outcome}`)])).toEqual([
      [5, 1, ["unit:pass"]], [2, 2, ["unit:pass"]], [2, 1, ["unit:fail", "lint:pass"]],
    ]);
    expect(ledgerEvaluations(ledger, null)).toHaveLength(4);
    expect(ledgerEvaluations(ledger, "finish")).toEqual([]);
  });
});

describe("words", () => {
  test("outputTail keeps the end and says what it left out", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const tail = outputTail(text, 3);
    expect(tail).toBe("[… 97 earlier lines not shown …]\nline 98\nline 99\nline 100");
    expect(outputTail("one\n", 60)).toBe("one");
    expect(outputTail("", 60)).toBe("");
    const capped = outputTail(`${"x".repeat(500)}\n${"y".repeat(50)}\nend`, 60, 60);
    expect(capped.endsWith(`${"y".repeat(50)}\nend`)).toBe(true);
    expect(capped).toContain("1 earlier line not shown");
    expect(outputTail("z".repeat(10_000)).length).toBeLessThanOrEqual(CHECK_LIMITS.tailBytes);
  });

  test("the roster lists every check with its description, and the verdict's exact shape", () => {
    const roster = checkRoster([builtinCheck("tree-clean"), cmd("lint", { required: false }), builtinCheck("review-verdict")], { issueUrl: "https://github.com/o/r/issues/3" });
    expect(roster.split("\n")).toEqual([
      "- `tree-clean` — The worktree has no uncommitted change to a tracked file: everything the step did is committed.",
      "- `lint` (reported, does not hold the step) — lint passes",
      expect.stringContaining("- `review-verdict` — The handoff carries"),
      expect.stringContaining('"issueUrl":"https://github.com/o/r/issues/3"'),
    ]);
  });

  const base = {
    pipelineName: "Change", stepIndex: 2, stepCap: 14, goal: "Fix it.", previous: [], outgoing: [{ name: "Review", label: "" }], transition: "choose" as const,
    subagentProfiles: [], subagentCap: null, inlineHandoff: true, parallelSiblings: [], nonce: "n",
  };
  test("a step prompt without a gate is exactly what it was", () => {
    const step = newStep({ name: "Build", instructions: "Do it. {{checks}}", goal: "Committed." });
    const plain = composeStepPrompt({ ...base, step });
    expect(composeStepPrompt({ ...base, step, gate: null })).toBe(plain);
    expect(plain).toContain("## Your step\n\nDo it. {{checks}}\n\n## Delegation");
    expect(plain).not.toContain("Step goal");
  });
  test("with a gate: the goal apart from the instructions, the roster after them", () => {
    const step = newStep({ name: "Build", instructions: "Do it." });
    const prompt = composeStepPrompt({ ...base, step, gate: { goal: "The change is committed.", checks: [builtinCheck("tree-clean"), builtinCheck("diff-nonempty")] } });
    expect(prompt).toContain("## Step goal\n\nWhat must be true when this step ends: The change is committed.\n\n## Your step\n\nDo it.\n\n## Checks this step must pass\n\n");
    expect(prompt).toContain("- `tree-clean` — ");
    expect(prompt).toContain("- `diff-nonempty` — ");
    expect(prompt.indexOf("## Checks this step must pass")).toBeLessThan(prompt.indexOf("## Delegation"));
    // No goal: no goal section, the roster still there.
    expect(composeStepPrompt({ ...base, step, gate: { goal: null, checks: [builtinCheck("tree-clean")] } })).not.toContain("## Step goal");
  });
  test("{{checks}} in the instructions is where the roster goes", () => {
    const step = newStep({ name: "Build", instructions: "Before you hand off, make these pass:\n{{checks}}\nThen stop." });
    const prompt = composeStepPrompt({ ...base, step, gate: { goal: null, checks: [builtinCheck("tree-clean")] } });
    expect(prompt).toContain("make these pass:\n- `tree-clean` — The worktree has no uncommitted change");
    expect(prompt).not.toContain("{{checks}}");
    expect(prompt.match(/- `tree-clean`/g)).toHaveLength(1);
    expect(prompt).toContain("they are listed in your step above.");
  });

  test("feedback: the goal, each failed check with its output, the turn count and the handoff contract", () => {
    const failed = [result(cmd("unit"), "fail", { exitCode: 2, detail: "exit 2", output: "expected 1\ngot ``` 2", outputPath: "/data/check.log" })];
    const unmet = [result(cmd("e2e", { dependsOn: ["unit"] }), "skip", { detail: 'not run: "unit" did not pass' })];
    const text = composeCheckFeedback({ stepName: "Build", goal: "Committed.", turn: 1, maxTurns: 2, failed, unmet, hadHandoff: true, outgoing: [{ name: "Review", label: "" }], transition: "choose" });
    expect(text.startsWith(`${CHECK_FEEDBACK_MARKER}\n\n`)).toBe(true);
    expect(text).toContain('Step "Build" is not finished: 2 required checks did not pass');
    expect(text).toContain("Your handoff was not passed on and is void.");
    expect(text).toContain("The step's goal: Committed.");
    expect(text).toContain("### `unit` — failed (exit 2)\nWhat it checks: unit passes\nFound: exit 2\nOutput (the end of it):\n```\nexpected 1\ngot ''' 2\n```\nWhole output: /data/check.log");
    expect(text).toContain('### `e2e` — not run: "unit" did not pass');
    expect(text).toContain("This is check-feedback turn 1 of 2.");
    expect(text).toContain('The next step is "Review"; set "next" to "Review".');
    const last = composeCheckFeedback({ stepName: "Build", goal: null, turn: 2, maxTurns: 2, failed, hadHandoff: false, outgoing: [], transition: "choose" });
    expect(last).toContain("a required check did not pass");
    expect(last).toContain("Nothing was handed to the next step.");
    expect(last).toContain("turn 2 of 2, the last in this session");
    expect(last).not.toContain("The step's goal");
  });
  test("feedback shares its output budget between the failed checks", () => {
    const big = Array.from({ length: 12 }, (_, i) => result(cmd(`c${i}`), "fail", { output: "y".repeat(CHECK_LIMITS.tailBytes) }));
    expect(renderCheckFailures(big).length).toBeLessThan(CHECK_LIMITS.feedbackBytes + 12 * 400);
  });

  test("a composed handoff says whose words it is, three times, and keeps the step's last words", () => {
    const h = composedHandoff({ stepName: "Build", next: "Review", passed: ["tree-clean", "diff-nonempty"], finalMessage: `${"old ".repeat(2000)}I committed the fix.` });
    expect(h).toMatchObject({ schemaVersion: 1, next: "Review", status: "done", artifacts: [], openQuestions: [] });
    for (const field of [h.purpose, h.summary, h.reason]) expect(field.startsWith(COMPOSED_HANDOFF_MARK)).toBe(true);
    expect(h.summary).toContain("Its required checks passed (tree-clean, diff-nonempty)");
    expect(h.summary.endsWith("I committed the fix.")).toBe(true);
    // It survives the normalizer every stored handoff goes through, as a done handoff.
    expect(normalizeHandoff(h)).toMatchObject({ status: "done", next: "Review" });
    expect(composedHandoff({ stepName: "Build", next: null, passed: [], finalMessage: " " }).summary).toContain("final message was empty");
  });
  test("the fresh session's arrival carries the failures", () => {
    const h = exhaustedHandoff({ stepName: "Build", turns: 2, failed: [result(cmd("unit"), "fail", { exitCode: 1, detail: "exit 1", output: "boom", outputPath: "/data/c.log" })], unmet: [], lastWords: "I tried." });
    expect(h.summary).toContain("also after 2 feedback turns");
    expect(h.summary).toContain("### `unit` — failed (exit 1)");
    expect(h.summary).toContain("boom");
    expect(h.summary).toContain("I tried.");
    expect(h.artifacts).toEqual(["/data/c.log"]);
    expect(normalizeHandoff(h).status).toBe("done");
  });
});
