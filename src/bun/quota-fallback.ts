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
    return { enabled: true, from, harness, ...(atPercent !== undefined ? { atPercent } : {}), ...(atPercent !== undefined && meters.length ? { meters } : {}) };
  } catch {
    return null;
  }
}

function readUntil(): Record<string, number> {
  try {
    const v = JSON.parse(preferences.get(QUOTA_FALLBACK_UNTIL_PREF) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The backup harness id for steps on `agent`, or null when none applies:
 *  not configured, `agent` is not covered, or the backup is missing, disabled,
 *  of another kind, or `agent` itself. */
export function fallbackHarnessFor(agent: string): string | null {
  const config = parseQuotaFallback(preferences.get(QUOTA_FALLBACK_PREF));
  if (!config || agent === config.harness) return null;
  const primary = harnesses.getByIdOrKind(agent);
  if (!primary || !(config.from.includes(agent) || config.from.includes(primary.kind))) return null;
  const backup = harnesses.get(config.harness);
  if (!backup || !backup.enabled || backup.kind !== primary.kind) return null;
  return backup.id;
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

/** Whether `agent`'s latest usage snapshot shows a counted meter at or above
 *  the configured `atPercent`. False without a threshold, without a usable
 *  snapshot, or when every such meter's window has already reset. */
export function usageAtThreshold(agent: string, now: number = Date.now()): boolean {
  const config = parseQuotaFallback(preferences.get(QUOTA_FALLBACK_PREF));
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
  return quotaLimited(agent, now) || usageAtThreshold(agent, now) ? (fallbackHarnessFor(agent) ?? agent) : agent;
}
