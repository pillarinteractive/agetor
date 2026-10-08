import { createBridgeNative } from "./native-bridge.ts";
import { makeParentWatch } from "./core-watchdog.ts";
import { isPidAlive } from "./core-creds.ts";
import type { CoreChildBoot } from "./core-host.ts";

/**
 * Entry point of the app's core child process. The app (index.ts) spawns
 * this with its own bundled bun so the core — API server, orchestrator and
 * background loops — gets an event loop of its own: inside the Electrobun
 * process the host's NSApplication loop could leave Bun's loop un-run for
 * minutes at a time (see stall-monitor.ts), stalling the API and every loop.
 *
 * Packaged as `Resources/app/bun/core-child.js` next to the app bundle's
 * index.js (see scripts/build-core-child.ts and electrobun.config.ts).
 */

const log = (m: string) => console.log(`[agetor:core] ${m}`);

let boot: CoreChildBoot;
try {
  boot = JSON.parse(await Bun.stdin.text()) as CoreChildBoot;
  if (!boot.apiToken || !boot.bridgeUrl || !boot.bridgeToken) throw new Error("incomplete");
} catch {
  log("missing boot parameters on stdin — this entry is started by the Agetor app");
  process.exit(1);
}

const native = createBridgeNative(boot.bridgeUrl, boot.bridgeToken);

// Exit with the app: watch from the start, so a boot that hangs still goes.
makeParentWatch({
  parentPid: process.ppid,
  currentParentPid: () => process.ppid,
  isPidAlive,
  pingBridge: (ms) => native.ping(ms),
  onParentGone: (reason) => void import("./core-main.ts").then((m) => m.shutdownCore(reason, log)),
}).start();

// api-config.ts reads the token from the env once, when it's first loaded —
// so set it, load the core, and clear it again. Setting `process.env` never
// reaches the environ Bun.spawn hands to children, so it doesn't leak.
process.env.AGETOR_API_TOKEN = boot.apiToken;
const { startCore, shutdownCore } = await import("./core-main.ts");
delete process.env.AGETOR_API_TOKEN;

await startCore({ kind: "app", native, log });

process.on("SIGTERM", () => shutdownCore("SIGTERM", log));
process.on("SIGINT", () => shutdownCore("SIGINT", log));
