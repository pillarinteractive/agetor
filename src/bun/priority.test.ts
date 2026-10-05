import { expect, test } from "bun:test";
import { db, tasks } from "./db.ts";
import { isPriority, priorityFirst, readPriority, setPriority } from "./priority.ts";

test("readPriority drops junk", () => {
  expect([...readPriority(JSON.stringify(["a", 3, "b"]))]).toEqual(["a", "b"]);
  expect(readPriority("nope").size).toBe(0);
});

test("a priority card and its steps go first; Done or archived cards stop being priority", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const made = await createTask({ title: "urgent", prompt: "p", agent: "claude-code", workdir: process.cwd() });
  if ("error" in made) throw new Error(made.error);
  const id = made.task.id;
  try {
    expect(isPriority(id)).toBe(false);
    expect(setPriority(id, true)).toEqual({ ok: true, priority: true });
    expect(isPriority(id)).toBe(true);
    expect(priorityFirst(["x", id, "y"], (s) => s)).toEqual([id, "x", "y"]);
    tasks.update(id, { column: "done" });
    expect(isPriority(id)).toBe(false);
    tasks.update(id, { column: "running" });
    setPriority(id, false);
    expect(isPriority(id)).toBe(false);
    expect(setPriority("missing", true)).toEqual({ error: "task not found" });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});
