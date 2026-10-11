import { expect, test } from "bun:test";
import { parseStatesResponse, statesQuery } from "./roadmap-fetch.ts";

test("statesQuery aliases one issue field per number", () => {
  const q = statesQuery([12, 345]);
  expect(q).toContain("i12: issue(number: 12) { number state stateReason closedAt url milestone { number title } }");
  expect(q).toContain("i345: issue(number: 345)");
  expect(q).toContain("repository(owner: $owner, name: $name)");
});

test("parseStatesResponse keeps what resolved and leaves out what didn't", () => {
  const stdout = JSON.stringify({
    data: {
      repository: {
        i12: { number: 12, state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/o/r/issues/12" },
        i13: { number: 13, state: "CLOSED", stateReason: "NOT_PLANNED", url: "https://github.com/o/r/issues/13" },
        i14: { number: 14, state: "OPEN", stateReason: null, url: "https://github.com/o/r/issues/14" },
        i999: null,
      },
    },
    errors: [{ type: "NOT_FOUND", path: ["repository", "i999"] }],
  });
  const m = parseStatesResponse(stdout)!;
  expect([...m.keys()]).toEqual([12, 13, 14]);
  expect(m.get(12)).toEqual({ state: "CLOSED", stateReason: "COMPLETED", url: "https://github.com/o/r/issues/12" });
  expect(m.get(14)).toEqual({ state: "OPEN", stateReason: null, url: "https://github.com/o/r/issues/14" });
  expect(parseStatesResponse("gh: not logged in")).toBeNull();
  expect(parseStatesResponse('{"data":{"repository":null}}')).toBeNull();
});

test("parseStatesResponse reads each issue's milestone: its number, none, or not asked", () => {
  const m = parseStatesResponse(
    JSON.stringify({
      data: {
        repository: {
          i12: { number: 12, state: "OPEN", stateReason: null, url: "u12", milestone: { number: 7, title: "M01 — Widget foundations" } },
          i13: { number: 13, state: "OPEN", stateReason: null, url: "u13", milestone: null },
          i14: { number: 14, state: "OPEN", stateReason: null, url: "u14" },
        },
      },
    }),
  )!;
  expect(m.get(12)!.milestone).toEqual({ number: 7, title: "M01 — Widget foundations" });
  expect(m.get(13)!.milestone).toBeNull();
  expect("milestone" in m.get(14)!).toBe(false);
});
