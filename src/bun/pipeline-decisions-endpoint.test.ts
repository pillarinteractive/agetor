import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "agetor-decision-endpoint-"));
process.env.AGETOR_DATA_DIR = dir;
process.env.AGETOR_API_PORT = "4457";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "2500";
let server: { stop: () => void }; let token: string; let id: string; let capturedAt: number;
beforeAll(async () => {
  const { startApiServer, API_TOKEN } = await import("./server.ts"); token = API_TOKEN; server = startApiServer() as never;
  const { tasks, pipelines, preferences, agentProfiles } = await import("./db.ts");
  const { PIPELINE_DECISIONS_PREF } = await import("../shared/pipeline-decisions.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: marker } = await import("./agents.ts");
  const wd = mkdtempSync(join(tmpdir(), "agetor-decision-endpoint-project-"));
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: "planner-recommendation", projects: [wd] }));
  const profile = agentProfiles.insert({ name: randomUUID(), harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [] });
  const step = newStep({ name: "Build", agentProfileId: profile.id, instructions: `${marker}:done` });
  const pipeline = pipelines.insert({ name: randomUUID(), graph: { steps: [step], edges: [], startStepId: step.id }, maxSteps: 14 });
  const created = await createTask({ title: "decision endpoint", prompt: "Issue scope", workdir: wd, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error); id = created.task.id;
  const start = await startTask(id); if ("error" in start) throw new Error(start.error);
  capturedAt = tasks.get(id)!.pipelineRun!.snapshot!.capturedAt;
});
afterAll(async () => {
  await (await import("./orchestrator.ts")).deleteTask(id); server.stop();
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
});
const request = (method: string, body?: unknown, auth = true) => fetch(`http://127.0.0.1:4457/tasks/${id}/pipeline/decisions`, {
  method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
test("decision routes require existing core authentication", async () => { expect((await request("POST", {}, false)).status).toBe(401); });
test("record endpoint rejects missing planner evidence without changing pipeline state", async () => {
  const res = await request("POST", { capturedAt, category: "routine", question: "Pick?" });
  expect(res.status).toBe(409); expect((await res.json()).error).toContain("explicit recommendation");
});
test("record and inspect a recommendation through the authenticated API without starting another worker", async () => {
  const { tasks, runs } = await import("./db.ts"); const before = tasks.get(id)!.pipelineRun!; const child = before.active[0]!.taskId;
  const res = await request("POST", { capturedAt, category: "routine", question: "Which reusable helper?", recommendation: "Use existing helper", rationale: "It meets the issue's existing API contract", evidence: ["src/helper.ts"], affectedArtifacts: ["src/helper.ts"] });
  expect(res.status).toBe(200); const body = await res.json(); expect(body.recorded).toBe(true); expect(body.approvalGranted).toBe(false);
  expect(body.publication).toBe("unavailable"); // no remote or source issue in fixture
  const inspected = await (await request("GET")).json(); expect(inspected.ledger.records).toHaveLength(1);
  expect(inspected.ledger.records[0].recommendation).toBe("Use existing helper");
  expect(tasks.get(id)!.pipelineRun).toEqual(before); expect(runs.listForTask(child)).toHaveLength(1);
});
