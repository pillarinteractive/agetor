import { describe, expect, test } from "bun:test";
import { prBadge } from "./prs.ts";
import type { TaskPrStatus } from "../../shared/types.ts";

const pr = (o: Partial<TaskPrStatus> = {}): TaskPrStatus => ({
  taskId: "t", number: 7, url: "u", state: "open", draft: false, checks: "success", failingChecks: [], unresolvedThreads: 0, checkedAt: 0, ...o,
});

describe("prBadge", () => {
  test("states map to text and tone", () => {
    expect(prBadge(pr())).toMatchObject({ text: "PR #7 ✓", tone: "success" });
    expect(prBadge(pr({ checks: "pending" }))).toMatchObject({ text: "PR #7 …", tone: "warning" });
    expect(prBadge(pr({ checks: "failure", failingChecks: [{ name: "lint", url: null }] }))).toMatchObject({ text: "PR #7 ✗ CI", tone: "danger", title: "CI failing: lint" });
    expect(prBadge(pr({ unresolvedThreads: 2 }))).toMatchObject({ text: "PR #7 ✓ · 2 💬", tone: "warning" });
    expect(prBadge(pr({ state: "merged" }))).toMatchObject({ text: "PR #7 merged", tone: "merged" });
    expect(prBadge(pr({ state: "closed" }))).toMatchObject({ text: "PR #7 closed", tone: "muted" });
  });
});
