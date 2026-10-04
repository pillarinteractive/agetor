/**
 * Orchestrator suggestions, layer 1: deterministic rules that recognise the
 * situations a person kept fixing by hand and propose the fix, ready to
 * apply. Nothing runs until the user clicks Apply, and a suggestion is
 * recomputed from the current state at apply time, so a stale button can't
 * act on something that already moved on.
 *
 * Rules:
 * - A step blocked because tests couldn't load their environment
 *   (`DATABASE_URL`, `.env.local`) → message the step to rerun with CI's
 *   placeholder.
 * - A step blocked on a lease that is free again → Retry.
 * - A PR behind its base, failing only on checks the base has since fixed →
 *   Update branch.
 * - A finished pipeline with no PR, when an "Open PR" preset exists → run it.
 * - A step blocked on open questions → surface the first question.
 */
import type { LeaseStatus, Task, TaskPrStatus } from "../shared/types.ts";
import { handoffHeadline } from "../shared/pipeline.ts";
import { runs, tasks } from "./db.ts";
import { listLeases } from "./lease-watch.ts";
import { prStatusForTask, staleAgainstBase } from "./pr-watch.ts";
import { parseFollowUpPresets, FOLLOW_UPS_PREF, startFollowUp } from "./pipeline-followups.ts";
import { preferences } from "./db.ts";
import { sendInput } from "./orchestrator.ts";
import { retryPipelineStep } from "./pipeline-runner.ts";
import { updateGitHubPullBranch } from "./github.ts";
import { recordActivity } from "./activity.ts";

export type SuggestionApply =
  | { kind: "message"; stepTaskId: string; text: string }
  | { kind: "retry" }
  | { kind: "update-branch"; number: number }
  | { kind: "followup"; presetId: string }
  | { kind: "open" };

export interface Suggestion {
  /** Stable for the same situation, so the UI can key on it. */
  id: string;
  taskId: string;
  taskTitle: string;
  /** What to do, in a few words — the button's sentence. */
  title: string;
  /** Why, in a sentence. */
  detail: string;
  apply: SuggestionApply;
}

export const ENV_UNBLOCK_MESSAGE =
  "You're unblocked — this isn't a real verification failure. apps/web/src/db only needs DATABASE_URL set at import " +
  "time; no unit suite connects (they all mock @/db), and CI runs them with a placeholder. Re-run the checks like CI, " +
  "e.g. from apps/web: `DATABASE_URL=postgres://pillar:pillar@127.0.0.1:5432/pillar_ci pnpm test`, then lint and " +
  "typecheck. Running the repo's own test commands is fine even though they load .env.local internally — you're not " +
  "reading the file yourself. Then carry on with your step and hand off.";

const ENV_PATTERN = /DATABASE_URL|\.env\.local|\benv(ironment)? file\b|test environment|permitted test env/i;
const LEASE_PATTERN = /\blease\b|\blab\b|plab|held by/i;

function blockText(task: Task): { stepTaskId: string | null; stepName: string; text: string; questions: string[] } | null {
  const run = task.pipelineRun;
  const block = run?.status === "blocked" ? run.blocked[0] : undefined;
  if (!run || !block) return null;
  const record = [...run.history].reverse().find((r) => r.taskId === block.taskId) ?? null;
  const h = record?.handoff;
  const stepName = run.snapshot?.graph.steps.find((s) => s.id === block.stepId)?.name ?? block.stepId ?? "a step";
  const text = [block.message, h?.summary, h?.reason, ...(h?.openQuestions ?? [])].filter(Boolean).join("\n");
  return { stepTaskId: block.taskId, stepName, text, questions: h?.openQuestions ?? [] };
}

