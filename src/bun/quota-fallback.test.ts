import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "agetor-quota-fallback-"));
process.env.AGETOR_DATA_DIR = dir;
const { harnesses, preferences } = await import("./db.ts");
const { QUOTA_FALLBACK_PREF, QUOTA_FALLBACK_UNTIL_PREF, UNKNOWN_RESET_WINDOW_MS, fallbackHarnessFor, harnessDuringLimit, noteQuotaLimit,
  parseQuotaFallback, quotaLimited } = await import("./quota-fallback.ts");
harnesses.insert({ id: "claude-backup", kind: "claude-code", label: "Claude via backup" });
harnesses.insert({ id: "codex-backup", kind: "codex", label: "Codex via backup" });
const configure = (v: unknown) => preferences.set(QUOTA_FALLBACK_PREF, JSON.stringify(v));
beforeEach(() => {
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup" });
  preferences.set(QUOTA_FALLBACK_UNTIL_PREF, "{}");
  harnesses.setEnabled("claude-backup", true);
});
afterAll(() => rmTestDataDir(dir));

test("parseQuotaFallback needs enabled and a harness; from defaults to claude-code", () => {
  expect(parseQuotaFallback(null)).toBeNull();
  expect(parseQuotaFallback("not json")).toBeNull();
  expect(parseQuotaFallback(JSON.stringify({ enabled: false, harness: "x" }))).toBeNull();
  expect(parseQuotaFallback(JSON.stringify({ enabled: true, harness: " " }))).toBeNull();
  expect(parseQuotaFallback(JSON.stringify({ enabled: true, harness: "x" }))).toEqual({ enabled: true, from: ["claude-code"], harness: "x" });
});

test("a covered harness falls back to the configured backup of the same kind", () => {
  expect(fallbackHarnessFor("claude-code")).toBe("claude-backup");
  expect(fallbackHarnessFor("codex")).toBeNull(); // not listed in `from`
  expect(fallbackHarnessFor("claude-backup")).toBeNull(); // the backup has no backup
});

test("no fallback when unset, disabled, missing, of another kind, or the backup harness is off", () => {
  preferences.set(QUOTA_FALLBACK_PREF, "");
  expect(fallbackHarnessFor("claude-code")).toBeNull();
  configure({ enabled: false, harness: "claude-backup" });
  expect(fallbackHarnessFor("claude-code")).toBeNull();
  configure({ enabled: true, harness: "no-such-harness" });
  expect(fallbackHarnessFor("claude-code")).toBeNull();
  configure({ enabled: true, harness: "codex-backup" });
  expect(fallbackHarnessFor("claude-code")).toBeNull();
  configure({ enabled: true, harness: "claude-backup" });
  harnesses.setEnabled("claude-backup", false);
  expect(fallbackHarnessFor("claude-code")).toBeNull();
});

test("a remembered limit routes new steps to the backup until it resets", () => {
  const now = 1_000_000;
  expect(harnessDuringLimit("claude-code", now)).toBe("claude-code");
  noteQuotaLimit("claude-code", now + 60_000, now);
  expect(quotaLimited("claude-code", now + 59_999)).toBe(true);
  expect(harnessDuringLimit("claude-code", now + 59_999)).toBe("claude-backup");
  expect(harnessDuringLimit("claude-code", now + 60_000)).toBe("claude-code");
  expect(harnessDuringLimit("codex", now)).toBe("codex");
});

test("a limit with no reset time lasts the default window and never shortens a known one", () => {
  const now = 2_000_000;
  noteQuotaLimit("claude-code", null, now);
  expect(quotaLimited("claude-code", now + UNKNOWN_RESET_WINDOW_MS - 1)).toBe(true);
  expect(quotaLimited("claude-code", now + UNKNOWN_RESET_WINDOW_MS)).toBe(false);
  noteQuotaLimit("claude-code", now + 3 * UNKNOWN_RESET_WINDOW_MS, now);
  noteQuotaLimit("claude-code", null, now);
  expect(quotaLimited("claude-code", now + 2 * UNKNOWN_RESET_WINDOW_MS)).toBe(true);
});

test("a limit with no usable backup keeps the step on its own harness", () => {
  configure({ enabled: false, harness: "claude-backup" });
  noteQuotaLimit("claude-code", null, 5);
  expect(harnessDuringLimit("claude-code", 6)).toBe("claude-code");
});
