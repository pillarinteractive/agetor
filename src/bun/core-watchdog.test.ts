import { test, expect } from "bun:test";
import { makeParentWatch, type ParentWatchDeps } from "./core-watchdog.ts";
import type { BridgeReachability } from "./native-bridge.ts";

function setup(over: Partial<ParentWatchDeps> = {}) {
  const gone: string[] = [];
  const state = { ppid: 100, alive: true, ping: "ok" as BridgeReachability };
  const watch = makeParentWatch({
    parentPid: 100,
    currentParentPid: () => state.ppid,
    isPidAlive: () => state.alive,
    pingBridge: async () => state.ping,
    onParentGone: (r) => gone.push(r),
    refusedLimit: 3,
    ...over,
  });
  return { watch, state, gone };
}

test("stays up while the parent is alive and the bridge answers", async () => {
  const { watch, gone } = setup();
  for (let i = 0; i < 10; i++) await watch.tick();
  expect(gone).toEqual([]);
});

test("exits when the parent pid is gone", async () => {
  const { watch, state, gone } = setup();
  await watch.tick();
  state.alive = false;
  await watch.tick();
  await watch.tick();
  expect(gone).toEqual(["parent exited"]);
});

test("exits when reparented (the parent died and launchd adopted us)", async () => {
  const { watch, state, gone } = setup();
  state.ppid = 1;
  await watch.tick();
  expect(gone).toEqual(["parent exited (reparented)"]);
});

test("exits after the bridge refuses connections several checks in a row", async () => {
  const { watch, state, gone } = setup();
  state.ping = "refused";
  await watch.tick();
  await watch.tick();
  expect(gone).toEqual([]);
  // One good answer resets the count.
  state.ping = "ok";
  await watch.tick();
  state.ping = "refused";
  await watch.tick();
  await watch.tick();
  expect(gone).toEqual([]);
  await watch.tick();
  expect(gone).toEqual(["native bridge unreachable"]);
});

test("never exits over a stalled (timing-out) bridge", async () => {
  const { watch, state, gone } = setup();
  state.ping = "timeout";
  for (let i = 0; i < 20; i++) await watch.tick();
  expect(gone).toEqual([]);
});
