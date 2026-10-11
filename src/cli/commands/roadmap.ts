import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import { flagValue } from "../args.ts";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson } from "../output.ts";
import { matchPipelineRef } from "../../shared/pipeline.ts";
import {
  currentRoadmapStatus,
  displayText,
  findRoadmapLinks,
  linkWaits,
  milestoneName,
  nextMilestoneText,
  roadmapLinkStateLabel,
  scopeLabel,
  scopeMilestones,
  type RoadmapLinkStep,
  type RoadmapStatus,
} from "../../shared/roadmap.ts";
import type { GitHubRepoMilestone } from "../../shared/types.ts";
import type { VelocityAnswer } from "../../shared/velocity.ts";
import { parseVelocityArgs, velocityLines, velocityPath } from "./roadmap-velocity.ts";

/**
 * Autopilot's tracker mode (src/bun/autopilot.ts, src/shared/roadmap.ts):
 *
 *   agetor roadmap status [--json]
 *   agetor roadmap start --project <dir> [--issue <n>] [--milestone <number|title-prefix|all>] [--max <n>] [--pipeline <id|name>] [--auto-continue]
 *   agetor roadmap pause
 *   agetor roadmap resolve <issue> --close | --redo
 *   agetor roadmap why <issue|step>
 *   agetor roadmap continue [--always | --off | --not-now]
 *   agetor roadmap velocity [--scope current|roadmap] [--owner-delay <hours>]
 *
 * `velocity` reports how fast the run is going (roadmap-velocity.ts):
 * throughput, cycle time, where the time goes, rework, slot utilisation,
 * bottlenecks and a forecast range. `--scope roadmap` widens the progress
 * and the bottlenecks from the milestones in scope to the whole roadmap;
 * `--owner-delay` is the time assumed for each step of the owner's.
 *
 * `why` prints what a step waits on and what it blocks (`#12` is an issue,
 * `2.1` a step, a bare number a step when one has that id). `continue`
 * answers the next-milestone offer `status` shows: it adds that milestone to
 * the scope (the current one keeps running); `--always` also has Autopilot
 * continue by itself from then on, `--off` turns that back off, `--not-now`
 * dismisses the offer. `start --auto-continue` starts with it on.
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
  "usage: agetor roadmap status | start --project <dir> [--issue <n>] [--milestone <number|title-prefix|all>] [--max <n>] [--pipeline <id|name>] [--auto-continue] | pause | resolve <issue> --close|--redo | why <issue|step> | continue [--always|--off|--not-now] | velocity [--scope current|roadmap] [--owner-delay <hours>]";

interface AutopilotDto {
  config: {
    enabled: boolean;
    project: string;
    maxInFlight: number;
    pipelineId: string | null;
    roadmap: { issue: number } | null;
    milestone?: { number: number; title: string } | null;
    milestones?: { number: number; title: string }[];
    autoContinue?: boolean;
  };
  state: { phase: string; lastError: string | null; roadmap?: RoadmapStatus | null };
  defaultTracker?: number | null;
}

type Client = Pick<AgetorClient, "call" | "listPipelines" | "listProjects">;

const scopeOf = (cfg: AutopilotDto["config"]) => {
  const list = scopeMilestones(cfg);
  if (list.length === 0) return `the whole roadmap #${cfg.roadmap?.issue}`;
  return `${list.length === 1 ? `milestone "${list[0]!.title}"` : `milestones ${list.map((m) => `"${m.title}"`).join(", ")}`} in the order of roadmap #${cfg.roadmap?.issue}`;
};

export interface RoadmapStartFlags {
  project?: string;
  issue?: number;
  /** A milestone number, the start of its title (`M01`), or `all`. */
  milestone?: string;
  max?: number;
  pipeline?: string;
  /** Continue into the next milestone without asking. */
  autoContinue?: boolean;
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
    else if (a === "--auto-continue") o.autoContinue = true;
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

/** `continue [--always|--off|--not-now]`. Pure; exported for tests. */
export function parseRoadmapContinueArgs(args: string[]): "accept" | "always" | "off" | "dismiss" {
  if (args.length === 0) return "accept";
  if (args.length === 1 && args[0] === "--always") return "always";
  if (args.length === 1 && args[0] === "--off") return "off";
  if (args.length === 1 && args[0] === "--not-now") return "dismiss";
  throw new Error(`'continue' takes at most one of --always, --off or --not-now\n${USAGE}`);
}

const linkLine = (l: RoadmapLinkStep) => `    ${l.step}  #${l.issue} ${plain(l.title)}${c.dim(` — ${roadmapLinkStateLabel(l)}${l.note ? ` (noted: ${plain(l.note)})` : ""}`)}`;

/**
 * `why <issue|step>`: what the step waits on and what it blocks, from the
 * last pass's status. Pure; exported for tests.
 */
