import { expect, test } from "bun:test";
import {
  closeOutReviewNote, dueForCloseOut, findingId, markClosed, missingClassSearch, mustNotApprovePast, openFindings,
  recordReview, repeatedOpen, sanitizeFindingLedger, buildFindingsNote, reviewFindingsNote,
} from "./finding-ledger.ts";

test("finding IDs as Review writes them", () => {
  expect(findingId("823-R3: Complete-output byte accounting resets")).toBe("823-R3");
  expect(findingId("ARC08-R15 — Mandatory predecessor invariant")).toBe("ARC08-R15");
  expect(findingId("**OPS01-R6**: .gitleaks.toml:20 suppresses")).toBe("OPS01-R6");
  expect(findingId("R1153-04: Mandatory creator browser coverage")).toBe("R1153-04");
  expect(findingId("e893-r5: negative values")).toBe("E893-R5");
  expect(findingId("The tests do not cover the reset path")).toBeNull();
  expect(findingId("Note: something")).toBeNull();
});

test("a finding counts a repeat each time Review raises it again, and resolves when it stops", () => {
  let l = recordReview(undefined, 3, ["823-R3: budget resets", "823-R9: cap resets"]);
  expect(openFindings(l).map(([id]) => id)).toEqual(["823-R3", "823-R9"]);
  l = recordReview(l, 5, ["823-R3: envelope excluded"]);
  expect(l["823-R3"]).toMatchObject({ repeat: 1, raised: [3, 5], state: "open", text: "823-R3: envelope excluded" });
  expect(l["823-R9"]!.state).toBe("resolved");
  expect(repeatedOpen(l).map(([id]) => id)).toEqual(["823-R3"]);
  // The same settle read twice doesn't count twice.
  expect(recordReview(l, 5, ["823-R3: again"])["823-R3"]!.repeat).toBe(1);
  l = recordReview(l, 7, ["823-R3: suppressed results"]);
  expect(dueForCloseOut(l).map(([id]) => id)).toEqual(["823-R3"]);
  expect(repeatedOpen(l)).toEqual([]);
  l = markClosed(l, "823-R3", { number: 1700, url: "u" });
  // Closed stays closed, and approval resolves the rest.
  l = recordReview(l, 9, ["823-R3: still"]);
  expect(l["823-R3"]).toMatchObject({ state: "closed", repeat: 2, issue: { number: 1700 } });
  expect(openFindings(recordReview(l, 11, []))).toEqual([]);
});

test("a resolved finding raised again reopens with its count kept", () => {
  let l = recordReview(undefined, 1, ["X-1: a"]);
  l = recordReview(l, 3, []);
  l = recordReview(l, 5, ["X-1: back"]);
  expect(l["X-1"]).toMatchObject({ state: "open", repeat: 1 });
});

test("the Class search gate wants a command and at least one hit per open ID", () => {
  const text = [
    "Fixed both.",
    "Class search:",
    "- 823-R3: rg -n 'WindowBytes' packages/core-go → 4 hits, all fixed",
    "- 823-R9: ast-grep --pattern 'cap($$$)' → 1 hit (single site)",
  ].join("\n");
  expect(missingClassSearch(text, ["823-R3", "823-R9"])).toEqual([]);
  expect(missingClassSearch(text, ["823-R3", "OPS01-R6"])).toEqual(["OPS01-R6"]);
  expect(missingClassSearch("Class search:\n- 823-R3: rg -n x → 0 hits", ["823-R3"])).toEqual(["823-R3"]);
  expect(missingClassSearch("Class search:\n- 823-R3: looked around, 3 hits", ["823-R3"])).toEqual(["823-R3"]); // no command
  expect(missingClassSearch("no section", ["823-R3"])).toEqual(["823-R3"]);
});

test("mandatory, security, privacy and data-loss findings are never approved past", () => {
  expect(mustNotApprovePast("ARC08-R15 — Mandatory predecessor invariant")).toBe(true);
  expect(mustNotApprovePast("R9: tenant isolation bypass")).toBe(true);
  expect(mustNotApprovePast("823-R3: byte accounting resets between callbacks")).toBe(false);
});

test("notes name the open findings, the escalation and what left the card", () => {
  let l = recordReview(undefined, 3, ["823-R3: budget"]);
  l = recordReview(l, 5, ["823-R3: envelope"]);
  const b = buildFindingsNote(l, true)!;
  expect(b).toContain("escalation profile");
  expect(b).toContain("823-R3");
  expect(b).toContain("Class search:");
  l = markClosed(recordReview(l, 7, ["823-R3: x"]), "823-R3", { number: 1700, url: "u" });
  expect(buildFindingsNote(l, false)).toContain("823-R3 has left this card as #1700");
  expect(reviewFindingsNote(l)).toContain("closed out as follow-up #1700");
  expect(closeOutReviewNote([{ id: "823-R3", text: "x", issue: { number: 1700 } }])).toContain("`Refs`");
  expect(buildFindingsNote(undefined, false)).toBeNull();
});

test("the ledger survives a reload and drops what it can't read", () => {
  const l = markClosed(recordReview(undefined, 1, ["A-1: x", "B-2: y"]), "A-1", { number: 5, url: "u" });
  expect(sanitizeFindingLedger(JSON.parse(JSON.stringify(l)))).toEqual(l);
  expect(sanitizeFindingLedger({ "A-1": { text: 1 } })).toBeUndefined();
  expect(sanitizeFindingLedger([])).toBeUndefined();
});
