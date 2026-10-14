import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_FAILURE_MARKER, ciFailureForHandoff, ciFailureIndex, ciFailureReport, cleanCiLine, distillFailedLog, parseFailedLog, renderCiFailure,
  type CiRunMeta,
} from "./ci-failure.ts";

const TS = "2026-10-14T00:48:29.3248291Z ";
/** `count` log lines of one job and step, as `gh run view --log-failed` prints them. */
const log = (job: string, step: string, texts: string[]) => texts.map((t) => `${job}\t${step}\t${TS}${t}`).join("\n");
const filler = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `line ${from + i}`);
const meta: CiRunMeta = { runId: 77, url: "https://github.com/o/r/actions/runs/77", workflow: "ci", logPath: "/data/ci-failed-77.log" };

describe("CI_FAILURE_MARKER", () => {
  const cases: [string, boolean][] = [
    ["FAIL src/cart.test.ts", true],
    ["--- FAIL: TestCart (0.00s)", true],
    ["FAILED (failures=10, skipped=3)", true],
    ["Error: expected 1 to be 2", true],
    ["src/a.ts(3,4): error TS2322: Type 'string' is not assignable", true],
    ["panic: runtime error: index out of range", true],
    ["AssertionError: {} != {'a': 1}", true],
    ["  ✗ adds an item", true],
    ["  × adds an item 12ms", true],
    ["##[error]Process completed with exit code 1.", true],
    ["0 failed, 12 passed", false],
    ["checking error-handling paths", false],
    ["error TS without a number", false],
    ["ok  	pillar/agent/internal/collector	0.412s", false],
  ];
  for (const [line, want] of cases) test(`${want ? "matches" : "ignores"}: ${line}`, () => expect(CI_FAILURE_MARKER.test(line)).toBe(want));
});

describe("cleanCiLine", () => {
  const cases: [string, string, string][] = [
    ["a timestamp", `${TS}hello`, "hello"],
    ["a timestamp without fractions", "2026-10-14T00:48:29Z hello", "hello"],
    ["colour codes", "\x1b[36;1mecho hi\x1b[0m", "echo hi"],
    ["a byte-order mark before the timestamp", `﻿${TS}##[group]Run tests`, "##[group]Run tests"],
    ["an OSC sequence and stray control characters", "\x1b]0;title\x07a\x08b\x7f", "ab"],
    ["trailing blanks, keeping indentation and inner tabs", `${TS}  a\tb  \t`, "  a\tb"],
    ["a date inside the line is kept", "seen at 2026-10-14T00:48:29Z ok", "seen at 2026-10-14T00:48:29Z ok"],
  ];
  for (const [name, input, want] of cases) test(name, () => expect(cleanCiLine(input)).toBe(want));

  test("an over-long line is cut by characters and says how much is gone", () => {
    expect(cleanCiLine("x".repeat(450))).toBe(`${"x".repeat(400)} … [+50 chars]`);
    expect(cleanCiLine("é😀".repeat(3), 4)).toBe("é😀é😀 … [+2 chars]");
    expect(cleanCiLine("x".repeat(400))).toBe("x".repeat(400));
  });
});

test("parseFailedLog splits job, step and text; a line without the prefix has no job; empty lines go", () => {
  const raw = ["web / unit\tRun tests\ta\tb", "", "   ", "a saved tail line\r", "agent / go\tgo test\t"].join("\n");
  expect(parseFailedLog(raw)).toEqual([
    { job: "web / unit", step: "Run tests", text: "a\tb" },
    { job: "", step: "", text: "a saved tail line" },
    { job: "agent / go", step: "go test", text: "" },
  ]);
});

