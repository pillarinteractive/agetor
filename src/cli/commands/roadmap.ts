import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import { flagValue } from "../args.ts";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson } from "../output.ts";
import { matchPipelineRef } from "../../shared/pipeline.ts";
import type { RoadmapStatus } from "../../shared/roadmap.ts";

/**
 * Autopilot's roadmap mode (src/bun/autopilot.ts, src/shared/roadmap.ts):
 *
 *   agetor roadmap status [--json]
 *   agetor roadmap start --project <dir> --issue <n> [--max <n>] [--pipeline <id|name>]
 *   agetor roadmap pause
 *
 * Everything goes through GET/PUT /autopilot.
 */
const USAGE = "usage: agetor roadmap status | start --project <dir> --issue <n> [--max <n>] [--pipeline <id|name>] | pause";

interface AutopilotDto {
  config: { enabled: boolean; project: string; maxInFlight: number; pipelineId: string | null; roadmap: { issue: number } | null };
  state: { phase: string; lastError: string | null; roadmap?: RoadmapStatus | null };
}

type Client = Pick<AgetorClient, "call" | "listPipelines" | "listProjects">;

export interface RoadmapStartFlags {
  project?: string;
  issue?: number;
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
    else if (a === "--max") o.max = positive(a, val());
    else if (a === "--pipeline") o.pipeline = val();
    else throw new Error(`unknown option '${a}'\n${USAGE}`);
  }
  return o;
}

/** The human-readable status. Pure; exported for tests. */
export function roadmapStatusLines(a: AutopilotDto): string[] {
  const { config, state } = a;
  if (!config.roadmap) return [c.dim("roadmap mode isn't set up — agetor roadmap start --project <dir> --issue <n>")];
  const s = state.roadmap?.issue === config.roadmap.issue ? state.roadmap : null;
  const lines = [
    `${c.bold(`Roadmap #${config.roadmap.issue}`)} ${config.enabled ? (state.phase === "done" ? c.green("done") : state.phase === "idle" ? c.yellow("waiting") : c.green("running")) : c.dim("paused")}` +
      c.dim(`  ${config.project} · up to ${config.maxInFlight} in flight`),
  ];
  if (state.lastError) lines.push(c.red(`  ${state.lastError}`));
  if (!s) return state.lastError ? lines : [...lines, c.dim("  no status yet — the first pass hasn't finished")];
  const n = s.counts;
  lines.push(
    `  ${n.complete}/${n.total} complete · ${n.inFlight} in flight · ${n.ready} ready · ${n.waiting} waiting · ${n.declined} declined` +
      c.dim(`  (as of ${new Date(s.fetchedAt).toLocaleTimeString()})`),
  );
  if (s.idleReason) lines.push(c.yellow(`  ${s.idleReason}`));
  if (s.humanReady.length) {
    lines.push("", c.bold("Yours to do ([Human] steps that are ready):"));
    for (const h of s.humanReady) lines.push(`  ${h.step}  #${h.issue} ${h.title}${h.url ? c.dim(`  ${h.url}`) : ""}`);
  }
  if (s.needsUser.length) {
    lines.push("", c.bold("Needs you:"));
    for (const u of s.needsUser) lines.push(`  ${u.step}  #${u.issue} ${u.title}`, c.yellow(`      ${u.reason}`));
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
    return { data: { enabled: a.config.enabled, project: a.config.project, roadmap: a.config.roadmap, phase: a.state.phase, lastError: a.state.lastError, status: a.state.roadmap ?? null }, lines: roadmapStatusLines(a) };
  }
  if (sub === "pause") {
    if (rest.length) throw new Error(USAGE);
    const a = await client.call<AutopilotDto>("PUT", "/autopilot", { enabled: false });
    return { data: a, lines: [`${c.green("✓")} Autopilot paused — cards already running carry on`] };
  }
  if (sub === "start") {
    const o = parseRoadmapStartFlags(rest);
    if (!o.project || !o.issue) throw new Error(`'start' needs --project and --issue\n${USAGE}`);
    const wanted = path.resolve(o.project);
    const project = (await client.listProjects()).find((p) => p.path === wanted || p.name === o.project);
    if (!project) throw new Error(`"${o.project}" isn't a project on the board (agetor projects list)`);
    let pipelineId: string | undefined;
    if (o.pipeline) {
      const m = matchPipelineRef(await client.listPipelines(), o.pipeline);
      if (!m.ok) throw new Error(m.error);
      pipelineId = m.pipeline.id;
    }
    const a = await client.call<AutopilotDto>("PUT", "/autopilot", {
      enabled: true,
      project: project.path,
      roadmap: { issue: o.issue },
      ...(o.max ? { maxInFlight: o.max } : {}),
      ...(pipelineId ? { pipelineId } : {}),
    });
    return {
      data: a,
      lines: [
        `${c.green("✓")} Autopilot is working roadmap #${a.config.roadmap?.issue} in ${a.config.project} (up to ${a.config.maxInFlight} in flight)`,
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
