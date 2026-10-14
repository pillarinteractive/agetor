// What a step launches with on its quota backup (pipeline-runner.ts
// `launchOnFallback`): a backup of the same kind changes only the harness;
// one of another kind runs the rule's model, keeps the step's effort where
// that kind accepts it, and runs in that kind's default mode.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "agetor-quota-fallback-launch-"));
process.env.AGETOR_DATA_DIR = dir;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
const { harnesses } = await import("./db.ts");
const { launchOnFallback } = await import("./pipeline-runner.ts");
harnesses.insert({ id: "launch-backup", kind: "claude-code", label: "Claude via backup" });
afterAll(() => rmTestDataDir(dir));

const rule = { enabled: true as const, from: ["codex"], harness: "launch-backup" };

test("a backup of the same kind keeps the step's model, effort and mode", () => {
  const step = { model: "opus-5.5", effort: "high", mode: "auto" };
  expect(launchOnFallback({ harness: "launch-backup", model: null, rule }, step)).toEqual({ agent: "launch-backup", ...step });
});

test("a Codex step on a Claude Code backup runs the rule's model and keeps the effort Claude Code accepts", () => {
  const fallback = { harness: "launch-backup", model: "opus-5.5", rule: { ...rule, model: "opus-5.5" } };
  expect(launchOnFallback(fallback, { model: "gpt-6.1-sol", effort: "high", mode: "auto" }))
    .toEqual({ agent: "launch-backup", model: "opus-5.5", effort: "high", mode: "auto" });
  // Codex's read-only "ask" would be Claude Code's prompt-on-every-change "ask": the backup's default applies.
  const readOnly = launchOnFallback(fallback, { model: "gpt-6.1-sol", effort: "medium", mode: "ask" });
  expect(readOnly.mode).toBe("auto");
  expect(readOnly.model).toBe("opus-5.5");
});
