import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "agetor-quota-fallback-"));
process.env.AGETOR_DATA_DIR = dir;
const { harnesses, harnessUsage, preferences } = await import("./db.ts");
const { QUOTA_FALLBACK_PREF, QUOTA_FALLBACK_UNTIL_PREF, UNKNOWN_RESET_WINDOW_MS, fallbackHarnessFor, harnessDuringLimit, noteQuotaLimit,
  parseQuotaFallback, quotaLimited, usageAtThreshold } = await import("./quota-fallback.ts");
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

const usage = (meters: { id: string; usedPercent: number; resetsAtMs: number | null; scope?: string }[], status: "ok" | "error" = "ok") =>
  harnessUsage.upsert({ harnessId: "claude-code", kind: "claude-code", planType: "max", status: status as never, source: "api" as never, fetchedAtMs: 1_000,
    meters: meters.map((m) => ({ label: m.id, ...m })), reason: null });

test("parseQuotaFallback keeps a valid atPercent and its meters, and drops an invalid one", () => {
  expect(parseQuotaFallback(JSON.stringify({ enabled: true, harness: "x", atPercent: 92 }))).toEqual({ enabled: true, from: ["claude-code"], harness: "x", atPercent: 92 });
  expect(parseQuotaFallback(JSON.stringify({ enabled: true, harness: "x", atPercent: 92, meters: ["session", " "] }))).toEqual({ enabled: true, from: ["claude-code"], harness: "x", atPercent: 92, meters: ["session"] });
  for (const bad of [0, 101, "92", null]) expect(parseQuotaFallback(JSON.stringify({ enabled: true, harness: "x", atPercent: bad, meters: ["session"] }))).toEqual({ enabled: true, from: ["claude-code"], harness: "x" });
});

test("without atPercent a high usage snapshot changes nothing", () => {
  usage([{ id: "session", usedPercent: 99, resetsAtMs: 10_000 }]);
  expect(usageAtThreshold("claude-code", 2_000)).toBe(false);
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-code");
});

test("at or above atPercent new steps start on the backup, below it they do not", () => {
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup", atPercent: 92 });
  usage([{ id: "session", usedPercent: 91, resetsAtMs: 10_000 }, { id: "weekly_all", usedPercent: 84, resetsAtMs: 10_000 }]);
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-code");
  usage([{ id: "session", usedPercent: 92, resetsAtMs: 10_000 }, { id: "weekly_all", usedPercent: 84, resetsAtMs: 10_000 }]);
  expect(usageAtThreshold("claude-code", 2_000)).toBe(true);
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-backup");
  expect(harnessDuringLimit("codex", 2_000)).toBe("codex"); // not covered
});

test("a meter whose window has reset no longer counts, and a missing reset time still does", () => {
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup", atPercent: 92 });
  usage([{ id: "session", usedPercent: 97, resetsAtMs: 10_000 }]);
  expect(harnessDuringLimit("claude-code", 9_999)).toBe("claude-backup");
  expect(harnessDuringLimit("claude-code", 10_000)).toBe("claude-code");
  usage([{ id: "session", usedPercent: 97, resetsAtMs: null }]);
  expect(harnessDuringLimit("claude-code", 99_999)).toBe("claude-backup");
});

test("model-scoped meters are ignored by default and counted only when named", () => {
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup", atPercent: 92 });
  usage([{ id: "session", usedPercent: 10, resetsAtMs: 10_000 }, { id: "weekly_scoped", usedPercent: 99, resetsAtMs: 10_000, scope: "Opus" }]);
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-code");
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup", atPercent: 92, meters: ["weekly_scoped"] });
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-backup");
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup", atPercent: 92, meters: ["weekly_all"] });
  usage([{ id: "session", usedPercent: 99, resetsAtMs: 10_000 }, { id: "weekly_all", usedPercent: 50, resetsAtMs: 10_000 }]);
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-code"); // only the named meter counts
});

test("no snapshot, a failed snapshot, or no usable backup keeps the step on its own harness", () => {
  configure({ enabled: true, from: ["claude-code"], harness: "claude-backup", atPercent: 92 });
  harnessUsage.delete?.("claude-code");
  usage([{ id: "session", usedPercent: 99, resetsAtMs: 10_000 }], "error");
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-code");
  usage([{ id: "session", usedPercent: 99, resetsAtMs: 10_000 }]);
  harnesses.setEnabled("claude-backup", false);
  expect(usageAtThreshold("claude-code", 2_000)).toBe(true);
  expect(harnessDuringLimit("claude-code", 2_000)).toBe("claude-code");
});
