/**
 * The release-gate rule for a roadmap step whose PR merged with a
 * `Refs #N` closing verdict (owner decision 2026-10-14): when everything the
 * verdict still lists is human approval or external evidence — nothing an
 * agent could build — Agetor closes #N itself and files one release-gate
 * follow-up issue (src/bun/autopilot.ts, `releaseGatePass`).
 *
 * The judgement is deliberately conservative: an item closes only when it
 * names evidence/approval vocabulary AND names no engineering vocabulary.
 * An item that names neither, a verdict with no list, or no verdict at all
 * keeps today's behaviour (the step waits for the owner). Pure; every
 * pattern is here so the rule is reviewable in one place.
 */

/** Words that make an item human approval or external evidence. */
export const EVIDENCE_TERMS: readonly { term: string; re: RegExp }[] = [
  { term: "approval", re: /\bapprov(?:al|als|e|ed|ing)\b/i },
  { term: "authorization", re: /\bauthori[sz](?:ation|ations|e|ed|ing)\b/i },
  { term: "sign-off", re: /\bsign[- ]?offs?\b|\bsigned[- ]off\b/i },
  { term: "receipt", re: /\breceipts?\b/i },
  { term: "qualification", re: /\bqualif(?:ication|ications|y|ied|ying)\b/i },
  { term: "measurement", re: /\bmeasure(?:ment|ments|d|s)?\b|\bmeasuring\b/i },
  { term: "invoice", re: /\binvoic(?:e|es|ed|ing)\b/i },
  { term: "custody", re: /\bcustod(?:y|ian|ians)\b/i },
  { term: "physical", re: /\bphysical(?:ly)?\b/i },
  { term: "hardware", re: /\bhardware\b/i },
  { term: "host", re: /\bhosts?\b/i },
  { term: "elapsed", re: /\belapsed\b/i },
  { term: "human", re: /\bhumans?\b/i },
  { term: "owner", re: /\bowners?\b/i },
  { term: "participant", re: /\bparticipants?\b/i },
  { term: "consent", re: /\bconsent(?:s|ed)?\b/i },
  { term: "external review", re: /\bexternal(?:ly)?[- ]review(?:s|ed)?\b/i },
  { term: "keys", re: /\bkeys?\b/i },
  // An owner's ruling on a claim or a finding ("claim disposition").
  { term: "disposition", re: /\bdispositions?\b/i },
];

/** Words that make an item engineering work an agent could do. Any one of
 *  them keeps the issue open, whatever else the item says. */
export const ENGINEERING_TERMS: readonly { term: string; re: RegExp }[] = [
  { term: "not yet implemented", re: /\bnot\s+(?:yet\s+)?implemented\b/i },
  { term: "runtime integration", re: /\bruntime[- ]integrat/i },
  { term: "implement", re: /\bimplement(?:s|ed|ing|ation|ations)?\b/i },
  { term: "integrate", re: /\bintegrat(?:e|es|ed|ing|ion|ions)\b/i },
  { term: "wire", re: /\bwir(?:e|es|ed|ing)\b/i },
  { term: "emit", re: /\bemi(?:t|ts|tted|tting|ssion|ssions)\b/i },
  { term: "execute", re: /\bexecut(?:e|es|ed|ing|ion|ions|or)\b/i },
  { term: "migrate", re: /\bmigrat(?:e|es|ed|ing|ion|ions)\b/i },
  { term: "refactor", re: /\brefactor(?:s|ed|ing)?\b/i },
  { term: "test coverage", re: /\btest[- ]coverage\b|\b(?:unit|integration|e2e|regression)\s+tests?\b/i },
  { term: "fix", re: /\bfix(?:es|ed|ing)?\b/i },
  { term: "build", re: /\bbuild(?:s|ing)?\b|\bbuilt\b/i },
  { term: "code", re: /\bcode\b/i },
  { term: "endpoint", re: /\bendpoints?\b/i },
  { term: "schema", re: /\bschemas?\b/i },
  { term: "harness", re: /\bharness(?:es)?\b/i },
];

export type RefsCloseDecision = "close" | "keep";

