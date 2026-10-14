/**
 * Every card state on one page, through the board's real components
 * (`Column`, `TaskCard`, `CardInspector`) and made-up data. A development and
 * screenshot page (e2e/board-fixtures.spec.ts), served by the Vite dev server
 * at /fixtures/board.html. It imports nothing that talks to the core — no
 * `@/lib/api` — and its buttons only say what they would have done. Not an
 * entry of `vite build` (index.html is the only one), so it never ships.
 *
 *   ?theme=dark       dark theme (default light)
 *   ?case=long        long titles, long reasons, long step and agent names
 *   ?case=backlog     60 cards in the backlog
 *   ?select=<id>      open the inspector on that card
 */
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import "@fontsource-variable/geist";
import "../index.css";
import { Column } from "@/components/kanban/Column";
import { CardInspector } from "@/components/kanban/CardInspector";
import type { CardAction } from "@/lib/card-state";
import { columnLabel } from "@/lib/column-labels";
import { LeaseContext } from "@/lib/leases";
import { PrContext } from "@/lib/prs";
import { ProgressContext, RoadmapCardsContext } from "@/lib/progress";
import type { RoadmapCardInfo } from "../../shared/roadmap.ts";
import { boardColumnOf, COLUMNS, type LeaseStatus, type PipelineBlock, type PipelineBlockWait, type PipelineRunState, type PipelineStepRecord, type Task, type TaskPrStatus } from "../../shared/types.ts";

const params = new URLSearchParams(window.location.search);
const CASE = params.get("case");
const NOW = Date.now();
const MIN = 60_000;

// ── Made-up data ──────────────────────────────────────────────────────────

const PROFILES = {
  planner: { id: "planner", name: "Opus Planner" },
  builder: { id: "builder", name: CASE === "long" ? "Sonnet Builder with the extended verification toolchain" : "Sonnet Builder" },
  reviewer: { id: "reviewer", name: "GPT Reviewer" },
  finisher: { id: "finisher", name: "Finisher" },
};
const STEPS = [
  { id: "understand", name: "Understand", agentProfileId: "planner" },
  { id: "build", name: CASE === "long" ? "Build and verify against the lab" : "Build", agentProfileId: "builder" },
  { id: "review", name: "Review", agentProfileId: "reviewer" },
  { id: "finish", name: "Finish", agentProfileId: "finisher" },
];
const EDGES = [
  { id: "e1", from: "understand", to: "build", label: "" },
  { id: "e2", from: "build", to: "review", label: "" },
  { id: "e3", from: "review", to: "finish", label: "" },
  { id: "e4", from: "review", to: "build", label: "changes" },
];
const snapshot = { graph: { steps: STEPS, edges: EDGES, startStepId: "understand" }, maxSteps: 28, profiles: PROFILES, capturedAt: 0 } as unknown as PipelineRunState["snapshot"];
const ORDER = STEPS.map((s) => s.id);

const rec = (seq: number, stepId: string, o: Partial<PipelineStepRecord> = {}): PipelineStepRecord => ({
  seq, stepId, taskId: `step-${seq}`, startedAt: NOW - 90 * MIN, endedAt: NOW - 80 * MIN, outcome: "succeeded", handoff: null, nextStepIds: ["next"], ...o,
});
/** A run whose steps before `at` succeeded and whose `at` step is open. */
function runAt(at: string, o: Partial<PipelineRunState> = {}, startedAgo = 2 * MIN): PipelineRunState {
  const i = ORDER.indexOf(at);
  const history = ORDER.slice(0, i).map((id, n) => rec(n + 1, id));
  history.push(rec(i + 1, at, { startedAt: NOW - startedAgo, endedAt: null, outcome: null }));
  return {
    pipelineId: "p", pipelineName: "Change: plan, build, review, finish", snapshot, status: "running",
    active: [{ stepId: at, taskId: `step-${i + 1}`, seq: i + 1 }], joins: {}, blocked: [], history, stepCount: i + 1, startedAt: NOW - 120 * MIN, endedAt: null, ...o,
  };
}
const finished = (summary: string): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Change: plan, build, review, finish", snapshot, status: "done", active: [], joins: {}, blocked: [],
  history: ORDER.map((id, n) => rec(n + 1, id, n === ORDER.length - 1 ? { nextStepIds: [], handoff: { schemaVersion: 1, purpose: "", summary, reason: "", next: null, artifacts: [], openQuestions: [] } as never } : {})),
  stepCount: 4, startedAt: NOW - 240 * MIN, endedAt: NOW - 30 * MIN,
});
const blockedAt = (at: string, blocked: PipelineBlock[], o: Partial<PipelineRunState> = {}) => runAt(at, { status: "blocked", blocked, ...o }, 40 * MIN);
const wait = (o: Partial<PipelineBlockWait>): PipelineBlockWait => ({
  stepId: "build", taskId: "step-2", category: "environment", source: "text", what: "the network", ref: null, reason: "the package registry timed out", state: "waiting",
  since: NOW - 12 * MIN, attempt: 1, max: 3, at: NOW + 18 * MIN, deadline: NOW + 360 * MIN, tried: [{ at: NOW - 5 * MIN, trigger: "timer" }], ...o,
});

