import pkg from "../../package.json" with { type: "json" };
import { API_TOKEN, getApiPort } from "./api-config.ts";
import { dataDir } from "./db.ts";
import {
  reconcileOrphans,
  rearmFxAutoResumes,
  sweepArchivedTeardowns,
  sweepDoneTeardowns,
  reapIdleSessions,
  stopFxAutoResumeTimers,
} from "./orchestrator.ts";
import { initPipelineRunner, reconcilePipelineRuns, rearmPipelineAutoRetries, startSlotScheduler, stopPipelineAutoRetryTimers } from "./pipeline-runner.ts";
import { ensureDisclaimedServer } from "./tmux-resolution.ts";
import { startApiServer, type ApiNative } from "./server.ts";
import { rehydratePath } from "./login-path.ts";
import { refreshAllModels, startPeriodicDiscovery } from "./model-discovery.ts";
import { reapLiveFxProcs } from "./fx-acp.ts";
import { pollAllUsage } from "./usage/poller.ts";
import { startLeaseWatchLoop } from "./lease-watch.ts";
import { startKeepAwakeLoop } from "./keep-awake.ts";
import { startPrWatchLoop } from "./pr-watch.ts";
import { startProgressWatchLoop } from "./progress-watch.ts";
import { startDependencyLoop } from "./dependencies.ts";
import { startMergeQueueLoop } from "./merge-queue.ts";
import { startAwaitLoop } from "./awaits.ts";
import { startBranchSweep } from "./branch-sweep.ts";
import { startAutopilot } from "./autopilot.ts";
import { startStallMonitor } from "./stall-monitor.ts";
import { backfillIssues } from "./auto-issue.ts";
import {
  writeCoreCreds,
  removeOwnCoreCreds,
  readCoreCreds,
  probeLiveCore,
  waitForPortFree,
  type CoreCreds,
} from "./core-creds.ts";
import { SESSION_REAP_SWEEP_MS, USAGE_POLL_SWEEP_MS } from "../shared/types.ts";

/**
 * The Agetor core — database, orchestrator, the localhost HTTP API and every
 * background loop — started the same way by both of its hosts:
 *
 *   - the app's core child process (core-child.ts, `kind: "app"`), which gets
 *     a `native` that proxies to the app over the native bridge, and
 *   - the headless CLI daemon (headless.ts, `kind: "cli-daemon"`), which gets
 *     none, so native-only routes return 501.
 *
 * One function so the two can't drift apart in which loops they run. The
 * module only defines things; nothing starts on import.
 */

export interface StartCoreOptions {
  native?: ApiNative;
  /** Which surface owns the port — written to the creds file, and decides
   *  what happens when the port is busy (see `bindApi`). */
  kind: CoreCreds["kind"];
  /** Where boot/loop diagnostics go: the console for the app's core, the
   *  daemon log for the CLI daemon (which has no console anyone sees). */
  log?: (message: string) => void;
}

/** Everything `startCore` calls, injectable so a test can check each loop is
 *  started exactly once without booting the real thing. */
export const coreDeps = {
  rehydratePath,
  ensureDisclaimedServer,
  initPipelineRunner,
  reconcileOrphans,
  reconcilePipelineRuns,
  rearmPipelineAutoRetries,
  rearmFxAutoResumes,
  sweepArchivedTeardowns,
  sweepDoneTeardowns,
  reapIdleSessions,
  pollAllUsage,
  refreshAllModels,
  startPeriodicDiscovery,
  startApiServer,
  writeCoreCreds,
  readCoreCreds,
  probeLiveCore,
  waitForPortFree,
  startLeaseWatchLoop,
  startKeepAwakeLoop,
  startPrWatchLoop,
  startProgressWatchLoop,
  startDependencyLoop,
  startMergeQueueLoop,
  startSlotScheduler,
  startAwaitLoop,
  startBranchSweep,
  startAutopilot,
  startStallMonitor,
  backfillIssues,
  exit: (code: number): never => process.exit(code),
};
export type CoreDeps = typeof coreDeps;

type ApiServer = ReturnType<typeof startApiServer>;

let started: Promise<ApiServer> | null = null;

/** Boot the core once per process; a second call returns the first boot. */
export function startCore(opts: StartCoreOptions, deps: CoreDeps = coreDeps): Promise<ApiServer> {
  started ??= boot(opts, deps);
  return started;
}

/** Test hook: forget a previous `startCore` so the next call boots again. */
export function resetCoreForTests(): void {
  started = null;
}

