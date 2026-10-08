import { test, expect } from "bun:test";
import {
  classifyFailure,
  matchClaudeResetNotice,
  nextRetryAt,
  parseResetTime,
  CLAUDE_QUOTA_PAUSED_RE,
  QUOTA_RESET_MARGIN_MS,
  TRANSIENT_RETRY_MAX,
} from "./usage-limit.ts";

// 2026-10-06 23:18 local — when the real session limit hit.
const NOW = new Date(2026, 9, 6, 23, 18, 0).getTime();
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();

test("claude turn-start limit (real run_events text) is a quota with its reset time", () => {
  const text = [
    "You've hit your session limit · resets 11:30pm (America/Chicago)",
    "api error: HTTP 429 — turn aborted; blocked for manual retry",
    "turn duration: 484ms",
  ].join("\n");
  const c = classifyFailure(text, NOW)!;
  expect(c.kind).toBe("quota");
  expect(c.resetAt).toBe(local(2026, 9, 6, 23, 30));
  expect(c.detail).toContain("session limit");
});

test("claude mid-turn notices are quotas; the auto-continue time parses", () => {
  const c = classifyFailure("Usage limit reached · continuing automatically at 8am · esc to cancel", NOW)!;
  expect(c.kind).toBe("quota");
  expect(c.resetAt).toBe(local(2026, 9, 7, 8, 0)); // already past today → tomorrow
  expect(classifyFailure("[Usage limit reached; a short grace allowance remains, then this turn is cut off…", NOW)?.kind).toBe("quota");
});

test("codex usage-limit messages (codex-cli 0.160 strings) are quotas", () => {
  const same = classifyFailure("You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 11:45 PM.", NOW)!;
  expect(same.kind).toBe("quota");
  expect(same.resetAt).toBe(local(2026, 9, 6, 23, 45));
  const later = classifyFailure("You've hit your usage limit. Try again at Oct 8th, 2026 3:05 PM.", NOW)!;
  expect(later.resetAt).toBe(local(2026, 9, 8, 15, 5));
  const model = classifyFailure("You've hit your usage limit for gpt-6.1-sol. Switch to another model now, or try again at Oct 9th, 2026 1:00 AM.", NOW)!;
  expect(model.resetAt).toBe(local(2026, 9, 9, 1, 0));
  expect(classifyFailure("Quota exceeded. Check your plan and billing details.", NOW)?.kind).toBe("quota");
  expect(classifyFailure("You've hit your usage limit. Try again later.", NOW)).toEqual({ kind: "quota", resetAt: null, detail: "You've hit your usage limit. Try again later." });
});

test("overload, capacity and launch failures are transient; other text is unclassified", () => {
  expect(classifyFailure("api error: HTTP 529 — turn aborted; blocked for manual retry")?.kind).toBe("transient");
  expect(classifyFailure("Selected model is at capacity. Please try a different model.")?.kind).toBe("transient");
  expect(classifyFailure("claude session JSONL never appeared: (empty — claude has not drawn any TUI output yet)")?.kind).toBe("transient");
  expect(classifyFailure("failed to start codex session: no server")?.kind).toBe("transient");
  expect(classifyFailure("I added a per-IP rate limit to /join")).toBeNull();
  expect(classifyFailure("env: node: No such file or directory")).toBeNull();
});

test("parseResetTime handles dated claude resets and rejects nonsense", () => {
  expect(parseResetTime("You've hit your weekly limit · resets Oct 9, 2pm (America/Chicago)", NOW)).toBe(local(2026, 9, 9, 14, 0));
  expect(parseResetTime("resets 13:00pm", NOW)).toBeNull();
  expect(parseResetTime("no time here", NOW)).toBeNull();
});

test("nextRetryAt: quota waits for the reset plus a margin, else backs off 15/30/60 and never gives up", () => {
  const reset = local(2026, 9, 6, 23, 30);
  expect(nextRetryAt("quota", 1, reset, NOW)).toBe(reset + QUOTA_RESET_MARGIN_MS);
  expect(nextRetryAt("quota", 1, null, NOW)).toBe(NOW + 15 * 60_000);
  expect(nextRetryAt("quota", 2, null, NOW)).toBe(NOW + 30 * 60_000);
  expect(nextRetryAt("quota", 3, null, NOW)).toBe(NOW + 60 * 60_000);
  expect(nextRetryAt("quota", 40, null, NOW)).toBe(NOW + 60 * 60_000);
  // A reset that's already (just) passed retries right away, after the margin.
  expect(nextRetryAt("quota", 1, NOW - 60_000, NOW)).toBe(NOW + QUOTA_RESET_MARGIN_MS);
});

test("nextRetryAt: transient backs off 1/5/15/30 minutes, then gives up", () => {
  expect(TRANSIENT_RETRY_MAX).toBe(4);
  expect([1, 2, 3, 4].map((a) => nextRetryAt("transient", a, null, NOW)! - NOW)).toEqual([60_000, 300_000, 900_000, 1_800_000]);
  expect(nextRetryAt("transient", 5, null, NOW)).toBeNull();
});

test("claude reset notice: exact markers only", () => {
  expect(matchClaudeResetNotice(["", "  Usage limit has reset · press enter to continue", "> "])).toBe(true);
  expect(matchClaudeResetNotice(["Your usage limit has reset", "Press enter to continue"])).toBe(true);
  expect(matchClaudeResetNotice(["Usage limit reached · continuing automatically at 8am · esc to cancel"])).toBe(false);
  expect(matchClaudeResetNotice(["The agent said: Usage limit has reset · press enter to continue, so I did"])).toBe(false);
  expect(matchClaudeResetNotice(["Your usage limit has reset", "Continue the task"])).toBe(false);
});

test("claude paused notice regex matches the auto-continue notices only", () => {
  expect(CLAUDE_QUOTA_PAUSED_RE.test("Usage limit reached · continuing automatically at 11:30pm · esc to cancel")).toBe(true);
  expect(CLAUDE_QUOTA_PAUSED_RE.test("Usage limit reached again · continuing automatically when it resets · esc to cancel")).toBe(true);
  expect(CLAUDE_QUOTA_PAUSED_RE.test("Usage limit has reset · press enter to continue")).toBe(false);
});
