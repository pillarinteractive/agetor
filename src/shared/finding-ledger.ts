/**
 * The finding ledger (owner decision 2026-10-14, "fewer Build and Review
 * rounds"). Measured that day: after a card's first review, Review raised
 * almost no new findings (121, then 12, 9, 6), yet 88 of 110 change requests
 * were second or later rounds — the same finding returning after Build fixed
 * one instance of it. The ledger counts, per finding ID, how often Review
 * raised it again, and the runner acts on it:
 *
 *   repeat 0  first raised; the next Build searches the whole class
 *   repeat 1  raised again; the next Build runs on the escalation profile
 *   repeat 2  raised a third time; it leaves the card (`CLOSE_AT`): filed as
 *             a `bug` follow-up, and Review approves the rest with Refs — or,
 *             for a mandatory, security, privacy or data-loss finding, the
 *             run finishes through the unapproved wrap-up. Never a Build 4.
 *
 * A finding Review stops raising is resolved. IDs are what Review writes at
 * the start of a finding ("823-R3: …", "ARC08-R25 — …"); a finding with no
 * recognisable ID is not counted. Pure.
 */

export const CLOSE_AT = 2;
const MAX_FINDINGS = 60;
const MAX_TEXT = 600;

export interface LedgerFinding {
  /** The text as Review last wrote it. */
  text: string;
  /** Review executions (run seq) that raised it, oldest first. */
  raised: number[];
  /** How many times it came back after it was first raised. */
  repeat: number;
  state: "open" | "resolved" | "closed";
  /** The follow-up it was filed as when it was closed out. */
  issue?: { number: number; url: string } | null;
}

export type FindingLedger = Record<string, LedgerFinding>;

const ID_RE = /^[\s*`_>#-]*([A-Za-z0-9][A-Za-z0-9._]*(?:-[A-Za-z0-9._]+)*)[*`_]*\s*(?::|—|–|-\s|\))/;

/** The stable ID a finding starts with, or null. An ID has a digit and at
 *  most 24 characters: "823-R3", "OPS01-R6", "R1153-04", "E893-R5". */
export function findingId(text: string): string | null {
  const m = ID_RE.exec(text);
  const id = m?.[1];
  if (!id || id.length > 24 || !/\d/.test(id) || !/[A-Za-z]|-/.test(id)) return null;
  return id.toUpperCase();
}

/** The ledger after a Review execution `seq` settled with these findings
 *  (empty on approval). Open findings it did not raise are resolved; a
 *  closed one stays closed whatever Review says. */
export function recordReview(ledger: FindingLedger | undefined, seq: number, findings: readonly string[]): FindingLedger {
  const next: FindingLedger = {};
  for (const [id, f] of Object.entries(ledger ?? {})) next[id] = { ...f, raised: [...f.raised] };
  const now = new Set<string>();
  for (const text of findings) {
    const id = findingId(text);
    if (!id || now.has(id)) continue;
    now.add(id);
    const prev = next[id];
    if (!prev) {
      next[id] = { text: text.slice(0, MAX_TEXT), raised: [seq], repeat: 0, state: "open" };
      continue;
    }
    if (prev.raised.includes(seq)) continue;
    if (prev.state === "closed") continue;
    next[id] = { ...prev, text: text.slice(0, MAX_TEXT), raised: [...prev.raised, seq], repeat: prev.repeat + 1, state: "open" };
  }
  for (const [id, f] of Object.entries(next)) {
    if (f.state === "open" && !now.has(id)) next[id] = { ...f, state: "resolved" };
  }
  // Bounded: keep the open ones and the newest of the rest.
  const ids = Object.keys(next);
  if (ids.length > MAX_FINDINGS) {
    const drop = ids.filter((id) => next[id]!.state !== "open")
      .sort((a, b) => (next[a]!.raised.at(-1) ?? 0) - (next[b]!.raised.at(-1) ?? 0))
      .slice(0, ids.length - MAX_FINDINGS);
    for (const id of drop) delete next[id];
  }
  return next;
}

export const openFindings = (l: FindingLedger | undefined) => Object.entries(l ?? {}).filter(([, f]) => f.state === "open");

/** Open findings Review has raised again: the next Build escalates. */
export const repeatedOpen = (l: FindingLedger | undefined) => openFindings(l).filter(([, f]) => f.repeat >= 1 && f.repeat < CLOSE_AT);

/** Open findings that reached the close-out. */
export const dueForCloseOut = (l: FindingLedger | undefined) => openFindings(l).filter(([, f]) => f.repeat >= CLOSE_AT);

export function markClosed(l: FindingLedger, id: string, issue: { number: number; url: string } | null): FindingLedger {
  const f = l[id];
  return f ? { ...l, [id]: { ...f, state: "closed", issue } } : l;
}

/** Whether a finding reads as one Review must never approve past: an unmet
 *  mandatory criterion, or a security, privacy or data-loss defect. */
export function mustNotApprovePast(text: string): boolean {
  return /\bmandatory\b|\bacceptance criteri|\bsecurity\b|\bprivacy\b|\bdata[- ]loss\b|\bsecret\b|\binjection\b|\bauthori[sz]ation\b|\btenant isolation\b/i.test(text);
}

// ── The Class search gate ──────────────────────────────────────────────────

