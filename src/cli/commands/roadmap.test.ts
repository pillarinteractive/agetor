import { expect, test } from "bun:test";
import path from "node:path";
import { parseRoadmapStartFlags, roadmapStatusLines, runRoadmap } from "./roadmap.ts";
import type { Pipeline, Project } from "../../shared/types.ts";

const status = {
  issue: 600,
  url: "https://github.com/o/r/issues/600",
  fetchedAt: 0,
  counts: { total: 6, complete: 2, declined: 1, inFlight: 1, ready: 1, waiting: 1 },
  humanReady: [{ step: "1", issue: 11, title: "[Human] Provide the sample device", url: "https://github.com/o/r/issues/11" }],
  needsUser: [{ step: "2", issue: 12, title: "Inventory the widgets", url: null, reason: "PR #77 merged but the issue is still open" }],
  nextWaiting: [{ step: "5", issue: 15, title: "Ship the widget page", url: null, waitingOn: ["3", "4"], reason: null }],
  problems: [{ kind: "unknown-predecessor" as const, message: "step 9: predecessor 44 names no step", step: "9" }],
  idleReason: null,
};
const dto = (over: Record<string, unknown> = {}) => ({
  config: { enabled: true, project: "/repo", maxInFlight: 3, pipelineId: null, roadmap: { issue: 600 }, ...over },
  state: { phase: "running", lastError: null, roadmap: status },
});

function fakeClient(answer = dto()) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    client: {
      call: async <T>(method: string, p: string, body?: unknown) => {
        calls.push({ method, path: p, body });
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
  expect(text).toContain("2/6 complete · 1 in flight · 1 ready · 1 waiting · 1 declined");
  expect(text).toContain("1  #11 [Human] Provide the sample device");
  expect(text).toContain("PR #77 merged but the issue is still open");
  expect(text).toContain("waits on 3, 4");
  expect(text).toContain("step 9: predecessor 44 names no step");
  expect(r.data).toMatchObject({ enabled: true, roadmap: { issue: 600 }, status: { counts: { total: 6 } } });
});

test("status without roadmap mode, or before the first pass, says so", () => {
  expect(roadmapStatusLines(dto({ roadmap: null })).join("\n")).toContain("isn't set up");
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
    { method: "PUT", path: "/autopilot", body: { enabled: true, project: path.resolve("/repo"), roadmap: { issue: 600 }, maxInFlight: 4, pipelineId: "pl-1" } },
  ]);
  await expect(runRoadmap(client, ["start", "--project", "/elsewhere", "--issue", "600"])).rejects.toThrow("isn't a project");
  await expect(runRoadmap(client, ["start", "--project", "/repo", "--issue", "600", "--pipeline", "nope"])).rejects.toThrow("unknown pipeline");
  await expect(runRoadmap(client, ["start", "--project", "/repo"])).rejects.toThrow("--project and --issue");
});

test("pause only turns Autopilot off", async () => {
  const { client, calls } = fakeClient();
  await runRoadmap(client, ["pause"]);
  expect(calls).toEqual([{ method: "PUT", path: "/autopilot", body: { enabled: false } }]);
  await expect(runRoadmap(client, ["bogus"])).rejects.toThrow("usage: agetor roadmap");
});
