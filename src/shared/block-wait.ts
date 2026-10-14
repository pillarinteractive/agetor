/**
 * The blocked-step wait queue, pure half: why a step that handed off
 * `blocked` is blocked, whether that clears without a person, and when to
 * try it again. The runner (`src/bun/pipeline-runner.ts`: `scheduleBlockWait`,
 * `releaseBlockWaits`) keeps the queue; the card's status line, the CLI and
 * the roadmap accounting read it through the helpers at the bottom.
 *
 * Deciding (`classifyBlock`), strongest evidence first:
 *   1. the step declared `waitingOn: "owner"`                    → the owner
 *   2. a watched lease is held by another checkout and the block
 *      names it (what the lease watcher already shows)           → resource
 *   3. the handoff has open questions, or its reason asks for a
 *      decision, a credential, a permission or a hand            → the owner
 *      (steps fill `openQuestions` on most blocked handoffs, often with
 *      notes rather than questions; `declaredOutranksQuestions` in the
 *      `blocked_wait` preference lets a declared `waitingOn` stand when no
 *      question reads as a request to the owner — off by default)
 *   4. the step declared what it waits on (`waitingOn`)          → that
 *   5. its reason matches one of the patterns below              → that
 *   6. nothing recognised                                        → unknown
 * A usage limit the harness itself reported is handled before any of this
 * (the run resumes at the reset). The owner always wins over what a step
 * declares, and no outcome here advances the run: a queued step is only ever
 * resumed in place.
 *
 * Every regular expression that reads a step's prose lives in this file.
 */
import type { BlockWaitCategory, Handoff, HandoffWait, HandoffWaitingOn, PipelineBlockWait, PipelineRunState } from "./types.ts";

// ── The handoff's `waitingOn` ─────────────────────────────────────────────

const WAITING_ON_ALIASES: Record<string, HandoffWaitingOn> = {
  owner: "owner",
  user: "owner",
  human: "owner",
  operator: "owner",
  maintainer: "owner",
  person: "owner",
  you: "owner",
  decision: "owner",
  approval: "owner",
  credential: "owner",
  credentials: "owner",
  permission: "owner",
  usagelimit: "usage_limit",
  usage: "usage_limit",
  quota: "usage_limit",
  ratelimit: "usage_limit",
  limit: "usage_limit",
  resource: "resource",
  lease: "resource",
  lock: "resource",
  slot: "resource",
  lab: "resource",
  dependency: "dependency",
  dependencies: "dependency",
  predecessor: "dependency",
  issue: "dependency",
  pr: "dependency",
  pullrequest: "dependency",
  ci: "dependency",
  merge: "dependency",
  environment: "environment",
  env: "environment",
  network: "environment",
  infra: "environment",
  infrastructure: "environment",
  transient: "environment",
  tooling: "environment",
  other: "other",
  unknown: "other",
  external: "other",
};

const REF_MAX = 120;
const refText = (x: unknown): string | undefined => {
  const s = typeof x === "number" && Number.isFinite(x) ? String(x) : typeof x === "string" ? x : "";
  // One line, no control characters: it is shown on the card.
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REF_MAX);
  return clean || undefined;
};

