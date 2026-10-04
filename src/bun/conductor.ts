/**
 * The Conductor: one long-lived agent session the user chats with about the
 * whole board. It reads the board through the `agetor` CLI (`agetor board`,
 * `show`, `activity`, `logs`…), explains what each card is doing, and acts —
 * messages a step, applies a suggestion, retries, starts a follow-up — when
 * the user asks it to.
 *
 * It also watches: when something notable changes (a card blocks or finishes,
 * a PR's checks flip, a lab run ends, a new suggestion appears) and the
 * Conductor is idle, it gets an automatic board update and replies with what
 * the user should do next. Updates are rate-limited (`minIntervalMin`,
 * `maxPerHour`), and the Conductor is told never to act on an update by itself.
 *
 * It's an ordinary task (isolation "none", workdir `<dataDir>/conductor`,
 * which holds its CLAUDE.md/AGENTS.md instructions) whose id is kept in the
 * `conductor_task_id` preference; the board hides it from the columns and
 * opens it from the top bar instead.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { dataDir, preferences, runs, tasks } from "./db.ts";
import { buildBoardDigest, renderBoardDigest, type BoardDigest } from "./board-digest.ts";
import { createTask, sendInput, startTask } from "./orchestrator.ts";
import { listProgress } from "./progress-watch.ts";

export const CONDUCTOR_PREF = "conductor";
export const CONDUCTOR_TASK_PREF = "conductor_task_id";
export const CONDUCTOR_RULES_PREF = "conductor_rules";

export interface ConductorConfig {
  agent: string;
  model: string | null;
  mode: string | null;
  /** Send automatic board updates while idle. */
  watch: boolean;
  minIntervalMin: number;
  maxPerHour: number;
}

const DEFAULTS: ConductorConfig = {
  agent: "claude-code",
  model: null,
  mode: "auto",
  watch: true,
  minIntervalMin: 5,
  maxPerHour: 6,
};
const TICK_MS = 30_000;

export function parseConductorConfig(raw: string | null | undefined): ConductorConfig {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // defaults
  }
  const str = (x: unknown, d: string | null) => (typeof x === "string" && x ? x : d);
  const n = (x: unknown, d: number, min: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(min, x) : d);
  return {
    agent: str(o.agent, DEFAULTS.agent)!,
    model: str(o.model, DEFAULTS.model),
    mode: str(o.mode, DEFAULTS.mode),
    watch: typeof o.watch === "boolean" ? o.watch : DEFAULTS.watch,
    minIntervalMin: n(o.minIntervalMin, DEFAULTS.minIntervalMin, 1),
    maxPerHour: n(o.maxPerHour, DEFAULTS.maxPerHour, 1),
  };
}

export function conductorDir(): string {
  return path.join(dataDir, "conductor");
}

/** The CLI the Conductor drives, pinned to this instance's data dir and
 *  never auto-starting a second core. */
export function conductorCli(): string {
  const bin = path.join(dataDir, "bin", "agetor");
  return `${bin} --data-dir ${dataDir} --no-daemon`;
}

