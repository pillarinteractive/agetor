/**
 * The pipeline run view in every state, through the real `RunPage` and its
 * parts and made-up runs. A development and screenshot page
 * (e2e/views-fixtures.spec.ts), served by the Vite dev server at
 * /fixtures/run.html. It imports nothing that talks to the core — no
 * `@/lib/api`, so no canvas (which needs it) and a plain handoff renderer —
 * and its buttons only say what they would have done. Not an entry of
 * `vite build` (index.html is the only one), so it never ships.
 *
 *   ?case=<name>        one of the cases below (default auto-retry)
 *   ?theme=dark         dark theme (default light)
 *   ?step=<id>          select a step tile
 *   ?tab=<name>         summary | transcript | checks | files
 *   ?presentation=graph the "Graph & routing" side of the switch
 *   ?card=1             also draw this task's board card, to compare
 */
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import "@fontsource-variable/geist";
import "../index.css";
import { TaskCard } from "@/components/kanban/TaskCard";
import { RunPage } from "@/components/pipelines/run/RunPage";
import { FollowUpComposer } from "@/components/pipelines/run/FollowUpComposer";
import type { RunActivityEntry } from "@/components/pipelines/run/RunHistory";
import type { RunDelegate, StepsPresentation } from "@/components/pipelines/run/StepTiles";
import type { StepTab } from "@/components/pipelines/run/StepContext";
import { cardState, type CardAction } from "@/lib/card-state";
import { LeaseContext, leaseInfoForTask } from "@/lib/leases";
import { PrContext } from "@/lib/prs";
import { ProgressContext, RoadmapCardsContext } from "@/lib/progress";
import { hasLiveExecution } from "@/lib/run-view";
import type { FollowUpAction, Handoff, PipelineBlock, PipelineBlockWait, PipelineGraph, PipelineRunState, PipelineStepRecord, Task, TaskPrStatus } from "../../shared/types.ts";

const params = new URLSearchParams(window.location.search);
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

// ── Made-up data ──────────────────────────────────────────────────────────

