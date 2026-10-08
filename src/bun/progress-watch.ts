/**
 * Progress watchers: while a card is running, periodically run a
 * project-provided command in the card's checkout that reports what a
 * long-running tool is doing there — which phase a VM lab suite is in, how
 * many tests have passed or failed so far, which test is running, where the
 * evidence is. The board shows a live line on the card and a Live panel in
 * the run view, and the card's timeline gets the milestones.
 *
 * Configured with the `progress_watchers` preference — a JSON array of
 * {@link ProgressWatcherConfig}. The command only reads local state; it must
 * be cheap, since it runs every few seconds per running card.
 */
import type {
  ProgressCounts,
  ProgressWatcherConfig,
  Task,
  TaskProgress,
  TaskProgressReport,
} from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { publishGlobalEvent } from "./orchestrator.ts";
import { recordActivity } from "./activity.ts";

export const PROGRESS_WATCHERS_PREF = "progress_watchers";
const DEFAULT_INTERVAL_SEC = 10;
const MIN_INTERVAL_SEC = 3;
// A checkout whose command fails (a branch older than the tool's progress
// command, say) is asked again rarely rather than every few seconds.
const ERROR_BACKOFF_MS = 120_000;
const TICK_MS = 3_000;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_FAILURES = 20;
const MAX_ARTIFACTS = 10;

/** Parse the preference value, dropping malformed entries. */
export function parseProgressWatchers(raw: string | null | undefined): ProgressWatcherConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProgressWatcherConfig[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { project, label, command, intervalSec } = item as Record<string, unknown>;
    if (typeof project !== "string" || !project) continue;
    if (typeof label !== "string" || !label) continue;
    if (typeof command !== "string" || !command) continue;
    out.push({
      project,
      label,
      command,
      intervalSec:
        typeof intervalSec === "number" && Number.isFinite(intervalSec)
          ? Math.max(MIN_INTERVAL_SEC, intervalSec)
          : DEFAULT_INTERVAL_SEC,
    });
  }
  return out;
}

const str = (x: unknown) => (typeof x === "string" && x ? x : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function parseCounts(v: unknown): ProgressCounts | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    passed: num(o.passed) ?? 0,
    failed: num(o.failed) ?? 0,
    skipped: num(o.skipped) ?? 0,
    errors: num(o.errors) ?? 0,
    total: num(o.total),
  };
}

export type ProgressProbe = { ok: true; report: TaskProgressReport } | { ok: false; error: string };

/** Read the command's last non-empty stdout line as a `progress/v1` object. */
export function parseProgressOutput(stdout: string): ProgressProbe {
  const line = stdout.trim().split("\n").filter((l) => l.trim()).pop();
  if (!line) return { ok: false, error: "no output" };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, error: `not JSON: ${line.slice(0, 120)}` };
  }
  if (!v || typeof v !== "object" || typeof (v as { active?: unknown }).active !== "boolean") {
    return { ok: false, error: 'expected {"active": true|false, "phase": ...}' };
  }
  const o = v as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : null);
  const failures = Array.isArray(o.failures)
    ? o.failures
        .flatMap((f) => {
          const r = f as Record<string, unknown> | null;
          const name = str(r?.name);
          return name ? [{ name, message: str(r?.message) }] : [];
        })
        .slice(0, MAX_FAILURES)
    : [];
  const artifacts = Array.isArray(o.artifacts)
    ? o.artifacts
        .flatMap((a) => {
          const r = a as Record<string, unknown> | null;
          const label = str(r?.label);
          const p = str(r?.path);
          return label && p ? [{ label, path: p }] : [];
        })
        .slice(0, MAX_ARTIFACTS)
    : [];
  const lastRaw = o.last && typeof o.last === "object" ? (o.last as Record<string, unknown>) : null;
  const result = lastRaw?.result === "passed" || lastRaw?.result === "failed" ? lastRaw.result : null;
  return {
    ok: true,
    report: {
      active: o.active as boolean,
      phase: str(o.phase) ?? (o.active ? "running" : "idle"),
      phases: strings(o.phases),
      runLabel: str(o.label),
      targets: strings(o.targets),
      startedAt: str(o.startedAt),
      phaseStartedAt: str(o.phaseStartedAt),
      counts: parseCounts(o.counts),
      current: str(o.current),
      failures,
      artifacts,
      last: lastRaw ? { finishedAt: str(lastRaw.finishedAt), result, counts: parseCounts(lastRaw.counts) } : null,
    },
  };
}

/** Cards worth probing for a watcher: live top-level cards of its project
 *  that are running and have a checkout. */
export function probeTargets(w: ProgressWatcherConfig, list: Task[]): { task: Task; checkout: string }[] {
  const trim = (p: string) => p.replace(/\/+$/, "");
  return list
    .filter((t) => t.archivedAt == null && !t.pipelineParentId && t.column === "running")
    .filter((t) => trim(t.workdir) === trim(w.project))
    .flatMap((t) => {
      const checkout = t.worktreePath ?? (t.isolation === "none" ? t.workdir : null);
      return checkout ? [{ task: t, checkout }] : [];
    });
}

