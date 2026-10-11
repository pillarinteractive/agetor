/**
 * GitHub reads for Autopilot's roadmap mode (src/bun/autopilot.ts,
 * src/shared/roadmap.ts): the tracker issue's body, and the state of every
 * issue the roadmap names — a few hundred, so they're read in batches of
 * aliased GraphQL fields rather than one `gh issue view` each.
 */
import { run } from "./github.ts";
import type { RoadmapIssueState } from "../shared/roadmap.ts";
import { createHash } from 'node:crypto';
import { preferences } from './db.ts';
import { assembleQueue, coverageIssues, type CanonicalQueue, type QueueSource, type SupplementalTask, type QueueSelection } from '../shared/canonical-roadmap.ts';
import { parseRoadmap } from '../shared/roadmap.ts';

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
  const fields = numbers.map((n) => `i${n}: issue(number: ${n}) { number title body updatedAt state stateReason closedAt url milestone { number title } }`).join(" ");
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
    const i = v as { number?: unknown; title?: unknown; body?: unknown; updatedAt?: unknown; state?: unknown; stateReason?: unknown; closedAt?: unknown; url?: unknown; milestone?: { number?: unknown; title?: unknown } | null } | null;
    if (!i || typeof i.number !== "number" || (i.state !== "OPEN" && i.state !== "CLOSED")) continue;
    // The issue's milestone decides whether its step is in a milestone's
    // scope (src/shared/roadmap.ts `roadmapScope`): null = it has none.
    const m = i.milestone;
    const milestone = m && typeof m.number === "number" ? { number: m.number, title: typeof m.title === "string" ? m.title : "" } : m === null ? null : undefined;
    out.set(i.number, {
      state: i.state,
      stateReason: typeof i.stateReason === "string" ? i.stateReason : null,
      url: typeof i.url === "string" ? i.url : null,
      ...(typeof i.body === 'string' ? { body: i.body } : {}),
      ...(typeof i.title === 'string' ? { title: i.title } : {}),
      ...(typeof i.updatedAt === 'string' ? { updatedAt: i.updatedAt } : {}),
      // When it closed: what velocity counts from (src/shared/velocity.ts).
      ...(typeof i.closedAt === "string" && Number.isFinite(Date.parse(i.closedAt)) ? { closedAt: Date.parse(i.closedAt) } : {}),
      ...(milestone !== undefined ? { milestone } : {}),
    });
  }
  return out;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const QUEUE_FACTS_PREF = 'autopilot_queue_facts_v1';
export const QUEUE_SELECTIONS_PREF = 'autopilot_queue_selections_v1';
export const REGISTERED_ISSUES_PREF = 'autopilot_registered_issues_v1';

/** Explicit immutable artifact references from the tracker, bounded to its repo. */
export function trackerArtifacts(body: string, trackerUrl: string): { url: string; owner: string; repo: string; revision: string; path: string }[] {
  const target = new URL(trackerUrl);
  const repoPath = target.pathname.split('/').slice(1,3).join('/').toLowerCase();
  const out = [];
  for (const match of body.matchAll(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([a-f0-9]{40})\/([^\s)<>]+\.(?:csv|json))/gi)) {
    const [,owner,repo,revision,path] = match;
    if (`${owner}/${repo}`.toLowerCase() !== repoPath || !path!.startsWith('docs/plans/')) continue;
    if (!/(?:roadmap-review-coverage|roadmap-supplements|adapter-architecture)/.test(path!)) continue;
    out.push({ url: match[0], owner: owner!, repo: repo!, revision: revision!, path: path! });
  }
  return [...new Map(out.map(a=>[a.url,a])).values()].slice(0,8);
}

