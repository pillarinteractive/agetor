/** Versioned queue facts; issue text is evidence, never scheduler instructions. */
import { compareStepIds, parseRoadmap, type ParsedRoadmap, type RoadmapIssueState, type RoadmapStep } from './roadmap.ts';

export interface QueueSource { url: string; revision: string; hash: string; }
export interface QueueSelection {
  slice: string;
  predicates: Record<string, { disposition: 'included' | 'excluded' | 'unresolved'; authority: string; evidence: string }>;
}
export interface QueueRecord {
  issue: number;
  key: string;
  origin: 'completion-order' | 'supplement' | 'registered';
  priority: string;
  sources: QueueSource[];
  bodyHash: string;
  updatedAt: string | null;
  hardInputs: number[];
  applicableInputs: number[];
  conditionalInputs: string[];
  selection: QueueSelection;
  paths: string[];
  hold: string | null;
}
export interface CanonicalQueue { parsed: ParsedRoadmap; records: QueueRecord[]; version: string; sources: QueueSource[]; coverage: number; errors: string[]; }
export interface SupplementalTask { issue: number; key?: string; title?: string; kind?: string; lane?: string; hard_predecessors?: unknown[]; current_hard_predecessors?: unknown[]; conditional_inputs?: unknown; milestone_number?: number; }

export function canonicalIssue(url: string | null | undefined): string | null {
  try {
    const u = new URL(url ?? '');
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i);
    return u.protocol === 'https:' && m ? `${u.hostname.toLowerCase()}/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/issues/${Number(m[3])}` : null;
  } catch { return null; }
}

