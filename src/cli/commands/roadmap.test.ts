import { expect, test } from "bun:test";
import path from "node:path";
import { matchMilestoneRef, parseRoadmapStartFlags, roadmapStatusLines, runRoadmap } from "./roadmap.ts";
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
