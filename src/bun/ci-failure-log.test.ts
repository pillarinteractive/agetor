import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIPELINE_LIMITS } from "../shared/types.ts";
import { failedRunReports, type FailedRunLog } from "./ci-failure-log.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ci-failure-log-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const line = (text: string) => `web / unit\tRun tests\t2026-10-14T00:48:29.3248291Z ${text}`;
const run = (runId: number, lines: string[]): FailedRunLog => ({ runId, raw: lines.map(line).join("\n"), workflow: "ci", url: `https://github.com/o/r/actions/runs/${runId}` });
const tailOf = (raw: string) => `tail:${raw.length}`;
const small = run(1, ["ok", "Error: boom", "##[error]Process completed with exit code 1."]);
const big = (runId: number) => run(runId, Array.from({ length: 400 }, (_, i) => `FAIL ${"x".repeat(70)} ${i}`));

test("a report that fits names the saved log and is not split into a second file", () => {
  const dir = join(tmp(), "runs", "card");
  const [got] = failedRunReports([small], dir, tailOf);
  expect(got).toMatchObject({ runId: 1, tail: `tail:${small.raw.length}` });
  expect(got!.report.split("\n").slice(0, 3)).toEqual([
    "Run 1: https://github.com/o/r/actions/runs/1",
    `Full log: ${join(dir, "ci-failed-1.log")} (or \`gh run view 1 --log-failed\`)`,
    '--- failed: ci / web / unit / step "Run tests" — exit code 1 ---',
  ]);
  expect(readFileSync(join(dir, "ci-failed-1.log"), "utf8")).toBe(`${small.raw}\n`);
  expect(existsSync(join(dir, "ci-failure-1.md"))).toBe(false);
});

test("runs share one handoff field; a shortened report says where its full excerpt is, and that file holds it", () => {
  const dir = tmp();
  const reports = failedRunReports([big(1), big(2)], dir, tailOf);
  expect(reports.map((r) => r.report).join("\n\n").length).toBeLessThanOrEqual(PIPELINE_LIMITS.handoffField);
  for (const r of reports) {
    const whole = join(dir, `ci-failure-${r.runId}.md`);
    expect(r.report).toEndWith(`(Shortened to fit the handoff. The same excerpt with up to 150 lines a job: ${whole})`);
    const saved = readFileSync(whole, "utf8");
    expect(saved.split("\n").length).toBeGreaterThan(150);
    expect(saved).toContain("first and last only");
  }
});

test("nowhere to save, or a folder that cannot be written: the report says the log is not saved and names no file", () => {
  const blocked = join(tmp(), "a-file");
  writeFileSync(blocked, "not a directory");
  for (const dir of [null, join(blocked, "runs")]) {
    const [fits] = failedRunReports([small], dir, tailOf);
    expect(fits!.report).toContain("Full log: not saved (or `gh run view 1 --log-failed`)");
    const [cut] = failedRunReports([big(3)], dir, tailOf);
    expect(cut!.report).toEndWith("\n(Shortened to fit the handoff.)");
    expect(cut!.report.length).toBeLessThanOrEqual(PIPELINE_LIMITS.handoffField);
  }
});

test("no run, no report", () => {
  expect(failedRunReports([], tmp(), tailOf)).toEqual([]);
});
