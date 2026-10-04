import { describe, expect, test } from "bun:test";
import { readableHandoffText } from "./handoff-format.ts";

describe("readableHandoffText", () => {
  test("breaks a one-paragraph summary at its numbered points and caps labels", () => {
    const text =
      "Merged both reviews. RANKED: (1) MEDIUM: demo endpoints are shared. (2) LOW: IPv6 ranges missing. " +
      "SIMPLIFICATIONS THAT HELP TESTING: per-visitor state.";
    expect(readableHandoffText(text)).toBe(
      "Merged both reviews.\n\n**RANKED:**\n\n(1) MEDIUM: demo endpoints are shared.\n\n(2) LOW: IPv6 ranges missing.\n\n" +
        "**SIMPLIFICATIONS THAT HELP TESTING:** per-visitor state.",
    );
  });

  test("leaves text that already has line breaks alone", () => {
    const md = "- one (1) thing\n- RANKED: two (2) things";
    expect(readableHandoffText(md)).toBe(md);
  });

  test("a single parenthesised number or short caps word isn't treated as structure", () => {
    expect(readableHandoffText("Fixed it in step (1) only. OK: done")).toBe("Fixed it in step (1) only. OK: done");
  });
});