/** A finite fresh cycle: exact sources + current issue contracts, no thread transcript. */
export async function loadCanonicalQueue(project: string, issue: number): Promise<(CanonicalQueue & { states: Map<number,RoadmapIssueState>; body: string; url: string | null }) | { error: string }> {
  const configAtStart=preferences.get('autopilot');
  const tracker = await loadRoadmapTracker(project,issue);
  if ('error' in tracker) return tracker;
  if (!tracker.url) return { error: 'tracker repository identity is unavailable' };
  const artifacts = trackerArtifacts(tracker.body,tracker.url);
  const coverage = artifacts.find(a=>a.path.includes('roadmap-review-coverage') && a.path.endsWith('.csv'));
  if (!coverage) return { error: 'live tracker has no explicit immutable canonical membership CSV' };
  const sourceReads = await Promise.all(artifacts.map(async a => {
    const r = await run(['gh','api',`repos/${a.owner}/${a.repo}/contents/${a.path}?ref=${a.revision}`,'-H','Accept: application/vnd.github.raw+json'],project,60_000,process.env);
    return { a, r };
  }));
  const sources: QueueSource[] = [{ url: tracker.url, revision: hash(tracker.body), hash: hash(tracker.body) }];
  let membership: number[] | null = null;
  const supplements: SupplementalTask[] = [];
  const errors: string[] = [];
  for (const {a,r} of sourceReads) {
    if (!r.ok) { errors.push(`unreadable queue source ${a.url}`); continue; }
    sources.push({url:a.url,revision:a.revision,hash:hash(r.stdout)});
    try {
      if (a.url === coverage.url) membership = coverageIssues(r.stdout);
      else {
        const manifest = JSON.parse(r.stdout);
        if (!manifest || typeof manifest !== 'object' || (!Array.isArray(manifest.tasks) && !Array.isArray(manifest.new_tasks))) throw new Error('invalid manifest');
        const entries=[...(manifest.tasks??[]),...(manifest.new_tasks??[])];
        if(entries.some(t=>!t||!Number.isSafeInteger(t.issue)||t.issue<=0))throw new Error('invalid manifest identity');
        supplements.push(...entries);
        // The tracker links this manifest; its explicit sibling pointer is
        // interpreted at the SAME immutable commit, never a moving branch.
        const sibling = manifest.adapter_architecture_batch?.registry;
        if (typeof sibling === 'string' && /^adapter-architecture-[\d-]+\.registry\.json$/.test(sibling)) {
          const path = a.path.slice(0,a.path.lastIndexOf('/')+1)+sibling;
          const extra = await run(['gh','api',`repos/${a.owner}/${a.repo}/contents/${path}?ref=${a.revision}`,'-H','Accept: application/vnd.github.raw+json'],project,60_000,process.env);
          if (!extra.ok) errors.push(`unreadable architecture membership at ${a.revision}`);
          else {
            const d=JSON.parse(extra.stdout);
            if(!Array.isArray(d.new_tasks)||d.new_tasks.some((t:SupplementalTask)=>!t||!Number.isSafeInteger(t.issue)||t.issue<=0))throw new Error('invalid architecture manifest');
            supplements.push(...d.new_tasks);sources.push({url:`https://github.com/${a.owner}/${a.repo}/blob/${a.revision}/${path}`,revision:a.revision,hash:hash(extra.stdout)});
          }
        }
      }
    } catch { errors.push(`invalid queue source ${a.url}`); }
  }
  if (!membership || errors.length) return {error:errors.join('; ') || 'canonical membership unavailable; existing queue preserved'};
  const registered: SupplementalTask[] = [];
  try {
    const v=JSON.parse(preferences.get(REGISTERED_ISSUES_PREF)??'{}');
    if (v.project===project && v.tracker===issue && v.authority && Array.isArray(v.tasks)) registered.push(...v.tasks.filter((t: SupplementalTask)=>Number.isSafeInteger(t.issue)));
  } catch { errors.push('invalid explicitly registered task metadata'); }
  const baseline=parseRoadmap(tracker.body);
  const numbers=[...new Set([...membership,...baseline.steps.map(s=>s.issue),...registered.map(t=>t.issue)])];
  const states=await loadRoadmapStates(project,numbers);
  if ('error' in states) return states;
  let selections: Record<string,QueueSelection>={};
  try { const v=JSON.parse(preferences.get(QUEUE_SELECTIONS_PREF)??'{}');if(v.project===project&&v.tracker===issue) selections=v.issues??{}; } catch { errors.push('invalid scoped selection metadata'); }
  const version=hash(JSON.stringify({sources,issues:[...states].map(([n,s])=>[n,s.state,s.stateReason,s.updatedAt,hash(s.body??'')]),selections,registered}));
  const queue=assembleQueue({body:tracker.body,states,membership,supplements,sources,version,hash,selections,registered});
  queue.errors.push(...errors);
  if(preferences.get('autopilot')!==configAtStart)return {error:'stale queue read discarded after scheduler configuration changed'};
  // Compact replace-in-place facts; no accumulated scheduler conversation.
  preferences.set(QUEUE_FACTS_PREF,JSON.stringify({version:1,project,tracker:issue,graphVersion:version,at:Date.now(),coverage:membership.length,sources,errors:queue.errors,records:queue.records}));
  return {...queue,states,body:tracker.body,url:tracker.url};
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
