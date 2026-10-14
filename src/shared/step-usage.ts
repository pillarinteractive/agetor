/**
 * Tokens per pipeline step visit — the pure half of `scripts/step-tokens.ts`.
 *
 * Agetor itself records tokens only as daily totals per account
 * (`usage_daily`, src/bun/account-usage.ts). What a step visit cost is in the
 * harness's own session records, and a step task's runs carry the session id
 * (`runs.claude_session_id`, `runs.codex_session_id`), so a visit is the sum
 * of its sessions:
 *
 *   - Claude Code writes one JSONL transcript per session, with the API's
 *     `usage` on every assistant line. A response is written once per content
 *     block, so the same `message.id` appears several times: it is counted
 *     once, with the largest output count seen. Subagents (Scouts) have their
 *     own files beside the session and are part of the visit.
 *   - Codex writes one rollout per session with `token_count` events whose
 *     `total_token_usage` is cumulative. Its `input_tokens` includes the
 *     cached part; here `input` is always the uncached part, so the four
 *     columns mean the same for both harnesses.
 *
 * Nothing here reads a file, a database or a clock.
 */

export interface TokenUsage {
  /** Input tokens that were neither read from nor written to the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model responses (API calls). */
  calls: number;
  /** Turns: messages the session was sent (the step prompt, a reminder, a
   *  wake-up, check feedback), not tool results. */
  turns: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, turns: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, calls: a.calls + b.calls, turns: a.turns + b.turns,
  };
}

/** One number for a visit, as FORK.md's cost section weighs it: output ×5,
 *  cache write ×1.25, input ×1, cache read ×0.1. */
export function weightedTokens(u: TokenUsage): number {
  return Math.round(u.output * 5 + u.cacheWrite * 1.25 + u.input + u.cacheRead * 0.1);
}

export interface SessionUsage {
  usage: TokenUsage;
  /** Responses per model name, as the session records them. */
  models: Record<string, number>;
  /** Lines that were not JSON. */
  badLines: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function jsonLines(text: string, each: (d: Record<string, unknown>) => void): number {
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d: unknown = JSON.parse(line);
      if (isObject(d)) each(d);
    } catch {
      bad++;
    }
  }
  return bad;
}

/** Whether a Claude transcript `user` line is a message someone sent (the
 *  prompt, a follow-up) and not a tool result or a harness note. */
function isClaudeTurn(d: Record<string, unknown>): boolean {
  if (d.type !== "user" || d.isSidechain === true || d.isMeta === true) return false;
  const content = isObject(d.message) ? d.message.content : null;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((b) => isObject(b) && b.type === "text");
}

/**
 * One Claude Code transcript (a session file, or a subagent's file). Pure.
 * `turns` is counted only for a main transcript: a subagent's first message
 * is its parent's tool call, not a turn of the step.
 */
export function parseClaudeTranscript(text: string, opts?: { subagent?: boolean }): SessionUsage {
  const byMessage = new Map<string, { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  let turns = 0;
  const badLines = jsonLines(text, (d) => {
    if (!opts?.subagent && isClaudeTurn(d)) turns++;
    const msg = isObject(d.message) ? d.message : null;
    const usage = msg && isObject(msg.usage) ? msg.usage : null;
    if (!msg || !usage || typeof msg.id !== "string" || !msg.id) return;
    const model = typeof msg.model === "string" && msg.model ? msg.model : "unknown";
    // A synthetic line (an API error shown as a message) has no usage worth counting.
    if (model === "<synthetic>") return;
    const key = `${msg.id}:${typeof d.requestId === "string" ? d.requestId : ""}`;
    const seen = byMessage.get(key);
    const next = {
      model, input: num(usage.input_tokens), output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
    };
    // The same response is written once per content block; the last one has
    // the final output count.
    if (!seen || next.output >= seen.output) byMessage.set(key, next);
  });
  const usage = { ...ZERO_USAGE, turns };
  const models: Record<string, number> = {};
  for (const m of byMessage.values()) {
    usage.input += m.input;
    usage.output += m.output;
    usage.cacheRead += m.cacheRead;
    usage.cacheWrite += m.cacheWrite;
    usage.calls++;
    models[m.model] = (models[m.model] ?? 0) + 1;
  }
  return { usage, models, badLines };
}

/**
 * One Codex rollout. `total_token_usage` is cumulative for the session; a
 * rollout that was continued may start counting again, so the file is read
 * as segments: whenever the total goes down a new segment starts, and the
 * segments' last totals are added. Pure.
 */
export function parseCodexRollout(text: string): SessionUsage {
  const usage = { ...ZERO_USAGE };
  const models: Record<string, number> = {};
  let model = "unknown";
  let segment: { input: number; cached: number; cacheWrite: number; output: number; total: number } | null = null;
  const close = () => {
    if (!segment) return;
    usage.input += Math.max(0, segment.input - segment.cached);
    usage.cacheRead += segment.cached;
    usage.cacheWrite += segment.cacheWrite;
    usage.output += segment.output;
    segment = null;
  };
  const badLines = jsonLines(text, (d) => {
    const payload = isObject(d.payload) ? d.payload : null;
    if (!payload) return;
    if (d.type === "turn_context" && typeof payload.model === "string" && payload.model) model = payload.model;
    if (d.type !== "event_msg") return;
    if (payload.type === "task_started") usage.turns++;
    if (payload.type !== "token_count") return;
    const info = isObject(payload.info) ? payload.info : null;
    const total = info && isObject(info.total_token_usage) ? info.total_token_usage : null;
    if (!total) return;
    const next = {
      input: num(total.input_tokens), cached: num(total.cached_input_tokens), cacheWrite: num(total.cache_write_input_tokens),
      output: num(total.output_tokens), total: num(total.input_tokens) + num(total.output_tokens),
    };
    if (segment && next.total === segment.total) return; // repeated with new rate limits only
    if (segment && next.total < segment.total) close();
    segment = next;
    usage.calls++;
    models[model] = (models[model] ?? 0) + 1;
  });
  close();
  return { usage, models, badLines };
}

/** Median of `values`; null for none. The mean of the two middle values for
 *  an even count, rounded. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The model most of a visit's responses came from. */
export function mainModel(models: Record<string, number>): string | null {
  const entries = Object.entries(models).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0]?.[0] ?? null;
}

