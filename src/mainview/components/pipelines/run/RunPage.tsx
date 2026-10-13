import { useState, type ReactNode } from "react";
import type { CardAction, CardState } from "@/lib/card-state";
import { formatElapsed } from "@/lib/card-state";
import { prNumberFromUrl } from "@/lib/card-names";
import { checksEvidence, executionSummary, hasLiveExecution, recoveryControls, stepTiles, type BandAction } from "@/lib/run-view";
import { LiveProgressPanel } from "../LiveProgressPanel";
import type { CheckLedgerEntry, Handoff, PipelineGraph, PipelineStepRecord, Task, TaskPrStatus } from "../../../../shared/types.ts";
import { HoldAside } from "./HoldAside";
import { ExecutionHistory, RecentActivity, type ResponseKindInfo, type RunActivityEntry } from "./RunHistory";
import { RunHeader } from "./RunHeader";
import { StateBand } from "./StateBand";
import { StepContext, type StepTab } from "./StepContext";
import { StepTiles, type RunDelegate, type StepsPresentation } from "./StepTiles";

export interface RunPageProps {
  task: Task;
  /** The run's step tasks. */
  steps: Task[];
  /** The run's snapshot graph, or the live pipeline's before the first run. */
  graph: PipelineGraph | null;
  /** The card's state for this task: what the board card shows too. */
  state: CardState;
  pr: TaskPrStatus | null;
  now: number;
  /** The card's activity timeline, newest first; null while unavailable. */
  activity: RunActivityEntry[] | null;
  /** The run's check ledger, oldest first; null or absent while unavailable. */
  ledger?: CheckLedgerEntry[] | null;
  /** A step's full final report by execution `seq`: absent = not read yet, null = none. */
  reports: ReadonlyMap<number, string | null>;
  onNeedReport?: (seq: number) => void;
  delegates: RunDelegate[];
  profileName: (profileId: string | null) => string | null;
  busy: boolean;
  error: string | null;
  /** The React Flow canvas, shown under "Graph & routing". */
  canvas: ReactNode;
  /** The follow-up composer, when this run can take a follow-up. */
  followUp: ReactNode | null;
  renderHandoff: (h: Handoff) => ReactNode;
  responseKind?: (kind: PipelineStepRecord["responseKind"]) => ResponseKindInfo | null;
  onBack: () => void;
  /** Open a task's panel: a step's transcript, or the card's own details. */
  onOpenTask: (t: Task) => void;
  onOpenUrl?: (url: string) => void;
  /** The board card's button, handled as the board handles it. */
  onCardAction: (action: CardAction) => void;
  onRetry: (stepTaskId?: string) => void;
  onStop: () => void;
  onRestart: () => void;
  onAdvance: (fromTaskId: string | null, nextStepIds: string[] | null, handoff?: Partial<Handoff>) => void;
  onViewChanges?: () => void;
  initialStepId?: string | null;
  initialTab?: StepTab;
  initialPresentation?: StepsPresentation;
}

/**
 * One pipeline task's run, laid out: the heading, the state band with the
 * run's only recovery actions, the steps as tiles (or the graph), the
 * selected step beside what holds the run, then the recorded activity and
 * executions. It draws what it is given and fetches nothing, so the fixture
 * page (src/mainview/fixtures/run.html) renders it from made-up runs.
 */
