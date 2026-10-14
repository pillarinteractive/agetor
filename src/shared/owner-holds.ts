/**
 * No owner holds (docs/plans/no-owner-holds.md): every stop of an unattended
 * pipeline run that used to wait for a person goes through one bounded
 * ladder instead, and resolves by itself.
 *
 *   1. answer   — resume the SAME step in its own session with a message
 *                 that says nobody will answer and what to do instead
 *                 (once per step execution);
 *   2. reroute  — a Review or Finish that still cannot proceed sends the work
 *                 back to Build with its reason; fresh — a step that ended
 *                 without a handoff or failed gets one fresh session;
 *      wait     — something external that clears by itself (another issue
 *                 or PR, the base branch's CI, a lease, a usage limit, the
 *                 environment) stays in the wait queue, re-checked for ever
 *                 at a capped interval, never escalated;
 *      restart-from-base — the step cap hit again after its wrap-up: the
 *                 attempt is archived and the run starts over from the
 *                 current base branch, once per card run;
 *   3. close    — one follow-up issue per unresolved item, then the existing
 *                 step-cap wrap-up through Finish when there is committed
 *                 work (`close-publish`), else a dependency wait on the
 *                 filed issue (`close-depend`).
 *
 * A declared hard stop (credentials, a destructive action, main/releases/
 * production) goes to the third rung as soon as its rung-1 answer has
 * confirmed it. Nothing here merges or approves anything.
 *
 * Pure: the runner (src/bun/pipeline-runner.ts `resolveOwnerHolds`) gathers
 * the input, persists the rung counters, and carries out the decision.
 */
import type { BlockWaitCategory } from "./types.ts";
import { SELF_CLEARING_CATEGORIES } from "./block-wait.ts";

// ── The preference ────────────────────────────────────────────────────────

export const OWNER_HOLDS_PREF = "owner_holds";
/** resolve: the ladder (default). park: today's behaviour, the card waits. */
export type OwnerHoldsMode = "resolve" | "park";

/** `owner_holds`: "resolve" | "park", bare or JSON-quoted, or {"mode": …}.
 *  Anything else is the default, resolve. */
export function parseOwnerHoldsMode(raw: string | null | undefined): OwnerHoldsMode {
  let v: unknown = raw ?? null;
  if (typeof v === "string") {
    const s = v.trim();
    try {
      v = JSON.parse(s);
    } catch {
      v = s;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) v = (v as Record<string, unknown>).mode;
  return typeof v === "string" && v.trim().toLowerCase() === "park" ? "park" : "resolve";
}

// ── The hard-stop field of a handoff ──────────────────────────────────────

export type HardStopKind = "credentials" | "destructive" | "protected";
export interface HardStop {
  kind: HardStopKind;
  /** What exactly is needed or would be done, one line. */
  detail: string;
}

const HARD_STOP_ALIASES: Record<string, HardStopKind> = {
  credentials: "credentials",
  credential: "credentials",
  secret: "credentials",
  secrets: "credentials",
  token: "credentials",
  key: "credentials",
  apikey: "credentials",
  access: "credentials",
  login: "credentials",
  auth: "credentials",
  authentication: "credentials",
  password: "credentials",
  permission: "credentials",
  destructive: "destructive",
  irreversible: "destructive",
  dataloss: "destructive",
  delete: "destructive",
  deletion: "destructive",
  forcepush: "destructive",
  protected: "protected",
  main: "protected",
  release: "protected",
  releases: "protected",
  production: "protected",
  prod: "protected",
  tag: "protected",
};

const hardStopKind = (x: unknown): HardStopKind | null =>
  typeof x === "string" ? (HARD_STOP_ALIASES[x.toLowerCase().replace(/[^a-z]/g, "")] ?? null) : null;

const DETAIL_MAX = 300;
const line = (x: unknown): string =>
  typeof x === "string" ? x.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, DETAIL_MAX) : "";

/**
 * Read `hardStop` from a handoff's parsed JSON, leniently, like `waitingOn`:
 * a bare string ("credentials", "main", "irreversible"…) or an object with
 * the kind under `kind` / `type` / `on` and the detail under `detail` /
 * `reason` / `what` / `needs`. `hard_stop` and `hardstop` are read too.
 * Null when absent or unrecognisable. Never throws.
 */
