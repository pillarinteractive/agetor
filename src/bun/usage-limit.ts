/**
 * Usage-limit (quota) and transient-failure detection for agent turns, and
 * the retry schedule that follows from it. Pure; the pipeline runner
 * (`scheduleAutoRetry`), Autopilot's thread (`codex-thread.ts`) and the
 * claude scraper use it.
 *
 * Evidence for the messages matched here (not guesses):
 * - Claude Code, limit hit at turn start: a synthetic assistant line
 *   (`isApiErrorMessage`, `apiErrorStatus: 429`, `error: "rate_limit"`) whose
 *   text is `You've hit your session limit · resets 11:30pm (America/Chicago)`
 *   (agetor.sqlite run_events, 2026-10-06 23:18). Agetor then adds
 *   `api error: HTTP 429 — turn aborted; blocked for manual retry`. The 2.1.293
 *   binary has the other `You've hit your … limit` variants (weekly, monthly
 *   spend, team budget, …).
 * - Claude Code, limit hit mid-turn: the model gets `[Usage limit reached; a
 *   short grace allowance remains, then this turn is cut off …]` (status row),
 *   usually hands off `blocked` ("Your usage limit was reached, so I
 *   stopped…"), and the JSONL gets a `system`/`informational` line
 *   `Usage limit reached · continuing automatically at 11:30pm · esc to cancel`.
 * - Codex (codex-cli 0.160.0 binary strings, codex-rs `UsageLimitReached`):
 *   `You've hit your usage limit. … Try again at 3:45 PM.` (same day) or
 *   `… try again at Oct 8th, 2026 3:45 PM.`, `You've hit your usage limit for
 *   <model>. Switch to another model now, or try again at …`, and
 *   `Quota exceeded. Check your plan and billing details.` Codex's capacity
 *   error `Selected model is at capacity. Please try a different model.`
 *   (real, run_events stderr) is transient, not a quota.
 */

export type FailureKind = "quota" | "transient";

export interface FailureClass {
  kind: FailureKind;
  /** When the limit resets (ms epoch), if the message said. */
  resetAt: number | null;
  /** The line that matched, for activity/block messages. */
  detail: string;
}