function waitingOnKind(x: unknown): HandoffWaitingOn | null {
  if (typeof x !== "string") return null;
  return WAITING_ON_ALIASES[x.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

/**
 * Read `waitingOn` from a handoff's parsed JSON, leniently: a bare string
 * (`"resource"`, `"usage-limit"`, `"the user"`…), or an object with the kind
 * under `on` / `kind` / `type` and the reference under `ref` / `until` /
 * `label` / `issue` / `pr`; a sibling `waitingRef` / `ref` / `until` on the
 * handoff itself is read too. Null when absent or unrecognisable — the
 * classifier then decides from the rest. Never throws.
 */
export function parseWaitingOn(handoffJson: unknown): HandoffWait | null {
  if (!handoffJson || typeof handoffJson !== "object" || Array.isArray(handoffJson)) return null;
  const h = handoffJson as Record<string, unknown>;
  const own = (o: Record<string, unknown>, k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const raw = own(h, "waitingOn") ?? own(h, "waiting_on") ?? own(h, "waitingFor");
  let on: HandoffWaitingOn | null = null;
  let ref: string | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    on = waitingOnKind(own(o, "on")) ?? waitingOnKind(own(o, "kind")) ?? waitingOnKind(own(o, "type")) ?? waitingOnKind(own(o, "reason"));
    const n = own(o, "issue") ?? own(o, "pr");
    ref = refText(own(o, "ref")) ?? refText(own(o, "until")) ?? refText(own(o, "label")) ?? (refText(n) ? `#${refText(n)!.replace(/^#/, "")}` : undefined);
  } else {
    on = waitingOnKind(raw);
  }
  if (!on) return null;
  ref ??= refText(own(h, "waitingRef")) ?? refText(own(h, "ref")) ?? refText(own(h, "until"));
  return ref ? { on, ref } : { on };
}

// ── Reading a step's prose (last resort) ──────────────────────────────────

/** The step asks for something only a person can give: a decision, an
 *  approval, a credential, a permission, a physical or manual action. Errs
 *  toward matching — a false match parks the card for the owner, which is
 *  what happened to every block before the queue existed. */
const OWNER_RES: RegExp[] = [
  // "needs a product decision", "awaiting sign-off", "blocked on authorization"
  /\b(?:needs?|requires?|await(?:s|ing)?|pending|wait(?:s|ing)? (?:for|on)|blocked (?:on|by)|up to)\b[^.\n]{0,60}\b(?:decision|decide|approval|approve|sign-?off|authori[sz]ation|authori[sz]ed?|confirmation|confirm|go-ahead|permission|guidance|clarification|answer)\b/i,
  // "the user must decide", "the operator is fixing the key", "someone has to restart it"
  /\b(?:user|owner|operator|maintainer|human|someone|a person)\b[^.\n]{0,60}\b(?:(?:must|needs? to|has to|should|will have to|chose to|to)\s+(?:decide|choose|confirm|approve|authori[sz]e|provide|supply|grant|fix|correct|restart|restore|provision|install|sign|rotate|log ?in|answer|stand down)|is (?:fixing|correcting|providing|restoring|deciding|rotating))\b/i,
  /\b(?:user|owner)(?:'s|’s) (?:decision|call|choice|approval|answer)\b/i,
  // credentials
  /\b(?:credentials?|secrets?|tokens?|api[- ]key|password|passphrase|ssh key|login)\b[^.\n]{0,60}\b(?:missing|absent|not (?:available|provided|configured|set|present)|unavailable|required|needed|expired|invalid|revoked|wrong|incorrect)\b/i,
  /\b(?:missing|no|without|lacks?|needs?|requires?|invalid|expired|wrong|incorrect)\s+(?:\w+\s+){0,3}(?:credentials?|secrets?|tokens?|api[- ]key|password|ssh key)\b/i,
  // permissions
  /\b(?:permission|access) (?:was |is )?(?:denied|refused|not granted)\b|\b(?:not|isn['’]t|aren['’]t) (?:authori[sz]ed|permitted|allowed)\b|\boutside (?:the |this )?(?:agent|step)(?:'s|’s)? permissions?\b|\bforbidden\b/i,
  // physical / manual
  /\b(?:restart|reboot|power[- ]?cycle|re-?seat|plug(?:ged)? in|unplug)\b[^.\n]{0,60}\b(?:required|needed|necessary|pending|must)\b|\b(?:requires?|needs?)\s+(?:a |an |the )?(?:manual|physical|human|hands-on)\b|\bmanual (?:intervention|action|step|check|fix)\b|\bby hand\b|\bphysically\b/i,
];

/** A transient failure outside the work: network, GitHub or a registry
 *  down, a rate limit on an API, a tool that crashed, a dependency install
 *  that failed. Retried on the transient backoff. */
const ENVIRONMENT_RES: RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/,
  /\b(?:network|connection|DNS|TLS)\b[^.\n]{0,40}\b(?:error|failure|failed|unreachable|timed? ?out|reset|refused|down|outage|dropped)\b/i,
  /\bGitHub\b[^.\n]{0,60}\b(?:5\d\d|outage|incident|is down|was down|unavailable|unreachable|not accepting)\b|\b50[0234]\b[^.\n]{0,40}\bGitHub\b/i,
  /\bHTTP 50[0234]\b|\b(?:bad gateway|service unavailable|gateway time-?out)\b/i,
  /\b(?:secondary|API) rate limit\b/i,
  /\b(?:npm|pnpm|yarn|bun|pip|cargo|go|brew|apt)\b[^.\n]{0,30}\b(?:install|download|fetch|registry)\b[^.\n]{0,60}\b(?:failed|error|timed? ?out|unavailable|unreachable)\b|\bregistry\b[^.\n]{0,40}\b(?:unreachable|unavailable|timed? ?out|5\d\d|is down)\b|\bERR_PNPM_\w+/i,
  /\b(?:segmentation fault|segfault|panicked|core dumped|out of memory|OOM[- ]?killed)\b|\b(?:tool|command|process|launch(?:es)?|session)\b[^.\n]{0,40}\b(?:crashed|was killed|stopped without an exit code|died unexpectedly)\b/i,
  /\boverloaded\b|\bat capacity\b|experiencing high load/i,
];

/** A shared resource is busy: a slot, a lease, a lock held elsewhere. */
const RESOURCE_RES: RegExp[] = [
  /\b(?:verification|step|agent|build|test) slots?\b[^.\n]{0,60}\b(?:occupied|full|busy|in use|taken|unavailable)\b/i,
  /\bwait(?:s|ing)? (?:for|on) (?:a|the|an?other) (?:\w+ ){0,2}slot\b/i,
  /\b(?:lease|lock)\b[^.\n]{0,60}\b(?:held|busy|taken|in use|unavailable)\b|\bheld by (?:another|a different|the other)\b/i,
];

/** It waits for another issue or PR to land. Captures the number. */
const DEPENDENCY_REF_RE =
  /\b(?:wait(?:s|ing)? (?:for|on)|blocked (?:on|by)|depends? on|until|once|after|pending|requires?)\b[^.\n]{0,80}?(?:\b(?:PR|pull request|issue)\s*#?|#)(\d{1,7})\b[^.\n]{0,60}?\b(?:merge[sd]?|lands?|landed|is closed|closes|closed|is fixed|ships?|is resolved|completes?|is done)\b/i;
/** It waits for CI itself: a queued workflow, a runner that isn't there. */
const CI_QUEUE_RE =
  /\b(?:runners?|workflows?|CI|checks?|jobs?)\b[^.\n]{0,60}\b(?:queued|offline|unavailable|not available|still running|in progress|pending)\b|\bwait(?:s|ing)? (?:for|on) (?:CI|a runner|the workflow|the checks)\b/i;
const MENTIONS_CI_RE = /\bCI\b|\bchecks?\b|\bworkflow\b|\bpipeline\b/i;

const firstMatch = (res: RegExp[], text: string): string | null => {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 120);
  }
  return null;
};

export const asksTheOwner = (text: string): string | null => firstMatch(OWNER_RES, text);
export const looksTransient = (text: string): string | null => firstMatch(ENVIRONMENT_RES, text);
export const looksResourceBusy = (text: string): string | null => firstMatch(RESOURCE_RES, text);
export const dependencyRefIn = (text: string): number | null => {
  const m = DEPENDENCY_REF_RE.exec(text);
  return m ? Number(m[1]) : null;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Same rule as `blockMentionsLease` (src/shared/block-reason.ts). */
const mentionsLease = (text: string, label: string) => new RegExp(`\\blease\\b|\\bplab\\b|held by|\\b${escapeRe(label)}\\b`, "i").test(text);

// ── Classifying a block ───────────────────────────────────────────────────

export interface BlockSignals {
  /** The watched leases of the card's project, as the lease watcher last
   *  saw them. `heldByOther`: held, and not by this card. */
  leases?: { label: string; held: boolean; heldByOther: boolean; error: boolean }[];
  /** The card's PR fails only on checks that also fail on its base. */
  baseCiRed?: { baseRef: string } | null;
}

export interface BlockVerdict {
  category: "owner" | BlockWaitCategory;
  source: "declared" | "signal" | "questions" | "text" | "none";
  /** What it waits on, as shown ("the lab", "#123"); "you" for the owner. */
  what: string;
  ref: string | null;
  /** The rule that decided, in a few words (timeline, CLI). */
  why: string;
}

const owner = (source: BlockVerdict["source"], why: string): BlockVerdict => ({ category: "owner", source, what: "you", ref: null, why });

/** "#123" from "123", "#123", "PR 123", "issue #123"; else null. */
export function issueRef(ref: string | null | undefined): number | null {
  const m = /^(?:(?:PR|pull request|issue)\s*)?#?(\d{1,7})$/i.exec((ref ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Why a step that handed off `blocked` is blocked. See the file comment for
 * the order. `handoff` is the step's own; `signals` what the watchers know.
 * Pure.
 */
export function classifyBlock(
  handoff: Pick<Handoff, "reason" | "summary" | "openQuestions" | "waitingOn">,
  signals: BlockSignals = {},
  opts: { declaredOutranksQuestions?: boolean } = {},
): BlockVerdict {
  const declared = handoff.waitingOn ?? null;
  const questions = handoff.openQuestions.filter((q) => q.trim());
  const prose = [handoff.reason, handoff.summary].filter(Boolean).join("\n");
  const everything = [prose, ...questions].join("\n");
  const leases = signals.leases ?? [];

  if (declared?.on === "owner") return owner("declared", "the step says it waits on you");

  // A lease the watcher sees held elsewhere, named by the block: the card
  // already read "Waiting for the lab" and was retried when it freed.
  const busy = leases.find((l) => l.heldByOther && !l.error && mentionsLease(everything, l.label));
  if (busy) return { category: "resource", source: "signal", what: `the ${busy.label}`, ref: busy.label, why: `the ${busy.label} is held by another checkout` };

  // Open questions are the owner's — unless the owner opted to let a step
  // that declares what it waits on keep its notes there, and none of them
  // reads as a request to a person.
  const notes = opts.declaredOutranksQuestions === true && declared != null && asksTheOwner(questions.join("\n")) == null;
  if (questions.length > 0 && !notes) return owner("questions", "its handoff has open questions");
  const ask = asksTheOwner(prose);
  if (ask) return owner("text", `its reason asks for you ("${ask}")`);

  if (declared) {
    const ref = declared.ref ?? null;
    switch (declared.on) {
      case "usage_limit":
        return { category: "limit", source: "declared", what: "its usage limit", ref, why: "the step says it ran out of usage" };
      case "resource": {
        const lease = leases.find((l) => ref != null && l.label.toLowerCase() === ref.toLowerCase()) ?? leases.find((l) => !ref && mentionsLease(everything, l.label));
        const label = lease?.label ?? ref;
        return { category: "resource", source: "declared", what: label ? `the ${label.replace(/^the\s+/i, "")}` : "a shared resource", ref: label ?? null, why: "the step says a shared resource is busy" };
      }
      case "dependency": {
        const n = issueRef(ref) ?? dependencyRefIn(prose);
        if (n != null) return { category: "dependency", source: "declared", what: `#${n}`, ref: `#${n}`, why: `the step says it waits on #${n}` };
        return { category: "dependency", source: "declared", what: ref ?? "another change", ref, why: "the step says it waits on another change" };
      }
      case "environment":
        return { category: "environment", source: "declared", what: ref ?? "the environment", ref, why: "the step says the environment failed" };
      default:
        return { category: "unknown", source: "declared", what: ref ?? "something outside the step", ref, why: "the step says it waits on something else" };
    }
  }

  const dep = dependencyRefIn(prose);
  if (dep != null) return { category: "dependency", source: "text", what: `#${dep}`, ref: `#${dep}`, why: `its reason names #${dep}` };
  if (signals.baseCiRed && MENTIONS_CI_RE.test(prose)) {
    const base = signals.baseCiRed.baseRef;
    return { category: "dependency", source: "signal", what: `${base}'s CI`, ref: "base-ci", why: `the same checks fail on ${base}` };
  }
  const slot = looksResourceBusy(prose);
  if (slot) {
    const lease = leases.find((l) => mentionsLease(prose, l.label));
    return lease
      ? { category: "resource", source: "text", what: `the ${lease.label}`, ref: lease.label, why: `its reason names the ${lease.label}` }
      : { category: "resource", source: "text", what: /slot/i.test(slot) ? "a slot" : "a shared resource", ref: null, why: `its reason says a resource is busy ("${slot}")` };
  }
  if (CI_QUEUE_RE.test(prose)) return { category: "dependency", source: "text", what: "CI", ref: "ci", why: "its reason says CI is queued or has no runner" };
  const env = looksTransient(prose);
  if (env) return { category: "environment", source: "text", what: "the environment", ref: null, why: `its reason reads as a transient failure ("${env}")` };
  return { category: "unknown", source: "none", what: "its own stated reason", ref: null, why: "no known reason matched" };
}

// ── The schedule ──────────────────────────────────────────────────────────

export const BLOCK_WAIT_PREF = "blocked_wait";

/** What clears without anyone: never the owner's when holds are resolved. */
export const SELF_CLEARING_CATEGORIES: readonly BlockWaitCategory[] = ["resource", "dependency", "environment", "limit"];
/** The deadline of a wait that has none (JSON has no Infinity). */
export const NO_DEADLINE = Number.MAX_SAFE_INTEGER;

export interface BlockWaitConfig {
  enabled: boolean;
  /** Minutes before each automatic resume, per category; its length is the
   *  number of resumes allowed. */
  backoffMin: Record<BlockWaitCategory, number[]>;
  /** Resumes one pass of the queue may start. */
  maxPerPass: number;
  /** Resumes one blocked execution may get in all, whatever it waits on. */
  maxResumes: number;
  /** A card still in the queue after this long goes to the owner. */
  maxWaitHours: number;
  /** Each wait is stretched by up to this fraction, so cards queued
   *  together don't come back together. */
  jitter: number;
  /** Minutes between re-checks of a self-clearing wait whose retries are
   *  spent, when owner holds are resolved (`owner_holds`): it is never
   *  given to the owner. */
  longBackoffMin: number;
  /** Off (the default): a blocked handoff with open questions is always the
   *  owner's. On: when the step also declares a `waitingOn` other than the
   *  owner, and no question reads as a request to a person, the declaration
   *  stands and the card is queued. */
  declaredOutranksQuestions: boolean;
}

export const DEFAULT_BLOCK_WAIT: BlockWaitConfig = {
  enabled: true,
  backoffMin: {
    unknown: [15, 45, 120],
    // The transient backoff (src/bun/usage-limit.ts `TRANSIENT_BACKOFF_MS`).
    environment: [1, 5, 15, 30],
    limit: [15, 30, 60],
    resource: [10, 20, 30, 60, 60, 60],
    dependency: [30, 60, 120, 240],
  },
  maxPerPass: 2,
  maxResumes: 8,
  maxWaitHours: 24,
  jitter: 0.1,
  longBackoffMin: 120,
  declaredOutranksQuestions: false,
};

const CATEGORIES: BlockWaitCategory[] = ["resource", "dependency", "environment", "limit", "unknown"];

/** The `blocked_wait` preference: any subset of {@link BlockWaitConfig};
 *  `backoffMin` per category, or `unknownBackoffMin` etc. Bad values fall
 *  back to the defaults; the totals are capped so a typo can't make a card
 *  loop for ever. */
export function parseBlockWaitConfig(raw: string | null | undefined): BlockWaitConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const num = (x: unknown, d: number, min: number, max: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d);
  const list = (x: unknown, d: number[]) => {
    if (!Array.isArray(x)) return d;
    const xs = x.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0).map((n) => Math.min(n, 24 * 60)).slice(0, 12);
    return xs.length || x.length === 0 ? xs : d;
  };
  const per = o.backoffMin && typeof o.backoffMin === "object" && !Array.isArray(o.backoffMin) ? (o.backoffMin as Record<string, unknown>) : {};
  const backoffMin = Object.fromEntries(
    CATEGORIES.map((c) => [c, list(per[c] ?? o[`${c}BackoffMin`], DEFAULT_BLOCK_WAIT.backoffMin[c])]),
  ) as Record<BlockWaitCategory, number[]>;
  return {
    enabled: o.enabled !== false,
    backoffMin,
    maxPerPass: Math.floor(num(o.maxPerPass, DEFAULT_BLOCK_WAIT.maxPerPass, 1, 10)),
    maxResumes: Math.floor(num(o.maxResumes, DEFAULT_BLOCK_WAIT.maxResumes, 0, 20)),
    maxWaitHours: num(o.maxWaitHours, DEFAULT_BLOCK_WAIT.maxWaitHours, 0.1, 14 * 24),
    jitter: num(o.jitter, DEFAULT_BLOCK_WAIT.jitter, 0, 0.5),
    longBackoffMin: num(o.longBackoffMin, DEFAULT_BLOCK_WAIT.longBackoffMin, 15, 24 * 60),
    declaredOutranksQuestions: o.declaredOutranksQuestions === true,
  };
}

const TRIED_MAX = 12;
const oneLine = (s: string, max = 240) => {
  const line = s.split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, "").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * Park (or re-park) a blocked execution: the queue entry after this block.
 * `prev` is the same execution's entry when the queue had resumed it and it
 * blocked again — its attempts and its start carry over, whatever it waits
 * on now. Out of attempts (the category's, or `maxResumes` in all) or past
 * the deadline, the entry comes back `escalated` — unless `endless` (owner
 * holds are resolved, `owner_holds`) and it waits on something that clears
 * by itself: then it has no deadline, and once its retries are spent it is
 * re-checked every `longBackoffMin`. `rng` in [0, 1). Pure.
 */
export function planWait(input: {
  stepId: string;
  taskId: string;
  verdict: BlockVerdict & { category: BlockWaitCategory };
  reason: string;
  prev?: PipelineBlockWait | null;
  config: BlockWaitConfig;
  now: number;
  rng?: () => number;
  endless?: boolean;
}): PipelineBlockWait {
  const { verdict, config, now } = input;
  const endless = input.endless === true && SELF_CLEARING_CATEGORIES.includes(verdict.category);
  const prev = input.prev && input.prev.taskId === input.taskId && input.prev.stepId === input.stepId ? input.prev : null;
  const attempt = prev?.attempt ?? 0;
  const backoff = config.backoffMin[verdict.category];
  const max = Math.min(backoff.length, config.maxResumes);
  const since = prev?.since ?? now;
  const deadline = endless ? NO_DEADLINE : since + config.maxWaitHours * 3_600_000;
  const base: PipelineBlockWait = {
    stepId: input.stepId,
    taskId: input.taskId,
    category: verdict.category,
    source: verdict.source === "questions" ? "text" : verdict.source,
    what: verdict.what.slice(0, REF_MAX),
    ref: verdict.ref,
    reason: oneLine(input.reason) || "no reason given",
    state: "waiting",
    since,
    attempt,
    max,
    at: null,
    deadline,
    tried: (prev?.tried ?? []).slice(-TRIED_MAX),
    ...(endless ? { endless: true as const } : {}),
  };
  const stretch = 1 + config.jitter * Math.min(0.999, Math.max(0, (input.rng ?? Math.random)()));
  if (endless) {
    const spentOut = attempt >= max || attempt >= config.maxResumes || backoff.length === 0;
    const minutes = spentOut ? config.longBackoffMin : backoff[Math.min(attempt, backoff.length - 1)]!;
    return { ...base, at: now + Math.round(minutes * 60_000 * stretch) };
  }
  const spent = attempt >= max || attempt >= config.maxResumes;
  if (spent || now >= deadline) {
    return {
      ...base,
      state: "escalated",
      escalatedAt: now,
      escalation: spent
        ? attempt === 0
          ? "automatic retries are turned off for this kind of block"
          : `still blocked after ${attempt} automatic ${attempt === 1 ? "retry" : "retries"}`
        : `still waiting after ${fmtSpan(now - since)}`,
    };
  }
  const delay = backoff[Math.min(attempt, backoff.length - 1)]! * 60_000;
  return { ...base, at: Math.min(now + Math.round(delay * stretch), deadline) };
}

/** Whether the queue can tell, without resuming the step, that what it
 *  waits on has changed: a watched lease, an issue or PR number, the base
 *  branch's CI. Otherwise the timer is all there is. */
export function waitHasTrigger(w: Pick<PipelineBlockWait, "category" | "ref">, leaseLabels: string[] = []): boolean {
  if (w.category === "resource") return w.ref != null && leaseLabels.some((l) => l.toLowerCase() === w.ref!.toLowerCase());
  if (w.category === "dependency") return w.ref === "base-ci" || issueRef(w.ref) != null;
  return false;
}

// ── Reading the queue (card line, CLI, roadmap) ───────────────────────────

/** The run's queue entry while it is parked or being resumed. */
export function queuedWait(run: PipelineRunState | null | undefined): PipelineBlockWait | null {
  const w = run?.wait;
  return w && w.state !== "escalated" && (w.state === "resuming" || run!.status === "blocked") ? w : null;
}

/** The run is blocked and parked in the queue: it is retried by itself. */
export function waitingInQueue(run: PipelineRunState | null | undefined): boolean {
  return run?.status === "blocked" && run.wait?.state === "waiting";
}

/** The queue gave this run up: it is the owner's, with what was tried. */
export function escalatedWait(run: PipelineRunState | null | undefined): PipelineBlockWait | null {
  const w = run?.wait;
  return w && w.state === "escalated" && run!.status === "blocked" ? w : null;
}

export function fmtSpan(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

const clock = (ts: number, now: number) => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
};

const WAIT_PHRASE: Record<BlockWaitCategory, (w: PipelineBlockWait) => string> = {
  resource: (w) => `waiting for ${w.what}`,
  dependency: (w) => `waiting on ${w.what}`,
  environment: () => "hit a transient failure",
  limit: () => "waiting on a usage limit",
  unknown: () => "blocked",
};
const TRIGGER_PHRASE = (w: PipelineBlockWait): string =>
  w.category === "resource" ? "when it frees" : w.ref === "base-ci" ? "when it passes" : "when it lands";

/**
 * A queued card's status line: "Build waiting for the lab — retrying when it
 * frees or at 3:40 PM · attempt 2 of 3". `triggered`: the queue watches what
 * it waits on (`waitHasTrigger`). Pure.
 */
export function waitLine(stepName: string, w: PipelineBlockWait, now: number, triggered = false): string {
  const max = Math.max(1, w.max);
  if (w.closeout && w.state !== "resuming") {
    return w.ref ? `${stepName} waiting on ${w.what} (filed for the owner) — resumes when it is closed` : `${stepName} closing out — filing its follow-up issue again ${w.at != null ? `at ${clock(w.at, now)}` : "soon"}`;
  }
  if (w.state === "resuming") return `${stepName} resumed to check whether its block has cleared · attempt ${Math.min(Math.max(1, w.attempt), max)} of ${max}`;
  const n = w.endless && w.attempt >= w.max
      ? "re-checking until it clears"
      : `attempt ${Math.min(w.attempt + 1, max)} of ${max}`;
  const when = w.at != null ? `at ${clock(w.at, now)}` : "soon";
  return `${stepName} ${WAIT_PHRASE[w.category](w)} — retrying ${triggered ? `${TRIGGER_PHRASE(w)} or ` : ""}${when} · ${n}`;
}

/** What was tried, for an escalation: "retried 3 times (3:10 PM, 3:55 PM, 5:58 PM)". */
export function triedLine(w: Pick<PipelineBlockWait, "tried">, now: number): string {
  if (w.tried.length === 0) return "nothing was retried";
  return `retried ${w.tried.length === 1 ? "once" : `${w.tried.length} times`} (${w.tried.map((t) => clock(t.at, now)).join(", ")})`;
}

/** An escalated card's status line and Needs-you reason. Pure. */
export function escalationLine(stepName: string, w: PipelineBlockWait, now: number): { line: string; reason: string } {
  const why = w.escalation ?? "automatic retries ran out";
  return {
    line: `${stepName} ${why}: ${w.reason}`,
    reason: `${stepName} ${why} — ${triedLine(w, now)}; it says: ${w.reason}`,
  };
}

/** One row of `agetor waiting` / `GET /waiting`. */
export interface WaitingRow {
  taskId: string;
  title: string;
  step: string;
  category: BlockWaitCategory;
  source: PipelineBlockWait["source"];
  what: string;
  ref: string | null;
  reason: string;
  state: PipelineBlockWait["state"];
  since: number;
  attempt: number;
  max: number;
  nextAt: number | null;
  deadline: number;
  triggered: boolean;
  tried: PipelineBlockWait["tried"];
  escalation: string | null;
  line: string;
}
