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
 * A hard cap: `"cap": true` with `atPercent` makes the threshold a ceiling,
 * not only a switch point (owner decision 2026-10-15: both subscriptions stop
 * at 95% of their weekly allowance). A new step whose harness is at its cap,
 * and has no backup under its own cap, is not started: it queues like a step
 * waiting for a slot and starts when a meter resets (pipeline-runner.ts).
 * A backup at its own limit or cap is never chosen, so two rules that point
 * at each other don't pass steps back and forth.
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
 *
 * Chains for one profile: a rule naming `"profile"` (a profile name or id)
 * and a `"chain"` of profile names or ids gives the steps that profile runs
 * their own order of backups, for example
 *   {"enabled": true, "profile": "GPT Reviewer", "chain": ["DeepInfra GLM", "DeepInfra Kimi", "Claude Reviewer"]}
 * A step starts on the first of the profile itself and then its chain whose
 * harness is enabled and not at a usage limit. A chain profile lends only its
 * harness, model, effort and mode: the step keeps its own profile's
 * instructions and skills. A profile with such a rule never uses the harness
 * rules above, so `"chain": []` keeps its steps on their own harness. A step
 * may also exclude one model family from the chain (a Review never runs on
 * the family that built the head it reviews; see {@link familyOf}).
 */
import { agentProfiles, harnesses, harnessUsage, preferences } from "./db.ts";
import type { AgentProfile } from "../shared/types.ts";

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
  /** `atPercent` is a ceiling: past it the harness takes no new step. */
  cap?: boolean;
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
    const cap = atPercent !== undefined && v.cap === true;
    return { enabled: true, from, harness, ...(atPercent !== undefined ? { atPercent } : {}), ...(atPercent !== undefined && meters.length ? { meters } : {}), ...(model ? { model } : {}), ...(cap ? { cap } : {}) };
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
 *  for a backup of another kind, and replaces the profile's model there.
 *  `profile` is set for a hop of a profile's chain, whose model, effort and
 *  mode the step runs with. */
export interface QuotaFallback {
  harness: string;
  model: string | null;
  rule: QuotaFallbackConfig | ProfileFallbackConfig;
  profile?: { id: string; name: string; effort: string | null; mode: string | null };
}

/** The first rule covering `agent` whose backup is usable, or null: none
 *  covers it, the backup is missing, disabled or `agent` itself, or it is of
 *  another kind and the rule names no model for it. */