async function boot(opts: StartCoreOptions, deps: CoreDeps): Promise<ApiServer> {
  const log = opts.log ?? ((m: string) => console.log(`[agetor] ${m}`));

  // A packaged app (or a daemon spawned by it) gets launchd's minimal PATH.
  // Source the user's login-shell PATH so `Bun.which("claude")` / "codex" /
  // "tmux" find what's installed. Idempotent.
  deps.rehydratePath();

  // Must run before reconcileOrphans(): reconciliation issues `has-session`
  // probes against agetor's tmux socket, and the first tmux command to
  // touch a socket auto-starts its server — un-disclaimed, if this didn't
  // run first — leaving every session that server ever hosts un-disclaimed
  // too.
  await deps.ensureDisclaimedServer();
  // Subscribe the pipeline runner to the global lifecycle stream BEFORE
  // reconcileOrphans() runs, so a step task's boot-time orphan→ready
  // transition reaches the runner and flips its pipeline parent back
  // instead of leaving it stuck `running` (docs/plans/pipelines.md §3, T3).
  deps.initPipelineRunner();
  // Mark runs left "running" by a previous process orphaned (or reattach
  // them). Awaited so the API below never serves `/tasks`/`/runs` while a
  // stale `status='running'` row is still being resolved underneath it — the
  // "reconcile before the API starts" invariant (CLAUDE.md §5). A throw fails
  // boot loudly — no swallow.
  await deps.reconcileOrphans();
  // M16: then every pipeline parent left mid-flight by a crash/restart, now
  // that every step task's own orphan→ready transition has fired.
  const reconciledPipelineRunCount = await deps.reconcilePipelineRuns();
  if (reconciledPipelineRunCount > 0) log(`reconciled ${reconciledPipelineRunCount} pipeline run(s)`);
  // Automatic retries waiting on a usage-limit reset or a transient-failure
  // backoff (pipeline-runner.ts `scheduleAutoRetry`) are persisted on the run;
  // their timers aren't.
  const rearmedAutoRetryCount = deps.rearmPipelineAutoRetries();
  if (rearmedAutoRetryCount > 0) log(`re-armed ${rearmedAutoRetryCount} automatic step retr${rearmedAutoRetryCount === 1 ? "y" : "ies"}`);
  // Re-arm in-memory auto-resume timers for every fx task still carrying a
  // pending schedule (docs/plans/fx-recovery-follow-ups.md §3 T2 item 9) — a
  // `setTimeout` handle never survives a process restart.
  const rearmedFxAutoResumeCount = await deps.rearmFxAutoResumes();
  if (rearmedFxAutoResumeCount > 0) log(`re-armed ${rearmedFxAutoResumeCount} fx auto-resume(s)`);

  // Heal any archive/delete teardown that was queued in memory but never ran
  // because the previous core quit or crashed first. Only enqueues jobs.
  deps.sweepArchivedTeardowns();

  // Probe the agent CLIs (and every enabled fx harness's account-scoped
  // catalog) for their model lists in the background; the webview polls
  // GET /agent-models/harnesses' `ready` flag until this lands
  // (docs/plans/fx-model-catalog-refresh.md §2). The periodic re-sweep is
  // unref'd internally.
  void deps.refreshAllModels();
  deps.startPeriodicDiscovery();

  const server = await bindApi(opts, deps, log);

  // Publish the per-launch port + token so the CLI (and the app, for its
  // core child) can discover and authenticate to this core.
  const ownCreds: CoreCreds = {
    // `server.port` is typed `number | undefined`, but a bound server
    // always has a numeric port.
    port: server.port!,
    token: API_TOKEN,
    pid: process.pid,
    kind: opts.kind,
    version: pkg.version,
    startedAt: Date.now(),
  };
  deps.writeCoreCreds(ownCreds, dataDir);
  // This process owns the API port, so it is the core. If the creds file is
  // lost or names someone else (a second core that started and exited beside
  // this one), publish ours again: without it the CLI finds no core.
  const credsGuard = setInterval(() => {
    try {
      if (!shuttingDown && deps.readCoreCreds(dataDir)?.pid !== process.pid) {
        deps.writeCoreCreds(ownCreds, dataDir);
        log("core creds file was missing or foreign — republished");
      }
    } catch {
      /* best-effort */
    }
  }, CREDS_GUARD_MS);
  credsGuard.unref?.();
  log(`core (${opts.kind}) listening on http://127.0.0.1:${server.port}`);

  // Stop the fx auto-resume engine's in-memory timers on the way out so a
  // timer can't fire mid-teardown. Touches no persisted `fxRecovery` row —
  // the next boot's `rearmFxAutoResumes()` re-arms from the DB.
  process.on("exit", stopFxAutoResumeTimers);

  // Background loops. Every timer here is unref'd: the listening server is
  // what keeps the process alive, so the CLI daemon's idle shutdown stays
  // reachable.

  // Done cards' worktrees: detached once they've sat in Done a while with
  // nothing running (branch kept; re-attaches on reopen). Best-effort.
  setInterval(() => {
    try {
      deps.sweepDoneTeardowns();
    } catch {
      // background hygiene only
    }
  }, 5 * 60_000).unref();

  // Idle-session reaper (docs/plans/reduce-cpu-and-memory.md §3.1, T4): kills
  // claude REPL tmux sessions that have sat idle. The 30s delay lets
  // reconcileOrphans' reattaches settle so a task mid-reattach isn't
  // mistaken for idle.
  const reap = (when: string) =>
    deps.reapIdleSessions().catch((err) => log(`idle-session reap (${when}) failed: ${errMessage(err)}`));
  setTimeout(() => void reap("post-boot"), 30_000).unref();
  setInterval(() => void reap("interval"), SESSION_REAP_SWEEP_MS).unref();

  // Per-harness usage poller (docs/plans/harness-usage-tracker.md §7) keeps
  // the topbar quota meters fresh. Offset 20s so it doesn't share a tick with
  // the reaper's first sweep.
  const pollUsage = (when: string) =>
    deps.pollAllUsage().catch((err) => log(`usage poll (${when}) failed: ${errMessage(err)}`));
  setTimeout(() => void pollUsage("post-boot"), 20_000).unref();
  setInterval(() => void pollUsage("sweep"), USAGE_POLL_SWEEP_MS).unref();

  // Lease badges (lease-watch.ts) — a no-op until `lease_watchers` is set.
  deps.startLeaseWatchLoop();
  // Hold a caffeinate assertion while any agent runs (keep-awake.ts).
  deps.startKeepAwakeLoop();
  // Follow each task's pull request (pr-watch.ts).
  deps.startPrWatchLoop();
  // Live progress of lab/E2E runs on running cards (progress-watch.ts).
  deps.startProgressWatchLoop();
  // Card dependencies (dependencies.ts): move a card on once what blocked it
  // has landed.
  deps.startDependencyLoop();
  // Ready to Merge (merge-queue.ts): work signed-off PRs to green and merge.
  deps.startMergeQueueLoop();
  // Step slots (step-slots.ts): start queued pipeline steps as running ones
  // finish.
  deps.startSlotScheduler();
  // Awaited conditions (awaits.ts), stale-branch cleanup (branch-sweep.ts)
  // and the issue autopilot (autopilot.ts).
  deps.startAwaitLoop();
  deps.startBranchSweep();
  deps.startAutopilot();
  // Event-loop stall diagnostics → <dataDir>/stalls.log.
  deps.startStallMonitor();
  // Every card gets a GitHub issue (auto-issue.ts): catch up live cards
  // that don't have one yet.
  void deps.backfillIssues().catch(() => undefined);

  return server;
}