describe("distillFailedLog", () => {
  test("a failure line is kept with 20 lines either side, and what was left out is counted", () => {
    const [job] = distillFailedLog(log("web / unit", "Run tests", [...filler(50), "Error: boom", ...filler(50, 51)]));
    expect(job).toMatchObject({ job: "web / unit", step: "Run tests", exitCode: null, totalLines: 101, failureLines: 1, shownLines: 41, context: 20 });
    expect(job!.lines[0]).toBe("… 30 lines omitted …");
    expect(job!.lines[1]).toBe("line 31");
    expect(job!.lines[21]).toBe("Error: boom");
    expect(job!.lines.at(-2)).toBe("line 70");
    expect(job!.lines.at(-1)).toBe("… 30 lines omitted …");
  });

  test("windows that touch are one stretch; a gap between two says its size", () => {
    const [job] = distillFailedLog(log("j", "s", [...filler(5), "FAIL a", ...filler(60, 6), "FAIL b", ...filler(3, 66)]));
    expect(job!.lines.filter((l) => l.includes("omitted"))).toEqual(["… 20 lines omitted …"]);
    expect(job!.shownLines).toBe(5 + 1 + 20 + 20 + 1 + 3);
  });

  test("the exit line gives the exit code and the step, and nothing after it is context", () => {
    const raw = [
      log("web / unit", "Set up", filler(3)),
      log("web / unit", "Run tests", ["FAIL src/cart.test.ts", "##[error]Process completed with exit code 2."]),
      log("web / unit", "Post Run actions/checkout", filler(30, 100)),
    ].join("\n");
    const [job] = distillFailedLog(raw);
    expect(job).toMatchObject({ step: "Run tests", exitCode: 2, failureLines: 2, shownLines: 5 });
    expect(job!.lines).toEqual(["line 1", "line 2", "line 3", "FAIL src/cart.test.ts", "##[error]Process completed with exit code 2.", "… 30 lines omitted …"]);
  });

  test("a job with no failure line shows its last 60 lines", () => {
    const [job] = distillFailedLog(log("deploy", "Push", filler(200)));
    expect(job).toMatchObject({ context: null, failureLines: 0, shownLines: 60, step: "Push" });
    expect(job!.lines[0]).toBe("… 140 lines omitted …");
    expect(job!.lines.at(-1)).toBe("line 200");
  });

  test("each job gets its own excerpt, in the log's order, and one job's lines are never another's context", () => {
    const raw = [log("b job", "s", [...filler(4), "Error: one"]), log("a job", "t", ["panic: two", ...filler(4)])].join("\n");
    const jobs = distillFailedLog(raw);
    expect(jobs.map((j) => `${j.job}:${j.shownLines}`)).toEqual(["b job:5", "a job:5"]);
  });

  describe("the 150-line cap", () => {
    const cases: { name: string; lines: string[]; maxLines?: number; context: number | null; shown: number }[] = [
      { name: "fits at 20 lines of context", lines: [...filler(100), "FAIL x", ...filler(100)], context: 20, shown: 41 },
      // 8 failures 30 lines apart: 20 either side is 8×41 > 150, 10 either side is 8×21 = 168 > 150, 5 either side is 88.
      { name: "context shrinks until the excerpt fits", lines: Array.from({ length: 8 }, (_, i) => [...filler(30), `FAIL ${i}`]).flat(), context: 5, shown: 8 * 6 + 5 * 7 },
      { name: "failure lines alone when even 2 either side is too much", lines: Array.from({ length: 140 }, (_, i) => [...filler(9), `FAIL ${i}`]).flat(), context: 0, shown: 140 },
      { name: "a smaller cap is honoured", lines: [...filler(30), "FAIL x", ...filler(30)], maxLines: 12, context: 5, shown: 11 },
    ];
    for (const c of cases) {
      test(c.name, () => {
        const [job] = distillFailedLog(log("j", "s", c.lines), c.maxLines ? { maxLines: c.maxLines } : {});
        expect(job).toMatchObject({ context: c.context, shownLines: c.shown });
        expect(job!.shownLines).toBeLessThanOrEqual(c.maxLines ?? 150);
      });
    }

    test("more failure lines than the cap: the first third and the last two thirds of them", () => {
      const lines = Array.from({ length: 400 }, (_, i) => `FAIL ${i}`);
      const [job] = distillFailedLog(log("j", "s", lines));
      expect(job).toMatchObject({ context: 0, failureLines: 400, shownLines: 150 });
      expect(job!.lines.slice(0, 50)).toEqual(lines.slice(0, 50));
      expect(job!.lines[50]).toBe("… 250 lines omitted …");
      expect(job!.lines.slice(51)).toEqual(lines.slice(300));
    });
  });
});

