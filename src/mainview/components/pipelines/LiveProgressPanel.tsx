import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { countsSummary, elapsedSince, progressFraction, useTaskProgress } from "@/lib/progress";
import type { TaskProgress } from "../../../shared/types.ts";

/** The run view's Live panel: for each progress watcher reporting on this
 *  card (src/bun/progress-watch.ts) — the phase stepper, test counts, the
 *  test running now, failures so far, and where the evidence is. */
export function LiveProgressPanel({ taskId }: { taskId: string }) {
  const list = useTaskProgress(taskId);
  // Re-render every second so elapsed times tick between reports.
  const [now, setNow] = useState(() => Date.now());
  const anyActive = list.some((p) => p.active);
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);
  if (list.length === 0) return null;
  return (
    <div data-testid="pipeline-run-live" className="mb-3 flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{anyActive ? "Live" : "Last run"}</p>
      {list.map((p) => (
        <ProgressBlock key={`${p.project}:${p.label}`} p={p} now={now} />
      ))}
    </div>
  );
}

function ProgressBlock({ p, now }: { p: TaskProgress; now: number }) {
  const counts = p.active ? p.counts : (p.last?.counts ?? p.counts);
  const fraction = progressFraction(counts);
  const bad = counts ? counts.failed + counts.errors : 0;
  const phases = p.phases?.length ? p.phases : null;
  const title = p.runLabel ?? p.label;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{title}</span>
        <span
          className={cn(
            "shrink-0 text-[11px]",
            p.active ? "text-info" : p.last?.result === "passed" ? "text-success" : p.last?.result === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {p.active
            ? `${p.phase} · ${elapsedSince(p.phaseStartedAt, now)}`
            : p.last?.result ?? "idle"}
        </span>
      </div>
      {phases && (
        <div className="flex gap-1" aria-label="Phases">
          {phases.map((ph) => {
            const idx = phases.indexOf(p.phase);
            const i = phases.indexOf(ph);
            const state = !p.active ? "idle" : i < idx ? "done" : i === idx ? "now" : "todo";
            return (
              <span
                key={ph}
                className={cn(
                  "flex-1 rounded px-1.5 py-0.5 text-center text-[10px]",
                  state === "done" && "bg-success/15 text-success",
                  state === "now" && "bg-info/15 font-medium text-info",
                  (state === "todo" || state === "idle") && "bg-muted text-muted-foreground",
                )}
              >
                {ph}
              </span>
            );
          })}
        </div>
      )}
      {p.targets?.length ? <p className="text-[11px] text-muted-foreground">Targets: {p.targets.join(", ")}</p> : null}
      {counts && (
        <div className="flex flex-col gap-1">
          {fraction != null && (
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div
                className={cn("h-full", bad ? "bg-destructive" : "bg-success")}
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
          )}
          <p className="text-[11px]">
            {countsSummary(counts)} — {counts.passed} passed
            {counts.failed ? `, ${counts.failed} failed` : ""}
            {counts.errors ? `, ${counts.errors} errors` : ""}
            {counts.skipped ? `, ${counts.skipped} skipped` : ""}
          </p>
        </div>
      )}
      {p.active && p.current && (
        <p className="truncate font-mono text-[10px] text-muted-foreground" title={p.current}>
          ▸ {p.current}
        </p>
      )}
      {p.failures.length > 0 && (
        <details open={p.failures.length <= 3}>
          <summary className="cursor-pointer text-[11px] text-destructive">
            {p.failures.length} failure{p.failures.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {p.failures.map((f) => (
              <li key={f.name} className="flex flex-col">
                <span className="break-all font-mono text-[10px]">{f.name}</span>
                {f.message && <span className="text-[10px] text-muted-foreground">{f.message}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {p.artifacts.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {p.artifacts.map((a) => (
            <span key={a.path} className="truncate font-mono text-[10px] text-muted-foreground" title={a.path}>
              {a.label}: {a.path}
            </span>
          ))}
        </div>
      )}
      {p.active && p.startedAt && (
        <p className="text-[10px] text-muted-foreground">Run started {elapsedSince(p.startedAt, now)} ago</p>
      )}
    </div>
  );
}
