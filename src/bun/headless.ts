import pkg from "../../package.json" with { type: "json" };
import { dataDir, db, subagents } from "./db.ts";
import { isPidAlive, isPortBound, readCoreCreds } from "./core-creds.ts";
import { getApiPort } from "./api-config.ts";
import { attachedClientCount } from "./server.ts";
import { startCore, shutdownCore } from "./core-main.ts";
import { daemonLog } from "./daemon-log.ts";

/**
 * Headless Agetor core — the same Bun server + orchestrator the desktop app
 * runs, minus Electrobun (no window, menu, updater, or before-quit confirm).
 * The `agetor` CLI auto-spawns this when no live core exists so the CLI works
 * with the app closed; it shares the same `$AGETOR_DATA_DIR` state, so tasks
 * created here also show up in the app.
 *
 * `runDaemon` is exported (not run on import) so the compiled CLI binary can
 * carry the server stack but only boot it under the hidden `__daemon`
 * subcommand — every client command lazy-loads this module, so `bun src/cli`
 * never opens the database just to run `agetor ls`.
 */

const IDLE_CHECK_MS = 30_000;
/** Default idle-shutdown after 5 min with no run, no running background
 *  agent/workflow, and no attached client.
 *  `AGETOR_DAEMON_IDLE_MS=0` disables idle shutdown (daemon stays up). */
const IDLE_TIMEOUT_MS = Number(
  process.env.AGETOR_DAEMON_IDLE_MS ?? 5 * 60 * 1000,
);

/** Ceiling on how long a `running` subagent row alone can hold the daemon up.
 *  Two row classes can never settle on their own: workflow container rows are
 *  deliberately exempt from the `STALE_SUBAGENT_SETTLE_MS` backstop
 *  (claude-subagents.ts) — they're settled only by their completion
 *  notification or user action — and rows created while
 *  `AGETOR_TRACK_SUBAGENTS=0` is set are no-op stubs nothing will ever flip
 *  to `completed`. Without a ceiling either one pins the daemon alive
 *  forever. Past this ceiling the daemon may idle-exit exactly as it did
 *  before this feature existed: the detached tmux session survives the exit,
 *  and the next boot's `reconcileOrphans` reattaches or orphans it. */
const SUBAGENT_HOLD_MAX_MS = 6 * 60 * 60 * 1000; // 6h

/** Set once a swallowed `hasRunningWork` error has been logged, so a
 *  sustained failure (e.g. SQLITE_BUSY) doesn't spam the log every 30s —
 *  but a daemon that idle-exited during a DB failure window is still
 *  diagnosable from the single line it did emit. */
let loggedHasRunningWorkError = false;

function hasRunningRuns(): boolean {
  try {
    return (
      db
        .query<{ one: number }, []>(
          "SELECT 1 AS one FROM runs WHERE status = 'running' LIMIT 1",
        )
        .get() != null
    );
  } catch {
    return false;
  }
}

/** Daemon-wide "is anything still working?" — running runs OR running
 *  background agents/workflows (subagent rows started within
 *  `SUBAGENT_HOLD_MAX_MS`). Exported for tests. */
export function hasRunningWork(): boolean {
  if (hasRunningRuns()) return true;
  try {
    return subagents.hasAnyRunning(Date.now() - SUBAGENT_HOLD_MAX_MS);
  } catch (err) {
    if (!loggedHasRunningWorkError) {
      loggedHasRunningWorkError = true;
      daemonLog(
        `hasRunningWork: subagents.hasAnyRunning failed, treating as idle: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    return false;
  }
}

function shutdown(reason: string, code = 0): void {
  // fx-acp.ts's own SIGINT/SIGTERM handlers step back once this module
  // registers its own (below), so shutdownCore owns the exit sequence —
  // including reaping live fx children and stopping auto-resume timers.
  shutdownCore(reason, daemonLog, code);
}

export async function runDaemon(): Promise<void> {
  process.env.AGETOR_HEADLESS = "1";
  daemonLog(`cli-daemon starting — pid ${process.pid}, version ${pkg.version}`);

  // Same boot as the app's core (core-main.ts): PATH hydration, orphan
  // reconciliation before the API serves, the API itself, the creds file and
  // every background loop. A busy port held by a live core exits quietly.
  // Every loop timer is unref'd, so the idle-shutdown path below stays
  // reachable.
  // Before touching any state: startCore reconciles orphaned runs ahead of
  // binding the port, so a daemon started beside a live (even unresponsive)
  // core would rewrite that core's runs before finding the port taken.
  const other = readCoreCreds(dataDir);
  if ((other && other.pid !== process.pid && isPidAlive(other.pid)) || (await isPortBound(getApiPort()))) {
    daemonLog("another core already owns this data dir or API port — exiting without touching state");
    process.exit(0);
  }
  await startCore({ kind: "cli-daemon", log: daemonLog }); // no native → native routes 501

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Idle-shutdown loop: exit once nothing is running AND no client is attached
  // for longer than the timeout. The interval is unref'd so it never keeps the
  // process alive on its own — the listening server does that.
  if (IDLE_TIMEOUT_MS > 0) {
    let idleSince: number | null = null;
    const timer = setInterval(() => {
      if (hasRunningWork() || attachedClientCount() > 0) {
        idleSince = null;
        return;
      }
      if (idleSince == null) idleSince = Date.now();
      else if (Date.now() - idleSince >= IDLE_TIMEOUT_MS) shutdown("idle timeout");
    }, IDLE_CHECK_MS);
    timer.unref();
  }
}

// `bun src/bun/headless.ts` runs the daemon directly (dev); importing this
// module from the CLI bundle does not.
if (import.meta.main) void runDaemon();
