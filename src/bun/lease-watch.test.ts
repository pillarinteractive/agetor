import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalEvent, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// db.ts captures AGETOR_DATA_DIR at first import, so lease-watch.ts (which
// imports it) is loaded dynamically after the env var is set.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-lease-watch-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let lw: typeof import("./lease-watch.ts");
let preferences: typeof import("./db.ts").preferences;
let subscribeGlobal: typeof import("./orchestrator.ts").subscribeGlobal;

beforeAll(async () => {
  lw = await import("./lease-watch.ts");
  ({ preferences } = await import("./db.ts"));
  ({ subscribeGlobal } = await import("./orchestrator.ts"));
});

afterEach(() => {
  preferences.set(lw.LEASE_WATCHERS_PREF, "");
  lw.resetLeaseWatchForTests();
});

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "t",
    title: "Task",
    prompt: "",
    column: "running",
    agent: "claude-code",
    workdir: "/repo",
    isolation: "worktree",
    worktreePath: null,
    archivedAt: null,
    pipelineParentId: null,
    ...overrides,
  } as Task;
}

test("parseLeaseWatchers keeps valid rows, drops malformed ones, clamps the interval", () => {
  const raw = JSON.stringify([
    { project: "/repo", label: "lab", command: "plab lease --json" },
    { project: "/repo", label: "fast", command: "x", intervalSec: 1 },
    { project: "/repo", label: "", command: "x" },
    { label: "no project", command: "x" },
    "junk",
  ]);
  expect(lw.parseLeaseWatchers(raw)).toEqual([
    { project: "/repo", label: "lab", command: "plab lease --json", intervalSec: 30 },
    { project: "/repo", label: "fast", command: "x", intervalSec: 5 },
  ]);
  expect(lw.parseLeaseWatchers("not json")).toEqual([]);
  expect(lw.parseLeaseWatchers(null)).toEqual([]);
});

test("parseLeaseProbeOutput reads the last line and requires a boolean held", () => {
  expect(lw.parseLeaseProbeOutput('log line\n{"held": false}\n')).toEqual({
    ok: true, held: false, checkout: null, owner: null, since: null,
  });
  expect(lw.parseLeaseProbeOutput('{"held": true, "checkout": "/wt", "owner": "me", "since": "t"}')).toEqual({
    ok: true, held: true, checkout: "/wt", owner: "me", since: "t",
  });
  expect(lw.parseLeaseProbeOutput("").ok).toBe(false);
  expect(lw.parseLeaseProbeOutput("free").ok).toBe(false);
  expect(lw.parseLeaseProbeOutput('{"held": "yes"}').ok).toBe(false);
});

test("resolveHolderTask maps a checkout to its card, lifting a step to its pipeline parent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-lease-holder-"));
  const wt = path.join(root, "worktrees", "parent");
  mkdirSync(wt, { recursive: true });
  const alias = path.join(root, "alias");
  symlinkSync(wt, alias);
  const parent = makeTask({ id: "parent", worktreePath: wt });
  const step = makeTask({ id: "step", worktreePath: wt, pipelineParentId: "parent" });
  const archived = makeTask({ id: "old", worktreePath: path.join(root, "old"), archivedAt: 1 });
  const inPlace = makeTask({ id: "inplace", isolation: "none", workdir: path.join(root, "repo") });

  // The step row shares its parent's worktree; whichever matches, the card is the parent.
  expect(lw.resolveHolderTask(alias, [step, parent])?.id).toBe("parent");
  expect(lw.resolveHolderTask(`${wt}/`, [parent])?.id).toBe("parent");
  expect(lw.resolveHolderTask(path.join(root, "old"), [archived])).toBeNull();
  expect(lw.resolveHolderTask(path.join(root, "repo"), [inPlace])?.id).toBe("inplace");
  expect(lw.resolveHolderTask("/nowhere", [parent])).toBeNull();
});

test("a tick probes each watcher, publishes on change only, and drops removed watchers", async () => {
  const events: GlobalEvent[] = [];
  const unsubscribe = subscribeGlobal((e) => { if (e.kind === "leases") events.push(e); });
  try {
    const project = mkdtempSync(path.join(tmpdir(), "agetor-lease-project-"));
    preferences.set(lw.LEASE_WATCHERS_PREF, JSON.stringify([
      { project, label: "lab", command: `printf '{"held": true, "checkout": "/elsewhere", "owner": "me@host"}\\n'` },
    ]));
    await Promise.all(lw.leaseWatchTick(1_000_000));
    expect(lw.listLeases()).toMatchObject([
      { project, label: "lab", held: true, checkout: "/elsewhere", owner: "me@host", holderTaskId: null, error: null },
    ]);
    expect(events).toHaveLength(1);

    // Not due yet: no probe.
    expect(lw.leaseWatchTick(1_000_000 + 1_000)).toHaveLength(0);
    // Due, unchanged: probes but doesn't republish.
    await Promise.all(lw.leaseWatchTick(1_000_000 + 31_000));
    expect(events).toHaveLength(1);

    // A failing probe keeps the last holder and reports the error.
    preferences.set(lw.LEASE_WATCHERS_PREF, JSON.stringify([{ project, label: "lab", command: "echo boom >&2; exit 3" }]));
    await Promise.all(lw.leaseWatchTick(1_000_000 + 62_000));
    expect(lw.listLeases()[0]).toMatchObject({ held: true, checkout: "/elsewhere", error: "exited 3: boom" });
    expect(events).toHaveLength(2);

    preferences.set(lw.LEASE_WATCHERS_PREF, "[]");
    await Promise.all(lw.leaseWatchTick(1_000_000 + 93_000));
    expect(lw.listLeases()).toEqual([]);
    expect(events).toHaveLength(3);
  } finally {
    unsubscribe();
  }
});
