import { expect, test } from "bun:test";
import { blockerColor, shortCardName, splitCardTitle } from "./card-names.ts";

test("short names: the issue number, else the first words", () => {
  expect(shortCardName("Issue #214: rollupInvariants.test.ts beforeAll times out")).toBe("#214");
  expect(shortCardName("Issue #172: [review] Public-route patterns")).toBe("#172");
  expect(shortCardName("VM tests: run, fix, expand coverage")).toBe("VM tests: run, fix, exp…");
  expect(splitCardTitle("Issue #182: [review] Public pages")).toEqual({ issue: "182", text: "Public pages" });
});

test("a blocker's color is stable for its id", () => {
  expect(blockerColor("8927cf40-a7bc")).toBe(blockerColor("8927cf40-a7bc"));
});