export function roadmapWhyLines(a: AutopilotDto, ref: string): string[] {
  const { config, state } = a;
  if (!config.roadmap) return [c.dim("no tracker is set — agetor roadmap start --project <dir>")];
  const s = currentRoadmapStatus(config, state.roadmap);
  if (!s) return [c.dim("no status yet — the first pass hasn't finished")];
  if (!s.links) return [c.dim("the status was written by an older build — it is refreshed on the next pass")];
  const { entry, readAs } = findRoadmapLinks(s.links, ref);
  if (!entry) {
    return [
      `${readAs === "issue" ? `#${ref.replace(/^#/, "")}` : `step ${plain(ref)}`} isn't an open step in scope (${s.scope ? scopeLabel(s.scope.milestones?.length ? s.scope.milestones : [s.scope]) : "the whole roadmap"})`,
      c.dim("  it is complete, declined, in another milestone, or not in the tracker's table — agetor roadmap status lists what waits"),
    ];
  }
  const waits = entry.predecessors.filter(linkWaits);
  const finished = entry.predecessors.filter((l) => !linkWaits(l));
  const lines = [`${c.bold(`Step ${entry.step}`)} · #${entry.issue} ${plain(entry.title)}${c.dim(` — ${roadmapLinkStateLabel({ state: entry.state, milestone: "" })}`)}`];
  if (/^\d+$/.test(ref.trim()) && readAs === "step" && s.links.some((l) => l.issue === Number(ref))) lines.push(c.dim(`  (read as step ${ref}; for issue #${ref} write #${ref})`));
  if (entry.predecessors.length === 0) lines.push("  Waits on nothing — it has no predecessor steps");
  else if (waits.length === 0) lines.push(entry.state === "in-flight" ? "  Waits on nothing — it has started" : "  Waits on nothing — every predecessor is complete");
  if (waits.length) {
    lines.push(c.bold("  Waits on:"));
    for (const l of waits) lines.push(linkLine(l));
    if (entry.morePredecessors) lines.push(c.dim(`    and ${entry.morePredecessors} more`));
  }
  if (finished.length) {
    lines.push(c.bold("  Finished predecessors:"));
    for (const l of finished) lines.push(linkLine(l));
  }
  if (entry.successors.length) {
    lines.push(c.bold("  Blocks:"));
    for (const l of entry.successors) lines.push(linkLine(l));
    if (entry.moreSuccessors) lines.push(c.dim(`    and ${entry.moreSuccessors} more`));
  } else lines.push("  Blocks nothing that is still open");
  return lines;
}

