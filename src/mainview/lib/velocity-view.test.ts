import { describe, expect, test } from "bun:test";
import { bottleneckRows, capacityView, rateRows, scopeView, timeBuckets, type BottleneckContext } from "./velocity-view.ts";
import { cardState } from "./card-state.ts";
import { velocityFixtureReport } from "../fixtures/velocity-data.ts";
import { fmtDuration, targetRange, type VelocityReport } from "../../shared/velocity.ts";
import type { PipelineRunState, Task } from "../../shared/types.ts";

// A fixed clock: the report and every age below are measured from it.
const NOW = new Date(2031, 2, 4, 15, 0).getTime();
const MIN = 60_000;
const report = velocityFixtureReport(NOW);
const ctx: BottleneckContext = { prs: new Map(), leases: [], now: NOW };
const task = (o: Partial<Task>) => ({ id: "t", title: "T", column: "running", pipelineId: "p", pendingInteractionCount: 0, archivedAt: null, pipelineParentId: null, runId: null, hasOpenableRun: false, prUrl: null, updatedAt: 0, ...o }) as Task;
const run = (o: Partial<PipelineRunState>): PipelineRunState => ({
  pipelineId: "p", pipelineName: "Change", status: "running", active: [], joins: {}, blocked: [], history: [], stepCount: 0, startedAt: 0, endedAt: null, snapshot: null, ...o,
});

describe("timeBuckets", () => {
  const buckets = timeBuckets(report);
  const of = (key: string) => buckets.find((b) => b.key === key)!;
  const phase = (p: string) => report.time.phases.find((x) => x.phase === p)?.totalMs ?? 0;

  test("four buckets that together hold every phase's time, once", () => {
    expect(buckets.map((b) => b.key)).toEqual(["working", "held", "ci", "other"]);
    expect(buckets.reduce((a, b) => a + b.ms, 0)).toBe(report.time.phases.reduce((a, p) => a + p.totalMs, 0));
    expect(buckets.reduce((a, b) => a + (b.share ?? 0), 0)).toBeCloseTo(1, 9);
  });

  test("working is the active phases; the report's own flow efficiency", () => {
    expect(of("working").ms).toBe(report.time.activeMs);
    expect(of("working").share).toBeCloseTo(report.time.flowEfficiency!, 9);
    expect(of("held").ms).toBe(phase("owner"));
    expect(of("ci").ms).toBe(phase("merge"));
    expect(of("other").ms).toBe(phase("quota") + phase("slot") + phase("other"));
  });

  test("each says accumulated task time, and a group of phases has no median", () => {
    for (const b of buckets) expect(b.detail).toContain("of accumulated task time");
    expect(of("held").detail).toContain(`Median per step: ${fmtDuration(report.time.phases.find((p) => p.phase === "owner")!.medianMs)}.`);
    expect(of("other").detail).toContain("A median per step is unavailable for a group of phases.");
  });

  test("the colours say what the time was: green work, amber the owner, blue CI, grey the rest", () => {
    expect(buckets.map((b) => b.tone)).toEqual(["working", "needs", "waiting", "queued"]);
  });

  test("nothing measured: zero time and no share, not an invented split", () => {
    const none = timeBuckets(velocityFixtureReport(NOW, { completed: 1 }));
    expect(none.every((b) => b.ms === 0 && b.share === null)).toBe(true);
  });
});

