/**
 * Milestone Autopilot: work a GitHub milestone to done without being driven.
 *
 * The user's milestone-manager Codex thread (src/bun/codex-thread.ts) decides
 * WHAT: asked which open issues should start next, it answers with up to N
 * issues plus a scope clarification for each (acceptance criteria, in/out of
 * scope, risks). Agetor does the rest: creates and starts a pipeline card per
 * issue (the scope goes into the card's prompt and onto the issue), keeps up
 * to `maxInFlight` cards going, signs finished cards off into Ready to Merge
 * (the merge queue lands them) — except PRs touching billing, auth,
 * migrations or the schema, which wait in In Review for the user — and, when
 * the milestone has no open issues and nothing in flight, asks the thread for
 * a deep audit. Issues the audit files into the milestone restart the loop;
 * a clean audit ends it.
 *
 * Config: `autopilot` preference. State: `autopilot_state` preference.
 */
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { recordActivity } from "./activity.ts";
import { run } from "./github.ts";
import { askThread, taggedJson } from "./codex-thread.ts";
import { createTaskFromIssue } from "./issue-queue.ts";
import { setMergeQueued } from "./merge-intent.ts";
import { prStatusForTask } from "./pr-watch.ts";

export const AUTOPILOT_PREF = "autopilot";
export const AUTOPILOT_STATE_PREF = "autopilot_state";
const TICK_MS = 2 * 60_000;
const QUIET_MS = 20 * 60_000;

export interface AutopilotConfig {
  enabled: boolean;
  threadId: string;
  project: string;
  milestone: { number: number; title: string } | null;
  maxInFlight: number;
  pipelineId: string | null;
}

export interface AutopilotState {
  phase: "idle" | "running" | "auditing" | "done";
  cards: string[];
  held: string[];
  audits: number;
  lastAnswer: { at: number; kind: "next" | "audit"; text: string } | null;
  lastError: string | null;
  /** Don't ask the thread again before this unless the board changed. */
  quietUntil: number;
  /** What the board looked like at the last unproductive ask. */
  quietSignature: string;
  updatedAt: number;
}

const RISKY = /(billing|stripe|checkout|subscription|auth|clerk|session|permission|migrations?\/|drizzle\/|db\/schema|schema\.ts)/i;

export function parseConfig(raw: string | null | undefined): AutopilotConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const m = o.milestone as { number?: unknown; title?: unknown } | null | undefined;
  return {
    enabled: o.enabled === true,
    threadId: typeof o.threadId === "string" ? o.threadId : "",
    project: typeof o.project === "string" ? o.project : "",
    milestone: m && typeof m.number === "number" && typeof m.title === "string" ? { number: m.number, title: m.title } : null,
    maxInFlight: typeof o.maxInFlight === "number" && o.maxInFlight >= 1 ? Math.min(10, Math.floor(o.maxInFlight)) : 5,
    pipelineId: typeof o.pipelineId === "string" && o.pipelineId ? o.pipelineId : null,
  };
}

export function readState(): AutopilotState {
  try {
    const v = JSON.parse(preferences.get(AUTOPILOT_STATE_PREF) ?? "{}") as Partial<AutopilotState>;
    return {
      phase: v.phase ?? "idle",
      cards: Array.isArray(v.cards) ? v.cards : [],
      held: Array.isArray(v.held) ? v.held : [],
      audits: typeof v.audits === "number" ? v.audits : 0,
      lastAnswer: v.lastAnswer ?? null,
      lastError: v.lastError ?? null,
      quietUntil: v.quietUntil ?? 0,
      quietSignature: v.quietSignature ?? "",
      updatedAt: v.updatedAt ?? 0,
    };
  } catch {
    return { phase: "idle", cards: [], held: [], audits: 0, lastAnswer: null, lastError: null, quietUntil: 0, quietSignature: "", updatedAt: 0 };
  }
}

function writeState(s: AutopilotState): void {
  preferences.set(AUTOPILOT_STATE_PREF, JSON.stringify({ ...s, updatedAt: Date.now() }));
}

