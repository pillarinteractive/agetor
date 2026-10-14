/**
 * The bug lane (owner decision 2026-10-14): Autopilot also starts open issues
 * labelled `bug` that are not roadmap steps, ahead of roadmap cards, with at
 * most `max` of them running at once. Review files a follow-up that reports a
 * defect with that label; until this lane existed those waited indefinitely
 * behind the roadmap (#1315–#1317 sat three days).
 *
 * Configured by the `autopilot_bugs` preference:
 *   {"label": "bug", "max": 2, "skipLabels": ["manual", "agetor-owner-decision"]}
 * Those are the defaults when it is unset; "off" or {"enabled": false} turns
 * the lane off. Pure.
 */

export const BUG_LANE_PREF = "autopilot_bugs";

export interface BugLaneConfig {
  label: string;
  max: number;
  /** An issue with any of these labels is a person's, never started. */
  skipLabels: string[];
}

export const BUG_LANE_DEFAULT: BugLaneConfig = { label: "bug", max: 2, skipLabels: ["manual", "agetor-owner-decision"] };
const MAX_BUG_SLOTS = 8;

export function parseBugLane(raw: string | null | undefined): BugLaneConfig | null {
  if (raw == null || raw.trim() === "") return BUG_LANE_DEFAULT;
  if (raw.trim() === "off" || raw.trim() === '"off"') return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return BUG_LANE_DEFAULT;
    if (v.enabled === false) return null;
    const label = typeof v.label === "string" && v.label.trim() ? v.label.trim() : BUG_LANE_DEFAULT.label;
    const max = Number.isSafeInteger(v.max) && v.max >= 0 ? Math.min(v.max, MAX_BUG_SLOTS) : BUG_LANE_DEFAULT.max;
    const skipLabels = Array.isArray(v.skipLabels) ? v.skipLabels.filter((s: unknown): s is string => typeof s === "string" && !!s.trim()) : BUG_LANE_DEFAULT.skipLabels;
    return max === 0 ? null : { label, max, skipLabels };
  } catch {
    return BUG_LANE_DEFAULT;
  }
}

export interface BugIssue {
  number: number;
  title: string;
  labels: string[];
}

/**
 * Which bugs to start now. A bug that is a roadmap step is the roadmap's. A
 * bug with any card that is not archived is left alone: a live card is
 * working on it, and a finished card whose issue is still open is for the
 * owner to settle (starting another would loop). Oldest first; at most
 * `max` running and never more than `free`.
 */
export function pickBugs(input: {
  open: readonly BugIssue[];
  config: BugLaneConfig;
  roadmap: ReadonlySet<number>;
  /** Every card of this project that is not archived, by issue. */
  cards: readonly { issue: number; live: boolean }[];
  free: number;
}): { start: BugIssue[]; running: number } {
  const bugs = input.open.filter((b) => b.labels.includes(input.config.label) && !input.roadmap.has(b.number)
    && !b.labels.some((l) => input.config.skipLabels.includes(l)));
  const withCard = new Set(input.cards.map((c) => c.issue));
  const running = new Set(input.cards.filter((c) => c.live).map((c) => c.issue));
  const runningBugs = bugs.filter((b) => running.has(b.number)).length;
  const room = Math.max(0, Math.min(input.config.max - runningBugs, input.free));
  const start = bugs.filter((b) => !withCard.has(b.number)).sort((a, b) => a.number - b.number).slice(0, room);
  return { start, running: runningBugs };
}

/** What a bug's card is told, after the issue itself. */
export function bugCardPrompt(issue: BugIssue, label: string): string {
  return [
    `## Bug lane`,
    `Autopilot started this card for #${issue.number} because it is labelled \`${label}\`: a defect, outside the roadmap, ` +
      "scheduled ahead of roadmap cards.",
    "- Reproduce the defect first, with a test that fails before the fix.",
    "- Fix the root cause, not the symptom, and keep the regression test.",
    "- Stay within the issue: anything larger is a follow-up.",
    `- Close with \`Fixes #${issue.number}\` when the defect is fixed and its test passes.`,
  ].join("\n");
}