/** The suggestion for one card, if any. Pure; exported for tests. */
export function suggestFor(
  task: Task,
  ctx: { pr: TaskPrStatus | null; leases: LeaseStatus[]; hasOpenPrPreset: boolean },
): Suggestion | null {
  const base = { taskId: task.id, taskTitle: task.title };
  const block = blockText(task);

  if (block?.stepTaskId && ENV_PATTERN.test(block.text)) {
    return {
      ...base,
      id: `env-unblock:${block.stepTaskId}`,
      title: `Unblock ${block.stepName}: rerun tests with CI's placeholder DATABASE_URL`,
      detail: `${block.stepName} stopped because the web tests couldn't load their environment — not a real failure.`,
      apply: { kind: "message", stepTaskId: block.stepTaskId, text: ENV_UNBLOCK_MESSAGE },
    };
  }

  if (block && LEASE_PATTERN.test(block.text)) {
    const lease = ctx.leases.find((l) => l.project.replace(/\/+$/, "") === task.workdir.replace(/\/+$/, ""));
    if (lease && !lease.held && !lease.error) {
      return {
        ...base,
        id: `lease-retry:${block.stepTaskId ?? task.id}`,
        title: `Retry ${block.stepName} — the ${lease.label} is free`,
        detail: `${block.stepName} was waiting for the ${lease.label}, which has been released.`,
        apply: { kind: "retry" },
      };
    }
  }

  if (ctx.pr && ctx.pr.state === "open" && staleAgainstBase(ctx.pr)) {
    return {
      ...base,
      id: `update-branch:${ctx.pr.number}:${ctx.pr.headSha ?? ""}`,
      title: `Update PR #${ctx.pr.number}'s branch from ${ctx.pr.baseRef ?? "base"}`,
      detail: `It's ${ctx.pr.behindBy} commit(s) behind, and its failing checks pass on ${ctx.pr.baseRef ?? "base"} now.`,
      apply: { kind: "update-branch", number: ctx.pr.number },
    };
  }

  const run = task.pipelineRun;
  if (run?.status === "done" && !ctx.pr && !task.prUrl && task.column === "review" && ctx.hasOpenPrPreset) {
    const committed = run.history.some((r) => /commit/i.test(handoffHeadline(r.handoff)));
    if (committed) {
      return {
        ...base,
        id: `open-pr:${task.id}:${run.stepCount}`,
        title: "Open a PR for this work",
        detail: "The run finished with committed changes and no pull request yet.",
        apply: { kind: "followup", presetId: "pr" },
      };
    }
  }

  if (block && block.questions.length > 0) {
    return {
      ...base,
      id: `question:${block.stepTaskId ?? task.id}:${block.questions[0]!.slice(0, 40)}`,
      title: `${block.stepName} asks: ${block.questions[0]}`,
      detail: "Answer by messaging the step, or Retry / Advance once it's resolved.",
      apply: { kind: "open" },
    };
  }
  return null;
}

function hasOpenPrPreset(): boolean {
  return parseFollowUpPresets(preferences.get(FOLLOW_UPS_PREF)).some((p) => p.id === "pr");
}

export function listSuggestions(): Suggestion[] {
  const leases = listLeases();
  const openPr = hasOpenPrPreset();
  return tasks
    .list()
    .filter((t) => t.archivedAt == null && !t.pipelineParentId)
    .flatMap((t) => {
      const s = suggestFor(t, { pr: prStatusForTask(t.id), leases, hasOpenPrPreset: openPr });
      return s ? [s] : [];
    });
}

export async function applySuggestion(
  taskId: string,
  id: string,
): Promise<{ ok: true; message: string } | { error: string; status: 404 | 409 | 502 }> {
  const s = listSuggestions().find((x) => x.taskId === taskId && x.id === id);
  if (!s) return { error: "that suggestion no longer applies — the card has moved on", status: 409 };
  let result: { ok: true; message: string } | { error: string; status: 404 | 409 | 502 };
  switch (s.apply.kind) {
    case "message": {
      const step = tasks.get(s.apply.stepTaskId);
      const runId = step?.runId ?? runs.listForTask(s.apply.stepTaskId)[0]?.id ?? null;
      if (!runId) return { error: "the step has no session to message", status: 409 };
      const sent = await sendInput(runId, s.apply.text);
      result = sent.delivered ? { ok: true, message: "Sent — the step is resuming." } : { error: sent.reason ?? "couldn't deliver the message", status: 409 };
      break;
    }
    case "retry": {
      const r = await retryPipelineStep(taskId);
      result = "error" in r ? { error: r.error, status: 409 } : { ok: true, message: "Retrying." };
      break;
    }
    case "update-branch": {
      const task = tasks.get(taskId)!;
      const r = await updateGitHubPullBranch({ dir: task.workdir, number: s.apply.number });
      result = r.ok ? { ok: true, message: r.message ?? "Branch update requested — CI will re-run." } : { error: r.error, status: 502 };
      break;
    }
    case "followup": {
      const r = await startFollowUp(taskId, { presetId: s.apply.presetId });
      result = "error" in r ? { error: r.error, status: 409 } : { ok: true, message: "Started." };
      break;
    }
    case "open":
      return { error: "this one needs you — open the card", status: 409 };
  }
  if ("ok" in result) recordActivity(taskId, { kind: "auto", text: `Applied suggestion: ${s.title}`, tone: "info" });
  return result;
}
