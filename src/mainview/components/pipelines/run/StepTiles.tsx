import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import type { PipelineGraph, PipelineRunState } from "../../../../shared/types.ts";
import { isFollowUpStepId } from "../../../../shared/pipeline.ts";
import type { StepTile, StepTiles as Tiles } from "@/lib/run-view";
import { STATE_ICONS } from "@/components/kanban/StateBadge";
import { PANEL, SUB } from "./parts";

export type StepsPresentation = "steps" | "graph";

/** Who a step may delegate to, and who is running for it right now. The
 *  two are different facts: a configured delegate is only available. */
export interface RunDelegate {
  stepId: string;
  available: string[];
  running: string[];
}

function Tile({ tile, selected, profile, onSelect }: { tile: StepTile; selected: boolean; profile: string | null; onSelect: (id: string) => void }) {
  const Icon = STATE_ICONS[tile.icon];
  return (
    <button
      type="button"
      data-testid="pipeline-run-step-tile"
      data-step-id={tile.id}
      data-state={tile.tone}
      data-current={tile.current ? "true" : undefined}
      aria-pressed={selected}
      aria-label={`${tile.name}: ${tile.label}${tile.current ? ", current step" : ""}. ${tile.countLabel}.`}
      onClick={() => onSelect(tile.id)}
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-board-line bg-board-card text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ring",
        selected && "outline outline-2 outline-offset-1 outline-state-waiting",
      )}
    >
      <span className="flex items-center gap-[5px] bg-state-bg px-2.5 py-[7px] text-[11px] font-semibold leading-[1.3] text-state">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{tile.label}</span>
      </span>
      <span className="block px-[11px] py-2.5">
        <strong className="mb-1 block truncate text-sm font-semibold leading-[1.4] text-foreground" title={tile.name}>
          {tile.name}
        </strong>
        <span className={cn(SUB, "block truncate")} title={profile ?? undefined}>
          {profile ?? "No agent profile"}
        </span>
        <span className={cn(SUB, "block truncate tabular-nums")}>{tile.countLabel}</span>
      </span>
    </button>
  );
}

/**
 * The pipeline's steps, as tiles or as the graph. A tile is the step's
 * state, its agent and how many executions it has; pressing one shows that
 * step below. The graph is the same canvas as before, with the routes as a
 * list and who each step may delegate to.
 */
export function StepTiles({
  tiles,
  selectedId,
  onSelect,
  profileName,
  presentation,
  onPresentation,
  graph,
  run,
  canvas,
  delegates,
}: {
  tiles: Tiles;
  selectedId: string | null;
  onSelect: (stepId: string) => void;
  profileName: (profileId: string | null) => string | null;
  presentation: StepsPresentation;
  onPresentation: (p: StepsPresentation) => void;
  graph: PipelineGraph | null;
  run: PipelineRunState | null;
  canvas: ReactNode;
  delegates: RunDelegate[];
}) {
  return (
    <section aria-labelledby="run-steps-title" className="mb-5">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
        <h3 id="run-steps-title" className="text-sm font-semibold leading-[1.4] text-foreground">
          Pipeline steps
          {tiles.parallel && <span className={cn(SUB, "ml-2 font-normal")}>several executions at once · no single current step</span>}
        </h3>
        <Segmented
          label="Pipeline presentation"
          value={presentation}
          onChange={onPresentation}
          options={[
            { value: "steps", label: "Run view", testId: "pipeline-run-presentation-steps" },
            { value: "graph", label: "Graph & routing", testId: "pipeline-run-presentation-graph" },
          ]}
        />
      </div>
      {presentation === "steps" ? (
        <>
          {tiles.tiles.length === 0 ? (
            <p className={SUB}>The pipeline's steps are unavailable: this run has no snapshot and the pipeline could not be read.</p>
          ) : (
            <div data-testid="pipeline-run-step-tiles" className="grid grid-cols-2 gap-2.5 md:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
              {tiles.tiles.map((t) => (
                <Tile key={t.id} tile={t} selected={t.id === selectedId} profile={profileName(t.profileId)} onSelect={onSelect} />
              ))}
            </div>
          )}
          {tiles.followUps.length > 0 && (
            <div className="mt-3">
              <p className={cn(SUB, "mb-1.5")}>Follow-up steps · run after the pipeline, not part of its graph</p>
              <div data-testid="pipeline-run-followup-tiles" className="grid grid-cols-2 gap-2.5 md:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
                {tiles.followUps.map((t) => (
                  <Tile key={t.id} tile={t} selected={t.id === selectedId} profile={profileName(t.profileId)} onSelect={onSelect} />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <RunGraph graph={graph} run={run} canvas={canvas} delegates={delegates} />
      )}
    </section>
  );
}

function RunGraph({ graph, run, canvas, delegates }: { graph: PipelineGraph | null; run: PipelineRunState | null; canvas: ReactNode; delegates: RunDelegate[] }) {
  const name = (id: string) => graph?.steps.find((s) => s.id === id)?.name ?? id;
  const edges = (graph?.edges ?? []).filter((e) => !isFollowUpStepId(e.from) && !isFollowUpStepId(e.to));
  // How often the run took a route: records of `from` that handed to `to`.
  const taken = (from: string, to: string) => (run?.history ?? []).filter((r) => r.stepId === from && r.nextStepIds.includes(to)).length;
  const lines = delegates.filter((d) => d.available.length > 0 || d.running.length > 0);
  return (
    <div data-testid="pipeline-run-graph" className={cn(PANEL, "p-4")}>
      <div className="h-[420px] overflow-hidden rounded-md border border-board-line">{canvas}</div>
      <h4 className="mt-4 text-[13px] font-semibold leading-[1.4] text-foreground">Routing rules</h4>
      {edges.length === 0 ? (
        <p className={cn(SUB, "mt-1")}>This pipeline has no routes between steps.</p>
      ) : (
        <ul data-testid="pipeline-run-routes" className="mt-2 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
          {edges.map((e) => {
            const n = taken(e.from, e.to);
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-x-[5px] rounded-[5px] bg-state-neutral px-2 py-[7px] text-[color:var(--state-queued)]">
                <strong className="font-medium text-foreground">{name(e.from)}</strong>
                <ArrowRight className="size-3 shrink-0" aria-hidden />
                <span className="text-foreground">{name(e.to)}</span>
                {e.label && <span>· {e.label}</span>}
                <span className="ml-auto tabular-nums">{n === 0 ? "not taken" : n === 1 ? "taken once" : `taken ${n} times`}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div data-testid="pipeline-run-delegation" className="mt-3">
        {lines.length === 0 ? (
          <p className={SUB}>No step of this pipeline may delegate to a subagent.</p>
        ) : (
          <ul className={cn(SUB, "flex flex-col gap-0.5")}>
            {lines.map((d) => (
              <li key={d.stepId}>
                <span className="text-foreground">{name(d.stepId)}</span>
                {d.available.length > 0 && <> · available: {d.available.join(", ")}</>}
                {d.running.length > 0 && (
                  <>
                    {" "}
                    · <span className="font-semibold text-state-working">running: {d.running.join(", ")}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className={cn(SUB, "mt-1")}>Available means a step may delegate to it. It does not mean a subagent is running.</p>
      </div>
    </div>
  );
}
