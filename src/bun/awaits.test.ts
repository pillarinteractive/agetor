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
