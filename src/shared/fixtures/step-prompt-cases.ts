// Representative step launches, as `composeStepPrompt` is given them. The
// files in `step-prompt-legacy/` are what `composeStepPrompt` returned for
// each of these BEFORE prompts were reordered static-first (generated from
// commit 6684acc, the last one with the old order, by calling it with these
// inputs). `src/shared/prompt-order.test.ts` holds the reordered composer to
// them: the legacy order must still give these bytes, and the new order must
// give the same paragraphs in another order.
import type { AgentProfileSnapshot, Handoff, PipelineStep, StepCheck } from "../types.ts";

const step = (name: string, instructions: string, more: Partial<PipelineStep> = {}): PipelineStep => ({
  id: name.toLowerCase(), name, agentProfileId: "profile", instructions, transition: "choose", subagents: { profileIds: [], cap: null },
  x: 0, y: 0, ...more,
} as PipelineStep);

const scout: AgentProfileSnapshot = {
  id: "scout", name: "Scout", harness: "claude-code", harnessKind: "claude-code", harnessLabel: "Claude Code", model: "sonnet-5.5", effort: "low",
  mode: null, fast: false, maxMode: false, instructions: "Fast codebase reconnaissance. Read-only.", skills: ["map"], capturedAt: 1,
};

const handoff = (more: Partial<Handoff> = {}): Handoff => ({
  schemaVersion: 1, status: "done", purpose: "Hand the plan to Build", summary: "The rounding lives in src/cart/total.ts.\nOne call site.",
  reason: "the plan is complete", next: "Build", artifacts: ["/git/agetor/file-map.md"], openQuestions: [], ...more,
});

const CHECKS: StepCheck[] = [
  { id: "tree-clean", description: "No uncommitted change to a tracked file.", run: { kind: "builtin", name: "tree-clean" }, required: true, timeoutSec: 120 },
  { id: "review-verdict", description: "The handoff carries a verdict for HEAD.", run: { kind: "builtin", name: "review-verdict" }, required: true, timeoutSec: 120 },
];

const GOAL = "Issue #974: round the cart total.\n\nAcceptance criteria:\n- CA01 totals are rounded half-even\n- CA02 the tax line is unchanged";
const base = { pipelineName: "Change: Understand, Build, Review, Finish", stepCap: 14, goal: GOAL, transition: "choose" as const, subagentProfiles: [], subagentCap: null, inlineHandoff: true, parallelSiblings: [], nonce: "a1b2c3d4" };