const PROFILES: Record<string, string> = { planner: "Architect", builder: "Sonnet Builder", reviewer: "GPT Reviewer", finisher: "Finisher", scout: "Scout" };
const step = (id: string, name: string, agentProfileId: string, o: Record<string, unknown> = {}) => ({ id, name, instructions: "", agentProfileId, position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any", ...o });
const STEPS = [
  step("understand", "Understand", "planner", { subagents: { profileIds: ["scout"], cap: 2 } }),
  step("build", "Build", "builder"),
  step("review", "Review", "reviewer", { subagents: { profileIds: ["scout"], cap: 1 } }),
  step("finish", "Finish", "finisher"),
];
const EDGES = [
  { id: "e1", from: "understand", to: "build", label: "implementation" },
  { id: "e2", from: "understand", to: "finish", label: "trivial change" },
  { id: "e3", from: "build", to: "review", label: "made changes" },
  { id: "e4", from: "review", to: "build", label: "changes requested" },
  { id: "e5", from: "review", to: "finish", label: "approved" },
  { id: "e6", from: "finish", to: "build", label: "verification failed" },
];
const GRAPH = { steps: STEPS, edges: EDGES, startStepId: "understand" } as unknown as PipelineGraph;
// A fan-out: Understand starts Build and Review side by side, Finish joins them.
const FAN_GRAPH = {
  steps: [step("understand", "Understand", "planner", { transition: "all" }), step("build", "Build", "builder"), step("review", "Security review", "reviewer"), step("finish", "Finish", "finisher", { join: "all" })],
  edges: [
    { id: "f1", from: "understand", to: "build", label: "" },
    { id: "f2", from: "understand", to: "review", label: "" },
    { id: "f3", from: "build", to: "finish", label: "" },
    { id: "f4", from: "review", to: "finish", label: "" },
  ],
  startStepId: "understand",
} as unknown as PipelineGraph;
const snapshot = (graph = GRAPH) => ({ graph, maxSteps: 28, profiles: Object.fromEntries(Object.entries(PROFILES).map(([id, name]) => [id, { id, name }])), capturedAt: 1 }) as unknown as PipelineRunState["snapshot"];

const handoff = (summary: string, o: Partial<Handoff> = {}): Handoff => ({ schemaVersion: 1, purpose: "Freeze the canonical operation-boundary extension", summary, reason: "The step's work is complete.", next: null, artifacts: [], openQuestions: [], ...o });
/** `ago`: minutes before now it started; `took`: minutes it ran. */
const rec = (seq: number, stepId: string, ago: number, took: number | null, next: string[], o: Partial<PipelineStepRecord> = {}): PipelineStepRecord => ({
  seq, stepId, taskId: `step-${seq}`, startedAt: NOW - ago * MIN, endedAt: took == null ? null : NOW - (ago - took) * MIN, outcome: took == null ? null : "succeeded",
  handoff: took == null ? null : handoff(`${stepId[0]!.toUpperCase()}${stepId.slice(1)} finished its part and handed it on.`, { next: next[0] ?? null }), nextStepIds: next, ...o,
});
const run = (o: Partial<PipelineRunState>): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Change: understand, build, review, finish", snapshot: snapshot(), status: "running", active: [], joins: {}, blocked: [], history: [], stepCount: o.history?.length ?? 0,
  startedAt: NOW - 20 * HOUR, endedAt: null, ...o,
});
const wait = (o: Partial<PipelineBlockWait>): PipelineBlockWait => ({
  stepId: "build", taskId: "step-2", category: "environment", source: "text", what: "the network", ref: null, reason: "the package registry timed out", state: "waiting",
  since: NOW - 12 * MIN, attempt: 1, max: 3, at: NOW + 18 * MIN, deadline: NOW + 6 * HOUR, tried: [{ at: NOW - 5 * MIN, trigger: "timer" }], ...o,
});
const task = (o: Partial<Task> = {}): Task =>
  ({
    id: "t1269", title: "Issue #1269: Freeze the canonical operation-boundary extension", prompt: "Freeze the canonical operation-boundary extension so that TypeScript and Go agree on every supported claim.", column: "running", agent: "claude-code",
    workdir: "/Users/dev/pillar", isolation: "worktree", taskType: "feature", branch: "feat/1269", branchSource: "created", worktreePath: null, baseRef: "develop", prUrl: null, pipelineId: "p", pipelineRun: null,
    mode: null, model: null, effort: null, fast: false, maxMode: false, references: [], backlog: [], draft: null, plans: [], runId: null, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: NOW - 30 * HOUR, updatedAt: NOW - MIN, archivedAt: null, ...o,
  }) as Task;
const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t1269", number: 1406, url: "https://github.com/example/pillar/pull/1406", state: "open", draft: false, baseRef: "develop", headSha: "9f3c1ab77d20", checks: "success", failingChecks: [], unresolvedThreads: 0, behindBy: 0, checkedAt: NOW - 3 * MIN, ...o,
});
const stepBlocked = (message: string, stepId = "build", taskId: string | null = "step-2"): PipelineBlock => ({ taskId, stepId, kind: "step-blocked", message: `step "${stepId[0]!.toUpperCase()}${stepId.slice(1)}" reported it is blocked: ${message}` });

