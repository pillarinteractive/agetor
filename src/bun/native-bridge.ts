import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiNative } from "./server.ts";
import type { ToggleZoomResult } from "./window.ts";
import type { UpdaterSnapshot } from "./updater.ts";

/**
 * The native bridge: how the app's core child process (core-child.ts)
 * reaches the Electrobun host for the things only it can do — dialogs,
 * notifications, Finder/browser, window focus/zoom, quit and the updater.
 *
 * The app process serves `ApiNative` over a tiny loopback HTTP server (random
 * port, random bearer token, both handed to the child on its stdin), and
 * the child's `native` is a client that POSTs to it. Every operation is
 * `POST /<op>` with a JSON body and answers `{ result }`.
 *
 * Type-only imports keep this module free of `server.ts` / `db.ts` at
 * runtime, so the app process can load it without opening the database.
 */

/** How long a quick native call may take before the core gives up on it and
 *  reports failure. The app's own event loop is the one that stalls, so a
 *  call can sit unanswered for a long time; dialogs and update checks wait
 *  on the user or the network and get no limit. */
const CALL_TIMEOUT_MS = 30_000;

type Handler = (body: any) => unknown;

function handlers(native: ApiNative): Record<string, Handler> {
  return {
    ping: () => true,
    openFileDialog: (b) => native.openFileDialog(b.opts),
    openPath: (b) => native.openPath(String(b.path)),
    revealPath: (b) => native.revealPath(String(b.path)),
    openExternal: (b) => native.openExternal(String(b.url)),
    showNotification: (b) => native.showNotification(b.notification),
    focusWindow: () => native.focusWindow(),
    toggleZoom: () => (native.toggleZoom ? native.toggleZoom() : "no-window"),
    quit: () => native.quit(),
    "updates/snapshot": () => native.updates.snapshot(),
    "updates/check": () => native.updates.check(),
    "updates/apply": () => native.updates.apply(),
  };
}

function tokenMatches(header: string | null, token: string): boolean {
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface NativeBridgeServer {
  url: string;
  token: string;
  stop(): void;
}

/** Serve `native` on 127.0.0.1 (app process side). */
export function startNativeBridge(native: ApiNative, opts: { port?: number; token?: string } = {}): NativeBridgeServer {
  const token = opts.token ?? randomBytes(32).toString("hex");
  const ops = handlers(native);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    // A file dialog stays open as long as the user leaves it; don't let
    // Bun's idle timeout cut the request off.
    idleTimeout: 0,
    async fetch(req) {
      if (!tokenMatches(req.headers.get("authorization"), token)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const op = ops[new URL(req.url).pathname.slice(1)];
      if (req.method !== "POST" || !op) return Response.json({ error: "not found" }, { status: 404 });
      try {
        const body = await req.json().catch(() => ({}));
        const result = await op(body);
        return Response.json({ result: result ?? null });
      } catch (err) {
        return Response.json({ error: (err as Error)?.message ?? String(err) }, { status: 500 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, token, stop: () => server.stop(true) };
}

/** Outcome of one bridge request, for the child's parent watchdog. */
export type BridgeReachability = "ok" | "refused" | "timeout";

/** The child side: an `ApiNative` whose every method calls the bridge. */
export function createBridgeNative(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): ApiNative & { ping(timeoutMs: number): Promise<BridgeReachability> } {
  async function call<T>(op: string, body: unknown = {}, timeoutMs: number | null = CALL_TIMEOUT_MS): Promise<T> {
    const res = await fetchImpl(`${url}/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutMs == null ? undefined : AbortSignal.timeout(timeoutMs),
    });
    const payload = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok) throw new Error(`native bridge ${op}: ${payload.error ?? res.status}`);
    return payload.result as T;
  }
  // Best-effort boolean calls keep their contract: any failure is `false`.
  const bool = (op: string, body?: unknown) => call<boolean>(op, body).then((r) => r === true, () => false);
  // Fire-and-forget: the route shouldn't wait on the app's event loop.
  const send = (op: string, body?: unknown) => {
    void call(op, body).catch((err) => console.error(`[agetor:core] ${(err as Error)?.message ?? err}`));
  };

  return {
    openFileDialog: (opts) => call<string[]>("openFileDialog", { opts }, null),
    openPath: (p) => bool("openPath", { path: p }),
    revealPath: (p) => bool("revealPath", { path: p }),
    openExternal: (u) => bool("openExternal", { url: u }),
    showNotification: (n) => send("showNotification", { notification: n }),
    focusWindow: () => bool("focusWindow"),
    toggleZoom: () => call<ToggleZoomResult>("toggleZoom").catch((): ToggleZoomResult => "no-window"),
    quit: () => send("quit"),
    updates: {
      snapshot: () => call<UpdaterSnapshot>("updates/snapshot"),
      check: () => call<void>("updates/check", {}, null),
      apply: () => call<void>("updates/apply", {}, null),
    },
    async ping(timeoutMs) {
      try {
        const res = await fetchImpl(`${url}/ping`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel().catch(() => {});
        return "ok"; // any answer at all means the app is there
      } catch (err) {
        const name = (err as { name?: string })?.name;
        // A timeout means something is listening but not answering — the
        // app's event loop is busy or not being run. Only a refused
        // connection means the app is gone.
        return name === "TimeoutError" || name === "AbortError" ? "timeout" : "refused";
      }
    },
  };
}