/** IDs among `required` with no Class search line in `text`: a line under a
 *  "Class search" heading or label that names the ID, a command and a hit
 *  count of 1 or more ("- 823-R3: rg -n 'x' pkg → 4 hits, all fixed",
 *  "R2: ast-grep … → 1 hit (single site)"). */
export function missingClassSearch(text: string, required: readonly string[]): string[] {
  const at = text.search(/class search\s*:?/i);
  if (at < 0) return [...required];
  const section = text.slice(at, at + 8000);
  const lines = section.split("\n");
  const covered = new Set<string>();
  for (const line of lines) {
    const id = findingId(line.replace(/^\s*[-*]\s*/, ""));
    if (!id) continue;
    const hits = /(\d+)\s+hits?\b/i.exec(line);
    if (hits && Number(hits[1]) >= 1 && /\b(rg|ast-grep|grep|git grep)\b/.test(line)) covered.add(id);
  }
  return required.filter((id) => !covered.has(id.toUpperCase()));
}

// ── What the steps are told ────────────────────────────────────────────────

const quote = (s: string) => s.replace(/\s+/g, " ").trim();

/** For a Build addressing findings: which need a Class search line, and
 *  which have left the card. */
export function buildFindingsNote(l: FindingLedger | undefined, escalated: boolean): string | null {
  const open = openFindings(l);
  const closed = Object.entries(l ?? {}).filter(([, f]) => f.state === "closed");
  if (open.length === 0 && closed.length === 0) return null;
  const parts = ["## Open review findings (kept by Agetor)"];
  if (escalated) {
    parts.push("You run on the escalation profile because Review raised a finding again after a fix. Read what the last Build searched and changed (below and in its handoff) before searching yourself; fix the invariant at its root and add one test that covers every instance.");
  }
  for (const [id, f] of open) {
    parts.push(`- **${id}** (raised ${f.raised.length} time${f.raised.length === 1 ? "" : "s"}${f.repeat >= 1 ? ", came back after a fix" : ""}): ${quote(f.text)}`);
  }
  if (open.length > 0) {
    parts.push(
      "Before editing, search the whole repository for each finding's class (`scripts/ai-exec -- rg -n …` or `ast-grep`) and fix every hit. " +
        "Your handoff summary must contain a `Class search:` section with one line per ID above: " +
        "`- <ID>: <command> → <n> hits, <what you did>` (a single site: `→ 1 hit (single site)`). Agetor returns a handoff without it to you before Review runs.",
    );
  }
  for (const [id, f] of closed) {
    parts.push(`- ${id} has left this card${f.issue ? ` as #${f.issue.number}` : ""}: do not work on it here.`);
  }
  return parts.join("\n");
}

/** For a re-review: what is still open, with its history. */
export function reviewFindingsNote(l: FindingLedger | undefined): string | null {
  const entries = Object.entries(l ?? {}).filter(([, f]) => f.state === "open" || f.state === "closed");
  if (entries.length === 0) return null;
  const parts = ["## Findings so far (kept by Agetor)"];
  for (const [id, f] of entries) {
    parts.push(f.state === "closed"
      ? `- ${id}: closed out${f.issue ? ` as follow-up #${f.issue.number}` : ""} after it came back ${f.repeat} times. Do not raise it again here.`
      : `- ${id} (raised ${f.raised.length}×): ${quote(f.text)}`);
  }
  parts.push("Verify each open ID against the delta and Build's `Class search:` lines. Keep each ID for one invariant; a new invariant gets a new ID.");
  return parts.join("\n");
}

/** For the Review after a close-out left nothing else open. */
export function closeOutReviewNote(closed: readonly { id: string; text: string; issue: { number: number } | null }[]): string {
  return [
    "## Findings closed out by Agetor — decide the verdict",
    "These findings came back after two fixes, one on the escalation profile. Agetor took them off this card instead of a fourth Build:",
    ...closed.map((c) => `- ${c.id}${c.issue ? ` → follow-up #${c.issue.number}` : ""}: ${quote(c.text)}`),
    "- If none of them is an unmet mandatory requirement or a security, privacy or data-loss defect: approve the rest of the work and make the closing verdict `Refs`, naming the follow-ups.",
    "- If one of them is: hand off to Build as usual. Agetor then finishes the run through Finish, published as not approved, never merged.",
  ].join("\n");
}

/** Read leniently: an unreadable record is dropped. */
export function sanitizeFindingLedger(raw: unknown): FindingLedger | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: FindingLedger = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FINDINGS)) {
    if (!v || typeof v !== "object" || id.length > 24) continue;
    const f = v as Record<string, unknown>;
    const raised = Array.isArray(f.raised) ? f.raised.filter((n): n is number => Number.isSafeInteger(n)).slice(-50) : [];
    const state = f.state === "open" || f.state === "resolved" || f.state === "closed" ? f.state : null;
    if (!state || typeof f.text !== "string") continue;
    const issue = f.issue && typeof f.issue === "object" && Number.isSafeInteger((f.issue as { number?: unknown }).number)
      ? { number: (f.issue as { number: number }).number, url: String((f.issue as { url?: unknown }).url ?? "") } : null;
    out[id] = { text: f.text.slice(0, MAX_TEXT), raised, repeat: Number.isSafeInteger(f.repeat) ? Math.max(0, f.repeat as number) : 0, state, ...(state === "closed" ? { issue } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}
