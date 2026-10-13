import { describe, expect, test } from "bun:test";
import { builtinCheck, checkDefHash } from "./checks.ts";
import {
  applicableFeedback, forwardPath, parseFeedbackLog, positionLine, renderOwnerFeedback, reopenChoices, resolvePosition, resumeOffer, stepsFrom,
  validateFeedbackNote, voidEntries, voidedThrough, POSITION_LIMITS, STEP_VOID_CHECK_ID,
  type OwnerFeedback, type PositionInput, type StepEvidence,
} from "./position.ts";
import type { CheckLedgerEntry, Handoff, PipelineGraph, PipelineStep, PipelineStepRecord, StepCheck } from "./types.ts";

// Stage 3 of docs/plans/check-gated-pipeline.md: where a run stands, read
// from evidence. Literal fixtures of the Change pipeline's graph as the
// board has it; nothing here touches git, a file or a clock.

const HEAD = "a".repeat(40), OLD = "b".repeat(40), TREE = "c".repeat(40);
const KEY = { head: HEAD, tree: TREE, baseTip: "d".repeat(40) };

const step = (id: string, name: string, o: Partial<PipelineStep> = {}): PipelineStep => ({
  id, name, instructions: "", agentProfileId: "p", position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any", ...o,
});
const understand = step("understand", "Understand", { canFinish: true }), build = step("build", "Build"), review = step("review", "Review");
const finish = step("finish", "Finish", { canFinish: true });
/** The Change pipeline: Understand → Build → Review → Finish with its three loops. */
const CHANGE: PipelineGraph = {
  steps: [understand, build, review, finish],
  edges: [
    { id: "understand-build", from: "understand", to: "build", label: "build" },
    { id: "understand-finish", from: "understand", to: "finish", label: "trivial change made" },
    { id: "build-review", from: "build", to: "review", label: "" },
    { id: "review-build", from: "review", to: "build", label: "changes requested" },
    { id: "review-finish", from: "review", to: "finish", label: "approved" },
    { id: "finish-build", from: "finish", to: "build", label: "verification failed" },
  ],
  startStepId: "understand",
};

const handoff = (o: Partial<Handoff> = {}): Handoff => ({ schemaVersion: 1, purpose: "p", summary: "s", reason: "r", next: null, artifacts: [], openQuestions: [], status: "done", ...o });
const verdict = (headSha: string, v: "approved" | "changes-requested" = "approved"): Handoff => handoff({
  reviewApproval: { verdict: v, headSha, issueUrl: "https://github.com/o/r/issues/1", acceptanceComplete: v === "approved", findings: v === "approved" ? [] : ["fix the test"] },
});
type Rec = Pick<PipelineStepRecord, "seq" | "stepId" | "taskId" | "outcome" | "handoff" | "nextStepIds" | "endedAt">;
const rec = (seq: number, stepId: string, next: string[], o: Partial<Rec> = {}): Rec => ({ seq, stepId, taskId: `t${seq}`, outcome: "succeeded", handoff: handoff(), nextStepIds: next, endedAt: seq * 1000, ...o });

const BUILD_CHECKS = [builtinCheck("tree-clean"), builtinCheck("diff-nonempty")];
const REVIEW_CHECKS = [builtinCheck("tree-clean"), builtinCheck("review-verdict")];
const ok = { satisfied: true, detail: "ok" };
const evidence = (o: { dirty?: boolean; empty?: boolean; buildChecks?: StepCheck[] } = {}): Record<string, StepEvidence> => ({
  build: { checks: o.buildChecks ?? BUILD_CHECKS, now: { "tree-clean": o.dirty ? { satisfied: false, detail: "2 tracked files have uncommitted changes" } : ok, "diff-nonempty": o.empty ? { satisfied: false, detail: "no commit ahead of develop" } : ok } },
  review: { checks: REVIEW_CHECKS, now: { "tree-clean": o.dirty ? { satisfied: false, detail: "2 tracked files have uncommitted changes" } : ok } },
});
/** Understand, Build, Review (approved HEAD), Finish — a run that finished. */
const FINISHED: Rec[] = [
  rec(1, "understand", ["build"]), rec(2, "build", ["review"]), rec(3, "review", ["finish"], { handoff: verdict(HEAD) }), rec(4, "finish", []),
];
const input = (o: Partial<PositionInput> = {}): PositionInput => ({
  graph: CHANGE, history: FINISHED, ledger: [], key: KEY, evidence: evidence(), publish: null, inputs: { goalUnchanged: true, issueChangedAt: null }, ...o,
});
const at = (p: ReturnType<typeof resolvePosition>) => (p.kind === "step" ? [p.stepId, p.satisfied.map((s) => s.stepId), p.arrivals.map((a) => [a.stepId, a.seq])] : [p.kind]);

