import { test, expect, describe, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineRunState, PipelineStep, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Pre-loading a step's first turn (`pipeline_gates`' `preload`): what Agetor
// reads at launch, against temporary git repositories, and what the runner
// puts in a step's prompt, with the scripted fake as the agent. Nothing is
// pushed and GitHub is never called. Same bootstrap as
// pipeline-check-gates.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-preload-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { tasks, preferences, pipelines, agentProfiles } = await import("./db.ts");
const { newStep } = await import("../shared/pipeline.ts");
const { PIPELINE_GATES_PREF } = await import("../shared/publish.ts");
const { PRELOAD_LIMITS } = await import("../shared/preload.ts");
const { STEP_SLOTS_PREF } = await import("./step-slots.ts");
const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
const { checkDeps } = await import("./check-runner.ts");
const { preloadDeps, stepPreload } = await import("./preload.ts");
const runner = await import("./pipeline-runner.ts");
const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");

const realCheckDeps = { ...checkDeps };
const realPreloadDeps = { ...preloadDeps };
const NOW = Date.parse("2026-10-13T20:00:00.000Z");
let parents: string[] = [];
let gitCalls = 0;
const SLOTS = JSON.stringify({ max: 200, heavy: { max: 200, steps: [] }, ci: { max: 200, exempt: [] } });
let slotsBefore: string | null = null;

beforeAll(() => {
  runner.initPipelineRunner();
  slotsBefore = preferences.get(STEP_SLOTS_PREF) ?? null;
  preferences.set(STEP_SLOTS_PREF, SLOTS);
});

beforeEach(() => {
  Object.assign(checkDeps, realCheckDeps);
  Object.assign(preloadDeps, realPreloadDeps);
  checkDeps.base = async () => "develop";
  preloadDeps.now = () => NOW;
  gitCalls = 0;
  preloadDeps.git = (args, cwd) => {
    gitCalls++;
    return realPreloadDeps.git(args, cwd);
  };
  preferences.set(PIPELINE_GATES_PREF, "{}");
});

afterEach(async () => {
  runner.stopPipelineAutoRetryTimers();
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
  Object.assign(checkDeps, realCheckDeps);
  Object.assign(preloadDeps, realPreloadDeps);
  preferences.set(STEP_SLOTS_PREF, slotsBefore ?? "");
  preferences.set(PIPELINE_GATES_PREF, "{}");
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(args, {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

const numbered = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

/** A bare `origin` with `develop` and a clone on the card's branch, level
 *  with `develop`: `src/total.ts` (60 lines), `src/tax.ts` (30), a lockfile,
 *  a JSON fixture. `commit` adds a commit to the card's branch. */
async function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "agetor-preload-repo-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "card");
  await sh(root, "git", "init", "-q", "--bare", "-b", "develop", origin);
  await sh(root, "git", "clone", "-q", origin, repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) await sh(repo, "git", "config", k!, v!);
  mkdirSync(path.join(repo, "src"));
  mkdirSync(path.join(repo, "pkg", "fixtures"), { recursive: true });
  writeFileSync(path.join(repo, "src", "total.ts"), numbered(60, "total"));
  writeFileSync(path.join(repo, "src", "tax.ts"), numbered(30, "tax"));
  writeFileSync(path.join(repo, "src", "legacy.ts"), numbered(10, "legacy"));
  writeFileSync(path.join(repo, "pnpm-lock.yaml"), numbered(40, "lock"));
  writeFileSync(path.join(repo, "pkg", "fixtures", "case.json"), "{}\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "base");
  await sh(repo, "git", "push", "-q", "origin", "HEAD:develop");
  await sh(repo, "git", "checkout", "-q", "-b", "claude/x", "origin/develop");
  const gitDir = await sh(repo, "git", "rev-parse", "--absolute-git-dir");
  const head = () => sh(repo, "git", "rev-parse", "HEAD");
  const commit = async (files: Record<string, string | Uint8Array>, message = "change") => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), content);
    }
    await sh(repo, "git", "add", ".");
    await sh(repo, "git", "commit", "-qm", message);
    return head();
  };
  const writeMap = (text: string) => {
    mkdirSync(path.join(gitDir, "agetor"), { recursive: true });
    writeFileSync(path.join(gitDir, "agetor", "file-map.md"), text);
  };
  return { root, repo, gitDir, head, commit, writeMap, mapPath: path.join(gitDir, "agetor", "file-map.md") };
}
type Repo = Awaited<ReturnType<typeof makeRepo>>;

