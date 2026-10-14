/**
 * What a failed CI run says, cut down to the part a fixer needs.
 *
 * A failed run's log (`gh run view <id> --log-failed`) is thousands of lines,
 * and its end is the runner cleaning up after itself: the last 60 lines that
 * Build used to be handed were mostly `git config --unset` and showed one
 * failure of ten. {@link distillFailedLog} keeps, per failed job, the lines
 * that match a failure marker with context around them, without ANSI colour
 * and timestamps, and {@link renderCiFailure} heads each job with its
 * workflow, job, step and exit code and names the run and the full log.
 *
 * `scripts/ci-wait/ci-wait` (what an agent-run Finish waits with) carries the
 * same algorithm in Python; `src/shared/ci-failure.test.ts` runs both on the
 * same logs and requires the same bytes. Change them together.
 *
 * Pure: no file, no process, no clock.
 */

/** A line matching any of these is a failure line: `FAIL` (also `--- FAIL:`
 *  and `FAILED`), `Error:`, `error TS1234`, `panic:`, `AssertionError`, `✗`,
 *  `×` and the runner's own `##[error]`. Case-sensitive on purpose: "0
 *  failed" and "error-handling" are not failures. */
export const CI_FAILURE_MARKER = /FAIL|Error:|error TS[0-9]+|panic:|AssertionError|✗|×|##\[error\]/;

const EXIT_LINE = /##\[error\]Process completed with exit code ([0-9]+)/;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f﻿]/g;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z ?/;
const TRAILING_BLANKS = /[ \t]+$/;

export const CI_FAILURE_DEFAULTS = {
  /** Lines kept either side of a failure line. */
  context: 20,
  /** Log lines kept per job, at most. */
  maxLines: 150,
  /** Lines kept from the end of a job in which no line matches a marker. */
  tailLines: 60,
  /** Characters kept of one line (a minified bundle or a JSON blob on one line). */
  maxLineChars: 400,
} as const;

/** Context sizes tried, widest first, until a job's excerpt fits `maxLines`. */
const CONTEXT_LADDER = [20, 10, 5, 2, 0];

export interface CiLogLine {
  job: string;
  step: string;
  text: string;
}

/** One log line without colour codes, control characters, the runner's
 *  timestamp and trailing blanks; over-long lines are cut and say so. Pure. */
export function cleanCiLine(text: string, maxChars: number = CI_FAILURE_DEFAULTS.maxLineChars): string {
  const clean = text.replace(ANSI, "").replace(CONTROL, "").replace(TIMESTAMP, "").replace(TRAILING_BLANKS, "");
  const points = Array.from(clean);
  return points.length > maxChars ? `${points.slice(0, maxChars).join("")} … [+${points.length - maxChars} chars]` : clean;
}

/** `gh run view --log-failed` output as lines: `job<TAB>step<TAB>text`. A
 *  line without that prefix (a saved tail) belongs to a job with no name.
 *  Lines that are wholly empty are dropped. Pure. */
export function parseFailedLog(raw: string): CiLogLine[] {
  const out: CiLogLine[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (/^[ \t]*$/.test(line)) continue;
    const parts = line.split("\t");
    if (parts.length >= 3) out.push({ job: parts[0]!, step: parts[1]!, text: cleanCiLine(parts.slice(2).join("\t")) });
    else out.push({ job: "", step: "", text: cleanCiLine(line) });
  }
  return out;
}

export interface CiJobExcerpt {
  /** "" when the log did not name its jobs. */
  job: string;
  /** The step the failure is in: the step of the last `exit code` line, else
   *  of the last failure line, else the job's last step. */
  step: string;
  exitCode: number | null;
  /** Log lines of this job. */
  totalLines: number;
  /** Of them, how many match a failure marker. */
  failureLines: number;
  /** Lines of the excerpt that are log lines. */
  shownLines: number;
  /** The context that fitted, or null when no line matched and the end of
   *  the job is shown instead. */
  context: number | null;
  /** The excerpt, with `… N lines omitted …` wherever lines were left out. */
  lines: string[];
}