export function conductorInstructions(rules: string | null): string {
  const cli = conductorCli();
  return `# You are the Conductor

You help the user run their Agetor board: a kanban of coding agents (each card is a task or a multi-step pipeline
working in its own git worktree). The user talks to you here instead of clicking through every card. You:

- explain what each card is doing, what it's waiting on, and what the user should do next — in plain, short words;
- watch the board: you'll get messages marked **[Automatic board update]** when something notable changes;
- act on the board **only when the user asks you to in this chat**.

## Reading the board

Use the Agetor CLI (always this exact command, it targets the right board):

    ${cli} board                     # every live card: status, PR, lease, live run progress; suggestions
    ${cli} show <id>                 # one card: prompt, runs, pending questions
    ${cli} activity <id>             # the card's timeline
    ${cli} logs <id> --no-follow     # the conversation of a task or pipeline step
    ${cli} pipeline status <id>      # a pipeline's steps and handoffs
    ${cli} diff <id>                 # the card's changes
    ${cli} suggestions               # rule-based fixes waiting for a click
    ${cli} followups <id>            # follow-ups a finished pipeline offers (Open PR, Run VM tests…)

Ids can be the 8-character prefix shown in \`board\`. You may also read the cards' worktrees and use \`gh\` read-only
(\`gh pr view\`, \`gh pr checks\`, \`gh run view --log-failed\`) to explain failures.

## Acting (only when the user asks)

    ${cli} send <id> "<message>"                 # message a task / pipeline step
    ${cli} suggestions apply <taskId> <suggestionId>
    ${cli} pipeline retry <id>                   # retry a blocked pipeline step
    ${cli} followup <id> <actionId> [--request "<text>"]   # start a follow-up step
    ${cli} add --title "<title>" --prompt "<prompt>" --workdir <repo>   # draft a new task (add --start to run it)
    ${cli} move <id> <column>
    ${cli} depends <id> <blocked-by-id>…         # <id> waits on those cards; it moves on by itself when they land

When a card can't proceed until another card's work merges, propose \`depends\` rather than asking the user to remember
to nudge it later.

Say what you're about to do in one line, do it, then report the result. If the user's request is ambiguous, ask.

## Automatic board updates

They are not from the user. Reply with at most three bullets, most important first: the card, what happened, and the
one thing the user should do (or "Nothing needs you right now."). Never act on an update by yourself — no sends,
retries, applies or follow-ups until the user says so.

## Rules

- Never edit files, commit, push, merge or approve pull requests, or delete tasks. You coordinate; the cards' agents do
  the work and the user merges.
- Never read or print secrets (\`.env*\` files, tokens, keys).
- Keep answers short. Lead with what matters; use card titles, not just ids.
${rules ? `\n## The user's standing rules\n\n${rules.trim()}\n` : ""}`;
}

function writeInstructions(): void {
  const dir = conductorDir();
  mkdirSync(dir, { recursive: true });
  const text = conductorInstructions(preferences.get(CONDUCTOR_RULES_PREF) ?? null);
  // Claude Code reads CLAUDE.md, Codex reads AGENTS.md — same text in both.
  writeFileSync(path.join(dir, "CLAUDE.md"), text);
  writeFileSync(path.join(dir, "AGENTS.md"), text);
}

export function conductorTaskId(): string | null {
  const id = preferences.get(CONDUCTOR_TASK_PREF);
  if (!id) return null;
  const t = tasks.get(id);
  return t && t.archivedAt == null ? id : null;
}

export function conductorStatus(): { taskId: string | null; config: ConductorConfig } {
  return { taskId: conductorTaskId(), config: parseConductorConfig(preferences.get(CONDUCTOR_PREF)) };
}

/** Return the Conductor task, creating and starting it the first time. */
export async function ensureConductor(): Promise<{ task: Task } | { error: string }> {
  writeInstructions();
  const existing = conductorTaskId();
  if (existing) return { task: tasks.get(existing)! };
  const cfg = parseConductorConfig(preferences.get(CONDUCTOR_PREF));
  const digest = renderBoardDigest(buildBoardDigest());
  const created = await createTask({
    title: "Conductor",
    prompt:
      "Read your instructions in CLAUDE.md (AGENTS.md for Codex), then give me a short overview of the board: what " +
      "needs me first, then anything at risk. Here's the board right now:\n\n" +
      digest,
    workdir: conductorDir(),
    isolation: "none",
    agent: cfg.agent,
    model: cfg.model,
    mode: cfg.mode,
    column: "ready",
  });
  if ("error" in created) return created;
  preferences.set(CONDUCTOR_TASK_PREF, created.task.id);
  baseline = snapshot(buildBoardDigest({ exclude: new Set([created.task.id]) }));
  const started = await startTask(created.task.id);
  if ("error" in started) return { error: `created, but it didn't start: ${started.error}` };
  return { task: tasks.get(created.task.id) ?? created.task };
}

// ── watching ────────────────────────────────────────────────────────────────

/** What counts as a change worth telling the Conductor about, per card. Live
 *  counters and ages are left out so a running test suite doesn't count as
 *  news every tick; a finished run's result is in. */
export type BoardSnapshot = Map<string, { title: string; facts: Record<string, string> }>;

export function snapshot(d: BoardDigest, finished: Map<string, string> = finishedRuns()): BoardSnapshot {
  const snap: BoardSnapshot = new Map();
  for (const c of d.cards) {
    snap.set(c.id, {
      title: c.title,
      facts: {
        column: c.column,
        // Ages ("quiet 25m", "· 1h 8m") change every minute; they aren't news.
        "needs you": stripAges(c.needsYou ?? ""),
        pipeline: c.pipeline?.status ?? "",
        PR: c.pr ?? "",
        "lab/E2E run": finished.get(c.id) ?? "",
      },
    });
  }
  for (const s of d.suggestions) {
    snap.set(`suggestion:${s.taskId}:${s.id}`, { title: s.taskTitle, facts: { suggestion: `${s.title} — ${s.detail}` } });
  }
  return snap;
}

