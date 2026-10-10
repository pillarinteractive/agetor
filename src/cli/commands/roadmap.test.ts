import { expect, test } from "bun:test";
import path from "node:path";
import { matchMilestoneRef, parseRoadmapContinueArgs, parseRoadmapResolveArgs, parseRoadmapStartFlags, roadmapStatusLines, roadmapWhyLines, runRoadmap } from "./roadmap.ts";
import type { GitHubRepoMilestone, Pipeline, Project } from "../../shared/types.ts";

const status = {
  issue: 600,
  url: "https://github.com/o/r/issues/600",
  fetchedAt: 0,
  scope: null as { number: number; title: string; roadmapTotal: number } | null,
  counts: { total: 6, complete: 2, declined: 1, inFlight: 1, ready: 1, waiting: 1, backlog: 0 },
  blockedOutside: [] as { step: string; issue: number; title: string; url: string | null; milestone: string }[],
  cards: [],
  humanReady: [{ step: "1", issue: 11, title: "[Human] Provide the sample device", url: "https://github.com/o/r/issues/11" }],
  needsUser: [{ step: "2", issue: 12, title: "Inventory the widgets", url: null, reason: "PR #77 merged but the issue is still open" }],
  nextWaiting: [{ step: "5", issue: 15, title: "Ship the widget page", url: null, waitingOn: ["3", "4"], reason: null }],
  problems: [{ kind: "unknown-predecessor" as const, message: "step 9: predecessor 44 names no step", step: "9" }],
  idleReason: null,
};
const dto = (over: Record<string, unknown> = {}) => ({
  config: { enabled: true, project: "/repo", maxInFlight: 3, pipelineId: null, roadmap: { issue: 600 } as { issue: number } | null, milestone: null as { number: number; title: string } | null, ...over },
  state: { phase: "running", lastError: null as string | null, roadmap: status },
  defaultTracker: null as number | null,
});
const MILESTONES = [
  { number: 1, title: "M01 — Widget foundations", state: "open" },
  { number: 2, title: "M02 — Widget page", state: "open" },
  { number: 10, title: "M010 — Widget extras", state: "open" },
  { number: 5, title: "M05 — Shipped", state: "closed" },
] as GitHubRepoMilestone[];

function fakeClient(answer = dto()) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    client: {
      call: async <T>(method: string, p: string, body?: unknown) => {
        calls.push({ method, path: p, body });
        if (p.startsWith("/github/milestones")) return { milestones: MILESTONES } as T;
        // The server answers a PUT with the config it saved.
        if (method === "PUT") return { ...answer, config: { ...answer.config, ...(body as object) } } as T;
        return answer as T;
      },
      listPipelines: async () => [{ id: "pl-1", name: "Change" }] as Pipeline[],
      listProjects: async () => [{ path: path.resolve("/repo"), name: "widgets" }] as Project[],
    },
  };
}

test("start flags: project, issue (with or without #), max, pipeline; bad values are refused", () => {
  expect(parseRoadmapStartFlags(["--project", "/repo", "--issue", "#600", "--max", "3", "--pipeline", "Change"])).toEqual({ project: "/repo", issue: 600, max: 3, pipeline: "Change" });
  expect(() => parseRoadmapStartFlags(["--issue", "abc"])).toThrow("positive whole number");
  expect(() => parseRoadmapStartFlags(["--max", "0"])).toThrow("positive whole number");
  expect(() => parseRoadmapStartFlags(["--issue"])).toThrow("needs a value");
  expect(() => parseRoadmapStartFlags(["--nope"])).toThrow("unknown option");
});

test("status reads GET /autopilot and prints counts, human steps, needs-you, waiting steps and problems", async () => {
  const { client, calls } = fakeClient();
  const r = await runRoadmap(client, ["status"]);
  expect(calls).toEqual([{ method: "GET", path: "/autopilot", body: undefined }]);
  const text = r.lines.join("\n");
  expect(text).toContain("Roadmap #600");
  expect(text).toContain("2/6 complete · 1 in flight · 1 ready · 1 waiting · 1 declined · 0 in the backlog");
  expect(text).toContain("Scope: all milestones");
  expect(text).toContain("Needs you:");
  expect(text).toContain("1  #11 [Human] Provide the sample device");
  expect(text).toContain("PR #77 merged but the issue is still open");
  expect(text).toContain("waits on 3, 4");
  expect(text).toContain("step 9: predecessor 44 names no step");
  expect(r.data).toMatchObject({ enabled: true, roadmap: { issue: 600 }, status: { counts: { total: 6 } } });
});