// Understand → Build → Review (changes) → Build → Review (changes) → Build → Review.
const LOOP = [
  rec(1, "understand", 19 * 60, 13, ["build"]),
  rec(2, "build", 18.7 * 60, 119, ["review"]),
  rec(3, "review", 16.7 * 60, 17, ["build"], { handoff: handoff("R03: the Join path drops the wire reference.", { next: "Build", reason: "Changes requested." }) }),
  rec(4, "build", 16.4 * 60, 965, ["review"]),
  rec(5, "review", 20, 4, ["build"], { handoff: handoff("R06: wire Ref validation is not preserved through Normalize.", { next: "Build", reason: "Changes requested." }) }),
  rec(6, "build", 15, 11, ["review"], { handoff: handoff("Fixed R06: wire Ref validation is preserved through Validate, Normalize, FromObservation and Join.", { next: "Review", artifacts: ["packages/contract/src/ref.ts", "apps/agent/internal/contract/ref.go"] }) }),
];
const FULL = [rec(1, "understand", 300, 13, ["build"]), rec(2, "build", 285, 95, ["review"]), rec(3, "review", 188, 17, ["finish"]), rec(4, "finish", 170, 9, [], { handoff: handoff("Opened PR #1406 with the frozen extension and its parity tests.", { artifacts: ["https://github.com/example/pillar/pull/1406", "docs/contract/operation-boundary.md"] }) })];
const upTo = (stepId: string, ago: number) => {
  const i = STEPS.findIndex((s) => s.id === stepId);
  const before = [rec(1, "understand", 200, 13, ["build"]), rec(2, "build", 185, 95, ["review"]), rec(3, "review", 88, 17, ["finish"])].slice(0, i);
  return { history: [...before, rec(i + 1, stepId, ago, null, [])], active: [{ stepId, taskId: `step-${i + 1}`, seq: i + 1 }] };
};

interface Case {
  task: Task;
  steps: Task[];
  pr: TaskPrStatus | null;
  graph: PipelineGraph;
  activity: RunActivityEntry[];
  /** Subagents running for the current step right now. */
  running?: string[];
}
const stepRows = (r: PipelineRunState | null, column: (h: PipelineStepRecord) => Task["column"], o: (h: PipelineStepRecord) => Partial<Task> = () => ({})): Task[] =>
  (r?.history ?? []).map((h) => task({ id: h.taskId, title: `${h.stepId} · #1269`, pipelineParentId: "t1269", pipelineStepId: h.stepId, pipelineId: null, column: column(h), ...o(h) }) as Task);
const live = (h: PipelineStepRecord): Task["column"] => (h.endedAt == null ? "running" : "review");
const parked = (h: PipelineStepRecord): Task["column"] => (h.endedAt == null ? "blocked" : "review");
const act = (ago: number, kind: string, text: string, tone: RunActivityEntry["tone"], url?: string): RunActivityEntry => ({ ts: NOW - ago * MIN, kind, text, tone, url });
const BASE_ACTIVITY = [act(88, "step", "Build finished → Review", "success"), act(185, "step", "Build started", "info"), act(186, "step", "Understand finished → Build", "success"), act(200, "step", "Understand started", "info"), act(1800, "task", "Card created", "muted")];
const PR_URL = "https://github.com/example/pillar/pull/1406";

