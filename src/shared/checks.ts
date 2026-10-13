/**
 * Checks on working steps — the pure half (docs/plans/check-gated-pipeline.md
 * §3 and §5).
 *
 * A step used to advance on what its agent said in a handoff block. A step
 * with a gate advances when checks Agetor runs itself pass: when the step's
 * turn ends its checks are run in order, and a required one that fails goes
 * back to the SAME step as another turn that carries the failure — not to the
 * next step, and not as a new launch. src/bun/check-runner.ts runs the checks
 * and keeps the ledger; src/bun/pipeline-runner.ts decides what a result does
 * to the run. Nothing here touches git, GitHub, a file or a clock.
 *
 * The order of trust: a built-in check recomputes from the worktree every
 * time. The ledger is only ever used to skip a check whose key (head, tree,
 * base tip, definition) is unchanged since it passed. What the agent writes
 * is a place to look and proves nothing — except a reviewer's verdict, which
 * is the one thing Agetor cannot recompute and so only binds to the head.
 */
import type { BuiltinCheck, CheckLedgerEntry, CheckOutcome, Handoff, StepCheck } from "./types.ts";

export const CHECK_LIMITS = {
  perStep: 12,
  id: 40,
  description: 240,
  command: 2000,
  goal: 1000,
  timeoutDefaultSec: 120,
  timeoutMaxSec: 600,
  maxTurnsDefault: 2,
  maxTurnsMax: 5,
  /** Of a failed check's output, what a feedback turn and the ledger carry. */
  tailLines: 60,
  tailBytes: 4000,
  /** All failed checks' output in one feedback message. */
  feedbackBytes: 16_000,
} as const;

export const BUILTIN_CHECKS: readonly BuiltinCheck[] = [
  "tree-clean", "diff-nonempty", "review-verdict", "head-approved", "merges-with-base", "head-published", "pr-required-check",
];

/** What each built-in grades, in the words the step's agent is shown. */
export const BUILTIN_DESCRIPTIONS: Record<BuiltinCheck, string> = {
  "tree-clean": "The worktree has no uncommitted change to a tracked file: everything the step did is committed.",
  "diff-nonempty": "The branch holds at least one commit that the base branch does not.",
  "review-verdict":
    "The handoff carries \"reviewApproval\" for exactly the commit under review: \"headSha\" is the full `git rev-parse HEAD`, " +
    "and \"approved\" comes with no findings and complete acceptance.",
  "head-approved": "HEAD is the commit the last Review approved.",
  "merges-with-base": "The branch merges with the base branch without conflicts.",
  "head-published": "The branch on origin is at HEAD.",
  "pr-required-check": "The pull request's required check passed for HEAD (read from GitHub; not applicable while there is no pull request).",
};

const CHECK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** A built-in as a check with its default description, required. */
export function builtinCheck(name: BuiltinCheck, o: Partial<Pick<StepCheck, "id" | "description" | "required" | "dependsOn">> = {}): StepCheck {
  return {
    id: o.id ?? name, description: o.description ?? BUILTIN_DESCRIPTIONS[name], run: { kind: "builtin", name },
    ...(o.dependsOn ? { dependsOn: o.dependsOn } : {}), required: o.required ?? true, timeoutSec: CHECK_LIMITS.timeoutDefaultSec,
  };
}

/**
 * The checks a step gets when its pipeline declares none, by its place in a
 * reviewed pipeline (Build → Review → Finish): only built-ins that take
 * milliseconds and start nothing. No test suite, linter, type checker or
 * build is ever a default. Any other step has no gate.
 */
export function defaultStepChecks(role: "build" | "review" | null): StepCheck[] {
  if (role === "build") return [builtinCheck("tree-clean"), builtinCheck("diff-nonempty")];
  if (role === "review") return [builtinCheck("tree-clean"), builtinCheck("review-verdict")];
  return [];
}

/**
 * Validate and normalize a step's `checks` as stored on a pipeline graph.
 * Rejects what would make a gate ambiguous or unsafe: a duplicate or
 * malformed id, an unknown built-in, an empty command, a dependency on a
 * check that is not there or on itself, a dependency cycle, a timeout out of
 * range. Defaults: a built-in's description, `required: true`, 120 s.
 */