export function parseHardStop(handoffJson: unknown): HardStop | null {
  if (!handoffJson || typeof handoffJson !== "object" || Array.isArray(handoffJson)) return null;
  const h = handoffJson as Record<string, unknown>;
  const own = (o: Record<string, unknown>, k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const raw = own(h, "hardStop") ?? own(h, "hard_stop") ?? own(h, "hardstop");
  if (raw == null || raw === false) return null;
  if (typeof raw === "string") {
    const kind = hardStopKind(raw);
    return kind ? { kind, detail: line(own(h, "reason")) || kind } : null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = hardStopKind(own(o, "kind")) ?? hardStopKind(own(o, "type")) ?? hardStopKind(own(o, "on"));
  if (!kind) return null;
  const detail = line(own(o, "detail")) || line(own(o, "reason")) || line(own(o, "what")) || line(own(o, "needs")) || line(own(h, "reason")) || kind;
  return { kind, detail };
}

export const HARD_STOP_LABEL: Record<HardStopKind, string> = {
  credentials: "credentials or access the agent does not have",
  destructive: "a destructive or irreversible action",
  protected: "something touching main, a release or production",
};

// ── The ladder ────────────────────────────────────────────────────────────

/** What kind of stop it is, as the runner reads it from the run. */
export type OwnerHoldKind =
  /** A step handed off `blocked` and it is the owner's (classified so, its
   *  queue wait escalated, the queue was taken, or turned off). */
  | "blocked"
  /** A step asked a question (a pending interaction) in an unattended run. */
  | "question"
  /** No usable handoff, also after the one reminder (and its retries). */
  | "no-handoff"
  /** The step failed: retries spent, not transient, never started. */
  | "failed"
  /** Required checks still fail after the feedback turns and fresh session,
   *  or could not be evaluated. */
  | "checks"
  /** A corrective route is used up (`maxTraversals`), or a Review asked for
   *  repair and no corrective route can be followed. */
  | "edge-limit"
  /** The step cap, after the automatic extension and the wrap-up. */
  | "step-cap"
  | "profile-missing"
  | "join-incomplete"
  /** Agetor-run Finish stopped (`stopPublishForOwner`). */
  | "publish";

export type StepRole = "build" | "review" | "finish" | "other";

/** What the ladder spent on one step execution. Persisted on the run. */
export interface LadderCounters {
  answers: number;
  fresh: number;
  reroutes: number;
}

export const NO_COUNTERS: LadderCounters = { answers: 0, fresh: 0, reroutes: 0 };

/** Reroutes to Build one run may take in all, whatever sent them. */
export const MAX_RUN_REROUTES = 2;

/** Categories of the wait queue that clear by themselves. */
export const SELF_CLEARING: readonly BlockWaitCategory[] = SELF_CLEARING_CATEGORIES;

export interface OwnerHoldInput {
  /** The `owner_holds` preference as it is now. */
  mode: OwnerHoldsMode;
  /** The run has a decision policy (Autopilot / roadmap cards): nobody is
   *  watching it. A run a person started by hand is left as it was. */
  unattended: boolean;
  /** A Stop the user pressed: never resumed by itself. */
  userStopped: boolean;
  kind: OwnerHoldKind;
  role: StepRole;
  /** The stopped execution has a session that can be resumed in place. */
  hasSession: boolean;
  /** The hard stop its handoff declared, if any. */
  hardStop: { kind: HardStopKind; detail: string } | null;
  /** Set when what it waits on is external and clears by itself. */
  external: BlockWaitCategory | null;
  /** What this step execution has had already. */
  counters: LadderCounters;
  /** Reroutes the whole run has taken. */
  runReroutes: number;
  /** The step that can act on a Review's or Finish's reason (Build), when
   *  there is one and its route is not used up. */
  rerouteTo: string | null;
  /** The ladder already closed this run (its wrap-up or dependency wait). */
  closed: boolean;
  /** The run has a terminal step and the cap wrap-up was not used yet. */
  wrapUpAvailable: boolean;
  /** The branch has commits of its own (or a pull request already). */
  hasCommits: boolean;
  /** The run's step-cap wrap-up has been used (`run.capWrapUp`). */
  wrapUpUsed?: boolean;
  /** The one restart from the base branch is still available: not used by
   *  this run (or the run it was restarted from), and the card has its own
   *  branch and worktree to restart. */
  capRestartAvailable?: boolean;
}

export type OwnerHoldDecision =
  | { action: "park"; why: string }
  | { action: "answer"; why: string }
  | { action: "reroute"; to: string; why: string }
  | { action: "fresh"; why: string }
  | { action: "wait"; category: BlockWaitCategory; why: string }
  | { action: "restart-from-base"; why: string }
  | { action: "close-publish"; why: string }
  | { action: "close-depend"; why: string };

export type OwnerHoldAction = OwnerHoldDecision["action"];

/** Kinds a message into the step's own session can do something about. */
const ANSWERABLE = new Set<OwnerHoldKind>(["blocked", "question"]);
/** Kinds a Review or Finish hands back to Build. */
const REROUTABLE = new Set<OwnerHoldKind>(["blocked", "question", "checks", "publish", "no-handoff", "failed"]);
/** Kinds one fresh session of the same step may get past. */
const FRESHABLE = new Set<OwnerHoldKind>(["blocked", "no-handoff", "failed", "checks", "publish"]);

/**
 * The ladder: what to do about a stop that would have waited for the owner.
 * Every rung is used at most once per step execution (`counters`), reroutes
 * at most {@link MAX_RUN_REROUTES} times a run, and the close-out at most
 * once a run (`closed`, `wrapUpAvailable`), so it cannot loop. Pure.
 */
export function resolveOwnerHold(input: OwnerHoldInput): OwnerHoldDecision {
  if (input.mode === "park") return { action: "park", why: `${OWNER_HOLDS_PREF} is "park"` };
  if (!input.unattended) return { action: "park", why: "a person runs this card" };
  if (input.userStopped) return { action: "park", why: "you stopped it" };

  const c = input.counters;
  const close = (why: string): OwnerHoldDecision =>
    !input.closed && input.wrapUpAvailable && input.hasCommits
      ? { action: "close-publish", why }
      : { action: "close-depend", why: input.closed ? `${why}; this run was already closed out once` : why };

  if (input.external && SELF_CLEARING.includes(input.external)) {
    return { action: "wait", category: input.external, why: "it waits on something that clears by itself" };
  }

  if (input.hardStop) {
    // Confirmed once in its own session, then straight to the close-out.
    if (ANSWERABLE.has(input.kind) && input.hasSession && c.answers === 0) {
      return { action: "answer", why: `it declared a hard stop (${input.hardStop.kind}); asking it once to confirm` };
    }
    return close(`hard stop: ${HARD_STOP_LABEL[input.hardStop.kind]} — ${input.hardStop.detail}`);
  }

  if (ANSWERABLE.has(input.kind) && input.hasSession && c.answers === 0) {
    return { action: "answer", why: "nobody will answer; it takes the recommended option and continues" };
  }

  // The step cap hit again after the wrap-up: the run is going round in
  // circles. Start it over from the current base, once; the second time it
  // closes out on an issue (owner decision 2026-10-14).
  if (input.kind === "step-cap" && input.wrapUpUsed === true && input.capRestartAvailable === true) {
    return { action: "restart-from-base", why: "the step cap is spent after its wrap-up; the attempt is archived and the run starts over from the current base, once" };
  }

  // Once closed, only the close-out's own steps run: nothing goes back.
  if (input.closed) return close("still stopped after the close-out");

  if (
    REROUTABLE.has(input.kind) &&
    (input.role === "review" || input.role === "finish") &&
    input.rerouteTo != null &&
    c.reroutes === 0 &&
    input.runReroutes < MAX_RUN_REROUTES
  ) {
    return { action: "reroute", to: input.rerouteTo, why: "Build is the step that can act on it" };
  }

  if (FRESHABLE.has(input.kind) && c.fresh === 0) {
    return { action: "fresh", why: "one fresh session of the same step" };
  }

  return close(
    input.kind === "edge-limit"
      ? "its corrective route is used up"
      : input.kind === "step-cap"
        ? "the step cap is spent"
        : input.kind === "profile-missing" || input.kind === "join-incomplete"
          ? "the run cannot launch its next step"
          : "the ladder is spent",
  );
}

/** A step's role, from its name or id (as the velocity ledger reads it). */
export function stepRole(name: string, id = ""): StepRole {
  for (const key of [name, id]) {
    const k = key.trim().toLowerCase();
    if (k.startsWith("build")) return "build";
    if (k.startsWith("review")) return "review";
    if (k.startsWith("finish")) return "finish";
  }
  return "other";
}

/** The rung, as the block log and the activity line name it. */
export const RESOLUTION: Record<Exclude<OwnerHoldAction, "park">, string> = {
  answer: "answered",
  reroute: "rerouted",
  fresh: "fresh-session",
  wait: "waiting",
  "restart-from-base": "restarted-from-base",
  "close-publish": "closed-published",
  "close-depend": "closed-dependency",
};

/** Every automatic action's activity line starts with this; the velocity
 *  ledger reads it as time that is not the owner's (src/shared/velocity.ts). */
export const RESOLVING_PREFIX = "Resolving without you";

/** A stop the ladder has seen and is acting on: the card reads as being
 *  resolved by Agetor (blue), not as needing the owner. */
export function resolvingHold(run: { status: string; ladder?: { resolving?: { since: number; note: string } } } | null | undefined): { since: number; note: string } | null {
  return run?.status === "blocked" && run.ladder?.resolving ? run.ladder.resolving : null;
}

// ── The follow-up issue ───────────────────────────────────────────────────

export const OWNER_HOLD_LABEL = "agetor-owner-decision";
export const ownerHoldMarker = (key: string) => `<!-- agetor-owner-hold:${key} -->`;

export interface FollowUpItem {
  /** The unresolved question or item, one line. */
  question: string;
  /** Options the step gave, when it gave any. */
  options: string[];
}

/** The unresolved items of a stop: each open question, else its reason. */
export function unresolvedItems(input: { openQuestions: string[]; reason: string; fallback: string }, max = 5): FollowUpItem[] {
  const qs = input.openQuestions.map((q) => q.replace(/\s+/g, " ").trim()).filter(Boolean);
  const items = (qs.length ? qs : [input.reason.replace(/\s+/g, " ").trim() || input.fallback]).slice(0, max);
  return items.map((q) => {
    // "Option A … or option B" / "(a) … (b) …": the step's own options.
    const opts = [...q.matchAll(/\((?:[a-e1-5])\)\s*([^()]+?)(?=\s*\((?:[a-e1-5])\)|[;.?]?$)/gi)].map((m) => m[1]!.trim()).filter(Boolean);
    return { question: q.slice(0, 500), options: opts.slice(0, 6) };
  });
}

/** A stable key for one unresolved item of one card, so the same question
 *  asked again (a later stop, a later run of the same issue) reuses its
 *  issue. `hash` is injected (sha256 in the runner). */
export function followUpKey(input: { source: string; step: string; question: string }, hash: (s: string) => string): string {
  const norm = input.question.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();
  return hash(`${input.source}\0${input.step.toLowerCase()}\0${norm}`).slice(0, 16);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Title and body of the follow-up issue for one item. */
export function followUpIssue(input: {
  key: string;
  cardTitle: string;
  cardId: string;
  step: string;
  item: FollowUpItem;
  reason: string;
  hardStop: HardStop | null;
  tried: string[];
  issueUrl: string | null;
  prUrl: string | null;
  close: "publish" | "depend";
}): { title: string; body: string } {
  const title = clip(`Owner decision: ${input.step} on "${clip(input.cardTitle, 60)}" — ${input.item.question}`, 120);
  const provisional = input.hardStop
    ? `None. This is a hard stop (${HARD_STOP_LABEL[input.hardStop.kind]}): Agetor did not act on it.`
    : "The step's recommended option, taken as provisional (recorded as provisional, never as approval). See the card's decision ledger: `agetor pipeline decisions " + input.cardId + "`.";
  const body = [
    `Agetor runs this card unattended and does not park cards for the owner. **${input.step}** could not resolve the item below by itself, so it is recorded here instead.`,
    `**Unresolved:** ${input.item.question}`,
    `**Options:** ${input.item.options.length ? input.item.options.map((o) => `\n- ${o}`).join("") : "none given by the step"}`,
    `**Provisional choice:** ${provisional}`,
    ...(input.hardStop ? [`**Hard stop:** ${input.hardStop.kind} — ${input.hardStop.detail}`] : []),
    `**Evidence (the step's stated reason):** ${clip(input.reason.replace(/\s+/g, " ").trim() || "none given", 1500)}`,
    `**What Agetor tried:** ${input.tried.length ? input.tried.join("; ") : "nothing — it went straight to this issue"}`,
    `**Card:** ${input.cardTitle} (\`${input.cardId}\`)${input.issueUrl ? ` · issue ${input.issueUrl}` : ""}${input.prUrl ? ` · PR ${input.prUrl}` : ""}`,
    input.close === "publish"
      ? "**What happened to the card:** its committed work was published through Finish (the pull request says so when the head is not approved). Nothing was merged."
      : "**What happens next:** the card waits on this issue. Write the decision in a comment and close the issue; the card resumes by itself and reads it.",
    ownerHoldMarker(input.key),
  ];
  return { title, body: body.join("\n\n") };
}
