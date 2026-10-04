/**
 * Orchestrator suggestions, layer 1: deterministic rules that recognise the
 * situations a person kept fixing by hand and propose the fix, ready to
 * apply. Nothing runs until the user clicks Apply, and a suggestion is
 * recomputed from the current state at apply time, so a stale button can't
 * act on something that already moved on.
 *
 * Rules (known causes of blocks are fixed at the source — worktree setup,
 * the web tests' placeholder DATABASE_URL — not patched over here):
 * - A step blocked on a lease that is free again → Retry.
 * - A PR behind its base, failing only on checks the base has since fixed →
 *   Update branch (only when the PR watcher isn't doing that itself).
 * - A finished pipeline with no PR, when an "Open PR" preset exists → run it.
 * - A step blocked on open questions → surface the first question.
 */
import type { LeaseStatus, Task, TaskPrStatus } from "../shared/types.ts";
import { handoffHeadline } from "../shared/pipeline.ts";
import { runs, tasks } from "./db.ts";
import { listLeases } from "./lease-watch.ts";
import { blockInfo, blockMentionsLease } from "../shared/block-reason.ts";
import { PR_AUTOUPDATE_PREF, prStatusForTask, staleAgainstBase } from "./pr-watch.ts";
import { parseFollowUpPresets, FOLLOW_UPS_PREF, startFollowUp } from "./pipeline-followups.ts";
import { preferences } from "./db.ts";
import { sendInput } from "./orchestrator.ts";
import { retryPipelineStep } from "./pipeline-runner.ts";
import { updateGitHubPullBranch } from "./github.ts";
import { recordActivity } from "./activity.ts";
import { blockedByFor, readDependencies } from "./dependencies.ts";

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

/** The suggestion for one card, if any. Pure; exported for tests. */
export function suggestFor(
  task: Task,
  ctx: { pr: TaskPrStatus | null; leases: LeaseStatus[]; hasOpenPrPreset: boolean; autoUpdatesBranches?: boolean },
): Suggestion | null {
  const base = { taskId: task.id, taskTitle: task.title };
  const block = blockInfo(task);

  if (block) {
    const lease = ctx.leases.find(
      (l) => l.project.replace(/\/+$/, "") === task.workdir.replace(/\/+$/, "") && blockMentionsLease(block.text, l.label),
    );
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

  // The PR watcher updates stale branches itself unless that's turned off.
  if (!ctx.autoUpdatesBranches && ctx.pr && ctx.pr.state === "open" && staleAgainstBase(ctx.pr)) {
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
  const autoUpdatesBranches = preferences.get(PR_AUTOUPDATE_PREF) !== "false";
  const deps = readDependencies();
  return tasks
    .list()
    .filter((t) => t.archivedAt == null && !t.pipelineParentId)
    // A card waiting on another card moves on by itself when that lands —
    // nothing to suggest meanwhile (src/bun/dependencies.ts).
    .filter((t) => !(blockedByFor(t.id, deps) ?? []).some((d) => !d.satisfied))
    .flatMap((t) => {
      const s = suggestFor(t, { pr: prStatusForTask(t.id), leases, hasOpenPrPreset: openPr, autoUpdatesBranches });
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
