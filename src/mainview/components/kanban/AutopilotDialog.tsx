import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Rocket, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, type AutopilotConfigDto, type AutopilotStateDto } from "@/lib/api";
import type { GitHubRepoMilestone, Project, Task } from "../../../shared/types.ts";
import { holdsAutopilotSlot, waitingOnQuota } from "../../../shared/autopilot.ts";

const TITLE_ID = "autopilot-dialog-title";
const DEFAULT_THREAD = "01a107c4-1e3c-7890-baad-752584bc2688";

const PHASE: Record<AutopilotStateDto["phase"], string> = {
  idle: "Not started",
  running: "Working the milestone",
  auditing: "Deep audit in progress",
  done: "Milestone done — audit came back clean",
};
const ROADMAP_PHASE: Record<AutopilotStateDto["phase"], string> = {
  idle: "Waiting — nothing can start",
  running: "Working the roadmap",
  auditing: "Working the roadmap",
  done: "Roadmap done — every step is complete or declined",
};

/** Milestone Autopilot (src/bun/autopilot.ts): pick a milestone and the
 *  milestone-manager Codex thread; Agetor works it to done, then audits.
 *  Or pick Roadmap and a tracker issue: its numbered step table gives the
 *  order and no thread is involved (src/shared/roadmap.ts). */
