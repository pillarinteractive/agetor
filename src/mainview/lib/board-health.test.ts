import { describe, expect, test } from "bun:test";
import { boardHealth, boardSignal, levelOf, waitGroups, whyStopped } from "./board-health.ts";
import type { PipelineBlock, Task, TaskPrStatus } from "../../shared/types.ts";

const STEPS = [{ id: "build", name: "Build" }, { id: "review", name: "Review" }, { id: "finish", name: "Finish" }];
let n = 0;
/** A pipeline card with the given blocks; `active` names its step tasks' columns. */
function card(column: Task["column"], blocks: Partial<PipelineBlock>[], extra: Partial<Task> = {}, active: Task["column"][] = []): Task[] {
  const id = `card-${++n}`;
  const steps = active.map((col, i) => ({ id: `${id}-step-${i}`, column: col, pipelineParentId: id }) as unknown as Task);
  const parent = {
    id,
    title: `Issue #${n}`,
    column,
    archivedAt: null,
    pipelineParentId: null,
    pendingInteractionCount: 0,
    pipelineRun: {
      active: steps.map((s, i) => ({ stepId: "build", taskId: s.id, seq: i + 1 })),
      blocked: blocks.map((b) => ({ taskId: null, stepId: "build", kind: "step-blocked", message: "", ...b })),
      snapshot: { graph: { steps: STEPS } },
    },
    ...extra,
  } as unknown as Task;
  return [parent, ...steps];
}
const pr = (taskId: string, extra: Partial<TaskPrStatus>): [string, TaskPrStatus] => [
  taskId,
  { taskId, number: 7, url: "u", state: "open", draft: false, baseRef: "develop", headSha: "h", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...extra },
];
const NONE = new Map<string, TaskPrStatus>();
const causes = (tasks: Task[], prs = NONE) => waitGroups(tasks, prs).map((g) => `${g.cause}:${g.cards.length}`);