describe("scopeView", () => {
  test("the gate: remaining steps and the forecast, never a completion or a total", () => {
    const gate = scopeView(report, "gate");
    const target = report.forecast.targets.find((t) => t.key === "gate")!;
    expect(gate.target).toBe(target);
    expect(gate.range).toEqual(targetRange(target));
    expect(gate.completion).toBeNull();
    expect(gate.completionNote).toContain("Completion is not supplied for this scope");
    expect(gate.completionNote).toContain("No total is derived from the gate's step number");
    expect(gate.unavailable).toBeNull();
  });

  test("the whole roadmap: the report's own totals, when it was computed over the roadmap", () => {
    const whole = scopeView(report, "roadmap");
    expect(whole.completion).toEqual({ complete: report.totals.complete, total: report.totals.total, openAgent: report.totals.openAgent, openOwner: report.totals.openOwner, declined: 0 });
    expect(whole.completionNote).toBeNull();
    const scoped = scopeView(velocityFixtureReport(NOW, { view: "current" }), "roadmap");
    expect(scoped.completion).toBeNull();
    expect(scoped.completionNote).toContain("unavailable");
  });

  test("no forecast yet: the report's reason, and no range", () => {
    const low = velocityFixtureReport(NOW, { completed: 4 });
    expect(low.forecast.ok).toBe(false);
    expect(scopeView(low, "roadmap")).toMatchObject({ target: null, range: null, unavailable: low.forecast.reason });
  });

  test("no release gate in the roadmap: unavailable, in words", () => {
    const gate = scopeView(velocityFixtureReport(NOW, { gate: false }), "gate");
    expect(gate).toMatchObject({ target: null, range: null });
    expect(gate.unavailable).toContain("no open release-gate step");
  });

  test("the forecast is the report's: this view changes no number", () => {
    const again: VelocityReport = velocityFixtureReport(NOW);
    expect(scopeView(again, "roadmap").range).toEqual(scopeView(report, "roadmap").range);
    expect(scopeView(report, "roadmap").target!.remainingAgent).toBe(report.forecast.targets.find((t) => t.key === "roadmap")!.remainingAgent);
  });
});

describe("bottleneckRows", () => {
  const top = report.bottlenecks.critical[0]!;

  test("a step with no card keeps the report's state, and its reason is unavailable", () => {
    const rows = bottleneckRows(report, [], ctx);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.task === null && r.action === null && !r.reasonKnown && /unavailable/.test(r.reason))).toBe(true);
    const held = rows.find((r) => report.bottlenecks.critical.find((b) => b.issue === r.issue)?.state === "held");
    expect(held).toMatchObject({ tone: "needs", label: "Held for sign-off" });
  });

  test("a step with a card reads the card's own state, label and button", () => {
    const failed = task({ id: "c1", title: `Issue #${top.issue}: ${top.title}`, column: "blocked", pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s2", stepId: "build", kind: "step-failed", message: 'step "Build" failed — exit 1' }] }) });
    const row = bottleneckRows(report, [failed], ctx).find((r) => r.issue === top.issue)!;
    const state = cardState(failed, { pr: null, lease: { holds: [], waiting: [] }, now: NOW });
    expect(row).toMatchObject({ tone: state.state, label: state.label, icon: state.icon, reason: state.reason, reasonKnown: true, action: state.action, task: failed });
    expect(row.label).toBe("Failed");
  });

  test("an archived card or a step task is not the step's card; the issue url also joins", () => {
    const archived = task({ title: `Issue #${top.issue}: x`, archivedAt: 1 });
    const child = task({ title: `Issue #${top.issue}: x`, pipelineParentId: "parent" });
    expect(bottleneckRows(report, [archived, child], ctx).find((r) => r.issue === top.issue)!.task).toBeNull();
    const byUrl = task({ title: "Renamed card", issueUrl: `https://github.com/o/r/issues/${top.issue}` });
    expect(bottleneckRows(report, [byUrl], ctx).find((r) => r.issue === top.issue)!.task).toBe(byUrl);
  });

  test("dependents are the report's count, worded as steps behind it", () => {
    const row = bottleneckRows(report, [], ctx).find((r) => r.issue === top.issue)!;
    expect(row.dependents).toBe(top.successors);
    expect(row.dependentsLabel).toBe(`${top.successors} steps behind it`);
  });

  test("an attempt maximum is shown only where the run has one", () => {
    const parked = task({
      title: `Issue #${top.issue}: x`, column: "blocked",
      pipelineRun: run({
        status: "blocked", blocked: [{ taskId: "s2", stepId: "build", kind: "step-blocked", message: "waiting" }],
        wait: { stepId: "build", taskId: "s2", category: "environment", source: "text", what: "the network", ref: null, reason: "timeout", state: "waiting", since: NOW - 12 * MIN, attempt: 1, max: 4, at: NOW + 49 * MIN, deadline: NOW + 600 * MIN, tried: [] },
      }),
    });
    expect(bottleneckRows(report, [parked], ctx).find((r) => r.issue === top.issue)!.timing).toBe("Next retry 3:49 PM · attempt 2 of 4");
    const quota = task({
      title: `Issue #${top.issue}: x`, column: "blocked",
      pipelineRun: run({ status: "blocked", blocked: [{ taskId: "s2", stepId: "build", kind: "step-failed", message: "usage limit" }], autoRetry: { stepId: "build", kind: "quota", attempt: 2, at: NOW + 30 * MIN, reason: "usage limit" } }),
    });
    expect(bottleneckRows(report, [quota], ctx).find((r) => r.issue === top.issue)!.timing).toBe("Next retry 3:30 PM · attempt 2 · no maximum recorded");
  });

  test("the owner's steps follow the critical ones, each once", () => {
    const rows = bottleneckRows(report, [], ctx);
    expect(new Set(rows.map((r) => r.issue)).size).toBe(rows.length);
    expect(rows.slice(0, report.bottlenecks.critical.length).map((r) => r.issue)).toEqual(report.bottlenecks.critical.map((b) => b.issue));
  });
});