export function AutopilotDialog({ open, projects, tasks, onClose }: { open: boolean; projects: Project[]; tasks: Task[]; onClose: () => void }) {
  const [config, setConfig] = useState<AutopilotConfigDto | null>(null);
  const [state, setState] = useState<AutopilotStateDto | null>(null);
  const [milestones, setMilestones] = useState<GitHubRepoMilestone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback((refresh = false) => {
    void api
      .getAutopilot()
      .then((r) => {
        const next = { ...r.config, threadId: r.config.threadId || DEFAULT_THREAD, project: r.config.project || projects[0]?.path || "" };
        // A periodic refresh mustn't undo what's being set up while paused.
        setConfig((cur) => (refresh && cur && !cur.enabled && !r.config.enabled ? cur : next));
        setState(r.state);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [projects]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useEffect(() => {
    if (!open || !config?.project) return;
    void api
      .listGitHubMilestones({ path: config.project })
      .then((r) => setMilestones(r.milestones.filter((m) => m.state === "open")))
      .catch(() => setMilestones([]));
  }, [open, config?.project]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [open, load]);

  // The board's lean task list leaves archived rows out, but an autopilot
  // card that was finished and archived still counts toward "done" — read
  // each such card once (archived rows are frozen; an unarchived one is back
  // in `tasks`, which wins).
  const [archivedCards, setArchivedCards] = useState<Record<string, Task>>({});
  const fetchedCardIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!open || !state) return;
    const known = new Set(tasks.map((t) => t.id));
    for (const id of state.cards) {
      if (known.has(id) || fetchedCardIdsRef.current.has(id)) continue;
      fetchedCardIdsRef.current.add(id);
      void api.getTask(id)
        .then((t) => setArchivedCards((m) => ({ ...m, [id]: t })))
        .catch(() => { /* deleted — not counted, as before */ });
    }
  }, [open, state, tasks]);

  if (!open || !config) return null;

  const save = async (patch: Partial<AutopilotConfigDto> & { restart?: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.setAutopilot({ ...config, ...patch });
      setConfig(r.config);
      setState(r.state);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const mine = (state?.cards ?? []).map((id) => tasks.find((t) => t.id === id) ?? archivedCards[id]).filter((t): t is Task => !!t);
  // Slots are held only by cards that are progressing (src/shared/autopilot.ts):
  // not blocked, not waiting on you, not waiting for a usage limit to reset.
  const inFlight = mine.filter((t) => holdsAutopilotSlot(t));
  const quotaWaiting = mine.filter((t) => t.archivedAt == null && waitingOnQuota(t.pipelineRun)).length;
  const done = mine.filter((t) => t.column === "done").length;
  const roadmapMode = !!config.roadmap;
  const ready = !!config.project && (roadmapMode ? config.roadmap!.issue > 0 : !!config.threadId && !!config.milestone);
  // The status of the roadmap that's configured now, not of an earlier one.
  const roadmap = roadmapMode && state?.roadmap?.issue === config.roadmap!.issue ? state.roadmap : null;
  const phases = roadmapMode ? ROADMAP_PHASE : PHASE;

  return createPortal(
    <Dialog open onClose={onClose} labelledBy={TITLE_ID} className="flex w-full max-w-xl flex-col p-0">
      <div data-testid="autopilot-dialog" className="flex flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
            <Rocket className="size-4 shrink-0 text-muted-foreground" />
            Milestone Autopilot
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex flex-col gap-3 p-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Project</span>
            <select
              value={config.project}
              disabled={config.enabled}
              onChange={(e) => setConfig({ ...config, project: e.target.value, milestone: null })}
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Work from</span>
            <div className="flex gap-1" role="group" aria-label="Work from" data-testid="autopilot-mode">
              <Button
                type="button"
                size="sm"
                variant={roadmapMode ? "outline" : "secondary"}
                aria-pressed={!roadmapMode}
                disabled={config.enabled}
                onClick={() => setConfig({ ...config, roadmap: null })}
                className="h-7 px-2 text-xs"
              >
                Milestone
              </Button>
              <Button
                type="button"
                size="sm"
                variant={roadmapMode ? "secondary" : "outline"}
                aria-pressed={roadmapMode}
                disabled={config.enabled}
                onClick={() => setConfig({ ...config, roadmap: config.roadmap ?? { issue: 0 } })}
                className="h-7 px-2 text-xs"
              >
                Roadmap
              </Button>
            </div>
          </div>
          {!roadmapMode && (
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Milestone</span>
            <select
              value={config.milestone?.number ?? ""}
              disabled={config.enabled}
              onChange={(e) => {
                const m = milestones.find((x) => x.number === Number(e.target.value));
                setConfig({ ...config, milestone: m ? { number: m.number, title: m.title } : null });
              }}
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              <option value="">Choose a milestone…</option>
              {milestones.map((m) => (
                <option key={m.number} value={m.number}>
                  {m.title} — {m.openIssues} open
                </option>
              ))}
            </select>
          </label>
          )}
          <div className="flex gap-3">
            {roadmapMode ? (
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted-foreground">Tracker issue (the one with the “Numbered completion order” table)</span>
                <Input
                  type="number"
                  min={1}
                  data-testid="autopilot-roadmap-issue"
                  value={config.roadmap!.issue || ""}
                  disabled={config.enabled}
                  placeholder="Issue number"
                  onChange={(e) => setConfig({ ...config, roadmap: { issue: Math.max(0, Math.floor(Number(e.target.value)) || 0) } })}
                  className="h-8"
                />
              </label>
            ) : (
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted-foreground">Codex thread (milestone manager)</span>
                <Input
                  value={config.threadId}
                  disabled={config.enabled}
                  onChange={(e) => setConfig({ ...config, threadId: e.target.value.replace(/^codex:\/\/threads\//, "").trim() })}
                  className="h-8 font-mono text-[11px]"
                />
              </label>
            )}
            <label className="flex w-24 flex-col gap-1">
              <span className="text-muted-foreground">In flight</span>
              <Input
                type="number"
                min={1}
                max={10}
                value={config.maxInFlight}
                onChange={(e) => setConfig({ ...config, maxInFlight: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                className="h-8"
              />
            </label>
          </div>

          {state && (
            <div className="rounded-md border border-border/60 bg-muted/30 p-2" data-testid="autopilot-status">
              <div className="font-medium">{config.enabled ? phases[state.phase] : state.phase === "done" ? phases.done : "Paused"}</div>
              {roadmap && (
                <div className="mt-1" data-testid="autopilot-roadmap-status">
                  <div>
                    {roadmap.counts.complete} of {roadmap.counts.total} steps complete · {roadmap.counts.inFlight} in flight · {roadmap.counts.ready} ready ·{" "}
                    {roadmap.counts.waiting} waiting
                    {roadmap.counts.declined > 0 && ` · ${roadmap.counts.declined} declined`}
                  </div>
                  {roadmap.idleReason && <div className="mt-1 text-warning">{roadmap.idleReason}</div>}
                  {roadmap.humanReady.length > 0 && (
                    <div className="mt-1">
                      <span className="text-muted-foreground">Yours to do: </span>
                      {roadmap.humanReady.map((s) => `${s.step} · #${s.issue} ${s.title}`).join("; ")}
                    </div>
                  )}
                  {roadmap.needsUser.map((s) => (
                    <div key={s.issue} className="mt-1 text-warning">
                      Step {s.step} · #{s.issue}: {s.reason}
                    </div>
                  ))}
                  {roadmap.nextWaiting.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground">Next waiting steps</summary>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {roadmap.nextWaiting.map((s) => (
                          <li key={s.step}>
                            {s.step} · #{s.issue} {s.title}
                            <span className="text-muted-foreground"> — {s.reason ?? `waits on ${s.waitingOn.join(", ")}`}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {roadmap.problems.length > 0 && (
                    <details className="mt-1" open>
                      <summary className="cursor-pointer text-warning">
                        {roadmap.problems.length} roadmap problem{roadmap.problems.length === 1 ? "" : "s"}
                      </summary>
                      <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-auto">
                        {roadmap.problems.map((p, i) => (
                          <li key={i}>{p.message}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
              <div className="mt-1 text-muted-foreground">
                {inFlight.length} card{inFlight.length === 1 ? "" : "s"} in flight · {done} done · {state.held.length} waiting for your sign-off
                {quotaWaiting > 0 && ` · ${quotaWaiting} waiting for a usage limit to reset`}
                {state.audits > 0 && ` · ${state.audits} audit${state.audits === 1 ? "" : "s"}`}
              </div>
              {state.lastError && (
                <div className={`mt-1 ${(state.limitedUntil ?? 0) > Date.now() ? "text-muted-foreground" : "text-warning"}`}>{state.lastError}</div>
              )}
              {!roadmapMode && state.lastAnswer && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">
                    Thread's last answer ({state.lastAnswer.kind === "audit" ? "audit" : "next issues"},{" "}
                    {new Date(state.lastAnswer.at).toLocaleTimeString()})
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">{state.lastAnswer.text}</pre>
                </details>
              )}
            </div>
          )}
          {roadmapMode ? (
          <p className="text-muted-foreground">
            A step starts when its issue is open and every predecessor step's issue is closed as completed; Agetor keeps
            {" "}{config.maxInFlight} cards building and signs finished PRs off for merging (billing, auth, migration and schema changes wait for you).
            [Human] steps are never given to an agent — you're notified when one is ready. An issue closed as not planned is a
            no-go: it unlocks nothing. No Codex thread is involved.
          </p>
          ) : (
          <p className="text-muted-foreground">
            Whenever a card finishes building, the thread picks the next issue(s) and clarifies each one's scope; Agetor keeps
            {" "}{config.maxInFlight} cards building and signs finished PRs off for merging (billing, auth, migration and schema changes wait for you). When the
            milestone is empty it runs a deep audit; anything it files restarts the loop. Don't type into the thread in Codex
            while Autopilot is on.
          </p>
          )}
          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border/60 p-3">
          {config.enabled ? (
            <Button size="sm" variant="outline" onClick={() => void save({ enabled: false })} disabled={saving}>
              Pause
            </Button>
          ) : (
            <>
              {state?.phase === "done" && (
                <Button size="sm" variant="outline" onClick={() => void save({ enabled: true, restart: true })} disabled={saving || !ready}>
                  Run again
                </Button>
              )}
              <Button size="sm" onClick={() => void save({ enabled: true })} disabled={saving || !ready}>
                Start
              </Button>
            </>
          )}
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
