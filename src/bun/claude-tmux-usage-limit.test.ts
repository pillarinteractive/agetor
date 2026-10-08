import { test, expect, beforeAll, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "agetor-usage-limit-"));
process.env.AGETOR_DATA_DIR = DIR;
// A fake tmux that records every invocation, so the Enter press is observable.
const LOG = path.join(DIR, "tmux.log");
const FAKE = path.join(DIR, "tmux");
writeFileSync(FAKE, `#!/bin/sh\necho "$@" >> '${LOG}'\n`);
chmodSync(FAKE, 0o755);
process.env.AGETOR_TMUX_BIN = FAKE;

const { __forTest } = await import("./claude-tmux.ts");
const { isQuotaPaused } = await import("./usage-limit.ts");
// db.ts captures the data dir of whichever test file loaded it first.
const { dataDir } = await import("./db.ts");
const activity = (id: string) => {
  const f = path.join(dataDir, "activity", `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string }) : [];
};

let n = 0;
const sent = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes("send-keys")) : []);

beforeAll(() => {
  writeFileSync(LOG, "");
});
// Other test files point AGETOR_TMUX_BIN elsewhere; it's read at call time.
beforeEach(() => {
  process.env.AGETOR_TMUX_BIN = FAKE;
});

function session() {
  const id = `ul-${++n}`;
  const state = __forTest.installSession(id, path.join(DIR, `${id}.jsonl`));
  const chunks: string[] = [];
  state.lastChunk = (_stream: string, data: string) => void chunks.push(data);
  return { id, state, chunks };
}

const IDLE_BOX = ["╭────────────────╮", "│ >              │", "╰────────────────╯", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];

test("the stale reset notice gets an Enter after two sightings, once, with an activity line", async () => {
  const { id, state, chunks } = session();
  const pane = ["● Your usage limit was reached, so I stopped here.", "", "  Usage limit has reset · press enter to continue", ...IDLE_BOX];
  const before = sent().length;
  await __forTest.handleUsageLimitNotices(state, pane, pane.join("\n"), 1_000_000);
  expect(sent().length).toBe(before); // first sighting: wait for a stable frame
  await __forTest.handleUsageLimitNotices(state, pane, pane.join("\n"), 1_001_000);
  expect(sent().length).toBe(before + 1);
  expect(sent().at(-1)).toEndWith(`send-keys -t ${state.sessionName} Enter`);
  expect(chunks.at(-1)).toContain("pressed Enter");
  expect(activity(id).some((e) => e.text.includes("pressed Enter"))).toBe(true);
  // Still on screen a moment later: no second press inside the cooldown.
  await __forTest.handleUsageLimitNotices(state, pane, pane.join("\n"), 1_002_000);
  await __forTest.handleUsageLimitNotices(state, pane, pane.join("\n"), 1_003_000);
  expect(sent().length).toBe(before + 1);
  __forTest.uninstallSession(id);
});

test("other limit notices and look-alike prose never press Enter", async () => {
  const { id, state } = session();
  const before = sent().length;
  for (const pane of [
    ["  Usage limit reached · continuing automatically at 8am · esc to cancel", ...IDLE_BOX],
    ["● The docs say: Usage limit has reset · press enter to continue (quoted)", ...IDLE_BOX],
    ["  Automatic continue was turned off · this task will not resume on its own", ...IDLE_BOX],
  ]) {
    for (let i = 0; i < 3; i++) await __forTest.handleUsageLimitNotices(state, pane, pane.join("\n"), 2_000_000 + i * 1000);
  }
  expect(sent().length).toBe(before);
  __forTest.uninstallSession(id);
});

test("a turn paused on the usage limit is marked quota-paused until it resumes", async () => {
  const { id, state } = session();
  const paused = ["● Working on it", "  Usage limit reached · continuing automatically at 11:30pm · esc to cancel", ...IDLE_BOX];
  await __forTest.handleUsageLimitNotices(state, paused, paused.join("\n"), 3_000_000);
  expect(isQuotaPaused(id)).toBe(true);
  const resumed = ["● Working on it", ...IDLE_BOX];
  await __forTest.handleUsageLimitNotices(state, resumed, resumed.join("\n"), 3_001_000);
  expect(isQuotaPaused(id)).toBe(false);
  __forTest.uninstallSession(id);
});