export interface RefsVerdict {
  decision: RefsCloseDecision;
  /** One sentence on why: shown on the card and in the follow-up. */
  why: string;
  /** The verdict line as the PR wrote it (comments stripped), or null. */
  line: string | null;
  /** The remaining items, verbatim, in order. */
  items: string[];
  /** Items naming engineering vocabulary, with the term found. */
  engineering: { item: string; term: string }[];
  /** Items naming neither vocabulary. */
  unmatched: string[];
}

const keep = (why: string, line: string | null = null, items: string[] = [], engineering: RefsVerdict["engineering"] = [], unmatched: string[] = []): RefsVerdict =>
  ({ decision: "keep", why, line, items, engineering, unmatched });

/** "remain pending." / "remain recorded gaps (#1447)." — only at the very
 *  end of the list, so a phrase in the middle never cuts items off. */
const TRAILER = /\s*\b(?:all\s+|still\s+)*(?:remains?|are|is)\s+(?:still\s+)?(?:pending|outstanding|open|unmet|recorded\s+gaps?|gaps?|to\s+(?:be\s+)?(?:done|recorded|collected))(?:\s*\([^)]*\))?\s*[.!]?\s*$/i;
/** A verdict that points elsewhere in the body for its list. */
const POINTER = /^(?:see\b|as\s+listed\b|listed\s+below\b|per\b|the\s+(?:items?|gaps?|remaining(?:\s+items?)?)\s+(?:listed\s+)?(?:below|above)\b|(?:items?\s+)?below\b|remaining\s+(?:items?\s+)?(?:below|above)\b)/i;
const PENDING_SENTENCE = /\bremains?\s+(?:pending|outstanding|open|unmet|recorded\s+gaps?)\b/i;

function verdictRe(n: number): RegExp {
  return new RegExp(`\\bRefs?\\s*:?\\s+(?:[\\w.-]+/[\\w.-]+)?#${n}\\b(?!\\d)`, "i");
}

