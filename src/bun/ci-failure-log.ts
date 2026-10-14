/**
 * Reading a failed CI run for a handoff — the effectful half of
 * src/shared/ci-failure.ts. One place for the two callers that hand a CI
 * failure to Build: a Finish Agetor runs itself (src/bun/publish-step.ts) and
 * the merge queue's fix round (src/bun/merge-rework.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_LIMITS } from "../shared/types.ts";
import { ciFailureForHandoff, type CiRunMeta } from "../shared/ci-failure.ts";
import { run as exec } from "./github.ts";

/** What GitHub says about one failed run. */
export interface FailedRunLog {
  runId: number;
  /** `gh run view <id> --log-failed`, whole. */
  raw: string;
  workflow: string | null;
  url: string | null;
}

/** Lines of a job kept for the runner-fault decision: enough to reach an
 *  error above the job's own cleanup output. */
const JOB_TAIL_LINES = 150;

/** Each job's last lines from `gh run view --log-failed` output, whose lines
 *  are `job<TAB>step<TAB>text`; the job column is the check's name. Pure. */
export function jobTails(raw: string): Record<string, string> {
  const byJob = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0 || !line.trim()) continue;
    const job = line.slice(0, tab);
    const text = line.split("\t").slice(2).join("\t");
    const lines = byJob.get(job) ?? [];
    lines.push(text);
    if (lines.length > JOB_TAIL_LINES) lines.shift();
    byJob.set(job, lines);
  }
  return Object.fromEntries([...byJob].map(([job, lines]) => [job, lines.join("\n")]));
}

/** One failed run as a handoff carries it. */
export interface FailedRunReport {
  runId: number;
  /** The log's last lines, as before: read for the runner-fault decision
   *  (`infraReason`), which looks at how a job ended. */
  tail: string;
  /** What Build is shown: each failed job's failure lines with context. */
  report: string;
  /** Each failed job's last lines, by job (check) name, for `infraReason`. */
  jobs?: Record<string, string>;
}

/** The failed log of `runId` and the run's workflow and page, or null when
 *  the log could not be read. The run's details are best-effort. */
export async function readFailedRun(dir: string, runId: number): Promise<FailedRunLog | null> {
  const log = await exec(["gh", "run", "view", String(runId), "--log-failed"], dir, 60_000, process.env);
  if (!log.ok) return null;
  const info = await exec(["gh", "run", "view", String(runId), "--json", "workflowName,url"], dir, 30_000, process.env);
  let workflow: string | null = null;
  let url: string | null = null;
  try {
    const parsed = info.ok ? (JSON.parse(info.stdout) as { workflowName?: unknown; url?: unknown }) : {};
    workflow = typeof parsed.workflowName === "string" && parsed.workflowName ? parsed.workflowName : null;
    url = typeof parsed.url === "string" && parsed.url ? parsed.url : null;
  } catch {
    // The log is what matters; the heading says less.
  }
  return { runId, raw: log.stdout, workflow, url };
}

/** Room for every run's report in one handoff field (`normalizeHandoff`
 *  cuts a field at `handoffField`), with a little kept for the separators. */
const REASON_BUDGET = PIPELINE_LIMITS.handoffField - 100;

/**
 * The reports of `runs` for one handoff, sharing its `reason` field equally.
 * Each run's whole failed log is saved to `saveDir/ci-failed-<run>.log`, and
 * its excerpt at full size to `ci-failure-<run>.md` when the handoff's copy
 * had to be shortened; the report names both. A file that cannot be written
 * is reported as not saved and changes nothing else. `tailOf` is the
 * caller's tail (src/bun/merge-rework.ts's `logTail`).
 */
export function failedRunReports(runs: readonly FailedRunLog[], saveDir: string | null, tailOf: (raw: string) => string): FailedRunReport[] {
  const share = Math.floor(REASON_BUDGET / Math.max(1, runs.length));
  const save = (name: string, text: string): string | null => {
    if (!saveDir) return null;
    try {
      mkdirSync(saveDir, { recursive: true });
      const path = join(saveDir, name);
      writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
      return path;
    } catch {
      return null;
    }
  };
  return runs.map((run) => {
    const meta: CiRunMeta = { runId: run.runId, url: run.url, workflow: run.workflow, logPath: save(`ci-failed-${run.runId}.log`, run.raw) };
    const excerptPath = saveDir ? join(saveDir, `ci-failure-${run.runId}.md`) : null;
    const fitted = ciFailureForHandoff(run.raw, meta, { maxChars: share, excerptPath });
    // Only a shortened report points at the larger one, so only then is it written.
    if (fitted.inline !== fitted.full && save(`ci-failure-${run.runId}.md`, fitted.full) === null) {
      return { runId: run.runId, tail: tailOf(run.raw), report: ciFailureForHandoff(run.raw, meta, { maxChars: share, excerptPath: null }).inline, jobs: jobTails(run.raw) };
    }
    return { runId: run.runId, tail: tailOf(run.raw), report: fitted.inline, jobs: jobTails(run.raw) };
  });
}
