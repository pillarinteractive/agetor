/**
 * The effects the no-owner-holds ladder needs from the rest of the core
 * (src/shared/owner-holds.ts; the runner's `resolveOwnerHolds`): filing one
 * deduplicated follow-up issue per unresolved item, answering a question a
 * step asked in an unattended run (never approving anything), and whether a
 * card's branch has work of its own to publish. Loaded lazily by the runner
 * and replaceable in tests (`ownerHoldDeps`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../shared/types.ts";
import { OWNER_HOLD_LABEL, ownerHoldMarker } from "../shared/owner-holds.ts";
import { dataDir } from "./db.ts";
import { createGitHubIssue, run as exec } from "./github.ts";
import { redactDecisionText } from "./pipeline-decisions.ts";
import type { AnyRequest } from "./interactions.ts";

// ── Follow-up issues ──────────────────────────────────────────────────────

interface LedgerEntry {
  state: "pending" | "filed";
  number?: number;
  url?: string;
  at: number;
}
type Ledger = Record<string, LedgerEntry>;

const ledgerFile = () => join(dataDir, "owner-hold-followups.json");

function readLedger(): Ledger {
  try {
    const f = ledgerFile();
    if (!existsSync(f)) return {};
    const v = JSON.parse(readFileSync(f, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Ledger) : {};
  } catch {
    return {};
  }
}

function writeLedger(l: Ledger): void {
  mkdirSync(dataDir, { recursive: true });
  const f = ledgerFile();
  writeFileSync(`${f}.tmp`, `${JSON.stringify(l, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

/** An open or closed issue already carrying the marker, found by search. */
async function findByMarker(dir: string, key: string): Promise<{ number: number; url: string } | null> {
  const r = await exec(
    ["gh", "issue", "list", "--state", "all", "--search", `"agetor-owner-hold:${key}" in:body`, "--json", "number,url,body", "--limit", "5"],
    dir,
    30_000,
    process.env,
  ).catch(() => null);
  if (!r?.ok) return null;
  try {
    const rows = JSON.parse(r.stdout) as { number: number; url: string; body?: string }[];
    const hit = rows.find((x) => (x.body ?? "").includes(ownerHoldMarker(key)));
    return hit ? { number: hit.number, url: hit.url } : null;
  } catch {
    return null;
  }
}

/**
 * File the follow-up issue for one unresolved item, or reuse the one that
 * already carries its key: the local ledger first (written before the
 * remote create, so a crash between the two searches instead of creating
 * twice), then a search of the repository by the marker. Labelled
 * {@link OWNER_HOLD_LABEL} so the owner's decision milestone collects them;
 * when the label cannot be set the marker still identifies it. Text is
 * redacted before it leaves the machine.
 */
export async function fileOwnerHoldIssue(input: { dir: string; key: string; title: string; body: string }): Promise<{ number: number; url: string; reused: boolean } | { error: string }> {
  const ledger = readLedger();
  const known = ledger[input.key];
  if (known?.state === "filed" && known.number) return { number: known.number, url: known.url ?? "", reused: true };
  if (known?.state === "pending" || !known) {
    const found = await findByMarker(input.dir, input.key);
    if (found) {
      writeLedger({ ...readLedger(), [input.key]: { state: "filed", ...found, at: Date.now() } });
      return { ...found, reused: true };
    }
  }
  writeLedger({ ...readLedger(), [input.key]: { state: "pending", at: Date.now() } });
  const title = redactDecisionText(input.title);
  const body = redactDecisionText(input.body);
  let created = await createGitHubIssue({ dir: input.dir, title, body, labels: [OWNER_HOLD_LABEL] }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  if (!created.ok) created = await createGitHubIssue({ dir: input.dir, title, body }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  if (!created.ok) return { error: created.error };
  const out = { number: created.item.number, url: created.item.htmlUrl };
  writeLedger({ ...readLedger(), [input.key]: { state: "filed", ...out, at: Date.now() } });
  return { ...out, reused: false };
}

// ── Questions a step asked ────────────────────────────────────────────────

/**
 * Answer a pending interaction of an unattended run with `note`, the way a
 * person's free-text answer is delivered: dismiss the question (Escape —
 * never a selection, never an approval of a permission) and send the note
 * as a follow-up turn. False when it could not be delivered.
 */
export async function answerPendingInteraction(req: AnyRequest, note: string): Promise<boolean> {
  const { sendInput } = await import("./orchestrator.ts");
  if (req.kind === "ask_questions") {
    const { dismissAskModalForMessage, resolveAskCard } = await import("./claude-tmux.ts");
    const clean = await dismissAskModalForMessage(req.taskId).catch(() => false);
    resolveAskCard(req.id, req.taskId);
    if (!clean) return false;
  } else if (req.kind === "tmux_prompt") {
    const { markTmuxPromptAnswered, sendModalKeys } = await import("./claude-tmux.ts");
    const { answerTmuxPrompt } = await import("./interactions.ts");
    const { recordPromptDismissal } = await import("./interaction-audit.ts");
    await sendModalKeys(req.taskId, ["Escape"]).catch(() => false);
    markTmuxPromptAnswered(req.taskId, req.fingerprint);
    if (answerTmuxPrompt(req.id, { key: "__external__" })) recordPromptDismissal(req, "unattended run: nobody will answer (owner_holds)");
  } else {
    const { answerFxPermission } = await import("./interactions.ts");
    answerFxPermission(req.id, { cancelled: true });
  }
  const sent = await sendInput(req.runId, note).catch((e: unknown) => ({ delivered: false as const, reason: String(e) }));
  return sent.delivered;
}

// ── Committed work ────────────────────────────────────────────────────────

/** The card's branch has commits of its own (or a pull request already). */
export async function hasCommittedWork(parent: Task): Promise<boolean> {
  if (parent.prUrl) return true;
  const cwd = parent.worktreePath ?? parent.workdir;
  if (!parent.baseRef) return false;
  const r = await exec(["git", "rev-list", "--count", `${parent.baseRef}..HEAD`], cwd, 30_000, process.env).catch(() => null);
  const n = r?.ok ? Number(r.stdout.trim()) : 0;
  return Number.isFinite(n) && n > 0;
}