const mapFor = (head: string, body: string[]) => [
  "# File map — issue #7", "", "## Header", "- Issue: #7", `- HEAD: \`${head}\``, "- Date: 2026-10-13", "", ...body, "",
].join("\n");
const MAP_BODY = [
  "## Touch points",
  "- `src/total.ts:L10-L14` — the rounding",
  "- `src/total.ts:L55-L70` — past the end",
  "- `src/missing.ts:L1-L5`",
  "- `pnpm-lock.yaml:L1-L5`",
  "- `src/legacy.ts:L1-L5`",
  "- `linked.ts:L1-L2`",
  "",
  "## Read for context",
  "- `src/tax.ts:L3-L4`",
  "",
  "## Tests",
  "- `src/total.test.ts:L1-L9`",
  "",
  "## Ruled out",
  "- `src/legacy.ts` — dead code, not on this path",
];

// A reviewed pipeline's steps, as far as `preloadKind` reads them.
const understand = newStep({ name: "Understand" });
const build = newStep({ name: "Build" });
const review = newStep({ name: "Review" });
const finish = newStep({ name: "Finish" });
const edge = (from: PipelineStep, to: PipelineStep, label = "") => ({ id: `${from.id}-${to.id}`, from: from.id, to: to.id, label });
const GRAPH = {
  steps: [understand, build, review, finish],
  edges: [edge(understand, build, "build"), edge(understand, review, "trivial change made"), edge(build, review), edge(review, build, "changes requested"), edge(review, finish, "approved"), edge(finish, build, "verification failed")],
  startStepId: understand.id,
};
const cardOf = (r: Repo, over: Partial<Task> = {}) => ({
  id: "card", title: "Issue #7: round the total", prompt: "Acceptance:\n- CA01 totals are rounded", workdir: r.repo, worktreePath: null, baseRef: null,
  issueUrl: "https://github.com/o/r/issues/7", ...over,
}) as Task;
const visit = (s: PipelineStep) => ({ stepId: s.id });
const load = (r: Repo, step: PipelineStep, history: { stepId: string }[], over: Partial<Task> = {}) =>
  stepPreload({ parent: cardOf(r, over), graph: GRAPH, step, history });

