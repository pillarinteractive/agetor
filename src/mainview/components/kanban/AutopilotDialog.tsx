import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Rocket, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, type AutopilotConfigDto, type AutopilotStateDto } from "@/lib/api";
import type { GitHubRepoMilestone, Project, Task } from "../../../shared/types.ts";
import { autopilotMode, holdsAutopilotSlot, waitingOnQuota } from "../../../shared/autopilot.ts";
import { currentRoadmapStatus, milestoneName, nextMilestoneText, scopeMilestones } from "../../../shared/roadmap.ts";

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
const SCOPED_PHASE: Record<AutopilotStateDto["phase"], string> = {
  idle: "Waiting — nothing in this milestone can start",
  running: "Working the milestone in the tracker's order",
  auditing: "Working the milestone in the tracker's order",
  done: "Milestone done — every step in it is complete or declined",
};

/** Autopilot (src/bun/autopilot.ts): pick a milestone — the scope — and a
 *  tracker issue, whose numbered step table gives the order
 *  (src/shared/roadmap.ts): every open step of the milestone gets a card in
 *  the Backlog, started when its predecessors are complete. No milestone =
 *  the whole roadmap. With no tracker, the milestone-manager Codex thread
 *  picks the order instead, and audits the milestone when it empties. */
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
        // No tracker configured: offer the default one (the last one saved).
        // Clearing the field before Start turns tracker ordering off.
        const roadmap = r.config.roadmap ?? (!r.config.enabled && r.defaultTracker ? { issue: r.defaultTracker } : null);
        const next = { ...r.config, roadmap, threadId: r.config.threadId || DEFAULT_THREAD, project: r.config.project || projects[0]?.path || "" };
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
      // While Autopilot is on, the scope and the tracker aren't this dialog's
      // to send: a pass may have changed the scope since it was loaded (a
      // finished milestone dropped, the next one added).
      const r = await api.setAutopilot(config.enabled ? { maxInFlight: config.maxInFlight, autoContinue: config.autoContinue ?? false, ...patch } : { ...config, ...patch });
      setConfig({ ...r.config, threadId: r.config.threadId || DEFAULT_THREAD });
      setState(r.state);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Accept the next milestone from here: the same answer as the board's popup.
  const continueInto = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.continueRoadmap("accept");
      setConfig({ ...r.config, threadId: r.config.threadId || DEFAULT_THREAD });
      setState(r.state);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const scope = scopeMilestones(config);

  const mine = (state?.cards ?? []).map((id) => tasks.find((t) => t.id === id) ?? archivedCards[id]).filter((t): t is Task => !!t);
  // Slots are held only by cards that are progressing (src/shared/autopilot.ts):
  // not blocked, not waiting on you, not waiting for a usage limit to reset.
  const inFlight = mine.filter((t) => holdsAutopilotSlot(t));
  const quotaWaiting = mine.filter((t) => t.archivedAt == null && waitingOnQuota(t.pipelineRun)).length;
  const done = mine.filter((t) => t.column === "done").length;
  const mode = autopilotMode(config);
  const roadmapMode = mode === "tracker" || mode === "tracker-milestone";
  const ready = !!config.project && (roadmapMode || (!!config.threadId && !!config.milestone));
  // The status of the run that's configured now, not of another tracker's or
  // another milestone's.
  const roadmap = currentRoadmapStatus(config, state?.roadmap);
  const phases = mode === "tracker-milestone" ? SCOPED_PHASE : roadmapMode ? ROADMAP_PHASE : PHASE;

  return createPortal(
    <Dialog open onClose={onClose} labelledBy={TITLE_ID} className="flex w-full max-w-xl flex-col p-0">
      <div data-testid="autopilot-dialog" className="flex flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
            <Rocket className="size-4 shrink-0 text-muted-foreground" />
            Autopilot
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
              onChange={(e) => setConfig({ ...config, project: e.target.value, milestone: null, milestones: [] })}
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Milestone</span>
            <select
              data-testid="autopilot-milestone"
              value={config.milestone?.number ?? ""}
              disabled={config.enabled}
              onChange={(e) => {
                const m = milestones.find((x) => x.number === Number(e.target.value));
                const one = m ? { number: m.number, title: m.title } : null;
                setConfig({ ...config, milestone: one, milestones: one ? [one] : [] });
              }}
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              <option value="">{roadmapMode ? "All milestones — the whole roadmap" : "Choose a milestone…"}</option>
              {/* The configured milestone stays listed once GitHub closes it. */}
              {config.milestone && !milestones.some((m) => m.number === config.milestone!.number) && (
                <option value={config.milestone.number}>{config.milestone.title}</option>
              )}
              {milestones.map((m) => (
                <option key={m.number} value={m.number}>
                  {m.title} — {m.openIssues} open
                </option>
              ))}
            </select>
            {roadmapMode && scope.length > 1 && (
              <span className="text-muted-foreground" data-testid="autopilot-scope-list">
                In scope: {scope.map((m) => m.title).join(" + ")} — the run continued into {scope.length === 2 ? "the second" : "the later ones"}. Choosing a
                milestone here (while paused) sets the scope back to that one.
              </span>
            )}
          </label>
          {mode === "tracker-milestone" && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-testid="autopilot-auto-continue"
                className="mt-0.5"
                checked={config.autoContinue ?? false}
                disabled={saving}
                onChange={(e) => {
                  // Takes effect at once on a running Autopilot; with Start otherwise.
                  if (config.enabled) void save({ autoContinue: e.target.checked });
                  else setConfig({ ...config, autoContinue: e.target.checked });
                }}
              />
              <span>
                Always continue: when this milestone can no longer fill its slots, start the next one without asking
                <span className="text-muted-foreground"> (off: the board asks first)</span>
              </span>
            </label>
          )}
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-muted-foreground">Tracker issue (its “completion order” table gives the order)</span>
              <Input
                type="number"
                min={1}
                data-testid="autopilot-roadmap-issue"
                value={config.roadmap?.issue || ""}
                disabled={config.enabled}
                placeholder="None — the Codex thread picks"
                onChange={(e) => {
                  const issue = Math.max(0, Math.floor(Number(e.target.value)) || 0);
                  setConfig({ ...config, roadmap: issue > 0 ? { issue } : null });
                }}
                className="h-8"
              />
            </label>
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
          {!roadmapMode && (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Codex thread (milestone manager) — used when there is no tracker</span>
              <Input
                data-testid="autopilot-thread"
                value={config.threadId}
                disabled={config.enabled}
                onChange={(e) => setConfig({ ...config, threadId: e.target.value.replace(/^codex:\/\/threads\//, "").trim() })}
                className="h-8 font-mono text-[11px]"
              />
            </label>
          )}

          {state && (
            <div className="rounded-md border border-border/60 bg-muted/30 p-2" data-testid="autopilot-status">
              <div className="font-medium">{config.enabled ? phases[state.phase] : state.phase === "done" ? phases.done : "Paused"}</div>
              {roadmap && (
                <div className="mt-1" data-testid="autopilot-roadmap-status">
                  <div>
                    {roadmap.counts.complete} of {roadmap.counts.total} steps complete
                    {roadmap.scope && ` (of ${roadmap.scope.roadmapTotal} in roadmap #${roadmap.issue})`} · {roadmap.counts.inFlight} in flight ·{" "}
                    {roadmap.counts.ready} ready · {roadmap.counts.waiting} waiting
                    {roadmap.counts.declined > 0 && ` · ${roadmap.counts.declined} declined`}
                    {(roadmap.counts.backlog ?? 0) > 0 && ` · ${roadmap.counts.backlog} card${roadmap.counts.backlog === 1 ? "" : "s"} in the backlog`}
                  </div>
                  {roadmap.idleReason && <div className="mt-1 text-warning">{roadmap.idleReason}</div>}
                  {(roadmap.continued ?? []).map((k) => (
                    <div key={`${k.number}:${k.at}`} className="mt-1 text-muted-foreground">
                      Continued into {k.title} at {new Date(k.at).toLocaleTimeString()} ({k.by === "auto" ? "always continue" : "you accepted"})
                    </div>
                  ))}
                  {roadmap.nextMilestone && (
                    <div className="mt-1" data-testid="autopilot-next-milestone">
                      <div className={roadmap.nextMilestone.reason && roadmap.nextMilestone.dismissedAt == null ? "text-warning" : undefined}>
                        {nextMilestoneText(roadmap.nextMilestone).question}
                      </div>
                      <div className="text-muted-foreground">
                        {nextMilestoneText(roadmap.nextMilestone).detail}
                        {roadmap.nextMilestone.dismissedAt != null && ` · you said not now at ${new Date(roadmap.nextMilestone.dismissedAt).toLocaleTimeString()}`}
                      </div>
                      {config.enabled && !config.autoContinue && (
                        <Button size="sm" variant="outline" className="mt-1 h-6 px-2 text-[11px]" disabled={saving} data-testid="autopilot-continue" onClick={() => void continueInto()}>
                          Start {milestoneName(roadmap.nextMilestone)} as well
                        </Button>
                      )}
                    </div>
                  )}
                  {roadmap.humanReady.length > 0 && (
                    <div className="mt-1">
                      <span className="text-muted-foreground">Yours to do: </span>
                      {roadmap.humanReady.map((s) => `${s.step} · #${s.issue} ${s.title}`).join("; ")}
                    </div>
                  )}
                  {roadmap.needsUser.map((s) => (
                    <div key={`${s.kind ?? "stuck"}:${s.issue}`} className="mt-1 text-warning">
                      Step {s.step} · #{s.issue}: {s.reason}
                      {/* The PR's own words, or the files holding the card: plain text. */}
                      {s.detail && <div className="break-words text-muted-foreground">{s.kind === "held" ? `Sensitive files: ${s.detail}` : s.detail}</div>}
                    </div>
                  ))}
                  {(roadmap.blockedOutside ?? []).length > 0 && (
                    <div className="mt-1" data-testid="autopilot-blocked-outside">
                      <span className="text-muted-foreground">Waits on other milestones: </span>
                      {(roadmap.blockedOutside ?? []).map((s) => `${s.step} · #${s.issue} (${s.milestone || "no milestone"})`).join("; ")}
                    </div>
                  )}
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
          {mode === "tracker-milestone" && (
            <p className="text-muted-foreground">
              Every open step whose issue is in this milestone gets a card in the Backlog. Steps of other milestones still
              gate the order but are never started by this run; cards another milestone left in the Backlog stay there,
              untouched. When fewer steps are left to start than fit in flight, the next milestone is offered: accepting adds
              it to the scope, and what is left here keeps running.
            </p>
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
