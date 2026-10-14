import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { AWAIT_SCRIPT, awaitResultMessage, awaitsFor, listAwaits, readyToWake } from "./awaits.ts";

function record(root: string, id: string, o: { cwd: string; started: number; exit?: string; pid?: number; notified?: boolean; log?: string }) {
  const d = path.join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "label"), `run ${id}`);
  writeFileSync(path.join(d, "cwd"), o.cwd);
  writeFileSync(path.join(d, "cmd"), "lab/vm/plab test truenas-scale ");
  writeFileSync(path.join(d, "started"), String(o.started));
  writeFileSync(path.join(d, "pid"), String(o.pid ?? process.pid));
  writeFileSync(path.join(d, "log"), o.log ?? "line\n");
  if (o.exit != null) writeFileSync(path.join(d, "exit"), o.exit);
  if (o.notified) writeFileSync(path.join(d, "notified"), "1");
}

test("records: running, finished with a code, killed without one; matched to the checkout and the step's start", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  const wt = mkdtempSync(path.join(tmpdir(), "wt-"));
  record(root, "a", { cwd: wt, started: 2000 }); // running (our own pid is alive)
  record(root, "b", { cwd: wt, started: 2000, exit: "1" });
  record(root, "c", { cwd: wt, started: 2000, pid: 999_999 }); // gone, no exit file
  record(root, "d", { cwd: wt, started: 1000, exit: "0" }); // before this step began
  record(root, "e", { cwd: "/elsewhere", started: 2000, exit: "0" });
  record(root, "f", { cwd: wt, started: 2000, exit: "0", notified: true });
  const all = listAwaits(root);
  const byId = Object.fromEntries(all.map((a) => [a.id, a]));
  expect(byId.a).toMatchObject({ finished: false, exitCode: null });
  expect(byId.b).toMatchObject({ finished: true, exitCode: 1 });
  expect(byId.c).toMatchObject({ finished: true, exitCode: null });
  expect(awaitsFor(wt, 1_900_000, all).map((a) => a.id).sort()).toEqual(["a", "b", "c"]);
});

test("repeat reads follow a record as it changes: pid and exit landing, notified, removal, a recreated dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  const wt = mkdtempSync(path.join(tmpdir(), "wt-"));
  record(root, "r", { cwd: wt, started: 2000 });
  const pidFile = path.join(root, "r", "pid");
  unlinkSync(pidFile); // the helper writes pid after started
  const one = () => listAwaits(root).find((a) => a.id === "r");
  expect(one()).toMatchObject({ pid: null, finished: false, exitCode: null, notified: false });
  writeFileSync(pidFile, String(process.pid));
  expect(one()).toMatchObject({ pid: process.pid, finished: false });
  writeFileSync(path.join(root, "r", "exit"), "");
  expect(one()).toMatchObject({ finished: true, exitCode: null });
  writeFileSync(path.join(root, "r", "exit"), "3");
  expect(one()).toMatchObject({ finished: true, exitCode: 3 });
  writeFileSync(path.join(root, "r", "notified"), "1");
  expect(one()).toMatchObject({ notified: true, label: "run r", cwd: wt });
  rmSync(path.join(root, "r"), { recursive: true });
  expect(listAwaits(root)).toEqual([]);
  // Same id again with new contents: read afresh, not from the earlier record.
  record(root, "r", { cwd: "/elsewhere", started: 3000 });
  expect(one()).toMatchObject({ cwd: "/elsewhere", startedAt: 3_000_000, finished: false, exitCode: null, notified: false });
  // A record without a valid cwd/started is skipped until it has them.
  mkdirSync(path.join(root, "s"));
  writeFileSync(path.join(root, "s", "started"), "4000");
  expect(listAwaits(root).map((a) => a.id)).toEqual(["r"]);
  writeFileSync(path.join(root, "s", "cwd"), wt);
  expect(listAwaits(root).map((a) => a.id)).toEqual(["r", "s"]);
});

test("a parked step wakes only once every await it started has finished", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  const wt = mkdtempSync(path.join(tmpdir(), "wt-"));
  record(root, "x", { cwd: wt, started: 2000, exit: "0" });
  const parent = {
    id: "p",
    archivedAt: null,
    worktreePath: wt,
    pipelineRun: {
      blocked: [{ taskId: "s1", stepId: "build", kind: "await", message: "" }],
      history: [{ taskId: "s1", stepId: "build", seq: 1, startedAt: 1_900_000 }],
      active: [{ taskId: "s1", stepId: "build", seq: 1 }],
    },
  } as unknown as Task;
  expect(readyToWake([parent], listAwaits(root)).map((w) => w.done.map((a) => a.id))).toEqual([["x"]]);
  record(root, "y", { cwd: wt, started: 2001 }); // still running
  expect(readyToWake([parent], listAwaits(root))).toEqual([]);
});

