/**
 * Quota fallback: when a harness hits its usage limit, run its steps on a
 * backup harness until the limit resets.
 *
 * Configured by the `quota_fallback` preference:
 *   {"enabled": true, "from": ["claude-code"], "harness": "claude-deepseek"}
 * `from` lists the harness ids (or kinds) that fall back; `harness` is the id
 * of an enabled harness of the same kind to use instead (for example a Claude
 * Code alias whose `bin` points the CLI at another provider's
 * Anthropic-compatible endpoint). Nothing happens while the preference is
 * unset, disabled, or names a harness that does not exist or is disabled.
 *
 * A limit is remembered in the `quota_fallback_until` preference (harness id
 * → epoch ms), so steps created while it lasts start on the backup directly
 * instead of failing on the limited harness first, and a core restart keeps
 * that. With no reset time in the limit message the window is 15 minutes.
 *
 * Optional early switch: `"atPercent": 92` moves new steps to the backup as
 * soon as the harness's latest usage snapshot shows a meter at or above that
 * percentage, instead of waiting for the limit message. `"meters"` names the
 * meter ids that count (for example ["session", "weekly_all"]); without it
 * every meter that is not scoped to one model counts. A meter whose reset
 * time has passed is ignored, so steps return to the primary harness once
 * the window resets. Steps already running are not moved.
 *
 * Several harnesses: the preference may be a list of such rules, for example
 *   [{"enabled": true, "from": ["claude-code"], "harness": "claude-deepseek", "atPercent": 92},
 *    {"enabled": true, "from": ["codex"], "harness": "claude-deepseek", "model": "opus-5.5", "atPercent": 92}]
 * The first enabled rule that covers a harness applies to it.
 *
 * A backup of another kind (Codex steps on a Claude Code harness) is used only
 * when its rule names `"model"`, the backup's model for those steps: the
 * profile's own model belongs to the other provider. The step keeps its
 * effort where the backup's kind accepts it, and runs in that kind's default
 * mode (pipeline-runner.ts `launchOnFallback`).
 */
import { harnesses, harnessUsage, preferences } from "./db.ts";

export const QUOTA_FALLBACK_PREF = "quota_fallback";
export const QUOTA_FALLBACK_UNTIL_PREF = "quota_fallback_until";
/** Assumed length of a limit whose message gives no reset time. */
export const UNKNOWN_RESET_WINDOW_MS = 15 * 60_000;

export interface QuotaFallbackConfig {
  enabled: boolean;
  from: string[];
  harness: string;
  /** Switch new steps to the backup at this usage percentage (1..100). */
  atPercent?: number;
  /** Meter ids that count toward `atPercent`; default: every unscoped meter. */
  meters?: string[];
  /** The model to run on a backup of another kind; required for one. */
  model?: string;
}

export function parseQuotaFallback(raw: string | null | undefined): QuotaFallbackConfig | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const harness = typeof v.harness === "string" ? v.harness.trim() : "";
    const from = Array.isArray(v.from) ? v.from.filter((s: unknown): s is string => typeof s === "string" && !!s.trim()) : ["claude-code"];
    if (v.enabled !== true || !harness || from.length === 0) return null;
    const atPercent = typeof v.atPercent === "number" && v.atPercent >= 1 && v.atPercent <= 100 ? v.atPercent : undefined;
    const meters = Array.isArray(v.meters) ? v.meters.filter((s: unknown): s is string => typeof s === "string" && !!s.trim()) : [];
    const model = typeof v.model === "string" ? v.model.trim() : "";
    return { enabled: true, from, harness, ...(atPercent !== undefined ? { atPercent } : {}), ...(atPercent !== undefined && meters.length ? { meters } : {}), ...(model ? { model } : {}) };
  } catch {
    return null;
  }
}

/** Every enabled rule in the preference, in order: one object or a list of them. */
export function parseQuotaFallbackRules(raw: string | null | undefined): QuotaFallbackConfig[] {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  const items = Array.isArray(v) ? v : v ? [v] : [];
  return items.map((item) => parseQuotaFallback(JSON.stringify(item))).filter((r): r is QuotaFallbackConfig => r !== null);
}

