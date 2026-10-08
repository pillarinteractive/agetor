import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearDeliberateQuit,
  KEEPALIVE_LABEL,
  keepaliveQuitMarker,
  markDeliberateQuit,
  renderKeepalivePlist,
} from "./keepalive.ts";
import { keepaliveOff, keepaliveOn, keepaliveStatus, type Exec } from "../cli/commands/keepalive.ts";

const SCRIPT = path.join(import.meta.dir, "..", "..", "scripts", "keepalive", "agetor-keepalive.sh");

test("a deliberate quit leaves a marker the next launch clears", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-keepalive-"));
  markDeliberateQuit(dir);
  expect(existsSync(keepaliveQuitMarker(dir))).toBe(true);
  clearDeliberateQuit(dir);
  expect(existsSync(keepaliveQuitMarker(dir))).toBe(false);
  clearDeliberateQuit(dir); // no marker: no-op
});

test("the LaunchAgent runs the check at load and every 3 minutes, with the data dir", () => {
  const plist = renderKeepalivePlist({ scriptPath: "/Users/me/.agetor/bin/agetor-keepalive", dataDir: "/Users/me/.agetor", logPath: "/Users/me/.agetor/keepalive.log" });
  expect(plist).toContain(`<string>${KEEPALIVE_LABEL}</string>`);
  expect(plist).toContain("<string>/Users/me/.agetor/bin/agetor-keepalive</string>");
  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(plist).toContain("<key>StartInterval</key>\n  <integer>180</integer>");
  expect(plist).toContain("<key>AGETOR_DATA_DIR</key>\n    <string>/Users/me/.agetor</string>");
});

test("agetor keepalive on/off/status manage the flag and the LaunchAgent", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-keepalive-data-"));
  const home = mkdtempSync(path.join(tmpdir(), "agetor-keepalive-home-"));
  const calls: string[] = [];
  let loaded = false;
  const exec: Exec = (argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "bootstrap") loaded = true;
    if (argv[1] === "bootout") loaded = false;
    if (argv[1] === "print") return { code: loaded ? 0 : 113, out: "" };
    return { code: 0, out: "" };
  };
  const env = { dataDir, home, uid: 501, exec };

  // Not installed yet: refuses, touches nothing.
  expect(keepaliveOn(env).ok).toBe(false);
  expect(calls).toEqual([]);

  mkdirSync(path.join(dataDir, "bin"), { recursive: true });
  writeFileSync(path.join(dataDir, "bin", "agetor-keepalive"), "#!/bin/sh\n");
  const on = keepaliveOn(env);
  expect(on.ok).toBe(true);
  const plist = path.join(home, "Library", "LaunchAgents", `${KEEPALIVE_LABEL}.plist`);
  expect(readFileSync(plist, "utf8")).toContain(path.join(dataDir, "bin", "agetor-keepalive"));
  expect(calls).toContain(`launchctl bootstrap gui/501 ${plist}`);
  expect(keepaliveStatus(env)).toMatchObject({ enabled: true, launchAgentInstalled: true, launchAgentLoaded: true, scriptInstalled: true, deliberateQuitAt: null });

  markDeliberateQuit(dataDir);
  expect(keepaliveStatus(env).deliberateQuitAt).not.toBeNull();

  expect(keepaliveOff(env).ok).toBe(true);
  expect(calls.at(-1)).toBe(`launchctl bootout gui/501/${KEEPALIVE_LABEL}`);
  expect(keepaliveStatus(env)).toMatchObject({ enabled: false, launchAgentInstalled: false, launchAgentLoaded: false });
});

/** Run the real check script against a fake app/data dir, with `pgrep` and
 *  `open` stubbed on PATH. Returns what `open` was asked to do. */
function runCheck(opts: { enabled: boolean; quitMarker?: boolean; running?: boolean; app?: boolean; priorReopens?: number }): { opened: string; log: string } {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-keepalive-sh-"));
  const data = path.join(root, "data");
  const app = path.join(root, "Agetor.app");
  const bin = path.join(root, "bin");
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (opts.app !== false) {
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(app, "Contents", "MacOS", "launcher"), "");
    chmodSync(path.join(app, "Contents", "MacOS", "launcher"), 0o755);
  }
  if (opts.enabled) writeFileSync(path.join(data, "keepalive-enabled"), "");
  if (opts.quitMarker) writeFileSync(path.join(data, "keepalive-quit"), "");
  if (opts.priorReopens) {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(path.join(data, "keepalive-reopens"), Array.from({ length: opts.priorReopens }, (_, i) => `${now - i * 60}`).join("\n") + "\n");
  }
  const opened = path.join(root, "opened");
  writeFileSync(path.join(bin, "pgrep"), `#!/bin/sh\nexit ${opts.running ? 0 : 1}\n`);
  writeFileSync(path.join(bin, "open"), `#!/bin/sh\necho "$@" >> '${opened}'\n`);
  chmodSync(path.join(bin, "pgrep"), 0o755);
  chmodSync(path.join(bin, "open"), 0o755);
  const r = Bun.spawnSync(["/bin/sh", SCRIPT], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, AGETOR_DATA_DIR: data, AGETOR_APP: app } });
  expect(r.exitCode).toBe(0);
  const log = existsSync(path.join(data, "keepalive.log")) ? readFileSync(path.join(data, "keepalive.log"), "utf8") : "";
  return { opened: existsSync(opened) ? readFileSync(opened, "utf8").trim().replace(app, "<app>") : "", log };
}

test("the check reopens a dead app only when enabled and not quit on purpose", () => {
  expect(runCheck({ enabled: true }).opened).toBe("-a <app>");
  expect(runCheck({ enabled: false }).opened).toBe("");
  expect(runCheck({ enabled: true, quitMarker: true }).opened).toBe("");
  expect(runCheck({ enabled: true, running: true }).opened).toBe("");
  expect(runCheck({ enabled: true, app: false }).opened).toBe(""); // mid-install
});

test("the check stops reopening an app that keeps dying (5 reopens an hour)", () => {
  expect(runCheck({ enabled: true, priorReopens: 4 }).opened).toBe("-a <app>");
  const looping = runCheck({ enabled: true, priorReopens: 5 });
  expect(looping.opened).toBe("");
  expect(looping.log).toContain("reopened 5 times in the last hour");
});