const voidLine = (stepId: string, seq: number): CheckLedgerEntry => ({
  at: 1, stepId, stepName: stepId, seq, turn: 1, checkId: STEP_VOID_CHECK_ID, description: "", required: true, outcome: "void", satisfied: false,
  key: { head: null, tree: null, baseTip: null, def: "" }, exitCode: null, detail: "rewound", outputTail: "", outputPath: null,
});

describe("forwardPath", () => {
  test("the Change graph: forward edges only, the branch Understand's visit took", () => {
    expect(forwardPath(CHANGE, FINISHED)!.map((s) => s.id)).toEqual(["understand", "build", "review", "finish"]);
    // "trivial change made": Understand went straight to Finish.
    expect(forwardPath(CHANGE, [rec(1, "understand", ["finish"])])!.map((s) => s.id)).toEqual(["understand", "finish"]);
    // The newest finished visit decides, not an older one.
    expect(forwardPath(CHANGE, [rec(1, "understand", ["finish"]), rec(2, "understand", ["build"])])!.map((s) => s.id)).toEqual(["understand", "build", "review", "finish"]);
  });

  test("a step that may end the run goes on only where its visit said so", () => {
    // Finish after the trivial path, then a CI failure sent it to Build.
    expect(forwardPath(CHANGE, [rec(1, "understand", ["finish"]), rec(2, "finish", ["build"])])!.map((s) => s.id)).toEqual(["understand", "finish", "build", "review"]);
    // On the ordinary path Finish → Build leads back, so the path ends at Finish.
    expect(forwardPath(CHANGE, [...FINISHED.slice(0, 3), rec(4, "finish", ["build"])])!.map((s) => s.id)).toEqual(["understand", "build", "review", "finish"]);
  });

  test("a step with two ways forward and no finished visit ends the path: what follows is not known", () => {
    expect(forwardPath(CHANGE, [])!.map((s) => s.id)).toEqual(["understand"]);
    expect(forwardPath(CHANGE, [rec(1, "understand", ["build"], { outcome: "cancelled" })])!.map((s) => s.id)).toEqual(["understand"]);
  });

  test("follow-up steps are not on it; a fan-out or a join has no single path", () => {
    const withFollowUp = { ...CHANGE, steps: [...CHANGE.steps, step("followup-1", "Open PR")] };
    expect(forwardPath(withFollowUp, FINISHED)!.map((s) => s.id)).toEqual(["understand", "build", "review", "finish"]);
    expect(forwardPath({ ...CHANGE, steps: CHANGE.steps.map((s) => (s.id === "build" ? { ...s, transition: "all" as const } : s)) }, FINISHED)).toBeNull();
    expect(forwardPath({ ...CHANGE, steps: CHANGE.steps.map((s) => (s.id === "review" ? { ...s, join: "all" as const } : s)) }, FINISHED)).toBeNull();
    expect(forwardPath({ steps: [], edges: [], startStepId: null }, [])).toBeNull();
  });

  test("stepsFrom: a step and everything after it", () => {
    const path = forwardPath(CHANGE, FINISHED)!;
    expect(stepsFrom(path, "review").map((s) => s.id)).toEqual(["review", "finish"]);
    expect(stepsFrom(path, "nope")).toEqual([]);
  });
});

