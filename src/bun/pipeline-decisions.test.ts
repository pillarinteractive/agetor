import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decisionPolicyForProject, PIPELINE_DECISIONS_PREF, plannerDecisionInstructions } from "../shared/pipeline-decisions.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { environmentReminderKey, gatewayBillingNoticeKey } from "./optional-claude-prompt.ts";
const dir = mkdtempSync(join(tmpdir(), "agetor-decisions-"));
process.env.AGETOR_DATA_DIR = dir;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
const parents: string[] = [];
beforeAll(async () => (await import("./pipeline-runner.ts")).initPipelineRunner());
afterEach(async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  const { preferences } = await import("./db.ts"); preferences.set(PIPELINE_DECISIONS_PREF, "null");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents.splice(0)) await deleteTask(id);
  (await import("./pipeline-runner.ts")).stopPipelineAutoRetryTimers();
});
afterAll(async () => { await Bun.sleep(150); rmTestDataDir(dir); });
async function fixture(enabled = true, blocked = false) {
  const { tasks, preferences, agentProfiles, pipelines } = await import("./db.ts");
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: marker } = await import("./agents.ts");
  const wd = mkdtempSync(join(tmpdir(), "agetor-decision-project-"));
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: "planner-recommendation", projects: enabled ? [wd] : [] }));
  const profile = agentProfiles.insert({ name: randomUUID(), harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "Preserve permissions", skills: [] });
  const step = newStep({ name: "Build", agentProfileId: profile.id, instructions: `${marker}:${blocked ? "blocked" : "done"}` });
  const pipeline = pipelines.insert({ name: randomUUID(), graph: { steps: [step], edges: [], startStepId: step.id }, maxSteps: 14 });
  const created = await createTask({ title: "planner decision", prompt: "All acceptance criteria", workdir: wd, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id; parents.push(id);
  // The fixture has no actual remote; only injected adapters below publish.
  tasks.update(id, { issueUrl: "https://github.com/acme/widget/issues/12" });
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = blocked ? "30" : "1500";
  const started = await startTask(id); if ("error" in started) throw new Error(started.error);
  if (blocked) {
    const deadline = Date.now() + 5000;
    while (tasks.get(id)?.pipelineRun?.status !== "blocked") { if (Date.now() > deadline) throw new Error("block timed out"); await Bun.sleep(15); }
  }
  return { id, parent: tasks.get(id)!, profile };
}
function record(at: number, question = "Which cache implementation?") {
  return { question, recommendation: "Use the existing bounded cache", rationale: "Issue12 requires bounded local storage; existing cache fulfills it", evidence: ["#12", "src/cache.ts"], affectedArtifacts: ["src/cache.ts"], category: "routine", capturedAt: at };
}
async function adapters() {
  let created = 0, updated = 0;
  const bodies: string[] = [];
  const item = { number: 91, htmlUrl: "https://github.com/acme/widget/issues/91" };
  const deps = {
    repo: async () => ({ owner: "acme", name: "widget", remoteHost: "github.com" }),
    create: async (input: { body?: string }) => { created++; bodies.push(input.body!); return { ok: true, item }; },
    update: async (input: { body?: string }) => { updated++; bodies.push(input.body!); return { ok: true, item }; },
  };
  const { recordPipelineDecision } = await import("./pipeline-decisions.ts");
  return { call: (id: string, input: unknown) => recordPipelineDecision(id, input, deps as never), deps, bodies, counts: () => ({ created, updated }) };
}
test("project opt-in is explicit, exact and fails closed", () => {
  const raw = JSON.stringify({ mode: "planner-recommendation", projects: ["/work/pillar"] });
  expect(decisionPolicyForProject(raw, "/work/pillar")).toBe("planner-recommendation");
  for (const [r, p] of [[raw, "/work/other"], [raw, "/work/pillar-child"], ["true", "/work/pillar"], ["{", "/work/pillar"]]) expect(decisionPolicyForProject(r, p!)).toBeUndefined();
});
test("only the exact harmless environment reminder is dismissible; permission prompts are never auto-approved", () => {
  const text = "Teach auto mode about your environment?\nAuto mode works better when it knows your environment. Takes about a minute.";
  const choices = [{ key: "1", label: "Yes" }, { key: "2", label: "Not now" }, { key: "3", label: "Don't show again" }];
  expect(environmentReminderKey(text, choices)).toBe("3");
  expect(environmentReminderKey("Allow deleting credentials?", choices)).toBeNull();
  expect(environmentReminderKey(text, [{ key: "1", label: "Allow (Recommended)" }])).toBeNull();
  expect(environmentReminderKey("Teach auto mode about your environment?", choices)).toBeNull();
});
test("only the exact gateway billing notice is continued, at any wrap width, and never when choices are offered", () => {
  const notice = [
    "  ⎿  Waiting…", "────────────",
    "  We're changing auto mode to no longer charge for classifier requests in", "  Claude Code.",
    "  However, this session isn't eligible because your requests go through", "  api.deepseek.com, which isn't compatible with this update.",
    "  Nothing breaks: auto mode keeps working, and its classifier requests are", "  billed as before.",
    "  To fix it and access the new version of auto mode, ask your gateway to", "  implement: https://code.claude.com/docs/en/auto-mode-classifier-billing",
    "  Enter to continue · Esc to cancel",
  ].join("\n");
  expect(gatewayBillingNoticeKey(notice, [])).toBe("Enter");
  expect(gatewayBillingNoticeKey(notice.replace(/\n\s*/g, " "), [])).toBe("Enter"); // one long line
  expect(gatewayBillingNoticeKey(notice.replace("classifier requests in\n  Claude Code.", "classifier\n  requests in Claude Code."), [])).toBe("Enter"); // wrapped elsewhere
  expect(gatewayBillingNoticeKey(notice, [{ key: "1", label: "Yes" }])).toBeNull();
  expect(gatewayBillingNoticeKey(notice.replace("Nothing breaks: auto mode keeps working", "Auto mode will be turned off"), [])).toBeNull();
  expect(gatewayBillingNoticeKey(notice.replace("Enter to continue · Esc to cancel", "Enter to allow · Esc to cancel"), [])).toBeNull();
  expect(gatewayBillingNoticeKey("Allow deleting credentials?\n  Enter to continue · Esc to cancel", [])).toBeNull();
});
test("planner instructions choose on the same card, derive missing recommendations, and preserve authority and quality boundaries", () => {
  const p = plannerDecisionInstructions("parent", 123);
  for (const text of ["continue THIS SAME CARD", "first reason as the planner", "Before acting", "required-authority", "do not perform the protected action", "Logging never grants authority", "reviewer denials", "Failing tests", "unmet prerequisites", "Never mark unfinished work done", "Do not poll", "capturedAt:123"]) expect(p).toContain(text);
});
test("a run freezes opt-in and launches the planner policy without changing its caps or agent permissions", async () => {
  const { id, parent, profile } = await fixture();
  const { tasks, preferences } = await import("./db.ts");
  expect(parent.pipelineRun!.snapshot!.decisionPolicy).toBe("planner-recommendation");
  expect(parent.pipelineRun!.snapshot!.maxSteps).toBe(14);
  expect(parent.pipelineRun!.snapshot!.profiles[profile.id]!.instructions).toBe("Preserve permissions");
  expect(tasks.get(parent.pipelineRun!.active[0]!.taskId)!.prompt).toContain(`agetor pipeline decision ${id}`);
  preferences.set(PIPELINE_DECISIONS_PREF, "null");
  expect(tasks.get(id)!.pipelineRun!.snapshot!.decisionPolicy).toBe("planner-recommendation");
});
test("routine recommendation is audited, deduplicated and published once while the same card keeps running", async () => {
  const { id, parent } = await fixture(); const api = await adapters();
  const before = JSON.stringify(parent.pipelineRun);
  const input = record(parent.pipelineRun!.snapshot!.capturedAt);
  const a = await api.call(id, input); const b = await api.call(id, input);
  expect(a.recorded).toBe(true); expect(a.approvalGranted).toBe(false); expect(b.deduplicated).toBe(true);
  expect(api.counts()).toEqual({ created: 1, updated: 0 });
  expect(JSON.parse(readFileSync(a.path as string, "utf8")).records[0]).toMatchObject(input);
  expect(JSON.stringify((await import("./db.ts")).tasks.get(id)!.pipelineRun)).toBe(before);
  expect(api.bodies[0]).not.toContain(input.question); expect(api.bodies[0]).not.toContain(input.rationale);
  expect(api.bodies[0]).toContain("agetor pipeline decisions");
});
test("later choices update the same human follow-up instead of creating issue spam", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  await api.call(id, record(at)); await api.call(id, record(at, "Which module layout?"));
  expect(api.counts()).toEqual({ created: 1, updated: 1 });
});
test("instruction refresh and a revised recommendation retain the same issue and prior rationale", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  const first = await api.call(id, record(at));
  const { tasks } = await import("./db.ts");
  const fresh = tasks.get(id)!.pipelineRun!; fresh.snapshot!.capturedAt = at + 1; tasks.setPipelineRun(id, fresh);
  expect((await api.call(id, record(at + 1))).deduplicated).toBe(true);
  const updated = await api.call(id, { ...record(at + 1), recommendation: "Use the newly approved bounded helper", evidence: ["#12", "docs/approved-decision.md"] });
  expect(updated.path).toBe(first.path); expect(api.counts()).toEqual({ created: 1, updated: 1 });
  const records = JSON.parse(readFileSync(updated.path as string, "utf8")).records;
  expect(records).toHaveLength(1); expect(records[0].revisions[0].recommendation).toBe("Use the existing bounded cache");
});
test("recording required authority never answers or restarts a held sibling or changes pipeline state", async () => {
  const { id, parent } = await fixture(); const api = await adapters();
  const before = JSON.stringify(parent.pipelineRun);
  const a = await api.call(id, { ...record(parent.pipelineRun!.snapshot!.capturedAt), category: "required-authority", recommendation: "Obtain explicit permission before deleting data" });
  expect(a.recorded).toBe(true); expect(a.approvalGranted).toBe(false);
  expect(JSON.stringify((await import("./db.ts")).tasks.get(id)!.pipelineRun)).toBe(before);
  expect(api.bodies[0]).toContain("protected action must remain blocked");
});
test("missing planner recommendation or evidence is rejected without publication", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const input = record(parent.pipelineRun!.snapshot!.capturedAt);
  for (const invalid of [{ ...input, recommendation: "" }, { ...input, evidence: [] }, { ...input, category: "approve" }]) expect(await api.call(id, invalid)).toHaveProperty("error");
  expect(api.counts()).toEqual({ created: 0, updated: 0 });
});
test("unscoped, stopped and stale runs cannot use planner decision publication", async () => {
  const api = await adapters(); const unscoped = await fixture(false);
  expect(await api.call(unscoped.id, record(unscoped.parent.pipelineRun!.snapshot!.capturedAt))).toHaveProperty("error");
  const blocked = await fixture(true, true); const before = JSON.stringify(blocked.parent.pipelineRun);
  expect(await api.call(blocked.id, record(blocked.parent.pipelineRun!.snapshot!.capturedAt))).toHaveProperty("error");
  expect(JSON.stringify((await import("./db.ts")).tasks.get(blocked.id)!.pipelineRun)).toBe(before);
  const active = await fixture(); expect(await api.call(active.id, record(active.parent.pipelineRun!.snapshot!.capturedAt - 1))).toHaveProperty("error");
  expect(api.counts()).toEqual({ created: 0, updated: 0 });
});
test("uncertain remote publication is persisted and never retried into duplicate issues", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); let calls = 0;
  api.deps.create = async () => { calls++; throw new Error("response lost after create"); };
  const { recordPipelineDecision } = await import("./pipeline-decisions.ts"); const at = parent.pipelineRun!.snapshot!.capturedAt;
  const a = await recordPipelineDecision(id, record(at), api.deps as never);
  expect(a.publication).toBe("uncertain"); expect(a.recorded).toBe(true);
  await recordPipelineDecision(id, record(at), api.deps as never); await recordPipelineDecision(id, record(at, "Another choice?"), api.deps as never);
  expect(calls).toBe(1);
});
test("repository mismatch never publishes a decision to another repository", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); api.deps.repo = async () => ({ owner: "other", name: "widget", remoteHost: "github.com" });
  const { recordPipelineDecision } = await import("./pipeline-decisions.ts");
  expect((await recordPipelineDecision(id, record(parent.pipelineRun!.snapshot!.capturedAt), api.deps as never)).publication).toBe("unavailable");
  expect(api.counts()).toEqual({ created: 0, updated: 0 });
});
test("simultaneous records claim the parent before remote awaits", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); let release!: () => void;
  api.deps.repo = async () => { await new Promise<void>((r) => { release = r; }); return { owner: "acme", name: "widget", remoteHost: "github.com" }; };
  const { recordPipelineDecision } = await import("./pipeline-decisions.ts"); const input = record(parent.pipelineRun!.snapshot!.capturedAt);
  const first = recordPipelineDecision(id, input, api.deps as never);
  expect(await recordPipelineDecision(id, input, api.deps as never)).toHaveProperty("error");
  release(); await first; expect(api.counts()).toEqual({ created: 1, updated: 0 });
});
test("known secrets are redacted locally and agent text is absent from the remote issue", async () => {
  const { parseDecisionRecord } = await import("./pipeline-decisions.ts");
  const r = parseDecisionRecord({ ...record(123), question: "token=secret-value ghp_AbCdEf123", rationale: "api_key=private-key" })!;
  expect(JSON.stringify(r)).not.toContain("secret-value"); expect(JSON.stringify(r)).not.toContain("private-key"); expect(JSON.stringify(r)).not.toContain("ghp_");
});
test("permanent session teardown cancels stale questions while other tasks' live holds survive", async () => {
  const { registerTmuxPrompt, listPendingForTask, cancelPendingForTask } = await import("./interactions.ts");
  registerTmuxPrompt({ taskId: "old-session", runId: "old-run", paneText: "Teach auto mode about your environment?", choices: [{ key: "3", label: "Don't show again" }], fingerprint: "old" });
  registerTmuxPrompt({ taskId: "held-sibling", runId: "live-run", paneText: "Permission required", choices: [{ key: "1", label: "Allow" }], fingerprint: "live" });
  await (await import("./claude-tmux.ts")).dropSession("old-session");
  expect(listPendingForTask("old-session")).toHaveLength(0); expect(listPendingForTask("held-sibling")).toHaveLength(1);
  cancelPendingForTask("held-sibling", "fixture cleanup");
});

