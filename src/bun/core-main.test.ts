import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-core-main-"));

const { startCore, resetCoreForTests, coreDeps } = await import("./core-main.ts");
type CoreDeps = typeof coreDeps;
type CoreCreds = import("./core-creds.ts").CoreCreds;

/** Fake deps that count every call; nothing real starts. */
function fakeDeps(over: Partial<CoreDeps> = {}) {
  const calls = new Map<string, number>();
  const written: CoreCreds[] = [];
  const order: string[] = [];
  const deps = {} as Record<string, unknown>;
  for (const key of Object.keys(coreDeps)) {
    deps[key] = (...args: unknown[]) => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      order.push(key);
      switch (key) {
        case "ensureDisclaimedServer":
        case "reconcileOrphans":
        case "refreshAllModels":
        case "reapIdleSessions":
        case "pollAllUsage":
        case "backfillIssues":
          return Promise.resolve();
        case "reconcilePipelineRuns":
        case "rearmFxAutoResumes":
          return Promise.resolve(0);
        case "startApiServer":
          return { port: 4999, stop() {} };
        case "writeCoreCreds":
          written.push(args[0] as CoreCreds);
          return;
        case "readCoreCreds":
          return null;
        case "probeLiveCore":
          return Promise.resolve(false);
        case "waitForPortFree":
          return Promise.resolve(true);
        case "exit":
          throw new Error(`exit(${args[0]})`);
      }
    };
  }
  return { deps: { ...(deps as CoreDeps), ...over }, calls, written, order };
}

const LOOPS = [
  "startPeriodicDiscovery",
  "startLeaseWatchLoop",
  "startKeepAwakeLoop",
  "startPrWatchLoop",
  "startProgressWatchLoop",
  "startDependencyLoop",
  "startMergeQueueLoop",
  "startPublishLoop",
  "startSlotScheduler",
  "startAwaitLoop",
  "startBranchSweep",
  "startAutopilot",
  "startStallMonitor",
  "backfillIssues",
  "sweepArchivedTeardowns",
  "refreshAllModels",
] as const;

beforeEach(() => resetCoreForTests());

test("startCore boots the core and starts every background loop exactly once", async () => {
  const { deps, calls, written, order } = fakeDeps();
  const log: string[] = [];
  await startCore({ kind: "app", log: (m) => log.push(m) }, deps);
  // A second call (e.g. a stray re-import) doesn't boot again.
  await startCore({ kind: "app", log: (m) => log.push(m) }, deps);

  for (const loop of LOOPS) expect([loop, calls.get(loop)]).toEqual([loop, 1]);
  expect(calls.get("startApiServer")).toBe(1);
  // Reconcile strictly before the API serves.
  expect(order.indexOf("ensureDisclaimedServer")).toBeLessThan(order.indexOf("reconcileOrphans"));
  expect(order.indexOf("initPipelineRunner")).toBeLessThan(order.indexOf("reconcileOrphans"));
  expect(order.indexOf("reconcileOrphans")).toBeLessThan(order.indexOf("startApiServer"));
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ port: 4999, kind: "app", pid: process.pid });
});

test("the cli-daemon gets the same loops and its own creds kind", async () => {
  const { deps, calls, written } = fakeDeps();
  await startCore({ kind: "cli-daemon", log: () => {} }, deps);
  for (const loop of LOOPS) expect([loop, calls.get(loop)]).toEqual([loop, 1]);
  expect(written[0]?.kind).toBe("cli-daemon");
});

const liveDaemon: CoreCreds = {
  port: 4999,
  token: "t",
  pid: process.pid,
  kind: "cli-daemon",
  version: "1",
  startedAt: 0,
};

test("a cli-daemon finding a live core on its port exits quietly", async () => {
  const { deps } = fakeDeps({
    startApiServer: () => {
      throw new Error("EADDRINUSE");
    },
    readCoreCreds: () => liveDaemon,
    probeLiveCore: async () => true,
  });
  await expect(startCore({ kind: "cli-daemon", log: () => {} }, deps)).rejects.toThrow("exit(0)");
});

test("the app's core waits for the port to free and binds after all", async () => {
  let binds = 0;
  const { deps, calls, written } = fakeDeps({
    startApiServer: (() => {
      if (binds++ === 0) throw new Error("EADDRINUSE");
      return { port: 4999, stop() {} };
    }) as unknown as CoreDeps["startApiServer"],
    // Owner isn't live (e.g. the previous app's core child still exiting).
    readCoreCreds: () => ({ ...liveDaemon, kind: "app" }),
  });
  await startCore({ kind: "app", log: () => {} }, deps);
  expect(binds).toBe(2);
  expect(calls.get("waitForPortFree")).toBe(1);
  expect(written[0]?.kind).toBe("app");
});

test("the app's core exits loudly when the port never frees", async () => {
  const { deps } = fakeDeps({
    startApiServer: () => {
      throw new Error("EADDRINUSE");
    },
    waitForPortFree: async () => false,
  });
  const log: string[] = [];
  await expect(startCore({ kind: "app", log: (m) => log.push(m) }, deps)).rejects.toThrow("exit(1)");
});
