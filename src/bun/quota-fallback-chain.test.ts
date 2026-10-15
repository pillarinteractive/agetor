// A profile's own chain of quota backups (quota-fallback.ts): the order a
// step tries them in, a profile rule replacing the harness rules, the family
// a Review must not fall back onto, and the return to the step's own harness.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "agetor-quota-fallback-chain-"));
process.env.AGETOR_DATA_DIR = dir;
const { agentProfiles, harnesses, preferences } = await import("./db.ts");
const { HARNESS_FAMILIES_PREF, QUOTA_FALLBACK_PREF, QUOTA_FALLBACK_UNTIL_PREF, fallbackAfterLimit, fallbackForStep, familyOf,
  noteQuotaLimit, parseProfileFallbackRules, parseQuotaFallbackRules } = await import("./quota-fallback.ts");

harnesses.insert({ id: "via-deepseek", kind: "claude-code", label: "Claude Code via DeepSeek" });
harnesses.insert({ id: "via-deepinfra", kind: "claude-code", label: "Claude Code via DeepInfra" });
const reviewer = agentProfiles.insert({ name: "GPT Reviewer", harness: "codex", model: "gpt-6.1-sol", effort: "high" });
const finisher = agentProfiles.insert({ name: "Finisher", harness: "codex", model: "gpt-6-luna", effort: "medium" });
const builder = agentProfiles.insert({ name: "Sonnet Builder", harness: "claude-code", model: "sonnet-5.5", effort: "medium" });
agentProfiles.insert({ name: "DeepInfra GLM", harness: "via-deepinfra", model: "zai-org/GLM-5.3", effort: "high", mode: "auto" });
agentProfiles.insert({ name: "DeepInfra Kimi", harness: "via-deepinfra", model: "moonshotai/Kimi-K3", effort: "high" });
agentProfiles.insert({ name: "DeepSeek Pro", harness: "via-deepseek", model: "opus-5.5", effort: "high" });
agentProfiles.insert({ name: "Claude Reviewer", harness: "claude-code", model: "opus-5.5", effort: "medium" });

const configure = (v: unknown) => preferences.set(QUOTA_FALLBACK_PREF, JSON.stringify(v));
const limit = (...agents: string[]) => { for (const a of agents) noteQuotaLimit(a, 100_000, 0); };
const NOW = 1_000;
beforeEach(() => {
  configure([
    { enabled: true, from: ["claude-code"], harness: "via-deepseek" },
    { enabled: true, from: ["codex"], harness: "via-deepseek", model: "opus-5.5" },
    { enabled: true, profile: "GPT Reviewer", chain: ["DeepInfra GLM", "DeepInfra Kimi", "Claude Reviewer"] },
    { enabled: true, profile: "finisher", chain: ["Sonnet Builder"] },
    { enabled: true, profile: "Sonnet Builder", chain: ["DeepSeek Pro", "DeepInfra Kimi"] },
  ]);
  preferences.set(QUOTA_FALLBACK_UNTIL_PREF, "{}");
  preferences.set(HARNESS_FAMILIES_PREF, JSON.stringify({ "via-deepseek": "deepseek" }));
});
afterAll(() => rmTestDataDir(dir));

test("profile rules parse on their own and are invisible to the harness rules", () => {
  const raw = JSON.stringify([
    { enabled: true, profile: " A ", chain: [" B ", "", 3] },
    { enabled: false, profile: "C", chain: ["D"] },
    { enabled: true, profile: "E" },
    { enabled: true, chain: ["F"] },
    { enabled: true, profile: "G", chain: [] },
  ]);
  expect(parseProfileFallbackRules(raw)).toEqual([
    { enabled: true, profile: "A", chain: ["B"] },
    { enabled: true, profile: "G", chain: [] },
  ]);
  expect(parseQuotaFallbackRules(raw)).toEqual([]);
  expect(parseProfileFallbackRules("not json")).toEqual([]);
});

test("a step stays on its own harness while it is available, then takes the chain in order", () => {
  expect(fallbackForStep("codex", reviewer, { now: NOW })).toBeNull();
  limit("codex");
  expect(fallbackForStep("codex", reviewer, { now: NOW })).toMatchObject({ harness: "via-deepinfra", model: "zai-org/GLM-5.3", profile: { name: "DeepInfra GLM" } });
  // Both DeepInfra hops share one harness: its limit skips both.
  limit("via-deepinfra");
  expect(fallbackForStep("codex", reviewer, { now: NOW })).toMatchObject({ harness: "claude-code", model: "opus-5.5", profile: { name: "Claude Reviewer" } });
  limit("claude-code");
  expect(fallbackForStep("codex", reviewer, { now: NOW })).toBeNull();
  // Every limit is over: back on its own harness.
  expect(fallbackForStep("codex", reviewer, { now: 100_000 })).toBeNull();
});

