/**
 * Finding a run's position — the half that reads the worktree and the files
 * beside the run (docs/plans/check-gated-pipeline.md §6 and §7; the walk and
 * every judgement are in src/shared/position.ts).
 *
 * {@link readPosition} gathers what the walk needs and starts nothing: the
 * built-in checks are recomputed with a few `git` reads, the pull request's
 * required check is read from GitHub only for a Finish that Agetor ran, and
 * no command check is executed. {@link voidStepEvidence} appends a rewind's
 * `void` lines to the check ledger. The owner's notes are kept in
 * `<data dir>/pipeline-runs/<card>/feedback-<generation>.jsonl`, append-only
 * and beside the run for the ledger's reason: a build that does not know
 * them cannot erase them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { builtinCheck } from "../shared/checks.ts";
import { defaultChecksOf, promptCarriesGoal, stepGate } from "../shared/pipeline.ts";
import {
  forwardPath, parseFeedbackLog, resolvePosition, stepsFrom, voidEntries, type OwnerFeedback, type Position, type StepEvidence,
} from "../shared/position.ts";
import { publishStepOf } from "../shared/publish.ts";
import type { CheckLedgerEntry, PipelineRunSnapshot, PipelineRunState, PipelineStep, StepCheck, Task } from "../shared/types.ts";
import { appendCheckLedger, checkDeps, probeBuiltinChecks, readCheckLedger } from "./check-runner.ts";
import { dataDir, preferences, tasks } from "./db.ts";

/** What a position is read with — replaceable in tests. */
export const positionDeps = {
  /** When the card's issue contract was last seen to change after it was
   *  dispatched (`autopilot_card_inputs_v1`, written at each step launch by
   *  `reconcileCardInputs`); null for a card with no such record. */
  issueChangedAt(taskId: string): number | null {
    try {
      const facts = JSON.parse(preferences.get("autopilot_card_inputs_v1") ?? "{}") as Record<string, { changes?: { at?: unknown }[] }>;
      const at = (facts[taskId]?.changes ?? []).map((c) => c.at).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      return at.length > 0 ? Math.max(...at) : null;
    } catch {
      return null;
    }
  },
  /** The prompt a step task was launched with; null when the row is gone. */
  stepPrompt: (taskId: string): string | null => tasks.get(taskId)?.prompt ?? null,
};

/**
 * The checks that decide `step` for a position: its gate's when the run
 * adopted the `steps` gate; otherwise — a run that adopted only `publish` —
 * the defaults for Build and Review of a reviewed pipeline, which is what
 * the design's table reads from the tree (§6). Any other step has none.
 * `history` is the run's (`defaultChecksOf`).
 */
export function positionChecks(snapshot: Pick<PipelineRunSnapshot, "graph" | "gates">, step: PipelineStep, history: PipelineRunState["history"] = []): StepCheck[] {
  if (snapshot.gates?.steps) return stepGate(snapshot, step, history)?.checks ?? [];
  return defaultChecksOf(snapshot.graph, step, history);
}

/**
 * Where `run` stands now, judged with `snapshot`'s graph and gates (the
 * run's own, or the fresh one a restart is about to take — a check whose
 * definition changed is then a different check). Reads only.
 */
