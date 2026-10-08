import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startNativeBridge } from "./native-bridge.ts";
import { makeTestNative } from "./test-native.ts";

// Boots the real core child the way the app does (index.ts): a native bridge
// in this process, the child spawned with the bridge coordinates and the
// app-chosen API token on its stdin. Checks native routes reach the bridge,
// the host routes work, the boot secrets don't leak into the child's
// environment, and SIGTERM shuts it down cleanly. Runs against the source
// entry and against a bundle built the way scripts/build-core-child.ts does
// (the bundle is what ships, and it loads the core with a dynamic import).
async function bootChild(entry: string, port: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-core-child-"));
  const token = "core-child-test-token";
  const opened: string[] = [];
  const bridge = startNativeBridge(
    makeTestNative({
      openExternal: (u) => (opened.push(u), true),
      toggleZoom: () => "toggled",
    }),
  );

  const proc = Bun.spawn(["bun", entry], {
    cwd: process.cwd(),
    env: { ...process.env, AGETOR_DATA_DIR: dir, AGETOR_API_PORT: String(port) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ apiToken: token, bridgeUrl: bridge.url, bridgeToken: bridge.token }));
  void proc.stdin.end();
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      up = existsSync(path.join(dir, "agetor-core.json"));
      if (!up) await Bun.sleep(100);
    }
    expect(up).toBe(true);
    const creds = JSON.parse(readFileSync(path.join(dir, "agetor-core.json"), "utf8"));
    expect(creds).toMatchObject({ kind: "app", port, token, pid: proc.pid });

    // The child's environ — what Bun.spawn hands every process it starts —
    // carries neither secret. (`ps -E` prints it on macOS; the data dir
    // showing up proves the listing includes the environment at all.)
    const environ = Bun.spawnSync(["ps", "-E", "-ww", "-o", "command=", "-p", String(proc.pid)]).stdout.toString();
    expect(environ).toContain(`AGETOR_DATA_DIR=${dir}`);
    expect(environ).not.toContain(token);
    expect(environ).not.toContain(bridge.token);

    const ext = await fetch(`${base}/open-external`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(await ext.json()).toEqual({ opened: true, url: "https://example.com" });
    expect(opened).toEqual(["https://example.com"]);

    const zoom = await fetch(`${base}/window/toggle-zoom`, { method: "POST", headers: auth });
    expect(zoom.status).toBe(200);

    // Nothing running → the quit may proceed.
    const qc = await fetch(`${base}/host/quit-check`, { method: "POST", headers: auth });
    expect(await qc.json()).toEqual({ allow: true });

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(existsSync(path.join(dir, "agetor-core.json"))).toBe(false);
  } finally {
    proc.kill();
    bridge.stop();
  }
}

test("core child (source entry) serves with the app's token and proxies native calls", async () => {
  await bootChild("src/bun/core-child.ts", 4483);
}, 30_000);

test("core child (bundled entry) boots the same way", async () => {
  const out = mkdtempSync(path.join(tmpdir(), "agetor-core-child-bundle-"));
  const built = await Bun.build({ entrypoints: ["src/bun/core-child.ts"], outdir: out, target: "bun" });
  expect(built.success).toBe(true);
  await bootChild(path.join(out, "core-child.js"), 4484);
}, 60_000);
