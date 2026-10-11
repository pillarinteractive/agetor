import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-tmux-prompts-endpoint-"));
process.env.AGETOR_API_PORT = "4459";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
let server: { stop: () => void }; let token: string;
beforeAll(async () => { const api = await import("./server.ts"); token = api.API_TOKEN; server = api.startApiServer() as never; });
afterAll(() => server.stop());
function fakeTmux(stderr: string) {
  const bin = join(mkdtempSync(join(tmpdir(), "agetor-prompt-fake-tmux-")), "tmux");
  writeFileSync(bin, `#!/bin/sh\n>&2 printf '%s' '${stderr.replaceAll("'", "'\\''")}'\nexit 1\n`); chmodSync(bin, 0o755);
  const previous = process.env.AGETOR_TMUX_BIN; process.env.AGETOR_TMUX_BIN = bin;
  return () => { process.env.AGETOR_TMUX_BIN = previous; };
}
async function prompt(taskId = randomUUID()) {
  const { registerTmuxPrompt } = await import("./interactions.ts");
  return registerTmuxPrompt({ taskId, runId: randomUUID(), paneText: "Optional environment teaching", choices: [{ key: "3", label: "Don't show again" }], fingerprint: randomUUID() });
}
const answer = (id: string, body: unknown) => fetch(`http://127.0.0.1:4459/tmux-prompts/${id}/answer`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});

for (const body of [{ key: "3" }, { reject: true }]) test(`confirmed-gone prompt ${JSON.stringify(body)} returns undelivered cancellation and preserves other questions`, async () => {
  const { listPendingForTask, cancelPendingForTask, setResolvedBroadcaster } = await import("./interactions.ts");
  const old = await prompt(); const other = await prompt(); const resolved: unknown[] = [];
  setResolvedBroadcaster((event) => resolved.push(event)); const restore = fakeTmux("can't find session");
  try {
    const res = await answer(old.id, body); expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, cancelled: true, undelivered: true });
    expect(await old.answer).toEqual({ key: "__cancelled__" });
    expect(listPendingForTask(old.req.taskId)).toHaveLength(0); expect(listPendingForTask(other.req.taskId)).toHaveLength(1);
    expect(resolved).toHaveLength(1); expect(resolved[0]).toMatchObject({ id: old.id, cancelled: true, undelivered: true });
  } finally { restore(); cancelPendingForTask(other.req.taskId, "cleanup"); setResolvedBroadcaster(() => {}); }
});

test("an unreachable session returns a retryable failure and retains the unanswered question", async () => {
  const { listPendingForTask, cancelPendingForTask } = await import("./interactions.ts");
  const pending = await prompt(); const restore = fakeTmux("resource temporarily unavailable");
  try { const res = await answer(pending.id, { key: "3" }); expect(res.status).toBe(503); expect(listPendingForTask(pending.req.taskId)).toHaveLength(1); }
  finally { restore(); cancelPendingForTask(pending.req.taskId, "cleanup"); }
});

test("an unregistered key cannot clear a dead-session card or deliver a keystroke", async () => {
  const { listPendingForTask, cancelPendingForTask } = await import("./interactions.ts");
  const pending = await prompt(); const restore = fakeTmux("can't find session");
  try { const res = await answer(pending.id, { key: "1" }); expect(res.status).toBe(400); expect(listPendingForTask(pending.req.taskId)).toHaveLength(1); }
  finally { restore(); cancelPendingForTask(pending.req.taskId, "cleanup"); }
});