describe("resolvePosition", () => {
  const cmdCheck: StepCheck = { id: "unit", description: "unit tests", run: { kind: "command", command: "make unit" }, required: true, timeoutSec: 60 };
  const ledgerLine = (o: Partial<CheckLedgerEntry> & { outcome: CheckLedgerEntry["outcome"] }): CheckLedgerEntry => ({
    at: 1, stepId: "build", stepName: "Build", seq: 2, turn: 1, checkId: "unit", description: "", required: true, satisfied: o.outcome === "pass",
    key: { head: HEAD, tree: TREE, baseTip: KEY.baseTip, def: checkDefHash(cmdCheck) }, exitCode: 0, detail: "", outputTail: "", outputPath: null, ...o,
  });
  const withCmd = (ledger: CheckLedgerEntry[], key = KEY) => input({ evidence: evidence({ buildChecks: [...BUILD_CHECKS, cmdCheck] }), ledger, key });

  const cases: [string, PositionInput, unknown][] = [
    ["a finished run whose evidence all holds: nothing to resume", input(), ["complete"]],
    // Incident 5: a restart re-ran Understand and Build although the commits were there.
    ["Understand and Build done, Review never ran: resume at Review with Build's handoff",
      input({ history: FINISHED.slice(0, 2) }), ["review", ["understand", "build"], [["build", 2]]]],
    ["nothing has run: the start step, with nothing to hand it", input({ history: [] }), ["understand", [], []]],
    ["a new commit after the approval voids Review and everything after it",
      input({ history: [...FINISHED.slice(0, 2), rec(3, "review", ["finish"], { handoff: verdict(OLD) }), rec(4, "finish", [])] }), ["review", ["understand", "build"], [["build", 2]]]],
    ["a dirty tree: Build's own check does not hold now", input({ evidence: evidence({ dirty: true }) }), ["build", ["understand"], [["understand", 1]]]],
    ["no commit ahead of the base: Build again", input({ evidence: evidence({ empty: true }) }), ["build", ["understand"], [["understand", 1]]]],
    ["a built-in that could not be evaluated is not satisfied",
      input({ evidence: { ...evidence(), build: { checks: BUILD_CHECKS, now: { "tree-clean": ok } } } }), ["build", ["understand"], [["understand", 1]]]],
    ["Review asked for changes at this head: the position is Build, with Review's findings as the arrival",
      input({ history: [...FINISHED.slice(0, 2), rec(3, "review", ["build"], { handoff: verdict(HEAD, "changes-requested") })] }), ["build", ["understand"], [["review", 3]]]],
    ["…and once Build has answered them, Review again",
      input({ history: [...FINISHED.slice(0, 2), rec(3, "review", ["build"], { handoff: verdict(OLD, "changes-requested") }), rec(4, "build", ["review"])] }), ["review", ["understand", "build"], [["build", 4]]]],
    ["Finish sent a CI failure back to Build: Build, with Finish's handoff",
      input({ history: [...FINISHED.slice(0, 3), rec(4, "finish", ["build"])] }), ["build", ["understand"], [["finish", 4]]]],
    ["a Review that only failed its checks (a fresh session pending) has not finished",
      input({ history: [...FINISHED.slice(0, 2), rec(3, "review", ["review"], { outcome: "failed" })] }), ["review", ["understand", "build"], [["build", 2]]]],
    ["a step the owner advanced by hand counts as finished; its checks are still recomputed",
      input({ history: [FINISHED[0]!, { ...FINISHED[1]!, outcome: "advanced-manually" }] }), ["review", ["understand", "build"], [["build", 2]]]],
    // Understand has no gate: its handoff is reused when what it read is unchanged.
    ["the card's goal changed: Understand again", input({ inputs: { goalUnchanged: false, issueChangedAt: null } }), ["understand", [], []]],
    ["the issue changed after Understand finished: Understand again", input({ inputs: { goalUnchanged: true, issueChangedAt: 1500 } }), ["understand", [], []]],
    ["the issue changed before Understand finished: it read that version", input({ inputs: { goalUnchanged: true, issueChangedAt: 900 } }), ["complete"]],
    // An operator's rewind.
    ["rewound to Review: Review and Finish no longer count, Understand and Build do",
      input({ ledger: [voidLine("review", 4), voidLine("finish", 4)] }), ["review", ["understand", "build"], [["build", 2]]]],
    ["rewound to Build: everything from Build", input({ ledger: [voidLine("build", 4), voidLine("review", 4), voidLine("finish", 4)] }), ["build", ["understand"], [["understand", 1]]]],
    ["rewound, and the steps have run again since: satisfied again",
      input({
        ledger: [voidLine("review", 4), voidLine("finish", 4)],
        history: [...FINISHED, rec(5, "review", ["finish"], { handoff: verdict(HEAD) }), rec(6, "finish", [])],
      }), ["complete"]],
    // A command check is believed only from the ledger, for exactly this head, tree and definition.
    ["a command check with a pass on record for this head", withCmd([ledgerLine({ outcome: "pass" })]), ["complete"]],
    ["…that a later evaluation reused (a satisfied skip) still stands", withCmd([ledgerLine({ outcome: "pass" }), ledgerLine({ outcome: "skip", satisfied: true })]), ["complete"]],
    ["a command check with no result on record", withCmd([]), ["build", ["understand"], [["understand", 1]]]],
    ["a pass for another head is not a pass for this one", withCmd([ledgerLine({ outcome: "pass" })], { ...KEY, head: OLD }), ["build", ["understand"], [["understand", 1]]]],
    ["a pass for another tree is not either", withCmd([ledgerLine({ outcome: "pass" })], { ...KEY, tree: "e".repeat(40) }), ["build", ["understand"], [["understand", 1]]]],
    ["a changed check definition voids that check", withCmd([ledgerLine({ outcome: "pass", key: { head: HEAD, tree: TREE, baseTip: KEY.baseTip, def: "00000000" } })]), ["build", ["understand"], [["understand", 1]]]],
    ["a later fail, waiver or void for the same key cancels the pass", withCmd([ledgerLine({ outcome: "pass" }), ledgerLine({ outcome: "void" })]), ["build", ["understand"], [["understand", 1]]]],
    ["a moved base does not void a command check: it tested the tree", withCmd([ledgerLine({ outcome: "pass" })], { ...KEY, baseTip: "f".repeat(40) }), ["complete"]],
    ["a check that is only reported never decides", withCmd([]).evidence.build!.checks.length === 3
      ? input({ evidence: evidence({ buildChecks: [...BUILD_CHECKS, { ...cmdCheck, required: false }] }) }) : input(), ["complete"]],
    // Finish run by Agetor.
    ["Agetor's Finish published HEAD and the required check passed", input({ publish: { stepId: "finish", head: HEAD, approvedHead: HEAD, carried: 0, requiredPassed: true } }), ["complete"]],
    ["…published another head: Finish again", input({ publish: { stepId: "finish", head: OLD, approvedHead: OLD, carried: 0, requiredPassed: true } }), ["finish", ["understand", "build", "review"], [["review", 3]]]],
    ["…the required check has not passed for it: Finish again", input({ publish: { stepId: "finish", head: HEAD, approvedHead: HEAD, carried: 0, requiredPassed: false } }), ["finish", ["understand", "build", "review"], [["review", 3]]]],
    ["A legacy carried approval cannot complete a different HEAD",
      input({
        history: [...FINISHED.slice(0, 2), rec(3, "review", ["finish"], { handoff: verdict(OLD) }), rec(4, "finish", [])],
        publish: { stepId: "finish", head: HEAD, approvedHead: OLD, carried: 1, requiredPassed: true },
      }), ["review", ["understand", "build"], [["build", 2]]]],
    // The trivial path.
    ["Understand made the trivial change and Finish published it", input({ history: [rec(1, "understand", ["finish"]), rec(2, "finish", [])] }), ["complete"]],
    ["a graph that fans out", input({ graph: { ...CHANGE, steps: CHANGE.steps.map((s) => (s.id === "understand" ? { ...s, transition: "all" as const } : s)) } }), ["unsupported"]],
  ];
  for (const [name, given, want] of cases) test(name, () => expect(at(resolvePosition(given))).toEqual(want as never));

  test("changed instruction text voids nothing: text is not evidence", () => {
    const edited = { ...CHANGE, steps: CHANGE.steps.map((s) => ({ ...s, instructions: `${s.instructions} — rewritten` })) };
    expect(resolvePosition(input({ graph: edited })).kind).toBe("complete");
  });

  test("the reasons name the step and what does not hold", () => {
    const why = (p: ReturnType<typeof resolvePosition>) => (p.kind === "step" ? p.why : p.kind);
    expect(why(resolvePosition(input({ evidence: evidence({ dirty: true }) })))).toBe("Build's check `tree-clean` does not hold now: 2 tracked files have uncommitted changes");
    expect(why(resolvePosition(input({ history: [...FINISHED.slice(0, 2), rec(3, "review", ["finish"], { handoff: verdict(OLD) })] })))).toContain("the verdict is for bbbbbbbb, but HEAD is aaaaaaaa");
    expect(why(resolvePosition(input({ ledger: [voidLine("review", 4)] })))).toBe("Review was rewound: its earlier visits no longer count");
    expect(why(resolvePosition(input({ history: FINISHED.slice(0, 2) })))).toBe("Review has not finished in this run");
    const names = (id: string) => CHANGE.steps.find((s) => s.id === id)!.name;
    expect(positionLine(resolvePosition(input({ history: FINISHED.slice(0, 2) })), names))
      .toBe("Resumes at Review — Review has not finished in this run; Understand, Build are still satisfied and are not run again");
    expect(positionLine(resolvePosition(input()), names)).toBe("Every step is still satisfied (Understand, Build, Review, Finish): there is nothing to resume");
    expect(positionLine(resolvePosition(input({ history: [] })), names)).toContain("nothing earlier can be kept");
  });
});

