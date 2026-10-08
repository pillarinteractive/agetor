import type { BridgeReachability } from "./native-bridge.ts";

/**
 * The app's core child (core-child.ts) must not outlive the app. The app
 * kills it on quit, but a crash or force-quit skips that, so the child also
 * watches for itself and exits when either:
 *
 *   - its parent is gone — the original parent pid no longer exists, or the
 *     child was reparented (to launchd) because the parent died, or
 *   - the native bridge refuses connections for `refusedLimit` checks in a
 *     row. A bridge that times out instead is NOT counted: that's the app's
 *     event loop stalling (the very thing running the core in its own
 *     process works around), not the app going away.
 *
 * tmux-hosted agents are unaffected either way — they live in tmux's own
 * server, not under this process.
 */
export interface ParentWatchDeps {
  /** The parent pid recorded at startup. */
  parentPid: number;
  /** The current parent pid (`process.ppid`, read live). */
  currentParentPid(): number;
  isPidAlive(pid: number): boolean;
  pingBridge(timeoutMs: number): Promise<BridgeReachability>;
  onParentGone(reason: string): void;
  intervalMs?: number;
  refusedLimit?: number;
}

export function makeParentWatch(deps: ParentWatchDeps) {
  const intervalMs = deps.intervalMs ?? 3_000;
  const refusedLimit = deps.refusedLimit ?? 5;
  let refused = 0;
  let pinging = false;
  let gone = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const fire = (reason: string) => {
    if (gone) return;
    gone = true;
    stop();
    deps.onParentGone(reason);
  };

  /** One check. Exposed for tests; `start` runs it on an interval. */
  async function tick(): Promise<void> {
    if (gone) return;
    if (deps.currentParentPid() !== deps.parentPid) return fire("parent exited (reparented)");
    if (!deps.isPidAlive(deps.parentPid)) return fire("parent exited");
    if (pinging) return;
    pinging = true;
    try {
      const r = await deps.pingBridge(Math.max(500, intervalMs - 500));
      if (r === "refused") {
        if (++refused >= refusedLimit) fire("native bridge unreachable");
      } else {
        refused = 0;
      }
    } finally {
      pinging = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => void tick(), intervalMs);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