/** Issue number from a card's issue URL. */
function issueOf(t: Task): number | null {
  const m = t.issueUrl?.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Live = not archived and not Done. */
const live = (t: Task) => t.archivedAt == null && t.column !== "done";

export interface NextPick {
  number: number;
  scope: string;
}

/** Keep only picks that are open, not already being worked, unique, and within
 *  the free slots. Pure; exported for tests. */
export function acceptPicks(picks: unknown, open: Set<number>, busy: Set<number>, free: number): NextPick[] {
  if (!Array.isArray(picks)) return [];
  const out: NextPick[] = [];
  for (const p of picks) {
    const n = Number((p as { number?: unknown })?.number);
    const scope = String((p as { scope?: unknown })?.scope ?? "").trim();
    if (!Number.isInteger(n) || !open.has(n) || busy.has(n) || out.some((x) => x.number === n)) continue;
    out.push({ number: n, scope });
    if (out.length >= free) break;
  }
  return out;
}

export function nextPrompt(milestone: string, candidates: { number: number; title: string }[], inFlight: { number: number; title: string }[], free: number): string {
  const list = (xs: { number: number; title: string }[]) => (xs.length ? xs.map((x) => `- #${x.number} ${x.title}`).join("\n") : "- (none)");
  return [
    `[Agetor Autopilot] Milestone "${milestone}".`,
    "",
    "Open issues nobody is working on yet:",
    list(candidates),
    "",
    "Being worked on right now (each by its own agent, on its own branch):",
    list(inFlight),
    "",
    `Pick up to ${free} issue(s) to start now, in the order they should go. Prefer what unblocks other work; avoid starting two issues that would edit the same files at the same time; skip anything that needs a product decision from the user and say so.`,
    "For each pick, clarify its scope for the implementing agent: acceptance criteria, what is in and out of scope, risks, likely files, and how to verify. Don't change any code or GitHub state for this request.",
    "",
    'End your reply with exactly one block: <next-issues>[{"number": 123, "scope": "markdown"}]</next-issues> — an empty list if nothing should start now.',
  ].join("\n");
}

export function auditPrompt(milestone: string): string {
  return [
    `[Agetor Autopilot] Every issue in milestone "${milestone}" is closed and its work merged into develop.`,
    "",
    "Do a deep audit. Don't take the issues being resolved at face value: rescan the code on the latest origin/develop, confirm each issue in this milestone is really resolved, check our tests correctly cover the scenarios, and look for new issues we introduced.",
    `For every real problem you find, file a GitHub issue in milestone "${milestone}" (gh issue create --milestone ...) with evidence and acceptance criteria. Don't fix anything yourself.`,
    "",
    'End your reply with exactly one block: <audit>{"clean": true|false, "filed": [issue numbers], "summary": "markdown"}</audit>',
  ].join("\n");
}

async function milestoneIssues(cfg: AutopilotConfig): Promise<{ number: number; title: string }[] | null> {
  const r = await run(
    ["gh", "issue", "list", "--milestone", cfg.milestone!.title, "--state", "open", "--limit", "300", "--json", "number,title"],
    cfg.project,
    60_000,
    process.env,
  );
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout || "[]") as { number: number; title: string }[];
  } catch {
    return null;
  }
}

async function prTouchesRisky(t: Task, number: number): Promise<boolean> {
  const r = await run(["gh", "pr", "view", String(number), "--json", "files", "-q", ".files[].path"], t.workdir, 30_000, process.env);
  return !r.ok || (r.stdout ?? "").split("\n").some((p) => RISKY.test(p));
}

let busy = false;

