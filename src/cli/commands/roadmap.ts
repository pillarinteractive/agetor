import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import { flagValue } from "../args.ts";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson } from "../output.ts";
import { matchPipelineRef } from "../../shared/pipeline.ts";
import { currentRoadmapStatus, displayText, type RoadmapStatus } from "../../shared/roadmap.ts";
import type { GitHubRepoMilestone } from "../../shared/types.ts";

/**
 * Autopilot's tracker mode (src/bun/autopilot.ts, src/shared/roadmap.ts):
 *
 *   agetor roadmap status [--json]
 *   agetor roadmap start --project <dir> [--issue <n>] [--milestone <number|title-prefix|all>] [--max <n>] [--pipeline <id|name>]
 *   agetor roadmap pause
 *   agetor roadmap resolve <issue> --close | --redo
 *
 * `resolve` answers a step whose card finished while its issue stayed open
 * (listed under "Needs you" by `status`, with what the merged PR said):
 * `--close` closes the issue as completed so its successors start, `--redo`
 * has Autopilot start a fresh card for the step. It is the owner's call —
 * nothing runs it automatically.
 *
 * `--issue` defaults to the default tracker (the last one saved). With
 * `--milestone`, only the steps whose issue is in that GitHub milestone are
 * worked, and each gets a Backlog card up front; without it (or `all`), the
 * whole roadmap. Everything goes through GET/PUT /autopilot.
 */
const USAGE =
  "usage: agetor roadmap status | start --project <dir> [--issue <n>] [--milestone <number|title-prefix|all>] [--max <n>] [--pipeline <id|name>] | pause | resolve <issue> --close|--redo";

interface AutopilotDto {
  config: {
    enabled: boolean;
    project: string;
    maxInFlight: number;
    pipelineId: string | null;
    roadmap: { issue: number } | null;
    milestone?: { number: number; title: string } | null;
  };
  state: { phase: string; lastError: string | null; roadmap?: RoadmapStatus | null };
  defaultTracker?: number | null;
}

type Client = Pick<AgetorClient, "call" | "listPipelines" | "listProjects">;

const scopeOf = (cfg: AutopilotDto["config"]) => (cfg.milestone ? `milestone "${cfg.milestone.title}" in the order of roadmap #${cfg.roadmap?.issue}` : `the whole roadmap #${cfg.roadmap?.issue}`);

export interface RoadmapStartFlags {
  project?: string;
  issue?: number;
  /** A milestone number, the start of its title (`M01`), or `all`. */
  milestone?: string;
  max?: number;
  pipeline?: string;
}