describe("Build's first visit", () => {
  test("the map and the code at its ranges, read from the worktree; everything not inlined is named with its reason", async () => {
    const r = await makeRepo();
    const outside = path.join(r.root, "outside.ts");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, path.join(r.repo, "linked.ts"));
    const head = await r.head();
    r.writeMap(mapFor(head, MAP_BODY));
    const got = (await load(r, build, [visit(understand)]))!;
    expect(got.kind).toBe("build-first");
    expect(got.inline.card).toContain(`The card's file map (${r.mapPath})`);
    expect(got.inline.card).toContain("- `src/total.ts:L10-L14` — the rounding");
    const visitText = got.inline.visit!;
    expect(visitText).toContain(`as they are at HEAD ${head}`);
    expect(visitText).toContain("### src/total.ts:L10-L14\n\n```\ntotal 10\ntotal 11\ntotal 12\ntotal 13\ntotal 14\n```");
    expect(visitText).toContain("### src/tax.ts:L3-L4 — read for context\n\n```\ntax 3\ntax 4\n```");
    const notInlined = visitText.slice(visitText.indexOf("Not inlined:")).split("\n").slice(1);
    expect(notInlined).toEqual([
      "- not inlined: src/legacy.ts — the map lists it under Ruled out",
      "- not inlined: src/total.ts:L55-L70 — past the end of the file (60 lines) — the map is out of date for it",
      "- not inlined: src/missing.ts — not in the worktree (new, moved or misnamed)",
      "- not inlined: pnpm-lock.yaml — a lockfile",
      "- not inlined: linked.ts — not a regular file inside the worktree",
    ]);
    // Never: a ruled-out path, a lockfile, what a link points at outside the worktree, a test file.
    for (const never of ["legacy 1", "lock 1", "secret", "total.test.ts:L"]) expect(visitText).not.toContain(never);
    expect(got.reference).toEqual({ card: `## File map\n\nThe card's file map is at ${r.mapPath}.`, visit: null });
  }, 30_000);

  test("uncommitted edits are what is read: the slice is the worktree's, not the commit's", async () => {
    const r = await makeRepo();
    r.writeMap(mapFor(await r.head(), ["## Touch points", "- `src/tax.ts:L1-L2`"]));
    writeFileSync(path.join(r.repo, "src", "tax.ts"), "edited 1\nedited 2\nedited 3\n");
    expect((await load(r, build, [visit(understand)]))!.inline.visit).toContain("### src/tax.ts:L1-L2\n\n```\nedited 1\nedited 2\n```");
  }, 30_000);

  const stale: { name: string; header: (head: string) => string; says: string }[] = [
    { name: "the map names another commit", header: () => "- HEAD: `0123456789abcdef0123456789abcdef01234567`", says: "written for commit 0123456789abcdef0123456789abcdef01234567 and the worktree is at" },
    { name: "the map names no commit", header: () => "- Issue: #7", says: "names no commit" },
  ];
  for (const c of stale) {
    test(`${c.name}: no slice is taken by line numbers, the prompt says why, and only the map is inlined`, async () => {
      const r = await makeRepo();
      const head = await r.head();
      r.writeMap(["# File map", "", "## Header", c.header(head), "", ...MAP_BODY].join("\n"));
      const got = (await load(r, build, [visit(understand)]))!;
      expect(got.inline.visit).toBeNull();
      expect(got.inline.card).toContain(c.says);
      expect(got.inline.card).toContain("no code was inlined by them");
      expect(got.inline.card).toContain("- `src/total.ts:L10-L14` — the rounding");
      expect(got.inline.card).not.toContain("total 10");
    }, 30_000);
  }

  test("a short sha in the header is enough; a commit made after the map was written is not covered by it", async () => {
    const r = await makeRepo();
    const head = await r.head();
    r.writeMap(`Header: commit \`${head.slice(0, 8)}\` on \`claude/x\`.\n\n## Touch points\n- \`src/tax.ts\` :3–4 the rate`);
    expect((await load(r, build, [visit(understand)]))!.inline.visit).toContain("### src/tax.ts:L3-L4\n\n```\ntax 3\ntax 4\n```");
    await r.commit({ "src/tax.ts": `inserted\n${numbered(30, "tax")}` });
    const after = (await load(r, build, [visit(understand)]))!;
    expect(after.inline.visit).toBeNull();
    expect(after.inline.card).toContain(`written for commit ${head.slice(0, 8)}`);
  }, 30_000);

  test("no map: nothing is added", async () => {
    const r = await makeRepo();
    expect(await load(r, build, [visit(understand)])).toBeNull();
  }, 30_000);

  test("slices over the budget: the largest is left out and named, the rest are inlined whole", async () => {
    const r = await makeRepo();
    const wide = (prefix: string) => Array.from({ length: 300 }, (_, i) => `${prefix} ${i} ${"x".repeat(120)}`).join("\n") + "\n";
    const head = await r.commit({ "src/a.ts": wide("a"), "src/b.ts": wide("b"), "src/c.ts": wide("c") });
    r.writeMap(mapFor(head, ["## Touch points", "- `src/a.ts:L1-L120`", "- `src/b.ts:L1-L300`", "- `src/c.ts:L1-L100`", "## Read for context", "- `src/tax.ts:L1-L3`"]));
    // History holds only Understand, whatever HEAD has: the map's HEAD is what makes its numbers true.
    const visitText = (await load(r, build, [visit(understand)]))!.inline.visit!;
    expect(visitText).toContain("### src/a.ts:L1-L120");
    expect(visitText).toContain("### src/c.ts:L1-L100");
    expect(visitText).toContain("### src/tax.ts:L1-L3 — read for context");
    expect(visitText).not.toContain("### src/b.ts");
    expect(visitText).toMatch(/- trimmed: read src\/b\.ts:L1-L300 yourself \([\d,]+ tokens, over what is left of the 12,000-token budget for slices\)/);
    const inlined = [...visitText.matchAll(/```\n([\s\S]*?)\n```/g)].reduce((sum, m) => sum + m[1]!.length, 0);
    expect(inlined).toBeLessThanOrEqual(PRELOAD_LIMITS.sliceTokens * PRELOAD_LIMITS.charsPerToken);
  }, 30_000);
});