function cases(): Record<string, Case> {
  const of = (r: PipelineRunState, o: Partial<Task>, extra: Partial<Case> = {}): Case => ({
    task: task({ pipelineRun: r, ...o }), steps: stepRows(r, r.status === "running" ? live : parked), pr: null, graph: r.snapshot?.graph ?? GRAPH, activity: BASE_ACTIVITY, ...extra,
  });
  const fan = run({
    snapshot: snapshot(FAN_GRAPH),
    history: [rec(1, "understand", 60, 12, ["build", "review"]), rec(2, "build", 47, null, []), rec(3, "review", 47, null, [])],
    active: [{ stepId: "build", taskId: "step-2", seq: 2 }, { stepId: "review", taskId: "step-3", seq: 3 }],
  });
  const capped = Array.from({ length: 28 }, (_, i) => rec(i + 1, i === 0 ? "understand" : i % 2 ? "build" : "review", (29 - i) * 40, 30, [i % 2 ? "review" : "build"]));
  const done = run({ status: "done", history: FULL, endedAt: NOW - 160 * MIN, startedAt: NOW - 300 * MIN });
  const prEvents = [act(150, "ci", "CI passed", "success", PR_URL), act(158, "pr", "PR #1406 opened", "info", PR_URL), act(161, "step", "Finish finished", "success")];
  const asking = run(upTo("review", 9));
  return {
    executing: of(run(upTo("build", 4)), { prUrl: PR_URL, lastActivityAt: NOW - MIN }, { pr: pr({ checks: "pending" }) }),
    ci: of(
      run({ ...upTo("finish", 25), blocked: [{ taskId: "step-4", stepId: "finish", kind: "await", message: 'step "Finish" is waiting on "ci-wait 1406" — it resumes when the command exits' }] }),
      { lastActivityAt: NOW - 24 * MIN },
      { pr: pr({ checks: "pending" }), activity: [act(24, "step", "Finish started", "info"), act(900, "ci", "CI passed", "success"), ...BASE_ACTIVITY] },
    ),
    dependency: of(
      run({
        status: "blocked", ...upTo("review", 40),
        blocked: [stepBlocked("required input #1326 is not graph-complete with readable current contract and evidence", "review", "step-3")],
        wait: wait({ stepId: "review", taskId: "step-3", category: "dependency", what: "#1326", ref: "#1326", reason: "waiting on #1326's completed contract", attempt: 2, max: 4, at: NOW + 5 * MIN }),
      }),
      { column: "blocked", blockedBy: [{ taskId: "t1326", title: "Issue #1326: Journey contract and parity", satisfied: true, detail: "running", ref: "#1326" }] },
      { pr: pr() },
    ),
    "auto-retry": of(run({ status: "blocked", ...upTo("build", 40), blocked: [stepBlocked("the package registry timed out")], wait: wait({}) }), { column: "blocked" }, { pr: pr() }),
    recheck: of(
      run({
        status: "blocked", history: [...LOOP],
        blocked: [{ taskId: null, stepId: "review", kind: "step-blocked", message: "required input #1326 is not graph-complete with readable current contract/evidence", pending: { stepId: "review", arrivals: [] }, inputRetry: { at: NOW + 6 * MIN, attempt: 32 } }],
      }),
      { column: "blocked" },
      { pr: pr({ checkedAt: NOW - 4 * MIN }), activity: [act(4, "step", "Review is held for an input; re-checked on a timer", "warning"), act(900, "ci", "CI passed", "success", PR_URL), act(905, "step", "Build finished → Review", "success"), ...BASE_ACTIVITY] },
    ),
    "step-cap": of(run({ status: "blocked", history: capped, stepCount: 28, blocked: [{ taskId: null, stepId: "review", kind: "step-cap", message: "reached the step cap of 28", pending: { stepId: "review", arrivals: [] } }] }), { column: "blocked" }, { pr: pr() }),
    "needs-input": {
      ...of(asking, { column: "blocked", pendingInteractionCount: 2 }),
      steps: stepRows(asking, (h) => (h.endedAt == null ? "blocked" : "review"), (h) => (h.endedAt == null ? { pendingInteractionCount: 2 } : {})),
    },
    failed: of(run({ status: "blocked", ...upTo("build", 40), blocked: [{ taskId: "step-2", stepId: "build", kind: "step-failed", message: 'step "Build" failed — the agent process exited with code 1' }] }), { column: "blocked" }),
    cancelled: of(run({ status: "cancelled", history: [rec(1, "understand", 200, 13, ["build"]), rec(2, "build", 185, 5, [], { outcome: "cancelled", handoff: null })] }), { column: "ready" }),
    loop: of(run({ history: [...LOOP, rec(7, "review", 3, null, [])], active: [{ stepId: "review", taskId: "step-7", seq: 7 }] }), { lastActivityAt: NOW - MIN }, { pr: pr({ checks: "pending" }), running: ["Scout"] }),
    fanout: of(fan, { lastActivityAt: NOW - MIN }, { graph: FAN_GRAPH }),
    done: of(done, { column: "review", prUrl: PR_URL }, { pr: pr(), activity: [...prEvents, ...BASE_ACTIVITY], steps: stepRows(done, () => "review") }),
    // A recorded pass, and a current head that fails: the two are not the same fact.
    "ci-failed": of(
      done,
      { column: "review", prUrl: PR_URL },
      {
        pr: pr({ checks: "failure", failingChecks: [{ name: "unit", url: null, alsoOnBase: false }, { name: "lint", url: null, alsoOnBase: true }], behindBy: 3, headSha: "c41d09e2aa10" }),
        activity: [act(20, "ci", "CI failing: unit", "danger"), ...prEvents, ...BASE_ACTIVITY],
        steps: stepRows(done, () => "review"),
      },
    ),
    "not-started": { task: task({ column: "backlog", pipelineRun: run({ status: "idle", snapshot: null, startedAt: null }) }), steps: [], pr: null, graph: GRAPH, activity: [act(1800, "task", "Card created", "muted")] },
    // Long words everywhere: nothing may spill.
    long: of(
      run({
        status: "blocked", ...upTo("build", 40),
        blocked: [{ taskId: "step-2", stepId: "build", kind: "step-failed", message: `step "Build" failed — supercalifragilisticexpialidocious_identifier_without_breaks_${"x".repeat(80)} and the agent process exited with code 1 after printing a very long stack trace that goes on and on` }],
      }),
      { column: "blocked", title: "Issue #1269: Reconcile the collection-host retention ledger with the canonical operation-boundary extension so that TypeScript and Go agree on every supported claim, including supercalifragilisticexpialidocious_identifier_without_breaks" },
    ),
  };
}

