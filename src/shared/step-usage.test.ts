import { describe, expect, test } from "bun:test";
import {
  ZERO_USAGE, addUsage, buildReport, mainModel, median, numberVisits, parseClaudeTranscript, parseCodexRollout, renderReport,
  summarizeVisits, weightedTokens, type StepVisit, type TokenUsage,
} from "./step-usage.ts";

const jsonl = (...rows: unknown[]) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");

const assistant = (id: string, usage: Record<string, number>, more: Record<string, unknown> = {}) => ({
  type: "assistant", requestId: `req_${id}`, isSidechain: false,
  message: { id, model: "claude-opus-5-5", usage }, ...more,
});
const user = (content: unknown, more: Record<string, unknown> = {}) => ({ type: "user", isSidechain: false, message: { role: "user", content }, ...more });

describe("parseClaudeTranscript", () => {
  const cases: { name: string; text: string; subagent?: boolean; want: Partial<TokenUsage>; models?: Record<string, number>; bad?: number }[] = [
    { name: "empty", text: "", want: ZERO_USAGE },
    {
      name: "one response written once per content block is counted once, with its last output count",
      text: jsonl(
        user("the step prompt"),
        assistant("m1", { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
        assistant("m1", { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
        assistant("m2", { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 150, cache_creation_input_tokens: 7 }),
      ),
      want: { input: 5, output: 45, cacheRead: 250, cacheWrite: 57, calls: 2, turns: 1 },
      models: { "claude-opus-5-5": 2 },
    },
    {
      name: "tool results, meta notes and sidechain lines are not turns; a follow-up message is",
      text: jsonl(
        user("the step prompt"),
        user([{ type: "tool_result", content: "ok" }]),
        user("note", { isMeta: true }),
        user("scout brief", { isSidechain: true }),
        user([{ type: "text", text: "[check feedback] …" }]),
        user("   "),
      ),
      want: { turns: 2, calls: 0 },
    },
    {
      name: "a synthetic error line and a usage block without an id are skipped",
      text: jsonl(
        { type: "assistant", message: { id: "e1", model: "<synthetic>", usage: { input_tokens: 9, output_tokens: 9 } } },
        { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 9, output_tokens: 9 } } },
      ),
      want: { input: 0, output: 0, calls: 0 },
    },
    {
      name: "a subagent's file counts tokens and calls, never turns",
      text: jsonl(user("You are Scout", { isSidechain: true }), user("stray"), assistant("s1", { input_tokens: 1, output_tokens: 2 })),
      subagent: true,
      want: { input: 1, output: 2, calls: 1, turns: 0 },
    },
    {
      name: "a line that is not JSON is counted and skipped; negative and non-numeric counts read as 0",
      text: jsonl("{not json", "[1,2]", assistant("m1", { input_tokens: -4, output_tokens: Number.NaN })),
      want: { input: 0, output: 0, calls: 1 },
      bad: 1,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = parseClaudeTranscript(c.text, c.subagent ? { subagent: true } : undefined);
      expect(got.usage).toMatchObject(c.want);
      if (c.models) expect(got.models).toEqual(c.models);
      expect(got.badLines).toBe(c.bad ?? 0);
    });
  }
});

const tokenCount = (input: number, cached: number, output: number, cacheWrite = 0) => ({
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output } } },
});
const turnContext = (model: string) => ({ type: "turn_context", payload: { model } });
const taskStarted = { type: "event_msg", payload: { type: "task_started" } };

describe("parseCodexRollout", () => {
  const cases: { name: string; text: string; want: Partial<TokenUsage>; models?: Record<string, number> }[] = [
    { name: "empty", text: "", want: ZERO_USAGE },
    {
      name: "the last cumulative total is the session's; input is the uncached part",
      text: jsonl(taskStarted, turnContext("gpt-6.1-sol"), tokenCount(100, 40, 5), tokenCount(300, 240, 12, 3)),
      want: { input: 60, cacheRead: 240, cacheWrite: 3, output: 12, calls: 2, turns: 1 },
      models: { "gpt-6.1-sol": 2 },
    },
    {
      name: "an unchanged total (new rate limits only) is not another call",
      text: jsonl(taskStarted, tokenCount(100, 40, 5), tokenCount(100, 40, 5), tokenCount(100, 40, 5)),
      want: { input: 60, cacheRead: 40, output: 5, calls: 1 },
      models: { unknown: 1 },
    },
    {
      name: "a total that starts again is a new segment, and the segments are added",
      text: jsonl(taskStarted, tokenCount(100, 40, 5), tokenCount(300, 240, 12), taskStarted, tokenCount(50, 10, 2), tokenCount(90, 30, 4)),
      want: { input: 60 + 60, cacheRead: 240 + 30, output: 12 + 4, calls: 4, turns: 2 },
    },
    {
      name: "a token_count with no info, and other events, are ignored",
      text: jsonl({ type: "event_msg", payload: { type: "token_count", info: null } }, { type: "response_item", payload: { type: "message" } }, "garbage"),
      want: { calls: 0, input: 0 },
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = parseCodexRollout(c.text);
      expect(got.usage).toMatchObject(c.want);
      if (c.models) expect(got.models).toEqual(c.models);
    });
  }
});

