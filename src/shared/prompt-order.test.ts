import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeStepPrompt, orderStepPrompt, parseStepPromptOrder, promptCarriesGoal, stepPromptSections, type StepPromptExtras, type StepPromptTier,
} from "./pipeline.ts";
import { STEP_PROMPT_CASES, STEP_PROMPT_EXTRAS } from "./fixtures/step-prompt-cases.ts";

// Step prompts were reordered: what is the same for every card and visit
// first, what changes last. Nothing may be added, dropped or reworded. The
// proof has two halves:
//   1. `order: "legacy"` still gives, byte for byte, what the composer gave
//      before the reorder (`fixtures/step-prompt-legacy/`, generated from the
//      last commit with the old order), wrapped as the runner wrapped it;
//   2. `order: "static-first"` gives the same paragraphs — the same multiset
//      of blank-line-separated blocks — and the same sections, in another
//      order.

type Case = Parameters<typeof composeStepPrompt>[0];
const cases = Object.entries(STEP_PROMPT_CASES) as unknown as [string, Case][];
const extras = Object.entries(STEP_PROMPT_EXTRAS) as [string, StepPromptExtras][];
const golden = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "step-prompt-legacy", `${name}.txt`), "utf8");

/**
 * What `launchStep` did to the composed prompt before the reorder, copied
 * from it expression for expression:
 *   withWrapUp(withMachineCapacity(withSync(withRouting(withDecisions(withFeedback(prompt))))))
 * and then the input note.
 */
function wrappedAsBefore(prompt: string, x: StepPromptExtras): string {
  const withFeedback = (p: string) => (x.feedback ? `${p}\n\n${x.feedback}` : p);
  const withDecisions = (p: string) => (x.decisions ? `${p}\n\n${x.decisions}` : p);
  const withRouting = (p: string) => (x.routing ? `${p}\n\n${x.routing}` : p);
  const withSync = (p: string) => (x.syncNote ? `${x.syncNote}\n\n${p}` : p);
  const withMachineCapacity = (p: string) => (x.machineCapacity ? `${p}\n\n${x.machineCapacity}${x.approvalNote ? `\n\n${x.approvalNote}` : ""}` : p);
  const withWrapUp = (p: string) => (x.wrapUp ? `${p}\n\n${x.wrapUp}` : p);
  let composed = withWrapUp(withMachineCapacity(withSync(withRouting(withDecisions(withFeedback(prompt))))));
  if (x.inputNote) composed += `\n\n${x.inputNote}`;
  return composed;
}

const paragraphs = (prompt: string) => prompt.split("\n\n").sort();

describe("the legacy order is the order prompts had", () => {
  for (const [name, input] of cases) {
    test(`${name}: the composer's own text is byte for byte what it was`, () => {
      expect(composeStepPrompt({ ...input, order: "legacy" })).toBe(golden(name));
    });
    for (const [extraName, x] of extras) {
      test(`${name}, with ${extraName}: wrapped as the runner wrapped it`, () => {
        expect(composeStepPrompt({ ...input, extras: x, order: "legacy" })).toBe(wrappedAsBefore(golden(name), x));
      });
    }
  }
});

describe("static-first drops nothing and adds nothing", () => {
  for (const [name, input] of cases) {
    for (const [extraName, x] of extras) {
      test(`${name}, with ${extraName}: the same paragraphs and the same sections as before, reordered`, () => {
        const before = wrappedAsBefore(golden(name), x);
        const after = composeStepPrompt({ ...input, extras: x });
        expect(after.length).toBe(before.length);
        expect(paragraphs(after)).toEqual(paragraphs(before));
        // Whole sections moved; none was split or merged.
        const sections = stepPromptSections({ ...input, extras: x });
        expect(orderStepPrompt(sections, "legacy").map((s) => s.text).join("\n\n")).toBe(before);
        expect(orderStepPrompt(sections, "static-first").map((s) => s.text).join("\n\n")).toBe(after);
        expect(orderStepPrompt(sections, "static-first").map((s) => s.text).sort()).toEqual(sections.map((s) => s.text).sort());
        for (const s of sections) expect(after).toContain(s.text);
      });
    }
  }

  test("static-first is the default, and `legacy` is asked for by name", () => {
    const [, input] = cases[1]!;
    expect(composeStepPrompt(input)).toBe(composeStepPrompt({ ...input, order: "static-first" }));
    expect(composeStepPrompt(input)).not.toBe(composeStepPrompt({ ...input, order: "legacy" }));
    const orders: [string | null | undefined, string][] = [
      [null, "static-first"], [undefined, "static-first"], ["", "static-first"], ["static-first", "static-first"], ["nonsense", "static-first"],
      ["legacy", "legacy"], [" Legacy ", "legacy"], ['"legacy"', "legacy"],
    ];
    for (const [raw, want] of orders) expect(parseStepPromptOrder(raw)).toBe(want as never);
  });
});

