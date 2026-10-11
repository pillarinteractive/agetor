/**
 * Awaits: a pipeline step hands a long command (a VM lab cycle, an E2E run, a
 * full test suite) to Agetor instead of sitting in its session watching it.
 * Watching costs a turn per check, each re-sending the whole conversation —
 * hours of it for a lab cycle — and holds an agent slot the whole time.
 *
 *   ~/.agetor/bin/agetor-await "VM tests" -- lab/vm/plab test truenas-scale
 *
 * starts the command detached and returns at once; the step ends its turn.
 * The runner sees the turn end with an await still out and parks the step as
 * `await` (reads as running, frees its slot) rather than "handoff missing".
 * When the command exits, the watcher here messages the step with the exit
 * code, how long it took, the log's tail and the log's path, and the step
 * carries on in the same session.
 *
 * Each await is a directory under `<dataDir>/awaits/<id>/` of plain files —
 * `label`, `cwd` (the checkout it ran in), `cmd`, `started` (epoch seconds),
 * `pid`, `log`, then `exit` once it finished and `notified` once a step was
 * told — so the shell helper needs no JSON and a restart loses nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PipelineRunState, Task } from "../shared/types.ts";
import { dataDir, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { isTaskRunLive, sendInput } from "./orchestrator.ts";
import { currentSlots, slotDecision, slotUse } from "./step-slots.ts";
import { isPriority } from "./priority.ts";
import {installHeavyHelper} from './heavy-jobs.ts';

export const AWAITS_DIR = path.join(dataDir, "awaits");
export const AWAIT_BIN = path.join(dataDir, "bin", "agetor-await");
const TICK_MS = 15_000;
const TAIL_LINES = 60;
/** Finished, told awaits are swept after this long. */
const KEEP_MS = 3 * 24 * 3600_000;

/** The helper agents call. Plain sh + perl (for setsid), both on every Mac. */
export const AWAIT_SCRIPT = `#!/bin/sh
# agetor-await <label> -- <command> [args...]
# Runs a long command detached and returns at once. End your turn after it:
# Agetor messages you with the exit code and the log's tail when it finishes.
# (Installed by Agetor — src/bun/awaits.ts; edits are overwritten.)
[ $# -ge 2 ] || { echo "usage: agetor-await <label> -- <command> [args...]" >&2; exit 2; }
label=$1; shift
[ "$1" = "--" ] && shift
[ $# -ge 1 ] || { echo "agetor-await: no command given" >&2; exit 2; }
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
id=$(date +%Y%m%d%H%M%S)-$$
d="${AWAITS_DIR}/$id"
mkdir -p "$d" || exit 1
printf '%s' "$label" > "$d/label"
printf '%s' "$root" > "$d/cwd"
printf '%s ' "$@" > "$d/cmd"
date +%s > "$d/started"
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh -c 'AGETOR_AWAIT_RECORD="$0" "$@" > "$0/log" 2>&1; echo $? > "$0/exit.tmp"; mv "$0/exit.tmp" "$0/exit"' "$d" "$@" </dev/null >/dev/null 2>&1 &
echo $! > "$d/pid"
echo "Started \\"$label\\" in the background — log: $d/log"
echo "Now end your turn with a one-line note (no <handoff> yet). Do not poll, tail or sleep:"
echo "Agetor messages you with the exit code and the log's tail when it finishes."
`;

/** Write the helper where agents can run it. Idempotent. */
export function installAwaitHelper(): void {
  installHeavyHelper();
  const body = AWAIT_SCRIPT;
  try {
    mkdirSync(path.dirname(AWAIT_BIN), { recursive: true });
    if (existsSync(AWAIT_BIN) && readFileSync(AWAIT_BIN, "utf8") === body) return;
    writeFileSync(AWAIT_BIN, body, { mode: 0o755 });
  } catch {
    // best-effort: steps fall back to running the command themselves
  }
}

export interface AwaitRecord {
  id: string;
  dir: string;
  label: string;
  cwd: string;
  cmd: string;
  startedAt: number;
  pid: number | null;
  /** Exit code once finished; null while running or when it died unrecorded. */
  exitCode: number | null;
  finished: boolean;
  notified: boolean;
  resourceState?: 'waiting'|'running'|'finished';
}

