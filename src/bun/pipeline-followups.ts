/**
 * Follow-ups for finished pipelines: the presets the run view offers ("Open
 * PR", "Run VM tests", "Explain …"), which of them the branch's changes make
 * worth suggesting, and turning a pick into a `runPipelineFollowUp` call.
 *
 * Presets come from the `pipeline_followups` preference (a JSON array of
 * {@link FollowUpPreset}); a preset is "suggested" when the branch changed a
 * file matching one of its `suggestWhen` globs. Nothing runs on its own —
 * suggestions only highlight a button.
 */
import type { FollowUpAction, FollowUpPreset, Task } from "../shared/types.ts";
import { agentProfiles, preferences } from "./db.ts";
import { runPipelineFollowUp } from "./pipeline-runner.ts";

export const FOLLOW_UPS_PREF = "pipeline_followups";
const MATCHED_SAMPLE = 3;

export function parseFollowUpPresets(raw: string | null | undefined): FollowUpPreset[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FollowUpPreset[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const id = str(o.id);
    const label = str(o.label);
    const agent = str(o.agent);
    const prompt = str(o.prompt);
    if (!id || !label || !agent || !prompt || seen.has(id)) continue;
    seen.add(id);
    const suggestWhen = Array.isArray(o.suggestWhen)
      ? o.suggestWhen.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : undefined;
    out.push({ id, label, agent, prompt, suggestWhen, requiresRequest: o.requiresRequest === true });
  }
  return out;
}

/** `**` crosses directories, `*` and `?` don't; a pattern with no slash
 *  matches the file name in any directory (`*.md`). */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes("/") ? glob.replace(/^\/+/, "") : `**/${glob}`;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches zero directories.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function suggestFollowUps(
  presets: FollowUpPreset[],
  changedFiles: string[],
  agentIdByName: (name: string) => string | null,
): FollowUpAction[] {
  return presets.map((p) => {
    const patterns = (p.suggestWhen ?? []).map(globToRegExp);
    const matched = patterns.length ? changedFiles.filter((f) => patterns.some((re) => re.test(f))) : [];
    return {
      id: p.id,
      label: p.label,
      agentName: p.agent,
      agentId: agentIdByName(p.agent),
      requiresRequest: p.requiresRequest === true,
      suggested: matched.length > 0,
      matched: matched.slice(0, MATCHED_SAMPLE),
    };
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : "";
}

/** Files the task's branch changed against its base: committed, staged,
 *  unstaged and untracked. Empty when the worktree isn't there. */
export async function changedFilesForTask(task: Task): Promise<string[]> {
  const cwd = task.worktreePath ?? task.workdir;
  const files = new Set<string>();
  if (task.baseRef) {
    for (const f of (await git(cwd, ["diff", "--name-only", task.baseRef])).split("\n")) if (f) files.add(f);
  }
  for (const f of (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n")) if (f) files.add(f);
  return [...files].sort();
}

function agentIdByName(name: string): string | null {
  const key = name.toLowerCase();
  return agentProfiles.list().find((p) => p.name.toLowerCase() === key)?.id ?? null;
}

export async function listFollowUps(task: Task): Promise<{ actions: FollowUpAction[]; changedFiles: number }> {
  const presets = parseFollowUpPresets(preferences.get(FOLLOW_UPS_PREF));
  const changed = await changedFilesForTask(task);
  return { actions: suggestFollowUps(presets, changed, agentIdByName), changedFiles: changed.length };
}

/** Run a preset (optionally with the user's extra request) or a custom
 *  request with a chosen agent. */
export async function startFollowUp(
  parentId: string,
  body: { presetId?: unknown; profileId?: unknown; request?: unknown },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (typeof body.presetId === "string" && body.presetId) {
    const preset = parseFollowUpPresets(preferences.get(FOLLOW_UPS_PREF)).find((p) => p.id === body.presetId);
    if (!preset) return { error: "unknown follow-up", status: 400 };
    if (preset.requiresRequest && !request) return { error: `${preset.label} needs a request`, status: 400 };
    const profileId = agentIdByName(preset.agent);
    if (!profileId) return { error: `agent "${preset.agent}" not found`, status: 400 };
    const instructions = request ? `${preset.prompt}\n\n## The user's request\n${request}` : preset.prompt;
    return runPipelineFollowUp(parentId, { profileId, name: preset.label, instructions });
  }
  if (typeof body.profileId !== "string" || !body.profileId) return { error: "presetId or profileId required", status: 400 };
  if (!request) return { error: "request required", status: 400 };
  const name = request.split("\n")[0]!.slice(0, 40) + (request.length > 40 ? "…" : "");
  return runPipelineFollowUp(parentId, {
    profileId: body.profileId,
    name,
    instructions: `A follow-up the user asked for after the pipeline finished:\n\n${request}`,
  });
}
