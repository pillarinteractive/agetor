import { c } from "../output.ts";
import { bottleneckLine, DAY, fmtDuration, fmtPct, fmtRange, fmtRate, type Distribution, type ForecastTarget, type VelocityAnswer, type VelocityReport } from "../../shared/velocity.ts";

/**
 * `agetor roadmap velocity [--scope current|roadmap] [--owner-delay <hours>]`:
 * the report `GET /autopilot/roadmap/velocity` computes (src/shared/velocity.ts),
 * as text — throughput, cycle and lead time, where the time goes, rework,
 * utilisation, the top bottlenecks and the forecast range with what it
 * rests on. Pure; exported for tests.
 */

export interface VelocityFlags {
  scope: "current" | "roadmap";
  ownerDelayHours: number | null;
}

export function parseVelocityArgs(args: string[], usage: string): VelocityFlags {
  const o: VelocityFlags = { scope: "current", ownerDelayHours: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--scope") {
      const v = args[++i];
      if (v !== "current" && v !== "roadmap") throw new Error(`'--scope' is current or roadmap\n${usage}`);
      o.scope = v;
    } else if (a === "--owner-delay") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`'--owner-delay' needs a number of hours, 0 or more\n${usage}`);
      o.ownerDelayHours = n;
    } else throw new Error(`unknown option '${a}'\n${usage}`);
  }
  return o;
}

export const velocityPath = (f: VelocityFlags): string =>
  `/autopilot/roadmap/velocity?scope=${f.scope}${f.ownerDelayHours != null ? `&ownerDelayHours=${f.ownerDelayHours}` : ""}`;

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const dist = (d: Distribution) => `median ${fmtDuration(d.median)} · p75 ${fmtDuration(d.p75)} · p90 ${fmtDuration(d.p90)} · ${fmtDuration(d.min)}–${fmtDuration(d.max)}`;
const steps = (n: number) => `${n} step${n === 1 ? "" : "s"}`;
const bar = (share: number, width = 20) => "█".repeat(Math.round(share * width));
const WINDOW: Record<string, string> = { "24h": "last 24 hours", "3d": "last 3 days", "7d": "last 7 days", all: "since the run began" };
const STATE: Record<string, string> = { building: "in flight", merging: "in CI / the merge queue", held: "held for your sign-off", stuck: "finished with the issue still open — needs you", blocked: "blocked — needs you", quota: "waiting for a usage limit", retry: "retrying after a failure", waiting: "waiting in the retry queue", ready: "ready, waiting for a slot", yours: "yours to do", outside: "open in another milestone" };

function forecastLines(t: ForecastTarget, r: VelocityReport): string[] {
  const f = r.forecast;
  const n = steps(t.remainingAgent).replace("step", "agent step");
  const left = t.key === "gate" ? `${n} to finish before it` : `${n} left${t.ancestorsOutside ? ` (${t.ancestorsOutside} of them outside it — it waits on them)` : ""}`;
  const out = [`  ${c.bold(t.label)}${c.dim(` — ${left}`)}`];
  const slots = (s: NonNullable<ForecastTarget["sim"]>) => c.dim(s.observed && f.busySlots ? `  (all ${f.busySlots.max} slots busy: ${fmtRange(s.full.low, s.full.high)}; as busy as so far: ${fmtRange(s.observed.low, s.observed.high)})` : "");
  if (t.sim) out.push(`      ${pad(t.ownerSteps > 0 ? "simulated, your steps taking no time" : "simulated", 40)} ${fmtRange(t.sim.low, t.sim.high)}${slots(t.sim)}`);
  if (t.ownerSteps > 0) {
    if (t.simWithOwner && f.ownerDelayMs != null) {
      out.push(`      ${pad(`simulated, ${fmtDuration(f.ownerDelayMs)} per step of yours`, 40)} ${fmtRange(t.simWithOwner.low, t.simWithOwner.high)}${slots(t.simWithOwner)}`);
    }
    out.push(
      c.dim(
        `      ${t.ownerSteps} of your steps lie${t.ownerSteps === 1 ? "s" : ""} on the path` +
          (f.ownerDelayMs == null
            ? " — how long they take is unknown; try --owner-delay <hours>"
            : f.ownerDelayFrom === "observed"
              ? ` — ${fmtDuration(f.ownerDelayMs)} each is the median of the ${f.ownerSample} you have finished (--owner-delay <hours> to change)`
              : ` — ${fmtDuration(f.ownerDelayMs)} each, as you set`),
      ),
    );
  }
  if (t.naive) out.push(c.dim(`      ${pad("naive (remaining ÷ recent rate)", 40)} ${fmtRange(t.naive.low, t.naive.high)}`));
  if (t.unreachable) out.push(c.yellow(`      ${steps(t.unreachable)} can never start (behind a declined step) — not counted`));
  return out;
}

