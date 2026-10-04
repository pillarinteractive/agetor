/**
 * Display helpers for handoff text. Agents used to write `summary`/`reason`
 * as one long paragraph ("RANKED: (1) MEDIUM: … (2) LOW: …"); the contract
 * now asks for short Markdown, but older and less obedient handoffs still
 * arrive as a wall of text. {@link readableHandoffText} adds paragraph
 * breaks at the structure those paragraphs already carry; text that already
 * has line breaks is left exactly as written.
 */

const NUMBERED = /\s\((\d{1,2})\)\s/g;
// An ALL-CAPS label ending in a colon ("RANKED:", "SIMPLIFICATIONS THAT HELP
// TESTING:") that isn't right after a "(n)" marker.
const LABEL = /(?<!\(\d{1,2}\))\s([A-Z][A-Z0-9 /-]{3,}[A-Z0-9]):(?=\s)/g;

export function readableHandoffText(text: string): string {
  if (text.includes("\n")) return text;
  const numbered = text.match(NUMBERED)?.length ?? 0;
  let out = text;
  if (numbered >= 2) out = out.replace(NUMBERED, "\n\n($1) ");
  out = out.replace(LABEL, "\n\n**$1:**");
  return out.trim();
}

/** Longer than this (in characters) and the card shows the text collapsed. */
export const HANDOFF_COLLAPSE_CHARS = 700;
