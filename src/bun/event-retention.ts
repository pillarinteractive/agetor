/**
 * Transcript retention (owner decision 2026-10-14). `run_events` holds every
 * streamed line of every run; on the Pillar board it reached 911 MB in eleven
 * days, 786 MB of it for archived cards, and the database 1.25 GB. An
 * archived card's transcript is only read if someone opens that card, so the
 * events of a card archived longer than `archivedDays` ago are deleted, in
 * small batches so the core is never held for long. The card itself, its
 * run rows, handoff files, reports and activity log are kept.
 *
 * Space comes back without a blocking VACUUM: the database is switched to
 * incremental auto-vacuum once (that switch takes one VACUUM, done at boot
 * only while the free space is large), and after each prune a bounded
 * `incremental_vacuum` returns freed pages and the WAL is truncated.
 *
 * `run_events_retention` preference: {"archivedDays": 2} (default), or
 * {"enabled": false}.
 */
import { db, preferences } from "./db.ts";

export const RETENTION_PREF = "run_events_retention";
const BATCH = 2_000;
const MAX_BATCHES_PER_SWEEP = 200;
/** Pages returned to the filesystem per sweep (4 KiB each: ~400 MB). */
const VACUUM_PAGES = 100_000;

export function parseRetention(raw: string | null | undefined): { archivedDays: number } | null {
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return { archivedDays: 2 };
    if (v.enabled === false) return null;
    const d = v.archivedDays;
    return { archivedDays: typeof d === "number" && d >= 0 && d <= 3650 ? d : 2 };
  } catch {
    return { archivedDays: 2 };
  }
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/** Delete the events of cards archived before `cutoffMs` — a card's own
 *  runs and, for a pipeline card, its steps' runs. Returns rows deleted. */
export async function pruneArchivedEvents(cutoffMs: number, maxBatches = MAX_BATCHES_PER_SWEEP): Promise<number> {
  const del = db.query(
    `DELETE FROM run_events WHERE id IN (
       SELECT e.id FROM run_events e
       JOIN runs r ON r.id = e.run_id
       JOIN tasks t ON t.id = r.task_id
       LEFT JOIN tasks p ON p.id = t.pipeline_parent_id
       WHERE COALESCE(p.archived_at, t.archived_at) IS NOT NULL
         AND COALESCE(p.archived_at, t.archived_at) < ?
       LIMIT ${BATCH})`,
  );
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = del.run(cutoffMs).changes;
    total += n;
    if (n < BATCH) break;
    await yieldToLoop();
  }
  return total;
}

/** Return freed pages to the filesystem (incremental auto-vacuum only) and
 *  truncate the WAL. */
export function reclaimSpace(pages = VACUUM_PAGES): void {
  const mode = (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null)?.auto_vacuum;
  if (mode === 2) db.exec(`PRAGMA incremental_vacuum(${pages})`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** At boot: switch to incremental auto-vacuum when it isn't, which takes one
 *  full VACUUM — done only when at least a quarter of the file is free, so
 *  the one-off wait buys real space. */
export function enableIncrementalVacuum(log: (s: string) => void): void {
  const mode = (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null)?.auto_vacuum;
  if (mode === 2) return;
  const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  if (pages === 0 || free / pages < 0.25) return;
  const started = Date.now();
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
  log(`database switched to incremental auto-vacuum (${Math.round((free * 4096) / 1e6)} MB returned) in ${Date.now() - started} ms`);
}

/** One sweep: prune by the preference, then reclaim. */
export async function retentionSweep(log: (s: string) => void, now = Date.now()): Promise<void> {
  const policy = parseRetention(preferences.get(RETENTION_PREF));
  if (!policy) return;
  const deleted = await pruneArchivedEvents(now - policy.archivedDays * 86_400_000);
  if (deleted > 0) {
    reclaimSpace();
    log(`transcript retention: deleted ${deleted} events of cards archived over ${policy.archivedDays} day(s) ago`);
  }
}
