/**
 * Lease watchers: periodically run a project-provided command that reports
 * who holds a shared resource (a lab host, a hardware rig), and map the
 * holder's checkout back to the board card whose worktree it is. The board
 * shows a badge on the holder and a busy/free hint on Blocked cards of the
 * same project, so the user knows when a task waiting on the resource can be
 * retried.
 *
 * Configured with the `lease_watchers` preference — a JSON array of
 * {@link LeaseWatcherConfig}. Agetor only reads the lease; acquiring and
 * releasing it stays with the project's own tooling.
 */
import { realpathSync } from "node:fs";
import type { LeaseStatus, LeaseWatcherConfig, Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { publishGlobalEvent } from "./orchestrator.ts";

export const LEASE_WATCHERS_PREF = "lease_watchers";
const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 5;
const TICK_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Parse the preference value, dropping malformed entries rather than
 *  failing the whole list — one bad row shouldn't blank every badge. */
export function parseLeaseWatchers(raw: string | null | undefined): LeaseWatcherConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LeaseWatcherConfig[] = [];
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

export type LeaseProbe =
  | { ok: true; held: boolean; checkout: string | null; owner: string | null; since: string | null }
  | { ok: false; error: string };

/** Read the command's last non-empty stdout line as the lease JSON. */
export function parseLeaseProbeOutput(stdout: string): LeaseProbe {
  const line = stdout.trim().split("\n").filter((l) => l.trim()).pop();
  if (!line) return { ok: false, error: "no output" };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, error: `not JSON: ${line.slice(0, 120)}` };
  }
  if (!v || typeof v !== "object" || typeof (v as { held?: unknown }).held !== "boolean") {
    return { ok: false, error: 'expected {"held": true|false, ...}' };
  }
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return { ok: true, held: o.held as boolean, checkout: str(o.checkout), owner: str(o.owner), since: str(o.since) };
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}

/** The board card whose checkout is `checkout`: the task whose worktree it
 *  is (or whose workdir, for an isolation-less task), lifted to its pipeline
 *  parent when it's a hidden step. Archived tasks never hold a badge. */
export function resolveHolderTask(checkout: string, list: Task[]): Task | null {
  const target = canonicalPath(checkout);
  const live = list.filter((t) => t.archivedAt == null);
  const owner =
    live.find((t) => t.worktreePath && canonicalPath(t.worktreePath) === target) ??
    live.find((t) => t.isolation === "none" && canonicalPath(t.workdir) === target) ??
    null;
  if (!owner?.pipelineParentId) return owner;
  return live.find((t) => t.id === owner.pipelineParentId) ?? owner;
}

const statuses = new Map<string, LeaseStatus>();
const lastProbeAt = new Map<string, number>();
const inFlight = new Set<string>();
let loop: ReturnType<typeof setInterval> | null = null;

const keyOf = (w: Pick<LeaseWatcherConfig, "project" | "label">) => `${w.project}\0${w.label}`;

/** Every configured watcher's latest status (watchers never probed yet are
 *  omitted). */
export function listLeases(): LeaseStatus[] {
  return [...statuses.values()];
}

function sameObservation(a: LeaseStatus | undefined, b: LeaseStatus): boolean {
  return (
    !!a &&
    a.held === b.held &&
    a.holderTaskId === b.holderTaskId &&
    a.holderTitle === b.holderTitle &&
    a.checkout === b.checkout &&
    a.error === b.error
  );
}

function publish(): void {
  publishGlobalEvent({ kind: "leases", leases: listLeases(), ts: Date.now() });
}

async function runProbe(w: LeaseWatcherConfig): Promise<LeaseProbe> {
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", w.command], {
      cwd: w.project,
      // The live env, not Bun's launch-time default: a Finder-launched app's
      // rehydrated PATH is what finds the project's tools.
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
    return parseLeaseProbeOutput(stdout);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function probe(w: LeaseWatcherConfig): Promise<void> {
  const key = keyOf(w);
  inFlight.add(key);
  try {
    const result = await runProbe(w);
    const prev = statuses.get(key);
    let next: LeaseStatus;
    if (result.ok) {
      const holder = result.held && result.checkout ? resolveHolderTask(result.checkout, tasks.list()) : null;
      next = {
        project: w.project,
        label: w.label,
        held: result.held,
        holderTaskId: holder?.id ?? null,
        holderTitle: holder?.title ?? null,
        checkout: result.held ? result.checkout : null,
        owner: result.held ? result.owner : null,
        since: result.held ? result.since : null,
        checkedAt: Date.now(),
        error: null,
      };
    } else {
      // Keep the last known holder: a flaky probe (host briefly unreachable)
      // shouldn't flash every badge off.
      next = {
        project: w.project,
        label: w.label,
        held: prev?.held ?? false,
        holderTaskId: prev?.holderTaskId ?? null,
        holderTitle: prev?.holderTitle ?? null,
        checkout: prev?.checkout ?? null,
        owner: prev?.owner ?? null,
        since: prev?.since ?? null,
        checkedAt: Date.now(),
        error: result.error,
      };
    }
    // A watcher removed from the preference while this probe ran is gone.
    if (!parseLeaseWatchers(preferences.get(LEASE_WATCHERS_PREF)).some((c) => keyOf(c) === key)) return;
    statuses.set(key, next);
    if (!sameObservation(prev, next)) publish();
  } finally {
    inFlight.delete(key);
  }
}

/** One scheduler pass: drop watchers no longer configured, probe the due
 *  ones. Exported for tests. */
export function leaseWatchTick(now = Date.now()): Promise<void>[] {
  const watchers = parseLeaseWatchers(preferences.get(LEASE_WATCHERS_PREF));
  const wanted = new Set(watchers.map(keyOf));
  let removed = false;
  for (const key of [...statuses.keys()]) {
    if (!wanted.has(key)) {
      statuses.delete(key);
      lastProbeAt.delete(key);
      removed = true;
    }
  }
  if (removed) publish();
  const started: Promise<void>[] = [];
  for (const w of watchers) {
    const key = keyOf(w);
    if (inFlight.has(key)) continue;
    const intervalMs = (w.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
    if (now - (lastProbeAt.get(key) ?? 0) < intervalMs) continue;
    lastProbeAt.set(key, now);
    started.push(probe(w));
  }
  return started;
}

/** Start polling. Idempotent; the timer is unref'd so it never keeps the
 *  headless daemon alive past its idle shutdown. */
export function startLeaseWatchLoop(): void {
  if (loop) return;
  void Promise.all(leaseWatchTick());
  loop = setInterval(() => void Promise.all(leaseWatchTick()), TICK_MS);
  loop.unref?.();
}

/** Test hook. */
export function resetLeaseWatchForTests(): void {
  if (loop) clearInterval(loop);
  loop = null;
  statuses.clear();
  lastProbeAt.clear();
  inFlight.clear();
}
