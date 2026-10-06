/**
 * Branch sweep: once an hour, delete the remote and local branch of every
 * finished card whose work has landed. GitHub only deletes a branch when its
 * PR *merges*; a merge train closes its members, and Agetor keeps a card's
 * local branch after Done so it can be reopened — so without this, branches
 * pile up.
 *
 * A branch is deleted only when ALL of these hold:
 *  - the card is Done (or archived) and isn't a pipeline step;
 *  - its PR merged, directly or through a merge train Agetor landed;
 *  - no open PR uses the branch;
 *  - remote: the branch still points at the PR's final head;
 *    local: its tip is the PR's final head or an ancestor of it (nothing on
 *    it that didn't land), and it isn't checked out in any worktree.
 *
 * Each deletion is recorded on the card's timeline and appended to
 * `<dataDir>/branch-cleanup/sweep.log` with its commit, so it can be restored
 * (`git push origin <sha>:refs/heads/<branch>` / `git branch <branch> <sha>`).
 * The `branch_sweep` preference set to "false" turns it off.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { dataDir, preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { run } from "./github.ts";
import { mergedViaTrain } from "./merge-train.ts";

export const BRANCH_SWEEP_PREF = "branch_sweep";
const EVERY_MS = 60 * 60_000;
const FIRST_MS = 5 * 60_000;
const LOG = path.join(dataDir, "branch-cleanup", "sweep.log");

const git = (args: string[], cwd: string, timeoutMs = 60_000) => run(["git", ...args], cwd, timeoutMs, process.env);
const gh = (args: string[], cwd: string) => run(["gh", ...args], cwd, 30_000, process.env);

interface PrInfo {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
}

/** Whether a finished card's branch may go, and at which commit. Pure.
 *  Exported for tests. */
export function landedHead(
  task: Pick<Task, "id" | "column" | "archivedAt" | "pipelineParentId" | "branch">,
  prs: PrInfo[],
  viaTrain: Record<string, unknown>,
): { head: string; pr: number } | null {
  if (task.pipelineParentId || !task.branch) return null;
  if (task.column !== "done" && task.archivedAt == null) return null;
  if (prs.some((p) => p.state === "OPEN")) return null;
  const landed = prs.find((p) => p.state === "MERGED") ?? (viaTrain[task.id] ? prs.find((p) => p.state === "CLOSED") : undefined);
  return landed?.headRefOid ? { head: landed.headRefOid, pr: landed.number } : null;
}

function logDeletion(line: string): void {
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the card's timeline still records it
  }
}

/** One sweep over every finished card. Returns how many branches it deleted. */
export async function branchSweep(list: Task[] = tasks.list()): Promise<number> {
  if (preferences.get(BRANCH_SWEEP_PREF) === "false") return 0;
  const viaTrain = mergedViaTrain();
  const candidates = list.filter((t) => !t.pipelineParentId && t.branch && (t.column === "done" || t.archivedAt != null));
  const byRepo = new Map<string, Task[]>();
  for (const t of candidates) byRepo.set(t.workdir, [...(byRepo.get(t.workdir) ?? []), t]);
  let deleted = 0;

  for (const [repo, cards] of byRepo) {
    if (!(await git(["fetch", "--quiet", "--prune", "origin"], repo, 120_000)).ok) continue;
    const remote = new Set(
      ((await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], repo)).stdout ?? "")
        .split("\n")
        .map((r) => r.replace(/^origin\//, ""))
        .filter(Boolean),
    );
    const local = new Set(((await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repo)).stdout ?? "").split("\n").filter(Boolean));
    const checkedOut = new Set(
      ((await git(["worktree", "list", "--porcelain"], repo)).stdout ?? "")
        .split("\n")
        .filter((l) => l.startsWith("branch refs/heads/"))
        .map((l) => l.slice("branch refs/heads/".length)),
    );

    for (const t of cards) {
      const branch = t.branch!;
      if (branch === "main" || branch === "develop" || branch === "master") continue;
      const hasRemote = remote.has(branch);
      const hasLocal = local.has(branch);
      if (!hasRemote && !hasLocal) continue;
      const listed = await gh(["pr", "list", "--state", "all", "--head", branch, "--limit", "20", "--json", "number,state,headRefOid"], repo);
      if (!listed.ok) continue;
      let prs: PrInfo[];
      try {
        prs = JSON.parse(listed.stdout || "[]") as PrInfo[];
      } catch {
        continue;
      }
      const landed = landedHead(t, prs, viaTrain);
      if (!landed) continue;

      if (hasRemote) {
        const tip = (await git(["rev-parse", `refs/remotes/origin/${branch}`], repo)).stdout?.trim();
        if (tip === landed.head && (await git(["push", "--quiet", "--no-verify", "origin", "--delete", branch], repo)).ok) {
          logDeletion(`remote ${branch} ${tip} (PR #${landed.pr})`);
          recordActivity(t.id, { kind: "auto", text: `Deleted branch origin/${branch} — PR #${landed.pr} landed`, tone: "muted" });
          deleted++;
        }
      }
      if (hasLocal && !checkedOut.has(branch)) {
        const tip = (await git(["rev-parse", `refs/heads/${branch}`], repo)).stdout?.trim();
        if (!tip) continue;
        // The PR head may be gone from the branch refs; GitHub keeps it under refs/pull/N/head.
        if (!(await git(["cat-file", "-e", `${landed.head}^{commit}`], repo)).ok) {
          await git(["fetch", "--quiet", "origin", `refs/pull/${landed.pr}/head`], repo);
        }
        const contained = tip === landed.head || (await git(["merge-base", "--is-ancestor", tip, landed.head], repo)).ok;
        if (contained && (await git(["branch", "-D", branch], repo)).ok) {
          logDeletion(`local ${repo} ${branch} ${tip} (PR #${landed.pr})`);
          recordActivity(t.id, { kind: "auto", text: `Deleted local branch ${branch} — PR #${landed.pr} landed`, tone: "muted" });
          deleted++;
        }
      }
    }
  }
  return deleted;
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startBranchSweep(): void {
  if (loop) return;
  const tick = () => void branchSweep().catch(() => 0);
  setTimeout(tick, FIRST_MS).unref?.();
  loop = setInterval(tick, EVERY_MS);
  loop.unref?.();
}