/** Why a visit has no token numbers. */
export type Unattributed =
  /** The step task never ran an agent: no run has a session id (a launch
   *  that never started, or a Finish visit Agetor ran itself). */
  | "no-session"
  /** A session id is recorded and its file is not there (cleaned up, or
   *  another config directory). */
  | "session-file-missing"
  /** A harness whose session records this tool does not read. */
  | "harness-not-read";

export interface StepVisit {
  cardId: string;
  cardTitle: string;
  stepTaskId: string;
  stepId: string;
  stepName: string;
  /** 1 for the card's first visit to this step, counted over every run of
   *  the card — a restart's earlier visits included. */
  visit: number;
  /** In the run's history as it stands (false: an earlier run of the card,
   *  before a restart, or a follow-up step). */
  inCurrentRun: boolean;
  harness: string;
  model: string | null;
  startedAt: number;
  sessions: number;
  usage: TokenUsage | null;
  /** Part of `usage` that subagents (Scouts) spent. */
  subagents: TokenUsage | null;
  unattributed: Unattributed | null;
  /** Sessions of this visit whose file was missing while others were read. */
  missingSessions: number;
}

/** Number each step task as a visit of its step, in launch order. Pure. */
export function numberVisits<T extends { stepId: string; startedAt: number }>(stepTasks: readonly T[]): (T & { visit: number })[] {
  const seen = new Map<string, number>();
  return [...stepTasks].sort((a, b) => a.startedAt - b.startedAt).map((t) => {
    const visit = (seen.get(t.stepId) ?? 0) + 1;
    seen.set(t.stepId, visit);
    return { ...t, visit };
  });
}

const METRICS = ["input", "output", "cacheRead", "cacheWrite", "calls", "turns"] as const;
type Metric = (typeof METRICS)[number];

export interface StepSummary {
  stepName: string;
  /** "first" (visit 1), "repeat" (visit 2 and later) or "all". */
  visits: "first" | "repeat" | "all";
  count: number;
  unattributed: number;
  median: Record<Metric | "weighted", number | null>;
  total: Record<Metric | "weighted", number>;
}

/** Medians and totals per step name, for all its visits and split into the
 *  first visit and the repeats (a Build sent back is another kind of visit
 *  than a first Build). Steps keep their first-seen order. Pure. */
export function summarizeVisits(visits: readonly StepVisit[]): StepSummary[] {
  const order: string[] = [];
  for (const v of visits) if (!order.includes(v.stepName)) order.push(v.stepName);
  const out: StepSummary[] = [];
  const row = (stepName: string, kind: StepSummary["visits"], rows: readonly StepVisit[]): StepSummary => {
    const counted = rows.filter((r) => r.usage !== null);
    const values = (pick: (u: TokenUsage) => number) => counted.map((r) => pick(r.usage!));
    const medians = {} as StepSummary["median"];
    const totals = {} as StepSummary["total"];
    for (const m of METRICS) {
      medians[m] = median(values((u) => u[m]));
      totals[m] = values((u) => u[m]).reduce((a, b) => a + b, 0);
    }
    medians.weighted = median(values(weightedTokens));
    totals.weighted = values(weightedTokens).reduce((a, b) => a + b, 0);
    return { stepName, visits: kind, count: rows.length, unattributed: rows.length - counted.length, median: medians, total: totals };
  };
  for (const name of order) {
    const rows = visits.filter((v) => v.stepName === name);
    out.push(row(name, "all", rows));
    const first = rows.filter((v) => v.visit === 1);
    const repeat = rows.filter((v) => v.visit > 1);
    if (first.length > 0 && repeat.length > 0) out.push(row(name, "first", first), row(name, "repeat", repeat));
  }
  return out;
}