test("safety net: a step left without a handoff is woken by its finished awaits; a step that says it is blocked is not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  const wt = mkdtempSync(path.join(tmpdir(), "wt-"));
  record(root, "x", { cwd: wt, started: 2000, exit: "0" });
  const card = (kind: string, column = "review", active = true) => [
    {
      id: "p",
      archivedAt: null,
      worktreePath: wt,
      pipelineRun: {
        blocked: [{ taskId: "s1", stepId: "build", kind, message: "" }],
        history: [{ taskId: "s1", stepId: "build", seq: 1, startedAt: 1_900_000 }],
        active: active ? [{ taskId: "s1", stepId: "build", seq: 1 }] : [],
      },
    },
    { id: "s1", archivedAt: null, column, pipelineParentId: "p" },
  ] as unknown as Task[];
  const woken = (list: Task[]) => readyToWake(list, listAwaits(root)).map((w) => [w.stepTaskId, w.done.map((a) => a.id)]);
  expect(woken(card("handoff-missing"))).toEqual([["s1", ["x"]]]);
  expect(woken(card("handoff-invalid"))).toEqual([["s1", ["x"]]]);
  // The step said it is blocked (or asked the owner something): theirs.
  expect(woken(card("step-blocked"))).toEqual([]);
  expect(woken(card("step-failed"))).toEqual([]);
  // Already running again, or no longer the step the run is on.
  expect(woken(card("handoff-missing", "running"))).toEqual([]);
  expect(woken(card("handoff-missing", "review", false))).toEqual([]);
  // Not until every await it started has finished; told once.
  record(root, "y", { cwd: wt, started: 2001 });
  expect(woken(card("handoff-missing"))).toEqual([]);
  writeFileSync(path.join(root, "y", "exit"), "1");
  expect(woken(card("handoff-missing"))).toEqual([["s1", ["x", "y"]]]);
  for (const id of ["x", "y"]) writeFileSync(path.join(root, id, "notified"), "1");
  expect(woken(card("handoff-missing"))).toEqual([]);
});

test("the wake-up message carries the outcome, the command, the log path and its tail", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  record(root, "z", { cwd: "/w", started: Math.floor(Date.now() / 1000) - 600, exit: "2", log: "a\nFAILED test_x\n" });
  const msg = awaitResultMessage(listAwaits(root));
  expect(msg).toContain('"run z" exited 2 (failure)');
  expect(msg).toContain("lab/vm/plab test truenas-scale");
  expect(msg).toContain(path.join(root, "z", "log"));
  expect(msg).toContain("FAILED test_x");
});

test("the helper runs the command detached and records its exit code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "await-bin-"));
  const awaits = path.join(dir, "awaits");
  const bin = path.join(dir, "agetor-await");
  writeFileSync(bin, AWAIT_SCRIPT.replaceAll(path.join(path.dirname(path.dirname(bin)), "x"), "x").replace(/d="[^"]*\/\$id"/, `d="${awaits}/$id"`), { mode: 0o755 });
  const p = Bun.spawnSync([bin, "quick", "--", "sh", "-c", "echo hello; exit 3"], { cwd: dir });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("end your turn");
  for (let i = 0; i < 50 && !listAwaits(awaits)[0]?.finished; i++) await Bun.sleep(100);
  const [a] = listAwaits(awaits);
  expect(a).toMatchObject({ label: "quick", finished: true, exitCode: 3 });
});

// ── Deadlines (no sleeps: time is the `now` argument, liveness a set) ─────

import { existsSync, readFileSync } from "node:fs";
import {
  AWAIT_KILL_GRACE_MS,
  awaitLimitMs,
  ciWaitTimeoutMinutes,
  enforceAwaitDeadlines,
  parseAwaitMaxMinutes,
  resetAwaitCacheForTests,
} from "./awaits.ts";

const MIN = 60_000;
const parked = (wt: string) =>
  [
    {
      id: "p",
      archivedAt: null,
      worktreePath: wt,
      pipelineRun: {
        blocked: [{ taskId: "s1", stepId: "review", kind: "await", message: "" }],
        history: [{ taskId: "s1", stepId: "review", seq: 1, startedAt: 1_000_000 }],
        active: [{ taskId: "s1", stepId: "review", seq: 1 }],
      },
    },
  ] as unknown as Task[];

