import { describe, expect, test } from "bun:test";
import type { BoardDigest, DigestCard } from "./board-digest.ts";
import { boardUpdateMessage, conductorInstructions, diffSnapshots, parseConductorConfig, snapshot } from "./conductor.ts";

const card = (over: Partial<DigestCard>): DigestCard => ({
  id: "aaaaaaaa-1", title: "Fix CI", column: "running", project: "/p", branch: "b", pipeline: { status: "running", steps: 2 },
  status: "Build is working", tone: "info", needsYou: null, pr: null, prUrl: null, leases: [], progress: [], updated: "1m",
  ...over,
});
const digest = (cards: DigestCard[], suggestions: BoardDigest["suggestions"] = []): BoardDigest => ({
  generatedAt: 0, cards, suggestions, leases: [],
});

describe("parseConductorConfig", () => {
  test("defaults, overrides and floors", () => {
    expect(parseConductorConfig(null)).toEqual({ agent: "claude-code", model: null, mode: "auto", watch: true, minIntervalMin: 5, maxPerHour: 6 });
    expect(parseConductorConfig('{"model":"sonnet-5.5","watch":false,"minIntervalMin":0}')).toMatchObject({ model: "sonnet-5.5", watch: false, minIntervalMin: 1 });
    expect(parseConductorConfig("garbage").agent).toBe("claude-code");
  });
});

describe("snapshot diffs", () => {
  test("nothing changed — live status wording and ages don't count", () => {
    const a = snapshot(digest([card({})]), new Map());
    const b = snapshot(digest([card({ status: "Build is working (12m)", updated: "12m", progress: ["lab: test 5/10"] })]), new Map());
    expect(diffSnapshots(a, b)).toEqual([]);
  });

  test("a card blocks and needs the user", () => {
    const a = snapshot(digest([card({})]), new Map());
    const b = snapshot(digest([card({ column: "blocked", pipeline: { status: "blocked", steps: 2 }, needsYou: "Build blocked → Open" })]), new Map());
    expect(diffSnapshots(a, b)).toEqual([
      '- "Fix CI" [aaaaaaaa]: column: running → blocked; needs you: — → Build blocked → Open; pipeline: running → blocked',
    ]);
  });

  test("a lab run finishing, a new card, a new suggestion, a card leaving", () => {
    const gone = card({ id: "bbbbbbbb-2", title: "Old" });
    const a = snapshot(digest([card({}), gone]), new Map());
    const b = snapshot(
      digest([card({}), card({ id: "cccccccc-3", title: "New", column: "ready" })], [
        { id: "retry-lease", taskId: "aaaaaaaa-1", taskTitle: "Fix CI", title: "Retry", detail: "the lab is free" },
      ]),
      new Map([["aaaaaaaa-1", "lab failed (t)"]]),
    );
    expect(diffSnapshots(a, b)).toEqual([
      '- "Fix CI" [aaaaaaaa]: lab/E2E run: — → lab failed (t)',
      '- New card "New" [cccccccc] in ready',
      '- New suggestion for "Fix CI": Retry — the lab is free',
      '- "Old" left the board (archived or deleted)',
    ]);
  });
});

test("the update message says it isn't from the user", () => {
  const m = boardUpdateMessage(["- x"], "## running (1)");
  expect(m.startsWith("[Automatic board update — not from the user]")).toBe(true);
  expect(m).toContain("Don't act on this by yourself.");
});

test("instructions carry the pinned CLI and the user's rules", () => {
  const text = conductorInstructions("Never touch gc-1 directly.");
  expect(text).toContain("--no-daemon board");
  expect(text).toContain("## The user's standing rules\n\nNever touch gc-1 directly.");
  expect(conductorInstructions(null)).not.toContain("standing rules");
});
