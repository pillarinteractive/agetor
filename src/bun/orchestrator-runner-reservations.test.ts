import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.AGETOR_DATA_DIR=mkdtempSync(path.join(tmpdir(),'agetor-turn-reservations-'));
for(const name of ['CLAUDE','CODEX','CURSOR','GEMINI','FX']) {
 process.env[`AGETOR_${name}_DRIVER`]='fake';process.env[`AGETOR_${name}_BIN`]='/bin/echo';
}
process.env.AGETOR_TMUX_BIN='/bin/echo';
const codex=path.join(process.env.AGETOR_DATA_DIR,'codex');writeFileSync(codex,"#!/bin/sh\necho 'codex-cli 0.162.1'\n");chmodSync(codex,0o755);process.env.AGETOR_CODEX_BIN=codex;
const fx=path.join(process.env.AGETOR_DATA_DIR,'fx');writeFileSync(fx,'#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Fast native coding agent"; elif [ "$1" = "--version" ]; then echo "0.0.4-fake"; fi\n');chmodSync(fx,0o755);process.env.AGETOR_FX_BIN=fx;
const {tasks,runs,preferences,harnesses}=await import('./db.ts');
const {createTask,startTask,sendInput,deleteTask,__testing}=await import('./orchestrator.ts');
const claude=await import('./claude-tmux.ts');
let created:string[]=[];
afterEach(async()=>{for(const id of created){claude.__forTest.uninstallSession(id);await deleteTask(id);}created=[];preferences.set('dispatch_runner_reservations_v1','{}');});
async function until(read:()=>boolean) {for(let i=0;i<250;i++){if(read())return;await new Promise(r=>setTimeout(r,10));}throw Error('fake turn did not settle');}
function full() {
 preferences.set('step_slots',JSON.stringify({max:8,heavy:{max:2,steps:['Finish']}}));
 preferences.set('dispatch_runner_reservations_v1',JSON.stringify(Object.fromEntries(Array.from({length:8},(_,i)=>['busy-'+i,{taskId:'busy-'+i,runId:null,pid:process.pid,at:Date.now(),name:'Build'}]))));
}
async function idle(agent:string) {
 preferences.set('dispatch_runner_reservations_v1','{}');harnesses.setEnabled(agent,true);
 const result=await createTask({title:'Build',prompt:'initial turn',agent,model:agent==='codex'?'gpt-6.1-sol':undefined,workdir:process.env.AGETOR_DATA_DIR!,isolation:'none',taskType:'task'});
 if('error'in result)throw Error(result.error);const id=result.task.id;created.push(id);
 const started=await startTask(id);if('error'in started)throw Error(started.error);
 await until(()=>runs.listForTask(id)[0]?.status==='succeeded');return id;
}
for(const kind of ['codex','cursor','gemini','fx']) {
 test(`${kind} fresh idle/resume turn declines full capacity without a new receipt; freed capacity admits the same task`,async()=>{
  const id=await idle(kind),old=tasks.get(id)!,runId=old.runId!;full();
  const declined=await sendInput(runId,'ordinary repair');expect(declined.delivered).toBe(false);
  if(declined.delivered)throw Error('unexpected delivered turn');expect(declined.reason).toContain('waiting for a slot');
  expect(runs.listForTask(id)).toHaveLength(1);expect(tasks.get(id)!.runId).toBe(runId);expect(tasks.get(id)!.model).toBe(old.model);
  preferences.set('dispatch_runner_reservations_v1','{}');const resumed=await sendInput(runId,'ordinary repair');expect(resumed.delivered).toBe(true);
  await until(()=>runs.listForTask(id).length===2&&runs.listForTask(id)[0]!.status==='succeeded');
  const claim=JSON.parse(preferences.get('dispatch_runner_reservations_v1')!)[id];expect(claim.runId).toBe(tasks.get(id)!.runId);
 });
}
test('Claude populated idle session and dead-session resume both preserve full-capacity ownership',async()=>{
 const id=await idle('claude-code'),runId=tasks.get(id)!.runId!;
 const jsonl=path.join(process.env.AGETOR_DATA_DIR!,id+'.jsonl');writeFileSync(jsonl,'');claude.__forTest.installSession(id,jsonl);full();
 const existing=await sendInput(runId,'ordinary repair');expect(existing.delivered).toBe(false);if(existing.delivered)throw Error('unexpected paste');expect(existing.reason).toContain('waiting for a slot');expect(runs.listForTask(id)).toHaveLength(1);
 claude.__forTest.uninstallSession(id);const dead=await sendInput(runId,'ordinary repair');expect(dead.delivered).toBe(false);if(dead.delivered)throw Error('unexpected resume');expect(dead.reason).toContain('waiting for a slot');expect(runs.listForTask(id)).toHaveLength(1);
 preferences.set('dispatch_runner_reservations_v1','{}');expect((await sendInput(runId,'ordinary repair')).delivered).toBe(true);
 await until(()=>runs.listForTask(id).length===2&&runs.listForTask(id)[0]!.status==='succeeded');
});
test('accepted one-shot followups retain their FIFO while capacity is full and resume once when freed',async()=>{
 for(const [kind,drain] of [['codex',__testing.drainCodexQueue],['cursor',__testing.drainCursorQueue],['gemini',__testing.drainGeminiQueue],['fx',__testing.drainFxQueue]] as const) {
  preferences.set('dispatch_runner_reservations_v1','{}');harnesses.setEnabled(kind,true);process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS='150';
  const made=await createTask({title:'Build',prompt:'first',agent:kind,workdir:process.env.AGETOR_DATA_DIR!,isolation:'none',taskType:'task'});if('error'in made)throw Error(made.error);
  const id=made.task.id;created.push(id);const started=await startTask(id);if(!('runId'in started))throw Error('no initial run');
  expect((await sendInput(started.runId,'retained exact followup')).delivered).toBe(true);full();
  await until(()=>__testing.pendingRunnerRecheck(id));expect(runs.listForTask(id)).toHaveLength(1);
  await drain(id);expect(runs.listForTask(id)).toHaveLength(1);
  preferences.set('dispatch_runner_reservations_v1','{}');await drain(id);
  await until(()=>runs.listForTask(id).length===2&&runs.listForTask(id)[0]!.status==='succeeded');
  expect(runs.listForTask(id)).toHaveLength(2);await deleteTask(id);expect(__testing.pendingRunnerRecheck(id)).toBe(false);
 }
 delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
});
