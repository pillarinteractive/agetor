import { expect, test } from "bun:test";
import { landingQuery, parseLandingResponse, parseStatesResponse, statesQuery } from "./roadmap-fetch.ts";

test("statesQuery aliases one issue field per number", () => {
  const q = statesQuery([12, 345]);
  expect(q).toContain("i12: issue(number: 12) { number title body updatedAt state stateReason closedAt url milestone { number title } labels(first: 30) { nodes { name } } }");
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

test("parseStatesResponse reads an issue's label names", () => {
  const out = parseStatesResponse(JSON.stringify({ data: { repository: {
    i7: { number: 7, state: "OPEN", stateReason: null, labels: { nodes: [{ name: "manual" }, { name: "area:web" }] } },
    i8: { number: 8, state: "OPEN", stateReason: null },
  } } }))!;
  expect(out.get(7)!.labels).toEqual(["manual", "area:web"]);
  expect(out.get(8)!.labels).toBeUndefined();
});

test("landings: a closed-as-completed issue or a merged PR has landed; open and closed-otherwise have not", () => {
  expect(landingQuery([7, 8])).toContain("r7: issueOrPullRequest(number: 7)");
  const out = parseLandingResponse(JSON.stringify({ data: { repository: {
    r1: { __typename: "Issue", number: 1, state: "OPEN", stateReason: null },
    r2: { __typename: "Issue", number: 2, state: "CLOSED", stateReason: "COMPLETED" },
    r3: { __typename: "Issue", number: 3, state: "CLOSED", stateReason: "NOT_PLANNED" },
    r4: { __typename: "PullRequest", number: 4, state: "MERGED", merged: true },
    r5: { __typename: "PullRequest", number: 5, state: "CLOSED", merged: false },
    r6: { __typename: "PullRequest", number: 6, state: "OPEN", merged: false },
    r7: null,
  } } }))!;
  expect(Object.fromEntries(out)).toEqual({ 1: "open", 2: "landed", 3: "unlanded", 4: "landed", 5: "unlanded", 6: "open" });
  expect(parseLandingResponse("gh: not logged in")).toBeNull();
});
