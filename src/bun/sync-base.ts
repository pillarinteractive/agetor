/**
 * Keeping a task branch current before it's verified and shipped. A branch
 * cut from `develop` hours ago can fail its final checks on something
 * `develop` has since fixed (and open a PR that's already behind). When a
 * configured step (e.g. Finish, Open PR) is about to start and the base
 * branch has moved ahead of the task branch, the step's prompt gets a short
 * "merge it first" section; when it hasn't moved, nothing changes.
 *
 * Configured with the `pipeline_sync_base` preference — a JSON array of
 * {@link SyncBaseRule}. Agetor only detects; the step's agent commits its work
 * and merges (a merge commit on the task branch — never a rebase, never a
 * push to the base).
 */
import type { Task } from "../shared/types.ts";
import { preferences } from "./db.ts";

export const SYNC_BASE_PREF = "pipeline_sync_base";

export interface SyncBaseRule {
  project: string;
  /** Base branch on `origin`, e.g. "develop". */
  branch: string;
  /** Step names (case-insensitive) to check before. */
  steps: string[];
}

export function parseSyncBaseRules(raw: string | null | undefined): SyncBaseRule[] {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) => {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o.project !== "string" || typeof o.branch !== "string" || !Array.isArray(o.steps)) return [];
    const steps = o.steps.filter((s): s is string => typeof s === "string" && !!s.trim());
    return o.project && o.branch && steps.length ? [{ project: o.project, branch: o.branch, steps }] : [];
  });
}

export function ruleFor(rules: SyncBaseRule[], workdir: string, stepName: string): SyncBaseRule | null {
  const trim = (p: string) => p.replace(/\/+$/, "");
  const name = stepName.trim().toLowerCase();
  return rules.find((r) => trim(r.project) === trim(workdir) && r.steps.some((s) => s.trim().toLowerCase() === name)) ?? null;
}

export function syncBaseSection(branch: string, behind: number): string {
  return `## Before you start: ${branch} has moved on

\`origin/${branch}\` is ${behind} commit${behind === 1 ? "" : "s"} ahead of this branch. Bring it in before you verify, so your checks run against what the PR will merge into:

1. Commit any outstanding work on this branch.
2. \`git merge --no-edit origin/${branch}\` (a merge commit on this task branch — don't rebase, and never push to \`${branch}\`).
3. If it conflicts, resolve it when the right resolution is clear from both sides' intent. If it isn't, \`git merge --abort\` and hand off to the step that fixes things (or as blocked if there's none), listing the conflicting files.

Then carry on with your step as written below.`;
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, out: out.trim() };
  } catch {
    return { code: -1, out: "" };
  }
}

/** How many commits `origin/<branch>` has that the checkout's HEAD doesn't,
 *  after a fetch — or null when it can't tell (no remote, offline). */
export async function commitsBehind(checkout: string, branch: string): Promise<number | null> {
  await git(checkout, ["fetch", "--quiet", "origin", branch]);
  const r = await git(checkout, ["rev-list", "--count", `HEAD..origin/${branch}`]);
  if (r.code !== 0) return null;
  const n = Number.parseInt(r.out, 10);
  return Number.isFinite(n) ? n : null;
}

/** The prompt section to add before `stepName` runs in `parent`'s checkout,
 *  or null when no rule applies or the base hasn't moved. Never throws. */
export async function syncBaseNote(parent: Task, stepName: string): Promise<string | null> {
  const rule = ruleFor(parseSyncBaseRules(preferences.get(SYNC_BASE_PREF)), parent.workdir, stepName);
  const checkout = parent.worktreePath ?? (parent.isolation === "none" ? parent.workdir : null);
  if (!rule || !checkout) return null;
  const behind = await commitsBehind(checkout, rule.branch);
  return behind && behind > 0 ? syncBaseSection(rule.branch, behind) : null;
}
