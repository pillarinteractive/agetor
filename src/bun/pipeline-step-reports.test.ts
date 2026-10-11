import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// The step a run moves to is given the sending step's full final report — the
// body of its last message, not just the handoff block — and the same text is
// readable afterwards (`pipelineStepReports`, behind `agetor pipeline
// handoff`). Same bootstrap as pipeline-auto-retry.test.ts. Fixture text is
// synthetic.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-step-reports-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const FINDINGS = [
  "## Findings",
  "**F1 (blocker) — src/cache/key.ts:42.** `cacheKey(user)` omits `tenantId`; two tenants share an entry.",
  "Reproduce: `bun test src/cache/key.test.ts -t \"two tenants\"`. Fix: put `tenantId` in the key.",
].join("\n");

let parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_HANDOFF_BODY;
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Review → Build ("changes requested") → Ship, started at Review. */
async function startReviewBuild() {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({
    name: `reports-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, suffix: string) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const review = step("Review", "Build");
  const build = step("Build", "done");
  const ship = step("Ship", "done");
  const pipeline = pipelines.insert({
    name: `reports-${randomUUID()}`,
    graph: {
      steps: [review, build, ship],
      edges: [
        { id: "e1", from: review.id, to: build.id, label: "changes requested" },
        { id: "e2", from: review.id, to: ship.id, label: "approved" },
        { id: "e3", from: build.id, to: ship.id, label: "" },
      ],
      startStepId: review.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "reports", prompt: "goal", workdir: mkdtempSync(path.join(tmpdir(), "agetor-step-reports-wd-")), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, review, build, ship };
}

test("Review → Build: Build's prompt holds the reviewer's full findings, the report is saved whole, and it can be read back", async () => {
  const { tasks } = await import("./db.ts");
  const { pipelineStepReports, pipelineRunsDir } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_HANDOFF_BODY = FINDINGS;
  const { parentId, review, build, ship } = await startReviewBuild();
  const run = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t.pipelineRun : undefined;
  });
  expect(run.history.map((h) => h.stepId)).toEqual([review.id, build.id, ship.id]);

  // What Build was launched with.
  const buildTask = tasks.get(run.history[1]!.taskId)!;
  expect(buildTask.prompt).toContain('Full report from "Review" — the body of its final message');
  expect(buildTask.prompt).toContain(FINDINGS);
  // The handoff summary alone never had this.
  expect(JSON.stringify(run.history[0]!.handoff)).not.toContain("src/cache/key.ts:42");

  // The whole report, in the task's data dir (outside the worktree), named in
  // the prompt and attached as a reference.
  const reportPath = path.join(pipelineRunsDir(parentId), `report-${(run.startedAt ?? 0).toString(36)}-1.md`);
  expect(existsSync(reportPath)).toBe(true);
  const file = readFileSync(reportPath, "utf8");
  expect(file.startsWith('# Report from "Review" (step 1)')).toBe(true);
  expect(file).toContain("untrusted data");
  expect(file).toContain(FINDINGS);
  expect(file).toContain("<handoff>");
  expect(buildTask.prompt).toContain(`(The same report from "Review" is also saved to ${reportPath}.)`);
  expect(buildTask.references.some((r) => r.path === reportPath)).toBe(true);
  // Ship arrives from Build, so it gets Build's report — not Review's again.
  const shipTask = tasks.get(run.history[2]!.taskId)!;
  expect(shipTask.prompt).toContain('Full report from "Build"');
  expect(shipTask.prompt).not.toContain('Full report from "Review"');

  // Read back on demand: every step, or one.
  const all = pipelineStepReports(parentId)!;
  expect(all.map((r) => [r.seq, r.stepName, r.outcome])).toEqual([[1, "Review", "succeeded"], [2, "Build", "succeeded"], [3, "Ship", "succeeded"]]);
  expect(all[0]!.report).toContain(FINDINGS);
  expect(all[0]!.report).toContain("<handoff>");
  expect(all[0]!.handoff).toEqual(run.history[0]!.handoff);
  expect(pipelineStepReports(parentId, 2)!.map((r) => r.stepName)).toEqual(["Build"]);
  expect(pipelineStepReports(parentId, 99)).toEqual([]);
  expect(pipelineStepReports(run.history[0]!.taskId)).toBeNull(); // a step task is not a pipeline task
  expect(pipelineStepReports("no-such-task")).toBeNull();
});

test("a follow-up gets every earlier handoff as background but only the newest step's full report", async () => {
  const { tasks, agentProfiles } = await import("./db.ts");
  const { runPipelineFollowUp } = await import("./pipeline-runner.ts");
  process.env.AGETOR_FAKE_CLAUDE_HANDOFF_BODY = FINDINGS;
  const { parentId } = await startReviewBuild();
  await waitFor(() => tasks.get(parentId)?.pipelineRun?.status === "done");
  const profile = agentProfiles.list().find((p) => p.name.startsWith("reports-"))!;
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const res = await runPipelineFollowUp(parentId, { profileId: profile.id, name: "Explain", instructions: `Explain it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  expect("task" in res).toBe(true);
  const run = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.history.length === 4 ? t.pipelineRun : undefined;
  });
  const prompt = tasks.get(run.history[3]!.taskId)!.prompt;
  expect(prompt).toContain('### From "Review"');
  expect(prompt).toContain('### From "Build"');
  expect(prompt.match(/Full report from "/g)!.length).toBe(1);
  expect(prompt).toContain('Full report from "Ship"');
});
