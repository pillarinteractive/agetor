import { expect, test } from "bun:test";
import type { Harness, Task } from "../shared/types.ts";
import { buildCommand } from "./agents.ts";
import {
  AUTOCOMPACT_MAX,
  AUTOCOMPACT_MIN,
  DEFAULT_DISALLOWED_TOOLS,
  claudeStepLaunchArgs,
  parseClaudeStepLaunch,
  stepNameOfTask,
} from "./claude-step-launch.ts";

const DENY = DEFAULT_DISALLOWED_TOOLS.join(",");

test("planner policy removes interactive routine questions without adding permission bypass flags", () => {
  const args = claudeStepLaunchArgs(parseClaudeStepLaunch(null), "Build", false, true);
  expect(args).toEqual(["--disallowedTools", `${DENY},AskUserQuestion`]);
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("--permission-mode");
});
test("planner question policy remains enabled when optional context reductions are disabled", () => {
  expect(claudeStepLaunchArgs(parseClaudeStepLaunch('{"enabled":false}'), "Build", false, true)).toEqual(["--disallowedTools", "AskUserQuestion"]);
});

test("with no preference a step leaves out the unused tools and nothing else", () => {
  const config = parseClaudeStepLaunch(null);
  expect(claudeStepLaunchArgs(config, "Build")).toEqual(["--disallowedTools", DENY]);
  expect(DEFAULT_DISALLOWED_TOOLS).not.toContain("AskUserQuestion");
  expect(DEFAULT_DISALLOWED_TOOLS).not.toContain("Agent");
});

test("unreadable or wrongly-shaped preferences fall back to the default", () => {
  for (const raw of ["{not json", "[]", "7", '"x"']) {
    expect(claudeStepLaunchArgs(parseClaudeStepLaunch(raw), "Build")).toEqual(["--disallowedTools", DENY]);
  }
});

test("enabled:false passes nothing", () => {
  expect(claudeStepLaunchArgs(parseClaudeStepLaunch('{"enabled":false,"autocompact":200000}'), "Build")).toEqual([]);
});

test("every option becomes its flag, the tool list as one value", () => {
  const config = parseClaudeStepLaunch('{"disallowedTools":["Artifact","Workflow"],"skills":false,"strictMcp":true,"autocompact":250000}');
  expect(claudeStepLaunchArgs(config, "Build")).toEqual([
    "--disallowedTools",
    "Artifact,Workflow",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--autocompact",
    "250000",
  ]);
});

test("an empty tool list drops the flag", () => {
  expect(claudeStepLaunchArgs(parseClaudeStepLaunch('{"disallowedTools":[]}'), "Build")).toEqual([]);
});

test("tool names that are not bare names are dropped (no patterns, no flags)", () => {
  const config = parseClaudeStepLaunch('{"disallowedTools":["Artifact","Bash(git *)","--model","a,b",7,"Artifact"]}');
  expect(config.disallowedTools).toEqual(["Artifact"]);
});

test("autocompact is clamped to what claude accepts; a non-number is ignored", () => {
  expect(parseClaudeStepLaunch('{"autocompact":5}').autocompact).toBe(AUTOCOMPACT_MIN);
  expect(parseClaudeStepLaunch('{"autocompact":9000000}').autocompact).toBe(AUTOCOMPACT_MAX);
  expect(parseClaudeStepLaunch('{"autocompact":"250000"}').autocompact).toBeNull();
});

test("a step override applies to that step only, by name, whatever the case", () => {
  const config = parseClaudeStepLaunch('{"steps":{"Build":{"autocompact":300000,"disallowedTools":[]},"review":{"skills":false}}}');
  expect(claudeStepLaunchArgs(config, "build")).toEqual(["--autocompact", "300000"]);
  expect(claudeStepLaunchArgs(config, "Review")).toEqual(["--disallowedTools", DENY, "--disable-slash-commands"]);
  expect(claudeStepLaunchArgs(config, "Understand")).toEqual(["--disallowedTools", DENY]);
});

test("a profile that names skills keeps slash commands", () => {
  const config = parseClaudeStepLaunch('{"skills":false,"disallowedTools":[]}');
  expect(claudeStepLaunchArgs(config, "Build", true)).toEqual([]);
  expect(claudeStepLaunchArgs(config, "Build", false)).toEqual(["--disable-slash-commands"]);
});

test("the step name comes from the run's graph, else from the step task's title", () => {
  const step = { pipelineStepId: "s2", title: "Change · Stale" } as Task;
  const parent = { pipelineRun: { snapshot: { graph: { steps: [{ id: "s2", name: "Build" }] } } } } as unknown as Task;
  expect(stepNameOfTask(step, parent)).toBe("Build");
  expect(stepNameOfTask({ pipelineStepId: "followup-1", title: "Change · Fix CI" } as Task, parent)).toBe("Fix CI");
  expect(stepNameOfTask({ pipelineStepId: "x", title: "Fix CI" } as Task, null)).toBe("Fix CI");
});

const claude = (): Harness => ({ id: "claude-code", kind: "claude-code", label: "claude", isBuiltin: true, home: null, bin: null, env: {}, enabled: true });
const base = { model: "opus-5.5", effort: "high", mode: "auto" };

test("the flags sit before the prompt terminator on a fresh launch", () => {
  const { cmd } = buildCommand(claude(), "do it", { ...base, sessionId: "sid", claudeExtraArgs: ["--disallowedTools", "Artifact,Workflow"] });
  expect(cmd.slice(-4)).toEqual(["--disallowedTools", "Artifact,Workflow", "--", "do it"]);
  expect(cmd).toContain("--session-id");
});

test("a resumed session keeps its session id and gets the same flags", () => {
  const { cmd } = buildCommand(claude(), "", { ...base, resumeSessionId: "prior", claudeExtraArgs: ["--autocompact", "300000"] });
  expect(cmd.slice(cmd.indexOf("--resume"), cmd.indexOf("--resume") + 2)).toEqual(["--resume", "prior"]);
  expect(cmd).not.toContain("--session-id");
  expect(cmd.slice(-2)).toEqual(["--autocompact", "300000"]);
});

test("without step flags the command is unchanged", () => {
  const a = buildCommand(claude(), "p", { ...base, sessionId: "sid" }).cmd;
  const b = buildCommand(claude(), "p", { ...base, sessionId: "sid", claudeExtraArgs: [] }).cmd;
  expect(b).toEqual(a);
  expect(a).not.toContain("--disallowedTools");
});
