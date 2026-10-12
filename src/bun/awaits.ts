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
import { dataDir, runs, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { isTaskRunLive, sendInput } from "./orchestrator.ts";
import { currentSlots, slotDecision, slotUse } from "./step-slots.ts";
import { isPriority } from "./priority.ts";
import {installHeavyHelper} from './heavy-jobs.ts';
import {asksTheOwner} from '../shared/block-wait.ts';
import {isQuotaPaused} from './usage-limit.ts';

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
 *  Most `step-blocked`: that is the step saying it is blocked or asking the
 *  owner something, or a usage-limit stop — which the limit's own resume
 *  continues, after which the turn parks on its awaits like any other.
 *  A declared queued resource wait bound below to its current await can wake. */
const WAKEABLE = new Set<string>(["await", "handoff-missing", "handoff-invalid"]);

/** A declared resource wait bound to an actual await from this execution's
 * current turn. Only the existing automatic wait queue can grant this
 * notification path; owner/permission holds and older/foreign jobs stay held.
 * Completion wakes this same step to inspect the result, never approves it. */
export function resourceBlockedAwaits(parent:Task, taskId:string, all:AwaitRecord[]):AwaitRecord[] {
  const run=parent.pipelineRun, wait=run?.wait;
  if(!parent.worktreePath||parent.archivedAt!=null||parent.pendingInteractionCount||run?.status!=='blocked'
    ||wait?.taskId!==taskId||wait.state!=='waiting'||wait.category!=='resource'||wait.source!=='declared')return [];
  const active=run.active.find(a=>a.taskId===taskId);
  const history=active&&run.history.find(h=>h.taskId===taskId&&h.seq===active.seq);
  const handoff=history?.handoff;
  if(!history||!handoff||handoff.status!=='blocked'||handoff.waitingOn?.on!=='resource'
    ||handoff.openQuestions.some(q=>q.trim())||asksTheOwner([handoff.reason,handoff.summary].join('\n')))return [];
  // The general await lookup allows a five-second launch grace. A declared
  // resource wake must instead prove this turn: second-resolution receipts
  // earlier than its precise start (including the ambiguous first second)
  // cannot establish ownership of the new turn.
  const since=history.turnStartedAt??history.startedAt;
  const mine=all.filter(a=>!a.notified&&a.startedAt>=since&&samePath(a.cwd,parent.worktreePath!));
  const refs=[handoff.waitingOn.ref,wait.ref].filter((r):r is string=>!!r);
  let bound=false;
  if(refs.length) {
    let identity:AwaitRecord|undefined;
    for(const ref of refs) {
      // IDs/log paths name global receipts; never let a local artifact or
      // reused label override a known foreign/stale exact identity.
      const exact=all.filter(a=>a.id===ref||path.isAbsolute(ref)&&
        (path.resolve(ref)===path.resolve(a.dir)||path.resolve(ref)===path.resolve(a.dir,'log')));
      const matches=exact.length?exact:mine.filter(a=>a.label===ref);
      const receipt=matches.length===1?matches[0]:undefined;
      if(!receipt||!mine.includes(receipt)||identity&&identity!==receipt)return [];
      identity=receipt;
    }
    bound=identity!=null;
  } else {
    // With no explicit reference, an exact current-turn log can bind the
    // await. Unresolved/conflicting explicit references never fall back.
    bound=mine.some(a=>handoff.artifacts.some(f=>path.isAbsolute(f)&&path.resolve(f)===path.resolve(a.dir,'log')));
  }
  return bound?mine:[];
}

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
      if (!b.taskId || !b.stepId || seen.has(b.taskId)) continue;
      const resource=b.kind==='step-blocked'?resourceBlockedAwaits(parent,b.taskId,all):[];
      if (!WAKEABLE.has(b.kind) && resource.length===0) continue;
      if(resource.length) {
        const child=list.find(t=>t.id===b.taskId);
        if(!child||child.archivedAt!=null||child.pendingInteractionCount||child.column==='running')continue;
      }
      if (b.kind !== "await") {
        // Only the step the run is on, and only while it is idle.
        if (!run.active.some((a) => a.taskId === b.taskId)) continue;
        if (list.find((t) => t.id === b.taskId)?.column === "running") continue;
      }
      const since = run.history.filter((h) => h.taskId === b.taskId).reduce((m, h) => Math.min(m, h.startedAt), Infinity);
      const mine = resource.length?resource:awaitsFor(parent.worktreePath, Number.isFinite(since) ? since : 0, all);
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
const notificationClaims=new Set<string>();

export async function awaitTick(now = Date.now()): Promise<number> {
  const all = listAwaits();
  const initial=tasks.listLive();
  let woke = 0;
  for (const candidate of readyToWake(initial, all)) {
    const originalChild=initial.find(t=>t.id===candidate.stepTaskId);
    const originalActive=candidate.parent.pipelineRun?.active.find(a=>a.taskId===candidate.stepTaskId);
    const originalHistory=originalActive&&candidate.parent.pipelineRun?.history.find(h=>h.taskId===candidate.stepTaskId&&h.seq===originalActive.seq);
    if(!originalChild?.runId||!originalActive||!originalHistory||notificationClaims.has(candidate.stepTaskId))continue;
    // Per-child claims deduplicate overlapping ticks without holding the
    // parent lock through a slow spawn; Stop and new owner holds stay free.
    notificationClaims.add(candidate.stepTaskId);
    try {
      // Earlier sends yield. Re-read the wait, current execution, exact run
      // and receipts immediately before this dispatch, never use its cached
      // eligibility or write a notified marker for a replaced execution.
      const parent=tasks.get(candidate.parent.id),child=tasks.get(candidate.stepTaskId);
      if(!parent||!child||parent.pipelineRun?.status==='cancelled'||parent.archivedAt!=null
        ||child.archivedAt!=null||parent.pendingInteractionCount||child.pendingInteractionCount
        ||child.runId!==originalChild.runId||isTaskRunLive(child.id)||isQuotaPaused(child.id))continue;
      const active=parent.pipelineRun?.active.find(a=>a.taskId===child.id);
      const history=active&&parent.pipelineRun?.history.find(h=>h.taskId===child.id&&h.seq===active.seq);
      const receipt=runs.get(originalChild.runId);
      if(!active||!history||active.seq!==originalActive.seq||active.stepId!==candidate.stepId
        ||(history.turnStartedAt??history.startedAt)!==(originalHistory.turnStartedAt??originalHistory.startedAt)
        ||!receipt||receipt.taskId!==child.id||!['succeeded','failed'].includes(receipt.status))continue;
      const w=readyToWake([parent,child],listAwaits()).find(w=>w.parent.id===parent.id&&w.stepTaskId===child.id&&w.stepId===candidate.stepId);
      if(!w)continue;
      const step = w.parent.pipelineRun?.snapshot?.graph.steps.find((s) => s.id === w.stepId);
      if (!isPriority(w.parent.id)) {
        const slots = currentSlots();
        if (!slotDecision(step?.name ?? "", slotUse(isTaskRunLive, slots), slots).ok) continue;
      }
      const sent = await sendInput(originalChild.runId, awaitResultMessage(w.done, now)).catch((e: Error) => ({ delivered: false, reason: e.message }));
      if (!sent.delivered) continue;
      for (const a of w.done) writeFileSync(path.join(a.dir, "notified"), String(now));
      const what = w.done.map((a) => `"${a.label}" ${a.exitCode === 0 ? "passed" : a.exitCode == null ? "stopped" : `failed (exit ${a.exitCode})`}`).join(", ");
      recordActivity(w.parent.id, { kind: "auto", text: `${what} — woke ${step?.name ?? "the step"} to carry on`, tone: w.done.every((a) => a.exitCode === 0) ? "success" : "warning" });
      woke++;
    } finally {
      notificationClaims.delete(candidate.stepTaskId);
    }
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