export interface StepTokenReport {
  project: string;
  pipeline: string | null;
  cards: { id: string; title: string; finishedAt: number; steps: number }[];
  visits: StepVisit[];
  summary: StepSummary[];
  /** Everything counted, over all cards. */
  total: TokenUsage & { weighted: number };
}

export function buildReport(input: Pick<StepTokenReport, "project" | "pipeline" | "cards" | "visits">): StepTokenReport {
  const total = input.visits.reduce((acc, v) => (v.usage ? addUsage(acc, v.usage) : acc), ZERO_USAGE);
  return { ...input, summary: summarizeVisits(input.visits), total: { ...total, weighted: weightedTokens(total) } };
}

const n = (v: number | null): string => (v === null ? "—" : v.toLocaleString("en-US"));

function table(head: string[], rows: string[][], rightFrom: number): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i >= rightFrom ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const UNATTRIBUTED_WORDS: Record<Unattributed, string> = {
  "no-session": "no agent session (never started, or run by Agetor)",
  "session-file-missing": "session file not found",
  "harness-not-read": "harness not read by this tool",
};

/** The report as text: one row per step visit, then medians and totals. Pure. */
export function renderReport(r: StepTokenReport): string {
  const out: string[] = [];
  out.push(`Tokens per step visit — ${r.project}${r.pipeline ? `, pipeline ${r.pipeline}` : ""}: last ${r.cards.length} finished card${r.cards.length === 1 ? "" : "s"}`);
  out.push("input = uncached input; weighted = output×5 + cache write×1.25 + input + cache read×0.1");
  out.push("");
  const tokenCells = (u: TokenUsage | null) => u
    ? [n(u.input), n(u.output), n(u.cacheRead), n(u.cacheWrite), n(u.calls), n(u.turns), n(weightedTokens(u))]
    : ["—", "—", "—", "—", "—", "—", "—"];
  const head = ["card", "step", "visit", "harness", "model", "input", "output", "cache read", "cache write", "calls", "turns", "weighted"];
  out.push(table(head, r.visits.map((v) => [
    v.cardTitle.slice(0, 28), v.stepName, `${v.visit}${v.inCurrentRun ? "" : "*"}`, v.harness, v.model ?? "—", ...tokenCells(v.usage),
  ]), 5));
  if (r.visits.some((v) => !v.inCurrentRun)) out.push("* not in the run's present history: an earlier run of the card (before a restart), or a follow-up step");
  out.push("");
  out.push("Per step — median per visit (total)");
  const cell = (s: StepSummary, m: Metric | "weighted") => `${n(s.median[m])} (${n(s.total[m])})`;
  out.push(table(
    ["step", "visits", "n", "input", "output", "cache read", "cache write", "calls", "turns", "weighted"],
    r.summary.map((s) => [s.stepName, s.visits, `${s.count - s.unattributed}/${s.count}`, cell(s, "input"), cell(s, "output"), cell(s, "cacheRead"), cell(s, "cacheWrite"), cell(s, "calls"), cell(s, "turns"), cell(s, "weighted")]),
    2,
  ));
  out.push("");
  out.push(`All cards: input ${n(r.total.input)}, output ${n(r.total.output)}, cache read ${n(r.total.cacheRead)}, cache write ${n(r.total.cacheWrite)}, calls ${n(r.total.calls)}, turns ${n(r.total.turns)}, weighted ${n(r.total.weighted)}`);
  const missing = r.visits.filter((v) => v.unattributed !== null || v.missingSessions > 0);
  if (missing.length > 0) {
    out.push("");
    out.push(`Not attributed (${missing.length} of ${r.visits.length} visits):`);
    for (const v of missing) {
      const why = v.unattributed ? UNATTRIBUTED_WORDS[v.unattributed] : `${v.missingSessions} of ${v.sessions} session files not found — the numbers above are a lower bound`;
      out.push(`- ${v.cardTitle.slice(0, 40)} · ${v.stepName} visit ${v.visit} (${v.harness}, step task ${v.stepTaskId}): ${why}`);
    }
  }
  return out.join("\n");
}
