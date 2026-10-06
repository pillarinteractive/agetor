import { expect, test } from "bun:test";
import { acceptPicks, auditPrompt, nextPrompt, parseConfig } from "./autopilot.ts";
import { taggedJson } from "./codex-thread.ts";

test("parseConfig: defaults to off, 5 in flight, clamps to 10", () => {
  expect(parseConfig(null)).toMatchObject({ enabled: false, maxInFlight: 5, milestone: null });
  expect(parseConfig(JSON.stringify({ enabled: true, maxInFlight: 40, milestone: { number: 2, title: "1.0 / 2" } }))).toMatchObject({
    enabled: true,
    maxInFlight: 10,
    milestone: { number: 2, title: "1.0 / 2" },
  });
});

test("taggedJson reads the block the thread ends with", () => {
  const text = 'Thinking…\n<next-issues>[{"number": 12, "scope": "- do x"}]</next-issues>';
  expect(taggedJson<unknown>(text, "next-issues")).toEqual([{ number: 12, scope: "- do x" }]);
  expect(taggedJson<unknown>("no block", "next-issues")).toBeNull();
  expect(taggedJson<unknown>("<audit>{not json}</audit>", "audit")).toBeNull();
});

test("acceptPicks keeps open, unworked, unique picks within the free slots", () => {
  const open = new Set([1, 2, 3, 4]);
  const busy = new Set([2]);
  const picks = [{ number: 2, scope: "busy" }, { number: 9, scope: "closed" }, { number: 1, scope: "a" }, { number: 1, scope: "dup" }, { number: 3, scope: "b" }, { number: 4, scope: "c" }];
  expect(acceptPicks(picks, open, busy, 2)).toEqual([{ number: 1, scope: "a" }, { number: 3, scope: "b" }]);
  expect(acceptPicks("nope", open, busy, 2)).toEqual([]);
});

test("prompts ask for the machine-readable block and name the milestone", () => {
  const p = nextPrompt("1.0 / 2", [{ number: 5, title: "x" }], [], 3);
  expect(p).toContain('"1.0 / 2"');
  expect(p).toContain("#5 x");
  expect(p).toContain("<next-issues>");
  expect(auditPrompt("1.0 / 2")).toContain("<audit>");
});