export function velocityLines(a: VelocityAnswer, now = Date.now()): string[] {
  if (!a.available) return [c.dim(a.reason)];
  const r = a;
  const t = r.totals;
  const lines = [
    `${c.bold(`Velocity — roadmap #${r.tracker}`)}${c.dim(`  ${r.scopeLabel} · as of ${new Date(r.asOf).toLocaleTimeString()}${r.runStartedAt != null ? ` · run began ${fmtDuration(now - r.runStartedAt)} ago` : ""}`)}`,
    `  ${t.complete}/${t.total} complete in ${r.scopeLabel} · ${t.inFlight} in flight · ${t.openAgent} agent and ${t.openOwner} of your steps open`,
    `  ${steps(t.runAgent + t.runOwner)} completed since the run began${t.runOwner ? ` (${t.runOwner} yours)` : ""}${t.runNoCard ? c.dim(` · ${t.runNoCard} without a card`) : ""}`,
    "",
    c.bold("Throughput") + c.dim("  (steps completed per day)"),
  ];
  // A window longer than the run is the run: said once.
  const windows = r.throughput.windows.filter((w, i, all) => w.key === "all" || w.days < all[all.length - 1]!.days - 1e-9);
  for (const w of windows) {
    lines.push(`  ${pad(WINDOW[w.key]!, 20)} ${padL(fmtRate(w.agentPerDay), 5)}/day agents ${c.dim(`(${w.agent} in ${w.days < 1 ? fmtDuration(w.days * DAY) : `${w.days.toFixed(1)}d`})`)}${w.owner ? `   ${fmtRate(w.ownerPerDay)}/day yours ${c.dim(`(${w.owner})`)}` : ""}`);
  }
  if (r.throughput.agentPerHour24 != null) lines.push(c.dim(`  ${r.throughput.agentPerHour24.toFixed(2)} per hour over the last 24 hours`));
  if (r.throughput.byStage.length) lines.push(c.dim(`  by stage: ${r.throughput.byStage.map((s) => `${s.stage || "none"} ${s.complete}/${s.total}`).join(" · ")}`));

  lines.push("", c.bold("Cycle time") + c.dim("  (card start → issue closed, agent steps)"));
  if (r.cycle.all) {
    lines.push(`  ${dist(r.cycle.all)} ${c.dim(`(${steps(r.cycle.all.n)})`)}`);
    if (r.cycle.byStage.length > 1) for (const s of r.cycle.byStage) lines.push(c.dim(`  ${pad(s.stage || "none", 6)} ${dist(s)} (${s.n})`));
  } else lines.push(c.dim("  no step has completed with a card yet"));
  lines.push(c.bold("Lead time") + c.dim("  (ready → issue closed; includes waiting for a slot or for the scope)"));
  lines.push(r.lead.all ? `  ${dist(r.lead.all)} ${c.dim(`(${steps(r.lead.all.n)})`)}` : c.dim("  not measured yet"));
  if (r.lead.owner) lines.push(c.dim(`  yours: ${dist(r.lead.owner)} (${steps(r.lead.owner.n)})`));

  lines.push("", c.bold("Where the time goes") + c.dim(`  (${steps(r.time.n)}, summed)`));
  if (r.time.n === 0) lines.push(c.dim("  nothing to break down yet"));
  else {
    for (const p of r.time.phases.filter((p) => p.totalMs >= 60_000)) {
      lines.push(`  ${pad(p.label, 31)} ${padL(fmtDuration(p.totalMs), 6)} ${padL(fmtPct(p.share), 4)}  ${(p.active ? c.green : c.yellow)(bar(p.share))}${c.dim(`  median ${fmtDuration(p.medianMs)}/step`)}`);
    }
    lines.push(`  Flow efficiency ${fmtPct(r.time.flowEfficiency)} ${c.dim(`— ${fmtDuration(r.time.activeMs)} in agent steps, ${fmtDuration(r.time.waitingMs)} waiting`)}`);
    if (r.time.stepsWithQuota) lines.push(c.dim(`  ${steps(r.time.stepsWithQuota)} ran into a usage limit`));
  }

  lines.push("", c.bold("Rework"));
  if (r.rework.n === 0) lines.push(c.dim("  no reviewed step yet"));
  else {
    lines.push(`  ${r.rework.roundsAvg!.toFixed(1)} review rounds per step on average · ${fmtPct(r.rework.firstPass)} approved first time ${c.dim(`(${r.rework.roundsDist.map((d) => `${d.rounds}×: ${d.steps}`).join(", ")})`)}`);
    lines.push(`  ${r.rework.finishBounces} Finish → Build bounce${r.rework.finishBounces === 1 ? "" : "s"} in ${steps(r.rework.stepsWithBounce)} · ${r.rework.fixCiRuns} automatic Fix CI run${r.rework.fixCiRuns === 1 ? "" : "s"} in ${steps(r.rework.stepsWithFixCi)}`);
  }

  const u = r.utilisation;
  lines.push("", c.bold("Slots"));
  if (u.avgUsed == null) lines.push(c.dim("  no samples yet — collected from the first pass on"));
  else {
    lines.push(`  ${u.avgUsed.toFixed(1)} of ${u.avgMax!.toFixed(u.avgMax! % 1 ? 1 : 0)} in use on average (${fmtPct(u.share)}) · blocked ${fmtPct(u.blockedShare)} of the time${u.quotaShare ? ` · holding for a usage limit ${fmtPct(u.quotaShare)}` : ""}`);
    lines.push(c.dim(`  over ${fmtDuration(u.knownMs)} watched${u.unknownMs > 60_000 ? `; ${fmtDuration(u.unknownMs)} unknown (the app was closed or Autopilot paused)` : ""}`));
  }

  if (r.bottlenecks.critical.length || r.bottlenecks.owner.length) lines.push("", c.bold("Bottlenecks now"));
  for (const b of r.bottlenecks.critical.slice(0, 6)) {
    lines.push(`  ${pad(b.step, 5)} #${b.issue} ${b.title}`, c.dim(`        ${steps(b.successors)} wait behind it · ${bottleneckLine(b, STATE[b.state] ?? b.state)}`));
  }
  const yours = r.bottlenecks.owner.filter((o) => !r.bottlenecks.critical.slice(0, 6).some((b) => b.issue === o.issue));
  if (yours.length) lines.push(c.dim("  Also waiting on you:"));
  for (const b of yours.slice(0, 6)) lines.push(`  ${pad(b.step, 5)} #${b.issue} ${b.title}${c.dim(` — ${bottleneckLine(b, STATE[b.state] ?? b.state)}`)}`);

  lines.push("", c.bold("Forecast") + c.dim("  (an estimate — a range, not a date)"));
  const f = r.forecast;
  if (!f.ok) lines.push(c.yellow(`  ${f.reason}`));
  else {
    for (const tgt of f.targets) lines.push(...forecastLines(tgt, r));
    for (const n of f.notes) lines.push(c.dim(`  · ${n}`));
  }
  if (r.dataQuality.length) {
    lines.push("", c.bold("What couldn't be measured"));
    for (const q of r.dataQuality) lines.push(c.dim(`  · ${q}`));
  }
  return lines;
}