describe("the static-first order", () => {
  const rank: Record<StepPromptTier, number> = { repo: 0, step: 1, card: 2, visit: 3 };
  const everything = { ...(cases.find(([name]) => name === "review-gated")![1]), extras: STEP_PROMPT_EXTRAS.everything, parallelSiblings: ["Docs"] };

  test("every section of a launch that has them all, in order", () => {
    expect(orderStepPrompt(stepPromptSections(everything), "legacy").map((s) => s.id)).toEqual([
      "sync", "title", "intro", "goal", "preload-card", "context", "preload-visit", "step-goal", "your-step", "checks", "parallel", "delegation",
      "economy", "handoff", "feedback", "decisions", "routing", "machine", "approval", "wrap-up", "input-note",
    ]);
    expect(orderStepPrompt(stepPromptSections(everything), "static-first").map((s) => s.id)).toEqual([
      "sync", "intro", "machine", "delegation", "handoff", "step-goal", "your-step", "checks", "approval", "decisions", "preload-card", "goal",
      "title", "context", "economy", "parallel", "preload-visit", "feedback", "routing", "wrap-up", "input-note",
    ]);
  });

  test("goes from what every step shares to what only this visit has — but for the two sections whose words name what is above or below them", () => {
    const ordered = orderStepPrompt(stepPromptSections(everything), "static-first");
    // `sync` says "as written below"; `economy` says "quoted above".
    const free = ordered.filter((s) => s.id !== "sync" && s.id !== "economy");
    const ranks = free.map((s) => rank[s.tier]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const at = (id: string) => ordered.findIndex((s) => s.id === id);
    expect(at("sync")).toBe(0);
    expect(at("economy")).toBeGreaterThan(at("context"));
    expect(at("checks")).toBe(at("your-step") + 1);
    expect(at("routing")).toBeGreaterThan(at("context"));
    expect(ordered.at(-2)!.id).toBe("wrap-up");
    expect(ordered.at(-1)!.id).toBe("input-note");
  });

  test("two visits of a step on two cards start with the same text, up to the first thing that is the card's", () => {
    const [, review] = cases.find(([name]) => name === "review-gated")!;
    const shared = STEP_PROMPT_EXTRAS["an unattended Pillar Review"];
    const one = composeStepPrompt({ ...review, extras: shared });
    const other = composeStepPrompt({
      ...review, stepIndex: 9, goal: "Issue #1031: another card.", nonce: "ffff0000", preload: { card: "## File map\n\nOTHER", visit: null },
      previous: [], extras: { ...shared, approvalNote: shared.approvalNote.replace("974", "1031"), decisions: shared.decisions.replace("card-1", "card-2") },
    });
    let same = 0;
    while (same < one.length && one[same] === other[same]) same++;
    const prefix = one.slice(0, same);
    for (const heading of ["## Machine test capacity", "## Delegation", "## Handoff (required)", "## Step goal", "## Your step", "## Checks this step must pass"]) expect(prefix).toContain(heading);
    expect(prefix).not.toContain("## Overall goal");
    // Before the reorder the two differed in their first line.
    const legacy = (input: Case) => composeStepPrompt({ ...input, order: "legacy" });
    expect(legacy({ ...review, extras: shared }).slice(0, 80)).not.toBe(legacy({ ...review, stepIndex: 9, extras: shared }).slice(0, 80));
  });

  test("the goal can still be read back out of a prompt, exactly, in either order — as position resolution reads Understand's", () => {
    for (const [, input] of cases) {
      for (const order of ["legacy", "static-first"] as const) {
        for (const [, x] of extras) {
          const prompt = composeStepPrompt({ ...input, order, extras: x });
          expect(promptCarriesGoal(prompt, input.goal)).toBe(true);
          // A goal that grew or shrank by a paragraph is another goal.
          expect(promptCarriesGoal(prompt, `${input.goal}\n\n## More`)).toBe(false);
          expect(promptCarriesGoal(prompt, input.goal.split("\n\n")[0]!) && input.goal.includes("\n\n")).toBe(false);
          expect(promptCarriesGoal(prompt, `${input.goal} `)).toBe(false);
        }
      }
    }
    // A goal with its own headings, one of which was later removed.
    const [, base] = cases[1]!;
    const before = composeStepPrompt({ ...base, goal: "Do A.\n\n## Acceptance\n\n- x" });
    expect(promptCarriesGoal(before, "Do A.")).toBe(false);
    expect(promptCarriesGoal(before, "Do A.\n\n## Acceptance\n\n- x")).toBe(true);
  });

  test("the step's instructions can still be found and swapped as a refresh swaps them", () => {
    for (const [, input] of cases) {
      const text = input.step.instructions.trim() ? input.step.instructions : "(no additional instructions)";
      if (text.includes("{{checks}}")) continue;
      for (const order of ["legacy", "static-first"] as const) {
        const prompt = composeStepPrompt({ ...input, order, extras: STEP_PROMPT_EXTRAS.everything });
        const needle = `\n\n## Your step\n\n${text}\n\n`;
        expect(prompt.indexOf(needle)).toBeGreaterThan(0);
        expect(prompt.indexOf(needle)).toBe(prompt.lastIndexOf(needle));
      }
    }
  });
});
