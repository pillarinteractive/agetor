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
 * the lane off.
 *
 * A bug filed from another card's work (Review's finding close-out titles it
 * `Bug (from #N): …`) is about code that exists only on that card's branch.
 * It waits until its parent has landed — the issue closed as completed, or
 * the PR merged — since a card started earlier fails on its first step
 * looking for code that is not on the base branch. Pure.
 */
import { dependencyRefIn } from "./block-wait.ts";

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
  /** Absent when the reader didn't ask for it. */
  body?: string;
}

/** Whether a bug's parent has landed on the base branch. */
export type ParentLanding = "landed" | "open" | "unlanded" | "unknown";

const FROM_TITLE_RE = /^\s*Bug\s*(?:\([^)]*\))?\s*\(from\s+#?(\d{1,7})\)/i;
const CAME_BACK_RE = /\bon #(\d{1,7}) came back\b/i;

/** The issue or PR a bug was filed from: `Bug (from #N): …` in the title,
 *  "finding … on #N came back" (the close-out's body), or a dependency the
 *  body names ("blocked by #N until it merges"). Null when it names none. */
export function bugParent(issue: Pick<BugIssue, "number" | "title" | "body">): number | null {
  const body = issue.body ?? "";
  const m = FROM_TITLE_RE.exec(issue.title) ?? CAME_BACK_RE.exec(body);
  const n = m ? Number(m[1]) : dependencyRefIn(body);
  return n != null && n !== issue.number ? n : null;
}

const HELD_WHY: Record<Exclude<ParentLanding, "landed">, (n: number) => string> = {
  open: (n) => `it was filed from #${n}, which is still open — its code is not on the base branch yet`,
  unlanded: (n) => `it was filed from #${n}, which closed without landing (not completed, or a PR closed unmerged)`,
  unknown: (n) => `it was filed from #${n}, whose state couldn't be read`,
};

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
  /** Each parent's landing (`bugParent`). Absent: parents aren't checked. */
  parents?: ReadonlyMap<number, ParentLanding>;
}): { start: BugIssue[]; running: number; held: { issue: number; title: string; parent: number; reason: string }[] } {
  const bugs = input.open.filter((b) => b.labels.includes(input.config.label) && !input.roadmap.has(b.number)
    && !b.labels.some((l) => input.config.skipLabels.includes(l)));
  const withCard = new Set(input.cards.map((c) => c.issue));
  const running = new Set(input.cards.filter((c) => c.live).map((c) => c.issue));
  const runningBugs = bugs.filter((b) => running.has(b.number)).length;
  const room = Math.max(0, Math.min(input.config.max - runningBugs, input.free));
  const held: { issue: number; title: string; parent: number; reason: string }[] = [];
  const startable = bugs.filter((b) => {
    if (withCard.has(b.number) || !input.parents) return !withCard.has(b.number);
    const parent = bugParent(b);
    if (parent == null) return true;
    const landing = input.parents.get(parent) ?? "unknown";
    if (landing === "landed") return true;
    held.push({ issue: b.number, title: b.title, parent, reason: HELD_WHY[landing](parent) });
    return false;
  });
  const start = startable.sort((a, b) => a.number - b.number).slice(0, room);
  return { start, running: runningBugs, held: held.sort((a, b) => a.issue - b.issue) };
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
