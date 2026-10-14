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
export async function fileOwnerHoldIssue(input: { dir: string; key: string; title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string; reused: boolean } | { error: string }> {
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
  let created = await createGitHubIssue({ dir: input.dir, title, body, labels: input.labels ?? [OWNER_HOLD_LABEL] }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
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

// ── Restart once from the base branch ─────────────────────────────────────

/** The git and GitHub calls {@link restartFromBase} makes — replaceable in
 *  tests (a temporary origin and worktree, no GitHub). */
export interface CapRestartDeps {
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string; stderr?: string }>;
  /** The card's open pull request for `branch`, if there is one. */
  findOpenPull: (dir: string, branch: string) => Promise<{ number: number; url: string; base: string | null } | null>;
  closePull: (dir: string, number: number, comment: string) => Promise<{ ok: boolean; error?: string }>;
  /** The project's configured base when the card names none (`prBase`). */
  defaultBase: (checkout: string) => Promise<string>;
}

export const capRestartDeps: CapRestartDeps = {
  git: (args, cwd) => exec(["git", ...args], cwd, 120_000, process.env),
  findOpenPull: async (dir, branch) => {
    const { findGitHubPullForBranch } = await import("./github.ts");
    const r = await findGitHubPullForBranch({ dir, branch }).catch(() => null);
    return r?.ok && r.pull && r.pull.state === "open" ? { number: r.pull.number, url: r.pull.htmlUrl, base: r.pull.baseRef } : null;
  },
  closePull: async (dir, number, comment) => {
    const { closeGitHubPull } = await import("./github.ts");
    const r = await closeGitHubPull({ dir, number, comment }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
  defaultBase: async (checkout) => (await import("./pr-watch.ts")).prBase(checkout),
};

export interface CapRestartInput {
  /** The card's worktree, on its branch. */
  worktree: string;
  /** The project checkout (for GitHub calls). */
  dir: string;
  branch: string;
  /** `archive/<slug>-attempt-<n>`: the issue (`issue-1481`) or the branch. */
  slug: string;
  /** The card's own base branch name, when it recorded one. */
  base: string | null;
}

export type CapRestartResult =
  | { ok: true; base: string; baseSha: string; archive: { ref: string; sha: string }[]; closedPr: number | null; note: string | null }
  /** Nothing was deleted or reset (`archive` lists any ref already pushed). */
  | { ok: false; why: string; archive: { ref: string; sha: string }[]; closedPr: number | null };

/** The archive name of a card: its issue number, else its branch. */
export function capRestartSlug(issueNumber: number | null, branch: string): string {
  if (issueNumber) return `issue-${issueNumber}`;
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "card";
}

const NO_VERIFY_PUSH = ["push", "--quiet", "--no-verify", "origin"];

/**
 * Restart a card once from its base branch (the `restart-from-base` rung,
 * docs/plans/no-owner-holds.md). In order:
 *
 *   1. refuse on uncommitted changes, a worktree off the card's branch, or a
 *      base that cannot be fetched — nothing done;
 *   2. push the worktree's HEAD to `archive/<slug>-attempt-<n>` and, when the
 *      card's remote branch exists and differs, that commit to `…-pr` (never
 *      a force push; `n` is one past the highest attempt on origin). Either
 *      failing stops here: nothing deleted, nothing reset;
 *   3. close the open pull request with a comment saying where the attempt is;
 *   4. delete the card's remote branch, so the restarted run's Finish can
 *      publish the same name without a force push;
 *   5. `git reset --hard origin/<base>` on the card's branch and unset its
 *      upstream.
 *
 * Pushes skip the repository's pre-push hook (`--no-verify`), as Agetor's own
 * pushes do: they publish commits that already exist. Never throws.
 */
export async function restartFromBase(input: CapRestartInput, deps: CapRestartDeps = capRestartDeps): Promise<CapRestartResult> {
  const archive: { ref: string; sha: string }[] = [];
  let closedPr: number | null = null;
  const fail = (why: string): CapRestartResult => ({ ok: false, why, archive, closedPr });
  const git = (args: string[]) => deps.git(args, input.worktree).catch((e: unknown) => ({ ok: false, stdout: "", stderr: String(e) }));
  const err = (r: { stdout: string; stderr?: string }) => (r.stderr || r.stdout || "no output").split("\n")[0]!.slice(0, 200);
  try {
    // 1. Refusals before anything changes.
    const on = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!on.ok || on.stdout.trim() !== input.branch) return fail(`the worktree is not on ${input.branch} (${on.ok ? on.stdout.trim() : "detached HEAD"})`);
    const dirty = await git(["status", "--porcelain"]);
    if (!dirty.ok) return fail(`git status failed: ${err(dirty)}`);
    if (dirty.stdout.trim()) return fail(`the worktree has uncommitted changes that are not in its HEAD (${dirty.stdout.trim().split("\n").length} path(s)) — nothing archived or reset`);
    const head = await git(["rev-parse", "HEAD"]);
    if (!head.ok || !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())) return fail(`cannot read HEAD: ${err(head)}`);
    const headSha = head.stdout.trim();

    const pull = await deps.findOpenPull(input.dir, input.branch).catch(() => null);
    const base = (pull?.base || input.base || (await deps.defaultBase(input.worktree).catch(() => "")) || "").replace(/^origin\//, "");
    if (!base) return fail("no base branch could be determined");
    if (base === input.branch) return fail(`the base branch is the card's own branch (${base})`);
    const fetched = await git(["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (!fetched.ok) return fail(`cannot fetch origin/${base}: ${err(fetched)}`);
    const baseTip = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`]);
    if (!baseTip.ok) return fail(`origin/${base} does not exist`);

    // The card's remote branch, as origin has it now.
    const remote = await git(["ls-remote", "--heads", "origin", `refs/heads/${input.branch}`]);
    if (!remote.ok) return fail(`cannot read origin: ${err(remote)}`);
    const remoteSha = remote.stdout.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === `refs/heads/${input.branch}`)?.[0] ?? null;

    // 2. Archive: the next attempt number on origin.
    const prefix = `archive/${input.slug}-attempt-`;
    const listed = await git(["ls-remote", "--heads", "origin", `refs/heads/${prefix}*`]);
    if (!listed.ok) return fail(`cannot list archive refs on origin: ${err(listed)}`);
    const taken = [...listed.stdout.matchAll(new RegExp(`refs/heads/${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)(?:-pr)?$`, "gm"))].map((m) => Number(m[1]));
    const n = (taken.length ? Math.max(...taken) : 0) + 1;
    const ref = `${prefix}${n}`;
    const pushed = await git([...NO_VERIFY_PUSH, `${headSha}:refs/heads/${ref}`]);
    if (!pushed.ok) return fail(`could not push the attempt to ${ref}: ${err(pushed)}`);
    archive.push({ ref, sha: headSha });
    if (remoteSha && remoteSha !== headSha) {
      const have = await git(["cat-file", "-e", `${remoteSha}^{commit}`]);
      if (!have.ok) {
        const got = await git(["fetch", "--quiet", "origin", `refs/heads/${input.branch}`]);
        if (!got.ok) return fail(`could not fetch origin/${input.branch} to archive it: ${err(got)}`);
      }
      const prRef = `${ref}-pr`;
      const pushedPr = await git([...NO_VERIFY_PUSH, `${remoteSha}:refs/heads/${prRef}`]);
      if (!pushedPr.ok) return fail(`could not push the remote branch to ${prRef}: ${err(pushedPr)}`);
      archive.push({ ref: prRef, sha: remoteSha });
    }

    // 3. Close the open pull request, saying where the attempt is.
    const notes: string[] = [];
    if (pull) {
      const comment = [
        "Agetor runs this card unattended. Its pipeline looped to its step cap again after the wrap-up, so the card restarts once from the current base " +
          `(\`${base}\`) on the same branch name, \`${input.branch}\`. A new pull request will be opened when the restarted run publishes.`,
        `The archived attempt: ${archive.map((a) => `\`${a.ref}\` (${a.sha.slice(0, 12)})`).join(", ")}.`,
        "If the restarted run hits its step cap again, Agetor files an owner-decision issue and the card waits on it.",
      ].join("\n\n");
      const closed = await deps.closePull(input.dir, pull.number, comment).catch((e: unknown) => ({ ok: false, error: String(e) }));
      if (closed.ok) closedPr = pull.number;
      else notes.push(`could not close PR #${pull.number} (${(closed.error ?? "").slice(0, 120)}); deleting its branch closes it`);
    }

    // 4. Delete the remote branch — only now that the archive is on origin.
    if (remoteSha) {
      const deleted = await git([...NO_VERIFY_PUSH, "--delete", input.branch]);
      if (!deleted.ok) return fail(`archived, but could not delete origin/${input.branch}: ${err(deleted)} — the worktree was not reset`);
    }

    // 5. The worktree on the current base, with no upstream.
    const reset = await git(["reset", "--hard", `refs/remotes/origin/${base}`]);
    if (!reset.ok) return fail(`archived${remoteSha ? " and the remote branch deleted" : ""}, but the reset to origin/${base} failed: ${err(reset)}`);
    await git(["branch", "--unset-upstream"]); // none set is fine
    return { ok: true, base, baseSha: baseTip.stdout.trim(), archive, closedPr, note: notes.length ? notes.join("; ") : null };
  } catch (e) {
    return fail(`unexpected error: ${String(e).slice(0, 200)}`);
  }
}
