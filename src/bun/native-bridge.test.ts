import { test, expect, afterEach } from "bun:test";
import { createBridgeNative, startNativeBridge, type NativeBridgeServer } from "./native-bridge.ts";
import { makeTestNative } from "./test-native.ts";

let bridge: NativeBridgeServer | null = null;
afterEach(() => {
  bridge?.stop();
  bridge = null;
});

test("every ApiNative operation round-trips through the bridge", async () => {
  const calls: string[] = [];
  bridge = startNativeBridge(
    makeTestNative({
      openFileDialog: async (o) => {
        calls.push(`dialog:${o.startingFolder}`);
        return ["/picked/a", "/picked/b"];
      },
      openPath: (p) => (calls.push(`open:${p}`), true),
      revealPath: async (p) => (calls.push(`reveal:${p}`), true),
      openExternal: (u) => (calls.push(`external:${u}`), false),
      showNotification: (n) => void calls.push(`notify:${n.title}:${n.taskId}`),
      focusWindow: () => (calls.push("focus"), true),
      toggleZoom: () => (calls.push("zoom"), "fullscreen"),
      quit: () => void calls.push("quit"),
      updates: {
        snapshot: () => ({ status: "ready", version: "9.9.9", error: null, lastCheckedAt: 1 }),
        check: async () => void calls.push("check"),
        apply: async () => void calls.push("apply"),
      },
    }),
  );
  const native = createBridgeNative(bridge.url, bridge.token);

  expect(
    await native.openFileDialog({
      startingFolder: "/home",
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: true,
    }),
  ).toEqual(["/picked/a", "/picked/b"]);
  expect(await native.openPath("/x")).toBe(true);
  expect(await native.revealPath("/y")).toBe(true);
  expect(await native.openExternal("https://example.com")).toBe(false);
  expect(await native.focusWindow()).toBe(true);
  expect(await native.toggleZoom!()).toBe("fullscreen");
  expect(await native.updates.snapshot()).toEqual({ status: "ready", version: "9.9.9", error: null, lastCheckedAt: 1 });
  await native.updates.check();
  await native.updates.apply();
  // Fire-and-forget ones: give the request a moment to land.
  native.showNotification({ title: "Done", taskId: "t1" });
  native.quit();
  for (let i = 0; i < 50 && !(calls.includes("quit") && calls.some((c) => c.startsWith("notify"))); i++) {
    await Bun.sleep(10);
  }
  expect(calls).toEqual(
    expect.arrayContaining([
      "dialog:/home",
      "open:/x",
      "reveal:/y",
      "external:https://example.com",
      "focus",
      "zoom",
      "check",
      "apply",
      "notify:Done:t1",
      "quit",
    ]),
  );
  expect(await native.ping(1_000)).toBe("ok");
});

test("rejects a request without the bridge token", async () => {
  let opened = false;
  bridge = startNativeBridge(makeTestNative({ openPath: () => (opened = true) }));

  const raw = await fetch(`${bridge.url}/openPath`, { method: "POST", body: JSON.stringify({ path: "/x" }) });
  expect(raw.status).toBe(401);
  const wrong = await fetch(`${bridge.url}/openPath`, {
    method: "POST",
    headers: { authorization: "Bearer nope" },
    body: JSON.stringify({ path: "/x" }),
  });
  expect(wrong.status).toBe(401);

  // A client with the wrong token sees failures, never a native call.
  const native = createBridgeNative(bridge.url, "wrong-token");
  expect(await native.openPath("/x")).toBe(false);
  expect(await native.focusWindow()).toBe(false);
  await expect(native.updates.snapshot()).rejects.toThrow();
  expect(opened).toBe(false);
});

test("a native failure maps to false for boolean ops and an error otherwise", async () => {
  bridge = startNativeBridge(
    makeTestNative({
      openExternal: () => {
        throw new Error("boom");
      },
      updates: {
        snapshot: () => {
          throw new Error("no updater");
        },
        check: async () => {},
        apply: async () => {},
      },
    }),
  );
  const native = createBridgeNative(bridge.url, bridge.token);
  expect(await native.openExternal("https://example.com")).toBe(false);
  await expect(native.updates.snapshot()).rejects.toThrow(/no updater/);
});

test("ping tells a gone app (refused) from a stalled one (timeout)", async () => {
  // Stalled: accepts the connection but never answers.
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    expect(await createBridgeNative(`http://127.0.0.1:${stalled.port}`, "t").ping(200)).toBe("timeout");
  } finally {
    stalled.stop(true);
  }

  bridge = startNativeBridge(makeTestNative());
  const native = createBridgeNative(bridge.url, bridge.token);
  bridge.stop();
  bridge = null;
  expect(await native.ping(1_000)).toBe("refused");
});
