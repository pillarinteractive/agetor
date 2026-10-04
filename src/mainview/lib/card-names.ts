/**
 * Short names and colors for cards, so a dependency reads at a glance: the
 * card that blocks others gets a color of its own, and every card waiting on
 * it wears a tag in that same color with its short name ("#214").
 */

/** "Issue #182: [review] Public pages…" → number + the readable rest. */
export function splitCardTitle(title: string): { issue: string | null; text: string } {
  const m = /^Issue #(\d+):\s*(?:\[[^\]]*\]\s*)?([\s\S]*)$/.exec(title);
  return m ? { issue: m[1]!, text: m[2]! || title } : { issue: null, text: title };
}

/** "#214" for an issue card, else its first few words. */
export function shortCardName(title: string, max = 24): string {
  const t = splitCardTitle(title);
  if (t.issue) return `#${t.issue}`;
  return t.text.length > max ? `${t.text.slice(0, max - 1).trimEnd()}…` : t.text;
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