export function RunPage(props: RunPageProps) {
  const { task, steps, graph, state, pr, now } = props;
  const run = task.pipelineRun ?? null;
  const started = run != null && !(run.status === "idle" && run.history.length === 0);
  const summary = run ? executionSummary(run) : null;
  const tiles = stepTiles(run, graph, steps, task, state);
  const controls = recoveryControls(task, steps, state);
  const checks = checksEvidence({ pr, run, activity: props.activity, task, now, ledger: props.ledger });

  const [picked, setPicked] = useState<string | null>(props.initialStepId ?? null);
  const [tab, setTab] = useState<StepTab>(props.initialTab ?? "summary");
  const [presentation, setPresentation] = useState<StepsPresentation>(props.initialPresentation ?? "steps");

  // The step shown below: the one picked, else the one the run is on, else
  // where it ended, else the first.
  const all = [...tiles.tiles, ...tiles.followUps];
  const ended = run ? [...run.history].sort((a, b) => b.seq - a.seq).find((r) => r.nextStepIds.length === 0)?.stepId : undefined;
  const selected = all.find((t) => t.id === picked) ?? all.find((t) => t.id === state.step?.id) ?? all.find((t) => t.current) ?? all.find((t) => t.id === ended) ?? all[0] ?? null;

  const prNumber = pr?.number ?? prNumberFromUrl(task.prUrl);
  const prUrl = pr?.url ?? task.prUrl ?? null;
  const openPr = prUrl ? () => props.onCardAction({ kind: "view-pr", label: "Open PR", url: prUrl }) : undefined;

  // The band's third line, after the card's own reason (which already says
  // when it is tried again and which attempt it is): how long it has run or
  // waited, and whether any agent is executing — each only where the run says so.
  const facts: string[] = [];
  if (run && started) {
    if (state.elapsedMs != null) facts.push(`${state.state === "working" || state.kind === "quiet" ? "running" : "waiting"} ${formatElapsed(state.elapsedMs)}`);
    const executing = run.active.some((a) => steps.find((t) => t.id === a.taskId)?.column === "running");
    if (run.status !== "done" && !executing && state.state !== "working") facts.push(hasLiveExecution(steps, run) ? "no agent executing: a step waits on your answer" : "no agent executing");
    if (state.kind === "step-cap" && summary) facts.push(summary.cap.label);
  }

  const onBandAction = (a: BandAction) => {
    switch (a.kind) {
      case "retry":
        return props.onRetry(a.stepTaskId ?? undefined);
      case "stop":
        return props.onStop();
      case "open-step":
        return props.onOpenTask(steps.find((t) => t.id === a.taskId) ?? task);
      case "card":
        return props.onCardAction(a.action);
    }
  };

  return (
    <div data-testid="pipeline-run-view" className="h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1280px] px-4 py-5 md:px-[22px]">
        <RunHeader
          task={task}
          status={run?.status ?? "idle"}
          pipelineName={run?.pipelineName ?? "Pipeline"}
          prNumber={prNumber}
          summary={started ? summary : null}
          onBack={props.onBack}
          onTaskDetails={() => props.onOpenTask(task)}
        />
        <StateBand state={state} facts={facts} controls={controls} busy={props.busy} error={props.error} onAction={onBandAction} />
        <StepTiles
          tiles={tiles}
          selectedId={selected?.id ?? null}
          onSelect={setPicked}
          profileName={props.profileName}
          presentation={presentation}
          onPresentation={setPresentation}
          graph={graph}
          run={run}
          canvas={props.canvas}
          delegates={props.delegates}
        />
        {/* Narrow: what holds the run comes before the step's detail. */}
        <div className="grid grid-cols-1 items-start gap-[22px] md:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="order-2 min-w-0 md:order-1">
            <StepContext
              task={task}
              run={run}
              graph={graph}
              steps={steps}
              tile={selected}
              state={state}
              pr={pr}
              now={now}
              tab={tab}
              onTab={setTab}
              checks={checks}
              reports={props.reports}
              onNeedReport={props.onNeedReport}
              delegate={props.delegates.find((d) => d.stepId === selected?.id) ?? null}
              profileName={props.profileName}
              renderHandoff={props.renderHandoff}
              onOpenTask={props.onOpenTask}
              onOpenPr={openPr}
              onViewChanges={props.onViewChanges}
              followUp={props.followUp}
            />
          </div>
          <div className="order-1 min-w-0 md:order-2">
            <HoldAside
              task={task}
              run={run}
              graph={graph}
              steps={steps}
              state={state}
              pr={pr}
              now={now}
              summary={started ? summary : null}
              controls={controls}
              busy={props.busy}
              profileName={props.profileName}
              renderHandoff={props.renderHandoff}
              liveProgress={<LiveProgressPanel taskId={task.id} />}
              onOpenTask={props.onOpenTask}
              onRestart={props.onRestart}
              onAdvance={props.onAdvance}
            />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
          <RecentActivity entries={props.activity} now={now} onOpenUrl={props.onOpenUrl} />
          {run && summary ? (
            <ExecutionHistory run={run} graph={graph} summary={summary} now={now} renderHandoff={props.renderHandoff} responseKind={props.responseKind} />
          ) : (
            <section className="min-w-0">
              <h3 className="mb-2.5 text-sm font-semibold text-foreground">Execution history</h3>
              <p className="text-[11px] text-[color:var(--state-queued)]">No steps have run yet.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