export function validateStepChecks(raw: unknown, stepName: string): { ok: true; checks: StepCheck[] } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error: `step "${stepName}" ${error}` });
  if (!Array.isArray(raw)) return bad("checks must be an array");
  if (raw.length > CHECK_LIMITS.perStep) return bad(`checks exceed the limit of ${CHECK_LIMITS.perStep}`);
  const checks: StepCheck[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!isObject(item)) return bad("has a check that is not an object");
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || id.length > CHECK_LIMITS.id || !CHECK_ID_RE.test(id)) return bad(`has a check with an invalid id ${JSON.stringify(item.id ?? null)} (letters, digits, ".", "_" and "-", at most ${CHECK_LIMITS.id})`);
    if (ids.has(id.toLowerCase())) return bad(`has two checks called "${id}"`);
    ids.add(id.toLowerCase());

    const run = item.run;
    if (!isObject(run)) return bad(`check "${id}" has no "run"`);
    let normalizedRun: StepCheck["run"];
    if (run.kind === "builtin") {
      if (typeof run.name !== "string" || !BUILTIN_CHECKS.includes(run.name as BuiltinCheck)) {
        return bad(`check "${id}" names an unknown built-in ${JSON.stringify(run.name ?? null)} (one of ${BUILTIN_CHECKS.join(", ")})`);
      }
      normalizedRun = { kind: "builtin", name: run.name as BuiltinCheck };
    } else if (run.kind === "command") {
      const command = typeof run.command === "string" ? run.command.trim() : "";
      if (!command) return bad(`check "${id}" has an empty command`);
      if (command.length > CHECK_LIMITS.command) return bad(`check "${id}" command exceeds ${CHECK_LIMITS.command} chars`);
      if (command.includes("\u0000")) return bad(`check "${id}" command contains a NUL character`);
      normalizedRun = { kind: "command", command };
    } else {
      return bad(`check "${id}" run.kind must be "builtin" or "command"`);
    }

    let description = typeof item.description === "string" ? item.description.trim().replace(/\s+/g, " ") : "";
    if (!description && normalizedRun.kind === "builtin") description = BUILTIN_DESCRIPTIONS[normalizedRun.name];
    if (!description) return bad(`check "${id}" needs a description: it is what the step's agent is told will be graded`);
    if (description.length > CHECK_LIMITS.description || CONTROL_RE.test(description)) {
      return bad(`check "${id}" description must be one line of at most ${CHECK_LIMITS.description} chars`);
    }

    if (item.required !== undefined && typeof item.required !== "boolean") return bad(`check "${id}" required must be true or false`);
    if (item.skipWhen !== undefined && item.skipWhen !== null && item.skipWhen !== "unchanged-since-pass") {
      return bad(`check "${id}" skipWhen must be "unchanged-since-pass" when given`);
    }
    let timeoutSec: number = CHECK_LIMITS.timeoutDefaultSec;
    if (item.timeoutSec !== undefined && item.timeoutSec !== null) {
      if (!Number.isInteger(item.timeoutSec) || (item.timeoutSec as number) < 1 || (item.timeoutSec as number) > CHECK_LIMITS.timeoutMaxSec) {
        return bad(`check "${id}" timeoutSec must be an integer between 1 and ${CHECK_LIMITS.timeoutMaxSec}`);
      }
      timeoutSec = item.timeoutSec as number;
    }
    let dependsOn: string[] | undefined;
    if (item.dependsOn !== undefined && item.dependsOn !== null) {
      if (!Array.isArray(item.dependsOn) || !item.dependsOn.every((d) => typeof d === "string")) return bad(`check "${id}" dependsOn must be a list of check ids`);
      dependsOn = [...new Set((item.dependsOn as string[]).map((d) => d.trim()))];
    }
    checks.push({
      id, description, run: normalizedRun,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
      ...(item.skipWhen === "unchanged-since-pass" ? { skipWhen: "unchanged-since-pass" as const } : {}),
      required: item.required !== false, timeoutSec,
    });
  }
  const byId = new Map(checks.map((c) => [c.id, c]));
  for (const c of checks) {
    for (const d of c.dependsOn ?? []) {
      if (d === c.id) return bad(`check "${c.id}" depends on itself`);
      if (!byId.has(d)) return bad(`check "${c.id}" depends on "${d}", which this step does not have`);
    }
  }
  if (orderChecks(checks).length !== checks.length) return bad("has checks that depend on each other in a cycle");
  return { ok: true, checks };
}