test("an identical record retries a failed lookup before any mutation without duplicating the record", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); let lookups = 0;
  api.deps.repo = async () => { if (++lookups === 1) throw new Error("temporary lookup failure"); return { owner: "acme", name: "widget", remoteHost: "github.com" }; };
  const input = record(parent.pipelineRun!.snapshot!.capturedAt);
  expect((await api.call(id, input)).publication).toBe("not-attempted");
  const retry = await api.call(id, input);
  expect(retry.publication).toBe("published"); expect(retry.deduplicated).toBe(true);
  expect(api.counts()).toEqual({ created: 1, updated: 0 });
  expect(JSON.parse(readFileSync(retry.path as string, "utf8")).records).toHaveLength(1);
});

test("repository lookup failures before an update retry the same existing follow-up", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  await api.call(id, record(at));
  api.deps.repo = async () => { throw new Error("lookup unavailable before update"); };
  await api.call(id, record(at, "Second choice?"));
  api.deps.repo = async () => ({ owner: "acme", name: "widget", remoteHost: "github.com" });
  expect((await api.call(id, record(at, "Second choice?"))).publication).toBe("published");
  expect(api.counts()).toEqual({ created: 1, updated: 1 });
  await api.call(id, record(at, "Second choice?"));
  expect(api.counts()).toEqual({ created: 1, updated: 1 });
});

