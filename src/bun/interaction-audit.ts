/**
 * A dismissed prompt leaves a record. A prompt card scraped from an agent's
 * terminal (`tmux_prompt`) lives only in memory: once it was dismissed —
 * "none of these", sent by the owner, an agent or the planner — nothing said
 * what it had shown or why it was judged not to be a question (the #944
 * card of 2026-10-11 was an idle composer read as a prompt, and no trace of
 * its text survived the dismissal). The dismissal is written to the card's
 * timeline: what the pane showed, and the reason the caller gave.
 */
import type { TmuxPromptRequest } from "./interactions.ts";
import { recordActivity } from "./activity.ts";

const SHOWN_LINES = 6;
const SHOWN_CHARS = 600;
const REASON_CHARS = 500;

/** The last few non-empty lines of what the prompt card showed, on one line. Pure. */
export function promptExcerpt(paneText: string): string {
  const lines = paneText.split("\n").map((l) => l.trim()).filter(Boolean).slice(-SHOWN_LINES);
  const text = lines.join(" ⏎ ");
  return text.length > SHOWN_CHARS ? `…${text.slice(-SHOWN_CHARS)}` : text;
}

/** The timeline line for a dismissed prompt. Pure. */
export function dismissalNote(req: Pick<TmuxPromptRequest, "paneText" | "unparsable" | "choices">, reason: string | null): string {
  const kind = req.unparsable ? "an unrecognised prompt (no choices could be read)" : `a prompt with ${req.choices.length} choice${req.choices.length === 1 ? "" : "s"}`;
  const why = reason?.trim() ? reason.trim().replace(/\s+/g, " ").slice(0, REASON_CHARS) : "no reason given";
  return `Prompt dismissed without an answer — ${kind}. It showed: "${promptExcerpt(req.paneText) || "(nothing)"}". Reason: ${why}`;
}

/** Write it on the card the owner sees: a pipeline step's prompt goes on its parent. */
export function recordPromptDismissal(req: Pick<TmuxPromptRequest, "taskId" | "pipelineParentId" | "paneText" | "unparsable" | "choices">, reason: string | null): void {
  recordActivity(req.pipelineParentId ?? req.taskId, { kind: "auto", text: dismissalNote(req, reason), tone: reason?.trim() ? "muted" : "warning" });
}