describe("voiding", () => {
  const pass = (stepId: string, checkId: string, seq: number, head = HEAD): CheckLedgerEntry => ({
    at: 1, stepId, stepName: stepId, seq, turn: 1, checkId, description: `${checkId} holds`, required: true, outcome: "pass", satisfied: true,
    key: { head, tree: TREE, baseTip: null, def: "abc" }, exitCode: null, detail: "", outputTail: "", outputPath: null,
  });

  test("voidedThrough: the newest voided visit of a step, 0 when none", () => {
    expect(voidedThrough([], "build")).toBe(0);
    expect(voidedThrough([voidLine("build", 3), voidLine("build", 7), voidLine("review", 9), pass("build", "x", 12)], "build")).toBe(7);
  });

  test("a rewind appends one line per step and one per check with a result on record, with that result's key; nothing is rewritten", () => {
    const ledger = [pass("build", "tree-clean", 2, OLD), pass("build", "tree-clean", 5), pass("review", "review-verdict", 6)];
    const before = JSON.stringify(ledger);
    const lines = voidEntries({
      at: 99, seq: 6, why: "rewound to Build by the owner", ledger,
      steps: [{ step: build, checks: BUILD_CHECKS }, { step: review, checks: REVIEW_CHECKS }, { step: finish, checks: [] }],
    });
    expect(JSON.stringify(ledger)).toBe(before);
    expect(lines.map((l) => [l.stepId, l.checkId, l.outcome, l.seq, l.key.head])).toEqual([
      ["build", STEP_VOID_CHECK_ID, "void", 6, null], ["build", "tree-clean", "void", 6, HEAD],
      ["review", STEP_VOID_CHECK_ID, "void", 6, null], ["review", "review-verdict", "void", 6, HEAD],
      // A step with no check (Finish here, Understand on the board) is voided too.
      ["finish", STEP_VOID_CHECK_ID, "void", 6, null],
    ]);
    expect(lines.every((l) => l.at === 99 && l.detail === "rewound to Build by the owner" && !l.satisfied)).toBe(true);
    for (const s of ["build", "review", "finish"]) expect(voidedThrough([...ledger, ...lines], s)).toBe(6);
  });
});

