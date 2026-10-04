import { describe, expect, test } from "bun:test";
import type { ProgressWatcherConfig, Task, TaskProgressReport } from "../shared/types.ts";
import { parseProgressOutput, parseProgressWatchers, probeTargets, progressMilestones } from "./progress-watch.ts";

describe("parseProgressWatchers", () => {
  test("keeps valid entries, clamps the interval, drops malformed ones", () => {
    const raw = JSON.stringify([
      { project: "/p", label: "lab", command: "lab/vm/plab progress --json", intervalSec: 1 },
      { project: "/p", label: "e2e", command: "x" },
      { project: "/p", command: "no label" },
      "nope",
    ]);
    expect(parseProgressWatchers(raw)).toEqual([
      { project: "/p", label: "lab", command: "lab/vm/plab progress --json", intervalSec: 3 },
      { project: "/p", label: "e2e", command: "x", intervalSec: 10 },
    ]);
    expect(parseProgressWatchers("not json")).toEqual([]);
    expect(parseProgressWatchers(null)).toEqual([]);
  });
});

describe("parseProgressOutput", () => {
  test("reads a progress/v1 object from the last line", () => {
    const line = JSON.stringify({
      schema: "progress/v1",
      label: "VM suite",
      active: true,
      phase: "test",
      phases: ["up", "test", "down"],
      targets: ["ubuntu-zfs"],
      counts: { passed: 3, failed: 1, skipped: 0, errors: 0, total: 10 },
      current: "tests/test_a.py::test_b",
      failures: [{ name: "tests/test_a.py::test_c", message: "AssertionError" }, { bad: 1 }],
      artifacts: [{ label: "junit", path: "/x/last-run.xml" }],
    });
    const r = parseProgressOutput(`noise\n${line}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.runLabel).toBe("VM suite");
    expect(r.report.phase).toBe("test");
    expect(r.report.counts).toEqual({ passed: 3, failed: 1, skipped: 0, errors: 0, total: 10 });
    expect(r.report.failures).toEqual([{ name: "tests/test_a.py::test_c", message: "AssertionError" }]);
    expect(r.report.artifacts).toEqual([{ label: "junit", path: "/x/last-run.xml" }]);
    expect(r.report.last).toBeNull();
  });

  test("the empty idle object", () => {
    const r = parseProgressOutput('{"schema":"progress/v1","active":false,"phase":"idle"}');
    expect(r.ok && r.report.active === false && r.report.phase === "idle").toBe(true);
  });

  test("rejects non-JSON and objects without active", () => {
    expect(parseProgressOutput("usage: plab ...").ok).toBe(false);
    expect(parseProgressOutput('{"phase":"up"}').ok).toBe(false);
    expect(parseProgressOutput("").ok).toBe(false);
  });
});

const task = (over: Partial<Task>): Task =>
  ({ id: "t", workdir: "/p", column: "running", archivedAt: null, pipelineParentId: null, worktreePath: "/wt/t", isolation: "worktree", ...over }) as unknown as Task;

describe("probeTargets", () => {
  const w: ProgressWatcherConfig = { project: "/p/", label: "lab", command: "x" };
  test("running top-level cards of the project with a checkout", () => {
    const list = [
      task({ id: "a" }),
      task({ id: "b", column: "review" }),
      task({ id: "c", pipelineParentId: "a" }),
      task({ id: "d", workdir: "/other" }),
      task({ id: "e", archivedAt: 1 as never }),
      task({ id: "f", worktreePath: null, isolation: "none" }),
      task({ id: "g", worktreePath: null }),
    ];
    expect(probeTargets(w, list).map((x) => [x.task.id, x.checkout])).toEqual([
      ["a", "/wt/t"],
      ["f", "/p"],
    ]);
  });
});

describe("progressMilestones", () => {
  const base: TaskProgressReport = {
    active: false, phase: "idle", phases: null, runLabel: "VM suite", targets: null, startedAt: null,
    phaseStartedAt: null, counts: null, current: null, failures: [], artifacts: [], last: null,
  };
  test("phase starts and a finished run", () => {
    const up = { ...base, active: true, phase: "up", targets: ["a", "b"] };
    expect(progressMilestones("lab", base, up)).toEqual([{ text: "VM suite: up (a, b)", tone: "info" }]);
    const test1 = { ...up, phase: "test" };
    expect(progressMilestones("lab", up, test1)).toEqual([{ text: "VM suite: test", tone: "info" }]);
    expect(progressMilestones("lab", test1, test1)).toEqual([]);
    const done = {
      ...base,
      last: { finishedAt: "2026-10-04T12:00:00Z", result: "failed" as const, counts: { passed: 8, failed: 2, skipped: 1, errors: 0, total: 11 } },
    };
    expect(progressMilestones("lab", test1, done)).toEqual([
      { text: "VM suite failed — 8 passed, 2 failed, 1 skipped", tone: "danger" },
    ]);
  });
  test("never replays an old result on first sight", () => {
    const done = { ...base, last: { finishedAt: "x", result: "passed" as const, counts: null } };
    expect(progressMilestones("lab", undefined, done)).toEqual([]);
  });
});
