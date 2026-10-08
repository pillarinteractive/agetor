import { existsSync } from "node:fs";
import path from "node:path";

/**
 * App-side supervisor for the core child process (core-child.ts): spawns it
 * with the app's own bundled bun, waits until its API answers, and restarts
 * it with capped exponential backoff if it dies. Dependencies are injected so
 * the restart policy is testable without spawning anything.
 */

/** What the app hands its core child on stdin (a single JSON object), read
 *  before the core loads. Not env vars: Bun.spawn's default env is the
 *  environ a process was launched with, so anything passed that way would
 *  leak into every process the core spawns, deletes notwithstanding. */
export interface CoreChildBoot {
  /** The API token — chosen by the app so a restarted core keeps the token
   *  the webview already holds. */
  apiToken: string;
  bridgeUrl: string;
  bridgeToken: string;
}

export interface CoreChild {
  pid: number;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface CoreHostDeps {
  spawn(): CoreChild;
  /** True once the core in `pid` is serving (creds written, API answering). */
  isHealthy(pid: number): Promise<boolean>;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Restart delays: 1s doubling to 30s; reset once a child has stayed up
 *  `STABLE_MS`. */
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 30_000;
const STABLE_MS = 60_000;
const HEALTH_POLL_MS = 200;

export function restartDelay(consecutiveFailures: number): number {
  return Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

export function superviseCore(deps: CoreHostDeps) {
  let child: CoreChild | null = null;
  let stopping = false;
  let failures = 0;

  /** Spawn one child and resolve once it's healthy; reject if it exits
   *  first. */
  async function launch(): Promise<CoreChild> {
    const c = deps.spawn();
    child = c;
    let exited = false;
    void c.exited.then(() => {
      exited = true;
    });
    while (!exited && !stopping) {
      if (await deps.isHealthy(c.pid)) return c;
      await deps.sleep(HEALTH_POLL_MS);
    }
    throw new Error(`core exited during boot (code ${await c.exited})`);
  }

  /** Watch a healthy child; when it dies unexpectedly, relaunch after a
   *  backoff (the first boot already succeeded, so later failures retry
   *  rather than take the app down). */
  function watch(c: CoreChild): void {
    const upSince = deps.now();
    void c.exited.then(async (code) => {
      if (stopping || child !== c) return;
      failures = deps.now() - upSince >= STABLE_MS ? 1 : failures + 1;
      for (;;) {
        const delay = restartDelay(failures);
        deps.log(`core process ${c.pid} exited (code ${code}) — restarting in ${delay}ms`);
        await deps.sleep(delay);
        if (stopping) return;
        try {
          const next = await launch();
          deps.log(`core process restarted (pid ${next.pid})`);
          watch(next);
          return;
        } catch (err) {
          if (stopping) return;
          failures++;
          deps.log(`core restart failed: ${(err as Error)?.message ?? err}`);
        }
      }
    });
  }

  /** First boot: resolves when the core is serving, rejects if it fails. */
  const ready = launch().then((c) => {
    watch(c);
  });

  return {
    ready,
    /** Stop supervising and terminate the child (on app quit). */
    stop(): void {
      stopping = true;
      try {
        child?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
    pid: (): number | null => child?.pid ?? null,
  };
}

/** Where the bundled core entry lives: `Resources/app/bun/core-child.js`,
 *  next to the app's own bundle, or the source file when running from a
 *  checkout. Resolved from `process.execPath` (Contents/MacOS/bun) first
 *  because Electrobun can load the app bundle from a temp copy. */
export function resolveCoreChildEntry(
  execPath: string = process.execPath,
  here: string = import.meta.dir,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates = [
    path.join(path.dirname(execPath), "..", "Resources", "app", "bun", "core-child.js"),
    path.join(here, "core-child.js"),
    path.join(here, "core-child.ts"),
  ];
  return candidates.find((p) => exists(p)) ?? null;
}
