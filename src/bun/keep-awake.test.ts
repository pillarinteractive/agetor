import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

// db.ts (imported by the module) captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-keep-awake-"));
const { KeepAwake, hasRunningWork, keepAwakeEnabled } = await import("./keep-awake.ts");

const task = (overrides: Partial<Task>) => ({ id: "t", column: "review", archivedAt: null, ...overrides }) as Task;

describe("keepAwakeEnabled", () => {
  test("on by default on macOS, off when the preference says false, never elsewhere", () => {
    expect(keepAwakeEnabled(null, "darwin")).toBe(true);
    expect(keepAwakeEnabled("true", "darwin")).toBe(true);
    expect(keepAwakeEnabled("false", "darwin")).toBe(false);
    expect(keepAwakeEnabled(null, "linux")).toBe(false);
  });
});

describe("hasRunningWork", () => {
  test("any live task in Running counts; archived or idle ones don't", () => {
    expect(hasRunningWork([task({ column: "review" }), task({ column: "running" })])).toBe(true);
    expect(hasRunningWork([task({ column: "running", archivedAt: 1 }), task({ column: "blocked" })])).toBe(false);
    expect(hasRunningWork([])).toBe(false);
  });
});

describe("KeepAwake", () => {
  function fakeSpawn() {
    const spawned: { argv: string[]; killed: boolean; exit: () => void }[] = [];
    const spawn = (argv: string[]) => {
      let exit!: () => void;
      const exited = new Promise<number>((resolve) => { exit = () => resolve(0); });
      const entry = { argv, killed: false, exit };
      spawned.push(entry);
      return { exited, kill: () => { entry.killed = true; exit(); } } as never;
    };
    return { spawned, spawn };
  }

  test("holds one caffeinate tied to this process while wanted, releases it when not", () => {
    const { spawned, spawn } = fakeSpawn();
    const ka = new KeepAwake(spawn);
    ka.set(true);
    ka.set(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.argv).toEqual(["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)]);
    expect(ka.held).toBe(true);
    ka.set(false);
    expect(spawned[0]!.killed).toBe(true);
    expect(ka.held).toBe(false);
  });

  test("a caffeinate that exits on its own is replaced on the next check", async () => {
    const { spawned, spawn } = fakeSpawn();
    const ka = new KeepAwake(spawn);
    ka.set(true);
    spawned[0]!.exit();
    await Promise.resolve();
    await Promise.resolve();
    expect(ka.held).toBe(false);
    ka.set(true);
    expect(spawned).toHaveLength(2);
  });
});