test("deadline: 2 h by default, the preference, --max from the record; capped at 12 h", () => {
  expect(parseAwaitMaxMinutes(null)).toBe(120);
  expect(parseAwaitMaxMinutes("240")).toBe(240);
  expect(parseAwaitMaxMinutes('{"minutes": 30}')).toBe(30);
  expect(parseAwaitMaxMinutes("0")).toBe(120);
  expect(parseAwaitMaxMinutes("soon")).toBe(120);
  expect(parseAwaitMaxMinutes("5000")).toBe(720);
  const cmd = "python3 poll.py ";
  expect(awaitLimitMs({ cmd, maxSeconds: null })).toBe(120 * MIN);
  expect(awaitLimitMs({ cmd, maxSeconds: null }, 45)).toBe(45 * MIN);
  expect(awaitLimitMs({ cmd, maxSeconds: 4 * 3600 }, 45)).toBe(240 * MIN);
  expect(awaitLimitMs({ cmd, maxSeconds: 20 * 3600 })).toBe(720 * MIN);

  // Written into the record on first sight.
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  record(root, "d", { cwd: "/w", started: 1000, pid: 4242 });
  writeFileSync(path.join(root, "d", "max"), String(4 * 3600)); // as `--max 4h` leaves it
  resetAwaitCacheForTests();
  const live = (pid: number | null) => pid === 4242;
  enforceAwaitDeadlines(listAwaits(root, live), 1_000_000, { prefMinutes: 30, kill: () => {} }, live);
  expect(Number(readFileSync(path.join(root, "d", "deadline"), "utf8"))).toBe(1000 + 4 * 3600);
});

test("deadline: a ci-wait is never cut shorter than its own --timeout", () => {
  expect(ciWaitTimeoutMinutes("/Users/x/.agetor/bin/ci-wait --timeout 240 ")).toBe(240);
  expect(ciWaitTimeoutMinutes("ci-wait ")).toBe(90);
  expect(ciWaitTimeoutMinutes("make test ")).toBeNull();
  expect(awaitLimitMs({ cmd: "/Users/x/.agetor/bin/ci-wait --timeout 240 ", maxSeconds: null })).toBe(255 * MIN);
  expect(awaitLimitMs({ cmd: "ci-wait --timeout 240 ", maxSeconds: 3600 })).toBe(255 * MIN);
  expect(awaitLimitMs({ cmd: "ci-wait --timeout 900 ", maxSeconds: null })).toBe(915 * MIN); // its floor is not capped
  expect(awaitLimitMs({ cmd: "ci-wait ", maxSeconds: null })).toBe(120 * MIN);
  expect(awaitLimitMs({ cmd: "ci-wait ", maxSeconds: null }, 600)).toBe(600 * MIN);
});

test("expiry: SIGTERM at the deadline, SIGKILL a grace later, exit 124, the step woken once", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  const wt = mkdtempSync(path.join(tmpdir(), "wt-"));
  record(root, "h", { cwd: wt, started: 1000, pid: 4242, log: "waiting for results.json\n" });
  resetAwaitCacheForTests();
  const pids = new Set([4242]);
  const live = (pid: number | null) => pid != null && pids.has(pid);
  const kills: string[] = [];
  const notes: string[] = [];
  const deps = { prefMinutes: 120, kill: (pid: number, sig: string) => void kills.push(`${pid}:${sig}`), note: (_: unknown, t: string) => void notes.push(t) };
  const t0 = 1000 * 1000;
  const pass = (now: number) => enforceAwaitDeadlines(listAwaits(root, live), now, deps, live);

  pass(t0 + 119 * MIN);
  expect(kills).toEqual([]);
  expect(readyToWake(parked(wt), listAwaits(root, live))).toEqual([]);
  const due = t0 + 120 * MIN;
  pass(due);
  expect(kills).toEqual(["4242:SIGTERM"]);
  expect(notes).toEqual(['"run h" ran past its limit of 2.0 h — stopped it (exit 124); the step will be woken with its last lines']);
  pass(due + 15_000); // one tick later, inside the grace
  expect(kills).toEqual(["4242:SIGTERM"]);
  expect(readyToWake(parked(wt), listAwaits(root, live))).toEqual([]); // still running
  pass(due + AWAIT_KILL_GRACE_MS);
  expect(kills).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
  pids.delete(4242); // gone
  pass(due + AWAIT_KILL_GRACE_MS + 15_000);
  expect(readFileSync(path.join(root, "h", "exit"), "utf8")).toBe("124");
  const [a] = listAwaits(root, live);
  expect(a).toMatchObject({ finished: true, exitCode: 124, timedOutAt: due, deadlineAt: due });
  expect(readyToWake(parked(wt), listAwaits(root, live)).map((w) => w.done.map((x) => x.id))).toEqual([["h"]]);
  const msg = awaitResultMessage([a!]);
  expect(msg).toContain('"run h" was stopped by Agetor after 2.0 h: it ran past its limit of 2.0 h (exit 124, like timeout(1))');
  expect(msg).toContain("waiting for results.json");
  // Told once; nothing more to do for it.
  writeFileSync(path.join(root, "h", "notified"), "1");
  expect(readyToWake(parked(wt), listAwaits(root, live))).toEqual([]);
  expect(pass(due + 60 * MIN)).toEqual([]);
  expect(kills).toHaveLength(2);
  expect(notes).toHaveLength(1);
});