const FOLLOW_UPS: FollowUpAction[] = [
  { id: "open-pr", label: "Open PR", agentName: "Finisher", agentId: "finisher", requiresRequest: false, suggested: false, matched: [] },
  { id: "vm-tests", label: "Run VM tests", agentName: "Sonnet Builder", agentId: "builder", requiresRequest: false, suggested: true, matched: ["apps/agent/internal/contract/ref.go"] },
  { id: "explain", label: "Explain", agentName: "Architect", agentId: "planner", requiresRequest: true, suggested: false, matched: [] },
];

// ── The page ──────────────────────────────────────────────────────────────

/** A handoff in plain text: the real card renders Markdown and opens links
 *  through the core, which this page does not load. */
function PlainHandoff({ handoff: h }: { handoff: Handoff }) {
  return (
    <div data-testid="fixture-handoff" className="rounded-md border border-board-line bg-board-card p-2.5 text-xs leading-[1.5] text-foreground [overflow-wrap:anywhere]">
      <p>{h.summary}</p>
      {h.reason && <p className="mt-1 text-[color:var(--state-queued)]">{h.reason}</p>}
      {h.artifacts.length > 0 && <p className="mt-1 font-mono text-[11px]">{h.artifacts.join(" · ")}</p>}
    </div>
  );
}

