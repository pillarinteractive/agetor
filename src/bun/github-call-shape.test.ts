import { expect, test } from "bun:test";
import { githubCallShape } from "./github.ts";

test("githubCallShape groups calls by endpoint, not by repository, number or commit", () => {
  expect(githubCallShape("https://api.github.com/repos/o/r/pulls/12/reviews?per_page=100")).toBe("/repos/:o/:r/pulls/:n/reviews");
  expect(githubCallShape("https://api.github.com/repos/o/r/commits/0123456789abcdef0123456789abcdef01234567/check-runs")).toBe("/repos/:o/:r/commits/…");
  expect(githubCallShape("https://api.github.com/repos/o/r/compare/develop...feature/x")).toBe("/repos/:o/:r/compare/…");
  expect(githubCallShape("https://api.github.com/graphql")).toBe("/graphql");
});
