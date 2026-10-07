/**
 * Fresh base for new cards: a card created from a branch (`develop`, or the
 * branch the repo's HEAD is on) records that branch's NAME here, and when
 * the card first creates its worktree it fetches `origin/<name>` and branches
 * from that — so a card that waited in Backlog still starts from the latest
 * develop, not the commit develop was at when the card was made (nor a stale
 * local `develop` nobody pulled). A card created from an explicit commit
 * keeps that commit.
 *
 * Stored in the `card_base_branches` preference as `{ taskId: branchName }`;
 * an entry is dropped once the worktree exists.
 */
import { preferences } from "./db.ts";

export const BASE_BRANCHES_PREF = "card_base_branches";

function read(): Record<string, string> {
  try {
    const v = JSON.parse(preferences.get(BASE_BRANCHES_PREF) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function baseBranchFor(taskId: string): string | null {
  const name = read()[taskId];
  return typeof name === "string" && name ? name : null;
}

export function setBaseBranch(taskId: string, name: string | null): void {
  const map = read();
  if (name) map[taskId] = name;
  else delete map[taskId];
  preferences.set(BASE_BRANCHES_PREF, JSON.stringify(map));
}

/** The branch a requested base names, if it names one: a local or `origin/`
 *  branch (`develop`, `origin/develop`). "HEAD" (no base chosen) means the
 *  repo's integration branch on the remote — `develop` when origin has one,
 *  else origin's default branch — NOT whatever branch the user's checkout
 *  happens to be on (a local-only branch there once became the base of every
 *  new card). A sha or tag → null (pinned as given). */
export async function branchNameForBase(
  requested: string,
  git: (args: string[]) => Promise<{ ok: boolean; stdout: string }>,
): Promise<string | null> {
  if (requested === "HEAD") {
    if ((await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/develop"])).ok) return "develop";
    const def = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    return def.ok && def.stdout.startsWith("origin/") ? def.stdout.slice("origin/".length) : null;
  }
  const name = requested.replace(/^origin\//, "");
  if (/^[0-9a-f]{7,40}$/.test(name)) return null;
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  if (local.ok) return name;
  const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
  return remote.ok ? name : null;
}
