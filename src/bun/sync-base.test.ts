import { expect, test } from "bun:test";
import { parseSyncBaseRules, ruleFor, syncBaseSection } from "./sync-base.ts";

test("rules: parse, drop malformed, match project and step name case-insensitively", () => {
  const rules = parseSyncBaseRules(JSON.stringify([
    { project: "/repo/", branch: "develop", steps: ["Finish", "Open PR"] },
    { project: "/repo", branch: "develop" },
    "nope",
  ]));
  expect(rules).toEqual([{ project: "/repo/", branch: "develop", steps: ["Finish", "Open PR"] }]);
  expect(ruleFor(rules, "/repo", "finish")?.branch).toBe("develop");
  expect(ruleFor(rules, "/repo", "open pr")?.branch).toBe("develop");
  expect(ruleFor(rules, "/repo", "Build")).toBeNull();
  expect(ruleFor(rules, "/other", "Finish")).toBeNull();
  expect(parseSyncBaseRules("garbage")).toEqual([]);
});

test("the prompt section says how far behind, merges (never rebases), and what to do on conflicts", () => {
  const s = syncBaseSection("develop", 3);
  expect(s).toContain("`origin/develop` is 3 commits ahead");
  expect(s).toContain("git merge --no-edit origin/develop");
  expect(s).toContain("don't rebase");
  expect(s).toContain("git merge --abort");
  expect(syncBaseSection("develop", 1)).toContain("1 commit ahead");
});
