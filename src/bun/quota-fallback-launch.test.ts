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

test("a hop of a profile's chain runs its own model and mode, and keeps the step's effort where accepted", () => {
  const hop = { harness: "launch-backup", model: "zai-org/GLM-5.3", rule: { enabled: true as const, profile: "GPT Reviewer", chain: ["GLM"] },
    profile: { id: "p", name: "GLM", effort: "medium", mode: "auto" } };
  expect(launchOnFallback(hop, { model: "gpt-6.1-sol", effort: "high", mode: "ask" }))
    .toEqual({ agent: "launch-backup", model: "zai-org/GLM-5.3", effort: "high", mode: "auto" });
  expect(launchOnFallback(hop, { model: "gpt-6.1-sol", effort: "nonsense", mode: "ask" }).effort).toBe("medium");
  expect(launchOnFallback({ ...hop, profile: { ...hop.profile, mode: null } }, { model: "gpt-6.1-sol", effort: "high", mode: "ask" }).mode).toBe("auto");
});

test("a Review excludes the family of the Build that made its head; other steps exclude nothing", () => {
  const { tasks } = require("./db.ts") as typeof import("./db.ts");
  const { familyToExclude } = require("./pipeline-runner.ts") as typeof import("./pipeline-runner.ts");
  const row = (id: string, agent: string, model: string) => tasks.insert({
    id, title: id, prompt: "", column: "done", agent, workdir: dir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null,
    model, effort: null, fast: false, maxMode: false, references: [], backlog: [], plans: [], draft: null, runId: null,
    createdAt: 0, updatedAt: 0, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  } as never);
  row("build-1", "claude-code", "sonnet-5.5");
  row("build-2", "launch-backup", "moonshotai/Kimi-K3");
  const steps = [{ id: "b", name: "Build" }, { id: "r", name: "Review" }];
  const rec = (stepId: string, taskId: string, seq: number) => ({ seq, stepId, taskId, startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: null, nextStepIds: [] });
  const run = { snapshot: { graph: { steps, edges: [] } }, history: [rec("b", "build-1", 1), rec("r", "x", 2)] } as never;
  expect(familyToExclude(run, "r")).toBe("anthropic");
  expect(familyToExclude(run, "b")).toBeNull();
  const later = { snapshot: { graph: { steps, edges: [] } }, history: [rec("b", "build-1", 1), rec("b", "build-2", 3)] } as never;
  expect(familyToExclude(later, "r")).toBe("moonshot");
});