test("status without roadmap mode, or before the first pass, says so", () => {
  expect(roadmapStatusLines(dto({ roadmap: null })).join("\n")).toContain("no tracker is set — agetor roadmap start --project <dir> --issue <n>");
  expect(roadmapStatusLines({ ...dto({ roadmap: null }), defaultTracker: 600 }).join("\n")).toContain("uses the default tracker #600");
  const other = { ...dto(), state: { phase: "running", lastError: "couldn't read tracker issue #601", roadmap: status } };
  other.config.roadmap = { issue: 601 };
  const text = roadmapStatusLines(other).join("\n");
  expect(text).toContain("couldn't read tracker issue #601");
  expect(text).not.toContain("2/6 complete"); // another roadmap's status isn't shown
  other.state.lastError = null as never;
  expect(roadmapStatusLines(other).join("\n")).toContain("no status yet");
});

test("start resolves the project and pipeline, then PUTs roadmap mode on", async () => {
  const { client, calls } = fakeClient();
  await runRoadmap(client, ["start", "--project", "widgets", "--issue", "600", "--max", "4", "--pipeline", "change"]);
  expect(calls).toEqual([
    { method: "PUT", path: "/autopilot", body: { enabled: true, project: path.resolve("/repo"), roadmap: { issue: 600 }, milestone: null, maxInFlight: 4, pipelineId: "pl-1" } },
  ]);
  await expect(runRoadmap(client, ["start", "--project", "/elsewhere", "--issue", "600"])).rejects.toThrow("isn't a project");
  await expect(runRoadmap(client, ["start", "--project", "/repo", "--issue", "600", "--pipeline", "nope"])).rejects.toThrow("unknown pipeline");
  await expect(runRoadmap(client, ["start", "--issue", "600"])).rejects.toThrow("'start' needs --project");
  // No --issue and no default tracker yet.
  await expect(runRoadmap(client, ["start", "--project", "/repo"])).rejects.toThrow("no default tracker is set yet");
});

test("pause only turns Autopilot off", async () => {
  const { client, calls } = fakeClient();
  await runRoadmap(client, ["pause"]);
  expect(calls).toEqual([{ method: "PUT", path: "/autopilot", body: { enabled: false } }]);
  await expect(runRoadmap(client, ["bogus"])).rejects.toThrow("usage: agetor roadmap");
});

test("start without --issue uses the default tracker", async () => {
  const { client, calls } = fakeClient({ ...dto({ roadmap: null }), defaultTracker: 600 });
  const r = await runRoadmap(client, ["start", "--project", "/repo"]);
  expect(calls).toEqual([
    { method: "GET", path: "/autopilot", body: undefined },
    { method: "PUT", path: "/autopilot", body: { enabled: true, project: path.resolve("/repo"), roadmap: { issue: 600 }, milestone: null } },
  ]);
  expect(r.lines[0]).toContain("the whole roadmap #600");
});

