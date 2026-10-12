import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineRunState } from "../shared/types.ts";

// The blocked-step wait queue (pipeline-runner.ts `scheduleBlockWait` /
// `releaseBlockWaits`, rules in src/shared/block-wait.ts). Same bootstrap as
// pipeline-auto-retry.test.ts. Every block reason here is synthetic.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-block-wait-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const BLOCK_ENV = ["AGETOR_FAKE_CLAUDE_BLOCKED_REASON", "AGETOR_FAKE_CLAUDE_BLOCKED_QUESTIONS", "AGETOR_FAKE_CLAUDE_BLOCKED_WAITING", "AGETOR_FAKE_CLAUDE_BLOCKED_NEXT", "AGETOR_FAKE_CLAUDE_BLOCKED_STDERR"];
const MIN = 60_000;
let parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterEach(async () => {
  for (const k of BLOCK_ENV) delete process.env[k];
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { resetBlockWaitsForTests, stopPipelineAutoRetryTimers } = await import("./pipeline-runner.ts");
  resetBlockWaitsForTests();
  stopPipelineAutoRetryTimers();
  const { tasks, preferences } = await import("./db.ts");
  preferences.set("blocked_wait", "{}");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) if (tasks.get(id)) await deleteTask(id).catch(() => {});
  parents = [];
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Build → Review (Build's only edge) → Finish, started. `buildSuffix` is
 *  what Build's turns do: "blocked" (every turn), "blocked-then-Review". */
async function startBuildReview(buildSuffix: string, workdir = mkdtempSync(path.join(tmpdir(), "agetor-block-wait-wd-"))) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const profile = agentProfiles.insert({
    name: `block-wait-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [],
  });
  const step = (name: string, suffix: string) =>
    newStep({ name, agentProfileId: profile.id, instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const build = step("Build", buildSuffix);
  const review = step("Review", "Finish");
  const finish = step("Finish", "done");
  const pipeline = pipelines.insert({
    name: `block-wait-${randomUUID()}`,
    graph: {
      steps: [build, review, finish],
      edges: [
        { id: "e1", from: build.id, to: review.id, label: "" },
        { id: "e2", from: review.id, to: build.id, label: "changes requested" },
        { id: "e3", from: review.id, to: finish.id, label: "approved" },
      ],
      startStepId: build.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "block wait", prompt: "goal", workdir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  return { parentId: created.task.id, build, review, finish, workdir };
}

/** The run once it is blocked and the queue has decided (parked, or not). */
async function blockedRun(parentId: string, pred: (run: PipelineRunState) => boolean = () => true): Promise<PipelineRunState> {
  const { tasks } = await import("./db.ts");
  return waitFor(() => {
    const run = tasks.get(parentId)?.pipelineRun;
    return run?.status === "blocked" && pred(run) ? run : undefined;
  });
}
const parked = (attempt: number) => (run: PipelineRunState) => run.wait?.state === "waiting" && run.wait.attempt === attempt;

async function awaitFixture(){
  const {tasks}=await import('./db.ts');
  const {AWAITS_DIR}=await import('./awaits.ts');
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_REASON='the registered check has not finished';
  process.env.AGETOR_FAKE_CLAUDE_BLOCKED_WAITING=JSON.stringify({waitingOn:'resource',waitingRef:'registered-check'});
  const f=await startBuildReview('blocked-then-Review');
  const run=await blockedRun(f.parentId,parked(0));
  const childId=run.active[0]!.taskId, turn=run.history[0]!.turnStartedAt??run.history[0]!.startedAt;
  tasks.update(f.parentId,{worktreePath:f.workdir});tasks.update(childId,{worktreePath:f.workdir});
  const record=path.join(AWAITS_DIR,'reviewer-'+randomUUID());mkdirSync(record,{recursive:true});
  for(const [name,value]of Object.entries({label:'registered-check',cwd:f.workdir,cmd:'synthetic check',started:String(Math.ceil(turn/1000)),pid:String(process.pid),exit:'0',log:'synthetic result\n'}))writeFileSync(path.join(record,name),value);
  return {...f,childId,record};
}

test('AW1: overlapping ticks deliver the registered completion once',async()=>{
 const {tasks,runs}=await import('./db.ts');
 const {awaitTick}=await import('./awaits.ts');
 const f=await awaitFixture();
 const results=await Promise.all([awaitTick(),awaitTick()]);
 await waitFor(()=>tasks.get(f.parentId)?.pipelineRun?.status==='done');
 const notifications=runs.listForTask(f.childId).flatMap(r=>runs.events(r.id)).filter(e=>e.stream==='user'&&e.data.startsWith('Your background command(s) finished:'));
 
 expect(results.reduce((a,b)=>a+b,0)).toBe(1);expect(notifications).toHaveLength(1);
});

test('AW1: Stop during another notification cancels the later resource wake',async()=>{
 const {tasks,runs}=await import('./db.ts');
 const {awaitTick,readyToWake,listAwaits}=await import('./awaits.ts');
 const {cancelPipelineRun}=await import('./pipeline-runner.ts');
 const f1=await awaitFixture(),f2=await awaitFixture();
 const order=readyToWake(tasks.listLive(),listAwaits());
 const first=[f1,f2].find(f=>f.parentId===order[0]?.parent.id)!;
 const later=[f1,f2].find(f=>f.parentId===order[1]?.parent.id)!;
 process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS='300';
 const ticking=awaitTick();
 await waitFor(()=>tasks.get(first.childId)?.column==='running');
 const stopped=await cancelPipelineRun(later.parentId);
 const waitAfterStop=tasks.get(later.parentId)!.pipelineRun!.wait??null;
 const woke=await ticking;
 delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
 await Bun.sleep(200);
 const notifications=runs.listForTask(later.childId).flatMap(r=>runs.events(r.id)).filter(e=>e.stream==='user'&&e.data.startsWith('Your background command(s) finished:'));
 
 expect(notifications).toHaveLength(0);
 expect(woke).toBe(1);
 expect(existsSync(path.join(later.record,'notified'))).toBe(false);
 expect('error' in stopped).toBe(false);
 expect(tasks.get(later.parentId)!.pipelineRun!.status).not.toBe('running');
 expect(tasks.get(later.parentId)!.pipelineRun!.wait).toBeUndefined();
});


test('AW1: a new owner hold during another notification prevents the later resource wake',async()=>{
 const {tasks,runs}=await import('./db.ts');
 const {awaitTick,readyToWake,listAwaits}=await import('./awaits.ts');
 const f1=await awaitFixture(),f2=await awaitFixture();
 const order=readyToWake(tasks.listLive(),listAwaits());
 const first=[f1,f2].find(f=>f.parentId===order[0]?.parent.id)!;
 const later=[f1,f2].find(f=>f.parentId===order[1]?.parent.id)!;
 process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS='300';
 const ticking=awaitTick();
 await waitFor(()=>tasks.get(first.childId)?.column==='running');
 const held=tasks.get(later.parentId)!.pipelineRun!;
 delete held.wait;
 held.history.find(h=>h.taskId===later.childId)!.handoff!.openQuestions=['May I skip the required check?'];
 held.history.find(h=>h.taskId===later.childId)!.handoff!.waitingOn={on:'owner'};
 tasks.setPipelineRun(later.parentId,held);
 const woke=await ticking;
 delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
 await Bun.sleep(200);
 const notifications=runs.listForTask(later.childId).flatMap(r=>runs.events(r.id)).filter(e=>e.stream==='user'&&e.data.startsWith('Your background command(s) finished:'));
 
 expect(notifications).toHaveLength(0);
 expect(woke).toBe(1);
 expect(existsSync(path.join(later.record,'notified'))).toBe(false);
 expect(tasks.get(later.parentId)!.pipelineRun!.status).toBe('blocked');
});

for(const replacement of ['permission','run-receipt','active-sequence','cancelled-receipt'] as const) {
 test(`AW1: replacement ${replacement} during an earlier notification invalidates the cached wake`,async()=>{
  const {tasks,runs}=await import('./db.ts');
  const {awaitTick,readyToWake,listAwaits}=await import('./awaits.ts');
  const f1=await awaitFixture(),f2=await awaitFixture();
  const order=readyToWake(tasks.listLive(),listAwaits());
  const first=[f1,f2].find(f=>f.parentId===order[0]?.parent.id)!;
  const later=[f1,f2].find(f=>f.parentId===order[1]?.parent.id)!;
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS='300';
  const ticking=awaitTick();
  await waitFor(()=>tasks.get(first.childId)?.column==='running');
  if(replacement==='cancelled-receipt') {
    runs.update(tasks.get(later.childId)!.runId!,{status:'cancelled'});
  } else if(replacement==='run-receipt') {
    const previous=runs.get(tasks.get(later.childId)!.runId!)!;
    const receipt={...previous,id:randomUUID(),startedAt:previous.startedAt+1};
    runs.insert(receipt);tasks.update(later.childId,{runId:receipt.id});
  } else {
    const held=tasks.get(later.parentId)!.pipelineRun!;
    const history=held.history.find(h=>h.taskId===later.childId)!;
    if(replacement==='permission') history.handoff!.reason='Permission was denied; credentials are required';
    else {
      held.active[0]!.seq++;
      held.history.push({...history,seq:held.active[0]!.seq});
    }
    tasks.setPipelineRun(later.parentId,held);
  }
  expect(await ticking).toBe(1);
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  await Bun.sleep(200);
  const notifications=runs.listForTask(later.childId).flatMap(r=>runs.events(r.id))
    .filter(e=>e.stream==='user'&&e.data.startsWith('Your background command(s) finished:'));
  expect(notifications).toHaveLength(0);
  expect(existsSync(path.join(later.record,'notified'))).toBe(false);
 });
}
