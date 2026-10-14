// Transcript retention (event-retention.ts): events of cards archived before
// the cutoff go, a pipeline card's steps' events with it; everything else and
// the cards themselves stay; the database switches to incremental vacuum.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "agetor-retention-"));
process.env.AGETOR_DATA_DIR = dir;
const { db, preferences } = await import("./db.ts");
const r = await import("./event-retention.ts");
afterAll(() => rmTestDataDir(dir));

const DAY = 86_400_000;
const NOW = 100 * DAY;
function card(id: string, archivedAt: number | null, parent: string | null = null) {
  db.query(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at, isolation, archived_at, pipeline_parent_id)
            VALUES (?, ?, '', 'done', 'claude-code', '/w', 0, 0, 'none', ?, ?)`).run(id, id, archivedAt, parent);
  db.query(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES (?, ?, 'claude-code', 'succeeded', 0)`).run(`run-${id}`, id);
  for (let i = 0; i < 5; i++) db.query(`INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'stdout', ?, 0)`).run(`run-${id}`, "x".repeat(200));
}
const events = (id: string) => (db.query("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?").get(`run-${id}`) as { n: number }).n;

test("incremental vacuum is switched on only when a quarter of the file is free, then reclaims", async () => {
  const mode = () => (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
  r.enableIncrementalVacuum(() => {});
  expect(mode()).toBe(0); // little free space: no VACUUM
  card("bulk", NOW - 9 * DAY);
  for (let i = 0; i < 3_000; i++) db.query(`INSERT INTO run_events (run_id, stream, data, ts) VALUES ('run-bulk', 'stdout', ?, 0)`).run("z".repeat(2_000));
  await r.pruneArchivedEvents(NOW);
  const lines: string[] = [];
  r.enableIncrementalVacuum((s) => lines.push(s));
  expect(mode()).toBe(2);
  expect(lines[0]).toContain("incremental auto-vacuum");
  expect(() => r.reclaimSpace()).not.toThrow();
});

test("the preference: two days by default, a number of days, or off", () => {
  expect(r.parseRetention(null)).toEqual({ archivedDays: 2 });
  expect(r.parseRetention(JSON.stringify({ archivedDays: 7 }))).toEqual({ archivedDays: 7 });
  expect(r.parseRetention(JSON.stringify({ enabled: false }))).toBeNull();
  expect(r.parseRetention("junk")).toEqual({ archivedDays: 2 });
});

test("archived long enough ago: the card's and its steps' events go; recent, live and the cards stay", async () => {
  card("old", NOW - 3 * DAY);
  card("old-step", null, "old");
  card("recent", NOW - DAY);
  card("live", null);
  preferences.set(r.RETENTION_PREF, JSON.stringify({ archivedDays: 2 }));
  await r.retentionSweep(() => {}, NOW);
  expect([events("old"), events("old-step"), events("recent"), events("live")]).toEqual([0, 0, 5, 5]);
  const four = "('old','old-step','recent','live')";
  expect((db.query(`SELECT COUNT(*) AS n FROM tasks WHERE id IN ${four}`).get() as { n: number }).n).toBe(4);
  expect((db.query(`SELECT COUNT(*) AS n FROM runs WHERE task_id IN ${four}`).get() as { n: number }).n).toBe(4);
  preferences.set(r.RETENTION_PREF, JSON.stringify({ enabled: false }));
  await r.retentionSweep(() => {}, NOW + 10 * DAY);
  expect(events("recent")).toBe(5);
});

test("batches stop at the cap and resume on the next sweep", async () => {
  card("big", NOW - 5 * DAY);
  for (let i = 0; i < 4_500; i++) db.query(`INSERT INTO run_events (run_id, stream, data, ts) VALUES ('run-big', 'stdout', 'y', 0)`).run();
  expect(await r.pruneArchivedEvents(NOW - 2 * DAY, 1)).toBe(2_000);
  expect(await r.pruneArchivedEvents(NOW - 2 * DAY)).toBe(2_505);
  expect(events("big")).toBe(0);
});

