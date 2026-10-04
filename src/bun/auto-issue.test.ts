import { expect, test } from "bun:test";
import { issueBody, needsIssue } from "./auto-issue.ts";

const card = (o: Record<string, unknown> = {}) => ({ id: "t", title: "Provision runner VM", issueUrl: null, pipelineParentId: null, archivedAt: null, ...o }) as never;

test("a card needs an issue unless it has one, is a step, archived, or the Conductor", () => {
  expect(needsIssue(card(), null)).toBe(true);
  expect(needsIssue(card({ issueUrl: "https://github.com/o/r/issues/1" }), null)).toBe(false);
  expect(needsIssue(card({ title: "Issue #214: slow test" }), null)).toBe(false);
  expect(needsIssue(card({ pipelineParentId: "p" }), null)).toBe(false);
  expect(needsIssue(card({ archivedAt: 1 }), null)).toBe(false);
  expect(needsIssue(card(), "t")).toBe(false);
});

test("the issue body is the card's prompt, marked as Agetor's, clipped when huge", () => {
  expect(issueBody({ prompt: "Do the thing." })).toBe("Do the thing.\n\n---\n_Opened by Agetor for a board card._");
  expect(issueBody({ prompt: "" })).toContain("_(no description)_");
  expect(issueBody({ prompt: "x".repeat(70_000) })).toContain("…(truncated)");
});