export async function readPosition(input: {
  parent: Task; run: PipelineRunState; snapshot: PipelineRunSnapshot; publishOn: boolean;
}): Promise<Position> {
  const { parent, run, snapshot } = input;
  const path = forwardPath(snapshot.graph, run.history);
  if (!path) return resolvePosition({ graph: snapshot.graph, history: run.history, ledger: [], key: { head: null, tree: null, baseTip: null }, evidence: {}, inputs: { goalUnchanged: false, issueChangedAt: null } });

  const evidence: Record<string, StepEvidence> = {};
  let key = { head: null as string | null, tree: null as string | null, baseTip: null as string | null };
  let read = false;
  for (const step of path) {
    const checks = positionChecks(snapshot, step, run.history);
    const probe = await probeBuiltinChecks({ parent, run, checks });
    if (!read) {
      key = probe.key;
      read = true;
    }
    evidence[step.id] = { checks, now: probe.now };
  }
  if (!read) key = (await probeBuiltinChecks({ parent, run, checks: [] })).key;

  // Finish run by Agetor: what it published, and the required check as
  // GitHub has it for HEAD now.
  const publishStep = input.publishOn ? publishStepOf(snapshot) : null;
  let publish: Parameters<typeof resolvePosition>[0]["publish"] = null;
  if (publishStep) {
    const p = run.publish?.stepId === publishStep.id ? run.publish : undefined;
    let requiredPassed = false;
    if (p?.head && key.head && p.head.toLowerCase() === key.head.toLowerCase()) {
      const probe = await probeBuiltinChecks({ parent, run, checks: [builtinCheck("pr-required-check")] });
      requiredPassed = probe.now["pr-required-check"]?.outcome === "pass";
    }
    publish = { stepId: publishStep.id, head: p?.head ?? null, approvedHead: p?.approvedHead ?? null, carried: p?.carried ?? 0, requiredPassed };
  }

  // The start step has no gate: its handoff is reused when it worked from
  // the goal the card has now. The goal is in its prompt, word for word.
  const start = path[0]!;
  const startRec = run.history.filter((h) => h.stepId === start.id && (h.outcome === "succeeded" || h.outcome === "advanced-manually") && h.handoff).sort((a, b) => b.seq - a.seq)[0];
  const startPrompt = startRec ? positionDeps.stepPrompt(startRec.taskId) : null;
  const goalUnchanged = !!startPrompt && promptCarriesGoal(startPrompt, parent.prompt);

  return resolvePosition({
    graph: snapshot.graph, history: run.history, ledger: readCheckLedger(parent.id, run), key, evidence, publish,
    inputs: { goalUnchanged, issueChangedAt: positionDeps.issueChangedAt(parent.id) },
  });
}

/**
 * Void the gate evidence of `fromStepId` and every step after it on the
 * run's path: `void` lines appended to the ledger, nothing removed. Returns
 * the steps voided. Throws when the ledger cannot be written — a rewind that
 * is not on record must not move the run.
 */
export function voidStepEvidence(input: { parent: Task; run: PipelineRunState; snapshot: PipelineRunSnapshot; fromStepId: string; why: string }): PipelineStep[] {
  const path = forwardPath(input.snapshot.graph, input.run.history) ?? [];
  const steps = stepsFrom(path, input.fromStepId);
  const ledger = readCheckLedger(input.parent.id, input.run);
  const entries: CheckLedgerEntry[] = voidEntries({
    at: checkDeps.now(), seq: input.run.stepCount, why: input.why, ledger,
    steps: steps.map((step) => ({ step, checks: positionChecks(input.snapshot, step, input.run.history) })),
  });
  appendCheckLedger(input.parent.id, input.run, entries);
  return steps;
}

// ---------------------------------------------------------------------------
// The owner's notes
// ---------------------------------------------------------------------------

const generationOf = (run: Pick<PipelineRunState, "startedAt">) => (run.startedAt ?? 0).toString(36);

export function feedbackLogPath(parentId: string, run: Pick<PipelineRunState, "startedAt">): string {
  return join(dataDir, "pipeline-runs", parentId, `feedback-${generationOf(run)}.jsonl`);
}

/** The run's notes, oldest first. Empty when there are none. */
export function readFeedback(parentId: string, run: Pick<PipelineRunState, "startedAt">): OwnerFeedback[] {
  const file = feedbackLogPath(parentId, run);
  if (!existsSync(file)) return [];
  try {
    return parseFeedbackLog(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** Record a note. Throws when it cannot be written. */
export function appendFeedback(parentId: string, run: Pick<PipelineRunState, "startedAt" | "stepCount">, input: { fromStepId: string; note: string; invalidate: boolean }): OwnerFeedback {
  const entry: OwnerFeedback = { id: randomUUID(), at: checkDeps.now(), fromStepId: input.fromStepId, note: input.note, invalidate: input.invalidate, seq: run.stepCount };
  mkdirSync(join(dataDir, "pipeline-runs", parentId), { recursive: true });
  appendFileSync(feedbackLogPath(parentId, run), `${JSON.stringify(entry)}\n`);
  return entry;
}
