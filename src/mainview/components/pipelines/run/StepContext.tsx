import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, FileText, FolderOpen, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabPanel, UnderlineTabs } from "@/components/ui/tabs-underline";
import { cn } from "@/lib/utils";
import { formatAge } from "@/lib/card-status";
import { whyStopped } from "@/lib/board-health";
import type { CardState } from "@/lib/card-state";
import { formatSpan, outcomeLabel, roundOf, type ChecksEvidence, type CheckRow, type StepTile } from "@/lib/run-view";
import { StateBadge } from "@/components/kanban/StateBadge";
import { handoffHeadline } from "../../../../shared/pipeline.ts";
import type { Handoff, PipelineGraph, PipelineRunState, Task, TaskPrStatus } from "../../../../shared/types.ts";
import { InfoRow, PANEL, SectionHead, SUB } from "./parts";
import type { RunDelegate } from "./StepTiles";

export type StepTab = "summary" | "transcript" | "checks" | "files";

const TABS: { value: StepTab; label: string; testId: string }[] = [
  { value: "summary", label: "Summary", testId: "pipeline-run-tab-summary" },
  { value: "transcript", label: "Transcript", testId: "pipeline-run-tab-transcript" },
  { value: "checks", label: "Checks", testId: "pipeline-run-tab-checks" },
  { value: "files", label: "Files", testId: "pipeline-run-tab-files" },
];

const CHECK_TONE: Record<CheckRow["status"], { tone: "working" | "failed" | "waiting" | "queued"; icon: "activity" | "x" | "clock" | "dashed"; label: string }> = {
  passing: { tone: "working", icon: "activity", label: "Passing" },
  failing: { tone: "failed", icon: "x", label: "Failing" },
  running: { tone: "waiting", icon: "clock", label: "Running" },
  none: { tone: "queued", icon: "dashed", label: "None reported" },
  unavailable: { tone: "queued", icon: "dashed", label: "Unavailable" },
};

/**
 * The step picked in the tiles: what it is doing or last did (Summary), its
 * final report with the way to the whole transcript (Transcript), what is
 * known about checks (Checks), and what it named or changed (Files). It
 * says whether it shows the step the run is on or an earlier execution.
 */