/** How often a running core checks that the creds file still names it. */
const CREDS_GUARD_MS = 10_000;

/**
 * Bind the API. When the port is busy:
 *   - the CLI daemon exits quietly if a live core already owns it (the app,
 *     or another daemon that won a startup race — the CLI re-discovers the
 *     winner via the creds file), and loudly otherwise;
 *   - the app's core asks a live cli-daemon owner to hand off, then waits for
 *     the port to free and binds. It waits for any owner, not just a daemon:
 *     after a relaunch (e.g. an applied update) the previous app's core child
 *     may still be shutting down. Anything that never lets go — a foreign
 *     process, e.g. OTLP gRPC also defaults to 4317 — fails loudly with an
 *     `lsof` hint.
 */
async function bindApi(opts: StartCoreOptions, deps: CoreDeps, log: (m: string) => void): Promise<ApiServer> {
  try {
    return deps.startApiServer({ native: opts.native });
  } catch (e) {
    const creds = deps.readCoreCreds(dataDir);
    const live = creds != null && (await deps.probeLiveCore(creds));
    if (opts.kind === "cli-daemon") {
      if (live) {
        log("port already owned by a live core — exiting quietly");
        return deps.exit(0);
      }
      log(`failed to bind API: ${errMessage(e)}`);
      return deps.exit(1);
    }
    if (live && creds?.kind === "cli-daemon") {
      log("a CLI daemon owns the API port — requesting handoff…");
      try {
        await fetch(`http://127.0.0.1:${creds.port}/daemon/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.token}` },
        });
      } catch {
        /* the daemon drops the connection as it exits — expected */
      }
    }
    if (await deps.waitForPortFree(getApiPort(), 10_000)) {
      try {
        return deps.startApiServer({ native: opts.native });
      } catch {
        /* fall through to the loud message below */
      }
    }
    const p = getApiPort();
    log(`failed to bind API on 127.0.0.1:${p}: ${errMessage(e)}`);
    log(`another process is holding that port. Run \`lsof -nP -iTCP:${p} -sTCP:LISTEN\` to identify it, then quit it and relaunch agetor.`);
    return deps.exit(1);
  }
}

let shuttingDown = false;

/**
 * Tear the core down and exit. Reaps live `fx acp` children explicitly
 * (fx-acp.ts's own signal handlers step back once a host registers its own),
 * stops the fx auto-resume timers so none fires mid-teardown, and removes the
 * creds file. tmux-hosted agents are untouched — their sessions outlive the
 * core and the next boot's `reconcileOrphans` reattaches them.
 */
export function shutdownCore(reason: string, log: (m: string) => void, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  reapLiveFxProcs();
  stopFxAutoResumeTimers();
  stopPipelineAutoRetryTimers();
  try {
    removeOwnCoreCreds(dataDir);
  } catch {
    /* best-effort */
  }
  process.exit(code);
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}
