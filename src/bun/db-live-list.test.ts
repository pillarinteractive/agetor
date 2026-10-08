// tasks.listLive / listByIds / stepIds / branchRows — the narrowed reads the
// core's background loops use instead of reading and parsing every row
// (archived history included) on every tick.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import (see the sibling
// db-*.test.ts files).
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-live-list-"));
process.env.AGETOR_DATA_DIR = dataDir;

let tasks: typeof import("./db.ts").tasks;
let interactions: typeof import("./interactions.ts");
let stepSessionRows: typeof import("./pipeline-runner.ts").stepSessionRows;
let inactiveStepSessions: typeof import("./pipeline-runner.ts").inactiveStepSessions;

let clock = 1_000_000;
function row(id: string, o: Partial<Task> = {}): Task {
  clock += 1_000;
  return {
    id,
    title: id,
    prompt: `prompt ${id}`,
    agent: "claude-code",
    workdir: "/repo",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: clock,
    updatedAt: clock,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...o,
  };
}

const ARCHIVED = 5;

beforeAll(async () => {
  ({ tasks } = await import("./db.ts"));
  interactions = await import("./interactions.ts");
  ({ stepSessionRows, inactiveStepSessions } = await import("./pipeline-runner.ts"));
  // Plain cards: live, archived.
  tasks.insert(row("card-live", { column: "running", branch: "feat/a" }));
  tasks.insert(row("card-arch", { archivedAt: ARCHIVED, branch: "feat/b", column: "done" }));
  tasks.insert(row("card-nobranch", { branch: "" }));
  // A live pipeline parent: one live step, one step a restart archived.
  tasks.insert(row("par-live", { pipelineId: "pl", branch: "feat/p", column: "running" }));
  tasks.insert(row("step-live", { pipelineParentId: "par-live", pipelineStepId: "s1", branch: "feat/p" }));
  tasks.insert(row("step-replaced", { pipelineParentId: "par-live", pipelineStepId: "s0", archivedAt: ARCHIVED, branch: "feat/p" }));
  // An archived pipeline parent and its (cascade-archived) steps.
  tasks.insert(row("par-arch", { pipelineId: "pl", archivedAt: ARCHIVED, branch: "feat/q" }));
  tasks.insert(row("step-arch", { pipelineParentId: "par-arch", pipelineStepId: "s1", archivedAt: ARCHIVED, branch: "feat/q" }));
  // Pending interactions on steps fold into their parents (D11).
  for (const [taskId, fp] of [["step-live", "fp1"], ["step-replaced", "fp2"], ["step-arch", "fp3"]]) {
    interactions.registerTmuxPrompt({ taskId: taskId!, runId: "r", paneText: "?", choices: [{ key: "1", label: "Yes" }], fingerprint: fp! });
  }
});

afterAll(() => {
  interactions.__testing.reset();
  rmTestDataDir(dataDir);
});

const ids = (list: Task[]) => list.map((t) => t.id);

test("listLive: every non-archived row plus every step of a live parent, archived or not", () => {
  expect(ids(tasks.listLive()).sort()).toEqual(["card-live", "card-nobranch", "par-live", "step-live", "step-replaced"]);
});

test("listLive rows are the same Task objects list() gives, in the same order (pending folding included)", () => {
  const live = tasks.listLive();
  const want = new Set(ids(live));
  expect(live).toEqual(tasks.list().filter((t) => want.has(t.id)));
  // par-live folds both of its steps' prompts, archived one included.
  expect(live.find((t) => t.id === "par-live")?.pendingInteractionCount).toBe(2);
});

test("every row listLive leaves out is archived and isn't a step of a live parent", () => {
  const all = tasks.list();
  const live = new Set(ids(tasks.listLive()));
  const byId = new Map(all.map((t) => [t.id, t]));
  const left = all.filter((t) => !live.has(t.id));
  expect(ids(left).sort()).toEqual(["card-arch", "par-arch", "step-arch"]);
  for (const t of left) {
    expect(t.archivedAt).not.toBeNull();
    if (t.pipelineParentId) expect(byId.get(t.pipelineParentId)?.archivedAt).not.toBeNull();
  }
});

test("listByIds: exactly the named rows, any archived state, list()-shaped", () => {
  expect(tasks.listByIds([])).toEqual([]);
  const got = tasks.listByIds(["step-arch", "par-live", "nope"]);
  expect(ids(got)).toEqual(["step-arch", "par-live"]); // created_at DESC, like list()
  const full = new Map(tasks.list().map((t) => [t.id, t]));
  expect(got.find((t) => t.id === "step-arch")).toEqual(full.get("step-arch")!);
  // A parent folds only the steps that are in the id set.
  expect(got.find((t) => t.id === "par-live")?.pendingInteractionCount).toBe(0);
  expect(tasks.listByIds(["par-live", "step-live"]).find((t) => t.id === "par-live")?.pendingInteractionCount).toBe(1);
});

test("stepIds: every step row with its parent, archived ones included", () => {
  expect(tasks.stepIds().map((s) => `${s.id}>${s.parentId}`).sort()).toEqual([
    "step-arch>par-arch",
    "step-live>par-live",
    "step-replaced>par-live",
  ]);
});

test("branchRows: the rows a branch-taken check sees, same as list() filtered on a branch", () => {
  const want = tasks
    .list()
    .filter((t) => Boolean(t.branch))
    .map((t) => ({ id: t.id, workdir: t.workdir, branch: t.branch!, archivedAt: t.archivedAt }));
  const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  expect(tasks.branchRows().sort(sortById)).toEqual(want.sort(sortById));
});

test("stepSessionRows: the step reaper decides exactly as it would over the whole list", () => {
  const nameOf = (id: string) => `agetor-${id.slice(0, 12)}`;
  const now = clock + 10 * 60_000;
  for (const sessions of [[], ["step-live"], ["step-replaced"], ["step-arch"], ["step-live", "step-replaced", "step-arch", "card-live"]]) {
    const names = new Set(sessions.map(nameOf));
    expect(inactiveStepSessions(stepSessionRows(names, nameOf), names, now, nameOf)).toEqual(
      inactiveStepSessions(tasks.list(), names, now, nameOf),
    );
  }
  expect(stepSessionRows(new Set(), nameOf)).toEqual([]);
  expect(ids(stepSessionRows(new Set([nameOf("step-arch")]), nameOf)).sort()).toEqual(["par-arch", "step-arch"]);
});
