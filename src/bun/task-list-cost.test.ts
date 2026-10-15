// The lists background loops and the board poll read (db.ts): prompts cut in
// SQL, never whole; a full `get` still returns the whole prompt.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "agetor-list-cost-"));
process.env.AGETOR_DATA_DIR = dir;
const { db, tasks, LIVE_PROMPT_CHARS } = await import("./db.ts");
afterAll(() => rmTestDataDir(dir));

const big = "a".repeat(LIVE_PROMPT_CHARS + 5_000);
db.query(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at, isolation, pipeline_id, pipeline_run)
          VALUES ('c1', 'card', ?, 'running', 'claude-code', '/w', 1, 1, 'none', 'gone-pipeline', '{"pipelineName":"Old Change","status":"done","active":[],"blocked":[],"history":[],"joins":{}}')`).run(big);

test("listLive and a preview list read the prompt cut in SQL; get reads it whole", () => {
  expect(tasks.listLive().find((t) => t.id === "c1")!.prompt.length).toBe(LIVE_PROMPT_CHARS);
  expect(tasks.list({ archived: "none", promptChars: 2_001 }).find((t) => t.id === "c1")!.prompt.length).toBe(2_001);
  expect(tasks.list().find((t) => t.id === "c1")!.prompt.length).toBe(big.length);
  expect(tasks.get("c1")!.prompt).toBe(big);
});

test("pipelines cards run under that no template names, with their frozen name", () => {
  expect(tasks.pipelinesOutside(new Set())).toEqual([{ id: "gone-pipeline", name: "Old Change" }]);
  expect(tasks.pipelinesOutside(new Set(["gone-pipeline"]))).toEqual([]);
});