test("start --milestone scopes the run to a GitHub milestone, by number or by the start of its title", async () => {
  const { client, calls } = fakeClient();
  const r = await runRoadmap(client, ["start", "--project", "/repo", "--issue", "600", "--milestone", "m01"]);
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /github/milestones?path=${encodeURIComponent(path.resolve("/repo"))}`, "PUT /autopilot"]);
  expect(calls[1]!.body).toMatchObject({ roadmap: { issue: 600 }, milestone: { number: 1, title: "M01 — Widget foundations" } });
  expect(r.lines.join("\n")).toContain('milestone "M01 — Widget foundations" in the order of roadmap #600');
  expect(r.lines.join("\n")).toContain("every open step of the milestone gets a card in the Backlog");

  // `all` is the whole roadmap, and asks GitHub nothing.
  const all = fakeClient();
  await runRoadmap(all.client, ["start", "--project", "/repo", "--issue", "600", "--milestone", "all"]);
  expect(all.calls.map((c) => c.method)).toEqual(["PUT"]);
  expect(all.calls[0]!.body).toMatchObject({ milestone: null });

  await expect(runRoadmap(client, ["start", "--project", "/repo", "--issue", "600", "--milestone", "M05"])).rejects.toThrow('no open milestone matches "M05"');
});

test("matchMilestoneRef: a number, a title prefix that stops at a separator, never a guess between two", () => {
  const open = MILESTONES.filter((m) => m.state === "open");
  const ok = (ref: string) => {
    const r = matchMilestoneRef(open, ref);
    return r.ok ? r.milestone.number : r.error;
  };
  expect(ok("2")).toBe(2);
  expect(ok("#10")).toBe(10);
  expect(ok("M01")).toBe(1); // not M010
  expect(ok("M010")).toBe(10);
  expect(ok("M02 — Widget page")).toBe(2);
  expect(ok("m02 — wid")).toBe(2);
  expect(ok("M0")).toContain('"M0" matches 3 milestones');
  expect(ok("X07")).toContain('no open milestone matches "X07"');
  expect(matchMilestoneRef([], "M01")).toEqual({ ok: false, error: 'no open milestone matches "M01"' });
});

test("status with a milestone: the scope, its counts, what needs you and what waits on other milestones", () => {
  const scoped = {
    ...status,
    scope: { number: 2, title: "M02 — Widget page", roadmapTotal: 40 },
    counts: { total: 6, complete: 2, declined: 0, inFlight: 1, ready: 1, waiting: 2, backlog: 3 },
    blockedOutside: [{ step: "3", issue: 13, title: "Build the widget store", url: null, milestone: "M01" }],
    idleReason: null,
  };
  const a = { ...dto({ milestone: { number: 2, title: "M02 — Widget page" } }), state: { phase: "running", lastError: null, roadmap: scoped } };
  const text = roadmapStatusLines(a).join("\n");
  expect(text).toContain('Scope: milestone "M02 — Widget page"');
  expect(text).toContain("6 of the roadmap's 40 steps");
  expect(text).toContain("2/6 complete · 1 in flight · 1 ready · 2 waiting · 0 declined · 3 in the backlog");
  expect(text).toContain("Needs you:");
  expect(text).toContain("1  #11 [Human] Provide the sample device");
  expect(text).toContain("yours to do — this step is ready and only you can do it");
  expect(text).toContain("Waits on other milestones (not started by this run):");
  expect(text).toContain("3  #13 Build the widget store");

  // The whole roadmap's status isn't shown as this milestone's.
  const stale = { ...dto({ milestone: { number: 2, title: "M02 — Widget page" } }) };
  const staleText = roadmapStatusLines(stale).join("\n");
  expect(staleText).toContain("no status yet");
  expect(staleText).not.toContain("2/6 complete");
});

test("status: a merged-but-open step shows what its PR said and how to resolve it; a held card shows its PR and files", () => {
  const a = dto();
  a.state.roadmap = {
    ...status,
    counts: { ...status.counts, inFlight: 2, held: 1 },
    idleReason: "Nothing can start: step 3 (#13) waits in In Review for your sign-off; step 2 (#12) needs you",
    needsUser: [
      { step: "2", issue: 12, title: "Inventory the widgets", url: null, kind: "stuck", reason: "PR #77 merged but the issue is still open — close it or reopen the work", pr: 77, prUrl: "https://github.com/o/r/pull/77", detail: "PR #77 left it open on purpose: “Refs #12 — the nightly job is not wired”", taskId: "c12" },
      { step: "3", issue: 13, title: "Build the widget store", url: null, kind: "held", reason: "PR #82 changes sensitive code — held in In Review for your sign-off", pr: 82, prUrl: "https://github.com/o/r/pull/82", detail: "apps/web/src/lib/billing/prices.ts", taskId: "c13" },
    ],
  } as never;
  const text = roadmapStatusLines(a).join("\n");
  expect(text).toContain("2 in flight (1 held for your sign-off)");
  expect(text).toContain("waits in In Review for your sign-off");
  expect(text).toContain("PR #77 left it open on purpose: “Refs #12 — the nightly job is not wired”");
  expect(text).toContain("https://github.com/o/r/pull/77");
  expect(text).toContain("agetor roadmap resolve 12 --close");
  expect(text).toContain("agetor roadmap resolve 12 --redo");
  expect(text).toContain("PR #82 changes sensitive code — held in In Review for your sign-off");
  expect(text).toContain("sensitive files: apps/web/src/lib/billing/prices.ts");
  expect(text).toContain("https://github.com/o/r/pull/82");
  expect(text).not.toContain("agetor roadmap resolve 13");
});

test("status prints text from a PR without its control characters or escapes", () => {
  const a = dto();
  a.state.roadmap = { ...status, needsUser: [{ step: "2", issue: 12, title: "Inventory the widgets", url: null, kind: "stuck", reason: "PR #77 merged", detail: "says \u001b[2J\u001b[31mcleared\u0007\nsecond line" }] } as never;
  const lines = roadmapStatusLines(a);
  const line = lines.find((l) => l.includes("cleared"))!;
  expect(line).toContain("says cleared second line");
  expect(line).not.toContain("\u001b[2J");
  expect(line).not.toContain("\u0007");
  expect(lines.some((l) => l.includes("\n"))).toBe(false);
});

test("resolve: one issue and one of --close / --redo, sent as the owner's request", async () => {
  expect(parseRoadmapResolveArgs(["12", "--close"])).toEqual({ issue: 12, action: "close" });
  expect(parseRoadmapResolveArgs(["--redo", "#12"])).toEqual({ issue: 12, action: "redo" });
  expect(() => parseRoadmapResolveArgs(["12"])).toThrow("needs --close");
  expect(() => parseRoadmapResolveArgs(["--close"])).toThrow("needs the step's issue number");
  expect(() => parseRoadmapResolveArgs(["12", "--close", "--redo"])).toThrow("one of --close or --redo");
  expect(() => parseRoadmapResolveArgs(["12", "13", "--close"])).toThrow("unknown argument");
  expect(() => parseRoadmapResolveArgs(["12", "--yes"])).toThrow("unknown argument");

  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    ...fakeClient().client,
    call: async <T>(method: string, p: string, body?: unknown) => {
      calls.push({ method, path: p, body });
      return { ...dto(), ok: true, message: "Closed #12 as completed — the steps that waited on step 2 can start" } as T;
    },
  };
  const r = await runRoadmap(client, ["resolve", "12", "--close"]);
  expect(calls).toEqual([{ method: "POST", path: "/autopilot/roadmap/resolve", body: { issue: 12, action: "close" } }]);
  expect(r.lines.join("\n")).toContain("Closed #12 as completed");
  expect(r.data).toEqual({ ok: true, issue: 12, action: "close", message: "Closed #12 as completed — the steps that waited on step 2 can start" });
  // Nothing is sent when the request is incomplete; the server's refusal is passed on.
  calls.length = 0;
  await expect(runRoadmap(client, ["resolve", "12"])).rejects.toThrow("needs --close");
  expect(calls).toEqual([]);
  const refusing = { ...client, call: async () => Promise.reject(new Error("#12 is already closed — nothing to resolve")) };
  await expect(runRoadmap(refusing as never, ["resolve", "12", "--redo"])).rejects.toThrow("already closed");
});


// ── why, and continuing into the next milestone ─────────────────────────────

const M01 = { number: 1, title: "M01 — Widget foundations" };
const M02 = { number: 2, title: "M02 — Widget page" };
const link = (step: string, issue: number, title: string, state: string, taskId: string | null = null, milestone = "M01") => ({ step, issue, title, milestone, state, taskId });
const scopedStatus = (over: Record<string, unknown> = {}) => ({
  ...status,
  scope: { ...M01, roadmapTotal: 6, milestones: [{ ...M01, total: 3 }] },
  humanReady: [],
  needsUser: [],
  problems: [],
  links: [
    { step: "2", issue: 12, title: "Inventory the widgets", state: "in-flight", taskId: "c12", predecessors: [], successors: [link("3", 13, "Build the widget store", "backlog", "bl-13"), link("4", 14, "Wire the widget API", "outside", null, "M02")] },
    {
      step: "3",
      issue: 13,
      title: "Build the widget store",
      state: "backlog",
      taskId: "bl-13",
      predecessors: [link("2", 12, "Inventory the widgets", "in-flight", "c12"), link("1", 11, "[Human] Provide the sample device", "yours", null, "H"), { ...link("7", 17, "Agree the widget names", "complete"), note: "annual only" }],
      successors: [link("5", 15, "Ship the widget page", "outside", null, "M02")],
      morePredecessors: 2,
    },
  ],
  ...over,
});
const offer = (over: Record<string, unknown> = {}) => ({ stage: "M02", number: 2, title: M02.title, steps: 3, agentSteps: 3, startable: 0, waitingOn: "steps 2 (#12), 3 (#13)", current: "M01", left: 1, underway: true, maxInFlight: 3, reason: "nearly-done", dismissedAt: null, ...over });
const scopedDto = (statusOver: Record<string, unknown> = {}, configOver: Record<string, unknown> = {}) => {
  const a = dto({ milestone: M01, milestones: [M01], ...configOver });
  a.state.roadmap = scopedStatus(statusOver) as never;
  return a;
};

test("why: what a step waits on (with where each predecessor stands) and what it blocks", () => {
  const text = roadmapWhyLines(scopedDto(), "#13").join("\n");
  expect(text).toContain("Step 3 · #13 Build the widget store — in the backlog");
  expect(text).toContain("Waits on:");
  expect(text).toContain("2  #12 Inventory the widgets — in flight");
  expect(text).toContain("1  #11 [Human] Provide the sample device — yours to do");
  expect(text).toContain("and 2 more");
  expect(text).toContain("Finished predecessors:");
  expect(text).toContain("7  #17 Agree the widget names — complete (noted: annual only)");
  expect(text).toContain("Blocks:");
  expect(text).toContain("5  #15 Ship the widget page — open in another milestone (M02)");
  // The same step by its step id.
  expect(roadmapWhyLines(scopedDto(), "3")[0]).toContain("Step 3 · #13");

  const running = roadmapWhyLines(scopedDto(), "2").join("\n");
  expect(running).toContain("Step 2 · #12 Inventory the widgets — in flight");
  expect(running).toContain("Waits on nothing — it has no predecessor steps");
  expect(running).toContain("3  #13 Build the widget store — in the backlog");
});

test("why: a bare number is a step first; an unknown or finished step, or an older status, says so", () => {
  // Step 2 exists and so does issue #2 (of step 9): the bare number is the step, and the output says how to name the issue.
  const tied = scopedStatus();
  (tied.links as { step: string; issue: number }[]).push({ ...tied.links[0]!, step: "9", issue: 2 } as never);
  const a = scopedDto();
  a.state.roadmap = tied as never;
  const lines = roadmapWhyLines(a, "2").join("\n");
  expect(lines).toContain("Step 2 · #12");
  expect(lines).toContain("(read as step 2; for issue #2 write #2)");
  expect(roadmapWhyLines(a, "#2")[0]).toContain("Step 9 · #2");

  expect(roadmapWhyLines(scopedDto(), "#99").join("\n")).toContain("#99 isn't an open step in scope (M01)");
  expect(roadmapWhyLines(scopedDto(), "4.5").join("\n")).toContain("step 4.5 isn't an open step in scope (M01)");
  expect(roadmapWhyLines(scopedDto({ links: undefined }), "3").join("\n")).toContain("written by an older build");
  expect(roadmapWhyLines(dto({ roadmap: null }), "3").join("\n")).toContain("no tracker is set");
  // The status of another scope isn't this run's.
  expect(roadmapWhyLines(scopedDto({}, { milestone: M02, milestones: [M02] }), "3").join("\n")).toContain("no status yet");
});

test("why reads GET /autopilot and nothing else; it needs exactly one step", async () => {
  const { client, calls } = fakeClient(scopedDto() as never);
  const r = await runRoadmap(client, ["why", "#13"]);
  expect(calls).toEqual([{ method: "GET", path: "/autopilot", body: undefined }]);
  expect(r.lines[0]).toContain("Step 3 · #13");
  expect(r.data).toMatchObject({ ref: "#13", step: { step: "3", issue: 13 } });
  await expect(runRoadmap(client, ["why"])).rejects.toThrow("'why' needs one step");
  await expect(runRoadmap(client, ["why", "3", "4"])).rejects.toThrow("'why' needs one step");
});

test("status: the next milestone, why it is offered, what of it can start and the command that accepts it", () => {
  const due = roadmapStatusLines(scopedDto({ nextMilestone: offer() })).join("\n");
  expect(due).toContain('Scope: milestone "M01 — Widget foundations"');
  expect(due).toContain("Next milestone:");
  expect(due).toContain("M01 is nearly done (1 step left to start). Start M02 — Widget page (3 steps) as well?");
  expect(due).toContain("0 can start yet — waiting on steps 2 (#12), 3 (#13)");
  expect(due).toContain("agetor roadmap continue            start M02 as well");
  expect(due).toContain("agetor roadmap continue --always");
  expect(due).toContain("agetor roadmap continue --not-now");

  // Not due yet: named, with the command, but nothing to dismiss.
  const early = roadmapStatusLines(scopedDto({ nextMilestone: offer({ reason: null, left: 4 }) })).join("\n");
  expect(early).toContain("Next: M02 — Widget page (3 steps) — offered once M01 has fewer than 3 steps left to start (4 now)");
  expect(early).not.toContain("--not-now");

  const dismissed = roadmapStatusLines(scopedDto({ nextMilestone: offer({ dismissedAt: 1_700_000_000_000 }) })).join("\n");
  expect(dismissed).toContain("you said not now at");
  expect(dismissed).not.toContain("--not-now");

  // Several milestones in scope, continued automatically.
  const auto = roadmapStatusLines(
    scopedDto(
      { scope: { ...M01, roadmapTotal: 6, milestones: [{ ...M01, total: 3 }, { ...M02, total: 3 }] }, continued: [{ ...M02, stage: "M02", at: 1_700_000_000_000, by: "auto" }], nextMilestone: null },
      { milestones: [M01, M02], autoContinue: true },
    ),
  ).join("\n");
  expect(auto).toContain('Scope: milestones "M01 — Widget foundations" + "M02 — Widget page"');
  expect(auto).toContain("Always continue is on");
  expect(auto).toContain("continued into M02 — Widget page at");
  expect(auto).toContain("(always continue)");
  expect(auto).not.toContain("Next milestone:");
});

test("continue: accepts the offer, --always also turns asking off, --not-now dismisses, --off is a config change", async () => {
  expect(parseRoadmapContinueArgs([])).toBe("accept");
  expect(parseRoadmapContinueArgs(["--always"])).toBe("always");
  expect(parseRoadmapContinueArgs(["--off"])).toBe("off");
  expect(parseRoadmapContinueArgs(["--not-now"])).toBe("dismiss");
  expect(() => parseRoadmapContinueArgs(["--always", "--off"])).toThrow("at most one of");
  expect(() => parseRoadmapContinueArgs(["M02"])).toThrow("at most one of");

  const calls: { method: string; path: string; body?: unknown }[] = [];
  const answered = scopedDto({}, { milestones: [M01, M02], autoContinue: true });
  const client = {
    ...fakeClient().client,
    call: async <T>(method: string, p: string, body?: unknown) => {
      calls.push({ method, path: p, body });
      return (method === "PUT" ? { ...answered, config: { ...answered.config, ...(body as object) } } : { ...answered, ok: true, message: "M02 — Widget page is in scope with M01: 3 steps get a Backlog card (1 can start now)" }) as T;
    },
  };
  const r = await runRoadmap(client, ["continue"]);
  expect(calls).toEqual([{ method: "POST", path: "/autopilot/roadmap/continue", body: { action: "accept" } }]);
  expect(r.lines.join("\n")).toContain("M02 — Widget page is in scope with M01");
  expect(r.data).toMatchObject({ ok: true, action: "accept", milestones: [M01, M02], autoContinue: true });
  calls.length = 0;
  await runRoadmap(client, ["continue", "--always"]);
  await runRoadmap(client, ["continue", "--not-now"]);
  expect(calls.map((c) => c.body)).toEqual([{ action: "always" }, { action: "dismiss" }]);
  calls.length = 0;
  const off = await runRoadmap(client, ["continue", "--off"]);
  expect(calls).toEqual([{ method: "PUT", path: "/autopilot", body: { autoContinue: false } }]);
  expect(off.lines.join("\n")).toContain("Always continue is off");
  // The server's refusal is passed on.
  const refusing = { ...client, call: async () => Promise.reject(new Error("no milestone follows the scope")) };
  await expect(runRoadmap(refusing as never, ["continue"])).rejects.toThrow("no milestone follows the scope");
});

test("start --auto-continue starts with always continue on; without it the flag isn't sent", async () => {
  expect(parseRoadmapStartFlags(["--project", "/repo", "--auto-continue"])).toEqual({ project: "/repo", autoContinue: true });
  const a = fakeClient();
  const r = await runRoadmap(a.client, ["start", "--project", "/repo", "--issue", "600", "--milestone", "M01", "--auto-continue"]);
  expect(a.calls.at(-1)).toMatchObject({ method: "PUT", path: "/autopilot", body: { enabled: true, roadmap: { issue: 600 }, milestone: M01, autoContinue: true } });
  expect(r.lines.join("\n")).toContain("always continue is on");
  const b = fakeClient();
  const plain = await runRoadmap(b.client, ["start", "--project", "/repo", "--issue", "600", "--milestone", "M01"]);
  expect(b.calls.at(-1)!.body).not.toHaveProperty("autoContinue");
  expect(plain.lines.join("\n")).toContain("the next milestone is offered when this one can no longer fill its slots");
});
