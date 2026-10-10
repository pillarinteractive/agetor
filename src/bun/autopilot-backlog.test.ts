// Tracker mode's backlog cards against the real task store, a scratch git
// repo and the fake agent driver: what making a card does (and doesn't do)
// before it starts, that nothing else on the board starts it, and that
// Autopilot starts that same card when its step is ready. GitHub is the only
// thing faked: the tracker, the issue states and the issue threads.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { RoadmapIssueState } from "../shared/roadmap.ts";
import type { Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-autopilot-backlog-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const TRACKER = [
  "## Numbered completion order",
  "| Step | Task and outcome | Milestone | Predecessor steps |",
  "| --- | --- | --- | --- |",
  "| 1 | #21 Inventory the widgets | M01 | none |",
  "| 2 | #22 Build the widget store | M01 | 1 |",
  "| 3 | #23 [Human] Approve the widget store | M01 | 2 |",
  "| 4 | #24 Ship the widget page | M02 | 2 |",
].join("\n");
const M01 = { number: 1, title: "M01 — Widget foundations" };
const GH_MILESTONE: Record<number, { number: number; title: string }> = { 21: M01, 22: M01, 23: M01, 24: { number: 2, title: "M02 — Widget page" } };
const OPEN: RoadmapIssueState = { state: "OPEN", stateReason: null };
const COMPLETED: RoadmapIssueState = { state: "CLOSED", stateReason: "COMPLETED" };

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let repo = "";
let pipelineId = "";
const made: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
  repo = mkdtempSync(path.join(tmpdir(), "agetor-autopilot-backlog-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["remote", "add", "origin", "https://github.com/o/r.git"], repo);
  writeFileSync(path.join(repo, "README.md"), "widgets\n");
  await git(["add", "."], repo);
  await git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "init"], repo);

  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({ name: `backlog-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [] });
  const A = newStep({ name: "Build", agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  pipelineId = pipelines.insert({ name: `backlog-${randomUUID()}`, graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 }).id;
});

afterAll(async () => {
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of made) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

/** The real deps, with GitHub faked. */
async function depsFor(states: Record<number, RoadmapIssueState>) {
  const { ROADMAP_DEPS } = await import("./autopilot.ts");
  const { createTaskFromIssue } = await import("./issue-queue.ts");
  const threads = { n: 0 };
  const issueThread = (async ({ number }: { number: number }) => {
    threads.n++;
    return {
      ok: true,
      repo: "o/r",
      item: {
        kind: "issue", number, title: `Widget task ${number}`, state: "open", draft: false, htmlUrl: `https://github.com/o/r/issues/${number}`,
        author: null, assignees: [], milestone: null, body: `Synthetic body of #${number}.`, labels: [], comments: 0,
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", closedAt: null, mergedAt: null, locked: false,
      },
      comments: [],
      truncated: false,
      refetchCommand: null,
    };
  }) as never;
  const make = (start: boolean) => async (input: { dir: string; number: number; pipelineId: string; extraPrompt: string }) => {
    const r = await createTaskFromIssue({ ...input, start, allowAfterDone: true }, { issueThread });
    if ("error" in r) return { error: r.error };
    made.push(r.task.id);
    return { task: r.task };
  };
  return {
    threads,
    deps: {
      ...ROADMAP_DEPS,
      loadTracker: async () => ({ body: TRACKER, url: "https://github.com/o/r/issues/600" }),
      loadStates: async (_p: string, numbers: number[]) => new Map(numbers.map((n) => [n, { ...(states[n] ?? OPEN), milestone: GH_MILESTONE[n] ?? null, url: `https://github.com/o/r/issues/${n}` }])),
      startCard: make(true),
      createBacklogCard: make(false),
      // No PR watcher here: a finished card isn't a "nothing to build" card.
      hasNoPr: () => false,
      mergedPr: () => null,
      notify: () => false,
      recheck: () => {},
    },
  };
}