describe("the owner's feedback", () => {
  const note = (o: Partial<OwnerFeedback> = {}): OwnerFeedback => ({ id: "n1", at: 10, fromStepId: "build", note: "Use the existing retry helper.", invalidate: false, seq: 4, ...o });
  const path = forwardPath(CHANGE, FINISHED)!;
  const ids = (n: OwnerFeedback[]) => n.map((x) => x.id);

  test("a note is carried by the step it was sent to and each later step, until that step has finished once since", () => {
    const cases: [string, Rec[], string, string[]][] = [
      ["the step it was sent to", FINISHED, "build", ["n1"]],
      ["a later step", FINISHED, "review", ["n1"]],
      ["the last step", FINISHED, "finish", ["n1"]],
      ["an earlier step never", FINISHED, "understand", []],
      ["Build has finished since: not again in a later round", [...FINISHED, rec(5, "build", ["review"])], "build", []],
      ["…but Review has not read it yet", [...FINISHED, rec(5, "build", ["review"])], "review", ["n1"]],
      ["a visit that did not finish does not use it up", [...FINISHED, rec(5, "build", [], { outcome: "cancelled" })], "build", ["n1"]],
      ["a step off the path", FINISHED, "followup-1", []],
    ];
    for (const [name, history, stepId, want] of cases) expect([name, ids(applicableFeedback([note()], path, history, stepId))]).toEqual([name, want]);
  });

  test("several notes: oldest first, the newest five", () => {
    const many = Array.from({ length: 7 }, (_, i) => note({ id: `n${i}`, at: 100 - i }));
    expect(ids(applicableFeedback(many, path, FINISHED, "build"))).toEqual(["n4", "n3", "n2", "n1", "n0"]);
    expect(POSITION_LIMITS.notesPerPrompt).toBe(5);
  });

  test("the prompt section says whose words these are and which kind of reopening it is", () => {
    const nameOf = (id: string) => CHANGE.steps.find((s) => s.id === id)!.name;
    expect(renderOwnerFeedback([], { stepId: "build", nameOf })).toBe("");
    const own = renderOwnerFeedback([note()], { stepId: "build", nameOf });
    expect(own.startsWith("## Feedback from the owner\n")).toBe(true);
    expect(own).toContain("### Note (sent to this step)\n\nUse the existing retry helper.");
    expect(own).toContain("This is a refinement: the earlier work passed its checks and stays.");
    const later = renderOwnerFeedback([note()], { stepId: "review", nameOf });
    expect(later).toContain("### Note (sent to Build, and passed on to the steps after it)");
    expect(later).toContain("do your step for what changed because of the note");
    expect(renderOwnerFeedback([note({ invalidate: true })], { stepId: "build", nameOf })).toContain("The owner voided the earlier results of this step with it");
  });

  test("the log is read line by line; what is not a note is left out", () => {
    const good = note();
    const text = [JSON.stringify(good), "{torn", JSON.stringify({ ...good, id: "" }), JSON.stringify({ ...good, note: "  " }), JSON.stringify({ ...good, seq: -1 }), "[]", "", JSON.stringify({ ...good, id: "n2", invalidate: "yes" })].join("\n");
    expect(parseFeedbackLog(text)).toEqual([good, { ...good, id: "n2", invalidate: false }]);
  });

  test("a note is trimmed, and refused when empty, too long or not text", () => {
    expect(validateFeedbackNote("  tighten the error message \n")).toEqual({ ok: true, note: "tighten the error message" });
    for (const bad of ["", "   ", 7, null, undefined, "x".repeat(POSITION_LIMITS.note + 1), "a\u0000b"]) expect(validateFeedbackNote(bad).ok).toBe(false);
  });

  test("Restart is offered as a resume only where something is kept", () => {
    const steps = CHANGE.steps.map((s) => ({ id: s.id, name: s.name, reached: true }));
    const view = (history: Rec[], gated = true) => ({ gated, position: resolvePosition(input({ history })), line: null, steps });
    expect(resumeOffer(view(FINISHED.slice(0, 2)))).toEqual({ stepId: "review", stepName: "Review", kept: ["Understand", "Build"], why: "Review has not finished in this run" });
    expect(resumeOffer(view([]))).toBeNull(); // the first step: a restart from the beginning
    expect(resumeOffer(view(FINISHED))).toBeNull(); // complete: nothing to resume
    expect(resumeOffer(view(FINISHED.slice(0, 2), false))).toBeNull(); // no gates
    expect(resumeOffer(null)).toBeNull();
  });

  test("the forms offer only steps the run has reached", () => {
    expect(reopenChoices({ steps: [{ id: "understand", name: "Understand", reached: true }, { id: "build", name: "Build", reached: true }, { id: "review", name: "Review", reached: false }] }))
      .toEqual([{ id: "understand", name: "Understand" }, { id: "build", name: "Build" }]);
    expect(reopenChoices(null)).toEqual([]);
  });
});