describe("renderCiFailure and ciFailureReport", () => {
  const raw = [
    log("web / unit", "Run tests", [...filler(30), "Error: expected 1 to be 2", "##[error]Process completed with exit code 1."]),
    log("agent / go test", "go test", ["--- FAIL: TestCart (0.00s)", "FAIL"]),
  ].join("\n");

  test("names the run, the full log, and each job's workflow, job, step and exit code", () => {
    const text = renderCiFailure(meta, distillFailedLog(raw));
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Run 77: https://github.com/o/r/actions/runs/77",
      "Full log: /data/ci-failed-77.log (or `gh run view 77 --log-failed`)",
      '--- failed: ci / web / unit / step "Run tests" — exit code 1 ---',
      "(22 of 32 log lines: the 2 failure lines with up to 20 lines either side)",
    ]);
    expect(text).toContain('--- failed: ci / agent / go test / step "go test" — exit code not in the log ---');
    expect(text).not.toContain(TS.trim());
    expect(ciFailureIndex(meta, distillFailedLog(raw))).toBe('ci / web / unit (exit 1, step "Run tests"); ci / agent / go test (exit code not in the log, step "go test")');
  });

  test("a run that could not be described still says what is known", () => {
    const text = renderCiFailure({ runId: 5, url: null, workflow: null, logPath: null }, distillFailedLog("a saved tail\nError: x"));
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Run 5",
      "Full log: not saved (or `gh run view 5 --log-failed`)",
      "--- failed: (job not named in the log) — exit code not in the log ---",
      "(2 of 2 log lines: the 1 failure line with up to 20 lines either side)",
    ]);
    expect(renderCiFailure(meta, [])).toContain("the failed log is empty");
  });

  test("within a character budget the cap per job is lowered until the report fits, and it never exceeds the budget", () => {
    const big = log("j", "s", Array.from({ length: 300 }, (_, i) => `FAIL ${"x".repeat(60)} ${i}`));
    const whole = ciFailureReport(big, meta);
    expect(whole.length).toBeGreaterThan(8_000);
    for (const maxChars of [8_000, 2_000, 600, 200]) {
      const fitted = ciFailureReport(big, meta, { maxChars });
      expect(fitted.length).toBeLessThanOrEqual(maxChars);
      expect(fitted.startsWith("Run 77")).toBe(true);
    }
    expect(ciFailureReport(big, meta, { maxChars: 8_000 })).toContain("first and last only");
    expect(ciFailureReport(big, meta, { maxChars: 200 })).toContain("cut here to fit");
    // A report that fits is not touched.
    expect(ciFailureReport(raw, meta, { maxChars: 8_000 })).toBe(renderCiFailure(meta, distillFailedLog(raw)));
  });
});

test("ciFailureForHandoff: the whole excerpt when it fits; else a shortened one that says where the whole one is", () => {
  const small = log("j", "s", ["Error: x"]);
  const fits = ciFailureForHandoff(small, meta, { maxChars: 4_000, excerptPath: "/data/ci-failure-77.md" });
  expect(fits.inline).toBe(fits.full);
  expect(fits.inline).not.toContain("Shortened");

  const big = log("j", "s", Array.from({ length: 300 }, (_, i) => `FAIL ${"x".repeat(60)} ${i}`));
  for (const maxChars of [4_000, 1_000]) {
    const cut = ciFailureForHandoff(big, meta, { maxChars, excerptPath: "/data/ci-failure-77.md" });
    expect(cut.full).toBe(ciFailureReport(big, meta));
    expect(cut.inline.length).toBeLessThanOrEqual(maxChars);
    expect(cut.inline).toEndWith("\n(Shortened to fit the handoff. The same excerpt with up to 150 lines a job: /data/ci-failure-77.md)");
  }
  expect(ciFailureForHandoff(big, meta, { maxChars: 1_000, excerptPath: null }).inline).toEndWith("\n(Shortened to fit the handoff.)");
});