test("restart: the stored deadline holds, and an await already past it is stopped on the first pass", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  record(root, "r", { cwd: "/w", started: 1000, pid: 4242 });
  resetAwaitCacheForTests();
  const live = (pid: number | null) => pid === 4242;
  const kills: string[] = [];
  const kill = (pid: number, sig: string) => void kills.push(sig);
  enforceAwaitDeadlines(listAwaits(root, live), 1000 * 1000 + MIN, { prefMinutes: 120, kill }, live);
  expect(existsSync(path.join(root, "r", "deadline"))).toBe(true);
  // The core restarts (nothing cached) with a longer preference, 25 h later:
  // the deadline recorded at the start still applies.
  resetAwaitCacheForTests();
  enforceAwaitDeadlines(listAwaits(root, live), 1000 * 1000 + 25 * 60 * MIN, { prefMinutes: 600, kill }, live);
  expect(kills).toEqual(["SIGTERM"]);
  // Restarted again inside the grace: the stop resumes (SIGKILL), not repeated.
  resetAwaitCacheForTests();
  enforceAwaitDeadlines(listAwaits(root, live), 1000 * 1000 + 25 * 60 * MIN + AWAIT_KILL_GRACE_MS, { prefMinutes: 600, kill }, live);
  expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
});

test("a process gone with no exit record gets one at once and wakes its step", () => {
  const root = mkdtempSync(path.join(tmpdir(), "awaits-"));
  const wt = mkdtempSync(path.join(tmpdir(), "wt-"));
  record(root, "g", { cwd: wt, started: 1000, pid: 4243 });
  resetAwaitCacheForTests();
  const dead = () => false;
  const kills: string[] = [];
  const changed = enforceAwaitDeadlines(listAwaits(root, dead), 1000 * 1000 + MIN, { kill: (_p, s) => void kills.push(s) }, dead);
  expect(changed.map((a) => a.id)).toEqual(["g"]);
  expect(kills).toEqual([]);
  expect(readFileSync(path.join(root, "g", "exit"), "utf8")).toBe("lost");
  const all = listAwaits(root, dead);
  expect(all[0]).toMatchObject({ finished: true, exitCode: null, timedOutAt: null });
  expect(readyToWake(parked(wt), all).map((w) => w.stepTaskId)).toEqual(["s1"]);
  expect(awaitResultMessage(all)).toContain("stopped without an exit code");
  // Recorded once.
  expect(enforceAwaitDeadlines(listAwaits(root, dead), 1000 * 1000 + 2 * MIN, {}, dead)).toEqual([]);
});

test("the helper records --max (4h, minutes, capped at 12h) and refuses a bad one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "await-bin-"));
  const awaits = path.join(dir, "awaits");
  const bin = path.join(dir, "agetor-await");
  writeFileSync(bin, AWAIT_SCRIPT.replace(/d="[^"]*\/\$id"/, `d="${awaits}/$id"`), { mode: 0o755 });
  const run = (...args: string[]) => Bun.spawnSync([bin, ...args], { cwd: dir });
  const maxOf = (out: string) => {
    const d = /log: (.*)\/log/.exec(out)![1]!;
    return existsSync(path.join(d, "max")) ? readFileSync(path.join(d, "max"), "utf8") : null;
  };
  expect(maxOf(run("--max", "4h", "a", "--", "true").stdout.toString())).toBe("14400");
  expect(maxOf(run("--max=90", "b", "--", "true").stdout.toString())).toBe("5400");
  expect(maxOf(run("--max", "030m", "b", "--", "true").stdout.toString())).toBe("1800");
  const capped = run("--max", "13h", "c", "--", "true");
  expect(maxOf(capped.stdout.toString())).toBe("43200");
  expect(capped.stderr.toString()).toContain("capped at 12h");
  expect(maxOf(run("d", "--", "true").stdout.toString())).toBeNull();
  for (const bad of ["4x", "0", "h", ""]) expect(run("--max", bad, "e", "--", "true").exitCode).toBe(2);
});
