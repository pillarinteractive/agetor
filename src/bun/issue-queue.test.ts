import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-issue-queue-"));
const { fixesLine, taskForIssue } = await import("./issue-queue.ts");

const url = "https://github.com/o/r/issues/12";
const task = (o: Partial<Task>) => ({ id: "t", title: "T", issueUrl: url, archivedAt: null, pipelineParentId: null, createdAt: 1, ...o }) as Task;

describe("taskForIssue", () => {
  test("the newest live board card for that issue; archived cards and step rows don't count", () => {
    const list = [
      task({ id: "old", createdAt: 1 }),
      task({ id: "new", createdAt: 5 }),
      task({ id: "archived", createdAt: 9, archivedAt: 10 }),
      task({ id: "step", createdAt: 9, pipelineParentId: "new" }),
      task({ id: "other", createdAt: 9, issueUrl: "https://github.com/o/r/issues/13" }),
    ];
    expect(taskForIssue(url, list)?.id).toBe("new");
    expect(taskForIssue("https://github.com/o/r/issues/99", list)).toBeNull();
  });
});

test("fixesLine asks the PR to close the issue", () => {
  expect(fixesLine(12)).toContain('"Fixes #12"');
});