// `scripts/ci-wait/ci-wait` carries the same algorithm in Python for an
// agent-run Finish. The two must not drift: same logs, same bytes.
describe("scripts/ci-wait/ci-wait prints the same excerpt", () => {
  const script = join(import.meta.dir, "../../scripts/ci-wait/ci-wait");
  const python = Bun.which("python3");
  const driver = [
    "import importlib.machinery, importlib.util, json, sys",
    "loader = importlib.machinery.SourceFileLoader('ci_wait', sys.argv[1])",
    "spec = importlib.util.spec_from_loader('ci_wait', loader)",
    "m = importlib.util.module_from_spec(spec)",
    "loader.exec_module(m)",
    "raw = open(sys.argv[2], encoding='utf-8').read()",
    "meta = json.loads(sys.argv[3])",
    "jobs = m.distill_failed_log(raw)",
    "sys.stdout.write(m.render_ci_failure(meta['runId'], meta['url'], meta['workflow'], meta['logPath'], jobs))",
    "sys.stdout.write('\\n@@index@@\\n' + m.ci_failure_index(meta['workflow'], jobs))",
  ].join("\n");
  const logs: Record<string, string> = {
    "two jobs, colour, a mark, an exit line": [
      `web / unit\tRun tests\t﻿${TS}##[group]Run pnpm test`,
      log("web / unit", "Run tests", [...filler(40), "\x1b[31m ✗ adds an item\x1b[0m", "AssertionError: expected 1 to be 2", ...filler(25, 41), "##[error]Process completed with exit code 1."]),
      log("web / unit", "Post Run actions/checkout", filler(12, 200)),
      log("agent / go test", "go test", ["--- FAIL: TestCart (0.00s)", "    cart_test.go:14: got 1, want 2  ", "FAIL", "panic: runtime error"]),
    ].join("\n"),
    "two failed steps in one job: context never crosses an exit line": [
      log("j", "lint", [...filler(8), "Error: lint", "##[error]Process completed with exit code 3."]),
      log("j", "test", [...filler(6, 50), "FAIL t", ...filler(30, 60), "##[error]Process completed with exit code 4.", ...filler(5, 90)]),
    ].join("\n"),
    "no failure line": log("deploy", "Push", filler(90)),
    "a saved tail without job names, CRLF and blank lines": ["first\r", "", "Error: x\r", "   ", `${TS}last`].join("\n"),
    "more failure lines than the cap, and an over-long line": log("j", "s", [...Array.from({ length: 200 }, (_, i) => `× case ${i}`), `Error: ${"é😀".repeat(300)}`]),
    "context that has to shrink": log("j", "s", Array.from({ length: 12 }, (_, i) => [...filler(25), `src/a.ts(${i},1): error TS2322: no`]).flat()),
    "empty": "",
  };
  const metas: CiRunMeta[] = [meta, { runId: "9", url: null, workflow: null, logPath: null }];

  test.skipIf(!python)("for every fixture log", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-failure-parity-"));
    try {
      for (const [name, raw] of Object.entries(logs)) {
        for (const m of metas) {
          const file = join(dir, "log.txt");
          writeFileSync(file, raw);
          const ran = Bun.spawnSync([python!, "-I", "-c", driver, script, file, JSON.stringify(m)], { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
          expect(`${name}: ${ran.stderr.toString()}`).toBe(`${name}: `);
          const jobs = distillFailedLog(raw);
          expect(ran.stdout.toString()).toBe(`${renderCiFailure(m, jobs)}\n@@index@@\n${ciFailureIndex(m, jobs)}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