/** What part of the in-flight steps isn't progressing, and whose it is. */
function inFlightNote(n: { held?: number; queued?: number; blocked?: number }): string {
  const parts = [
    n.held ? `${n.held} held for your sign-off` : "",
    n.blocked ? `${n.blocked} blocked — needs you` : "",
    n.queued ? `${n.queued} waiting in the queue` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** The human-readable status. Pure; exported for tests. */
export function roadmapStatusLines(a: AutopilotDto): string[] {
  const { config, state } = a;
  if (!config.roadmap) {
    return [c.dim(`no tracker is set — agetor roadmap start --project <dir> ${a.defaultTracker ? `(uses the default tracker #${a.defaultTracker})` : "--issue <n>"}`)];
  }
  // The status of the run configured now, not of another tracker or milestone.
  const s = currentRoadmapStatus(config, state.roadmap);
  const scope = scopeMilestones(config);
  const lines = [
    `${c.bold(`Roadmap #${config.roadmap.issue}`)} ${config.enabled ? (state.phase === "done" ? c.green("done") : state.phase === "idle" ? c.yellow("waiting") : c.green("running")) : c.dim("paused")}` +
      c.dim(`  ${config.project} · up to ${config.maxInFlight} in flight`),
    scope.length > 0
      ? `  Scope: ${scope.length === 1 ? `milestone "${scope[0]!.title}"` : `milestones ${scope.map((m) => `"${m.title}"`).join(" + ")}`}${s?.scope ? c.dim(` — ${s.counts.total} of the roadmap's ${s.scope.roadmapTotal} steps`) : ""}`
      : `  Scope: all milestones ${c.dim("(the whole roadmap)")}`,
  ];
  if (scope.length > 0 && config.autoContinue) lines.push(c.dim("  Always continue is on: the next milestone is added by itself (agetor roadmap continue --off)"));
  if (state.lastError) lines.push(c.red(`  ${state.lastError}`));
  if (!s) return state.lastError ? lines : [...lines, c.dim("  no status yet — the first pass hasn't finished")];
  const n = s.counts;
  lines.push(
    `  ${n.complete}/${n.total} complete · ${n.inFlight} in flight${inFlightNote(n)} · ${n.ready} ready · ${n.waiting} waiting · ${n.declined} declined · ${n.backlog ?? 0} in the backlog` +
      c.dim(`  (as of ${new Date(s.fetchedAt).toLocaleTimeString()})`),
  );
  if (s.idleReason) lines.push(c.yellow(`  ${s.idleReason}`));
  for (const k of s.continued ?? []) lines.push(c.dim(`  continued into ${plain(k.title)} at ${new Date(k.at).toLocaleTimeString()} (${k.by === "auto" ? "always continue" : "you accepted"})`));
  // The milestone that follows, and the command that starts it.
  const next = s.nextMilestone;
  if (next) {
    const t = nextMilestoneText(next);
    lines.push("", c.bold("Next milestone:"));
    lines.push(next.reason && next.dismissedAt == null ? c.yellow(`  ${plain(t.question)}`) : `  ${plain(t.question)}`);
    lines.push(c.dim(`      ${plain(t.detail)}`));
    if (next.dismissedAt != null) lines.push(c.dim(`      you said not now at ${new Date(next.dismissedAt).toLocaleTimeString()}`));
    if (!config.autoContinue) {
      lines.push(c.dim(`      agetor roadmap continue            start ${milestoneName(next)} as well (the current scope keeps running)`));
      lines.push(c.dim("      agetor roadmap continue --always   and continue into later milestones without asking"));
      if (next.reason && next.dismissedAt == null) lines.push(c.dim("      agetor roadmap continue --not-now  not now"));
    }
  }
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
  // Started cards that stopped on a block: the ones parked in the wait
  // queue need nothing from the owner; the others do (their lines quote the
  // steps' own words — printed with control characters removed).
  const stopped = s.blockedCards ?? [];
  const mine = stopped.filter((b) => !b.queued);
  const parkedCards = stopped.filter((b) => b.queued);
  if (mine.length) {
    lines.push("", c.bold("Blocked — needs you:"));
    for (const b of mine) lines.push(`  ${b.step}  #${b.issue} ${b.title}`, c.yellow(`      ${plain(b.line)}`), c.dim(`      agetor pipeline status ${b.taskId.slice(0, 8)} --handoffs`));
  }
  if (parkedCards.length) {
    lines.push("", c.bold("Waiting in the queue (retried by itself):"));
    for (const b of parkedCards) lines.push(`  ${b.step}  #${b.issue} ${b.title}`, c.dim(`      ${plain(b.line)}`));
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
        milestones: scopeMilestones(a.config),
        autoContinue: a.config.autoContinue ?? false,
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
  if (sub === "why") {
    if (rest.length !== 1 || rest[0]!.startsWith("--")) throw new Error(`'why' needs one step: its issue (#123) or its step id\n${USAGE}`);
    const a = await client.call<AutopilotDto>("GET", "/autopilot");
    const s = a.config.roadmap ? currentRoadmapStatus(a.config, a.state.roadmap) : null;
    return { data: { ref: rest[0], step: s?.links ? findRoadmapLinks(s.links, rest[0]!).entry : null }, lines: roadmapWhyLines(a, rest[0]!) };
  }
  if (sub === "velocity") {
    const a = await client.call<VelocityAnswer>("GET", velocityPath(parseVelocityArgs(rest, USAGE)));
    return { data: a, lines: velocityLines(a) };
  }
  if (sub === "continue") {
    const action = parseRoadmapContinueArgs(rest);
    if (action === "off") {
      const a = await client.call<AutopilotDto>("PUT", "/autopilot", { autoContinue: false });
      return { data: a, lines: [`${c.green("✓")} Always continue is off — the next milestone is offered, not started`] };
    }
    const r = await client.call<AutopilotDto & { ok: true; message: string }>("POST", "/autopilot/roadmap/continue", { action });
    return { data: { ok: true, action, message: r.message, milestones: scopeMilestones(r.config), autoContinue: r.config.autoContinue ?? false }, lines: [`${c.green("✓")} ${plain(r.message)}`] };
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
      ...(o.autoContinue ? { autoContinue: true } : {}),
      ...(o.max ? { maxInFlight: o.max } : {}),
      ...(pipelineId ? { pipelineId } : {}),
    });
    return {
      data: a,
      lines: [
        `${c.green("✓")} Autopilot is working ${scopeOf(a.config)} in ${a.config.project} (up to ${a.config.maxInFlight} in flight)`,
        ...(a.config.milestone ? [c.dim("  every open step of the milestone gets a card in the Backlog; each starts when its predecessors are complete")] : []),
        ...(a.config.milestone
          ? [c.dim(a.config.autoContinue ? "  always continue is on: the next milestone is added when this one can no longer fill its slots" : "  the next milestone is offered when this one can no longer fill its slots (agetor roadmap continue)")]
          : []),
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