const read = (f: string): string | null => {
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
};

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What `listAwaits` keeps of a record between ticks: the files the helper
 *  writes once and never changes (label, cwd, cmd and started are written
 *  before the command starts; exit lands by an atomic rename; pid is read
 *  until it's there). Keyed by the record's dir and checked against the
 *  `started` file's inode + mtime, so a dir that's removed and recreated is
 *  read afresh. Saves ~6 file reads per record per tick — hundreds of
 *  records accumulate over the 3-day keep window. */
interface CachedAwait {
  stamp: string;
  label: string;
  cwd: string;
  cmd: string;
  started: number;
  pid: number | null;
  exit: string | null;
}
const awaitCache = new Map<string, CachedAwait>();

export function listAwaits(root = AWAITS_DIR): AwaitRecord[] {
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const out: AwaitRecord[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const dir = path.join(root, id);
    let stamp: string;
    try {
      const st = statSync(path.join(dir, "started"));
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      continue; // no `started` yet (or not a record): `read` would give null → skipped
    }
    let c = awaitCache.get(dir);
    if (!c || c.stamp !== stamp) {
      const started = Number(read(path.join(dir, "started")));
      const cwd = read(path.join(dir, "cwd"));
      if (!cwd || !Number.isFinite(started) || started <= 0) {
        awaitCache.delete(dir);
        continue;
      }
      c = {
        stamp,
        label: read(path.join(dir, "label")) || "command",
        cwd,
        cmd: read(path.join(dir, "cmd")) ?? "",
        started,
        pid: null,
        exit: null,
      };
      awaitCache.set(dir, c);
    }
    seen.add(dir);
    if (c.pid == null) c.pid = Number(read(path.join(dir, "pid"))) || null;
    if (!c.exit) c.exit = read(path.join(dir, "exit")); // an empty exit file is re-read until it has the code
    const { pid, exit } = c;
    // No exit file and the process is gone: it was killed (or the machine
    // restarted) — finished, outcome unknown.
    const finished = exit != null || (pid != null && !alive(pid));
    out.push({
      id,
      dir,
      label: c.label,
      cwd: c.cwd,
      cmd: c.cmd,
      startedAt: c.started * 1000,
      pid,
      exitCode: exit != null && exit !== "" && Number.isFinite(Number(exit)) ? Number(exit) : null,
      finished,
      notified: existsSync(path.join(dir, "notified")),
      ...(()=>{const phase=read(path.join(dir,'resource-state'))??read(path.join(dir,'phase'));return phase==='executing'?{resourceState:'running' as const}:['waiting','running','finished'].includes(phase??'')?{resourceState:phase as AwaitRecord['resourceState']}:{};})(),
    });
  }
  for (const dir of awaitCache.keys()) if (path.dirname(dir) === root && !seen.has(dir)) awaitCache.delete(dir);
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(a) === norm(b);
}

/** Awaits a step started in `worktree` since `sinceMs` that no step has
 *  been told about yet. */
export function awaitsFor(worktree: string, sinceMs: number, all: AwaitRecord[] = listAwaits()): AwaitRecord[] {
  return all.filter((a) => !a.notified && a.startedAt >= sinceMs - 5_000 && samePath(a.cwd, worktree));
}

function tail(file: string, lines: number): string {
  const text = read(file) ?? "";
  return text.split("\n").slice(-lines).join("\n");
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

/** The message that wakes the step. Exported for tests. */
export function awaitResultMessage(done: AwaitRecord[], now = Date.now()): string {
  const parts = done.map((a) => {
    const outcome = a.exitCode == null ? "stopped without an exit code (killed, or the machine restarted)" : a.exitCode === 0 ? "exited 0 (success)" : `exited ${a.exitCode} (failure)`;
    const log = path.join(a.dir, "log");
    const ended = (() => {
      try {
        return statSync(path.join(a.dir, existsSync(path.join(a.dir, "exit")) ? "exit" : "log")).mtimeMs;
      } catch {
        return now;
      }
    })();
    return [
      `"${a.label}" ${outcome} after ${minutes(ended - a.startedAt)}.`,
      `Command: ${a.cmd.trim()}`,
      `Full log: ${log}`,
      `Last ${TAIL_LINES} lines:`,
      "```",
      tail(log, TAIL_LINES),
      "```",
    ].join("\n");
  });
  return [
    "Your background command(s) finished:",
    "",
    ...parts,
    "",
    "Read more of the log only where you need to, then carry on with your step. If you start another long command, use agetor-await again and end your turn.",
  ].join("\n");
}

/** Blocks a finished await wakes a step out of. `await` is the step parked
 *  on purpose. The other two are the safety net: the step's turn ended with
 *  no usable handoff, so nothing was asked of the owner, and a command it
 *  started has results it was never told — left alone it would sit until a
 *  person looked. (Each record wakes a step once: `notified`.)
 *
 *  Not `step-blocked`: that is the step saying it is blocked or asking the
 *  owner something, or a usage-limit stop — which the limit's own resume
 *  continues, after which the turn parks on its awaits like any other. */
const WAKEABLE = new Set<string>(["await", "handoff-missing", "handoff-invalid"]);

/** Step + await pairs ready to be woken: an active, idle step under a
 *  {@link WAKEABLE} block whose awaits have all finished. Pure over its
 *  inputs. Exported for tests. */
export function readyToWake(
  list: Task[],
  all: AwaitRecord[],
): { parent: Task; stepTaskId: string; stepId: string; done: AwaitRecord[] }[] {
  const out: { parent: Task; stepTaskId: string; stepId: string; done: AwaitRecord[] }[] = [];
  for (const parent of list) {
    const run: PipelineRunState | null | undefined = parent.pipelineRun;
    if (!run || parent.archivedAt != null || !parent.worktreePath) continue;
    const seen = new Set<string>();
    for (const b of run.blocked) {
      if (!WAKEABLE.has(b.kind) || !b.taskId || !b.stepId || seen.has(b.taskId)) continue;
      if (b.kind !== "await") {
        // Only the step the run is on, and only while it is idle.
        if (!run.active.some((a) => a.taskId === b.taskId)) continue;
        if (list.find((t) => t.id === b.taskId)?.column === "running") continue;
      }
      const since = run.history.filter((h) => h.taskId === b.taskId).reduce((m, h) => Math.min(m, h.startedAt), Infinity);
      const mine = awaitsFor(parent.worktreePath, Number.isFinite(since) ? since : 0, all);
      if (mine.length && mine.every((a) => a.finished)) {
        seen.add(b.taskId);
        out.push({ parent, stepTaskId: b.taskId, stepId: b.stepId, done: mine });
      }
    }
  }
  return out;
}

/** One pass: wake every step whose awaits all finished (when a slot allows),
 *  and sweep old records. Exported for tests. */
export async function awaitTick(now = Date.now()): Promise<number> {
  const all = listAwaits();
  let woke = 0;
  for (const w of readyToWake(tasks.listLive(), all)) {
    const step = w.parent.pipelineRun?.snapshot?.graph.steps.find((s) => s.id === w.stepId);
    if (!isPriority(w.parent.id)) {
      const slots = currentSlots();
      if (!slotDecision(step?.name ?? "", slotUse(isTaskRunLive, slots), slots).ok) continue;
    }
    const runId = tasks.get(w.stepTaskId)?.runId;
    if (!runId) continue;
    const sent = await sendInput(runId, awaitResultMessage(w.done, now)).catch((e: Error) => ({ delivered: false, reason: e.message }));
    if (!sent.delivered) continue;
    for (const a of w.done) writeFileSync(path.join(a.dir, "notified"), String(now));
    const what = w.done.map((a) => `"${a.label}" ${a.exitCode === 0 ? "passed" : a.exitCode == null ? "stopped" : `failed (exit ${a.exitCode})`}`).join(", ");
    recordActivity(w.parent.id, { kind: "auto", text: `${what} — woke ${step?.name ?? "the step"} to carry on`, tone: w.done.every((a) => a.exitCode === 0) ? "success" : "warning" });
    woke++;
  }
  for (const a of all) {
    if (a.finished && now - a.startedAt > KEEP_MS) rmSync(a.dir, { recursive: true, force: true });
  }
  return woke;
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startAwaitLoop(): void {
  if (loop) return;
  installAwaitHelper();
  loop = setInterval(() => void awaitTick().catch(() => undefined), TICK_MS);
  loop.unref?.();
}
