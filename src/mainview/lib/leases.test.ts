import { describe, expect, test } from "bun:test";
import { leaseInfoForTask } from "./leases.ts";
import type { LeaseStatus, Task } from "../../shared/types.ts";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    prompt: "",
    column: "running",
    agent: "claude-code",
    workdir: "/repo",
    isolation: "worktree",
    ...overrides,
  } as Task;
}

function makeLease(overrides: Partial<LeaseStatus> = {}): LeaseStatus {
  return {
    project: "/repo",
    label: "lab",
    held: false,
    holderTaskId: null,
    holderTitle: null,
    checkout: null,
    owner: null,
    since: null,
    checkedAt: 0,
    error: null,
    ...overrides,
  };
}

const queued = (...ids: string[]) => ids.map((taskId, i) => ({ taskId, title: taskId, since: i }));

describe("leaseInfoForTask", () => {
  test("the holder gets a badge per lease it holds", () => {
    const leases = [
      makeLease({ held: true, holderTaskId: "task-1", holderTitle: "Task" }),
      makeLease({ label: "rig", held: true, holderTaskId: "task-2" }),
    ];
    expect(leaseInfoForTask(makeTask(), leases).holds).toEqual(["lab"]);
  });

  test("a queued blocked card hears who holds the lease and its place in line", () => {
    const leases = [makeLease({ held: true, holderTaskId: "task-2", holderTitle: "E2E", queue: queued("task-3", "task-1") })];
    const info = leaseInfoForTask(makeTask({ column: "blocked" }), leases);
    expect(info.holds).toEqual([]);
    expect(info.waiting).toEqual([{ label: "lab", heldBy: "E2E", free: false, position: 2, queueLength: 2 }]);
  });

  test("a queued card is told when the lease is free", () => {
    const info = leaseInfoForTask(makeTask({ column: "blocked" }), [makeLease({ queue: queued("task-1") })]);
    expect(info.waiting).toEqual([{ label: "lab", heldBy: null, free: true, position: 1, queueLength: 1 }]);
  });

  test("a blocked card that isn't waiting on the lease gets no lease hint, even when it's busy", () => {
    const leases = [makeLease({ held: true, holderTaskId: "task-2", holderTitle: "VM tests", queue: [] })];
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), leases).waiting).toEqual([]);
  });

  test("a holder outside Agetor is named by its owner string", () => {
    const leases = [makeLease({ held: true, owner: "me@host:/elsewhere pid=1 since=x", queue: queued("task-1") })];
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), leases).waiting[0]!.heldBy).toBe(
      "me@host:/elsewhere pid=1 since=x",
    );
  });

  test("a failing probe that never saw a holder doesn't claim the lease is free", () => {
    const failing = makeLease({ error: "exited 1: usage", queue: queued("task-1") });
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), [failing]).waiting).toEqual([]);
    const stale = makeLease({ error: "timeout", held: true, holderTaskId: "task-2", holderTitle: "E2E", queue: queued("task-1") });
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), [stale]).waiting).toEqual([
      { label: "lab", heldBy: "E2E", free: false, position: 1, queueLength: 1 },
    ]);
  });

  test("no hint outside Blocked or on the holder itself", () => {
    const held = makeLease({ held: true, holderTaskId: "task-2", queue: queued("task-1") });
    expect(leaseInfoForTask(makeTask({ column: "review" }), [held]).waiting).toEqual([]);
    const mine = makeLease({ held: true, holderTaskId: "task-1", queue: queued("task-1") });
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), [mine]).waiting).toEqual([]);
  });
});
