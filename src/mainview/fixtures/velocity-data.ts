/**
 * A made-up roadmap run for the Velocity fixture page and its unit tests:
 * the steps, completions, in-flight cards and slot samples a pass would have
 * recorded, turned into a report by the real `computeVelocity`
 * (src/shared/velocity.ts). Nothing here is measured from a real run, and
 * the report's numbers are whatever the shared code makes of this input.
 * Deterministic for a given `now`.
 */
import { computeVelocity, HOUR, type VelocityAnswer, type VelocityGraphStep, type VelocityOpenStep, type VelocityPhase, type VelocityReport, type VelocitySample, type VelocityStepFacts } from "../../shared/velocity.ts";

const MIN = 60_000;

export type VelocityFixtureCase = "roadmap" | "no-forecast" | "no-gate" | "no-samples" | "empty";

export interface VelocityFixtureOptions {
  /** Cut the run down to its first completions (the low-data state). */
  completed?: number;
  /** Leave the release gate out of the roadmap. */
  gate?: boolean;
  /** No slot samples yet. */
  samples?: boolean;
  view?: "current" | "roadmap";
  ownerDelayMs?: number | null;
}

export function velocityFixtureReport(now: number, opts: VelocityFixtureOptions = {}): VelocityReport {
  const began = now - 68 * HOUR;
  // A small fixed generator: the same picture every time.
  let seed = 20260105;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const steps: VelocityGraphStep[] = [];
  const add = (stage: string, title: string, preds: string[], human = false) => {
    const step = String(steps.length + 1);
    steps.push({ step, issue: 800 + steps.length, title, stage, human, preds, status: "open", closedAt: null });
    return step;
  };
  const NOUN = ["inventory", "store", "API", "page", "guide", "importer", "index", "export", "audit", "dock"];
  const device = add("H", "[Human] Provide the sample device", [], true);
  const names = add("H", "[Human] Agree the widget names", [], true);
  const pricing = add("H", "[Human] Decide the gadget pricing", [], true);
  const stage = (code: string, n: number, first: string[]) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(add(code, `${i % 2 ? "Wire" : "Build"} the ${code === "M01" || code === "M03" ? "widget" : "gadget"} ${NOUN[i % NOUN.length]}`, i === 0 ? first : i < 3 ? [ids[0]!] : [ids[i - 2]!, ids[i - 1]!]));
    return ids;
  };
  const m1 = stage("M01", 8, [names]);
  const m2 = stage("M02", 10, [m1[7]!]);
  const m3 = stage("M03", 10, [m1[6]!, device]);
  const approve = add("H", "[Human] Approve the gadget dock", [m2[9]!], true);
  const m4 = stage("M04", 10, [m3[9]!, pricing, approve]);
  if (opts.gate !== false) add("H", "[Human] Publish the main release", [m4[9]!, m4[8]!], true);

  // What is complete, in the order it closed.
  const order = [names, ...m1, device, m2[0]!, m2[1]!, m3[0]!, m2[2]!, m3[1]!, m2[3]!, pricing, m2[4]!, m2[5]!, m3[2]!].slice(0, opts.completed ?? 99);
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const facts: VelocityStepFacts[] = [];
  order.forEach((id, i) => {
    const s = byStep.get(id)!;
    const closedAt = Math.round(began + ((i + 1) / (order.length + 1)) * (now - began - 2 * HOUR) + (rand() - 0.5) * HOUR);
    s.status = "complete";
    s.closedAt = closedAt;
    const readyAt = Math.max(began, ...s.preds.map((p) => byStep.get(p)!.closedAt ?? began));
    const base = { step: s.step, issue: s.issue, stage: s.stage, human: s.human, closedAt, closedFrom: "github" as const, readyAt, prOpenedAt: null, mergedAt: null };
    if (s.human) return void facts.push({ ...base, how: "no-card", cardId: null, cards: 0, startedAt: null, phases: null, reviewRounds: null, finishBounces: null, fixCi: null, quotaHits: null });
    const rounds = 1 + Math.floor(rand() * 3);
    const phases: Partial<Record<VelocityPhase, number>> = {
      slot: Math.round(rand() * 6 * MIN),
      understand: Math.round((6 + rand() * 6) * MIN),
      build: Math.round((35 + rand() * 50) * MIN * (0.6 + rounds * 0.4)),
      review: Math.round((4 + rand() * 6) * MIN * rounds),
      finish: Math.round((3 + rand() * 5) * MIN),
      merge: Math.round((18 + rand() * 30) * MIN),
    };
    if (i % 5 === 2) phases.owner = Math.round((25 + rand() * 60) * MIN);
    if (i % 6 === 4) phases.fixup = Math.round((8 + rand() * 10) * MIN);
    if (i % 7 === 5) phases.quota = Math.round((20 + rand() * 25) * MIN);
    const cycle = Object.values(phases).reduce((a, b) => a + (b ?? 0), 0);
    facts.push({ ...base, how: "card", cardId: `card-${s.issue}`, cards: 1, startedAt: Math.max(readyAt, closedAt - cycle), phases, reviewRounds: rounds, finishBounces: i % 9 === 3 ? 1 : 0, fixCi: phases.fixup ? 1 : 0, quotaHits: phases.quota ? 1 : 0 });
  });

  // In flight: what is ready among M02 and M03, as far as there are slots.
  const ready = steps.filter((s) => s.status === "open" && !s.human && (s.stage === "M02" || s.stage === "M03") && s.preds.every((p) => byStep.get(p)!.status === "complete"));
  const states: VelocityOpenStep["state"][] = ["building", "held", "waiting", "merging"];
  const open: VelocityOpenStep[] = ready.slice(0, 4).map((s, i) => ({
    issue: s.issue,
    state: states[i]!,
    cardId: `card-${s.issue}`,
    startedAt: now - (0.6 + i * 0.9) * HOUR,
    since: states[i] === "held" ? now - 61 * MIN : null,
  }));

  // One sample every five minutes; the app was closed for eight hours.
  const samples: VelocitySample[] = [];
  if (opts.samples !== false) {
    for (let t = Math.max(began, now - 50 * HOUR); t <= now; t += 5 * MIN) {
      const back = (now - t) / HOUR;
      if (back > 22 && back < 30) continue;
      const blocked = (back > 34 && back < 37) || (back > 9 && back < 10.5);
      const used = blocked ? 0 : Math.max(0, Math.min(3, Math.round(1.2 + 1.1 * Math.sin(back / 3) + rand())));
      samples.push({ t: Math.round(t), max: 3, used, blocked, quota: back > 15 && back < 15.7, ready: 0, held: 1 });
    }
  }
  return computeVelocity({
    now,
    tracker: 639,
    asOf: now - 2 * MIN,
    maxInFlight: 3,
    runStartedAt: began,
    steps,
    scope: { label: "M02 and M03", steps: steps.filter((s) => s.stage === "M02" || s.stage === "M03").map((s) => s.step) },
    view: opts.view ?? "roadmap",
    facts,
    open,
    samples,
    hours: [],
    ownerDelayMs: opts.ownerDelayMs,
  });
}

export function velocityFixtureAnswer(now: number, which: VelocityFixtureCase): VelocityAnswer {
  switch (which) {
    case "no-forecast":
      return velocityFixtureReport(now, { completed: 4 });
    case "no-gate":
      return velocityFixtureReport(now, { gate: false });
    case "no-samples":
      return velocityFixtureReport(now, { samples: false });
    case "empty":
      return { available: false, reason: "No velocity data yet — it is collected from the first Autopilot pass on" };
    default:
      return velocityFixtureReport(now);
  }
}
