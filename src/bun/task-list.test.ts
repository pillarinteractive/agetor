// The lean `GET /tasks?lean=1` list (src/bun/task-list.ts): pure shaping
// helpers, then the route itself — prompt previews, the archived opt-in,
// `include=`, the ETag/304 path, the legacy full shape, and the PATCH guard
// that refuses to write a truncated prompt preview back over the real one.
import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfileSnapshot, Task } from "../shared/types.ts";
import {
  FULL_TASK_LIST,
  LIST_PROFILE_INSTRUCTIONS_PREVIEW_CHARS,
  LIST_PROMPT_PREVIEW_CHARS,
  archivedRowsFor,
  isTruncatedPromptWrite,
  listPromptFields,
  parseTaskListOptions,
  shapeTaskForList,
} from "./task-list.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-list-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port (checked via `grep -rhn "AGETOR_API_PORT = " src/bun/*.test.ts`).
process.env.AGETOR_API_PORT = "4617";
const BASE = "http://127.0.0.1:4617";

const LEAN = { lean: true, includeArchived: false, includeIds: [] as string[] };
const LONG = "x".repeat(LIST_PROMPT_PREVIEW_CHARS + 500);

describe("task-list helpers", () => {
  test("parseTaskListOptions: no params is the legacy full list", () => {
    expect(parseTaskListOptions(new URL("http://h/tasks"))).toEqual(FULL_TASK_LIST);
    // archived/include are lean-mode knobs only.
    expect(parseTaskListOptions(new URL("http://h/tasks?archived=0&include=a"))).toEqual(FULL_TASK_LIST);
  });

  test("parseTaskListOptions: lean, archived and include", () => {
    expect(parseTaskListOptions(new URL("http://h/tasks?lean=1"))).toEqual(LEAN);
    expect(parseTaskListOptions(new URL("http://h/tasks?lean=1&archived=1&include=a,,b%20"))).toEqual({
      lean: true,
      includeArchived: true,
      includeIds: ["a", "b"],
    });
  });

  test("archivedRowsFor", () => {
    expect(archivedRowsFor(FULL_TASK_LIST)).toBe("all");
    expect(archivedRowsFor(LEAN)).toBe("none");
    expect(archivedRowsFor({ ...LEAN, includeArchived: true })).toBe("cards");
  });

  test("listPromptFields keeps short prompts and the full list untouched", () => {
    expect(listPromptFields("short", LEAN)).toEqual({ prompt: "short" });
    expect(listPromptFields(LONG, FULL_TASK_LIST)).toEqual({ prompt: LONG });
    const cut = listPromptFields(LONG, LEAN);
    expect(cut.prompt).toHaveLength(LIST_PROMPT_PREVIEW_CHARS);
    expect(cut.promptTruncated).toBe(true);
  });

  test("listPromptFields never splits a surrogate pair", () => {
    const s = "a".repeat(LIST_PROMPT_PREVIEW_CHARS - 1) + "😀" + "tail";
    const cut = listPromptFields(s, LEAN);
    expect(cut.prompt).toBe("a".repeat(LIST_PROMPT_PREVIEW_CHARS - 1));
    expect(cut.promptTruncated).toBe(true);
  });

  test("shapeTaskForList trims a long profile snapshot's instructions in lean mode only", () => {
    const profile = { id: "p", name: "P", instructions: "i".repeat(5_000) } as AgentProfileSnapshot;
    const t = { id: "t", prompt: "p", agentProfile: profile, pipelineRun: null } as unknown as Task;
    const lean = shapeTaskForList(t, LEAN);
    expect(lean.agentProfile?.instructions).toHaveLength(LIST_PROFILE_INSTRUCTIONS_PREVIEW_CHARS);
    expect(lean.agentProfileTruncated).toBe(true);
    expect(t.agentProfile?.instructions).toHaveLength(5_000); // input untouched
    const full = shapeTaskForList(t, FULL_TASK_LIST);
    expect(full.agentProfile?.instructions).toHaveLength(5_000);
    expect(full.agentProfileTruncated).toBeUndefined();
  });

  test("isTruncatedPromptWrite", () => {
    const preview = LONG.slice(0, LIST_PROMPT_PREVIEW_CHARS);
    expect(isTruncatedPromptWrite({ prompt: preview, promptTruncated: true }, LONG)).toBe(true);
    // A list row sent back without its flag is still caught.
    expect(isTruncatedPromptWrite({ prompt: preview }, LONG)).toBe(true);
    expect(isTruncatedPromptWrite({ prompt: "new prompt" }, LONG)).toBe(false);
    expect(isTruncatedPromptWrite({ prompt: LONG }, LONG)).toBe(false);
    expect(isTruncatedPromptWrite({ title: "t", promptTruncated: true }, LONG)).toBe(false);
    expect(isTruncatedPromptWrite({ prompt: "short" }, "short")).toBe(false);
    expect(isTruncatedPromptWrite(null, LONG)).toBe(false);
  });
});