let n = 0;
const task = (issue: number, title: string, column: Task["column"], o: Partial<Task> = {}): Task =>
  ({
    id: `t${issue}`, title: `Issue #${issue}: ${title}`, prompt: "", column, agent: "claude-code", workdir: "/Users/dev/pillar", isolation: "worktree", taskType: "feature",
    branch: `feat/${issue}`, branchSource: "created", worktreePath: null, baseRef: "develop", prUrl: null, pipelineId: "p", pipelineRun: null, mode: null, model: null, effort: null,
    fast: false, maxMode: false, references: [], backlog: [], draft: null, plans: [], runId: null, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: NOW - 600 * MIN, updatedAt: NOW - ++n * MIN, archivedAt: null, ...o,
  }) as Task;
const pr = (taskId: string, number: number, o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId, number, url: `https://github.com/example/pillar/pull/${number}`, state: "open", draft: false, baseRef: "develop", headSha: "abc", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: NOW - 3 * MIN, ...o,
});

const LONG = "Reconcile the collection-host retention ledger with the canonical operation-boundary extension so that TypeScript and Go agree on every supported claim, including supercalifragilisticexpialidocious_identifier_without_breaks";

function standardBoard(): { tasks: Task[]; prs: TaskPrStatus[]; leases: LeaseStatus[]; roadmap: RoadmapCardInfo[] } {
  const stepBlocked = (message: string, stepId = "build", taskId: string | null = "step-2"): PipelineBlock[] => [{ taskId, stepId, kind: "step-blocked", message: `step "x" reported it is blocked: ${message}` }];
  const tasks: Task[] = [
    // Backlog
    task(1455, "Classify TypeScript packages and enforce import direction", "backlog"),
    task(1454, "Run retained Agent sources on the collection host", "backlog", { blockedBy: [{ taskId: "t1351", title: "Issue #1351: Collection host lease", satisfied: false, detail: "running", ref: "#1351" }] }),
    task(1460, "Publish the retention ledger schema", "backlog"),
    task(1458, "Trim the lab bootstrap to one command", "ready", { pipelineRun: runAt("build", { status: "cancelled", history: [rec(1, "understand"), rec(2, "build", { outcome: "cancelled", startedAt: NOW - 50 * MIN, endedAt: NOW - 45 * MIN })] }) }),
    task(1461, "Sketch the tenant export format", "backlog", { pipelineId: null, agentProfile: { name: "Opus Planner" } as never }),
    // Running
    task(933, "Detect native capabilities without elevation", "running", { prUrl: "https://github.com/example/pillar/pull/1399", pipelineRun: runAt("build"), lastActivityAt: NOW - MIN, runningSubagents: 2 }),
    task(1279, "Bind project scope to backup coverage evidence", "running", { pipelineRun: runAt("review", { history: [rec(1, "understand"), rec(2, "build"), rec(3, "review"), rec(4, "build", { taskId: "step-4" }), rec(5, "review", { taskId: "step-5", startedAt: NOW - 4 * MIN, endedAt: null, outcome: null })], active: [{ stepId: "review", taskId: "step-5", seq: 5 }] }), lastActivityAt: NOW - MIN, unread: true }),
    task(1326, "Extend the journey contract with Go/TypeScript parity", "running", { pipelineRun: runAt("finish", { blocked: [{ taskId: "step-4", stepId: "finish", kind: "await", message: 'step "Finish" is waiting on "ci-wait 1476" — it resumes when the command exits' }] }, 25 * MIN), lastActivityAt: NOW - 24 * MIN }),
    task(1265, "Version OBS supported claims independently", "running", { pipelineRun: runAt("build", { blocked: [{ taskId: "step-2", stepId: "build", kind: "await", message: 'step "Build" is waiting on "lab e2e suite" — it resumes when the command exits' }] }, 31 * MIN), lastActivityAt: NOW - 30 * MIN }),
    task(1301, "Harden the agent's restart path", "running", { pipelineRun: runAt("build", {}, 48 * MIN), lastActivityAt: NOW - 26 * MIN }),
    task(1340, "Queue the nightly qualification run", "running", { pipelineRun: { ...runAt("understand"), active: [], history: [rec(1, "understand")], blocked: [{ taskId: null, stepId: "build", kind: "slot-wait", message: "queued — 3 of 3 agents busy" }] } }),
    task(1345, "Write the upgrade note for v1.1", "running", { pipelineId: null, runId: "r1", lastActivityAt: NOW - 2 * MIN, todoProgress: { completed: 2, total: 5 }, agentProfile: { name: "Sonnet Builder" } as never }),
    task(1346, "Check the docs build", "running", { pipelineId: null, runId: "r2" }),
    // Blocked
    task(1293, "Project compact backup evidence into optional Cloud", "blocked", { pipelineRun: blockedAt("review", [{ taskId: null, stepId: "review", kind: "step-cap", message: "reached the step cap of 28", pending: { stepId: "review", arrivals: [] } }]) }),
    task(1269, "Freeze the canonical operation-boundary extension", "blocked", { pendingInteractionCount: 2, pipelineRun: runAt("review") }),
    task(845, "Bind the first NAS read role and secret store", "blocked", { pipelineRun: blockedAt("build", stepBlocked("the package registry timed out"), { wait: wait({}) }) }),
    task(846, "Rotate the lab credentials on a schedule", "blocked", { pipelineRun: blockedAt("build", [{ taskId: "step-2", stepId: "build", kind: "step-failed", message: 'step "Build" failed — You have hit your usage limit' }], { autoRetry: { stepId: "build", kind: "quota", attempt: 1, at: NOW + 95 * MIN, reason: "usage limit reached, resets 4:35 PM" } }) }),
    task(850, "Snapshot the NAS lab before each run", "blocked", { pipelineRun: blockedAt("build", stepBlocked("the lab lease is held by another checkout")) }),
    task(851, "Probe the collection host over the tunnel", "blocked", { pipelineRun: blockedAt("build", stepBlocked("waiting on #1351 to merge"), { wait: wait({ category: "dependency", what: "#1351", ref: "#1351", reason: "waiting on #1351 to merge", attempt: 0, tried: [] }) }), blockedBy: [{ taskId: "t1454", title: "x", satisfied: true, detail: "", ref: "#9999" }] }),
    task(860, "Seal the evidence bundle format", "blocked", { pipelineRun: blockedAt("build", stepBlocked("the fixture service did not come up"), { wait: wait({ state: "escalated", category: "unknown", what: "its own stated reason", attempt: 3, at: null, reason: "the fixture service did not come up", escalation: "still blocked after 3 automatic retries", tried: [{ at: NOW - 200 * MIN, trigger: "timer" }, { at: NOW - 120 * MIN, trigger: "timer" }, { at: NOW - 40 * MIN, trigger: "timer" }] }) }) }),
    // No owner holds (src/shared/owner-holds.ts): an unattended card the
    // ladder is resolving, and one closed out on the issue filed for the owner.
    task(862, "Pin the collector's digest refresh", "blocked", { pipelineRun: blockedAt("finish", stepBlocked("Blocked on permission to refresh recorded digest pins", "finish", "step-4"), { ladder: { steps: {}, reroutes: 0, resolving: { since: NOW - MIN, note: "Finish: Blocked on permission to refresh recorded digest pins" } } }) }),
    task(863, "Choose the retention ledger's storage class", "blocked", { pipelineRun: blockedAt("review", stepBlocked("which storage class to use", "review", "step-3"), { ladder: { steps: {}, reroutes: 0, closed: { at: NOW - 30 * MIN, mode: "depend", issues: [1502] } }, wait: wait({ stepId: "review", taskId: "step-3", category: "dependency", source: "signal", what: "#1502", ref: "#1502", reason: "which storage class to use", attempt: 0, max: 0, tried: [], at: NOW + 90 * MIN, deadline: Number.MAX_SAFE_INTEGER, endless: true, closeout: true }) }) }),
    task(861, "Migrate the scheduler table", "blocked", { pipelineRun: blockedAt("build", [{ taskId: "step-2", stepId: "build", kind: "step-failed", message: 'step "Build" failed — the agent process exited with code 1' }]) }),
    // In review
    task(1031, "Select a Kubernetes CSI profile", "review", { pipelineRun: finished("Opened PR #1381 with the CSI profile selection") }),
    task(1023, "Select a Windows request source", "review", { pipelineRun: finished("Opened PR #1416") }),
    task(1024, "Document the request-source contract", "review", { pipelineRun: finished("Opened PR #1417") }),
    task(1025, "Add the restore drill checklist", "review", { pipelineRun: finished("Wrote the checklist and pushed the branch") }),
    task(1026, "Retire the legacy probe", "review", { pipelineRun: finished("Opened PR #1420") }),
    task(1027, "Rename the evidence fields", "review", { pipelineRun: finished("Opened PR #1421") }),
    // Merge queue
    task(816, "Select a scoped journey subgraph", "merge", { pipelineRun: finished("Ready to merge") }),
    task(1285, "Decide the Time Machine evidence route", "merge", { pipelineRun: finished("Ready to merge") }),
    task(1286, "Stamp the commercial-capacity checkpoint", "merge", { pipelineRun: finished("Ready to merge") }),
    task(1287, "Fold the review ledger into the journey docs", "merge", { pipelineRun: finished("Ready to merge"), mergeTrain: { pr: 1500, url: "https://github.com/example/pillar/pull/1500", state: "riding" } }),
    // Done
    task(892, "Verify candidate artifact trust", "done", { pipelineRun: finished("Merged") }),
    task(1350, "Enforce collection contracts and import effect boundaries", "done", { pipelineRun: finished("Merged") }),
    task(1352, "Tidy the fixture names", "done", { pipelineRun: finished("Renamed the fixtures; no PR was needed") }),
  ];
  const failing = [{ name: "unit", url: null, alsoOnBase: false }, { name: "e2e-web", url: null, alsoOnBase: false }];
  const prs = [
    pr("t933", 1399, { checks: "pending" }),
    pr("t1326", 1476, { checks: "pending" }),
    pr("t1293", 1472),
    pr("t1031", 1381, { checks: "failure", failingChecks: failing }),
    pr("t1023", 1416),
    pr("t1024", 1417, { unresolvedThreads: 3 }),
    pr("t1026", 1420, { state: "closed" }),
    pr("t1027", 1421, { checks: "none" }),
    pr("t1285", 1457, { behindBy: 4 }),
    pr("t1286", 1459, { checks: "pending" }),
    pr("t1287", 1463),
    pr("t892", 1390, { state: "merged" }),
    pr("t1350", 1480, { state: "merged" }),
  ];
  const leases: LeaseStatus[] = [
    { project: "/Users/dev/pillar", label: "lab", held: true, holderTaskId: "t933", holderTitle: "#933", checkout: "/x", owner: null, since: null, checkedAt: NOW, queue: [{ taskId: "t850" }] } as unknown as LeaseStatus,
  ];
  const roadmap = [{ taskId: "t1460", line: "Step 7 · waits on step 6 (#1455)", tone: "muted" } as unknown as RoadmapCardInfo];
  return { tasks, prs, leases, roadmap };
}

