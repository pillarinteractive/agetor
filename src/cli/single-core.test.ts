import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "../bun/test-data-dir.ts";
import { coreCredsPath, isPortBound, readCoreCreds, removeOwnCoreCreds, writeCoreCreds, type CoreCreds } from "../bun/core-creds.ts";
import { coreOccupied, ensureCore } from "./daemon/supervisor.ts";

const dirs: string[] = [];
const servers: Server[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agetor-single-core-"));
  dirs.push(dir);
  return dir;
}
/** A core whose event loop is stuck: the port accepts connections, nothing answers. */
function silentListener(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(() => undefined);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
const creds = (port: number, pid: number): CoreCreds => ({ port, token: "t", pid, kind: "app", version: "0", startedAt: Date.now() });
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
afterAll(() => { for (const d of dirs) rmTestDataDir(d); });

test("isPortBound tells a silent listener from a free port", async () => {
  expect(await isPortBound(await silentListener(), 500)).toBe(true);
  expect(await isPortBound(await freePort(), 500)).toBe(false);
});

test("a core that is alive but not answering is waited for, never replaced", async () => {
  const dir = dataDir();
  writeCoreCreds(creds(await silentListener(), process.pid), dir);
  expect(await coreOccupied({ dataDir: dir })).toMatchObject({ pid: process.pid });
  await expect(ensureCore({ dataDir: dir, busyWaitMs: 300 })).rejects.toThrow(/Not starting a second core/);
  expect(readCoreCreds(dir)?.pid).toBe(process.pid); // untouched: no daemon took over
});

test("a bound API port with no creds file still blocks a second core", async () => {
  const dir = dataDir();
  const port = await silentListener();
  expect(await coreOccupied({ dataDir: dir, port })).toEqual({ pid: null, port });
  await expect(ensureCore({ dataDir: dir, port, busyWaitMs: 300 })).rejects.toThrow(/Not starting a second core/);
});

test("nothing running: not occupied, and --no-daemon reports no core", async () => {
  const dir = dataDir();
  const port = await freePort();
  expect(await coreOccupied({ dataDir: dir, port })).toBeNull();
  await expect(ensureCore({ dataDir: dir, port, noDaemon: true })).rejects.toThrow(/No Agetor core is running/);
});

test("stale creds from a dead process on a free port do not count as a core", async () => {
  const dir = dataDir();
  writeCoreCreds(creds(await freePort(), 2 ** 22 + 12345), dir);
  expect(await coreOccupied({ dataDir: dir })).toBeNull();
});

test("removeOwnCoreCreds leaves another core's file alone", () => {
  const dir = dataDir();
  writeCoreCreds(creds(1, process.pid + 1), dir);
  removeOwnCoreCreds(dir);
  expect(existsSync(coreCredsPath(dir))).toBe(true);
  writeCoreCreds(creds(1, process.pid), dir);
  removeOwnCoreCreds(dir);
  expect(existsSync(coreCredsPath(dir))).toBe(false);
});