describe("GET /tasks", () => {
  let server: { stop: () => void };
  let token: string;
  let createTask: typeof import("./orchestrator.ts").createTask;
  let tasks: typeof import("./db.ts").tasks;
  let db: typeof import("./db.ts").db;

  beforeAll(async () => {
    ({ createTask } = await import("./orchestrator.ts"));
    ({ tasks, db } = await import("./db.ts"));
    const { startApiServer, API_TOKEN } = await import("./server.ts");
    server = startApiServer() as unknown as { stop: () => void };
    token = API_TOKEN;
  });

  afterAll(() => {
    server?.stop?.();
    rmTestDataDir(DATA_DIR);
  });

  beforeEach(() => {
    db.run(`DELETE FROM tasks`);
  });

  const call = (p: string, init: RequestInit = {}) =>
    fetch(`${BASE}${p}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });

  async function newTask(title: string, prompt = "noop"): Promise<string> {
    const created = await createTask({ title, prompt, agent: "claude-code", workdir: process.cwd(), isolation: "none" });
    if ("error" in created) throw new Error(created.error);
    return created.task.id;
  }

  /** active (long prompt), an archived card, and an archived pipeline step
   *  (a hidden row whose parent is the archived card). */
  async function seed() {
    const active = await newTask("active", LONG);
    const archived = await newTask("archived");
    const step = await newTask("archived step");
    db.run(`UPDATE tasks SET column = 'done', archived_at = ? WHERE id IN (?, ?)`, [Date.now(), archived, step]);
    db.run(`UPDATE tasks SET pipeline_parent_id = ? WHERE id = ?`, [archived, step]);
    return { active, archived, step };
  }

  const ids = (list: Task[]) => list.map((t) => t.id).sort();

  test("no params: the legacy full list (every row, full prompts, no ETag)", async () => {
    const { active, archived, step } = await seed();
    const res = await call("/tasks");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    const list = (await res.json()) as Task[];
    expect(ids(list)).toEqual([active, archived, step].sort());
    const a = list.find((t) => t.id === active)!;
    expect(a.prompt).toBe(LONG);
    expect(a.promptTruncated).toBeUndefined();
  });

  test("lean=1: archived rows left out, prompts previewed, omitted cards counted", async () => {
    const { active } = await seed();
    const res = await call("/tasks?lean=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-agetor-omitted-archived")).toBe("1"); // the card, not the step
    const list = (await res.json()) as Task[];
    expect(ids(list)).toEqual([active]);
    expect(list[0]!.prompt).toBe(LONG.slice(0, LIST_PROMPT_PREVIEW_CHARS));
    expect(list[0]!.promptTruncated).toBe(true);
    expect(typeof list[0]!.runningSubagents).toBe("number"); // live decorations still ride along
    // The single-task route still returns the whole prompt.
    const full = (await (await call(`/tasks/${active}`)).json()) as Task;
    expect(full.prompt).toBe(LONG);
    expect(full.promptTruncated).toBeUndefined();
  });

  test("lean=1&archived=1: archived cards, never archived steps", async () => {
    const { active, archived } = await seed();
    const res = await call("/tasks?lean=1&archived=1");
    expect(res.headers.get("x-agetor-omitted-archived")).toBe("0");
    expect(ids((await res.json()) as Task[])).toEqual([active, archived].sort());
  });

  test("include= keeps named archived rows (the open panel / run view)", async () => {
    const { active, archived, step } = await seed();
    const res = await call(`/tasks?lean=1&include=${archived},${step}`);
    expect(res.headers.get("x-agetor-omitted-archived")).toBe("0");
    expect(ids((await res.json()) as Task[])).toEqual([active, archived, step].sort());
  });

  test("ETag: an unchanged list answers 304, a change answers 200", async () => {
    const { active } = await seed();
    const first = await call("/tasks?lean=1");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await call("/tasks?lean=1", { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    tasks.update(active, { title: "renamed" });
    const changed = await call("/tasks?lean=1", { headers: { "if-none-match": etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(((await changed.json()) as Task[])[0]!.title).toBe("renamed");
  });

  test("CORS exposes the ETag and omitted count and allows If-None-Match", async () => {
    const res = await call("/tasks?lean=1");
    expect(res.headers.get("access-control-expose-headers")).toContain("etag");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-agetor-omitted-archived");
    expect(res.headers.get("access-control-allow-headers")).toContain("if-none-match");
  });

  test("PATCH refuses to write a lean row's prompt preview over the full prompt", async () => {
    const { active } = await seed();
    const row = ((await (await call("/tasks?lean=1")).json()) as Task[])[0]!;
    // The whole lean row sent back (flag included).
    let res = await call(`/tasks/${active}`, { method: "PATCH", body: JSON.stringify(row) });
    expect(res.status).toBe(400);
    // Just the preview, flag stripped.
    res = await call(`/tasks/${active}`, { method: "PATCH", body: JSON.stringify({ prompt: row.prompt }) });
    expect(res.status).toBe(400);
    expect(tasks.get(active)!.prompt).toBe(LONG);
    // A genuine prompt edit and a prompt-less patch still go through.
    res = await call(`/tasks/${active}`, { method: "PATCH", body: JSON.stringify({ prompt: "rewritten" }) });
    expect(res.status).toBe(200);
    expect(tasks.get(active)!.prompt).toBe("rewritten");
    res = await call(`/tasks/${active}`, { method: "PATCH", body: JSON.stringify({ title: "t2", promptTruncated: true }) });
    expect(res.status).toBe(200);
  });
});