function board() {
  const base = standardBoard();
  if (CASE === "long") {
    base.tasks = base.tasks.map((t, i) => (i % 2 === 0 ? { ...t, title: `${t.title.split(":")[0]}: ${LONG}` } : t));
    const stuck = base.tasks.find((t) => t.id === "t861")!;
    stuck.pipelineRun!.blocked[0]!.message = `step "Build" failed — ${LONG} and the agent process exited with code 1 after printing a very long stack trace that goes on and on`;
  }
  if (CASE === "backlog") {
    const more = Array.from({ length: 57 }, (_, i) => task(2000 + i, `Backlog item ${i + 1}: follow-up work queued behind the current milestone`, "backlog"));
    base.tasks = [...more, ...base.tasks];
  }
  return base;
}

// ── The page ──────────────────────────────────────────────────────────────

function BoardFixture() {
  const data = useMemo(board, []);
  const [query, setQuery] = useState("");
  const [inspectedId, setInspectedId] = useState<string | null>(params.get("select"));
  const [notice, setNotice] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const prs = useMemo(() => new Map(data.prs.map((p) => [p.taskId, p])), [data]);
  const roadmap = useMemo(() => new Map(data.roadmap.map((c) => [c.taskId, c])), [data]);
  const visible = useMemo(() => data.tasks.filter((t) => t.title.toLowerCase().includes(query.trim().toLowerCase())), [data, query]);
  const inspected = visible.find((t) => t.id === inspectedId) ?? null;

  // Nothing here reaches a core: each handler only says what it stood for.
  const say = useCallback((what: string, t: Task) => setNotice(`Preview: ${what} — ${t.title.split(":")[0]}. Nothing was started.`), []);
  const onSelect = useCallback((t: Task) => setInspectedId(t.id), []);
  const onOpen = useCallback((t: Task) => say("open the run", t), [say]);
  const onAction = useCallback((t: Task, a: CardAction) => (a.kind === "inspect" ? setInspectedId(t.id) : say(a.label, t)), [say]);
  const onCancel = useCallback((t: Task) => say("stop", t), [say]);
  const onDelete = useCallback((t: Task) => say("delete", t), [say]);
  const onDiff = useCallback((t: Task) => say("view changes", t), [say]);
  const onMarkDone = useCallback((t: Task) => say("mark done", t), [say]);
  const onArchive = useCallback((t: Task) => say("archive", t), [say]);
  const onUnarchive = useCallback((t: Task) => say("unarchive", t), [say]);
  const onRestart = useCallback((t: Task) => say("restart the pipeline (after its confirmation)", t), [say]);
  const closeInspector = useCallback(() => setInspectedId(null), []);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
        <h1 className="font-geist text-base font-semibold leading-none tracking-tight">Agetor</h1>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Board fixtures · made-up cards · no live actions</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a task…"
          aria-label="Search tasks"
          className="h-7 w-44 rounded-md border border-input bg-transparent px-2 text-xs"
        />
      </header>
      <LeaseContext.Provider value={data.leases}>
        <PrContext.Provider value={prs}>
          <ProgressContext.Provider value={[]}>
            <RoadmapCardsContext.Provider value={roadmap}>
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="relative flex-1">
                  <div className="kanban-scroll absolute inset-0 overflow-x-scroll">
                    <DndContext sensors={sensors}>
                      <div className="flex min-h-full min-w-full gap-[9px] px-3 pb-3.5 pt-3">
                        {COLUMNS.map((c) => (
                          <Column
                            key={c.id}
                            id={c.id}
                            label={columnLabel(c.id)}
                            tasks={visible.filter((t) => boardColumnOf(t.column) === c.id)}
                            homeDir="/Users/dev"
                            onCancel={onCancel}
                            onDelete={onDelete}
                            onSelect={onSelect}
                            onOpen={onOpen}
                            onAction={onAction}
                            onDiff={onDiff}
                            onMarkDone={onMarkDone}
                            onArchive={onArchive}
                            onUnarchive={onUnarchive}
                            selectedTaskId={null}
                            inspectedTaskId={inspected?.id ?? null}
                            onMergeTogether={c.id === "merge" ? () => setNotice("Preview: merge together. Nothing was started.") : undefined}
                            onRefresh={c.id === "merge" ? async () => setNotice("Preview: refresh the merge queue. Nothing was started.") : undefined}
                          />
                        ))}
                      </div>
                    </DndContext>
                  </div>
                </div>
                {inspected && <CardInspector task={inspected} onClose={closeInspector} onOpen={onOpen} onAction={onAction} onRestart={onRestart} onStop={onCancel} />}
                <p role="status" aria-live="polite" data-testid="fixture-notice" className="min-h-6 shrink-0 px-4 pb-1.5 text-[11px] text-muted-foreground">
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
    <BoardFixture />
  </StrictMode>,
);