test("a profile rule replaces the harness rules: Finish never reaches the harness rule's DeepSeek backup", () => {
  limit("codex");
  expect(fallbackForStep("codex", finisher, { now: NOW })).toMatchObject({ harness: "claude-code", model: "sonnet-5.5" });
  limit("claude-code");
  expect(fallbackForStep("codex", finisher, { now: NOW })).toBeNull();
  // A profile with no rule still uses the harness rule.
  expect(fallbackForStep("codex", { id: "x", name: "Codex Builder" }, { now: NOW })).toMatchObject({ harness: "via-deepseek", model: "opus-5.5" });
  // An empty chain keeps the step on its own harness.
  configure([{ enabled: true, from: ["codex"], harness: "via-deepseek", model: "opus-5.5" }, { enabled: true, profile: "Finisher", chain: [] }]);
  expect(fallbackForStep("codex", finisher, { now: NOW })).toBeNull();
});

test("a chain skips the excluded family, a missing profile and a disabled harness", () => {
  limit("codex");
  expect(fallbackForStep("codex", reviewer, { excludeFamily: "zai", now: NOW })).toMatchObject({ profile: { name: "DeepInfra Kimi" } });
  expect(fallbackForStep("codex", reviewer, { excludeFamily: "anthropic", now: NOW })).toMatchObject({ profile: { name: "DeepInfra GLM" } });
  configure([{ enabled: true, profile: "GPT Reviewer", chain: ["Nobody", "DeepInfra GLM", "Claude Reviewer"] }]);
  harnesses.setEnabled("via-deepinfra", false);
  try {
    expect(fallbackForStep("codex", reviewer, { now: NOW })).toMatchObject({ profile: { name: "Claude Reviewer" } });
  } finally {
    harnesses.setEnabled("via-deepinfra", true);
  }
});

test("after a hop hits its own limit the step moves on, or back to its own harness once that is free", () => {
  const snap = { ...builder, effort: "medium", mode: null };
  limit("claude-code");
  expect(fallbackForStep("claude-code", builder, { now: NOW })).toMatchObject({ harness: "via-deepseek", profile: { name: "DeepSeek Pro" } });
  // DeepSeek is cut off mid-step: the next hop.
  limit("via-deepseek");
  expect(fallbackAfterLimit("via-deepseek", snap, { now: NOW })).toMatchObject({ harness: "via-deepinfra", model: "moonshotai/Kimi-K3" });
  // Claude's own limit is over by the time DeepInfra is cut off too: back on Claude Code with the profile's own settings.
  preferences.set(QUOTA_FALLBACK_UNTIL_PREF, JSON.stringify({ "via-deepseek": 100_000 }));
  noteQuotaLimit("via-deepinfra", 100_000, 0);
  expect(fallbackAfterLimit("via-deepinfra", snap, { now: NOW })).toMatchObject({ harness: "claude-code", model: "sonnet-5.5", profile: { effort: "medium" } });
  // No profile rule: the harness rule's backup, as before.
  expect(fallbackAfterLimit("codex", null, { now: NOW })).toMatchObject({ harness: "via-deepseek", model: "opus-5.5" });
});

test("familyOf reads an org prefix, then a pinned harness, then the model name, then the kind", () => {
  expect(familyOf("via-deepinfra", "zai-org/GLM-5.3")).toBe("zai");
  expect(familyOf("via-deepinfra", "moonshotai/Kimi-K3")).toBe("moonshot");
  expect(familyOf("fx", "deepseek/deepseek-v4-pro")).toBe("deepseek");
  expect(familyOf("via-deepseek", "opus-5.5")).toBe("deepseek"); // DeepSeek serves Claude model names
  expect(familyOf("claude-code", "opus-5.5")).toBe("anthropic");
  expect(familyOf("codex", "gpt-6.1-sol")).toBe("openai");
  expect(familyOf("claude-code", "some-new-model")).toBe("anthropic");
  expect(familyOf("cursor", "auto")).toBeNull();
});