describe("waitGroups", () => {
  test("the same cause on many cards is one group, most actionable first", () => {
    const tasks = [
      ...card("running", [{ kind: "await", message: 'Build is waiting on "ci" — wakes when it finishes' }]),
      ...card("running", [{ kind: "await", message: 'Review is waiting on "ci" — wakes when it finishes', stepId: "review" }]),
      ...card("running", [{ kind: "await", message: 'Build is waiting on "1277 verify_changed" — wakes when it finishes' }]),
      ...card("running", [{ kind: "slot-wait", message: "Finish is waiting for a slot — 14 of 6 cards are waiting on CI", stepId: "finish" }]),
      ...card("blocked", [{ kind: "handoff-missing", message: "still no valid handoff after one reminder" }]),
      ...card("blocked", [{ kind: "step-failed", message: 'step "Build" failed — runner reservation is active or uncertain' }]),
      ...card("blocked", [{ kind: "step-failed", message: 'step "Understand" hit a usage limit — Usage limit reached' }]),
      ...card("blocked", [{ kind: "step-cap", message: "reached the 14-step cap for this run" }]),
    ];
    expect(causes(tasks)).toEqual(["failed:1", "no-handoff:1", "step-cap:1", "limit:1", "slot:1", "ci:2", "command:1"]);
    const ci = waitGroups(tasks, NONE).find((g) => g.cause === "ci")!;
    expect(ci.cards.map((c) => c.step)).toEqual(["Build", "Review"]);
    expect(ci.action).toBeNull();
    expect(waitGroups(tasks, NONE).find((g) => g.cause === "failed")!.action).toBe("retry");
  });

  test("a step that says it is blocked is sorted by what it actually waits on", () => {
    const tasks = [
      ...card("blocked", [{ message: 'step "Build" reported it is blocked: Code is fixed. (open questions: Who is the owner?)' }]),
      ...card("blocked", [{ message: 'step "Review" reported it is blocked: - Waiting for CI required on remote HEAD 114feb4.\n- After completion, record it.', stepId: "review" }]),
      ...card("blocked", [{ message: 'step "Build" reported it is blocked: Still waiting for a fix to land on develop that makes the transport test pass' }]),
      ...card("blocked", [{ message: 'step "Review" reported it is blocked: - The merged HEAD needs fresh independent Review approval.', stepId: "review" }]),
      ...card("blocked", [{ message: 'step "Build" reported it is blocked: something' }], { pendingInteractionCount: 1 }),
    ];
    expect(causes(tasks)).toEqual(["you:2", "base:1", "blocked:1", "ci:1"]);
    const blocked = waitGroups(tasks, NONE).find((g) => g.cause === "blocked")!;
    // The step's own first line, without the wrapper or the list dash.
    expect(blocked.cards[0]!.detail).toBe("The merged HEAD needs fresh independent Review approval.");
    expect(blocked.cards[0]!.step).toBe("Review");
  });

  test("a card with several blocks counts once, under the most actionable", () => {
    const tasks = card("blocked", [
      { kind: "slot-wait", message: "Review is waiting for a slot — 12 of 12 card owners busy" },
      { kind: "handoff-missing", message: "still no valid handoff after one reminder" },
    ]);
    expect(causes(tasks)).toEqual(["no-handoff:1"]);
  });

  test("a PR that only inherits the base branch's failures waits on the base, and a merging PR on its checks", () => {
    const inherits = card("merge", []);
    const own = card("merge", []);
    const pending = card("merge", []);
    const prs = new Map([
      pr(inherits[0]!.id, { checks: "failure", failingChecks: [{ name: "select", url: null, alsoOnBase: true }, { name: "required", url: null, alsoOnBase: true }] }),
      pr(own[0]!.id, { checks: "failure", failingChecks: [{ name: "web", url: null, alsoOnBase: false }] }),
      pr(pending[0]!.id, { checks: "pending" }),
    ]);
    const groups = waitGroups([...inherits, ...own, ...pending], prs);
    expect(groups.map((g) => `${g.cause}:${g.cards.length}`)).toEqual(["base:1", "ci:1"]);
    expect(groups[0]!.cards[0]!.detail).toBe("develop fails select, required");
  });

  test("moving cards, backlog, done, archived and step tasks are left out", () => {
    const moving = card("running", [], {}, ["running"]);
    const backlog = card("backlog", [{ kind: "slot-wait", message: "x" }]);
    const archived = card("blocked", [{ kind: "step-failed", message: "x" }], { archivedAt: 1 });
    expect(causes([...moving, ...backlog, ...archived])).toEqual([]);
  });
});

describe("boardHealth", () => {
  const prefs = { step_slots: JSON.stringify({ max: 20, heavy: { max: 6 }, ci: { max: 6 } }) };

  test("counts working agents, cards on CI and the queue with its commonest reason", () => {
    const tasks = [
      ...card("running", [], {}, ["running"]),
      ...card("running", [], {}, ["running", "review"]),
      ...card("running", [{ kind: "await", message: 'Build is waiting on "ci" — wakes when it finishes' }], {}, ["review"]),
      ...card("running", [{ kind: "slot-wait", message: "Finish is waiting for a slot — 14 of 6 cards are waiting on CI" }]),
      ...card("running", [{ kind: "slot-wait", message: "Review is waiting for a slot — 14 of 6 cards are waiting on CI" }]),
      ...card("running", [{ kind: "slot-wait", message: "Finish is waiting for a verification slot — 6 of 6 in use" }]),
      ...card("blocked", [{ message: 'step "Build" reported it is blocked: x (open questions: y?)' }]),
    ];
    expect(boardHealth(tasks, NONE, prefs, 0)).toEqual({
      working: 2, agentCap: 20, onCi: 1, ciCap: 6, queued: 3, queuedWhy: "14 of 6 cards are waiting on CI",
      baseFailing: null, fallback: null, needsYou: 1,
    });
  });

  test("defaults when the preference is missing or unreadable", () => {
    expect(boardHealth([], NONE, {}, 0)).toMatchObject({ agentCap: 3, ciCap: 6, working: 0, queued: 0, queuedWhy: null });
    expect(boardHealth([], NONE, { step_slots: "not json" }, 0)).toMatchObject({ agentCap: 3, ciCap: 6 });
  });

  test("names a failing base branch", () => {
    const inherits = card("merge", []);
    const prs = new Map([pr(inherits[0]!.id, { checks: "failure", failingChecks: [{ name: "select", url: null, alsoOnBase: true }] })]);
    expect(boardHealth(inherits, prs, prefs, 0).baseFailing).toBe("develop fails select");
  });

  test("shows a usage limit only while it lasts, with the backup it routes to", () => {
    const at = new Date(2026, 9, 12, 23, 50).getTime();
    const limited = {
      ...prefs,
      quota_fallback: JSON.stringify({ enabled: true, from: ["claude-code"], harness: "claude-deepseek" }),
      quota_fallback_until: JSON.stringify({ "claude-code": at }),
    };
    const label = (id: string) => ({ "claude-code": "Claude Code", "claude-deepseek": "Claude Code via DeepSeek" })[id] ?? id;
    const text = boardHealth([], NONE, limited, at - 60_000, label).fallback!;
    expect(text.startsWith("Claude Code at its limit → Claude Code via DeepSeek until ")).toBe(true);
    expect(boardHealth([], NONE, limited, at, label).fallback).toBeNull();
    const noBackup = { ...limited, quota_fallback: JSON.stringify({ enabled: false, harness: "claude-deepseek" }) };
    expect(boardHealth([], NONE, noBackup, at - 1, label).fallback!.startsWith("Claude Code at its limit until ")).toBe(true);
  });
});