/**
 * The order checks run in: declaration order, except that a check comes
 * after everything it depends on (so cheap checks listed first run first).
 * A check caught in a dependency cycle, or depending on one that is not
 * there, is left out — `validateStepChecks` refuses such a list, and a list
 * that slipped past it must not loop here.
 */
export function orderChecks(checks: readonly StepCheck[]): StepCheck[] {
  const ids = new Set(checks.map((c) => c.id));
  const placed = new Set<string>();
  const out: StepCheck[] = [];
  let progressed = true;
  while (out.length < checks.length && progressed) {
    progressed = false;
    for (const c of checks) {
      if (placed.has(c.id)) continue;
      const deps = c.dependsOn ?? [];
      if (!deps.every((d) => ids.has(d) && placed.has(d))) continue;
      placed.add(c.id);
      out.push(c);
      progressed = true;
    }
  }
  return out;
}

/** A short stable hash of what a check does (FNV-1a): a changed command or
 *  built-in is a different check as far as a recorded pass goes. Its
 *  description, `required` and timeout are not part of what it tests. */
export function checkDefHash(check: StepCheck): string {
  const text = JSON.stringify([check.id, check.run.kind, check.run.kind === "builtin" ? check.run.name : check.run.command]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Planning and judging
// ---------------------------------------------------------------------------

/** What the worktree was when a check ran. */
export interface CheckKey {
  head: string | null;
  tree: string | null;
  baseTip: string | null;
}

/** One check's result in one evaluation of a gate. */
export interface CheckResult {
  check: StepCheck;
  outcome: Extract<CheckOutcome, "pass" | "fail" | "skip" | "halt">;
  /** Counts as met: a pass, a reused pass, or a check that does not apply. */
  satisfied: boolean;
  exitCode: number | null;
  /** One line. */
  detail: string;
  /** The end of its output; empty when it had none. */
  output: string;
  outputPath: string | null;
}

/** The newest recorded result of `check` on `stepId` for exactly `key`, when
 *  that result is a pass — the one thing the ledger is trusted for. A later
 *  fail, void or waiver of the same check for the same key cancels it. */
export function reusablePass(check: StepCheck, stepId: string, key: CheckKey, ledger: readonly CheckLedgerEntry[]): CheckLedgerEntry | null {
  if (check.skipWhen !== "unchanged-since-pass" || !key.head || !key.tree) return null;
  const def = checkDefHash(check);
  for (let i = ledger.length - 1; i >= 0; i--) {
    const e = ledger[i]!;
    if (e.stepId !== stepId || e.checkId !== check.id) continue;
    if (e.key.def !== def || e.key.head !== key.head || e.key.tree !== key.tree || e.key.baseTip !== key.baseTip) continue;
    // A reused pass is itself recorded as a satisfied skip: look past it.
    if (e.outcome === "skip" && e.satisfied) continue;
    return e.outcome === "pass" ? e : null;
  }
  return null;
}

/**
 * What to do with `check` now, given the results of the checks before it:
 * `blocked` — something it depends on did not pass, so it is not run;
 * `reuse` — a recorded pass for the same key stands in for running it;
 * `run`. Call in {@link orderChecks} order.
 */
export function planCheck(
  check: StepCheck,
  done: ReadonlyMap<string, Pick<CheckResult, "satisfied" | "outcome">>,
  reuse: CheckLedgerEntry | null,
): { action: "run" } | { action: "reuse"; from: CheckLedgerEntry } | { action: "blocked"; by: string[]; halted: boolean } {
  const unmet = (check.dependsOn ?? []).filter((d) => !done.get(d)?.satisfied);
  if (unmet.length > 0) {
    // Not the work's fault when what it waits on could not be evaluated.
    const halted = unmet.every((d) => done.get(d)?.outcome === "halt" || done.get(d) === undefined);
    return { action: "blocked", by: unmet, halted };
  }
  return reuse ? { action: "reuse", from: reuse } : { action: "run" };
}

/** The result recorded for a check that was not run (`planCheck`). */
export function unrunResult(check: StepCheck, plan: Exclude<ReturnType<typeof planCheck>, { action: "run" }>): CheckResult {
  if (plan.action === "reuse") {
    return { check, outcome: "skip", satisfied: true, exitCode: plan.from.exitCode, detail: "unchanged since it passed — not run again", output: "", outputPath: plan.from.outputPath };
  }
  return {
    check, outcome: plan.halted ? "halt" : "skip", satisfied: false, exitCode: null,
    detail: `not run: ${plan.by.map((d) => `"${d}"`).join(", ")} did not pass`, output: "", outputPath: null,
  };
}

export interface GateVerdict {
  /** pass — every required check is met. fail — one failed: the step's to
   *  fix. halt — none failed, but one could not be evaluated. */
  state: "pass" | "fail" | "halt";
  /** Checks that failed and stand in the way: required ones, and optional
   *  ones a required check depends on. */
  failed: CheckResult[];
  /** Required checks that are not met for any other reason. */
  unmet: CheckResult[];
}

/** Whether a gate is satisfied by one evaluation of its checks. */
export function gateVerdict(results: readonly CheckResult[]): GateVerdict {
  const open = results.filter((r) => r.check.required && !r.satisfied);
  if (open.length === 0) return { state: "pass", failed: [], unmet: [] };
  const neededBy = new Set(open.flatMap((r) => r.check.dependsOn ?? []));
  const failed = results.filter((r) => r.outcome === "fail" && (r.check.required || neededBy.has(r.check.id)));
  return { state: failed.length > 0 ? "fail" : "halt", failed, unmet: open.filter((r) => !failed.includes(r)) };
}

/** A ledger line for one result. */
export function ledgerEntry(input: {
  at: number; stepId: string; stepName: string; seq: number; turn: number; key: CheckKey; result: CheckResult;
}): CheckLedgerEntry {
  const { result: r } = input;
  return {
    at: input.at, stepId: input.stepId, stepName: input.stepName, seq: input.seq, turn: input.turn,
    checkId: r.check.id, description: r.check.description, required: r.check.required, outcome: r.outcome, satisfied: r.satisfied,
    key: { ...input.key, def: checkDefHash(r.check) }, exitCode: r.exitCode, detail: r.detail, outputTail: r.output, outputPath: r.outputPath,
  };
}

const OUTCOMES = new Set<string>(["pass", "fail", "skip", "waived", "halt", "void"]);

/** Read a ledger file's text. A line that is not a ledger entry (a torn
 *  write, a hand edit) is left out; nothing else is trusted about the file. */
export function parseCheckLedger(text: string): CheckLedgerEntry[] {
  const out: CheckLedgerEntry[] = [];
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(v) || !isObject(v.key)) continue;
    const { at, stepId, seq, turn, checkId, outcome } = v;
    if (typeof at !== "number" || !Number.isFinite(at) || typeof stepId !== "string" || !stepId || typeof checkId !== "string" || !checkId) continue;
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(turn) || typeof outcome !== "string" || !OUTCOMES.has(outcome)) continue;
    out.push({
      at, stepId, stepName: str(v.stepName) ?? stepId, seq: seq as number, turn: turn as number, checkId,
      description: str(v.description) ?? "", required: v.required !== false, outcome: outcome as CheckOutcome,
      satisfied: typeof v.satisfied === "boolean" ? v.satisfied : outcome === "pass",
      key: { head: str(v.key.head), tree: str(v.key.tree), baseTip: str(v.key.baseTip), def: str(v.key.def) ?? "" },
      exitCode: Number.isSafeInteger(v.exitCode) ? (v.exitCode as number) : null,
      detail: str(v.detail) ?? "", outputTail: str(v.outputTail) ?? "", outputPath: str(v.outputPath),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-ins whose judgement is pure
// ---------------------------------------------------------------------------

export type Finding = Pick<CheckResult, "outcome" | "satisfied" | "detail" | "output">;
const pass = (detail: string): Finding => ({ outcome: "pass", satisfied: true, detail, output: "" });
const fail = (detail: string, output = ""): Finding => ({ outcome: "fail", satisfied: false, detail, output });
const halt = (detail: string): Finding => ({ outcome: "halt", satisfied: false, detail, output: "" });
const short = (sha: string) => sha.slice(0, 8);

/**
 * `review-verdict`: the reviewer's judgement is the evidence, so the check
 * only binds it to the commit — the handoff carries `reviewApproval`, its
 * `headSha` is HEAD, and "approved" comes with no findings and complete
 * acceptance. "changes-requested" for HEAD passes too: that is a judgement,
 * and the run follows it to Build. `reviewApprovalMatches` without the
 * conditions that are Pillar's.
 */
export function reviewVerdictFinding(handoff: Pick<Handoff, "reviewApproval"> | null, head: string | null, issueUrl: string | null = null): Finding {
  if (!head) return halt("HEAD could not be read");
  const r = handoff?.reviewApproval;
  if (!r) {
    return fail(
      handoff ? "the handoff has no readable \"reviewApproval\"" : "the turn ended without a handoff, so there is no verdict",
      `${reviewApprovalFormat(issueUrl)} It is dropped when a field is missing or misspelt, or when "issueUrl" is not an issue URL.`,
    );
  }
  if (r.headSha.toLowerCase() !== head.toLowerCase()) {
    return fail(
      `the verdict is for ${short(r.headSha)}, but HEAD is ${short(head)}`,
      `reviewApproval.headSha is ${r.headSha}; git rev-parse HEAD is ${head}. Review the commit that is checked out and name it, or say why HEAD moved.`,
    );
  }
  if (r.verdict === "approved" && (r.findings.length > 0 || !r.acceptanceComplete)) {
    return fail(
      r.findings.length > 0 ? `"approved" with ${r.findings.length} finding(s)` : "\"approved\" with acceptanceComplete false",
      "An approval has no findings and complete acceptance. With findings or an unmet criterion the verdict is \"changes-requested\" and the next step is the one that fixes them.",
    );
  }
  return pass(`${r.verdict} for ${short(head)}`);
}

/** `head-approved`: HEAD is the commit the last finished Review approved. */
export function headApprovedFinding(lastReview: Pick<Handoff, "reviewApproval"> | null | undefined, head: string | null): Finding {
  if (!head) return halt("HEAD could not be read");
  const r = lastReview?.reviewApproval;
  if (!r) return fail("no Review of this run has recorded a verdict");
  if (r.verdict !== "approved" || r.findings.length > 0 || !r.acceptanceComplete) return fail(`the last Review did not approve (${r.verdict})`);
  if (r.headSha.toLowerCase() !== head.toLowerCase()) {
    return fail(`Review approved ${short(r.headSha)}, but HEAD is ${short(head)}`, `Commits after ${r.headSha} were not reviewed.`);
  }
  return pass(`approved head ${short(head)}`);
}

/** `pr-required-check`, from what GitHub says: no pull request → it does not
 *  apply; the check for another head, still running, or unreadable → not a
 *  failure of the work; otherwise the `required` roll-up's own result (the
 *  whole set when the repository has no such check). */
export function prRequiredFinding(
  seen: { readable: false } | { readable: true; pull: { number: number; headSha: string | null; state: string } | null; state: "none" | "pending" | "success" | "failure"; failing: string[] },
  head: string | null,
): Finding {
  if (!head) return halt("HEAD could not be read");
  if (!seen.readable) return halt("GitHub could not be read");
  if (!seen.pull) return { outcome: "skip", satisfied: true, detail: "no pull request yet — nothing to read", output: "" };
  if (seen.pull.state !== "open") return halt(`pull request #${seen.pull.number} is ${seen.pull.state}`);
  if (seen.pull.headSha && seen.pull.headSha.toLowerCase() !== head.toLowerCase()) {
    return fail(`pull request #${seen.pull.number} is at ${short(seen.pull.headSha)}, not HEAD ${short(head)}`, "The pull request has not been given this commit.");
  }
  if (seen.state === "success") return pass(`passed for ${short(head)} on #${seen.pull.number}`);
  if (seen.state === "failure") return fail(`failed for ${short(head)} on #${seen.pull.number}`, seen.failing.length ? `Failing: ${seen.failing.join(", ")}` : "");
  return halt(seen.state === "none" ? `no check has reported for ${short(head)} yet` : `still running for ${short(head)}`);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The last `lines` lines of `text`, cut to `bytes` UTF-16 units from the
 *  end (a failure is at the bottom of a log), with a first line saying how
 *  much is not shown. */
export function outputTail(text: string, lines: number = CHECK_LIMITS.tailLines, bytes: number = CHECK_LIMITS.tailBytes): string {
  const all = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (all.length === 1 && all[0] === "") return "";
  let kept = all.slice(-Math.max(1, lines));
  let joined = kept.join("\n");
  if (joined.length > bytes) {
    joined = joined.slice(joined.length - Math.max(1, bytes));
    // Start on a whole line when one is in reach.
    const nl = joined.indexOf("\n");
    if (nl !== -1 && nl < joined.length - 1) joined = joined.slice(nl + 1);
    kept = joined.split("\n");
  }
  const dropped = all.length - kept.length;
  return dropped > 0 ? `[… ${dropped} earlier line${dropped === 1 ? "" : "s"} not shown …]\n${joined}` : joined;
}

/** The roster a gated step's prompt carries: what will be graded when its
 *  turn ends. One line per check, required ones marked. */
export function checkRoster(checks: readonly StepCheck[], ctx: { issueUrl?: string | null } = {}): string {
  return orderChecks(checks)
    .map((c) => {
      const line = `- \`${c.id}\`${c.required ? "" : " (reported, does not hold the step)"} — ${c.description}`;
      // The verdict is read from the handoff, so the step is shown its exact shape.
      return c.run.kind === "builtin" && c.run.name === "review-verdict" ? `${line}\n  ${reviewApprovalFormat(ctx.issueUrl ?? null)}` : line;
    })
    .join("\n");
}

/** The `reviewApproval` a gated Review must put in its handoff. */
export function reviewApprovalFormat(issueUrl: string | null): string {
  return (
    'In the handoff JSON add "reviewApproval":{"verdict":"approved"|"changes-requested","headSha":"<full 40-character git rev-parse HEAD>",' +
    `"issueUrl":${JSON.stringify(issueUrl ?? "<this card's issue URL>")},"acceptanceComplete":true|false,"findings":["…"]}. ` +
    'Use "approved" only with complete acceptance and no findings; otherwise list every finding and use "changes-requested".'
  );
}

/** The words around the roster. */
export const CHECK_ROSTER_INTRO =
  "When your turn ends these checks are run on the worktree, by the pipeline and not by you. The step is finished " +
  "when every required one passes; if one fails you get another turn here with its output. Leave the worktree so they pass:";

/** The placeholder a step's instructions may carry where the roster should
 *  go; without it the roster is its own section. */
export const CHECKS_PLACEHOLDER = "{{checks}}";

/** Each failed check as the step is told about it: id, description, exit
 *  code, the end of its output, and where the whole output is. The output
 *  budget is shared equally. */
export function renderCheckFailures(failed: readonly CheckResult[], unmet: readonly CheckResult[] = []): string {
  const share = Math.max(400, Math.floor(CHECK_LIMITS.feedbackBytes / Math.max(1, failed.length)));
  const parts: string[] = [];
  for (const r of failed) {
    const lines = [`### \`${r.check.id}\` — failed${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`, `What it checks: ${r.check.description}`, `Found: ${r.detail}`];
    const tail = outputTail(r.output, CHECK_LIMITS.tailLines, Math.min(CHECK_LIMITS.tailBytes, share));
    if (tail) lines.push("Output (the end of it):", "```", tail.replaceAll("```", "'''"), "```");
    if (r.outputPath) lines.push(`Whole output: ${r.outputPath}`);
    parts.push(lines.join("\n"));
  }
  for (const r of unmet) parts.push(`### \`${r.check.id}\` — ${r.detail}\nWhat it checks: ${r.check.description}`);
  return parts.join("\n\n");
}

/** The end of `text`: a step's last words are at the bottom. */
const lastChars = (text: string, max: number) => {
  const t = text.trim();
  return t.length > max ? `…${t.slice(t.length - max).trimStart()}` : t;
};

/** What marks a handoff as written by Agetor and not by the step's agent. */
export const COMPOSED_HANDOFF_MARK = "[Composed by Agetor — not written by the step's agent]";

/**
 * The handoff Agetor writes for a step that ended without one, after its one
 * reminder, with every required check passing: the run advances on the
 * checks, and the next step is told plainly whose words these are. The
 * summary is the step's final message.
 */
export function composedHandoff(input: { stepName: string; next: string | null; passed: readonly string[]; finalMessage: string }): Handoff {
  const said = lastChars(input.finalMessage, 4000);
  return {
    schemaVersion: 1,
    purpose: `${COMPOSED_HANDOFF_MARK} "${input.stepName}" ended without a handoff block; its required checks passed.`,
    summary: [
      COMPOSED_HANDOFF_MARK,
      `"${input.stepName}" ended its turn without a handoff block, also after one reminder. Its required checks passed ` +
        `(${input.passed.join(", ") || "none declared"}), so the run moved on.`,
      said ? `The step's final message, as it wrote it:\n\n${said}` : "The step's final message was empty.",
    ].join("\n\n"),
    reason:
      `${COMPOSED_HANDOFF_MARK} The checks show the worktree is in order; they do not show the work is complete. ` +
      "Read the summary as the step's unstructured last words, not as a report.",
    next: input.next,
    artifacts: [],
    openQuestions: [],
    status: "done",
  };
}

/**
 * The handoff a visit ends with when its required checks still fail after
 * its feedback turns: the arrival of the one fresh session of the same step.
 */
export function exhaustedHandoff(input: {
  stepName: string; turns: number; failed: readonly CheckResult[]; unmet: readonly CheckResult[]; lastWords: string;
}): Handoff {
  const ids = [...input.failed, ...input.unmet].map((r) => `\`${r.check.id}\``).join(", ");
  const said = lastChars(input.lastWords, 1500);
  return {
    schemaVersion: 1,
    purpose: `${COMPOSED_HANDOFF_MARK} "${input.stepName}" is started again in a fresh session: its required checks still fail.`,
    summary: [
      COMPOSED_HANDOFF_MARK,
      `The previous session of "${input.stepName}" ended with required checks failing (${ids}), also after ${input.turns} ` +
        `feedback turn${input.turns === 1 ? "" : "s"}. You are the one fresh session this step gets; if the checks still fail ` +
        "after your turns the card goes to its owner. The work so far is in the worktree — start by looking at it, do not start over.",
      renderCheckFailures(input.failed, input.unmet),
      said ? `The previous session's last words:\n\n${said}` : "",
    ].filter(Boolean).join("\n\n"),
    reason: `${COMPOSED_HANDOFF_MARK} Make the failing checks pass, then finish the step as its instructions say.`,
    next: input.stepName,
    artifacts: [...input.failed, ...input.unmet].map((r) => r.outputPath).filter((p): p is string => !!p),
    openQuestions: [],
    status: "done",
  };
}

/** A gate's failure in one line, for a block message or the card. */
export function gateFailureLine(verdict: Pick<GateVerdict, "failed" | "unmet">): string {
  return [...verdict.failed, ...verdict.unmet].map((r) => `${r.check.id} (${r.detail})`).join("; ");
}

/** The ledger's entries for one step, grouped by visit and turn, newest
 *  evaluation first — what the run view's Checks tab lists. */
export function ledgerEvaluations(ledger: readonly CheckLedgerEntry[], stepId: string | null): { seq: number; turn: number; at: number; entries: CheckLedgerEntry[] }[] {
  const groups = new Map<string, { seq: number; turn: number; at: number; entries: CheckLedgerEntry[] }>();
  for (const e of ledger) {
    if (stepId !== null && e.stepId !== stepId) continue;
    const k = `${e.stepId}\u0000${e.seq}\u0000${e.turn}`;
    const g = groups.get(k) ?? { seq: e.seq, turn: e.turn, at: e.at, entries: [] };
    g.entries.push(e);
    g.at = Math.max(g.at, e.at);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.seq - a.seq || b.turn - a.turn || b.at - a.at);
}
