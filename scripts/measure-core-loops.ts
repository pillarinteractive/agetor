// Time the DB/disk reads the core's background loops make on every tick,
// against a COPY of a real data dir, and rank them by CPU per minute:
//   mkdir /tmp/agetor-copy
//   sqlite3 -readonly ~/.agetor/agetor.sqlite ".backup /tmp/agetor-copy/agetor.sqlite"
//   cp -R ~/.agetor/awaits /tmp/agetor-copy/
//   AGETOR_DATA_DIR=/tmp/agetor-copy bun scripts/measure-core-loops.ts [--iters 40]
// Never point it at the live ~/.agetor — importing db.ts runs migrations.
//
// "before" is the full-table `tasks.list()` (and the uncached await-record
// read) the loops used to make; "after" is what they make now
// (`tasks.listLive()`, the targeted step-reaper read, the cached
// `listAwaits`). Calls/min are for a steady board with one lease watcher
// and one progress watcher (this user's config) and nothing slot-waiting —
// a tick that finds work does more of the same reads (each slot-waiting
// step adds 1–2 `slotUse` reads to every 10 s slot-scheduler tick). Per-call
// cost is process CPU time (user+sys).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

if (!process.env.AGETOR_DATA_DIR) throw new Error("set AGETOR_DATA_DIR to a COPY of the data dir");
const { tasks } = await import("../src/bun/db.ts");
const { slotUse } = await import("../src/bun/step-slots.ts");
const { listAwaits, AWAITS_DIR } = await import("../src/bun/awaits.ts");
const { stepSessionRows } = await import("../src/bun/pipeline-runner.ts");

const iters = Number(process.argv[process.argv.indexOf("--iters") + 1]) || 40;
const cpuMs = (fn: () => unknown): number => {
  fn(); // warm statement + file caches
  const t0 = process.cpuUsage();
  for (let i = 0; i < iters; i++) fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000 / iters;
};

/** The pre-cache `listAwaits` (6 file reads per record per call). */
function legacyListAwaits(root = AWAITS_DIR): number {
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {
      return null;
    }
  };
  let n = 0;
  for (const id of readdirSync(root)) {
    const dir = path.join(root, id);
    const started = Number(read(path.join(dir, "started")));
    const cwd = read(path.join(dir, "cwd"));
    if (!cwd || !Number.isFinite(started) || started <= 0) continue;
    const pid = Number(read(path.join(dir, "pid"))) || null;
    const exit = read(path.join(dir, "exit"));
    if (exit == null && pid != null) {
      try {
        process.kill(pid, 0);
      } catch {
        // gone
      }
    }
    read(path.join(dir, "label"));
    read(path.join(dir, "cmd"));
    existsSync(path.join(dir, "notified"));
    n++;
  }
  return n;
}

const all = tasks.list();
const live = tasks.listLive();
console.log(`tasks: ${all.length} (archived ${all.filter((t) => t.archivedAt != null).length}; listLive ${live.length}); awaits: ${listAwaits().length}`);

// A plausible tmux session set: every running step has a session.
const sessionName = (id: string) => `agetor-${id.slice(0, 12)}`;
const names = new Set(live.filter((t) => t.pipelineParentId && t.column === "running").map((t) => sessionName(t.id)));

const listCall = cpuMs(() => tasks.list());
const liveCall = cpuMs(() => tasks.listLive());
const reaperAfter = cpuMs(() => stepSessionRows(names, sessionName));
const branchAfter = cpuMs(() => tasks.branchRows());
const slotUseFull = cpuMs(() => slotUse(() => false, undefined, tasks.list()));
const slotUseLive = cpuMs(() => slotUse(() => false));
const awaitsBefore = cpuMs(() => legacyListAwaits());
const awaitsAfter = cpuMs(() => listAwaits());

const rows: { item: string; perMin: number; before: number; after: number }[] = [
  { item: "progress-watch tick (3 s): tasks.list()", perMin: 20, before: listCall, after: liveCall },
  { item: "lease-watch tick (5 s): queueFor → tasks.list()", perMin: 12, before: listCall, after: liveCall },
  { item: "lease-watch probe (30 s): resolveHolderTask + queueFor", perMin: 4, before: listCall, after: liveCall },
  { item: "slot scheduler (10 s): releaseSlotWaits → tasks.list()", perMin: 6, before: listCall, after: liveCall },
  { item: "keep-awake (10 s): hasRunningWork(tasks.list())", perMin: 6, before: listCall, after: liveCall },
  { item: "awaits (15 s): readyToWake(tasks.list())", perMin: 4, before: listCall, after: liveCall },
  { item: "awaits (15 s): listAwaits() over awaits/", perMin: 4, before: awaitsBefore, after: awaitsAfter },
  { item: "step reaper (60 s): tasks.list() → stepSessionRows", perMin: 1, before: listCall, after: reaperAfter },
  { item: "pr-watch (60 s): tasks.list()", perMin: 1, before: listCall, after: liveCall },
  { item: "merge-queue (60 s): tasks.list()", perMin: 1, before: listCall, after: liveCall },
  { item: "unsettled-step recovery (5 min): 2× tasks.list()", perMin: 0.4, before: listCall, after: liveCall },
  { item: "done-teardown sweep (5 min): tasks.list()", perMin: 0.2, before: listCall, after: liveCall },
  { item: "idle-session reaper (5 min): tasks.list()", perMin: 0.2, before: listCall, after: liveCall },
];
const fmt = (n: number, w = 8, d = 2) => n.toFixed(d).padStart(w);
console.log(`\nper call (CPU ms, mean of ${iters}):`);
console.log(`  tasks.list() ${fmt(listCall)}   tasks.listLive() ${fmt(liveCall)}`);
console.log(`  slotUse(): over list() ${fmt(slotUseFull)}   default (listLive) ${fmt(slotUseLive)}   (per slot-waiting step per 10 s tick, per await wake, per step launch)`);
console.log(`  branch-taken check: tasks.list() ${fmt(listCall)}   tasks.branchRows() ${fmt(branchAfter)}   (per task start / step launch / branch picker)`);
console.log(`  listAwaits(): legacy ${fmt(awaitsBefore)}   cached ${fmt(awaitsAfter)}`);
console.log(`\n${"loop read".padEnd(58)} ${"calls/min".padStart(9)} ${"ms/call".padStart(8)} ${"ms/min".padStart(8)}  → ${"ms/call".padStart(8)} ${"ms/min".padStart(8)}`);
let tb = 0;
let ta = 0;
for (const r of rows.sort((a, b) => b.perMin * b.before - a.perMin * a.before)) {
  const b = r.perMin * r.before;
  const a = r.perMin * r.after;
  tb += b;
  ta += a;
  console.log(`${r.item.padEnd(58)} ${String(r.perMin).padStart(9)} ${fmt(r.before)} ${fmt(b, 8, 0)}  → ${fmt(r.after)} ${fmt(a, 8, 0)}`);
}
console.log(`${"TOTAL CPU ms per minute (600 = 1% of one core)".padEnd(58)} ${"".padStart(9)} ${"".padStart(8)} ${fmt(tb, 8, 0)}  → ${"".padStart(8)} ${fmt(ta, 8, 0)}`);
console.log(`as % of one core: ${(tb / 600).toFixed(1)}% → ${(ta / 600).toFixed(1)}%`);
