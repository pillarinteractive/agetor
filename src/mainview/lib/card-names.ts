/**
 * Short names and colors for cards, so a dependency reads at a glance: the
 * card that blocks others gets a color of its own, and every card waiting on
 * it wears a tag in that same color with its short name ("#214").
 */

/** "Issue #182: [review] Public pages…" → number + the readable rest. */
/** The pull request number in a GitHub PR URL (…/pull/334), or null. */
export function prNumberFromUrl(url: string | null | undefined): number | null {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function splitCardTitle(title: string): { issue: string | null; text: string } {
  const m = /^Issue #(\d+):\s*(?:\[[^\]]*\]\s*)?([\s\S]*)$/.exec(title);
  return m ? { issue: m[1]!, text: m[2]! || title } : { issue: null, text: title };
}

/** A card's short handle for tags: its issue number ("#214"), else its PR
 *  ("PR #210"), else its first word or two ("Provision…"). The tag's color
 *  does the linking; the text only has to be recognisable. */
export function shortCardName(title: string, opts: { issueUrl?: string | null; prNumber?: number | null; max?: number } = {}): string {
  const t = splitCardTitle(title);
  if (t.issue) return `#${t.issue}`;
  const fromUrl = /\/issues\/(\d+)/.exec(opts.issueUrl ?? "");
  if (fromUrl) return `#${fromUrl[1]}`;
  if (opts.prNumber) return `PR #${opts.prNumber}`;
  const max = opts.max ?? 14;
  const words = t.text.split(/\s+/);
  let out = words[0] ?? t.text;
  for (const w of words.slice(1)) {
    if (`${out} ${w}`.length > max) break;
    out = `${out} ${w}`;
  }
  return out.length < t.text.length ? `${out.slice(0, max)}…` : out;
}

/** Tag classes, chosen per blocking card. Distinct hues, readable on the
 *  dark board and the light one. */
const PALETTE = [
  "bg-sky-500/20 text-sky-700 dark:text-sky-300 ring-sky-500/50",
  "bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300 ring-fuchsia-500/50",
  "bg-amber-500/20 text-amber-700 dark:text-amber-300 ring-amber-500/50",
  "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/50",
  "bg-rose-500/20 text-rose-700 dark:text-rose-300 ring-rose-500/50",
  "bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 ring-indigo-500/50",
  "bg-lime-500/20 text-lime-700 dark:text-lime-300 ring-lime-500/50",
  "bg-orange-500/20 text-orange-700 dark:text-orange-300 ring-orange-500/50",
];

/** The tag color for a blocking card — stable for its id. */
export function blockerColor(taskId: string): string {
  let h = 0;
  for (let i = 0; i < taskId.length; i++) h = (h * 31 + taskId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