export function quotaFallbackFor(agent: string, now: number = Date.now()): QuotaFallback | null {
  const primary = harnesses.getByIdOrKind(agent);
  if (!primary) return null;
  for (const rule of parseQuotaFallbackRules(preferences.get(QUOTA_FALLBACK_PREF))) {
    if (agent === rule.harness || !(rule.from.includes(agent) || rule.from.includes(primary.kind))) continue;
    const backup = harnesses.get(rule.harness);
    if (!backup || !backup.enabled || atLimit(backup.id, now)) continue;
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
  return quotaLimited(agent, now) || usageAtThreshold(agent, now) ? quotaFallbackFor(agent, now) : null;
}

/** A profile's own chain of backups (see the module comment). */
export interface ProfileFallbackConfig {
  enabled: true;
  profile: string;
  chain: string[];
}

/** Every enabled profile rule in the preference, in order. */
export function parseProfileFallbackRules(raw: string | null | undefined): ProfileFallbackConfig[] {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  const items = Array.isArray(v) ? v : v ? [v] : [];
  const rules: ProfileFallbackConfig[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const profile = typeof r.profile === "string" ? r.profile.trim() : "";
    if (r.enabled !== true || !profile || !Array.isArray(r.chain)) continue;
    const chain = r.chain.filter((s: unknown): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
    rules.push({ enabled: true, profile, chain });
  }
  return rules;
}

function sameProfile(ref: string, p: { id: string; name: string }): boolean {
  return ref === p.id || ref.toLowerCase() === p.name.toLowerCase();
}

function liveProfile(ref: string): AgentProfile | null {
  return agentProfiles.get(ref) ?? agentProfiles.findByName(ref);
}

/** The first enabled rule for `profile`, or null when none names it. */
export function profileRuleFor(profile: { id: string; name: string }): ProfileFallbackConfig | null {
  return parseProfileFallbackRules(preferences.get(QUOTA_FALLBACK_PREF)).find((r) => sameProfile(r.profile, profile)) ?? null;
}

/** Whether `agent` has a remembered limit or its usage is at its rule's threshold. */
function atLimit(agent: string, now: number): boolean {
  return quotaLimited(agent, now) || usageAtThreshold(agent, now);
}

/** Whether a chain could send a step to `agent` now: it exists, is enabled
 *  and is not at a limit. (A step's own harness is judged by its limit alone,
 *  as without a chain.) */
export function harnessAvailable(agent: string, now: number = Date.now()): boolean {
  const h = harnesses.getByIdOrKind(agent);
  return !!h && h.enabled && !atLimit(h.id, now);
}

/** `harness_families`: harness id → model family, for a harness that sends
 *  a model name of one family to another provider (Claude Code via DeepSeek
 *  runs `opus-5.5` as DeepSeek V4 Pro). */
export const HARNESS_FAMILIES_PREF = "harness_families";

const ORG_FAMILIES: Record<string, string> = {
  "zai-org": "zai", zai: "zai", moonshotai: "moonshot", moonshot: "moonshot", "deepseek-ai": "deepseek", deepseek: "deepseek",
  anthropic: "anthropic", openai: "openai", google: "google", "meta-llama": "meta", qwen: "qwen", xai: "xai",
};
const NAME_FAMILIES: Array<[RegExp, string]> = [
  [/^(claude|opus|sonnet|haiku|fable)/, "anthropic"], [/^(gpt|o\d|codex)/, "openai"], [/^deepseek/, "deepseek"],
  [/^glm/, "zai"], [/^kimi/, "moonshot"], [/^gemini/, "google"], [/^grok/, "xai"], [/^qwen/, "qwen"],
];
const KIND_FAMILIES: Record<string, string> = { "claude-code": "anthropic", codex: "openai", gemini: "google" };

/** The model family a step on `agent` with `model` runs on, or null when
 *  nothing tells. In order: the organisation of an `org/model` id, the
 *  harness's `harness_families` entry, the model name, the harness's kind. */
export function familyOf(agent: string, model: string | null | undefined): string | null {
  const m = (model ?? "").trim().toLowerCase();
  const slash = m.indexOf("/");
  if (slash > 0) {
    const org = m.slice(0, slash);
    return ORG_FAMILIES[org] ?? org;
  }
  try {
    const pinned = JSON.parse(preferences.get(HARNESS_FAMILIES_PREF) ?? "{}")?.[agent];
    if (typeof pinned === "string" && pinned.trim()) return pinned.trim().toLowerCase();
  } catch {
    // an unreadable preference pins nothing
  }
  for (const [re, family] of NAME_FAMILIES) if (re.test(m)) return family;
  const kind = harnesses.getByIdOrKind(agent)?.kind;
  return (kind && KIND_FAMILIES[kind]) ?? null;
}

/**
 * The fallback a new step run by `profile` (whose harness is `agent`) should
 * start on now, or null when it starts on its own harness. With a profile
 * rule: null while `agent` is available, otherwise the first available hop
 * of the chain outside `excludeFamily`, and null when there is none (the step
 * then waits on its own limit). Without one: the harness rules
 * ({@link fallbackDuringLimit}).
 */
export function fallbackForStep(
  agent: string,
  profile: { id: string; name: string } | null,
  opts: { excludeFamily?: string | null; now?: number } = {},
): QuotaFallback | null {
  const now = opts.now ?? Date.now();
  const rule = profile ? profileRuleFor(profile) : null;
  if (!rule) return fallbackDuringLimit(agent, now);
  if (!atLimit(agent, now)) return null;
  return nextHop(rule, agent, opts.excludeFamily ?? null, now);
}

/**
 * Where a step run by `profile` goes after `agent` hit its usage limit (the
 * limit already noted): its own profile's harness when that is available
 * again, else the next available hop of the chain outside `excludeFamily`.
 * Without a profile rule: the harness rule's backup ({@link quotaFallbackFor}).
 */
export function fallbackAfterLimit(
  agent: string,
  profile: { id: string; name: string; harness: string; model: string; effort: string | null; mode: string | null } | null,
  opts: { excludeFamily?: string | null; now?: number } = {},
): QuotaFallback | null {
  const now = opts.now ?? Date.now();
  const rule = profile ? profileRuleFor(profile) : null;
  if (!rule || !profile) return quotaFallbackFor(agent, now);
  if (profile.harness !== agent && !atLimit(profile.harness, now)) {
    return { harness: profile.harness, model: profile.model, rule, profile: { id: profile.id, name: profile.name, effort: profile.effort, mode: profile.mode } };
  }
  return nextHop(rule, agent, opts.excludeFamily ?? null, now);
}

/** When `agent`'s capped meters next reset, if a rule with `"cap": true`
 *  covers it and its usage is at that cap; otherwise null. A capped meter
 *  with no reset time counts, with `Infinity`. */
export function capReachedUntil(agent: string, now: number = Date.now()): number | null {
  const config = quotaRuleCovering(agent);
  if (!config?.cap || config.atPercent === undefined) return null;
  const snapshot = harnessUsage.get(agent);
  if (!snapshot || snapshot.status !== "ok" || !Array.isArray(snapshot.meters)) return null;
  let until: number | null = null;
  for (const m of snapshot.meters) {
    if (!m || typeof m.usedPercent !== "number") continue;
    if (config.meters ? !config.meters.includes(m.id) : !!m.scope) continue;
    if (m.resetsAtMs != null && m.resetsAtMs <= now) continue;
    if (m.usedPercent < config.atPercent) continue;
    const at = m.resetsAtMs ?? Infinity;
    until = until == null ? at : Math.max(until, at);
  }
  return until;
}

/**
 * Whether a new step run by `profile` on `agent` must wait for usage: its
 * harness is at its cap and no backup is under its own. Null when it may
 * start (on its own harness or a backup); otherwise when the soonest capped
 * harness among the options resets and a sentence saying so. Pure over the
 * preference and the usage snapshots.
 */
export function capWait(
  agent: string,
  profile: { id: string; name: string } | null,
  opts: { excludeFamily?: string | null; now?: number } = {},
): { until: number | null; why: string } | null {
  const now = opts.now ?? Date.now();
  const own = capReachedUntil(agent, now);
  if (own == null || fallbackForStep(agent, profile, opts)) return null;
  const label = (id: string) => harnesses.getByIdOrKind(id)?.label ?? id;
  const config = quotaRuleCovering(agent)!;
  const others = parseQuotaFallbackRules(preferences.get(QUOTA_FALLBACK_PREF)).map((r) => r.harness).filter((h) => h !== agent);
  const capped = [...new Set(others)].map((h) => ({ h, at: capReachedUntil(h, now) })).filter((x) => x.at != null) as { h: string; at: number }[];
  const soonest = [own, ...capped.map((x) => x.at)].filter((t) => Number.isFinite(t)).sort((a, b) => a - b)[0] ?? null;
  const names = [label(agent), ...capped.map((x) => label(x.h))];
  return {
    until: soonest,
    why: `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} at the ${config.atPercent}% weekly cap — it starts when usage resets`,
  };
}

function nextHop(rule: ProfileFallbackConfig, agent: string, excludeFamily: string | null, now: number): QuotaFallback | null {
  for (const ref of rule.chain) {
    const hop = liveProfile(ref);
    if (!hop || hop.harness === agent || !harnessAvailable(hop.harness, now)) continue;
    if (excludeFamily && familyOf(hop.harness, hop.model) === excludeFamily) continue;
    const harness = harnesses.getByIdOrKind(hop.harness)!;
    return { harness: harness.id, model: hop.model, rule, profile: { id: hop.id, name: hop.name, effort: hop.effort, mode: hop.mode } };
  }
  return null;
}
