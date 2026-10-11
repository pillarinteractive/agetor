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

test("a handoff from before the step was sent back into its session is void", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { db, runs } = await import("./db.ts");
  const { executionAssistantText } = await import("./pipeline-runner.ts");
  const made = await createTask({ title: "re-entered step", prompt: "p", agent: "claude-code", workdir: process.cwd(), isolation: "none" });
  if ("error" in made) throw new Error(made.error);
  const taskId = made.task.id;
  const base = { taskId, agent: "claude-code", status: "succeeded", exitCode: 0, tmuxSession: null } as const;
  const mk = (startedAt: number) => {
    const id = randomUUID();
    runs.insert({ ...base, id, startedAt, endedAt: startedAt + 1 } as never);
    return id;
  };
  const handoff = (status: string) => `<handoff>\n{"schemaVersion":1,"purpose":"p","summary":"s","reason":"r","next":null,"status":"${status}"}\n</handoff>`;
  try {
    // The step's first turn stopped at a usage limit and said so.
    const stopped = mk(1_000);
    runs.appendEvent(stopped, "assistant", `Out of usage.\n${handoff("blocked")}`);
    // Resumed in the same session: it worked, started a long command and
    // ended its turn to wait for the result — no handoff yet.
    const resumed = mk(5_000);
    runs.appendEvent(resumed, "assistant", "Verification is running; I'll hand off when it reports back.");
    // Judged as an execution (the old rule) the stale block is found…
    expect(parseHandoff(executionAssistantText(taskId, resumed, 1_000)).ok).toBe(true);
    // …judged as the turn that began at the resume, there is no handoff.
    expect(executionAssistantText(taskId, resumed, 1_000, 5_000)).not.toContain("<handoff>");
    expect(parseHandoff(executionAssistantText(taskId, resumed, 1_000, 5_000)).ok).toBe(false);
    // A reply that landed in a twin run of the same turn is still found (#416).
    const twin = mk(5_044);
    runs.appendEvent(twin, "assistant", handoff("done"));
    const text = executionAssistantText(taskId, resumed, 1_000, 5_000);
    expect(text).toContain('"status":"done"');
    expect(text).not.toContain('"status":"blocked"');
  } finally {
    db.run(`DELETE FROM runs WHERE task_id = ?`, [taskId]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});
