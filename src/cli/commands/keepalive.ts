import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { Flags } from "../context.ts";
import { c, errln, out, printJson } from "../output.ts";
import { resolveDataDir } from "../../bun/core-creds.ts";
import {
  KEEPALIVE_INTERVAL_SECONDS,
  KEEPALIVE_LABEL,
  keepaliveEnabledFlag,
  keepaliveQuitMarker,
  keepaliveScriptPath,
  launchAgentPlistPath,
  renderKeepalivePlist,
} from "../../bun/keepalive.ts";

/** Runs a command, returning its exit code and output. Injected for tests. */
export type Exec = (argv: string[]) => { code: number; out: string };

const realExec: Exec = (argv) => {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
};

export interface KeepaliveStatus {
  enabled: boolean;
  launchAgentInstalled: boolean;
  launchAgentLoaded: boolean;
  scriptInstalled: boolean;
  appRunning: boolean;
  /** When the user last quit Agetor on purpose (keepalive waits for a launch). */
  deliberateQuitAt: string | null;
  plist: string;
  log: string[];
}

export interface KeepaliveEnv {
  dataDir: string;
  home: string;
  uid: number;
  exec: Exec;
}

function domain(env: KeepaliveEnv): string {
  return `gui/${env.uid}`;
}

export function keepaliveStatus(env: KeepaliveEnv): KeepaliveStatus {
  const plist = launchAgentPlistPath(env.home);
  const marker = keepaliveQuitMarker(env.dataDir);
  const logFile = path.join(env.dataDir, "keepalive.log");
  return {
    enabled: existsSync(keepaliveEnabledFlag(env.dataDir)),
    launchAgentInstalled: existsSync(plist),
    launchAgentLoaded: env.exec(["launchctl", "print", `${domain(env)}/${KEEPALIVE_LABEL}`]).code === 0,
    scriptInstalled: existsSync(keepaliveScriptPath(env.dataDir)),
    appRunning: env.exec(["pgrep", "-f", "/Applications/Agetor.app/Contents/MacOS/(launcher|\\.\\./Resources/main\\.js)"]).code === 0,
    deliberateQuitAt: existsSync(marker) ? statSync(marker).mtime.toISOString() : null,
    plist,
    log: existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").slice(-3) : [],
  };
}

/** `on`: set the flag, write the LaunchAgent and load it into launchd. */
export function keepaliveOn(env: KeepaliveEnv): { ok: boolean; message: string } {
  const script = keepaliveScriptPath(env.dataDir);
  if (!existsSync(script)) {
    return { ok: false, message: `${script} isn't installed — run \`bun run install:local\` from the Agetor checkout first` };
  }
  writeFileSync(keepaliveEnabledFlag(env.dataDir), `${new Date().toISOString()}\n`);
  const plist = launchAgentPlistPath(env.home);
  mkdirSync(path.dirname(plist), { recursive: true });
  writeFileSync(plist, renderKeepalivePlist({ scriptPath: script, dataDir: env.dataDir, logPath: path.join(env.dataDir, "keepalive.log") }));
  // Reload so an edited plist takes effect; bootout fails harmlessly when it isn't loaded.
  env.exec(["launchctl", "bootout", `${domain(env)}/${KEEPALIVE_LABEL}`]);
  const r = env.exec(["launchctl", "bootstrap", domain(env), plist]);
  if (r.code !== 0) return { ok: false, message: `wrote ${plist}, but launchctl bootstrap failed: ${r.out}` };
  return { ok: true, message: `keepalive on — launchd checks every ${KEEPALIVE_INTERVAL_SECONDS / 60} minutes and reopens Agetor if it died (never after you quit it)` };
}

/** `off`: unload and remove the LaunchAgent, clear the flag. */
export function keepaliveOff(env: KeepaliveEnv): { ok: boolean; message: string } {
  env.exec(["launchctl", "bootout", `${domain(env)}/${KEEPALIVE_LABEL}`]);
  rmSync(launchAgentPlistPath(env.home), { force: true });
  rmSync(keepaliveEnabledFlag(env.dataDir), { force: true });
  return { ok: true, message: "keepalive off" };
}

/** `agetor keepalive on|off|status` — see src/bun/keepalive.ts. */
export async function cmdKeepalive(args: string[], flags: Flags): Promise<void> {
  const env: KeepaliveEnv = { dataDir: flags.dataDir ?? resolveDataDir(), home: homedir(), uid: userInfo().uid, exec: realExec };
  const sub = args[0] ?? "status";
  if (sub === "on" || sub === "off") {
    const r = sub === "on" ? keepaliveOn(env) : keepaliveOff(env);
    if (flags.json) return printJson(r);
    if (!r.ok) {
      errln(c.red(r.message));
      process.exitCode = 1;
      return;
    }
    out(`${c.green("✓")} ${r.message}`);
    return;
  }
  if (sub !== "status") {
    errln(c.red(`unknown keepalive subcommand: ${sub}`));
    errln("usage: agetor keepalive on|off|status");
    process.exitCode = 1;
    return;
  }
  const s = keepaliveStatus(env);
  if (flags.json) return printJson(s);
  const yes = (b: boolean) => (b ? c.green("yes") : c.dim("no"));
  out(`keepalive enabled:     ${yes(s.enabled)}`);
  out(`LaunchAgent loaded:    ${yes(s.launchAgentLoaded)}${s.launchAgentInstalled ? "" : c.dim(` (no ${s.plist})`)}`);
  out(`check script:          ${yes(s.scriptInstalled)}`);
  out(`Agetor running:        ${yes(s.appRunning)}`);
  if (s.deliberateQuitAt) out(`quit on purpose at:    ${s.deliberateQuitAt} ${c.dim("(not reopened until you launch it)")}`);
  for (const l of s.log) out(c.dim(l));
}
