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

/** An unknown or malformed disposition never means excluded. */
export function applicableInputs(owning: ReturnType<typeof controllingInputs>, selection: QueueSelection): { inputs: number[]; hold: string | null } {
  const inputs = [...owning.hard];
  let hold = owning.error;
  for (const predicate of owning.conditional) {
    const value = selection?.predicates?.[predicate];
    if (!selection || typeof selection.slice !== 'string' || !selection.slice.trim()
      || !value || !['included', 'excluded'].includes(value.disposition)
      || typeof value.authority !== 'string' || !value.authority.trim()
      || typeof value.evidence !== 'string' || !value.evidence.trim()) {
      hold ??= `unresolved selected-slice predicate: ${predicate}`;
      continue;
    }
    if (value.disposition === 'included') inputs.push(...[...predicate.matchAll(/#(\d+)/g)].map(m => Number(m[1])));
  }
  return { inputs: [...new Set(inputs)], hold };
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
  const duplicates = new Set(baseline.steps.filter((s,i,all)=>all.findIndex(t=>t.issue===s.issue)!==i).map(s=>s.issue));
  const inconsistent = errors.length > 0 || membership.size !== input.membership.length;
  if (membership.size !== input.membership.length) errors.push('duplicate canonical membership identities');
  const overlays = new Map<number, SupplementalTask>();
  const conflicts = new Set<number>();
  for (const t of input.supplements) {
    const prior = overlays.get(t.issue);
    if (prior && JSON.stringify(prior) !== JSON.stringify(t)) conflicts.add(t.issue);
    else overlays.set(t.issue, t);
  }
  const registered = new Map((input.registered ?? []).map(t => [t.issue, t]));
  const steps = baseline.steps.filter((s,i,all)=>all.findIndex(t=>t.issue===s.issue)===i).map(s => ({ ...s, predecessors: [...s.predecessors] }));
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
    const resolved = applicableInputs(owning, selection);
    let hold = resolved.hold;
    if (inconsistent) hold = 'canonical membership is inconsistent with the published completion order';
    if (duplicates.has(s.issue)) hold = 'duplicate historical issue identity; reconcile source records';
    if (!state?.body || !state.updatedAt) hold = 'current issue body/revision is unavailable';
    if (conflicts.has(s.issue)) hold = 'conflicting supplemental identity; reconcile source records';
    const conditional = owning.conditional;
    const applicable = resolved.inputs;
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

// ── Predecessors an issue names that the tracker table doesn't ───────────

/** A sentence that says another issue must land first: "#12 merges before
 *  this task starts", "#12 is upstream of this task". Looser wording ("needs
 *  #12", "waits on #12") is mostly options and questions in practice, so it
 *  is only reported (`mention`), never enforced. */
const LANDS_FIRST_RE = /\b(?:merges?|lands?|is merged|is landed|closes|must (?:merge|land|close|be merged|be closed))\s+(?:before|ahead of)\s+(?:this|the)\s+(?:task|step|issue|work|card|change)\b|\bis (?:an? )?(?:upstream|predecessor|prerequisite|hard predecessor) (?:of|to|for) (?:this|the) (?:task|step|issue|work)\b/i;
const SENTENCES_RE = /[^.\n;?!]+(?:[.;?!]|$)/g;
/** "#12" but not "PR #12" (a PR is the producer's delivery, not a step). */
const ISSUE_REF_RE = /(?<!\b(?:PR|pull request)\s*)#(\d{1,7})\b/gi;

export interface IssuePrerequisite {
  issue: number;
  /** declared: the controlling `## Dependencies and required inputs` list;
   *  prose: a sentence saying it lands first; mention: any other mention of
   *  an open roadmap step (reported only). */
  source: "declared" | "prose";
  quote: string;
}

/** What an issue's body says must land before it: its controlling list and
 *  any sentence saying so (`LANDS_FIRST_RE`). Pure. */
export function issuePrerequisites(body: string, self: number): IssuePrerequisite[] {
  const out = new Map<number, IssuePrerequisite>();
  const owning = controllingInputs(body);
  if (!owning.error) for (const n of owning.hard) if (n !== self) out.set(n, { issue: n, source: "declared", quote: "its controlling predecessor list" });
  for (const m of body.matchAll(SENTENCES_RE)) {
    const sentence = m[0].trim();
    if (!LANDS_FIRST_RE.test(sentence)) continue;
    for (const r of sentence.matchAll(ISSUE_REF_RE)) {
      const n = Number(r[1]);
      if (n !== self && !out.has(n)) out.set(n, { issue: n, source: "prose", quote: sentence.slice(0, 200) });
    }
  }
  return [...out.values()];
}

/** The sentence around `at`, at most 200 characters, centred on it when longer. */
function sentenceAt(body: string, at: number): string {
  const starts = [body.lastIndexOf("\n", at), body.lastIndexOf(". ", at), body.lastIndexOf("; ", at)];
  const start = Math.max(...starts) + 1;
  const tail = body.slice(at).search(/\n|[.;](?:\s|$)/);
  const sentence = body.slice(start, tail < 0 ? body.length : at + tail + 1).trim();
  if (sentence.length <= 200) return sentence;
  const from = Math.max(0, Math.min(at - start - 80, sentence.length - 200));
  return `${from > 0 ? "…" : ""}${sentence.slice(from, from + 198).trim()}…`;
}

export interface RoadmapAuditRow {
  step: string;
  issue: number;
  /** The issue it names. */
  ref: number;
  /** The step of `ref`, when it is one. */
  refStep: string | null;
  source: "declared" | "prose" | "mention";
  quote: string;
  /** complete: closed as completed; open; declined: closed otherwise;
   *  unknown: not read. */
  refState: "complete" | "open" | "declined" | "unknown";
  /** The step waits on it (declared and prose rows the table doesn't list). */
  enforced: boolean;
}

const refStateOf = (st: RoadmapIssueState | undefined): RoadmapAuditRow["refState"] =>
  !st ? "unknown" : st.state === "OPEN" ? "open" : st.stateReason === "COMPLETED" ? "complete" : "declined";

/**
 * Compare each open step's table predecessors with what its issue says it
 * needs. A predecessor the issue declares or says lands first, and the table
 * leaves out, is enforced (`roadmapStatus`'s `extra`); an open roadmap step
 * the issue only mentions, and that is neither its predecessor nor its
 * successor, is reported for the owner. Rows for open steps only. Pure.
 */
export function roadmapAudit(steps: readonly RoadmapStep[], states: ReadonlyMap<number, RoadmapIssueState>): RoadmapAuditRow[] {
  const byIssue = new Map(steps.map((s) => [s.issue, s]));
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const successors = new Map<string, Set<string>>();
  for (const s of steps) for (const p of s.predecessors) (successors.get(p) ?? successors.set(p, new Set()).get(p)!).add(s.step);
  const rows: RoadmapAuditRow[] = [];
  for (const s of steps) {
    const st = states.get(s.issue);
    if (!st || st.state !== "OPEN" || !st.body) continue;
    const table = new Set(s.predecessors.map((p) => byStep.get(p)?.issue ?? Number(p.replace(/^#/, ""))));
    const named = issuePrerequisites(st.body, s.issue);
    for (const p of named) {
      if (table.has(p.issue)) continue;
      rows.push({ step: s.step, issue: s.issue, ref: p.issue, refStep: byIssue.get(p.issue)?.step ?? null, source: p.source, quote: p.quote, refState: refStateOf(states.get(p.issue)), enforced: true });
    }
    const seen = new Set([...table, ...named.map((p) => p.issue), s.issue]);
    const after = successors.get(s.step) ?? new Set();
    for (const r of st.body.matchAll(ISSUE_REF_RE)) {
      const n = Number(r[1]);
      const other = byIssue.get(n);
      if (seen.has(n) || !other || after.has(other.step) || states.get(n)?.state !== "OPEN") continue;
      seen.add(n);
      const quote = sentenceAt(st.body, r.index ?? 0);
      rows.push({ step: s.step, issue: s.issue, ref: n, refStep: other.step, source: "mention", quote, refState: "open", enforced: false });
    }
  }
  return rows;
}

/** The predecessors `roadmapAudit` enforces, by step issue. Pure. */
export function auditPrerequisites(rows: readonly RoadmapAuditRow[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of rows) if (r.enforced) out.set(r.issue, [...(out.get(r.issue) ?? []), r.ref]);
  return out;
}
