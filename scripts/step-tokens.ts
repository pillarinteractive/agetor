// Tokens per pipeline step visit, for the last N finished pipeline cards of a
// project — the before/after measure for prompt and pipeline changes.
//
//   bun scripts/step-tokens.ts --project pillar [--pipeline Change] [--last 10] [--json]
//                              [--data-dir ~/.agetor] [--claude-dir <dir>]… [--codex-dir <dir>]…
//
// Read-only, and safe to point at the live board: the database is opened
// read-only with bun:sqlite (never through src/bun/db.ts, which migrates),
// and the harnesses' session files are only read. It is a script and not a
// CLI command because a command would need a route in the core, and so an
// installed build, before the first number: this runs from any checkout
// against any data directory.
//
// A step visit is one step task (`tasks.pipeline_parent_id`). Its sessions
// are the session ids on its runs (`runs.claude_session_id`,
// `runs.codex_session_id`); src/shared/step-usage.ts reads what each cost.
// Visits it cannot attribute are listed with the reason, never guessed.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ZERO_USAGE, addUsage, buildReport, mainModel, numberVisits, parseClaudeTranscript, parseCodexRollout, renderReport,
  type SessionUsage, type StepVisit, type TokenUsage, type Unattributed,
} from "../src/shared/step-usage.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const values = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
const value = (name: string) => values(name).at(-1);
const expand = (p: string) => resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

if (flag("help") || flag("h")) {
  console.log("bun scripts/step-tokens.ts --project <name|path> [--pipeline <name prefix>] [--last 10] [--json] [--data-dir ~/.agetor] [--claude-dir <dir>]… [--codex-dir <dir>]…");
  process.exit(0);
}