/** A usage/quota limit: retrying before it resets can't succeed. */
const QUOTA_RES: RegExp[] = [
  /You['’]ve hit your\b[^.\n·]*\blimit/i, // claude + codex
  /You['’]ve reached your\b[^.\n·]*\blimit/i,
  /\bUsage limit reached\b/i, // claude notices + grace window
  /\bQuota exceeded\b/i, // codex (API key out of quota)
  /You['’]re out of (?:usage )?credits/i,
];

/** Failures that are worth retrying a few times: overload/5xx/capacity,
 *  launch flakes. A failed run that matches nothing is treated as transient
 *  too (the pipeline's own crash retry); these just say so explicitly. */
const TRANSIENT_RES: RegExp[] = [
  /\bHTTP 5\d\d\b/,
  /\boverloaded\b/i,
  /\bat capacity\b/i,
  /experiencing high load/i,
  /session JSONL never appeared/i,
  /failed to start \w+ session/i,
  /stream disconnected/i,
  /Connection failed/i,
  /exceeded retry limit/i,
];

/** Classify the text of a failed/stopped turn (its last status, stderr and
 *  assistant lines). Null when nothing recognisable matched. */
export function classifyFailure(text: string, now: number = Date.now()): FailureClass | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // The last matching line is the freshest notice (claude's "continuing
  // automatically at 11:30pm" follows its grace-window note).
  const quota = lines.findLast((l) => QUOTA_RES.some((re) => re.test(l)));
  if (quota) return { kind: "quota", resetAt: parseResetTime(text, now), detail: quota.slice(0, 200) };
  for (const re of TRANSIENT_RES) {
    const line = lines.find((l) => re.test(l));
    if (line) return { kind: "transient", resetAt: null, detail: line.slice(0, 200) };
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function at(base: Date, hour12: number, minute: number, ampm: string): Date {
  const d = new Date(base);
  let h = hour12 % 12;
  if (ampm.toLowerCase() === "pm") h += 12;
  d.setHours(h, minute, 0, 0);
  return d;
}

/**
 * When a limit message says the limit resets, in local time:
 *   claude  `resets 11:30pm (America/Chicago)`, `resets 9am`, `resets Oct 9, 2pm`,
 *           `continuing automatically at 8am`
 *   codex   `Try again at 3:45 PM.`, `try again at Oct 8th, 2026 3:45 PM.`
 * A bare time already past today means tomorrow. Null when unparseable.
 */
export function parseResetTime(text: string, now: number = Date.now()): number | null {
  const re =
    /(?:\bresets(?: at)?|continuing automatically at|try again at)\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/gi;
  let m: RegExpExecArray | null;
  let found: number | null = null;
  while ((m = re.exec(text))) {
    const [, mon, day, year, hh, mm, ap] = m;
    const hour = Number(hh);
    const minute = mm ? Number(mm) : 0;
    if (hour < 1 || hour > 12 || minute > 59) continue;
    const base = new Date(now);
    let d: Date;
    if (mon && day) {
      const mi = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
      if (mi < 0) continue;
      base.setFullYear(year ? Number(year) : base.getFullYear(), mi, Number(day));
      d = at(base, hour, minute, `${ap}m`);
      // "Jan 2" seen on Dec 31 is next year.
      if (!year && d.getTime() < now - 12 * 3_600_000) d.setFullYear(d.getFullYear() + 1);
    } else {
      d = at(base, hour, minute, `${ap}m`);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    }
    found = d.getTime(); // the last mention wins (the freshest notice)
  }
  return found;
}

/** Retry this long after a parsed reset time — the limit is enforced
 *  server-side and claude's own auto-continue fires right at the reset. */
export const QUOTA_RESET_MARGIN_MS = 5 * 60_000;
/** No reset time given: back off 15 → 30 → 60 minutes, then hourly. */
export const QUOTA_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000];
/** A reset time further out than this is probably misparsed; cap the wait. */
const QUOTA_MAX_WAIT_MS = 8 * 24 * 3_600_000;
/** Transient failures: 1 → 5 → 15 → 30 minutes, then left for the user. */
export const TRANSIENT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
export const TRANSIENT_RETRY_MAX = TRANSIENT_BACKOFF_MS.length;

/** When to retry attempt `attempt` (1-based) of a failure, or null when a
 *  transient failure has used up its attempts. Quota retries never give up. */
export function nextRetryAt(kind: FailureKind, attempt: number, resetAt: number | null, now: number = Date.now()): number | null {
  if (kind === "quota") {
    if (resetAt != null && resetAt > now - QUOTA_RESET_MARGIN_MS) {
      return Math.min(Math.max(resetAt, now) + QUOTA_RESET_MARGIN_MS, now + QUOTA_MAX_WAIT_MS);
    }
    return now + QUOTA_BACKOFF_MS[Math.min(attempt, QUOTA_BACKOFF_MS.length) - 1]!;
  }
  if (attempt > TRANSIENT_RETRY_MAX) return null;
  return now + TRANSIENT_BACKOFF_MS[attempt - 1]!;
}

/** "11:35 PM" today, else "Thu 11:35 PM". */
export function formatRetryTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** Claude's in-pane usage-limit notice (2.1.293 binary strings) while
 *  auto-continue is armed: the turn is paused until the reset and resumes by
 *  itself. */
export const CLAUDE_QUOTA_PAUSED_RE = /Usage limit reached(?: again)? · continuing automatically\b|^\s*Continuing automatically\b.*· esc to cancel/;
/** Auto-continue went stale (e.g. the Mac slept through the reset): claude
 *  waits for Enter. Exact markers only — `Usage limit has reset · press enter
 *  to continue` on one line, or the two-line `Your usage limit has reset` /
 *  `Press enter to continue` status. */
export function matchClaudeResetNotice(paneLines: string[]): boolean {
  const ls = paneLines.map((l) => l.replace(/^[\s│|●⎿>❯*·]+/, "").replace(/[\s│|]+$/, ""));
  if (ls.some((l) => l === "Usage limit has reset · press enter to continue")) return true;
  const i = ls.findIndex((l) => l === "Your usage limit has reset");
  return i >= 0 && ls.slice(i + 1, i + 3).some((l) => l === "Press enter to continue");
}

/** Step/task sessions claude has paused mid-turn on a usage limit, as the
 *  claude scraper last saw them (in memory: a restart re-learns it on the
 *  next scrape). Such a turn is still "running" but not progressing, so it
 *  holds no step slot and no Autopilot slot. */
const quotaPaused = new Map<string, number>();

export function setQuotaPaused(taskId: string, paused: boolean, now: number = Date.now()): void {
  if (paused) quotaPaused.set(taskId, now);
  else quotaPaused.delete(taskId);
}

export function isQuotaPaused(taskId: string): boolean {
  return quotaPaused.has(taskId);
}