const stripAges = (s: string) => s.replace(/\b\d+h(?: \d+m)?\b|\b\d+m\b|just now/g, "…");

function finishedRuns(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of listProgress()) {
    if (p.active || !p.last?.result) continue;
    out.set(p.taskId, `${p.label} ${p.last.result} (${p.last.finishedAt ?? ""})`);
  }
  return out;
}

/** Human-readable changes from `prev` to `next`. */
export function diffSnapshots(prev: BoardSnapshot, next: BoardSnapshot): string[] {
  const lines: string[] = [];
  for (const [key, n] of next) {
    const p = prev.get(key);
    if (key.startsWith("suggestion:")) {
      if (!p) lines.push(`- New suggestion for "${n.title}": ${n.facts.suggestion}`);
      continue;
    }
    if (!p) {
      lines.push(`- New card "${n.title}" [${key.slice(0, 8)}] in ${n.facts.column}`);
      continue;
    }
    const changes = Object.keys(n.facts)
      .filter((f) => n.facts[f] !== p.facts[f] && n.facts[f] !== "")
      .map((f) => `${f}: ${p.facts[f] || "—"} → ${n.facts[f]}`);
    if (changes.length) lines.push(`- "${n.title}" [${key.slice(0, 8)}]: ${changes.join("; ")}`);
  }
  for (const [key, p] of prev) {
    if (!next.has(key) && !key.startsWith("suggestion:")) lines.push(`- "${p.title}" left the board (archived or deleted)`);
  }
  return lines;
}

export function boardUpdateMessage(changes: string[], digest: string): string {
  return `[Automatic board update — not from the user]

Changed since your last update:
${changes.join("\n")}

The board now:
${digest}

Reply per your instructions: at most three bullets on what the user should do next, or "Nothing needs you right now." Don't act on this by yourself.`;
}

let baseline: BoardSnapshot | null = null;
let lastNudgeAt = 0;
const nudges: number[] = [];
let loop: ReturnType<typeof setInterval> | null = null;

function conductorIdle(t: Task): boolean {
  return t.column !== "running" && (t.pendingInteractionCount ?? 0) === 0 && t.runId != null;
}

/** One watcher pass. Exported for tests. */
export async function conductorTick(now = Date.now()): Promise<"off" | "no-conductor" | "quiet" | "busy" | "waiting" | "sent"> {
  const cfg = parseConductorConfig(preferences.get(CONDUCTOR_PREF));
  if (!cfg.watch) return "off";
  const id = conductorTaskId();
  if (!id) return "no-conductor";
  const digest = buildBoardDigest({ exclude: new Set([id]), now });
  const snap = snapshot(digest);
  if (!baseline) {
    baseline = snap;
    return "quiet";
  }
  const changes = diffSnapshots(baseline, snap);
  if (changes.length === 0) return "quiet";
  const task = tasks.get(id);
  if (!task || !conductorIdle(task)) return "busy";
  while (nudges.length && now - nudges[0]! > 3_600_000) nudges.shift();
  if (now - lastNudgeAt < cfg.minIntervalMin * 60_000 || nudges.length >= cfg.maxPerHour) return "waiting";
  const runId = task.runId ?? runs.listForTask(id)[0]?.id ?? null;
  if (!runId) return "busy";
  const sent = await sendInput(runId, boardUpdateMessage(changes, renderBoardDigest(digest)));
  if (!sent.delivered) return "busy";
  baseline = snap;
  lastNudgeAt = now;
  nudges.push(now);
  return "sent";
}

/** Start watching. Idempotent; the timer is unref'd. */
export function startConductorLoop(): void {
  if (loop) return;
  if (existsSync(conductorDir())) {
    try {
      writeInstructions();
    } catch {
      // best-effort refresh of the instructions file
    }
  }
  loop = setInterval(() => void conductorTick().catch(() => undefined), TICK_MS);
  loop.unref?.();
}

/** Test hook. */
export function resetConductorForTests(): void {
  if (loop) clearInterval(loop);
  loop = null;
  baseline = null;
  lastNudgeAt = 0;
  nudges.length = 0;
}
