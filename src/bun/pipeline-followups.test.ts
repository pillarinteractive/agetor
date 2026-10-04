import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts (imported by the module) captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-followups-"));
const { globToRegExp, parseFollowUpPresets, suggestFollowUps } = await import("./pipeline-followups.ts");

describe("parseFollowUpPresets", () => {
  test("keeps valid presets, drops incomplete and duplicate ones", () => {
    const raw = JSON.stringify([
      { id: "pr", label: "Open PR", agent: "Finisher", prompt: "Open a PR" },
      { id: "vm", label: "Run VM tests", agent: "Codex Builder", prompt: "plab cycle", suggestWhen: ["apps/agent/**", 3] },
      { id: "explain", label: "Explain", agent: "Architect", prompt: "Answer", requiresRequest: true },
      { id: "pr", label: "dup", agent: "x", prompt: "y" },
      { id: "nolabel", agent: "x", prompt: "y" },
    ]);
    expect(parseFollowUpPresets(raw)).toEqual([
      { id: "pr", label: "Open PR", agent: "Finisher", prompt: "Open a PR", suggestWhen: undefined, requiresRequest: false },
      { id: "vm", label: "Run VM tests", agent: "Codex Builder", prompt: "plab cycle", suggestWhen: ["apps/agent/**"], requiresRequest: false },
      { id: "explain", label: "Explain", agent: "Architect", prompt: "Answer", suggestWhen: undefined, requiresRequest: true },
    ]);
    expect(parseFollowUpPresets("{")).toEqual([]);
  });
});

describe("globToRegExp", () => {
  test("** crosses directories, * doesn't, slash-less patterns match a file name anywhere", () => {
    expect(globToRegExp("apps/agent/**").test("apps/agent/internal/x.go")).toBe(true);
    expect(globToRegExp("apps/agent/**").test("apps/agents/x.go")).toBe(false);
    expect(globToRegExp("apps/*/go.mod").test("apps/agent/go.mod")).toBe(true);
    expect(globToRegExp("apps/*/go.mod").test("apps/a/b/go.mod")).toBe(false);
    expect(globToRegExp("lab/**/*.py").test("lab/vm/tests/test_x.py")).toBe(true);
    expect(globToRegExp("lab/**/*.py").test("lab/x.py")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a/README.md")).toBe(true);
    expect(globToRegExp("*.md").test("README.mdx")).toBe(false);
  });
});

describe("suggestFollowUps", () => {
  const presets = parseFollowUpPresets(JSON.stringify([
    { id: "vm", label: "Run VM tests", agent: "Codex Builder", prompt: "p", suggestWhen: ["apps/agent/**", "lab/vm/**"] },
    { id: "e2e", label: "Run E2E", agent: "Builder", prompt: "p", suggestWhen: ["apps/web/**"] },
    { id: "pr", label: "Open PR", agent: "Gone", prompt: "p" },
  ]));
  const ids: Record<string, string> = { "Codex Builder": "p1", Builder: "p2" };

  test("flags presets whose globs match the changed files, with a sample", () => {
    const out = suggestFollowUps(presets, ["apps/agent/a.go", "apps/agent/b.go", "lab/vm/plab", "apps/agent/c.go", "README.md"], (n) => ids[n] ?? null);
    expect(out.map((a) => [a.id, a.suggested, a.agentId])).toEqual([["vm", true, "p1"], ["e2e", false, "p2"], ["pr", false, null]]);
    expect(out[0]!.matched).toEqual(["apps/agent/a.go", "apps/agent/b.go", "lab/vm/plab"]);
  });

  test("docs-only change suggests nothing", () => {
    expect(suggestFollowUps(presets, ["docs/x.md"], (n) => ids[n] ?? null).some((a) => a.suggested)).toBe(false);
  });
});
