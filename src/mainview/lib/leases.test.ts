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

describe("leaseInfoForTask", () => {
  test("the holder gets a badge per lease it holds", () => {
    const leases = [
      makeLease({ held: true, holderTaskId: "task-1", holderTitle: "Task" }),
      makeLease({ label: "rig", held: true, holderTaskId: "task-2" }),
    ];
    expect(leaseInfoForTask(makeTask(), leases).holds).toEqual(["lab"]);
  });

  test("a blocked card in the same project hears who holds the lease", () => {
    const leases = [makeLease({ held: true, holderTaskId: "task-2", holderTitle: "E2E" })];
    const info = leaseInfoForTask(makeTask({ column: "blocked", workdir: "/repo/" }), leases);
    expect(info.holds).toEqual([]);
    expect(info.waiting).toEqual([{ label: "lab", heldBy: "E2E", free: false }]);
  });

  test("a blocked card is told when the lease is free", () => {
    const info = leaseInfoForTask(makeTask({ column: "blocked" }), [makeLease()]);
    expect(info.waiting).toEqual([{ label: "lab", heldBy: null, free: true }]);
  });

  test("a holder outside Agetor is named by its owner string", () => {
    const leases = [makeLease({ held: true, owner: "me@host:/elsewhere pid=1 since=x" })];
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), leases).waiting[0]!.heldBy).toBe(
      "me@host:/elsewhere pid=1 since=x",
    );
  });

  test("no hint outside Blocked, for other projects, or on the holder itself", () => {
    const held = makeLease({ held: true, holderTaskId: "task-2" });
    expect(leaseInfoForTask(makeTask({ column: "review" }), [held]).waiting).toEqual([]);
    expect(leaseInfoForTask(makeTask({ column: "blocked", workdir: "/other" }), [held]).waiting).toEqual([]);
    const mine = makeLease({ held: true, holderTaskId: "task-1" });
    expect(leaseInfoForTask(makeTask({ column: "blocked" }), [mine]).waiting).toEqual([]);
  });
});
