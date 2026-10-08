import { test, expect } from "bun:test";
import { resolveCoreChildEntry, restartDelay, superviseCore, RESTART_MAX_MS, type CoreChild } from "./core-host.ts";

/** A fake child whose exit the test controls. */
function fakeChild(pid: number) {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => (exit = r));
  const kills: (string | number | undefined)[] = [];
  const child: CoreChild = {
    pid,
    exited,
    kill: (sig) => {
      kills.push(sig);
      exit(143);
    },
  };
  return { child, exit, kills };
}

function harness() {
  const children: ReturnType<typeof fakeChild>[] = [];
  const healthy = new Set<number>();
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  const host = superviseCore({
    spawn: () => {
      const c = fakeChild(1000 + children.length);
      children.push(c);
      return c.child;
    },
    isHealthy: async (pid) => healthy.has(pid),
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      await Bun.sleep(0);
    },
    now: () => clock,
  });
  return { host, children, healthy, sleeps, logs, advance: (ms: number) => (clock += ms) };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
};

test("ready resolves once the spawned core is healthy", async () => {
  const h = harness();
  await until(() => h.children.length === 1);
  h.healthy.add(1000);
  await h.host.ready;
  expect(h.host.pid()).toBe(1000);
});

test("ready rejects if the core exits during its first boot", async () => {
  const h = harness();
  await until(() => h.children.length === 1);
  h.children[0]!.exit(1);
  await expect(h.host.ready).rejects.toThrow(/exited during boot \(code 1\)/);
});

test("a crashed core is restarted with growing, capped backoff", async () => {
  const h = harness();
  h.healthy.add(1000);
  await h.host.ready;

  // Crash right away, twice: delays double.
  h.children[0]!.exit(1);
  await until(() => h.children.length === 2);
  h.healthy.add(1001);
  await until(() => h.logs.some((l) => l.includes("restarted (pid 1001)")));
  h.children[1]!.exit(1);
  await until(() => h.children.length === 3);
  expect(h.sleeps.filter((ms) => ms >= 1_000)).toEqual([1_000, 2_000]);

  // A core that stays up a while resets the backoff.
  h.healthy.add(1002);
  await until(() => h.logs.some((l) => l.includes("restarted (pid 1002)")));
  h.advance(120_000);
  h.children[2]!.exit(1);
  await until(() => h.children.length === 4);
  expect(h.sleeps.filter((ms) => ms >= 1_000).at(-1)).toBe(1_000);
  h.host.stop();
});

test("stop() kills the core and doesn't restart it", async () => {
  const h = harness();
  h.healthy.add(1000);
  await h.host.ready;
  h.host.stop();
  expect(h.children[0]!.kills).toEqual(["SIGTERM"]);
  await Bun.sleep(20);
  expect(h.children.length).toBe(1);
});

test("restartDelay doubles from 1s and caps", () => {
  expect([1, 2, 3, 4].map(restartDelay)).toEqual([1_000, 2_000, 4_000, 8_000]);
  expect(restartDelay(50)).toBe(RESTART_MAX_MS);
});

test("resolveCoreChildEntry prefers the packaged copy beside the app bundle", () => {
  const exec = "/Applications/Agetor.app/Contents/MacOS/bun";
  const packaged = "/Applications/Agetor.app/Contents/Resources/app/bun/core-child.js";
  expect(resolveCoreChildEntry(exec, "/tmp/x", (p) => p === packaged)).toBe(packaged);
  expect(resolveCoreChildEntry(exec, "/src/bun", (p) => p === "/src/bun/core-child.ts")).toBe("/src/bun/core-child.ts");
  expect(resolveCoreChildEntry(exec, "/src/bun", () => false)).toBeNull();
});