export function countsText(c: ProgressCounts | null): string {
  if (!c) return "";
  const parts = [`${c.passed} passed`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.errors) parts.push(`${c.errors} errors`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.join(", ");
}

/** Timeline entries for the change from `prev` to `next`: a phase starting,
 *  and a run finishing with its result. */
export function progressMilestones(
  label: string,
  prev: TaskProgressReport | undefined,
  next: TaskProgressReport,
): { text: string; tone: "info" | "success" | "danger" | "muted" }[] {
  const out: { text: string; tone: "info" | "success" | "danger" | "muted" }[] = [];
  const name = next.runLabel ?? label;
  if (next.active && (!prev?.active || prev.phase !== next.phase)) {
    const targets = next.phase === "up" && next.targets?.length ? ` (${next.targets.join(", ")})` : "";
    out.push({ text: `${name}: ${next.phase}${targets}`, tone: "info" });
  }
  // `prev` is known: never replay an old result the first time a card is seen.
  const finished = next.last?.finishedAt;
  if (prev && finished && finished !== prev.last?.finishedAt && next.last?.result) {
    const counts = countsText(next.last.counts);
    out.push({
      text: `${name} ${next.last.result}${counts ? ` — ${counts}` : ""}`,
      tone: next.last.result === "passed" ? "success" : "danger",
    });
  }
  return out;
}

const progress = new Map<string, TaskProgress>();
const lastProbeAt = new Map<string, number>();
const backoffUntil = new Map<string, number>();
const inFlight = new Set<string>();
let loop: ReturnType<typeof setInterval> | null = null;

const keyOf = (taskId: string, w: Pick<ProgressWatcherConfig, "project" | "label">) =>
  `${taskId}\0${w.project}\0${w.label}`;

/** Every card's latest progress. A card keeps its last report after it
 *  leaves Running (so the result stays visible) until it's archived, done,
 *  or its watcher is removed. */
export function listProgress(): TaskProgress[] {
  return [...progress.values()];
}

function publish(): void {
  publishGlobalEvent({ kind: "progress", progress: listProgress(), ts: Date.now() });
}

async function runProbe(w: ProgressWatcherConfig, checkout: string): Promise<ProgressProbe> {
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", w.command], {
      cwd: checkout,
      // The live env, not Bun's launch-time default (see lease-watch.ts).
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) {
      const detail = stderr.trim().split("\n").pop() ?? "";
      return { ok: false, error: `exited ${code}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
    }
    return parseProgressOutput(stdout);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function sameReport(a: TaskProgress | undefined, b: TaskProgress): boolean {
  if (!a) return false;
  const { checkedAt: _a, ...ra } = a;
  const { checkedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

async function probe(w: ProgressWatcherConfig, task: Task, checkout: string): Promise<void> {
  const key = keyOf(task.id, w);
  inFlight.add(key);
  try {
    const result = await runProbe(w, checkout);
    if (!parseProgressWatchers(preferences.get(PROGRESS_WATCHERS_PREF)).some((c) => keyOf(task.id, c) === key)) return;
    if (!result.ok) {
      // Keep the last good report; just stop asking so often.
      backoffUntil.set(key, Date.now() + ERROR_BACKOFF_MS);
      return;
    }
    backoffUntil.delete(key);
    const prev = progress.get(key);
    // A checkout that has never run the tool has nothing to show.
    if (!prev && !result.report.active && !result.report.last) return;
    const next: TaskProgress = {
      ...result.report,
      taskId: task.id,
      project: w.project,
      label: w.label,
      checkout,
      checkedAt: Date.now(),
    };
    for (const m of progressMilestones(w.label, prev, next)) {
      recordActivity(task.id, { kind: "progress", text: m.text, tone: m.tone });
    }
    progress.set(key, next);
    if (!sameReport(prev, next)) publish();
  } finally {
    inFlight.delete(key);
  }
}

/** One scheduler pass: drop progress for cards that are gone, archived or
 *  done, or whose watcher was removed; probe the due running cards.
 *  Exported for tests. */
export function progressWatchTick(now = Date.now()): Promise<void>[] {
  const watchers = parseProgressWatchers(preferences.get(PROGRESS_WATCHERS_PREF));
  const list = tasks.listLive();
  const byId = new Map(list.map((t) => [t.id, t]));
  const wanted = new Set(watchers.flatMap((w) => list.map((t) => keyOf(t.id, w))));
  let removed = false;
  for (const [key, p] of [...progress.entries()]) {
    const t = byId.get(p.taskId);
    if (!wanted.has(key) || !t || t.archivedAt != null || t.column === "done") {
      progress.delete(key);
      lastProbeAt.delete(key);
      backoffUntil.delete(key);
      removed = true;
    }
  }
  if (removed) publish();
  const started: Promise<void>[] = [];
  for (const w of watchers) {
    const intervalMs = (w.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
    for (const { task, checkout } of probeTargets(w, list)) {
      const key = keyOf(task.id, w);
      if (inFlight.has(key)) continue;
      if (now < (backoffUntil.get(key) ?? 0)) continue;
      if (now - (lastProbeAt.get(key) ?? 0) < intervalMs) continue;
      lastProbeAt.set(key, now);
      started.push(probe(w, task, checkout));
    }
  }
  return started;
}

/** Start polling. Idempotent; the timer is unref'd so it never keeps the
 *  headless daemon alive past its idle shutdown. */
export function startProgressWatchLoop(): void {
  if (loop) return;
  void Promise.all(progressWatchTick());
  loop = setInterval(() => void Promise.all(progressWatchTick()), TICK_MS);
  loop.unref?.();
}

/** Test hook. */
export function resetProgressWatchForTests(): void {
  if (loop) clearInterval(loop);
  loop = null;
  progress.clear();
  lastProbeAt.clear();
  backoffUntil.clear();
  inFlight.clear();
}
