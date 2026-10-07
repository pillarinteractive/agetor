/**
 * Event-loop stall monitor: the core sometimes stops answering (no HTTP
 * response for seconds to minutes) while the process sits at ~0% CPU. This
 * tells the two possible causes apart. A timer that should fire every 500 ms
 * measures how late it really fires; when it's more than 1.5 s late it logs
 * the stall's length and the CPU the process used during it to
 * `<dataDir>/stalls.log`:
 *   - CPU close to the stall's length → the loop was BUSY (synchronous work);
 *   - CPU near zero → the loop was IDLE but not being run (the host app's
 *     event loop didn't hand control back to Bun).
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./db.ts";

const TICK_MS = 500;
const REPORT_OVER_MS = 1_500;
const LOG = path.join(dataDir, "stalls.log");

/** Classify a stall from its length and the CPU spent during it. Pure. */
export function classifyStall(stallMs: number, cpuMs: number): "busy" | "idle" | "mixed" {
  const ratio = cpuMs / Math.max(1, stallMs);
  return ratio >= 0.6 ? "busy" : ratio <= 0.15 ? "idle" : "mixed";
}

let started = false;

export function startStallMonitor(): void {
  if (started) return;
  started = true;
  let expected = Date.now() + TICK_MS;
  let cpu = process.cpuUsage();
  const tick = () => {
    const now = Date.now();
    const late = now - expected;
    const used = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    if (late > REPORT_OVER_MS) {
      const stallMs = late + TICK_MS;
      const cpuMs = Math.round((used.user + used.system) / 1000);
      const mem = Math.round(process.memoryUsage().rss / 1048576);
      try {
        appendFileSync(LOG, `${new Date(now).toISOString()} stall=${stallMs}ms cpu=${cpuMs}ms kind=${classifyStall(stallMs, cpuMs)} rss=${mem}MB\n`);
      } catch {
        // diagnostics only
      }
    }
    expected = now + TICK_MS;
    setTimeout(tick, TICK_MS).unref?.();
  };
  setTimeout(tick, TICK_MS).unref?.();
}
