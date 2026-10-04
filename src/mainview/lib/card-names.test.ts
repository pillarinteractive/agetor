import { expect, test } from "bun:test";
import { blockerColor, shortCardName, splitCardTitle } from "./card-names.ts";

test("short names: the issue number, else the first words", () => {
  expect(shortCardName("Issue #214: rollupInvariants.test.ts beforeAll times out")).toBe("#214");
  expect(shortCardName("Issue #172: [review] Public-route patterns")).toBe("#172");
  expect(shortCardName("VM tests: run, fix, expand coverage")).toBe("VM tests: run,…");
  expect(shortCardName("Provision pillar-ci-pr runner VM on Unraid (rollout for PR #203)")).toBe("Provision…");
  // No issue in the title: its issue link, then its PR.
  expect(shortCardName("Provision runner", { issueUrl: "https://github.com/o/r/issues/77" })).toBe("#77");
  expect(shortCardName("Provision pillar-ci-pr runner", { prNumber: 210 })).toBe("PR #210");
  expect(shortCardName("Docs")).toBe("Docs");
  expect(splitCardTitle("Issue #182: [review] Public pages")).toEqual({ issue: "182", text: "Public pages" });
});

test("a blocker's color is stable for its id", () => {
  expect(blockerColor("8927cf40-a7bc")).toBe(blockerColor("8927cf40-a7bc"));
});