test("backlog cards: cheap to make, left alone by everything else, started by Autopilot when their step is ready", async () => {
  const { roadmapPass, readState, parseConfig, AUTOPILOT_STATE_PREF } = await import("./autopilot.ts");
  const { tasks, preferences, dataDir } = await import("./db.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");
  const { dependencyTick, readDependencies } = await import("./dependencies.ts");
  const { neverStarted, holdsAutopilotSlot } = await import("../shared/autopilot.ts");
  const cfg = parseConfig(JSON.stringify({ enabled: true, project: repo, milestone: M01, roadmap: { issue: 600 }, maxInFlight: 1, pipelineId }));
  preferences.set(AUTOPILOT_STATE_PREF, "{}");
  const branchesBefore = await git(["branch", "--list"], repo);
  const worktreesBefore = await git(["worktree", "list"], repo);

  // ── Pass 1: nothing is complete. #21 is ready (but hold it back: no slot),
  // #22 waits on it, #23 is the owner's, #24 is in another milestone.
  const state = readState();
  const first = await depsFor({});
  await roadmapPass({ ...cfg, maxInFlight: 0 }, state, tasks.listLive(), [], first.deps);
  expect(state.lastError).toBeNull();
  expect(Object.keys(state.roadmapBacklog).sort()).toEqual(["21", "22", "23"]);
  expect(first.threads.n).toBe(3); // one GitHub read per card — and #24 got none
  expect(state.cards).toEqual([]);
  // The ledger was saved as the cards were made, not only at the end of the pass.
  expect(Object.keys(readState().roadmapBacklog).sort()).toEqual(["21", "22", "23"]);

  const card = (n: number) => tasks.get(state.roadmapBacklog[String(n)]!)!;
  for (const n of [21, 22, 23]) {
    const t = card(n);
    expect(t).toMatchObject({ column: "backlog", runId: null, worktreePath: null, workdir: repo, issueUrl: `https://github.com/o/r/issues/${n}`, pipelineId });
    expect(t.pipelineRun).toMatchObject({ status: "idle", active: [], history: [] });
    expect(neverStarted(t)).toBe(true);
    expect(existsSync(path.join(WORKTREES_DIR, t.id))).toBe(false);
    // The thread snapshot is the one file a card gets.
    expect(readdirSync(path.join(dataDir, "issue-threads", t.id)).length).toBe(1);
    expect(t.prompt).toContain(`## Roadmap step ${n - 20} (M01)`);
  }
  expect(card(22).prompt).toContain("1 (#21) was not finished");
  // No branch, no worktree, no step task.
  expect(await git(["branch", "--list"], repo)).toBe(branchesBefore);
  expect(await git(["worktree", "list"], repo)).toBe(worktreesBefore);
  expect(tasks.listLive().filter((t) => t.pipelineParentId).length).toBe(0);
  expect(state.roadmap!.cards.map((c) => c.line)).toEqual(["Step 1 · ready — waiting for a slot", "Step 2 · waits on step 1 (#21)", "Step 3 · yours to do, after step 2 (#22)"]);

  // ── Nothing else starts them: they have no dependency entry for the
  // dependency watcher to act on, and a second pass makes no second card.
  expect(readDependencies()).toEqual({});
  expect(await dependencyTick()).toEqual([]);
  const again = await depsFor({});
  await roadmapPass({ ...cfg, maxInFlight: 0 }, state, tasks.listLive(), [], again.deps);
  expect(again.threads.n).toBe(0);
  expect(tasks.listLive().filter((t) => !t.pipelineParentId && t.workdir === repo).length).toBe(3);
  for (const n of [21, 22, 23]) expect(card(n).column).toBe("backlog");

  // ── Pass 3: one slot. Step 1's own card is started — not a new one — and
  // its three backlog cards never held that slot.
  const id21 = state.roadmapBacklog["21"]!;
  const third = await depsFor({});
  await roadmapPass(cfg, state, tasks.listLive(), [], third.deps);
  expect(state.lastError).toBeNull();
  expect(third.threads.n).toBe(0);
  expect(state.cards).toEqual([id21]);
  expect(Object.keys(state.roadmapBacklog).sort()).toEqual(["22", "23"]);
  const started = await waitFor(() => {
    const t = tasks.get(id21)!;
    return t.pipelineRun && t.pipelineRun.status !== "idle" ? t : null;
  });
  expect(neverStarted(started)).toBe(false);
  expect(started.column).not.toBe("backlog");
  expect(started.prompt).toContain("## Roadmap step 1 (M01)");
  expect(started.prompt.match(/## Roadmap step/g)!.length).toBe(1);
  // Starting is what makes the worktree.
  await waitFor(() => tasks.get(id21)!.worktreePath);
  expect(existsSync(tasks.get(id21)!.worktreePath!)).toBe(true);
  // The other two are still exactly where they were.
  for (const n of [22, 23]) expect(card(n)).toMatchObject({ column: "backlog", runId: null, worktreePath: null });

  // ── Pass 4: #21 closed as completed. Step 2's card starts, with its step
  // section rewritten; the owner's card (#23) is never started.
  await waitFor(() => tasks.get(id21)!.pipelineRun?.status === "done");
  tasks.update(id21, { column: "done" }); // its PR merged
  const id22 = state.roadmapBacklog["22"]!;
  const id23 = state.roadmapBacklog["23"]!;
  const fourth = await depsFor({ 21: COMPLETED });
  const mine = (): Task[] => state.cards.map((id) => tasks.get(id)).filter((t): t is Task => !!t);
  await roadmapPass(cfg, state, tasks.listLive(), mine(), fourth.deps);
  expect(state.lastError).toBeNull();
  expect(state.cards).toEqual([id21, id22]);
  expect(state.roadmapBacklog).toEqual({ "23": id23 });
  const prompt22 = tasks.get(id22)!.prompt;
  expect(prompt22).toContain("are finished and already merged into the base: 1 (#21)");
  expect(prompt22).not.toContain("was not finished");
  expect(prompt22).toContain('"Fixes #22"');
  await waitFor(() => tasks.get(id22)!.pipelineRun?.status === "done");

  // ── Pass 5: #22 closed too. The owner's step is ready: surfaced, its card
  // untouched, no slot taken; and the run isn't done while #23 is open.
  tasks.update(id22, { column: "done" });
  const fifth = await depsFor({ 21: COMPLETED, 22: COMPLETED });
  await roadmapPass(cfg, state, tasks.listLive(), mine(), fifth.deps);
  expect(tasks.get(id23)).toMatchObject({ column: "backlog", runId: null, worktreePath: null });
  expect(holdsAutopilotSlot(tasks.get(id23)!)).toBe(true); // by column alone it would — the ledger is what exempts it
  expect(state.roadmap!.counts).toMatchObject({ total: 3, complete: 2, inFlight: 0, ready: 1, backlog: 1 });
  expect(state.roadmap!.humanReady.map((h) => h.issue)).toEqual([23]);
  expect(state.roadmap!.cards).toEqual([{ taskId: id23, step: "3", issue: 23, human: true, line: "Step 3 · yours to do — open the issue", tone: "warning" }]);
  expect(state.phase).toBe("idle");
  expect(await dependencyTick()).toEqual([]);
  expect(tasks.get(id23)!.column).toBe("backlog");

  // ── Pass 6: the owner closes #23 without ever starting its card: the card
  // is closed with a note, and the milestone is done.
  const sixth = await depsFor({ 21: COMPLETED, 22: COMPLETED, 23: COMPLETED });
  await roadmapPass(cfg, state, tasks.listLive(), mine(), sixth.deps);
  expect(tasks.get(id23)!.column).toBe("done");
  expect(state.roadmapBacklog).toEqual({});
  expect(state.phase).toBe("done");
  const notes = readFileSync(path.join(dataDir, "activity", `${id23}.jsonl`), "utf8");
  expect(notes).toContain("is yours to do — Autopilot never starts it");
  expect(notes).toContain("#23 was closed (completed) before this card started — moved it to Done");
  // #24 (another milestone) never got a card.
  expect(tasks.listLive().some((t) => t.issueUrl?.endsWith("/issues/24"))).toBe(false);
}, 60_000);