/** Pure; exported for tests. */
export function parseRoadmapStartFlags(args: string[]): RoadmapStartFlags {
  const o: RoadmapStartFlags = {};
  const positive = (flag: string, v: string): number => {
    const n = Number(v.replace(/^#/, ""));
    if (!Number.isInteger(n) || n < 1) throw new Error(`'${flag}' needs a positive whole number`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => flagValue(args, ++i, a);
    if (a === "--project") o.project = val();
    else if (a === "--issue") o.issue = positive(a, val());
    else if (a === "--milestone") o.milestone = val();
    else if (a === "--max") o.max = positive(a, val());
    else if (a === "--pipeline") o.pipeline = val();
    else throw new Error(`unknown option '${a}'\n${USAGE}`);
  }
  return o;
}

/** The milestone `ref` names: its number, else the start of its title (case
 *  doesn't matter; `M01` doesn't match `M010 …`). Pure; exported for tests. */
export function matchMilestoneRef(milestones: Pick<GitHubRepoMilestone, "number" | "title">[], ref: string): { ok: true; milestone: { number: number; title: string } } | { ok: false; error: string } {
  const wanted = ref.trim().replace(/^#/, "");
  const pick = (m: Pick<GitHubRepoMilestone, "number" | "title">) => ({ ok: true as const, milestone: { number: m.number, title: m.title } });
  if (/^\d+$/.test(wanted)) {
    const byNumber = milestones.find((m) => m.number === Number(wanted));
    if (byNumber) return pick(byNumber);
  }
  const lower = wanted.toLowerCase();
  const byTitle = milestones.filter((m) => m.title.toLowerCase().startsWith(lower));
  const exact = byTitle.filter((m) => m.title.toLowerCase() === lower);
  if (exact.length === 1) return pick(exact[0]!);
  // `M01` must not also match `M010 — …`: the title continues with a separator.
  const whole = byTitle.filter((m) => !/[a-z0-9]/i.test(m.title.charAt(wanted.length)));
  if (whole.length === 1) return pick(whole[0]!);
  if (whole.length === 0 && byTitle.length === 1) return pick(byTitle[0]!);
  if (byTitle.length > 1) return { ok: false, error: `"${ref}" matches ${byTitle.length} milestones: ${byTitle.map((m) => `"${m.title}"`).join(", ")}` };
  return { ok: false, error: `no open milestone matches "${ref}"${milestones.length ? ` — there ${milestones.length === 1 ? "is" : "are"}: ${milestones.map((m) => `"${m.title}" (${m.number})`).join(", ")}` : ""}` };
}

/** Text that came from GitHub, safe for a terminal: one line, no escapes. */
const plain = (s: string) => displayText(s, 600);

/** `resolve <issue> --close|--redo`. Pure; exported for tests. */
export function parseRoadmapResolveArgs(args: string[]): { issue: number; action: "close" | "redo" } {
  let issue: number | null = null;
  let action: "close" | "redo" | null = null;
  for (const a of args) {
    if (a === "--close" || a === "--redo") {
      if (action) throw new Error(`'resolve' takes one of --close or --redo\n${USAGE}`);
      action = a === "--close" ? "close" : "redo";
    } else if (/^#?\d+$/.test(a) && issue == null) issue = Number(a.replace(/^#/, ""));
    else throw new Error(`unknown argument '${a}'\n${USAGE}`);
  }
  if (!issue) throw new Error(`'resolve' needs the step's issue number\n${USAGE}`);
  if (!action) throw new Error(`'resolve' needs --close (accept the step, close the issue) or --redo (do the step again)\n${USAGE}`);
  return { issue, action };
}

/** The human-readable status. Pure; exported for tests. */
export function roadmapStatusLines(a: AutopilotDto): string[] {
  const { config, state } = a;
  if (!config.roadmap) {
    return [c.dim(`no tracker is set — agetor roadmap start --project <dir> ${a.defaultTracker ? `(uses the default tracker #${a.defaultTracker})` : "--issue <n>"}`)];
  }
  // The status of the run configured now, not of another tracker or milestone.
  const s = currentRoadmapStatus({ roadmap: config.roadmap, milestone: config.milestone ?? null }, state.roadmap);
  const lines = [
    `${c.bold(`Roadmap #${config.roadmap.issue}`)} ${config.enabled ? (state.phase === "done" ? c.green("done") : state.phase === "idle" ? c.yellow("waiting") : c.green("running")) : c.dim("paused")}` +
      c.dim(`  ${config.project} · up to ${config.maxInFlight} in flight`),
    config.milestone ? `  Scope: milestone "${config.milestone.title}"${s?.scope ? c.dim(` — ${s.counts.total} of the roadmap's ${s.scope.roadmapTotal} steps`) : ""}` : `  Scope: all milestones ${c.dim("(the whole roadmap)")}`,
  ];
  if (state.lastError) lines.push(c.red(`  ${state.lastError}`));
  if (!s) return state.lastError ? lines : [...lines, c.dim("  no status yet — the first pass hasn't finished")];
  const n = s.counts;
  lines.push(
    `  ${n.complete}/${n.total} complete · ${n.inFlight} in flight${n.held ? ` (${n.held} held for your sign-off)` : ""} · ${n.ready} ready · ${n.waiting} waiting · ${n.declined} declined · ${n.backlog ?? 0} in the backlog` +
      c.dim(`  (as of ${new Date(s.fetchedAt).toLocaleTimeString()})`),
  );
  if (s.idleReason) lines.push(c.yellow(`  ${s.idleReason}`));
  if (s.humanReady.length || s.needsUser.length) {
    lines.push("", c.bold("Needs you:"));
    for (const h of s.humanReady) lines.push(`  ${h.step}  #${h.issue} ${h.title}${h.url ? c.dim(`  ${h.url}`) : ""}`, c.dim("      yours to do — this step is ready and only you can do it"));
    for (const u of s.needsUser) {
      lines.push(`  ${u.step}  #${u.issue} ${u.title}`, c.yellow(`      ${plain(u.reason)}`));
      // What the PR said (or the files holding the card): text from GitHub,
      // printed with control characters removed.
      if (u.detail) lines.push(c.dim(`      ${u.kind === "held" ? "sensitive files: " : ""}${plain(u.detail)}`));
      if (u.prUrl) lines.push(c.dim(`      ${plain(u.prUrl)}`));
      if (u.kind === "held") lines.push(c.dim("      review the PR, then move its card to Ready to Merge"));
      else lines.push(c.dim(`      agetor roadmap resolve ${u.issue} --close   accept the step: close the issue as completed`), c.dim(`      agetor roadmap resolve ${u.issue} --redo    have the step done again`));
    }
  }
  const outside = s.blockedOutside ?? [];
  if (outside.length) {
    lines.push("", c.bold("Waits on other milestones (not started by this run):"));
    for (const o of outside) lines.push(`  ${o.step}  #${o.issue} ${o.title}${c.dim(`  ${o.milestone || "no milestone"}`)}`);
  }
  if (s.nextWaiting.length) {
    lines.push("", c.bold("Next waiting steps:"));
    for (const w of s.nextWaiting) lines.push(`  ${w.step}  #${w.issue} ${w.title}${c.dim(`  — ${w.reason ?? `waits on ${w.waitingOn.join(", ")}`}`)}`);
  }
  if (s.problems.length) {
    lines.push("", c.bold(`Roadmap problems (${s.problems.length}):`));
    for (const p of s.problems) lines.push(c.yellow(`  ${p.message}`));
  }
  return lines;
}

/** Exported for tests (the client is the only I/O). */
export async function runRoadmap(client: Client, args: string[]): Promise<{ data: unknown; lines: string[] }> {
  const [sub, ...rest] = args;
  if (!sub || sub === "status") {
    if (rest.length) throw new Error(USAGE);
    const a = await client.call<AutopilotDto>("GET", "/autopilot");
    return {
      data: {
        enabled: a.config.enabled,
        project: a.config.project,
        roadmap: a.config.roadmap,
        milestone: a.config.milestone ?? null,
        defaultTracker: a.defaultTracker ?? null,
        phase: a.state.phase,
        lastError: a.state.lastError,
        status: a.state.roadmap ?? null,
      },
      lines: roadmapStatusLines(a),
    };
  }
  if (sub === "pause") {
    if (rest.length) throw new Error(USAGE);
    const a = await client.call<AutopilotDto>("PUT", "/autopilot", { enabled: false });
    return { data: a, lines: [`${c.green("✓")} Autopilot paused — cards already running carry on`] };
  }
  if (sub === "resolve") {
    const { issue, action } = parseRoadmapResolveArgs(rest);
    const r = await client.call<AutopilotDto & { ok: true; message: string }>("POST", "/autopilot/roadmap/resolve", { issue, action });
    return { data: { ok: true, issue, action, message: r.message }, lines: [`${c.green("✓")} ${plain(r.message)}`] };
  }
  if (sub === "start") {
    const o = parseRoadmapStartFlags(rest);
    if (!o.project) throw new Error(`'start' needs --project\n${USAGE}`);
    const wanted = path.resolve(o.project);
    const project = (await client.listProjects()).find((p) => p.path === wanted || p.name === o.project);
    if (!project) throw new Error(`"${o.project}" isn't a project on the board (agetor projects list)`);
    const issue = o.issue ?? (await client.call<AutopilotDto>("GET", "/autopilot")).defaultTracker ?? null;
    if (!issue) throw new Error(`'start' needs --issue: no default tracker is set yet (the first tracker you start becomes the default)\n${USAGE}`);
    // No --milestone (or `all`): the whole roadmap.
    let milestone: { number: number; title: string } | null = null;
    if (o.milestone && o.milestone.trim().toLowerCase() !== "all") {
      const list = await client.call<{ milestones: GitHubRepoMilestone[] }>("GET", `/github/milestones?path=${encodeURIComponent(project.path)}`);
      const m = matchMilestoneRef((list.milestones ?? []).filter((x) => x.state === "open"), o.milestone);
      if (!m.ok) throw new Error(m.error);
      milestone = m.milestone;
    }
    let pipelineId: string | undefined;
    if (o.pipeline) {
      const m = matchPipelineRef(await client.listPipelines(), o.pipeline);
      if (!m.ok) throw new Error(m.error);
      pipelineId = m.pipeline.id;
    }
    const a = await client.call<AutopilotDto>("PUT", "/autopilot", {
      enabled: true,
      project: project.path,
      roadmap: { issue },
      milestone,
      ...(o.max ? { maxInFlight: o.max } : {}),
      ...(pipelineId ? { pipelineId } : {}),
    });
    return {
      data: a,
      lines: [
        `${c.green("✓")} Autopilot is working ${scopeOf(a.config)} in ${a.config.project} (up to ${a.config.maxInFlight} in flight)`,
        ...(a.config.milestone ? [c.dim("  every open step of the milestone gets a card in the Backlog; each starts when its predecessors are complete")] : []),
        c.dim("  agetor roadmap status   shows what's ready, waiting and yours to do"),
      ],
    };
  }
  throw new Error(USAGE);
}

export async function cmdRoadmap(args: string[], flags: Flags): Promise<void> {
  const r = await runRoadmap(await getClient(flags), args);
  if (flags.json) return printJson(r.data);
  for (const line of r.lines) out(line);
}
