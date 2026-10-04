#!/usr/bin/env bun
/**
 * Copy projects, Agents (profiles), Pipelines and custom harness aliases from the
 * release data dir (`~/.agetor`) into the dev sandbox (`~/.agetor-dev`), so
 * `bun run dev` starts with the same setup as the app you use day to day.
 *
 * Goes through each instance's HTTP API (the same calls `agetor profile` /
 * `agetor pipeline export|import` make), never the SQLite files, so dev-side
 * migrations and validation still apply. Upserts by name: re-running updates
 * what changed and never duplicates. Nothing is deleted on either side, and
 * tasks/runs are never copied.
 *
 * Built-in harnesses can't be edited over the API, so their bin/env overrides
 * are not synced — launch the dev app from a terminal so agents inherit your
 * shell PATH.
 *
 *   bun run sync:dev [--from <dir>] [--to <dir>] [--dry-run]
 */
import os from "node:os";
import path from "node:path";
import { AgetorClient, discoverCore, type AgentProfileInput } from "../src/cli/api-client.ts";
import { ensureCore, spawnDaemon, stopDaemon } from "../src/cli/daemon/supervisor.ts";
import type { AgentProfile, Pipeline, PipelineGraph } from "../src/shared/types.ts";

const DEV_PORT = 4318;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDir = flag("--from") ?? path.join(os.homedir(), ".agetor");
const toDir = flag("--to") ?? path.join(os.homedir(), ".agetor-dev");
const dryRun = process.argv.includes("--dry-run");

if (path.resolve(fromDir) === path.resolve(toDir)) {
  console.error("--from and --to must be different data dirs");
  process.exit(1);
}

const src = new AgetorClient(await ensureCore({ dataDir: fromDir, noDaemon: true }));
// When the dev app isn't running, sync through a temporary headless core and
// shut it down afterwards so it doesn't hold the dev port for `bun run dev`.
const runningDst = await discoverCore(toDir);
const dst = new AgetorClient(runningDst ?? (await spawnDaemon({ dataDir: toDir, port: DEV_PORT })));
const say = (msg: string) => console.log(`${dryRun ? "[dry-run] " : ""}${msg}`);

try {

  // ── projects (repo paths) ──────────────────────────────────────────────────
  const dstProjectPaths = new Set((await dst.listProjects()).map((p) => p.path));
  for (const p of await src.listProjects()) {
    if (dstProjectPaths.has(p.path)) continue;
    say(`project ${p.path}: add`);
    if (!dryRun) await dst.addProject(p.path, p.name);
  }

  // ── harness aliases ────────────────────────────────────────────────────────
  const { harnesses: srcHarnesses } = await src.listHarnesses();
  const { harnesses: dstHarnesses } = await dst.listHarnesses();
  for (const h of srcHarnesses) {
    const existing = dstHarnesses.find((d) => d.id === h.id);
    if (h.isBuiltin) {
      if (existing && existing.enabled !== h.enabled) {
        say(`harness ${h.id}: ${h.enabled ? "enable" : "disable"}`);
        if (!dryRun) await dst.patchHarness(h.id, { enabled: h.enabled });
      }
      continue;
    }
    const config = { label: h.label, home: h.home, bin: h.bin, env: h.env };
    say(`harness ${h.id}: ${existing ? "update" : "create"}`);
    if (dryRun) continue;
    if (existing) await dst.patchHarness(h.id, { ...config, enabled: h.enabled });
    else await dst.createHarness({ id: h.id, kind: h.kind, ...config });
  }

  // ── agent profiles (by name) ───────────────────────────────────────────────
  const srcProfiles = await src.listAgentProfiles();
  const dstProfiles = await dst.listAgentProfiles();
  const dstProfileByName = new Map(dstProfiles.map((p) => [p.name.toLowerCase(), p]));
  for (const p of srcProfiles) {
    const input: AgentProfileInput = {
      name: p.name,
      harness: p.harness,
      model: p.model,
      effort: p.effort,
      mode: p.mode,
      fast: p.fast,
      maxMode: p.maxMode,
      instructions: p.instructions,
      skills: p.skills,
    };
    const existing = dstProfileByName.get(p.name.toLowerCase());
    say(`agent "${p.name}": ${existing ? "update" : "create"}`);
    if (dryRun) continue;
    const saved: AgentProfile = existing
      ? await dst.patchAgentProfile(existing.id, input)
      : await dst.createAgentProfile(input);
    dstProfileByName.set(saved.name.toLowerCase(), saved);
  }

  // ── pipelines (by name, step agents remapped by name) ──────────────────────
  const srcNameById = new Map(srcProfiles.map((p) => [p.id, p.name.toLowerCase()]));
  const remap = (id: string | null): string | null => {
    if (!id) return id;
    const name = srcNameById.get(id);
    return (name && dstProfileByName.get(name)?.id) ?? id;
  };
  const dstPipelines = await dst.listPipelines();
  for (const summary of await src.listPipelines()) {
    const p: Pipeline = await src.getPipeline(summary.id);
    const graph: PipelineGraph = {
      ...p.graph,
      steps: p.graph.steps.map((s) => ({
        ...s,
        agentProfileId: remap(s.agentProfileId),
        subagents: { ...s.subagents, profileIds: s.subagents.profileIds.map((id) => remap(id) ?? id) },
      })),
    };
    const input = { name: p.name, description: p.description, graph, maxSteps: p.maxSteps };
    const existing = dstPipelines.find((d) => d.name.toLowerCase() === p.name.toLowerCase());
    say(`pipeline "${p.name}": ${existing ? "update" : "create"}`);
    if (dryRun) continue;
    if (existing) await dst.updatePipeline(existing.id, input);
    else await dst.createPipeline(input);
  }

  say(`synced ${fromDir} → ${toDir}`);
} finally {
  if (!runningDst) await stopDaemon(toDir);
}
