/**
 * Launch flags for Claude Code sessions that run a pipeline step.
 *
 * Every model call re-sends the session's whole context, so what a session
 * starts with is paid for on each of its calls (a Build visit makes 40–60).
 * Measured on this board (2026-10-10, Claude Code 2.1.296): a step session
 * starts at ~50–57k tokens, about 30k of that tool definitions — and roughly
 * 80% of those belong to tools a pipeline step never calls (`Artifact` alone
 * is ~47%). A tool that is deny-listed by name is left out of the context.
 *
 * Configured with the `pipeline_claude_launch` preference (JSON):
 *
 *   {"disallowedTools":["Artifact", …],   // default: DEFAULT_DISALLOWED_TOOLS
 *    "skills":true,                        // false → --disable-slash-commands
 *    "strictMcp":false,                    // true  → --strict-mcp-config
 *    "autocompact":null,                   // tokens (100k–1M) → --autocompact
 *    "steps":{"Build":{"autocompact":300000}}}   // per step name, same keys
 *
 * `{"enabled":false}` passes nothing. Only pipeline step tasks are affected;
 * a plain task launches as before. The same flags are used when a step's
 * session is reopened with `--resume`, so its tool set never changes mid-way.
 */
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";

export const CLAUDE_STEP_LAUNCH_PREF = "pipeline_claude_launch";

/** Built-in tools with large definitions that a pipeline step has no use
 *  for: publishing pages, feedback, workflow scripts, self-scheduled wake-ups
 *  (Agetor wakes steps itself — see awaits.ts) and review-finding reports.
 *  `AskUserQuestion` stays: Agetor surfaces a step's questions to the user. */
export const DEFAULT_DISALLOWED_TOOLS: readonly string[] = ["Artifact", "SendFeedback", "Workflow", "ScheduleWakeup", "ReportFindings"];

export const AUTOCOMPACT_MIN = 100_000;
export const AUTOCOMPACT_MAX = 1_000_000;

export interface ClaudeStepLaunchOptions {
  disallowedTools: string[];
  /** Keep skills (slash commands) listed in the session. */
  skills: boolean;
  /** Ignore every MCP server not given on the command line. */
  strictMcp: boolean;
  /** Auto-compact window in tokens; null leaves Claude Code's own. */
  autocompact: number | null;
}

export interface ClaudeStepLaunchConfig extends ClaudeStepLaunchOptions {
  enabled: boolean;
  /** Overrides keyed by lower-cased step name. */
  steps: Record<string, Partial<ClaudeStepLaunchOptions>>;
}

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function readOptions(o: Record<string, unknown>): Partial<ClaudeStepLaunchOptions> {
  const out: Partial<ClaudeStepLaunchOptions> = {};
  if (Array.isArray(o.disallowedTools)) {
    // Bare tool names only: a pattern such as `Bash(git *)` is a permission
    // rule, not a tool to leave out, and a stray value must never be able to
    // read as another flag.
    out.disallowedTools = [...new Set(o.disallowedTools.filter((t): t is string => typeof t === "string" && TOOL_NAME_RE.test(t)))];
  }
  if (typeof o.skills === "boolean") out.skills = o.skills;
  if (typeof o.strictMcp === "boolean") out.strictMcp = o.strictMcp;
  if (o.autocompact === null) out.autocompact = null;
  else if (typeof o.autocompact === "number" && Number.isFinite(o.autocompact)) {
    out.autocompact = Math.min(AUTOCOMPACT_MAX, Math.max(AUTOCOMPACT_MIN, Math.round(o.autocompact)));
  }
  return out;
}

export function parseClaudeStepLaunch(raw: string | null | undefined): ClaudeStepLaunchConfig {
  const config: ClaudeStepLaunchConfig = {
    enabled: true,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    skills: true,
    strictMcp: false,
    autocompact: null,
    steps: {},
  };
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return config;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return config;
  const o = v as Record<string, unknown>;
  if (o.enabled === false) config.enabled = false;
  Object.assign(config, readOptions(o));
  if (o.steps && typeof o.steps === "object" && !Array.isArray(o.steps)) {
    for (const [name, value] of Object.entries(o.steps as Record<string, unknown>)) {
      if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
      config.steps[name.trim().toLowerCase()] = readOptions(value as Record<string, unknown>);
    }
  }
  return config;
}

/**
 * The extra `claude` argv for a step named `stepName`. `profileUsesSkills`:
 * the step's agent profile names skills, which need slash commands — they
 * are then kept whatever the preference says. Pure.
 */
export function claudeStepLaunchArgs(config: ClaudeStepLaunchConfig, stepName: string, profileUsesSkills = false, plannerDecisions = false): string[] {
  if (!config.enabled) return plannerDecisions ? ["--disallowedTools", "AskUserQuestion"] : [];
  const o: ClaudeStepLaunchOptions = { ...config, ...(config.steps[stepName.trim().toLowerCase()] ?? {}) };
  const args: string[] = [];
  // One comma-separated value: `--disallowedTools` takes several, and a
  // separate value per tool would let it swallow what follows.
  const disallowed = plannerDecisions ? [...new Set([...o.disallowedTools, "AskUserQuestion"])] : o.disallowedTools;
  if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","));
  if (!o.skills && !profileUsesSkills) args.push("--disable-slash-commands");
  if (o.strictMcp) args.push("--strict-mcp-config");
  if (o.autocompact != null) args.push("--autocompact", String(o.autocompact));
  return args;
}

/** The step's name as its pipeline shows it: from the run's snapshot, else
 *  from the step task's title (`<pipeline> · <step>` — follow-ups are not in
 *  the graph). */
export function stepNameOfTask(task: Task, parent: Task | null | undefined): string {
  const fromGraph = parent?.pipelineRun?.snapshot?.graph.steps.find((s) => s.id === task.pipelineStepId)?.name;
  if (fromGraph) return fromGraph;
  const i = task.title.lastIndexOf(" · ");
  return i >= 0 ? task.title.slice(i + 3) : task.title;
}

/** Extra `claude` argv for `taskId`'s session: empty unless it is a pipeline
 *  step. Never throws — a launch must not fail on a preference. */
export function claudeStepArgsForTask(taskId: string): string[] {
  try {
    const task = tasks.get(taskId);
    if (!task?.pipelineParentId) return [];
    const config = parseClaudeStepLaunch(preferences.get(CLAUDE_STEP_LAUNCH_PREF));
    const usesSkills = (task.agentProfile?.skills?.length ?? 0) > 0;
    const parent = tasks.get(task.pipelineParentId);
    return claudeStepLaunchArgs(config, stepNameOfTask(task, parent), usesSkills,
      !!parent?.pipelineRun?.snapshot?.decisionPolicy);
  } catch {
    return [];
  }
}
