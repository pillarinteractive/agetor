/**
 * Keep the Mac awake while agents are working. A long agent turn (a VM or
 * E2E run can take most of an hour) dies with "Your computer went to sleep
 * mid-response" if the machine idles to sleep, and the task blocks. While any
 * task is running, Agetor holds a `caffeinate -i -s` assertion (no idle
 * sleep; no system sleep on AC power) and releases it as soon as nothing is
 * running. `-w <pid>` ties caffeinate to this process, so a crash or quit can
 * never leave the Mac pinned awake.
 *
 * On by default; the `keepAwakeWhileRunning` preference set to "false" turns
 * it off. macOS only.
 */
import type { Subprocess } from "bun";
import type { Task } from "../shared/types.ts";
import { preferences, tasks } from "./db.ts";
import { subscribeGlobal } from "./orchestrator.ts";

export const KEEP_AWAKE_PREF_KEY = "keepAwakeWhileRunning";
const CHECK_MS = 10_000;

export function keepAwakeEnabled(pref: string | null, platform: string = process.platform): boolean {
  return platform === "darwin" && pref !== "false";
}

/** Any live (non-archived) task — a pipeline step included — in Running. */
export function hasRunningWork(list: Task[]): boolean {
  return list.some((t) => t.archivedAt == null && t.column === "running");
}

type Spawn = (argv: string[]) => Pick<Subprocess, "kill" | "exited">;

/** Holds or releases the assertion to match `wanted`. Exported for tests. */
export class KeepAwake {
  private proc: Pick<Subprocess, "kill" | "exited"> | null = null;

  constructor(private readonly spawn: Spawn = (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })) {}

  get held(): boolean {
    return this.proc !== null;
  }

  set(wanted: boolean): void {
    if (wanted && !this.proc) {
      try {
        const proc = this.spawn(["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)]);
        this.proc = proc;
        // If caffeinate dies on its own, let the next check start a new one.
        void proc.exited.then(() => {
          if (this.proc === proc) this.proc = null;
        });
      } catch {
        this.proc = null;
      }
    } else if (!wanted && this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill();
    }
  }
}

let loop: ReturnType<typeof setInterval> | null = null;

/** Start following the board. Idempotent; the timer is unref'd so it never
 *  keeps the headless daemon alive past its idle shutdown. */
export function startKeepAwakeLoop(): void {
  if (loop) return;
  const keepAwake = new KeepAwake();
  const check = () => {
    try {
      keepAwake.set(keepAwakeEnabled(preferences.get(KEEP_AWAKE_PREF_KEY)) && hasRunningWork(tasks.list()));
    } catch {
      // A failed read just waits for the next tick.
    }
  };
  check();
  loop = setInterval(check, CHECK_MS);
  loop.unref?.();
  // React to a task starting or stopping right away rather than up to a tick later.
  subscribeGlobal((e) => {
    if (e.kind === "column" || e.kind === "run-status") queueMicrotask(check);
  });
  process.on("exit", () => keepAwake.set(false));
}
