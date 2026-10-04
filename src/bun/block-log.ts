/**
 * Every pipeline block, appended as it happens (`<dataDir>/blocks.jsonl`), so
 * what still needs a person is measurable: which pipelines and steps block,
 * how, and on what. Read by `GET /blocks` and `agetor blocks`.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PipelineBlock } from "../shared/types.ts";
import { dataDir } from "./db.ts";

export interface BlockLogEntry {
  ts: number;
  taskId: string;
  title: string;
  pipeline: string;
  step: string;
  kind: string;
  message: string;
}

const file = () => path.join(dataDir, "blocks.jsonl");
const MAX_READ = 5000;

const keyOf = (b: Pick<PipelineBlock, "taskId" | "stepId" | "kind" | "message">) => `${b.taskId}\0${b.stepId}\0${b.kind}\0${b.message}`;

/** Blocks in `next` that weren't in `prev` — the ones that just happened. */
export function newBlocks(prev: PipelineBlock[], next: PipelineBlock[]): PipelineBlock[] {
  const seen = new Set(prev.map(keyOf));
  return next.filter((b) => !seen.has(keyOf(b)));
}

export function logBlocks(entries: Omit<BlockLogEntry, "ts">[], now = Date.now()): void {
  if (entries.length === 0) return;
  try {
    appendFileSync(file(), entries.map((e) => `${JSON.stringify({ ts: now, ...e })}\n`).join(""));
  } catch {
    // best-effort
  }
}

export function readBlockLog(sinceMs = 0): BlockLogEntry[] {
  if (!existsSync(file())) return [];
  try {
    return readFileSync(file(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_READ)
      .flatMap((l) => {
        try {
          const e = JSON.parse(l) as BlockLogEntry;
          return e.ts >= sinceMs ? [e] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export interface BlockSummaryRow {
  pipeline: string;
  step: string;
  kind: string;
  count: number;
  lastAt: number;
  examples: { title: string; message: string }[];
}

/** Grouped by pipeline + step + kind, most frequent first. */
export function summarizeBlocks(entries: BlockLogEntry[]): BlockSummaryRow[] {
  const groups = new Map<string, BlockSummaryRow>();
  for (const e of entries) {
    const k = `${e.pipeline}\0${e.step}\0${e.kind}`;
    const g = groups.get(k) ?? { pipeline: e.pipeline, step: e.step, kind: e.kind, count: 0, lastAt: 0, examples: [] };
    g.count++;
    g.lastAt = Math.max(g.lastAt, e.ts);
    g.examples.unshift({ title: e.title, message: e.message });
    g.examples = g.examples.slice(0, 3);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}
