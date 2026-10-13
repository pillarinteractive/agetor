/**
 * The Velocity view through the real `VelocityView` and a made-up roadmap
 * run (./velocity-data.ts, through the real `computeVelocity`). A
 * development and screenshot page (e2e/views-fixtures.spec.ts), served by
 * the Vite dev server at /fixtures/velocity.html. It imports nothing that
 * talks to the core — no `@/lib/api` — and its buttons only say what they
 * would have done. Not an entry of `vite build`, so it never ships.
 *
 *   ?case=<name>    roadmap (default) | no-forecast | no-gate | no-samples | empty
 *   ?scope=gate     start on the release gate's forecast (default roadmap)
 *   ?theme=dark     dark theme (default light)
 */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "../index.css";
import { VelocityView } from "@/components/kanban/VelocityView";
import type { ScopeKey } from "@/lib/velocity-view";
import type { PipelineRunState, PipelineStepRecord, Task, TaskPrStatus } from "../../shared/types.ts";
import { velocityFixtureAnswer, velocityFixtureReport, type VelocityFixtureCase } from "./velocity-data";

const params = new URLSearchParams(window.location.search);
const NOW = Date.now();
const MIN = 60_000;
const CASES: VelocityFixtureCase[] = ["roadmap", "no-forecast", "no-gate", "no-samples", "empty"];

const run = (o: Partial<PipelineRunState>): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Change", status: "running", active: [], joins: {}, blocked: [], history: [], stepCount: 0, startedAt: NOW - 120 * MIN, endedAt: null,
  snapshot: { graph: { steps: [{ id: "build", name: "Build" }], edges: [], startStepId: "build" }, maxSteps: 28, profiles: {}, capturedAt: 1 } as never, ...o,
});
const card = (issue: number, title: string, column: Task["column"], o: Partial<Task> = {}): Task =>
  ({ id: `t${issue}`, title: `Issue #${issue}: ${title}`, prompt: "", column, agent: "claude-code", workdir: "/Users/dev/pillar", pipelineId: "p", pipelineRun: null, pendingInteractionCount: 0, archivedAt: null, pipelineParentId: null, runId: null, hasOpenableRun: false, prUrl: null, createdAt: NOW, updatedAt: NOW, ...o }) as Task;

/** Cards for the steps the report says are in flight, each in a different
 *  state; the owner's steps and the rest have none, as on a real board. */
function board(now: number): { tasks: Task[]; prs: TaskPrStatus[] } {
  const report = velocityFixtureReport(now);
  const rows = [...report.bottlenecks.critical, ...report.bottlenecks.owner].filter((b) => !b.human);
  const open: PipelineStepRecord = { seq: 1, stepId: "build", taskId: "s1", startedAt: now - 30 * MIN, endedAt: null, outcome: null, handoff: null, nextStepIds: [] };
  const building = { active: [{ stepId: "build", taskId: "s1", seq: 1 }], history: [open] };
  const ended = (ago: number) => run({ status: "done", history: [{ ...open, endedAt: now - ago * MIN, outcome: "succeeded" }], endedAt: now - ago * MIN });
  // Each card in the state the report says its step is in.
  const cardFor: Partial<Record<string, (issue: number, title: string) => Task>> = {
    building: (i, t) => card(i, t, "running", { pipelineRun: run(building), lastActivityAt: now - MIN }),
    held: (i, t) => card(i, t, "review", { pipelineRun: ended(61) }),
    waiting: (i, t) =>
      card(i, t, "blocked", {
        pipelineRun: run({
          status: "blocked", ...building,
          blocked: [{ taskId: "s1", stepId: "build", kind: "step-blocked", message: 'step "Build" reported it is blocked: develop CI is failing' }],
          wait: { stepId: "build", taskId: "s1", category: "dependency", source: "signal", what: "develop CI", ref: "base-ci", reason: "develop CI is failing", state: "waiting", since: now - 40 * MIN, attempt: 1, max: 4, at: now + 49 * MIN, deadline: now + 600 * MIN, tried: [] },
        }),
      }),
    merging: (i, t) => card(i, t, "merge", { pipelineRun: ended(20) }),
  };
  const tasks = rows.flatMap((b) => (cardFor[b.state] ? [cardFor[b.state]!(b.issue, b.title)] : []));
  const byState = (state: string) => tasks.find((t) => rows.find((b) => `t${b.issue}` === t.id)?.state === state);
  const pr = (taskId: string, number: number, o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
    taskId, number, url: `https://github.com/example/pillar/pull/${number}`, state: "open", draft: false, baseRef: "develop", headSha: "abc", checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: now - 3 * MIN, ...o,
  });
  const held = byState("held");
  const merging = byState("merging");
  const prs = [held && pr(held.id, 1406), merging && pr(merging.id, 1411, { checks: "pending" })].filter((p): p is TaskPrStatus => !!p);
  return { tasks, prs };
}

function VelocityFixture() {
  const which = CASES.find((c) => c === params.get("case")) ?? "roadmap";
  const [delay, setDelay] = useState("");
  const [applied, setApplied] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const answer = useMemo(() => (which === "roadmap" ? velocityFixtureReport(NOW, { ownerDelayMs: applied == null ? undefined : applied * 3_600_000 }) : velocityFixtureAnswer(NOW, which)), [which, applied]);
  const data = useMemo(() => board(NOW), []);
  const prs = useMemo(() => new Map(data.prs.map((p) => [p.taskId, p])), [data]);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <h1 className="font-geist text-base font-semibold leading-none tracking-tight">Agetor</h1>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Velocity fixtures · a made-up run · no live actions</span>
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
            {CASES.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <VelocityView
            answer={answer}
            error={null}
            tasks={which === "empty" ? [] : data.tasks}
            ctx={{ prs, leases: [], now: NOW }}
            delay={delay}
            onDelay={setDelay}
            onApplyDelay={() => {
              const n = Number(delay);
              setApplied(delay.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null);
            }}
            onBack={() => setNotice("Preview: go back to the board. Nothing was started.")}
            onAction={(t, a) => setNotice(`Preview: ${a.label} — ${t.title.split(":")[0]}. Nothing was started.`)}
            initialScope={(params.get("scope") as ScopeKey | null) ?? undefined}
          />
        </div>
        <p role="status" aria-live="polite" data-testid="fixture-notice" className="min-h-6 shrink-0 px-4 pb-1.5 pt-1 text-[11px] text-muted-foreground">
          {notice}
        </p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VelocityFixture />
  </StrictMode>,
);
