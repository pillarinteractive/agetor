import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseHandoff } from "../shared/pipeline.ts";

test("a handoff that landed in a sibling run is still found (#416: reply in one run, empty twin judged)", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const { executionAssistantText } = await import("./pipeline-runner.ts");
  const made = await createTask({ title: "split run", prompt: "p", agent: "claude-code", workdir: process.cwd(), isolation: "none" });
  if ("error" in made) throw new Error(made.error);
  const taskId = made.task.id;
  const base = { taskId, agent: "claude-code", status: "succeeded", exitCode: 0, tmuxSession: null } as const;
  const mk = (startedAt: number) => {
    const id = randomUUID();
    runs.insert({ ...base, id, startedAt, endedAt: startedAt + 1 } as never);
    return id;
  };
  try {
    const first = mk(1_000);
    runs.appendEvent(first, "assistant", "Reviewed it, all good.");
    const reply = mk(5_000);
    runs.appendEvent(reply, "assistant", '<handoff>\n{"schemaVersion":1,"purpose":"p","summary":"approved","reason":"r","next":"Finish","status":"done"}\n</handoff>');
    const twin = mk(5_044); // the duplicate the settle read
    expect(parseHandoff(executionAssistantText(taskId, twin, 1_000)).ok).toBe(true);
    // A run with its own handoff is judged on its own text.
    expect(executionAssistantText(taskId, reply, 1_000)).toContain('"next":"Finish"');
    // Runs from before the execution started don't count.
    expect(parseHandoff(executionAssistantText(taskId, twin, 7_000)).ok).toBe(false);
  } finally {
    db.run(`DELETE FROM runs WHERE task_id = ?`, [taskId]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});