export interface CiDistillOptions {
  context?: number;
  maxLines?: number;
  tailLines?: number;
}

function distillJob(job: string, lines: readonly CiLogLine[], opts: Required<CiDistillOptions>): CiJobExcerpt {
  const hits: number[] = [];
  const exits: number[] = [];
  let exitCode: number | null = null;
  lines.forEach((l, i) => {
    if (!CI_FAILURE_MARKER.test(l.text)) return;
    hits.push(i);
    const exit = EXIT_LINE.exec(l.text);
    if (exit) {
      exitCode = Number(exit[1]);
      exits.push(i);
    }
  });
  const exitAt = exits.length > 0 ? exits[exits.length - 1]! : -1;
  let keep: number[] = [];
  let context: number | null = null;
  if (hits.length === 0) {
    for (let i = Math.max(0, lines.length - opts.tailLines); i < lines.length; i++) keep.push(i);
  } else {
    for (const ctx of CONTEXT_LADDER.filter((c) => c <= opts.context)) {
      const chosen = new Set<number>();
      for (const i of hits) {
        // Context never crosses "Process completed with exit code": what
        // follows it is the runner cleaning up, not part of the failure
        // before it, and a later failure's context starts after it.
        let from = Math.max(0, i - ctx);
        let to = Math.min(lines.length - 1, i + ctx);
        for (const e of exits) {
          if (e < i) from = Math.max(from, e + 1);
          else to = Math.min(to, e);
        }
        for (let k = from; k <= to; k++) chosen.add(k);
      }
      keep = [...chosen].sort((a, b) => a - b);
      context = ctx;
      if (keep.length <= opts.maxLines) break;
    }
    if (keep.length > opts.maxLines) {
      // More failure lines than the cap: the first third and the last two
      // thirds, as a report is cut (`truncateMiddleUtf8`).
      const head = Math.floor(opts.maxLines / 3);
      keep = [...hits.slice(0, head), ...hits.slice(hits.length - (opts.maxLines - head))];
    }
  }
  const out: string[] = [];
  let previous = -1;
  const omitted = (count: number) => {
    if (count > 0) out.push(`… ${count} line${count === 1 ? "" : "s"} omitted …`);
  };
  for (const i of keep) {
    omitted(i - previous - 1);
    out.push(lines[i]!.text);
    previous = i;
  }
  omitted(lines.length - 1 - previous);
  const stepAt = exitAt >= 0 ? exitAt : hits.length > 0 ? hits[hits.length - 1]! : lines.length - 1;
  return {
    job, step: lines[stepAt]?.step ?? "", exitCode, totalLines: lines.length, failureLines: hits.length,
    shownLines: keep.length, context, lines: out,
  };
}

/** One excerpt per job of a failed run's log, in the log's order. Pure. */
export function distillFailedLog(raw: string, options: CiDistillOptions = {}): CiJobExcerpt[] {
  const opts = {
    context: options.context ?? CI_FAILURE_DEFAULTS.context,
    maxLines: Math.max(1, options.maxLines ?? CI_FAILURE_DEFAULTS.maxLines),
    tailLines: options.tailLines ?? CI_FAILURE_DEFAULTS.tailLines,
  };
  const jobs = new Map<string, CiLogLine[]>();
  for (const line of parseFailedLog(raw)) {
    const list = jobs.get(line.job);
    if (list) list.push(line);
    else jobs.set(line.job, [line]);
  }
  return [...jobs].map(([job, lines]) => distillJob(job, lines, opts));
}

export interface CiRunMeta {
  runId: number | string;
  /** The run's page; null when it could not be read. */
  url: string | null;
  /** The workflow's name; null when it could not be read. */
  workflow: string | null;
  /** Where the whole `--log-failed` output was saved; null when it was not. */
  logPath: string | null;
}

/** The heading of one job's excerpt. Pure. */
export function ciJobHeading(meta: Pick<CiRunMeta, "workflow">, job: CiJobExcerpt): string {
  const where = [meta.workflow, job.job, job.step ? `step "${job.step}"` : null].filter((s) => s !== null && s !== "").join(" / ");
  return `--- failed: ${where || "(job not named in the log)"} — ${job.exitCode === null ? "exit code not in the log" : `exit code ${job.exitCode}`} ---`;
}