/** Split a list into items: commas, semicolons, " and " / "; and ". */
export function splitItems(list: string): string[] {
  const cleaned = list
    .replace(/\s*\((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*,\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*\)\s*/g, " ") // "(#1447)"
    .replace(/[.。]\s*$/, "")
    .trim();
  return cleaned
    .split(/\s*[,;]\s*(?:and\s+)?|\s+and\s+/i)
    .map((s) => s.replace(/^[-*•]\s*/, "").replace(/^(?:and|the)\s+/i, "").trim())
    .filter((s) => s.length > 0);
}

function classifyItems(items: string[], line: string | null): RefsVerdict {
  if (items.length === 0) return keep("the verdict lists nothing that remains, so there is nothing to judge", line);
  const engineering: RefsVerdict["engineering"] = [];
  const unmatched: string[] = [];
  for (const item of items) {
    const eng = ENGINEERING_TERMS.find((t) => t.re.test(item));
    if (eng) { engineering.push({ item, term: eng.term }); continue; }
    if (!EVIDENCE_TERMS.some((t) => t.re.test(item))) unmatched.push(item);
  }
  if (engineering.length) {
    return keep(`engineering is still listed: ${engineering.map((e) => `“${e.item}” (${e.term})`).join(", ")}`, line, items, engineering, unmatched);
  }
  if (unmatched.length) {
    return keep(`not clearly evidence or approval: ${unmatched.map((u) => `“${u}”`).join(", ")}`, line, items, engineering, unmatched);
  }
  return { decision: "close", why: "every remaining item is human approval or external evidence", line, items, engineering, unmatched };
}

/**
 * Judge the closing verdict a merged PR wrote for issue `n`. Reads the line
 * `Refs #N — <remaining…>` (any dash or a colon after the number); a verdict
 * that only points elsewhere ("— see below") takes the body's "… remain
 * pending" sentences as its list. Anything else keeps the issue open.
 */
export function classifyRefsVerdict(body: string | null | undefined, n: number): RefsVerdict {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const re = verdictRe(n);
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return keep(`the PR has no “Refs #${n}” closing verdict`);
  const line = lines[at]!.trim();
  const m = re.exec(line)!;
  const after = line.slice(m.index + m[0].length);
  const sep = /^\s*(?:[—–-]+|:)\s*/.exec(after);
  const tail = sep ? after.slice(sep[0].length).trim() : "";
  if (!tail) return keep(`the verdict is a bare “Refs #${n}” with no remaining items`, line);
  if (POINTER.test(tail)) {
    const sentences = lines
      .filter((_, i) => i !== at)
      .flatMap((l) => l.split(/(?<=[.!?])\s+/))
      .map((s) => s.trim())
      .filter((s) => PENDING_SENTENCE.test(s));
    if (!sentences.length) return keep("the verdict points elsewhere, and the PR has no “… remain pending” sentence", line);
    const items = sentences.flatMap((s) => splitItems(s.replace(/^[-*•]\s*/, "").replace(TRAILER, "")));
    return classifyItems(items, line);
  }
  return classifyItems(splitItems(tail.replace(TRAILER, "")), line);
}

// ── Preference ───────────────────────────────────────────────────────────

export const REFS_CLOSE_PREF = "refs_close";
export const REFS_CLOSE_DEFAULT_LABEL = "follow-up";

export interface RefsClosePolicy {
  mode: "release-gate" | "off";
  /** The follow-up's milestone title; null for none. */
  milestone: string | null;
  /** The follow-up's label; null for none. */
  label: string | null;
}

/**
 * `refs_close`: `"off"`, `"release-gate"` (the default when unset) or JSON
 * `{"mode": "release-gate" | "off", "milestone": "<title>" | null, "label":
 * "<name>" | null}`. Unreadable values fall back to the default mode.
 */
export function parseRefsClosePref(raw: string | null | undefined): RefsClosePolicy {
  const def: RefsClosePolicy = { mode: "release-gate", milestone: null, label: REFS_CLOSE_DEFAULT_LABEL };
  const s = (raw ?? "").trim();
  if (!s) return def;
  if (s === "off" || s === '"off"') return { ...def, mode: "off" };
  if (s === "release-gate" || s === '"release-gate"') return def;
  try {
    const v = JSON.parse(s) as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return def;
    const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
    return {
      mode: v.mode === "off" ? "off" : "release-gate",
      milestone: str(v.milestone),
      label: v.label === null ? null : (str(v.label) ?? REFS_CLOSE_DEFAULT_LABEL),
    };
  } catch {
    return def;
  }
}

// ── Texts ────────────────────────────────────────────────────────────────

export const refsCloseMarker = (n: number) => `<!-- agetor-refs-close:#${n} -->`;

export function releaseGateTitle(n: number, issueTitle: string): string {
  return `Release gate: remaining qualification of #${n} (${issueTitle.trim() || "untitled"})`;
}

export function releaseGateBody(input: { issue: number; pr: number; prUrl: string | null; verdict: RefsVerdict }): string {
  const { issue, pr, prUrl, verdict } = input;
  return [
    refsCloseMarker(issue),
    `PR ${prUrl ?? `#${pr}`} merged with the closing verdict “Refs #${issue}”. Agetor closed #${issue} under the owner's rule of 2026-10-14: everything the verdict still lists is human approval or external evidence.`,
    "## Remaining, verbatim from the verdict",
    ...verdict.items.map((i) => `- ${i}`),
    ...(verdict.line ? ["", `> ${verdict.line}`] : []),
    "",
    `Required before the main release; not a develop prerequisite. Reopen #${issue} if any item is engineering work.`,
  ].join("\n");
}

export function releaseGateCloseComment(input: { pr: number; prUrl: string | null; followup: { number: number; url: string } }): string {
  const { pr, prUrl, followup } = input;
  return [
    `Closed automatically by Agetor under the owner's rule of 2026-10-14: PR ${prUrl ?? `#${pr}`} merged, and everything its “Refs” verdict still lists is human approval or external evidence, not engineering.`,
    `The remaining items are tracked as a release gate in #${followup.number}${followup.url ? ` (${followup.url})` : ""}. Reopen this issue if any of them is engineering work.`,
  ].join("\n\n");
}