test("a corrected repository mismatch never creates a second issue for an existing follow-up", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  await api.call(id, record(at));
  api.deps.repo = async () => ({ owner: "other", name: "widget", remoteHost: "github.com" });
  expect((await api.call(id, record(at, "Next choice?"))).publication).toBe("unavailable");
  api.deps.repo = async () => ({ owner: "acme", name: "widget", remoteHost: "github.com" });
  expect((await api.call(id, record(at, "Next choice?"))).publication).toBe("published");
  expect(api.counts()).toEqual({ created: 1, updated: 1 });
});

test("real create and update stay bound to the verified owning repository after remote changes", async () => {
  const { id, parent } = await fixture(); const { tasks } = await import("./db.ts"); const wd = tasks.get(id)!.workdir;
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", ...args], { cwd: wd }); if (r.exitCode) throw new Error(r.stderr.toString()); };
  git("init"); git("remote", "add", "origin", "https://github.com/acme/widget.git");
  const { repoForDir, createGitHubIssue, updateGitHubIssue } = await import("./github.ts");
  const { recordPipelineDecision } = await import("./pipeline-decisions.ts");
  const previousFetch = globalThis.fetch, previousToken = process.env.GITHUB_TOKEN;
  const attempted: Array<{ url: string; method: string }> = []; process.env.GITHUB_TOKEN = "synthetic-test-token";
  globalThis.fetch = (async (url: unknown, options?: RequestInit) => {
    attempted.push({ url: String(url), method: options?.method ?? "GET" });
    return new Response(JSON.stringify({ number: 91, title: "Human follow-up", state: "open", html_url: "https://github.com/acme/widget/issues/91" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const deps = {
      repo: async (dir: string) => { const verified = await repoForDir(dir); git("remote", "set-url", "origin", "https://github.com/unrelated/widget.git"); return verified; },
      create: createGitHubIssue, update: updateGitHubIssue,
    };
    const at = parent.pipelineRun!.snapshot!.capturedAt;
    expect((await recordPipelineDecision(id, record(at), deps)).publication).toBe("published");
    git("remote", "set-url", "origin", "https://github.com/acme/widget.git");
    expect((await recordPipelineDecision(id, record(at, "Another recommendation?"), deps)).publication).toBe("published");
    expect(attempted).toEqual([
      { url: "https://api.github.com/repos/acme/widget/issues", method: "POST" },
      { url: "https://api.github.com/repos/acme/widget/issues/91", method: "PATCH" },
    ]);
  } finally { globalThis.fetch = previousFetch; if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken; }
});

test("published ownership and source issue remain immutable after task scope changes, including within the same repository", async () => {
  for (const issueUrl of ["https://github.com/unrelated/widget/issues/13", "https://github.com/acme/widget/issues/13"]) {
    const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
    const initial = await api.call(id, record(at)); const { tasks } = await import("./db.ts");
    tasks.update(id, { issueUrl });
    const changed = await api.call(id, record(at, "Changed scope choice?"));
    expect(changed).toHaveProperty("error"); expect(changed.recorded).toBe(false); expect(changed.reconciliationRequired).toContain("source issue changed");
    const ledger = JSON.parse(readFileSync(initial.path as string, "utf8"));
    expect(ledger.sourceIssue).toBe("https://github.com/acme/widget/issues/12");
    expect(ledger.repository).toEqual({ owner: "acme", name: "widget", remoteHost: "github.com" });
    expect(ledger.issueUrl).toBe("https://github.com/acme/widget/issues/91"); expect(ledger.records).toHaveLength(1);
    tasks.update(id, { issueUrl: parent.issueUrl });
    expect(await api.call(id, record(at, "Restored scope?"))).toHaveProperty("error"); // Explicit reconciliation is still required.
    expect(api.counts()).toEqual({ created: 1, updated: 0 });
  }
});

test("a lookup failure pins source ownership before an identical retry can see changed task metadata", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  api.deps.repo = async () => { throw new Error("lookup failed before create"); };
  const initial = await api.call(id, record(at));
  const ledger = JSON.parse(readFileSync(initial.path as string, "utf8")); expect(ledger.sourceIssue).toBe("https://github.com/acme/widget/issues/12");
  (await import("./db.ts")).tasks.update(id, { issueUrl: "https://github.com/unrelated/widget/issues/12" });
  api.deps.repo = async () => ({ owner: "unrelated", name: "widget", remoteHost: "github.com" });
  expect(await api.call(id, record(at))).toHaveProperty("error"); expect(api.counts()).toEqual({ created: 0, updated: 0 });
});

test("source changes during awaited repository lookup prevent both create and update", async () => {
  for (const published of [false, true]) {
    const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
    if (published) await api.call(id, record(at));
    api.deps.repo = async () => {
      (await import("./db.ts")).tasks.update(id, { issueUrl: "https://github.com/acme/widget/issues/13" });
      return { owner: "acme", name: "widget", remoteHost: "github.com" };
    };
    const result = await api.call(id, record(at, "Choice before scope changed?"));
    expect(result).toHaveProperty("error"); expect(result.recorded).toBe(true); expect(result.reconciliationRequired).toContain("during repository lookup");
    expect(api.counts()).toEqual({ created: published ? 1 : 0, updated: 0 });
    expect(JSON.parse(readFileSync(result.path as string, "utf8")).sourceIssue).toBe("https://github.com/acme/widget/issues/12");
  }
});

test("a new run during repository lookup cannot inherit the old run's publication claim", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  api.deps.repo = async () => {
    const { tasks } = await import("./db.ts"); const run = tasks.get(id)!.pipelineRun!;
    run.startedAt = (run.startedAt ?? at) + 1; run.snapshot!.capturedAt = at + 1; tasks.setPipelineRun(id, run);
    return { owner: "acme", name: "widget", remoteHost: "github.com" };
  };
  const result = await api.call(id, record(at)); expect(result.error).toContain("run changed");
  expect(result.publication).toBe("not-attempted"); expect(api.counts()).toEqual({ created: 0, updated: 0 });
});

test("an in-flight create stays bound to original ownership and records a concurrent scope change for reconciliation", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  let mutations = 0; let bound: unknown;
  (api.deps as unknown as { create: (...args: unknown[]) => unknown }).create = async (_input: unknown, repo: unknown) => {
    bound = repo; mutations++;
    (await import("./db.ts")).tasks.update(id, { issueUrl: "https://github.com/unrelated/widget/issues/13" });
    return { ok: true, item: { number: 91, htmlUrl: "https://github.com/acme/widget/issues/91" } };
  };
  const result = await api.call(id, record(at)); expect(result.error).toContain("during publication");
  expect(bound).toEqual({ owner: "acme", name: "widget", remoteHost: "github.com" });
  const ledger = JSON.parse(readFileSync(result.path as string, "utf8")); expect(ledger.publication).toBe("published");
  expect(ledger.sourceIssue).toBe("https://github.com/acme/widget/issues/12"); expect(ledger.issueUrl).toBe("https://github.com/acme/widget/issues/91");
  await api.call(id, record(at)); expect(mutations).toBe(1);
});

test("untrusted response identities cannot rebind a create or update, and uncertain mutations never replay", async () => {
  for (const published of [false, true]) {
    const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
    if (published) await api.call(id, record(at));
    let attempts = 0;
    const wrong = async () => { attempts++; return { ok: true, item: { number: 99, htmlUrl: "https://github.com/unrelated/widget/issues/99" } }; };
    api.deps.create = wrong; api.deps.update = wrong;
    const result = await api.call(id, record(at, "Choice with inconsistent response?"));
    expect(result).toHaveProperty("error"); expect(result.publication).toBe("uncertain");
    const ledger = JSON.parse(readFileSync(result.path as string, "utf8"));
    expect(ledger.repository.owner).toBe("acme"); expect(ledger.issueUrl).toBe(published ? "https://github.com/acme/widget/issues/91" : undefined);
    expect(ledger.issueNumber).toBe(published ? 91 : undefined);
    await api.call(id, record(at, "Choice with inconsistent response?")); expect(attempts).toBe(1);
  }
});

test("an update response cannot substitute another issue number in the same repository", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  await api.call(id, record(at));
  api.deps.update = async () => ({ ok: true, item: { number: 92, htmlUrl: "https://github.com/acme/widget/issues/92" } });
  const result = await api.call(id, record(at, "Different issue response?")); expect(result.publication).toBe("uncertain");
  expect(JSON.parse(readFileSync(result.path as string, "utf8")).issueNumber).toBe(91);
});