function RunFixture() {
  const which = params.get("case") ?? "auto-retry";
  const all = cases();
  const c = all[which] ?? all["auto-retry"]!;
  const [notice, setNotice] = useState("");
  const say = useCallback((what: string) => setNotice(`Preview: ${what}. Nothing was started.`), []);
  const prs = new Map(c.pr ? [[c.task.id, c.pr]] : []);
  const activity = [...c.activity].sort((a, b) => b.ts - a.ts);
  const state = cardState(c.task, { pr: c.pr, lease: leaseInfoForTask(c.task, []), now: NOW });
  const r = c.task.pipelineRun ?? null;
  const delegates: RunDelegate[] = c.graph.steps
    .filter((s) => s.subagents.profileIds.length > 0)
    .map((s) => ({ stepId: s.id, available: s.subagents.profileIds.map((id) => PROFILES[id] ?? id), running: s.id === state.step?.id ? (c.running ?? []) : [] }));
  const reports = new Map<number, string | null>(
    (r?.history ?? []).map((h) => [h.seq, h.handoff ? `${h.handoff.summary}\n\nWhat I checked: the contract's wire references on both sides, and the parity tests.\n\n<handoff>${JSON.stringify({ summary: h.handoff.summary, next: h.handoff.next })}</handoff>` : null]),
  );
  const canFollowUp = !!r && (r.status === "done" || (r.status === "blocked" && !hasLiveExecution(c.steps, r)));
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <h1 className="font-geist text-base font-semibold leading-none tracking-tight">Agetor</h1>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Run view fixtures · made-up runs · no live actions</span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Case
          <select
            data-testid="fixture-case"
            value={which}
            onChange={(e) => {
              const next = new URLSearchParams(window.location.search);
              next.set("case", e.target.value);
              window.location.search = next.toString();
            }}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            {Object.keys(all).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </header>
      <LeaseContext.Provider value={[]}>
        <PrContext.Provider value={prs}>
          <ProgressContext.Provider value={[]}>
            <RoadmapCardsContext.Provider value={new Map()}>
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  <RunPage
                    task={c.task}
                    steps={c.steps}
                    graph={c.graph}
                    state={state}
                    pr={c.pr}
                    now={NOW}
                    activity={activity}
                    reports={reports}
                    delegates={delegates}
                    profileName={(id) => (id ? (PROFILES[id] ?? null) : null)}
                    busy={false}
                    error={null}
                    canvas={<p className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">The live canvas is not loaded on the fixture page: it reads the core.</p>}
                    followUp={
                      canFollowUp ? (
                        <FollowUpComposer
                          actions={FOLLOW_UPS}
                          profiles={Object.entries(PROFILES).map(([id, name]) => ({ id, name }))}
                          busy={false}
                          error={null}
                          onRun={(body) => {
                            say(`start a follow-up (${body.presetId ?? "custom request"})`);
                            return false;
                          }}
                        />
                      ) : null
                    }
                    renderHandoff={(h) => <PlainHandoff handoff={h} />}
                    onBack={() => say("go back to the board")}
                    onOpenTask={(t) => say(t.id === c.task.id ? "open the task's details" : `open the panel of ${t.id}`)}
                    onOpenUrl={(url) => say(`open ${url}`)}
                    onCardAction={(a: CardAction) => say(a.kind === "open-dependency" ? `open the dependency ${a.taskId}` : a.label)}
                    onRetry={(id) => say(`send the retry request${id ? ` for ${id}` : ""}`)}
                    onStop={() => say("stop the run")}
                    onRestart={() => say("restart the pipeline (after its confirmation)")}
                    onAdvance={(from, next) => say(`advance ${from ?? "the run"} to ${next ? next.join(", ") : "the end"}`)}
                    onViewChanges={() => say("view the task's changes")}
                    initialStepId={params.get("step")}
                    initialTab={(params.get("tab") as StepTab | null) ?? undefined}
                    initialPresentation={(params.get("presentation") as StepsPresentation | null) ?? undefined}
                  />
                </div>
                {params.get("card") === "1" && (
                  <div data-testid="fixture-card" className="shrink-0 border-t border-border/60 px-4 py-3">
                    <p className="mb-2 text-[11px] text-muted-foreground">Fixture only: the board card of this task, from the same data.</p>
                    <div className="w-60">
                      <DndContext>
                        <TaskCard task={c.task} homeDir="/Users/dev" onCancel={() => {}} onDelete={() => {}} onSelect={() => {}} onOpen={() => {}} onAction={() => {}} onDiff={() => {}} onMarkDone={() => {}} onArchive={() => {}} onUnarchive={() => {}} />
                      </DndContext>
                    </div>
                  </div>
                )}
                <p role="status" aria-live="polite" data-testid="fixture-notice" className="min-h-6 shrink-0 px-4 pb-1.5 pt-1 text-[11px] text-muted-foreground">
                  {notice}
                </p>
              </main>
            </RoadmapCardsContext.Provider>
          </ProgressContext.Provider>
        </PrContext.Provider>
      </LeaseContext.Provider>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RunFixture />
  </StrictMode>,
);