/** One pass. Exported for tests and the "run now" button. */
export async function autopilotTick(): Promise<void> {
  const cfg = parseConfig(preferences.get(AUTOPILOT_PREF));
  if (!cfg.enabled || !cfg.threadId || !cfg.project || !cfg.milestone || busy) return;
  busy = true;
  const state = readState();
  try {
    // A finished milestone stays finished until the user restarts Autopilot.
    if (state.phase === "done") return;
    if (state.phase === "idle") state.phase = "running";
    const all = tasks.list();
    const mine = state.cards.map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t && t.archivedAt == null);
    state.cards = mine.map((t) => t.id);

    // Sign finished cards off: Ready to Merge, unless the PR touches risky code.
    for (const t of mine) {
      if (t.column !== "review" || t.pipelineRun?.status !== "done" || state.held.includes(t.id)) continue;
      const pr = prStatusForTask(t.id);
      if (pr?.state !== "open") continue;
      if (await prTouchesRisky(t, pr.number)) {
        state.held.push(t.id);
        recordActivity(t.id, { kind: "auto", text: `Autopilot: PR #${pr.number} touches billing/auth/migrations/schema — left in In Review for you to sign off`, tone: "warning" });
        continue;
      }
      setMergeQueued(t.id, true);
      tasks.update(t.id, { column: "merge" });
      recordActivity(t.id, { kind: "auto", text: `Autopilot: signed off PR #${pr.number} for merging`, tone: "info" });
    }

    const open = await milestoneIssues(cfg);
    if (!open) {
      state.lastError = "couldn't list the milestone's issues";
      return;
    }
    const openSet = new Set(open.map((i) => i.number));
    const busyIssues = new Set(all.filter((t) => live(t) && !t.pipelineParentId).map(issueOf).filter((n): n is number => n != null));
    const inFlight = open.filter((i) => busyIssues.has(i.number));
    // Autopilot's own cards still finishing (PR not merged yet) count too.
    const ownLive = mine.filter(live).length;
    const candidates = open.filter((i) => !busyIssues.has(i.number));

    // Back off after an ask that started nothing, until the board changes.
    const signature = `${candidates.map((i) => i.number).join(",")}|${inFlight.map((i) => i.number).join(",")}|${ownLive}`;
    if (Date.now() < state.quietUntil && signature === state.quietSignature) return;

    if (candidates.length === 0 && ownLive === 0 && inFlight.length === 0) {
      // Nothing left: audit (once per emptying), then done unless it filed more.
      state.phase = "auditing";
      writeState(state);
      const a = await askThread({ threadId: cfg.threadId, cwd: cfg.project, prompt: auditPrompt(cfg.milestone.title), timeoutMs: 90 * 60_000 });
      state.audits++;
      if (!a.ok) {
        state.lastError = `audit: ${a.error}`;
        state.phase = "running";
        state.quietUntil = Date.now() + QUIET_MS;
        state.quietSignature = signature;
        return;
      }
      state.lastAnswer = { at: Date.now(), kind: "audit", text: a.text.slice(-6000) };
      const after = await milestoneIssues(cfg);
      state.phase = after && after.length > 0 ? "running" : "done";
      state.lastError = null;
      return;
    }

    const free = cfg.maxInFlight - Math.max(ownLive, inFlight.length);
    if (free <= 0 || candidates.length === 0) return;
    const answer = await askThread({
      threadId: cfg.threadId,
      cwd: cfg.project,
      prompt: nextPrompt(cfg.milestone.title, candidates, inFlight, free),
    });
    if (!answer.ok) {
      state.lastError = `next issue: ${answer.error}`;
      state.quietUntil = Date.now() + QUIET_MS;
      state.quietSignature = signature;
      return;
    }
    state.lastAnswer = { at: Date.now(), kind: "next", text: answer.text.slice(-6000) };
    const picks = acceptPicks(taggedJson(answer.text, "next-issues"), openSet, busyIssues, free);
    const pipelineId = cfg.pipelineId ?? preferences.get("default_pipeline") ?? null;
    if (!pipelineId) {
      state.lastError = "no pipeline to run issues with (set default_pipeline)";
      return;
    }
    for (const p of picks) {
      const scope = p.scope ? `## Scope from the milestone manager\n\n${p.scope}` : undefined;
      const r = await createTaskFromIssue({ dir: cfg.project, number: p.number, pipelineId, extraPrompt: scope, allowAfterDone: true });
      if ("error" in r) {
        state.lastError = `#${p.number}: ${r.error}`;
        continue;
      }
      state.cards.push(r.task.id);
      recordActivity(r.task.id, { kind: "auto", text: `Autopilot started this for milestone "${cfg.milestone.title}"`, tone: "info" });
      if (p.scope) {
        await run(
          ["gh", "issue", "comment", String(p.number), "--body", `**Scope** (milestone manager, via Agetor Autopilot):\n\n${p.scope}`],
          cfg.project,
          30_000,
          process.env,
        );
      }
    }
    if (picks.length === 0) {
      state.lastError = "the thread picked nothing to start now — see its answer";
      state.quietUntil = Date.now() + QUIET_MS;
      state.quietSignature = signature;
    } else {
      state.lastError = null;
    }
  } finally {
    writeState(state);
    busy = false;
  }
}

let loop: ReturnType<typeof setInterval> | null = null;

export function startAutopilot(): void {
  if (loop) return;
  loop = setInterval(() => void autopilotTick().catch((e: Error) => {
    const s = readState();
    s.lastError = e.message;
    writeState(s);
  }), TICK_MS);
  loop.unref?.();
}