test("median, weightedTokens, addUsage, mainModel", () => {
  const medians: [number[], number | null][] = [[[], null], [[5], 5], [[9, 1, 5], 5], [[1, 2, 3, 10], 3], [[1, 2], 2]];
  for (const [values, want] of medians) expect(median(values)).toBe(want);
  expect(weightedTokens({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 40, calls: 0, turns: 0 })).toBe(100 + 50 + 100 + 50);
  expect(addUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, calls: 5, turns: 6 }, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, calls: 1, turns: 1 }))
    .toEqual({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, calls: 6, turns: 7 });
  expect(mainModel({})).toBeNull();
  expect(mainModel({ haiku: 2, opus: 7 })).toBe("opus");
  expect(mainModel({ b: 2, a: 2 })).toBe("a");
});

test("numberVisits counts each step's visits in launch order", () => {
  const got = numberVisits([
    { id: "c", stepId: "build", startedAt: 30 },
    { id: "a", stepId: "understand", startedAt: 10 },
    { id: "b", stepId: "build", startedAt: 20 },
    { id: "d", stepId: "review", startedAt: 40 },
  ]);
  expect(got.map((v) => `${v.id}:${v.visit}`)).toEqual(["a:1", "b:1", "c:2", "d:1"]);
});

const visit = (stepName: string, n: number, usage: Partial<TokenUsage> | null, more: Partial<StepVisit> = {}): StepVisit => ({
  cardId: "card", cardTitle: "Issue #1: a card", stepTaskId: `${stepName}-${n}`, stepId: stepName.toLowerCase(), stepName, visit: n, inCurrentRun: true,
  harness: "claude-code", model: "claude-opus-5-5", startedAt: n, sessions: usage ? 1 : 0, usage: usage ? { ...ZERO_USAGE, ...usage } : null,
  subagents: null, unattributed: usage ? null : "no-session", missingSessions: 0, ...more,
});

describe("summarizeVisits", () => {
  test("medians and totals per step, split into first and repeat visits; a visit with no numbers is counted apart", () => {
    const summary = summarizeVisits([
      visit("Understand", 1, { input: 10, output: 100 }),
      visit("Build", 1, { input: 1, output: 1000, calls: 60 }),
      visit("Build", 2, { input: 3, output: 200, calls: 20 }),
      visit("Build", 3, { input: 5, output: 400, calls: 30 }),
      visit("Build", 4, null),
    ]);
    expect(summary.map((s) => `${s.stepName}/${s.visits}`)).toEqual(["Understand/all", "Build/all", "Build/first", "Build/repeat"]);
    const all = summary[1]!;
    expect(all).toMatchObject({ count: 4, unattributed: 1 });
    expect(all.median.output).toBe(400);
    expect(all.total.output).toBe(1600);
    expect(all.total.calls).toBe(110);
    const repeat = summary[3]!;
    expect(repeat).toMatchObject({ count: 3, unattributed: 1 });
    expect(repeat.median.output).toBe(300);
    expect(repeat.median.weighted).toBe(Math.round((3 + 200 * 5 + 5 + 400 * 5) / 2));
  });

  test("a step whose visits were all unattributed has no median", () => {
    const [only] = summarizeVisits([visit("Finish", 1, null)]);
    expect(only!.median.input).toBeNull();
    expect(only!.total.input).toBe(0);
  });
});

test("renderReport lists every visit, the per-step medians and what was not attributed", () => {
  const report = buildReport({
    project: "pillar", pipeline: "Change",
    cards: [{ id: "card", title: "Issue #1: a card", finishedAt: 1, steps: 4 }],
    visits: [
      visit("Understand", 1, { input: 1200, output: 34, cacheRead: 5, cacheWrite: 6, calls: 7, turns: 1 }),
      visit("Build", 1, { input: 10, output: 20 }, { inCurrentRun: false, missingSessions: 1, sessions: 2 }),
      visit("Finish", 1, null),
      visit("Review", 1, null, { unattributed: "harness-not-read", harness: "gemini" }),
    ],
  });
  expect(report.total).toMatchObject({ input: 1210, output: 54, calls: 7 });
  const text = renderReport(report);
  expect(text).toContain("last 1 finished card");
  expect(text).toContain("1,200");
  expect(text).toMatch(/Build\s+1\*/);
  expect(text).toContain("Not attributed (3 of 4 visits):");
  expect(text).toContain("1 of 2 session files not found — the numbers above are a lower bound");
  expect(text).toContain("no agent session (never started, or run by Agetor)");
  expect(text).toContain("harness not read by this tool");
});