describe("capacityView", () => {
  test("occupied slots, in the report's averages over all observed time", () => {
    const c = capacityView(report);
    expect(c.available).toBe(true);
    expect(c.occupied).toBe(`${report.utilisation.avgUsed!.toFixed(1)} of 3`);
    expect(c.pips).toHaveLength(3);
    expect(c.window).toBe(`All observed time · ${fmtDuration(report.utilisation.knownMs)}`);
    expect(c.window).not.toContain("48");
    expect(c.note).toContain("An occupied slot may be waiting, not executing.");
    expect(c.note).toContain("went unobserved while the app was closed or Autopilot paused");
  });

  test("the pips round the average to full, half and free slots", () => {
    const at = (avgUsed: number) => capacityView({ ...report, utilisation: { ...report.utilisation, avgUsed, avgMax: 4 } }).pips;
    expect(at(2.5)).toEqual(["full", "full", "half", "empty"]);
    expect(at(2.8)).toEqual(["full", "full", "full", "empty"]);
    expect(at(0.1)).toEqual(["empty", "empty", "empty", "empty"]);
  });

  test("no samples: every figure is unavailable, none is zero", () => {
    const c = capacityView(velocityFixtureReport(NOW, { samples: false }));
    expect(c).toMatchObject({ available: false, occupied: "unavailable", blockedShare: "unavailable", quotaShare: "unavailable", window: "No samples yet" });
    expect(c.pips.every((p) => p === "empty")).toBe(true);
  });
});

describe("rateRows", () => {
  test("the report's three windows, with the bar relative to the fastest", () => {
    const rows = rateRows(report);
    const win = (k: string) => report.throughput.windows.find((w) => w.key === k)!;
    expect(rows.map((r) => [r.key, r.perDay, r.count])).toEqual([
      ["24h", win("24h").agentPerDay, win("24h").agent],
      ["3d", win("3d").agentPerDay, win("3d").agent],
      ["all", win("all").agentPerDay, win("all").agent],
    ]);
    expect(Math.max(...rows.map((r) => r.fraction))).toBe(1);
  });

  test("a window longer than the run says how old the run is", () => {
    const rows = rateRows(report);
    expect(rows.find((r) => r.key === "24h")!.clipped).toBeNull();
    expect(rows.find((r) => r.key === "3d")!.clipped).toBe("the run is 2.8 days old");
    expect(rows.find((r) => r.key === "all")!.clipped).toBeNull();
  });
});
