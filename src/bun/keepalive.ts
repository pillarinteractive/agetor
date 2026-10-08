/**
 * App-level keepalive: a launchd LaunchAgent runs
 * `~/.agetor/bin/agetor-keepalive` (scripts/keepalive/agetor-keepalive.sh)
 * every few minutes, and it reopens /Applications/Agetor.app when
 *   (a) keepalive is enabled — the flag file `~/.agetor/keepalive-enabled`,
 *   (b) no Agetor app process is running, and
 *   (c) the last exit wasn't a deliberate quit — a quit the user approved
 *       (Cmd+Q, the menu, `install:local`) writes `~/.agetor/keepalive-quit`
 *       (`markDeliberateQuit`, index.ts's before-quit), which keepalive
 *       respects until the next launch clears it (`clearDeliberateQuit`).
 *       A crash or a kill leaves no marker, so it's undone.
 *
 * `agetor keepalive on|off|status` (src/cli/commands/keepalive.ts) manages
 * the flag and the LaunchAgent. The core child already restarts under the
 * app's supervisor (core-host.ts); this covers the app itself dying.
 *
 * No db.ts import: the app process (index.ts) and the CLI both use this.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveDataDir } from "./core-creds.ts";

export const KEEPALIVE_LABEL = "com.pillarinteractive.agetor.keepalive";
export const KEEPALIVE_ENABLED_FILE = "keepalive-enabled";
export const KEEPALIVE_QUIT_FILE = "keepalive-quit";
export const KEEPALIVE_SCRIPT_NAME = "agetor-keepalive";
/** How often launchd runs the check. */
export const KEEPALIVE_INTERVAL_SECONDS = 180;

export function keepaliveQuitMarker(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, KEEPALIVE_QUIT_FILE);
}

export function keepaliveEnabledFlag(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, KEEPALIVE_ENABLED_FILE);
}

export function keepaliveScriptPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, "bin", KEEPALIVE_SCRIPT_NAME);
}

export function launchAgentPlistPath(home: string = homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${KEEPALIVE_LABEL}.plist`);
}

/** A quit the user approved: keepalive must not undo it. Best-effort. */
export function markDeliberateQuit(dataDir: string = resolveDataDir()): void {
  try {
    writeFileSync(keepaliveQuitMarker(dataDir), `${new Date().toISOString()}\n`);
  } catch {
    // best-effort
  }
}

/** The app launched: from now on an exit that isn't a deliberate quit is
 *  one keepalive undoes. Best-effort. */
export function clearDeliberateQuit(dataDir: string = resolveDataDir()): void {
  try {
    if (existsSync(keepaliveQuitMarker(dataDir))) rmSync(keepaliveQuitMarker(dataDir), { force: true });
  } catch {
    // best-effort
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The LaunchAgent: run the check at load (login) and every
 *  {@link KEEPALIVE_INTERVAL_SECONDS}. Pure. */
export function renderKeepalivePlist(opts: { scriptPath: string; dataDir: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${KEEPALIVE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xml(opts.scriptPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGETOR_DATA_DIR</key>
    <string>${xml(opts.dataDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${KEEPALIVE_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.logPath)}</string>
</dict>
</plist>
`;
}