test("legacy published and unpublished ledgers without proven source ownership require reconciliation", async () => {
  for (const published of [false, true]) {
    const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
    if (!published) api.deps.repo = async () => { throw new Error("pre-create lookup failed"); };
    const initial = await api.call(id, record(at));
    const ledger = JSON.parse(readFileSync(initial.path as string, "utf8")); delete ledger.sourceIssue; delete ledger.repository;
    writeFileSync(initial.path as string, JSON.stringify(ledger));
    api.deps.repo = async () => ({ owner: "acme", name: "widget", remoteHost: "github.com" });
    expect((await api.call(id, record(at, "Legacy choice?"))).reconciliationRequired).toContain("ownership is missing");
    expect(api.counts()).toEqual({ created: published ? 1 : 0, updated: 0 });
  }
});

test("inconsistent persisted follow-up ownership cannot target a remote update", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  const initial = await api.call(id, record(at));
  const ledger = JSON.parse(readFileSync(initial.path as string, "utf8")); ledger.issueUrl = "https://github.com/unrelated/widget/issues/91";
  writeFileSync(initial.path as string, JSON.stringify(ledger));
  expect((await api.call(id, record(at, "Tampered follow-up?"))).reconciliationRequired).toContain("follow-up identity");
  expect(api.counts()).toEqual({ created: 1, updated: 0 });
});