/** What a step on a covered harness starts on instead. `model` is set only
 *  for a backup of another kind, and replaces the profile's model there. */
export interface QuotaFallback {
  harness: string;
  model: string | null;
  rule: QuotaFallbackConfig;
}

/** The first rule covering `agent` whose backup is usable, or null: none
 *  covers it, the backup is missing, disabled or `agent` itself, or it is of
 *  another kind and the rule names no model for it. */
export function quotaFallbackFor(agent: string): QuotaFallback | null {
  const primary = harnesses.getByIdOrKind(agent);
  if (!primary) return null;
  for (const rule of parseQuotaFallbackRules(preferences.get(QUOTA_FALLBACK_PREF))) {
    if (agent === rule.harness || !(rule.from.includes(agent) || rule.from.includes(primary.kind))) continue;
    const backup = harnesses.get(rule.harness);
    if (!backup || !backup.enabled) continue;
    if (backup.kind === primary.kind) return { harness: backup.id, model: null, rule };
    if (rule.model) return { harness: backup.id, model: rule.model, rule };
  }
  return null;
}

function readUntil(): Record<string, number> {
  try {
    const v = JSON.parse(preferences.get(QUOTA_FALLBACK_UNTIL_PREF) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The backup harness id for steps on `agent`, or null when none applies
 *  (see {@link quotaFallbackFor}). */
export function fallbackHarnessFor(agent: string): string | null {
  return quotaFallbackFor(agent)?.harness ?? null;
}

/** Remember that `agent` is at its usage limit until `resetAt`. */
export function noteQuotaLimit(agent: string, resetAt: number | null, now: number = Date.now()): void {
  const until = readUntil();
  until[agent] = Math.max(until[agent] ?? 0, resetAt && resetAt > now ? resetAt : now + UNKNOWN_RESET_WINDOW_MS);
  preferences.set(QUOTA_FALLBACK_UNTIL_PREF, JSON.stringify(until));
}

/** Whether a remembered limit on `agent` is still in effect. */
export function quotaLimited(agent: string, now: number = Date.now()): boolean {
  return (readUntil()[agent] ?? 0) > now;
}

/** The first rule that lists `agent` (or its kind), usable backup or not. */
function quotaRuleCovering(agent: string): QuotaFallbackConfig | null {
  const kind = harnesses.getByIdOrKind(agent)?.kind;
  return parseQuotaFallbackRules(preferences.get(QUOTA_FALLBACK_PREF))
    .find((r) => agent !== r.harness && (r.from.includes(agent) || (!!kind && r.from.includes(kind)))) ?? null;
}

/** Whether `agent`'s latest usage snapshot shows a counted meter at or above
 *  the configured `atPercent`. False without a threshold, without a usable
 *  snapshot, or when every such meter's window has already reset. */
export function usageAtThreshold(agent: string, now: number = Date.now()): boolean {
  const config = quotaRuleCovering(agent);
  if (!config || config.atPercent === undefined) return false;
  const snapshot = harnessUsage.get(agent);
  if (!snapshot || snapshot.status !== "ok" || !Array.isArray(snapshot.meters)) return false;
  return snapshot.meters.some((m) => {
    if (!m || typeof m.usedPercent !== "number") return false;
    if (config.meters ? !config.meters.includes(m.id) : !!m.scope) return false;
    if (m.resetsAtMs != null && m.resetsAtMs <= now) return false;
    return m.usedPercent >= config.atPercent!;
  });
}

/** The harness a new step for `agent` should start on right now: the backup
 *  while a remembered limit lasts or usage is at the configured threshold,
 *  and a backup applies; otherwise `agent`. */
export function harnessDuringLimit(agent: string, now: number = Date.now()): string {
  return fallbackDuringLimit(agent, now)?.harness ?? agent;
}

/** The fallback a new step for `agent` should start on right now, or null
 *  when it starts on `agent` itself. */
export function fallbackDuringLimit(agent: string, now: number = Date.now()): QuotaFallback | null {
  return quotaLimited(agent, now) || usageAtThreshold(agent, now) ? quotaFallbackFor(agent) : null;
}
