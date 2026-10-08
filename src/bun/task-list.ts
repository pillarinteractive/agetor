// Shaping for the `GET /tasks` list route — kept out of server.ts so the
// lean-list rules can be unit-tested (and measured against a copy of a real
// DB) without booting the API server.
//
// The board polls `GET /tasks` every 2 s. Shipping every column of every row
// (archived history included, 10–30 KB pipeline step prompts included) made
// that poll ~20 MB per tick, so the webview asks for a LEAN list (`lean=1`):
//   - each `prompt` is cut to a LIST_PROMPT_PREVIEW_CHARS preview and the
//     row flagged `promptTruncated: true` (absent when the prompt fit) —
//     anything that shows or uses the whole prompt reads `GET /tasks/:id`;
//   - archived rows are left out (skipped in SQL, never even parsed) unless
//     `archived=1` asks for archived board cards (the "All"/"Archived"
//     filter). Archived hidden pipeline STEP rows never ride the lean list —
//     the run view reads them from `GET /tasks/:id/pipeline`;
//   - `include=<id>,<id>` keeps the named rows whatever their state (the
//     open run panel / pipeline run view, so archiving the task you're
//     looking at doesn't make it vanish from under you).
// Without `lean=1` the route keeps its legacy full shape, so an older
// `agetor` CLI binary (which polls the same route) is unaffected.
import { handoffHeadline } from "../shared/pipeline.ts";
import type { PipelineRunState, Task } from "../shared/types.ts";

/** Characters of `prompt` the lean list keeps — enough for the card search
 *  hay and any preview, a small fraction of a pipeline step's prompt. */
export const LIST_PROMPT_PREVIEW_CHARS = 2_000;

/** Cap on `include=` ids — the webview sends at most two. */
const MAX_INCLUDE_IDS = 20;

export interface TaskListOptions {
  /** Truncate prompts to a preview (`promptTruncated` marks cut rows) and
   *  leave archived rows out unless `includeArchived`. */
  lean: boolean;
  /** Lean mode only: also return archived board cards (not archived steps). */
  includeArchived: boolean;
  /** Lean mode only: rows returned whatever their archived state. */
  includeIds: string[];
}

export const FULL_TASK_LIST: TaskListOptions = { lean: false, includeArchived: true, includeIds: [] };

const truthy = (v: string | null): boolean => v === "1" || v === "true";

/** Parse the list route's query string. Absent params keep the legacy full
 *  shape. */
export function parseTaskListOptions(url: URL): TaskListOptions {
  if (!truthy(url.searchParams.get("lean"))) return FULL_TASK_LIST;
  const includeIds = (url.searchParams.get("include") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 128)
    .slice(0, MAX_INCLUDE_IDS);
  return { lean: true, includeArchived: truthy(url.searchParams.get("archived")), includeIds };
}

/** Which archived rows `tasks.list()` should read for these options. */
export function archivedRowsFor(opts: TaskListOptions): "all" | "cards" | "none" {
  if (!opts.lean) return "all";
  return opts.includeArchived ? "cards" : "none";
}

/** The prompt fields a list row carries: the full prompt, or a preview plus
 *  `promptTruncated: true`. Cuts on a UTF-16 boundary that never splits a
 *  surrogate pair. */
export function listPromptFields(
  prompt: string,
  opts: TaskListOptions,
): { prompt: string; promptTruncated?: true } {
  if (!opts.lean || prompt.length <= LIST_PROMPT_PREVIEW_CHARS) return { prompt };
  return { prompt: preview(prompt, LIST_PROMPT_PREVIEW_CHARS), promptTruncated: true };
}

/**
 * The trimmed `Task.pipelineRun` variant `GET /tasks` ships (M-S3, see the
 * field's doc in `shared/types.ts`): every history handoff is cut to its
 * headline (`handoffHeadline`), partial-join arrival handoffs are nulled and
 * the frozen profile snapshots dropped,
 * since the board/TUI/`agetor ls` only read `snapshot.graph`, `status`,
 * `active`, `blocked`, history outcomes and `stepCount` — and the 2s poll
 * was otherwise shipping every handoff of every pipeline task on every
 * tick. `GET /tasks/:id` and `GET /tasks/:id/pipeline` still return the
 * full state; the server's own `tasks.list()`/`get()` reads are untouched.
 */
export function trimPipelineRunForList(run: PipelineRunState): PipelineRunState {
  const joins: PipelineRunState["joins"] = {};
  for (const [stepId, join] of Object.entries(run.joins)) {
    joins[stepId] = { arrivals: join.arrivals.map((a) => ({ ...a, handoff: null })) };
  }
  return {
    ...run,
    snapshot: run.snapshot ? { ...run.snapshot, profiles: {} } : null,
    // Keep each step's headline (status, next, first summary line) so a card
    // can say what its run did without the full handoff on every poll.
    history: run.history.map((h) => ({
      ...h,
      handoff: h.handoff
        ? {
            schemaVersion: 1 as const,
            purpose: "",
            summary: handoffHeadline(h.handoff),
            reason: "",
            next: h.handoff.next,
            artifacts: [],
            openQuestions: [],
            ...(h.handoff.status ? { status: h.handoff.status } : {}),
          }
        : null,
    })),
    joins,
  };
}

/** Characters of a step's frozen `agentProfile.instructions` the lean list
 *  keeps (`agentProfileTruncated` marks cut rows) — the card/chip never shows
 *  them; the run panel's agent details dialog reads `GET /tasks/:id`. */
export const LIST_PROFILE_INSTRUCTIONS_PREVIEW_CHARS = 300;

/** Cut `s` to at most `max` UTF-16 units without splitting a surrogate pair. */
function preview(s: string, max: number): string {
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** The stored-field part of a list row (prompt preview, trimmed pipeline
 *  run, trimmed profile snapshot). The route layers its live decorations
 *  (subagent counts, stalls, dependencies, …) on top. */
export function shapeTaskForList(t: Task, opts: TaskListOptions): Task {
  const out: Task = {
    ...t,
    ...listPromptFields(t.prompt, opts),
    ...(t.pipelineRun ? { pipelineRun: trimPipelineRunForList(t.pipelineRun) } : {}),
  };
  if (opts.lean && t.agentProfile && t.agentProfile.instructions.length > LIST_PROFILE_INSTRUCTIONS_PREVIEW_CHARS) {
    out.agentProfile = {
      ...t.agentProfile,
      instructions: preview(t.agentProfile.instructions, LIST_PROFILE_INSTRUCTIONS_PREVIEW_CHARS),
    };
    out.agentProfileTruncated = true;
  }
  return out;
}

/** Whether a PATCH body would write a lean-list prompt preview over the real
 *  prompt: it carries `prompt` together with the list row's
 *  `promptTruncated` flag, or its `prompt` is exactly the preview the lean
 *  list makes of a longer stored prompt (a list object sent back without the
 *  flag). The route refuses such a write. */
export function isTruncatedPromptWrite(raw: unknown, storedPrompt: string): boolean {
  if (!raw || typeof raw !== "object" || !("prompt" in raw)) return false;
  const body = raw as { prompt?: unknown; promptTruncated?: unknown };
  if (body.promptTruncated === true) return true;
  return (
    typeof body.prompt === "string"
    && storedPrompt.length > LIST_PROMPT_PREVIEW_CHARS
    && body.prompt !== storedPrompt
    && body.prompt === preview(storedPrompt, LIST_PROMPT_PREVIEW_CHARS)
  );
}
