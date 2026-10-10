/**
 * GitHub reads for Autopilot's roadmap mode (src/bun/autopilot.ts,
 * src/shared/roadmap.ts): the tracker issue's body, and the state of every
 * issue the roadmap names — a few hundred, so they're read in batches of
 * aliased GraphQL fields rather than one `gh issue view` each.
 */
import { run } from "./github.ts";
import type { RoadmapIssueState } from "../shared/roadmap.ts";

const BATCH = 100;

export async function loadRoadmapTracker(project: string, issue: number): Promise<{ body: string; url: string | null } | { error: string }> {
  const r = await run(["gh", "issue", "view", String(issue), "--json", "body,url"], project, 60_000, process.env);
  if (!r.ok) return { error: `couldn't read tracker issue #${issue}: ${(r.stderr || r.stdout).slice(-300)}` };
  try {
    const v = JSON.parse(r.stdout) as { body?: unknown; url?: unknown };
    return { body: typeof v.body === "string" ? v.body : "", url: typeof v.url === "string" ? v.url : null };
  } catch {
    return { error: `couldn't read tracker issue #${issue}: unexpected answer from gh` };
  }
}

/** One query for up to `BATCH` issues. Pure; exported for tests. */
export function statesQuery(numbers: number[]): string {
  const fields = numbers.map((n) => `i${n}: issue(number: ${n}) { number state stateReason url }`).join(" ");
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

/** The issues a response answered for. An issue GitHub couldn't resolve is
 *  null there (and the call exits non-zero): it's left out, and its step is
 *  held. Null when the response is unusable. Pure; exported for tests. */
export function parseStatesResponse(stdout: string): Map<number, RoadmapIssueState> | null {
  let repo: unknown;
  try {
    repo = (JSON.parse(stdout) as { data?: { repository?: unknown } }).data?.repository;
  } catch {
    return null;
  }
  if (!repo || typeof repo !== "object") return null;
  const out = new Map<number, RoadmapIssueState>();
  for (const v of Object.values(repo as Record<string, unknown>)) {
    const i = v as { number?: unknown; state?: unknown; stateReason?: unknown; url?: unknown } | null;
    if (!i || typeof i.number !== "number" || (i.state !== "OPEN" && i.state !== "CLOSED")) continue;
    out.set(i.number, { state: i.state, stateReason: typeof i.stateReason === "string" ? i.stateReason : null, url: typeof i.url === "string" ? i.url : null });
  }
  return out;
}

export async function loadRoadmapStates(project: string, numbers: number[]): Promise<Map<number, RoadmapIssueState> | { error: string }> {
  const unique = [...new Set(numbers)];
  const batches: number[][] = [];
  for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));
  const results = await Promise.all(
    batches.map((b) => run(["gh", "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${statesQuery(b)}`], project, 60_000, process.env)),
  );
  const out = new Map<number, RoadmapIssueState>();
  for (const r of results) {
    // A batch naming an issue that doesn't exist exits non-zero but still
    // carries the rest: use what it has.
    const part = parseStatesResponse(r.stdout);
    if (!part) return { error: `couldn't read the roadmap's issue states: ${(r.stderr || r.stdout).slice(-300)}` };
    for (const [n, s] of part) out.set(n, s);
  }
  return out;
}