/** Only the owning issue's explicitly controlling list, not citations elsewhere. */
export function controllingInputs(body: string): { hard: number[]; conditional: string[]; error: string | null } {
  const section = body.match(/^## Dependencies and required inputs\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  if (!section || !/sole controlling whole-task predecessor list/i.test(section)) return { hard: [], conditional: [], error: 'current controlling whole-task inputs are unavailable' };
  const before = section.split(/^### /m)[0]!;
  const hard = [...new Set([...before.matchAll(/^\s*-\s+(?:\[#(\d+)\]\([^\n)]+\)|#(\d+))(?=\s|$)/gm)].map(m => Number(m[1] ?? m[2])))];
  if (!hard.length && !/\b(?:none|no whole-task|no hard|no required|no predecessor)\b/i.test(before)) return { hard, conditional: [], error: 'controlling predecessor list is empty without an explicit none disposition' };
  const conditionalSection = section.match(/^### Conditional and action-specific input predicates\s*\n([\s\S]*?)(?=^### |$(?![\s\S]))/m)?.[1] ?? '';
  const explicitNone=/^\s*No additional conditional predicate is recorded\./i.test(conditionalSection.trim());
  const conditional = explicitNone ? [] : conditionalSection.split('\n').filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, '').trim());
  if(!explicitNone&&conditionalSection.trim()&&!conditional.length) conditional.push(conditionalSection.trim());
  return { hard, conditional, error: null };
}

export function coverageIssues(csv: string): number[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0]?.split(',')[0] !== 'issue') throw new Error('coverage CSV has no issue column');
  const ids = lines.slice(1).map(l => Number(l.split(',')[0]));
  if (ids.some(n => !Number.isSafeInteger(n) || n <= 0) || new Set(ids).size !== ids.length) throw new Error('coverage CSV has invalid or duplicate identities');
  return ids;
}

/** Stable supplemental priority is derived, and never presented as numeric order. */
export function assembleQueue(input: {
  body: string; states: ReadonlyMap<number, RoadmapIssueState>; membership: number[];
  supplements: SupplementalTask[]; sources: QueueSource[]; version: string;
  hash: (value: string) => string; selections?: Record<string, QueueSelection>;
  registered?: SupplementalTask[];
}): CanonicalQueue {
  const baseline = parseRoadmap(input.body);
  const errors: string[] = [];
  if (baseline.error) return { parsed: baseline, records: [], version: input.version, sources: input.sources, coverage: input.membership.length, errors: [baseline.error] };
  const byIssue = new Map(baseline.steps.map(s => [s.issue, s]));
  const membership = new Set(input.membership);
  for (const n of byIssue.keys()) if (!membership.has(n)) errors.push(`historical #${n} is missing from canonical membership`);
  const overlays = new Map<number, SupplementalTask>();
  const conflicts = new Set<number>();
  for (const t of input.supplements) {
    const prior = overlays.get(t.issue);
    if (prior && JSON.stringify(prior) !== JSON.stringify(t)) conflicts.add(t.issue);
    else overlays.set(t.issue, t);
  }
  const registered = new Map((input.registered ?? []).map(t => [t.issue, t]));
  const steps = baseline.steps.map(s => ({ ...s, predecessors: [...s.predecessors] }));
  // Supplemental placement follows its latest published historical producer,
  // then stable issue number. This never reorders the original 417 entries.
  for (const issue of [...new Set([...input.membership, ...registered.keys()])].sort((a,b) => a-b)) {
    if (byIssue.has(issue)) continue;
    const st = input.states.get(issue);
    const t = overlays.get(issue) ?? registered.get(issue);
    const deps = t?.current_hard_predecessors ?? t?.hard_predecessors ?? [];
    const positions = deps.filter((n): n is number => typeof n === 'number').map(n => byIssue.get(n)?.step).filter((n): n is string => !!n);
    const anchor = positions.sort(compareStepIds).at(-1) ?? baseline.steps.at(-1)!.step;
    const step = `${anchor.split('.')[0]}.${100000 + issue}`;
    steps.push({ step, issue, title: st?.title ?? t?.title ?? `Issue #${issue}`, human: t?.kind === 'human' || /^\[Human\]/i.test(st?.title ?? t?.title ?? ''), milestone: st?.milestone?.title ?? t?.lane ?? '', predecessors: [] });
  }
  const allByIssue = new Map(steps.map(s => [s.issue, s]));
  const records: QueueRecord[] = [];
  const held: Record<string, string> = {};
  for (const s of steps) {
    const state = input.states.get(s.issue);
    const owning = controllingInputs(state?.body ?? '');
    const selection = input.selections?.[String(s.issue)] ?? { slice: 'bounded input validation; no implementation or authority inferred', predicates: {} };
    let hold = owning.error;
    if (!state?.body || !state.updatedAt) hold = 'current issue body/revision is unavailable';
    if (conflicts.has(s.issue)) hold = 'conflicting supplemental identity; reconcile source records';
    const conditional = owning.conditional;
    const applicable = [...owning.hard];
    for (const p of conditional) {
      const disposition = selection.predicates[p];
      if (!disposition || disposition.disposition === 'unresolved' || !disposition.authority || !disposition.evidence) {
        hold ??= `unresolved selected-slice predicate: ${p}`; continue;
      }
      if (disposition.disposition === 'included') applicable.push(...[...p.matchAll(/#(\d+)/g)].map(m => Number(m[1])));
    }
    const missing = applicable.filter(n => !allByIssue.has(n));
    if (missing.length) hold ??= `input identities absent from canonical coverage: ${missing.map(n=>'#'+n).join(', ')}`;
    s.predecessors = [...new Set(applicable)].map(n => allByIssue.get(n)?.step ?? '#'+n);
    if (hold) held[s.step] = hold;
    const paths=[...new Set([...(state?.body??'').matchAll(/`((?:apps|packages|modules|docs\/engineering|docs\/testing|\.github)\/[a-zA-Z0-9_./-]+)`/g)].map(m=>m[1]!))];
    records.push({ issue: s.issue, key: overlays.get(s.issue)?.key ?? `E${s.issue}`, origin: byIssue.has(s.issue) ? 'completion-order' : membership.has(s.issue) ? 'supplement' : 'registered', priority: s.step, sources: input.sources, bodyHash: input.hash(state?.body ?? ''), updatedAt: state?.updatedAt ?? null, hardInputs: owning.hard, applicableInputs:[...new Set(applicable)], conditionalInputs: conditional, selection, paths, hold });
  }
  steps.sort((a,b)=>compareStepIds(a.step,b.step));
  // Detect cycles again after replacing stale table edges with live contracts.
  const visiting = new Set<string>(), visited = new Set<string>();
  const indexed = new Map(steps.map(s=>[s.step,s]));
  const visit = (id: string, path: string[]) => {
    if (visiting.has(id)) { for (const n of path.slice(path.indexOf(id))) held[n] = 'cycle in current controlling inputs'; return; }
    if (visited.has(id)) return;
    visiting.add(id); for (const p of indexed.get(id)?.predecessors ?? []) visit(p,[...path,id]); visiting.delete(id); visited.add(id);
  };
  for (const s of steps) visit(s.step,[]);
  for (const r of records) r.hold = held[r.priority] ?? r.hold;
  return { parsed: { steps, held, problems: baseline.problems.filter(p=>p.kind !== 'unknown-predecessor' && p.kind !== 'cycle'), error: null }, records, sources: input.sources, coverage: input.membership.length, version: input.version, errors };
}
