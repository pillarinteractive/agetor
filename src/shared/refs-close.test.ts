import { describe, expect, test } from "bun:test";
import { classifyRefsVerdict, parseRefsClosePref, refsCloseMarker, releaseGateBody, releaseGateTitle, splitItems } from "./refs-close.ts";

const body = (verdict: string) => `## Summary\n\nDid the thing.\n\n${verdict}\n\n## Tests\n- ran them`;

describe("classifyRefsVerdict: today's real verdicts", () => {
  test("#892 keeps: runtime integration, emission and execution are engineering", () => {
    const v = classifyRefsVerdict(body("Refs #892 — issuer custody, approved keys, runtime integration/composition emission, native-store execution, and human/elapsed/physical qualification remain pending."), 892);
    expect(v.decision).toBe("keep");
    expect(v.items).toEqual(["issuer custody", "approved keys", "runtime integration/composition emission", "native-store execution", "human/elapsed/physical qualification"]);
    expect(v.engineering.map((e) => e.item)).toEqual(["runtime integration/composition emission", "native-store execution"]);
    expect(v.why).toContain("engineering");
  });

  test("#968 closes: approvals, measurements, invoices, a disposition and qualification receipts", () => {
    const v = classifyRefsVerdict(body("Refs #968 — actual #794 approval, #877 measurement, #802 invoices, #1168 claim disposition and named source/distribution/runtime/queue/backup/outage qualification receipts remain pending."), 968);
    expect(v.decision).toBe("close");
    expect(v.items).toEqual(["actual #794 approval", "#877 measurement", "#802 invoices", "#1168 claim disposition", "named source/distribution/runtime/queue/backup/outage qualification receipts"]);
    expect(v.engineering).toEqual([]);
    expect(v.unmatched).toEqual([]);
  });

  test("#1285 keeps: “acquisition-mode compatibility” is neither evidence nor approval, so it is in doubt", () => {
    const v = classifyRefsVerdict(body("Refs #1285 — human disposition, permitted host-reference evidence and acquisition-mode compatibility remain recorded gaps (#1447)."), 1285);
    expect(v.decision).toBe("keep");
    expect(v.items).toEqual(["human disposition", "permitted host-reference evidence", "acquisition-mode compatibility"]);
    expect(v.unmatched).toEqual(["acquisition-mode compatibility"]);
  });

  test("a bare “Refs #1281” keeps", () => {
    const v = classifyRefsVerdict(body("Refs #1281"), 1281);
    expect(v.decision).toBe("keep");
    expect(v.items).toEqual([]);
    expect(v.line).toBe("Refs #1281");
  });
});

describe("classifyRefsVerdict: doubt keeps", () => {
  test("no verdict line, another issue's verdict, a verdict in a comment", () => {
    expect(classifyRefsVerdict("Fixes #5", 12).decision).toBe("keep");
    expect(classifyRefsVerdict("Refs #120 — owner approval remains pending.", 12).decision).toBe("keep");
    expect(classifyRefsVerdict("<!-- Refs #12 — owner approval remains pending. -->", 12).decision).toBe("keep");
    expect(classifyRefsVerdict(null, 12).decision).toBe("keep");
  });

  test("an empty list after the dash keeps", () => {
    expect(classifyRefsVerdict("Refs #12 — remain pending.", 12).decision).toBe("keep");
  });

  test("a mixed list keeps, whatever order", () => {
    expect(classifyRefsVerdict("Refs #12 — owner approval and wiring the exporter remain pending.", 12).decision).toBe("keep");
    expect(classifyRefsVerdict("Refs #12: fix the parser, owner sign-off.", 12).decision).toBe("keep");
    expect(classifyRefsVerdict("Refs #12 — hardware receipts; the collector is not yet implemented", 12).decision).toBe("keep");
  });

  test("a “remain pending” phrase mid-list never cuts the rest of the list off", () => {
    const v = classifyRefsVerdict("Refs #12 — owner approval is pending, and migrating the store remain pending.", 12);
    expect(v.decision).toBe("keep");
    expect(v.engineering.map((e) => e.term)).toEqual(["migrate"]);
  });

  test("evidence-only with a colon and an owner/repo reference closes", () => {
    expect(classifyRefsVerdict("Refs o/r#12: owner sign-off and participant consent remain outstanding.", 12).decision).toBe("close");
  });
});

describe("classifyRefsVerdict: a verdict that points at the body's pending sentences", () => {
  test("takes the “remain pending” sentences as the list", () => {
    const v = classifyRefsVerdict("Refs #12 — see below.\n\n## Remaining\nOwner approval and host measurement remain pending. Everything else landed.", 12);
    expect(v.decision).toBe("close");
    expect(v.items).toEqual(["Owner approval", "host measurement"]);
  });

  test("keeps when the pointed-at sentences list engineering, or there are none", () => {
    expect(classifyRefsVerdict("Refs #12 — see below.\n\nThe emitter wiring remains pending.", 12).decision).toBe("keep");
    expect(classifyRefsVerdict("Refs #12 — see below.\n\nNothing else to say.", 12).decision).toBe("keep");
  });
});

test("splitItems: commas, semicolons, “and”, and issue references in brackets", () => {
  expect(splitItems("a, b; c and d, and e (#9).")).toEqual(["a", "b", "c", "d", "e"]);
});

test("parseRefsClosePref: default release-gate with label follow-up; off; JSON milestone and label", () => {
  expect(parseRefsClosePref(null)).toEqual({ mode: "release-gate", milestone: null, label: "follow-up" });
  expect(parseRefsClosePref("off").mode).toBe("off");
  expect(parseRefsClosePref('"off"').mode).toBe("off");
  expect(parseRefsClosePref('{"mode":"off"}').mode).toBe("off");
  expect(parseRefsClosePref('{"milestone":"H — Owner decisions","label":"release-gate"}')).toEqual({ mode: "release-gate", milestone: "H — Owner decisions", label: "release-gate" });
  expect(parseRefsClosePref('{"label":null}').label).toBeNull();
  expect(parseRefsClosePref("{nope").mode).toBe("release-gate");
});

test("follow-up texts carry the marker, the items verbatim and the release wording", () => {
  const verdict = classifyRefsVerdict("Refs #968 — #877 measurement and owner approval remain pending.", 968);
  const b = releaseGateBody({ issue: 968, pr: 70, prUrl: "https://github.com/o/r/pull/70", verdict });
  expect(b.startsWith(refsCloseMarker(968))).toBe(true);
  expect(b).toContain("- #877 measurement\n- owner approval");
  expect(b).toContain("Required before the main release; not a develop prerequisite. Reopen #968 if any item is engineering work.");
  expect(releaseGateTitle(968, "Qualify the queue")).toBe("Release gate: remaining qualification of #968 (Qualify the queue)");
});