export const STEP_PROMPT_CASES = {
  "understand-first-with-scouts": {
    ...base, step: step("Understand", "Read the issue and the code. Write the file map."), stepIndex: 1, previous: [],
    outgoing: [{ name: "Build", label: "build" }, { name: "Finish", label: "trivial change made" }],
    subagentProfiles: [scout], subagentCap: 3, parentHarnessKind: "claude-code",
  },
  "build-from-understand": {
    ...base, step: step("Build", "Start from the file map.\n\nCommit your work; never push."), stepIndex: 2,
    previous: [{ stepName: "Understand", handoff: handoff(), filePath: "/data/pipeline-runs/card/handoff-x-2-from-1.json", report: { body: "# Plan\n\n1. Change `total()`.\n2. Add the test.", filePath: "/data/pipeline-runs/card/report-x-1.md" } }],
    outgoing: [{ name: "Review", label: "" }], parentHarnessKind: "codex",
  },
  "build-bounce-preloaded": {
    ...base, step: step("Build", "Start from the file map.\n\nCommit your work; never push."), stepIndex: 5,
    previous: [{
      stepName: "Review",
      handoff: handoff({ purpose: "Changes requested", summary: "F1: rounding is half-up.", reason: "one finding", next: "Build" }),
      filePath: "/data/pipeline-runs/card/handoff-x-5-from-4.json",
      report: { body: `F1 — src/cart/total.ts:14 rounds half-up.\n\n${"detail ".repeat(6_000)}\n\nFix: use the banker's rounding helper.`, filePath: "/data/pipeline-runs/card/report-x-4.md" },
    }],
    outgoing: [{ name: "Review", label: "" }], parentHarnessKind: "claude-code",
    preload: { card: "## File map\n\nThe card's file map (/git/agetor/file-map.md).\n\n```markdown\n# File map\n```", visit: "## What this branch changes so far\n\n`git diff -U10 origin/develop...HEAD`.\n\n```diff\n+x\n```" },
  },
  "review-gated": {
    ...base, step: step("Review", "Review the change against every acceptance criterion."), stepIndex: 3,
    previous: [{ stepName: "Build", handoff: handoff({ next: "Review", purpose: "Built" }), filePath: "/data/pipeline-runs/card/handoff-x-3-from-2.json" }],
    outgoing: [{ name: "Build", label: "changes requested" }, { name: "Finish", label: "approved" }], parentHarnessKind: "codex",
    gate: { goal: "A verdict that names HEAD.", checks: CHECKS, issueUrl: "https://github.com/o/r/issues/974" },
    preload: { card: "## File map\n\nMAP", visit: "## Review bundle: the change\n\nBUNDLE" },
  },
  "review-gated-checks-in-place": {
    ...base, step: step("Review", "Review the change.\n\nYou are graded on:\n{{checks}}\n\nThen hand off."), stepIndex: 3,
    previous: [{ stepName: "Build", handoff: handoff({ next: "Review" }), filePath: null }],
    outgoing: [{ name: "Build", label: "changes requested" }, { name: "Finish", label: "approved" }],
    gate: { goal: null, checks: CHECKS, issueUrl: null },
  },
  "finish-parallel-no-inline": {
    ...base, step: step("Finish", "Publish the approved head.", { canFinish: true, transition: "all" }), stepIndex: 14, transition: "all" as const, inlineHandoff: false,
    previous: [
      { stepName: "Review", handoff: handoff({ next: "Finish", purpose: "Approved" }), filePath: "/data/pipeline-runs/card/handoff-x-14-from-13.json", report: { body: "Approved: every criterion is met.", filePath: "/data/pipeline-runs/card/report-x-13.md" } },
      { stepName: "Docs", handoff: null, filePath: null },
    ],
    outgoing: [{ name: "Build", label: "verification failed" }], parallelSiblings: ["Docs", "Changelog"], parentHarnessKind: "gemini",
  },
  "no-instructions-oversized-handoff": {
    ...base, step: step("Build", "   "), stepIndex: 2, goal: "Short goal.",
    previous: [{ stepName: "Understand", handoff: handoff({ summary: "s".repeat(7_900), reason: "r".repeat(7_900), purpose: "p".repeat(7_900) }), filePath: "/data/pipeline-runs/card/handoff-x-2-from-1.json" }],
    outgoing: [{ name: "Review", label: "" }],
  },
} as const;

/** What `launchStep` adds around the composed prompt, in combinations. */
export const STEP_PROMPT_EXTRAS = {
  none: {},
  "an unattended Pillar Review": {
    decisions: "## Planner recommendations and retrospective human follow-up\n\nPriorities, in order: fulfill the issue.\n\nagetor pipeline decision card-1 <record.json>  # record must also contain capturedAt:1791925556793",
    machineCapacity: "## Machine test capacity\nVerification runs in GitHub CI, as the step instructions describe.",
    approvalNote: 'Automatic sign-off requires explicit independent approval of this exact head. In the handoff add "reviewApproval":{"issueUrl":"https://github.com/o/r/issues/974"}.',
  },
  everything: {
    syncNote: "## Before you start: develop has moved on\n\n`origin/develop` is 3 commits ahead of this branch.\n\n1. Commit any outstanding work on this branch.\n\nThen carry on with your step as written below.",
    feedback: "## Feedback from the owner\nThe card's owner reopened this run and wrote the following.\n\n### Note (sent to this step)\n\nUse half-even.\n\nThis is a refinement.",
    decisions: "## Planner recommendations and retrospective human follow-up\n\nPriorities, in order: fulfill the issue.",
    routing: "This step was explicitly selected by manual Advance. The preceding verdict and findings are preserved for you to address.",
    machineCapacity: "## Machine test capacity\nVerification runs in GitHub CI.",
    approvalNote: "Publish only the exact independently approved head.",
    wrapUp: "## Step cap reached — wrap up this run\nThis run reached its 28-step cap, so this is its last step.\n- Do not hand back to an earlier step.",
    inputNote: "Card inputs changed since the run started: removed inputs: #1.",
  },
  "feedback and a wrap-up only": {
    feedback: "## Feedback from the owner\nNote.",
    wrapUp: "## Step cap reached — wrap up this run\nLast step.",
  },
} as const;
