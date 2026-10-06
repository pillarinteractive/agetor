/**
 * Ask a long-lived Codex thread a question — the user's "milestone manager"
 * thread (a Codex Desktop conversation that already knows the project, its
 * milestones and audits). Resumes it non-interactively with
 * `codex exec resume <id> -o <file> <prompt>` in the project directory and
 * returns its final message.
 *
 * Requests are serialized: one at a time across Agetor, so two answers can't
 * interleave in the thread. The user agrees not to type into the thread in
 * Codex Desktop while Autopilot uses it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { run } from "./github.ts";

const CODEX = path.join(homedir(), ".agetor", "bin", "codex");

let chain: Promise<unknown> = Promise.resolve();

export interface ThreadAnswer {
  ok: boolean;
  text: string;
  error?: string;
  /** The thread is open elsewhere (Codex Desktop holds its single-writer lock). */
  busy?: boolean;
}

export const THREAD_BUSY_MESSAGE =
  "The thread is open in Codex Desktop, which locks it — switch to another thread there (or quit Codex) so Autopilot can use it. Retrying every 5 minutes.";

/** Pull the JSON inside `<tag>…</tag>` out of an answer, or null. Pure. */
export function taggedJson<T>(text: string, tag: string): T | null {
  const m = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return null;
  }
}

export function askThread(input: { threadId: string; cwd: string; prompt: string; timeoutMs?: number }): Promise<ThreadAnswer> {
  const job = chain.then(() => askNow(input));
  chain = job.catch(() => undefined);
  return job;
}

async function askNow(input: { threadId: string; cwd: string; prompt: string; timeoutMs?: number }): Promise<ThreadAnswer> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-thread-"));
  const out = path.join(dir, "answer.md");
  try {
    const r = await run(
      [
        CODEX,
        "exec",
        "resume",
        input.threadId,
        "-o",
        out,
        // It reads the repo, runs gh and tests; it doesn't need to push.
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        input.prompt,
      ],
      input.cwd,
      input.timeoutMs ?? 20 * 60_000,
      process.env,
    );
    let text = "";
    try {
      text = readFileSync(out, "utf8").trim();
    } catch {
      // no final message written
    }
    if (!r.ok && !text) {
      const raw = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
      if (/already has an active writer/i.test(raw)) return { ok: false, text: "", busy: true, error: THREAD_BUSY_MESSAGE };
      return { ok: false, text: "", error: (r.stderr || r.stdout || "codex exited with an error").slice(-500) };
    }
    return { ok: !!text, text, error: text ? undefined : "the thread gave no answer" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