test("an authentication-host change cannot silently rebind an existing follow-up", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  await api.call(id, record(at));
  api.deps.repo = async () => ({ owner: "acme", name: "widget", remoteHost: "github-other-account" });
  const result = await api.call(id, record(at, "Another host?")); expect(result.publication).toBe("unavailable");
  expect(JSON.parse(readFileSync(result.path as string, "utf8")).repository.remoteHost).toBe("github.com");
  expect(api.counts()).toEqual({ created: 1, updated: 0 });
});

test("ledger run and publication identity inconsistencies cannot create or update a follow-up", async () => {
  for (const corrupt of [
    (ledger: Record<string, unknown>) => { ledger.runStartedAt = Number(ledger.runStartedAt) + 1; },
    (ledger: Record<string, unknown>) => { delete ledger.issueNumber; },
    (ledger: Record<string, unknown>) => { ledger.publication = "not-attempted"; },
  ]) {
    const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
    const initial = await api.call(id, record(at)); const ledger = JSON.parse(readFileSync(initial.path as string, "utf8"));
    corrupt(ledger); writeFileSync(initial.path as string, JSON.stringify(ledger));
    expect(await api.call(id, record(at, "Inconsistent ledger?"))).toHaveProperty("error");
    expect(api.counts()).toEqual({ created: 1, updated: 0 });
  }
});