/** One line saying what an excerpt is an excerpt of. Pure. */
export function ciJobNote(job: CiJobExcerpt): string {
  if (job.context === null) return `(no line matches a failure marker: the last ${job.shownLines} of ${job.totalLines} log lines)`;
  return `(${job.shownLines} of ${job.totalLines} log lines: the ${job.failureLines} failure line${job.failureLines === 1 ? "" : "s"}` +
    `${job.context > 0 ? ` with up to ${job.context} lines either side` : ""}${job.shownLines < job.failureLines ? ", first and last only" : ""})`;
}

/**
 * A failed run as text: where the whole thing is, then each failed job's
 * workflow, job, step and exit code over its excerpt. Pure.
 */
export function renderCiFailure(meta: CiRunMeta, jobs: readonly CiJobExcerpt[]): string {
  const out = [
    `Run ${meta.runId}${meta.url ? `: ${meta.url}` : ""}`,
    `Full log: ${meta.logPath ?? "not saved"} (or \`gh run view ${meta.runId} --log-failed\`)`,
  ];
  if (jobs.length === 0) out.push("(the failed log is empty: the job failed before any of its steps ran)");
  for (const job of jobs) out.push(ciJobHeading(meta, job), ciJobNote(job), ...job.lines);
  return out.join("\n");
}

/** Per-job caps tried, largest first, to make a report fit a character budget. */
const LINE_CAPS = [150, 100, 60, 40, 25, 15, 8, 4];

/**
 * {@link renderCiFailure} of `raw`, within `maxChars` when given: the cap on
 * lines per job is lowered until the report fits (a handoff field holds
 * 8,000 characters). The whole excerpt is what a caller saves to a file;
 * this is what it puts in front of the model. Pure.
 */
export function ciFailureReport(raw: string, meta: CiRunMeta, opts: CiDistillOptions & { maxChars?: number } = {}): string {
  const first = Math.max(1, opts.maxLines ?? CI_FAILURE_DEFAULTS.maxLines);
  const caps = [first, ...LINE_CAPS.filter((c) => c < first)];
  let text = "";
  for (const maxLines of caps) {
    text = renderCiFailure(meta, distillFailedLog(raw, { ...opts, maxLines }));
    if (opts.maxChars === undefined || text.length <= opts.maxChars) return text;
  }
  const cut = "\n… cut here to fit; the rest is in the full log …";
  return `${text.slice(0, Math.max(0, opts.maxChars! - cut.length))}${cut}`;
}

/** One line naming every failed job of a run. Pure. */
export function ciFailureIndex(meta: Pick<CiRunMeta, "workflow">, jobs: readonly CiJobExcerpt[]): string {
  return jobs.map((j) => {
    const where = [meta.workflow, j.job].filter((s) => s !== null && s !== "").join(" / ") || "(job not named)";
    return `${where} (${j.exitCode === null ? "exit code not in the log" : `exit ${j.exitCode}`}${j.step ? `, step "${j.step}"` : ""})`;
  }).join("; ");
}

/**
 * A failed run's report for a handoff field of `maxChars`: `full` is the
 * excerpt at its normal size (what a caller saves to `excerptPath`), `inline`
 * is `full` when it fits, else the shortened report with a line saying where
 * the larger one is. `inline` never exceeds `maxChars`. Pure.
 */
export function ciFailureForHandoff(raw: string, meta: CiRunMeta, opts: { maxChars: number; excerptPath: string | null }): { inline: string; full: string } {
  const full = ciFailureReport(raw, meta);
  if (full.length <= opts.maxChars) return { inline: full, full };
  const note = opts.excerptPath
    ? `\n(Shortened to fit the handoff. The same excerpt with up to ${CI_FAILURE_DEFAULTS.maxLines} lines a job: ${opts.excerptPath})`
    : "\n(Shortened to fit the handoff.)";
  return { inline: `${ciFailureReport(raw, meta, { maxChars: Math.max(0, opts.maxChars - note.length) })}${note}`, full };
}