const dataDir = expand(value("data-dir") ?? process.env.AGETOR_DATA_DIR ?? "~/.agetor");
const dbPath = join(dataDir, "agetor.sqlite");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}
const last = Math.max(1, Number(value("last") ?? 10) || 10);
const projectRef = value("project");
const pipelineRef = value("pipeline")?.trim().toLowerCase() ?? null;
if (!projectRef) {
  console.error("--project <name|path> is required");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
db.exec("PRAGMA query_only = ON");

interface ProjectRow { path: string; name: string }
const projects = db.query<ProjectRow, []>("SELECT path, name FROM projects").all();
const project = projects.find((p) => p.path === expand(projectRef)) ?? projects.find((p) => p.name.toLowerCase() === projectRef.toLowerCase());
if (!project) {
  console.error(`no project "${projectRef}" — known: ${projects.map((p) => p.name).join(", ")}`);
  process.exit(1);
}

interface HarnessRow { id: string; kind: string; home: string | null }
const harnesses = new Map(db.query<HarnessRow, []>("SELECT id, kind, home FROM harnesses").all().map((h) => [h.id, h] as const));
const claudeDirs = [...new Set([
  ...values("claude-dir").map(expand),
  ...[...harnesses.values()].filter((h) => h.kind === "claude-code" && h.home).map((h) => expand(h.home!)),
  expand(process.env.CLAUDE_CONFIG_DIR ?? "~/.claude"),
])];
const codexDirs = [...new Set([
  ...values("codex-dir").map(expand),
  ...[...harnesses.values()].filter((h) => h.kind === "codex" && h.home).map((h) => expand(h.home!)),
  expand(process.env.CODEX_HOME ?? "~/.codex"),
])];

interface CardRow { id: string; title: string; updated_at: number; pipeline_run: string }
interface RunRecord { seq: number; stepId: string; taskId: string; endedAt: number | null }
interface RunState { status?: string; pipelineName?: string; history?: RunRecord[]; snapshot?: { graph?: { steps?: { id: string; name: string }[] } } }

const cards = db
  .query<CardRow, [string]>(
    `SELECT id, title, updated_at, pipeline_run FROM tasks
      WHERE workdir = ? AND pipeline_id IS NOT NULL AND pipeline_parent_id IS NULL AND pipeline_run IS NOT NULL
        AND json_extract(pipeline_run, '$.status') = 'done'`,
  )
  .all(project.path)
  .map((row) => {
    const run = JSON.parse(row.pipeline_run) as RunState;
    const ended = (run.history ?? []).map((h) => h.endedAt ?? 0);
    return { row, run, finishedAt: ended.length > 0 ? Math.max(...ended) : row.updated_at };
  })
  .filter((c) => !pipelineRef || (c.run.pipelineName ?? "").toLowerCase().startsWith(pipelineRef))
  .sort((a, b) => b.finishedAt - a.finishedAt)
  .slice(0, last);

// --- session files ---------------------------------------------------------

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Claude Code names a project's transcript folder after its working
 *  directory with every character that is not a letter or digit as "-". */
const claudeProjectDir = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

let claudeIndex: Map<string, string> | null = null;
/** Every transcript by session id — built only when the direct path misses. */
function claudeAnywhere(sessionId: string): string | null {
  if (!claudeIndex) {
    claudeIndex = new Map();
    for (const dir of claudeDirs) {
      for (const p of list(join(dir, "projects"))) {
        for (const f of list(join(dir, "projects", p))) if (f.endsWith(".jsonl")) claudeIndex.set(f.slice(0, -6), join(dir, "projects", p, f));
      }
    }
  }
  return claudeIndex.get(sessionId) ?? null;
}

function claudeSession(sessionId: string, cwd: string | null): { main: SessionUsage; subagents: SessionUsage[] } | null {
  const direct = cwd ? claudeDirs.map((d) => join(d, "projects", claudeProjectDir(cwd), `${sessionId}.jsonl`)).find(existsSync) : undefined;
  const path = direct ?? claudeAnywhere(sessionId);
  const text = path ? read(path) : null;
  if (!path || text === null) return null;
  const subDir = join(path.slice(0, -6), "subagents");
  const subagents = list(subDir).filter((f) => f.endsWith(".jsonl")).map((f) => read(join(subDir, f)))
    .filter((t): t is string => t !== null).map((t) => parseClaudeTranscript(t, { subagent: true }));
  return { main: parseClaudeTranscript(text), subagents };
}

let codexIndex: Map<string, string> | null = null;
function codexSession(sessionId: string): SessionUsage | null {
  if (!codexIndex) {
    codexIndex = new Map();
    const walk = (dir: string, depth: number) => {
      for (const name of list(dir)) {
        const m = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(name);
        if (m) codexIndex!.set(m[1]!, join(dir, name));
        else if (depth < 4 && !name.includes(".")) walk(join(dir, name), depth + 1);
      }
    };
    for (const dir of codexDirs) walk(join(dir, "sessions"), 0);
  }
  const path = codexIndex.get(sessionId);
  const text = path ? read(path) : null;
  return text === null ? null : parseCodexRollout(text);
}

// --- visits ----------------------------------------------------------------

interface StepTaskRow { id: string; title: string; agent: string; model: string | null; pipeline_step_id: string | null; worktree_path: string | null; created_at: number }
interface SessionRow { claude_session_id: string | null; codex_session_id: string | null; started_at: number }
const stepTasksOf = db.query<StepTaskRow, [string]>(
  "SELECT id, title, agent, model, pipeline_step_id, worktree_path, created_at FROM tasks WHERE pipeline_parent_id = ?",
);
const runsOf = db.query<SessionRow, [string]>("SELECT claude_session_id, codex_session_id, started_at FROM runs WHERE task_id = ? ORDER BY started_at");

const visits: StepVisit[] = [];
for (const card of cards) {
  const names = new Map((card.run.snapshot?.graph?.steps ?? []).map((s) => [s.id, s.name] as const));
  const current = new Set((card.run.history ?? []).map((h) => h.taskId));
  const stepTasks = stepTasksOf.all(card.row.id).map((t) => {
    const runs = runsOf.all(t.id);
    const stepId = t.pipeline_step_id ?? "?";
    return { task: t, runs, stepId, startedAt: runs[0]?.started_at ?? t.created_at };
  });
  for (const { task, runs, stepId, startedAt, visit } of numberVisits(stepTasks)) {
    const harness = harnesses.get(task.agent);
    const kind = harness?.kind ?? task.agent;
    const sessionIds = [...new Set(runs.map((r) => (kind === "codex" ? r.codex_session_id : r.claude_session_id)).filter((s): s is string => !!s))];
    let usage: TokenUsage | null = null;
    let subagents: TokenUsage | null = null;
    let unattributed: Unattributed | null = null;
    let missing = 0;
    const models: Record<string, number> = {};
    const count = (s: SessionUsage) => {
      usage = addUsage(usage ?? ZERO_USAGE, s.usage);
      for (const [m, c] of Object.entries(s.models)) models[m] = (models[m] ?? 0) + c;
    };
    if (kind !== "claude-code" && kind !== "codex") unattributed = "harness-not-read";
    else if (sessionIds.length === 0) unattributed = "no-session";
    else {
      for (const id of sessionIds) {
        if (kind === "codex") {
          const s = codexSession(id);
          if (s) count(s);
          else missing++;
        } else {
          const s = claudeSession(id, task.worktree_path);
          if (!s) {
            missing++;
            continue;
          }
          count(s.main);
          for (const sub of s.subagents) {
            // A subagent's calls are the visit's, its model is not the step's.
            usage = addUsage(usage ?? ZERO_USAGE, sub.usage);
            subagents = addUsage(subagents ?? ZERO_USAGE, sub.usage);
          }
        }
      }
      if (usage === null) unattributed = "session-file-missing";
    }
    visits.push({
      cardId: card.row.id, cardTitle: card.row.title, stepTaskId: task.id, stepId,
      // Follow-ups are named after what they were asked; they are one kind of visit here.
      stepName: stepId.startsWith("followup-") ? "Follow-up" : (names.get(stepId) ?? stepId),
      visit, inCurrentRun: current.has(task.id), harness: task.agent, model: mainModel(models) ?? task.model, startedAt,
      sessions: sessionIds.length, usage, subagents, unattributed, missingSessions: usage === null ? 0 : missing,
    });
  }
}
db.close();

const report = buildReport({
  project: project.name, pipeline: value("pipeline") ?? null,
  cards: cards.map((c) => ({ id: c.row.id, title: c.row.title, finishedAt: c.finishedAt, steps: visits.filter((v) => v.cardId === c.row.id).length })),
  visits,
});
console.log(flag("json") ? JSON.stringify(report, null, 2) : renderReport(report));