describe("a Build visit after other steps ran", () => {
  test("the branch's diff with ten lines of context, never slices; lockfiles, snapshots, fixtures, generated and binary files are named", async () => {
    const r = await makeRepo();
    const base = await r.head();
    r.writeMap(mapFor(base, MAP_BODY));
    const total = numbered(60, "total").replace("total 30\n", "total thirty\n");
    const head = await r.commit({
      "src/total.ts": total, "pnpm-lock.yaml": numbered(41, "lock"), "pkg/fixtures/case.json": '{"a":1}\n', "src/__snapshots__/a.snap": "snap\n",
      "src/api.generated.ts": "export {};\n", "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    });
    const got = (await load(r, build, [visit(understand), visit(build), visit(review)]))!;
    expect(got.kind).toBe("build-bounce");
    const visitText = got.inline.visit!;
    expect(visitText.startsWith(`## What this branch changes so far\n\n\`git diff -U10 origin/develop...HEAD\` at HEAD ${head}.`)).toBe(true);
    expect(visitText).toContain("-total 30\n+total thirty");
    // Ten lines either side of the change, no more.
    expect(visitText).toContain("\n total 20\n");
    expect(visitText).toContain("\n total 40\n");
    expect(visitText).not.toContain("\n total 19\n");
    expect(visitText).not.toContain("\n total 41\n");
    expect(visitText).not.toContain("###");
    const notInlined = visitText.slice(visitText.indexOf("Not inlined:")).split("\n").slice(1).sort();
    expect(notInlined).toEqual([
      "- not inlined: assets/logo.png — a binary file",
      "- not inlined: pkg/fixtures/case.json — a JSON fixture (+1 −1)",
      "- not inlined: pnpm-lock.yaml — a lockfile (+1 −0)",
      "- not inlined: src/__snapshots__/a.snap — a snapshot (+1 −0)",
      "- not inlined: src/api.generated.ts — generated (+1 −0)",
    ]);
    for (const never of ["lock 41", "snap\n", "export {}", '"a":1']) expect(visitText).not.toContain(never);
    // The map is still shown, with a warning in place of slices.
    expect(got.inline.card).toContain("may have moved since: no code is inlined by them on this visit");
    expect(got.inline.card).not.toContain("total 10\n");
  }, 30_000);

  test("a diff over the budget: files over the cap and the largest of the rest are named as trimmed, and what is inlined fits", async () => {
    const r = await makeRepo();
    const body = (prefix: string, lines: number) => Array.from({ length: lines }, (_, i) => `${prefix} ${i} ${"y".repeat(90)}`).join("\n") + "\n";
    const files: Record<string, string> = { "src/huge.ts": body("huge", 400) };
    for (let i = 0; i < 6; i++) files[`src/m${i}.ts`] = body(`m${i}`, 160 + i);
    await r.commit(files);
    const visitText = (await load(r, build, [visit(build)]))!.inline.visit!;
    expect(visitText).toMatch(/- trimmed: read src\/huge\.ts yourself \(its diff is [\d,]+ tokens, over the 6,000-token cap for one file\)/);
    expect(visitText).toMatch(/- trimmed: read src\/m5\.ts yourself \(its diff is [\d,]+ tokens, over what is left of the 20,000-token budget for the diff\)/);
    expect(visitText).toContain("+++ b/src/m0.ts");
    expect(visitText).not.toContain("+++ b/src/huge.ts");
    const inlined = /```diff\n([\s\S]*)\n```/.exec(visitText)![1]!;
    expect(inlined.length).toBeLessThanOrEqual(PRELOAD_LIMITS.diffTokens * PRELOAD_LIMITS.charsPerToken);
  }, 30_000);

  test("no commit ahead and no map: nothing is added; no base to diff against: the map alone", async () => {
    const r = await makeRepo();
    expect(await load(r, build, [visit(build)])).toBeNull();
    r.writeMap(mapFor(await r.head(), MAP_BODY));
    checkDeps.base = async () => "no-such-branch";
    const got = (await load(r, build, [visit(build)]))!;
    expect(got.inline.visit).toBeNull();
    expect(got.inline.card).toContain("## File map");
  }, 30_000);
});

test("Understand, Review and Finish are not pre-loaded, and a folder that is no git repository is no reason to fail", async () => {
  const r = await makeRepo();
  r.writeMap(mapFor(await r.head(), MAP_BODY));
  expect(await load(r, understand, [])).toBeNull();
  expect(await load(r, review, [visit(understand), visit(build)])).toBeNull();
  expect(await load(r, finish, [visit(understand), visit(build), visit(review)])).toBeNull();
  const plain = mkdtempSync(path.join(tmpdir(), "agetor-preload-plain-"));
  expect(await load(r, build, [visit(understand)], { workdir: plain })).toBeNull();
}, 30_000);

// ---------------------------------------------------------------------------
// Through the runner
// ---------------------------------------------------------------------------

/** Poll for a condition (never a duration). */
async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const runOf = (id: string): PipelineRunState => tasks.get(id)!.pipelineRun!;
const where = (id: string) => {
  const run = runOf(id);
  return JSON.stringify({ status: run.status, stepCount: run.stepCount, blocked: run.blocked.map((b) => `${b.kind}: ${b.message}`), history: run.history.map((h) => [h.seq, h.stepId, h.outcome]) });
};
const until = async (id: string, done: (run: PipelineRunState) => boolean, what: string) => {
  try {
    return await waitFor(() => (done(runOf(id)) ? runOf(id) : null), what);
  } catch (e) {
    throw new Error(`${(e as Error).message} — ${where(id)}`);
  }
};
/** The prompts of a step's visits, in order. */
const promptsOf = (run: PipelineRunState, step: PipelineStep) =>
  run.history.filter((h) => h.stepId === step.id).sort((a, b) => a.seq - b.seq).map((h) => tasks.get(h.taskId)!);

/** Understand → Build → Review → Finish with scripted agents: each step
 *  hands off to the step named in `script`. */
async function makeCard(workdir: string, script: { understand?: string; review?: string } = {}, maxSteps = 9) {
  const profile = agentProfiles.insert({
    name: `preload-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, next: string, extra: Partial<PipelineStep> = {}) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do the ${name} work. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${next}`, ...extra });
  const u = step("Understand", script.understand ?? "Build");
  const b = step("Build", "Review");
  const rv = step("Review", script.review ?? "Finish");
  const f = step("Finish", "done", { canFinish: true });
  const e = (from: PipelineStep, to: PipelineStep, label = "") => ({ id: `${from.name}-${to.name}`, from: from.id, to: to.id, label });
  const graph = {
    steps: [u, b, rv, f],
    edges: [e(u, b, "build"), e(u, rv, "trivial change made"), e(b, rv), e(rv, b, "changes requested"), e(rv, f, "approved"), e(f, b, "verification failed")],
    startStepId: u.id,
  };
  const pipeline = pipelines.insert({ name: `preload-${randomUUID()}`, graph, maxSteps });
  const created = await createTask({ title: "Issue #7: round the total", prompt: "Acceptance:\n- CA01 totals are rounded", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  return { id: created.task.id, pipeline, understand: u, build: b, review: rv, finish: f };
}
const switchOn = (pipelineName: string, cards?: string[]) =>
  preferences.set(PIPELINE_GATES_PREF, JSON.stringify({ preload: { pipelines: [pipelineName], ...(cards ? { cards } : {}) } }));
async function start(id: string) {
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
}
const PRELOAD_HEADINGS = ["## File map", "## Code at the file map's ranges", "## What this branch changes so far"];

describe("through the runner", () => {
  test("switch off: no prompt has a pre-loaded section and nothing is read for one — also for a card left out of the trial list", async () => {
    const r = await makeRepo();
    r.writeMap(mapFor(await r.commit({ "src/tax.ts": numbered(31, "tax") }), MAP_BODY));
    const off = await makeCard(r.repo);
    await start(off.id);
    const done = await until(off.id, (run) => run.status === "done", "the run done");
    for (const h of done.history) for (const heading of PRELOAD_HEADINGS) expect(tasks.get(h.taskId)!.prompt).not.toContain(heading);

    const other = await makeCard(r.repo);
    switchOn(other.pipeline.name, ["some-other-card"]);
    await start(other.id);
    const left = await until(other.id, (run) => run.status === "done", "the run done");
    for (const h of left.history) for (const heading of PRELOAD_HEADINGS) expect(tasks.get(h.taskId)!.prompt).not.toContain(heading);
    expect(gitCalls).toBe(0);
  }, 60_000);

  test("switch on, for a card on the trial list: Build starts with the map and its code; the other steps are as they were", async () => {
    const r = await makeRepo();
    const head = await r.commit({ "src/tax.ts": numbered(31, "tax") });
    r.writeMap(mapFor(head, MAP_BODY));
    const card = await makeCard(r.repo);
    switchOn(card.pipeline.name, [card.id]);
    await start(card.id);
    const run = await until(card.id, (x) => x.status === "done", "the run done");
    expect(run.history.map((h) => h.stepId)).toEqual([card.understand.id, card.build.id, card.review.id, card.finish.id]);

    const buildTask = promptsOf(run, card.build)[0]!;
    const at = (prompt: string, heading: string) => prompt.indexOf(`\n\n${heading}`);
    const order = ["## Overall goal", "## File map", "## Context from previous step(s)", "## Code at the file map's ranges", "## Your step"].map((h) => at(buildTask.prompt, h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(buildTask.prompt).toContain("### src/total.ts:L10-L14\n\n```\ntotal 10\ntotal 11\ntotal 12\ntotal 13\ntotal 14\n```");
    expect(buildTask.prompt).not.toContain("## What this branch changes so far");

    for (const step of [card.understand, card.review, card.finish]) {
      for (const heading of PRELOAD_HEADINGS) expect(promptsOf(run, step)[0]!.prompt).not.toContain(heading);
    }
  }, 60_000);

  test("Review sends the work back: that Build gets the diff and Review's findings, and no slice by line number", async () => {
    const r = await makeRepo();
    const head = await r.commit({ "src/total.ts": numbered(60, "total").replace("total 30\n", "total thirty\n") });
    r.writeMap(mapFor(head, MAP_BODY));
    // Review always asks for changes; the cap stops the run after the second Build.
    const card = await makeCard(r.repo, { review: "Build" }, 4);
    switchOn(card.pipeline.name);
    await start(card.id);
    const run = await until(card.id, (x) => x.history.filter((h) => h.stepId === card.build.id && h.endedAt !== null).length === 2, "two Build visits");
    const [first, bounce] = promptsOf(run, card.build);
    expect(first!.prompt).toContain("## Code at the file map's ranges");
    expect(bounce!.prompt).toContain(`## What this branch changes so far\n\n\`git diff -U10 origin/develop...HEAD\` at HEAD ${head}.`);
    expect(bounce!.prompt).toContain("-total 30\n+total thirty");
    expect(bounce!.prompt).not.toContain("## Code at the file map's ranges");
    expect(bounce!.prompt).not.toContain("### src/total.ts:L10-L14");
    // What already arrived still does: Review's handoff, in its untrusted span.
    expect(bounce!.prompt).toContain('### From "Review"');
    expect(bounce!.prompt.indexOf('### From "Review"')).toBeLessThan(bounce!.prompt.indexOf("## What this branch changes so far"));
  }, 60_000);

  test("switch on where nothing can be read: the run goes on exactly as without it", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "agetor-preload-plain-"));
    const card = await makeCard(plain);
    switchOn(card.pipeline.name);
    preloadDeps.git = async () => {
      throw new Error("git is not there");
    };
    await start(card.id);
    const run = await until(card.id, (x) => x.status === "done", "the run done");
    expect(run.history).toHaveLength(4);
    for (const h of run.history) for (const heading of PRELOAD_HEADINGS) expect(tasks.get(h.taskId)!.prompt).not.toContain(heading);
  }, 60_000);
});