export function StepContext({
  task,
  run,
  graph,
  steps,
  tile,
  state,
  pr,
  now,
  tab,
  onTab,
  checks,
  reports,
  onNeedReport,
  delegate,
  profileName,
  renderHandoff,
  onOpenTask,
  onOpenPr,
  onViewChanges,
  followUp,
}: {
  task: Task;
  run: PipelineRunState | null;
  graph: PipelineGraph | null;
  steps: Task[];
  tile: StepTile | null;
  state: CardState;
  pr: TaskPrStatus | null;
  now: number;
  tab: StepTab;
  onTab: (tab: StepTab) => void;
  checks: ChecksEvidence;
  reports: ReadonlyMap<number, string | null>;
  onNeedReport?: (seq: number) => void;
  delegate: RunDelegate | null;
  profileName: (profileId: string | null) => string | null;
  renderHandoff: (h: Handoff) => ReactNode;
  onOpenTask: (t: Task) => void;
  onOpenPr?: () => void;
  onViewChanges?: () => void;
  /** The follow-up composer, when the run can take one. */
  followUp: ReactNode | null;
}) {
  const records = run && tile ? run.history.filter((r) => r.stepId === tile.id).sort((a, b) => b.seq - a.seq) : [];
  const latest = records[0] ?? null;
  const stepTask = tile?.taskId ? (steps.find((t) => t.id === tile.taskId) ?? null) : null;
  const seq = latest?.seq ?? null;
  useEffect(() => {
    if (tab === "transcript" && seq != null) onNeedReport?.(seq);
  }, [tab, seq, onNeedReport]);

  if (!tile) {
    return (
      <section aria-label="Selected step" className="min-w-0">
        <SectionHead title="Step context" />
        <p className={SUB}>No step to show: the pipeline's steps are unavailable.</p>
      </section>
    );
  }

  const own = state.step?.id === tile.id;
  const viewing = tile.current ? "Current step" : latest ? "Viewing recorded execution" : "Viewing a step that has not run";
  const openStep = stepTask ? (
    <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-open-step" className="h-7 gap-1 px-2.5 text-[11px]" onClick={() => onOpenTask(stepTask)}>
      <FolderOpen className="size-3" aria-hidden />
      Open step
    </Button>
  ) : null;

  return (
    <section data-testid="pipeline-run-step-context" data-step-id={tile.id} aria-labelledby="run-step-title" className="min-w-0">
      <SectionHead id="run-step-title" title={`${tile.name} context`} note={<span data-testid="pipeline-run-step-viewing">{viewing}</span>} />
      <UnderlineTabs label="Selected step content" idBase="run-step" value={tab} tabs={TABS} onChange={onTab} className="mb-4" />
      <TabPanel idBase="run-step" value={tab} className="min-h-[183px] text-xs">
        {/* Called, not mounted: each is a part of this component, and a
         *  fresh component type per render would remount its panel on every poll. */}
        {tab === "summary" && summaryTab()}
        {tab === "transcript" && transcriptTab()}
        {tab === "checks" && checksTab()}
        {tab === "files" && filesTab()}
      </TabPanel>
      <div className="mt-5 border-t border-board-line pt-3.5">
        {followUp ?? (
          <p data-testid="pipeline-run-followup-unavailable" className={SUB}>
            A follow-up can be started once the run is done, or blocked with no step executing. It runs as a new step on this run, not inside the step shown above.
          </p>
        )}
      </div>
    </section>
  );

  function summaryTab() {
    // The step's own words in full, when they say more than the band's one line.
    const why = own ? whyStopped(task, pr) : null;
    const said = (why?.lines ?? []).map((l) => l.replace(/^step "[^"]*" failed(?: —|:)?\s*/i, "")).filter((l) => l && !state.reason.includes(l));
    const headline = latest ? handoffHeadline(latest.handoff) : "";
    const isResult = !!run && run.status === "done" && !!latest?.handoff && latest.endedAt != null && latest.nextStepIds.length === 0;
    return (
      <>
        <div className={cn(PANEL, "px-3.5 py-3")}>
          <StateBadge tone={tile!.tone} icon={tile!.icon} label={tile!.label} testId="pipeline-run-step-state" />
          <p className="mt-2 leading-[1.5] text-foreground [overflow-wrap:anywhere]">
            {own
              ? state.reason
              : latest
                ? `${outcomeLabel(latest, graph)}${headline ? `. ${headline}` : ""}`
                : `${tile!.name} has not run in this run.`}
          </p>
          {said.length > 0 && <SaidLines lines={said} />}
        </div>
        {latest?.handoff && (
          <div data-testid={isResult ? "pipeline-run-result" : "pipeline-run-step-handoff"} className="mt-3">
            <p className={cn(SUB, "mb-1.5")}>
              Handoff from execution #{latest.seq}
              {!tile!.current && " · a recorded handoff, not an approval of the current head"}
            </p>
            {renderHandoff(latest.handoff)}
          </div>
        )}
        <dl className="mt-3">
          <InfoRow name="Agent profile">{profileName(tile!.profileId) ?? "none set"}</InfoRow>
          <InfoRow name="Executions" testId="pipeline-run-step-executions">
            {tile!.countLabel}
            {latest && ` · latest #${latest.seq}${roundOf(run!, latest) > 1 ? `, round ${roundOf(run!, latest)}` : ""}`}
          </InfoRow>
          {latest && <InfoRow name="Latest execution">{latest.endedAt != null ? `${formatSpan(latest.endedAt - latest.startedAt)} elapsed` : `started ${formatAge(now - latest.startedAt)} ago, still open`}</InfoRow>}
          <InfoRow name="Subagents" testId="pipeline-run-step-subagents">
            {!delegate || (delegate.available.length === 0 && delegate.running.length === 0)
              ? "none configured"
              : [delegate.available.length > 0 ? `available: ${delegate.available.join(", ")}` : null, delegate.running.length > 0 ? `running: ${delegate.running.join(", ")}` : "none running"].filter(Boolean).join(" · ")}
          </InfoRow>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-[7px]">
          {openStep ?? (
            <p data-testid="pipeline-run-step-not-started" className={SUB}>
              "{tile!.name}" hasn't started yet: there is no step to open.
            </p>
          )}
        </div>
      </>
    );
  }

  function transcriptTab() {
    const report = seq != null ? reports.get(seq) : undefined;
    return (
      <>
        <div className={cn(PANEL, "px-3.5 py-3")}>
          <p className="mb-1.5 font-semibold text-foreground">{latest ? `${tile!.name} · final report of execution #${latest.seq}` : `${tile!.name} · no execution yet`}</p>
          {!latest ? (
            <p className={SUB}>This step has not run, so it has no report or transcript.</p>
          ) : report === undefined ? (
            <p data-testid="pipeline-run-report-loading" className={SUB}>
              {onNeedReport ? "Reading the report…" : "The final report is unavailable here."}
            </p>
          ) : report === null ? (
            <p data-testid="pipeline-run-report-none" className={SUB}>
              {latest.endedAt == null ? "This execution is still open: it has no final report yet." : "No final report is recorded for this execution."}
            </p>
          ) : (
            <pre data-testid="pipeline-run-report" className="max-h-80 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-[1.5] text-foreground [overflow-wrap:anywhere]">
              {report}
            </pre>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-[7px]">
          {stepTask ? (
            <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-open-transcript" className="h-7 gap-1 px-2.5 text-[11px]" onClick={() => onOpenTask(stepTask)}>
              <FileText className="size-3" aria-hidden />
              Open full transcript
            </Button>
          ) : (
            <p className={SUB}>There is no transcript to open for this step yet.</p>
          )}
          <span className={SUB}>The transcript opens in the step's own panel. Only the final report is shown here.</span>
        </div>
      </>
    );
  }

  function checksTab() {
    const here = checks.recorded.filter((r) => r.duringStepId === tile!.id);
    const rest = checks.recorded.filter((r) => r.duringStepId !== tile!.id);
    return (
      <div data-testid="pipeline-run-checks">
        <p className={cn(SUB, "mb-2")}>{checks.note}</p>
        <h4 className="text-[13px] font-semibold leading-[1.4] text-foreground">Current head</h4>
        {checks.current ? (
          <CheckLine row={checks.current} now={now} testId="pipeline-run-check-current" />
        ) : (
          <p data-testid="pipeline-run-check-current" data-status="unavailable" className={cn(SUB, "border-b border-board-line py-2")}>
            Unavailable: no pull request is known for this task.
          </p>
        )}
        {pr?.behindBy != null && <p className={cn(SUB, "mt-1")}>{pr.behindBy > 0 ? `The branch is ${pr.behindBy} behind ${pr.baseRef ?? "its base"}.` : `The branch is up to date with ${pr.baseRef ?? "its base"}.`}</p>}
        <h4 className="mt-4 text-[13px] font-semibold leading-[1.4] text-foreground">Recorded while {tile!.name} was executing</h4>
        {here.length === 0 ? <p className={cn(SUB, "border-b border-board-line py-2")}>Nothing was recorded during this step's executions.</p> : here.map((r, i) => <CheckLine key={i} row={r} now={now} />)}
        {rest.length > 0 && (
          <>
            <h4 className="mt-4 text-[13px] font-semibold leading-[1.4] text-foreground">Other recorded events for this task</h4>
            {rest.map((r, i) => (
              <CheckLine key={i} row={r} now={now} />
            ))}
          </>
        )}
        {pr && onOpenPr && (
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-inspect-checks" className="h-7 gap-1 px-2.5 text-[11px]" onClick={onOpenPr}>
              <ExternalLink className="size-3" aria-hidden />
              Inspect current checks on PR #{pr.number}
            </Button>
          </div>
        )}
      </div>
    );
  }

  function filesTab() {
    const artifacts = latest?.handoff?.artifacts ?? [];
    return (
      <div data-testid="pipeline-run-files">
        <div className={cn(PANEL, "px-3.5 py-3")}>
          <p className="mb-1.5 font-semibold text-foreground">{latest ? `Named by execution #${latest.seq}'s handoff` : "No execution yet"}</p>
          {artifacts.length === 0 ? (
            <p className={SUB}>{latest ? "This execution's handoff names no files or links." : "This step has not run."}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {artifacts.map((a) => (
                <li key={a} className="font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
                  {a}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className={cn(SUB, "mt-2")}>A list of the files one step changed is unavailable: no diff is recorded per step. The task's changes below are the whole branch against its base.</p>
        <div className="mt-3 flex flex-wrap items-center gap-[7px]">
          {onViewChanges && (
            <Button type="button" variant="outline" size="sm" data-testid="pipeline-run-view-changes" className="h-7 gap-1 px-2.5 text-[11px]" onClick={onViewChanges}>
              <GitCompare className="size-3" aria-hidden />
              View the task's changes
            </Button>
          )}
          {pr && onOpenPr && (
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-[11px]" onClick={onOpenPr}>
              <ExternalLink className="size-3" aria-hidden />
              Open PR #{pr.number}
            </Button>
          )}
        </div>
      </div>
    );
  }
}

function SaidLines({ lines }: { lines: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, 3);
  return (
    <div className="mt-2">
      <p className={cn(SUB, "font-semibold")}>The step says</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-[1.45] text-foreground [overflow-wrap:anywhere]">
        {shown.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {lines.length > 3 && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className={cn(SUB, "mt-1 rounded underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring")}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function CheckLine({ row, now, testId }: { row: CheckRow; now: number; testId?: string }) {
  const look = CHECK_TONE[row.status];
  // Only the current head's row wears a result's colour. A recorded pass or
  // failure is history, told in words on a neutral chip; a wait a step is in
  // right now is a wait.
  const tone = row.currentHead ? look.tone : row.source === "step-wait" ? "waiting" : "queued";
  const label = row.currentHead ? look.label : row.source === "step-wait" ? "Waiting now" : row.status === "passing" ? "Passed · recorded" : "Failed · recorded";
  return (
    <div data-testid={testId ?? "pipeline-run-check-row"} data-source={row.source} data-status={row.status} data-current-head={row.currentHead} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-board-line py-2 text-[11px] leading-[1.45]">
      <StateBadge tone={tone} icon={row.currentHead || row.source === "step-wait" ? look.icon : "dashed"} label={label} />
      <span className="min-w-0 flex-1 basis-40 text-foreground [overflow-wrap:anywhere]">{row.text}</span>
      <span className="text-[color:var(--state-queued)]">
        {row.qualifier}
        {row.observedAt != null && ` · ${formatAge(now - row.observedAt) === "just now" ? "just now" : `${formatAge(now - row.observedAt)} ago`}`}
      </span>
    </div>
  );
}