describe("boardSignal", () => {
  test("green with nothing waiting, yellow when everything clears by itself, red once a card is blocked", () => {
    expect(boardSignal([])).toEqual({ level: "good", blocked: 0, waiting: 0 });
    const waiting = [
      ...card("running", [{ kind: "await", message: 'Build is waiting on "ci" — wakes when it finishes' }]),
      ...card("running", [{ kind: "slot-wait", message: "Finish is waiting for a slot — 6 of 6 in use" }]),
      ...card("blocked", [{ kind: "step-failed", message: 'step "Understand" hit a usage limit — Usage limit reached' }]),
    ];
    expect(boardSignal(waitGroups(waiting, NONE))).toEqual({ level: "waiting", blocked: 0, waiting: 3 });
    const blocked = [...waiting, ...card("blocked", [{ kind: "handoff-missing", message: "no handoff" }])];
    expect(boardSignal(waitGroups(blocked, NONE))).toEqual({ level: "blocked", blocked: 1, waiting: 3 });
  });

  test("only causes that clear by themselves are yellow", () => {
    const yellow = (["limit", "slot", "ci", "command"] as const).map(levelOf);
    const red = (["you", "failed", "no-handoff", "step-cap", "base", "blocked"] as const).map(levelOf);
    expect(new Set(yellow)).toEqual(new Set(["waiting"]));
    expect(new Set(red)).toEqual(new Set(["blocked"]));
  });
});

describe("whyStopped", () => {
  test("a moving card has no reason", () => {
    expect(whyStopped(card("running", [], {}, ["running"])[0]!)).toBeNull();
  });

  test("gives the cause, the step and the step's own words line by line", () => {
    const message = 'step "Review" reported it is blocked: - Exact-head CI remains unavailable.\n- The no-push instruction remains effective.\n- Resume Review after publication.';
    const [task] = card("blocked", [{ stepId: "review", message }]);
    const why = whyStopped(task!)!;
    expect([why.cause, why.title, why.step, why.action]).toEqual(["blocked", "Step reports it is blocked", "Review", "open"]);
    expect(why.lines).toEqual(["Exact-head CI remains unavailable.", "The no-push instruction remains effective.", "Resume Review after publication."]);
  });

  test("a retryable stop offers retry", () => {
    const [task] = card("blocked", [{ kind: "handoff-missing", message: "still no valid handoff after one reminder" }]);
    expect(whyStopped(task!)).toMatchObject({ cause: "no-handoff", action: "retry", lines: ["still no valid handoff after one reminder"] });
  });
});