test("concurrent records cannot race a pending update; a concurrent scope change retains the original follow-up", async () => {
  const { id, parent } = await fixture(); const api = await adapters(); const at = parent.pipelineRun!.snapshot!.capturedAt;
  await api.call(id, record(at)); let release!: () => void; let started!: () => void; const entered = new Promise<void>((r) => { started = r; });
  let calls = 0; let bound: unknown;
  (api.deps as unknown as { update: (...args: unknown[]) => unknown }).update = async (_input: unknown, repo: unknown) => {
    bound = repo; calls++; started(); await new Promise<void>((r) => { release = r; });
    return { ok: true, item: { number: 91, htmlUrl: "https://github.com/acme/widget/issues/91" } };
  };
  const updating = api.call(id, record(at, "Before concurrent change?")); await entered;
  expect(await api.call(id, record(at, "Second concurrent record?"))).toHaveProperty("error");
  (await import("./db.ts")).tasks.update(id, { issueUrl: "https://github.com/unrelated/widget/issues/91" });
  release(); const result = await updating;
  expect(result.reconciliationRequired).toContain("during publication"); expect(calls).toBe(1);
  expect(bound).toEqual({ owner: "acme", name: "widget", remoteHost: "github.com" });
  const ledger = JSON.parse(readFileSync(result.path as string, "utf8"));
  expect(ledger.records).toHaveLength(2); expect(ledger.issueNumber).toBe(91); expect(ledger.issueUrl).toBe("https://github.com/acme/widget/issues/91");
  expect(ledger.sourceIssue).toBe("https://github.com/acme/widget/issues/12");
});
