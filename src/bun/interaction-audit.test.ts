import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level, before db.ts is first imported (see interactions.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-int-audit-"));

const { dismissalNote, promptExcerpt, recordPromptDismissal } = await import("./interaction-audit.ts");
const { dataDir } = await import("./db.ts");
const timeline = (id: string): { text: string; tone: string }[] => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; tone: string }) : [];
};

// The #944 pane: a finished turn with an unsent draft in the composer, once read as a prompt.
const PANE_944 = ["✻ Worked for 12s", "", "────────────────────────────", "❯ fix the inventory role and commit", "────────────────────────────"].join("\n");

test("a dismissal says what the prompt showed and why it was dismissed", () => {
  const note = dismissalNote({ paneText: PANE_944, unparsable: true, choices: [] },
    "idle-composer false positive: the pane holds a completed handoff and an ordinary draft, no choices or permission modal");
  expect(note).toStartWith("Prompt dismissed without an answer — an unrecognised prompt (no choices could be read).");
  expect(note).toContain("❯ fix the inventory role and commit");
  expect(note).toContain("Reason: idle-composer false positive: the pane holds a completed handoff");
});

test("a dismissal with no reason is still recorded, and says so", () => {
  const note = dismissalNote({ paneText: "Do you trust this folder?\n❯ 1. Yes\n  2. No", unparsable: false, choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }] }, "   ");
  expect(note).toContain("a prompt with 2 choices");
  expect(note).toContain('It showed: "Do you trust this folder? ⏎ ❯ 1. Yes ⏎ 2. No"');
  expect(note).toEndWith("Reason: no reason given");
});

test("the excerpt is the end of the pane, bounded", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n");
  const excerpt = promptExcerpt(long);
  expect(excerpt.length).toBeLessThanOrEqual(601);
  expect(excerpt).toContain("line 39");
  expect(excerpt).not.toContain("line 3 ");
  expect(promptExcerpt("\n \n")).toBe("");
});

test("it is written on the card the owner sees: a step's prompt goes on its pipeline parent", () => {
  recordPromptDismissal({ taskId: "step-1", pipelineParentId: "parent-1", paneText: PANE_944, unparsable: true, choices: [] }, "idle composer, nothing was asked");
  recordPromptDismissal({ taskId: "plain-1", paneText: PANE_944, unparsable: true, choices: [] }, null);
  expect(timeline("step-1")).toEqual([]);
  const parent = timeline("parent-1");
  expect(parent).toHaveLength(1);
  expect(parent[0]!.text).toContain("Reason: idle composer, nothing was asked");
  expect(parent[0]!.tone).toBe("muted");
  // No reason given stands out.
  expect(timeline("plain-1")[0]!.tone).toBe("warning");
});
