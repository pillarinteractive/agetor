import {test,expect,beforeAll,afterEach,spyOn} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
process.env.AGETOR_DATA_DIR=mkdtempSync(path.join(tmpdir(),'agetor-queue-recovery-'));
process.env.AGETOR_CLAUDE_DRIVER='fake';process.env.AGETOR_CLAUDE_BIN='/bin/echo';process.env.AGETOR_TMUX_BIN='/bin/echo';
process.env.AGETOR_CODEX_DRIVER='fake';
const codex=path.join(process.env.AGETOR_DATA_DIR,'codex');writeFileSync(codex,"#!/bin/sh\necho 'codex-cli 0.162.1'\n");chmodSync(codex,0o755);process.env.AGETOR_CODEX_BIN=codex;
const {tasks,pipelines,agentProfiles,harnesses,preferences}=await import('./db.ts');
const {createTask,startTask,deleteTask}=await import('./orchestrator.ts');
const runner=await import('./pipeline-runner.ts');
const validation=await import('./queue-validation.ts');
const {newStep}=await import('../shared/pipeline.ts');
const {FAKE_CLAUDE_HANDOFF_PROMPT_MARKER:marker}=await import('./agents.ts');
let parents:string[]=[],restore:(()=>void)|null=null;
beforeAll(()=>{runner.initPipelineRunner();preferences.set('step_slots',JSON.stringify({max:8,heavy:{max:2,steps:['Finish']}}));harnesses.setEnabled('codex',true);});
afterEach(async()=>{for(const id of parents)await deleteTask(id);parents=[];restore?.();restore=null;});
async function until<T>(read:()=>T|null|undefined,timeout=5000):Promise<T> {
 const deadline=Date.now()+timeout;for(;;){const value=read();if(value)return value;if(Date.now()>deadline)throw Error('timed out');await new Promise(r=>setTimeout(r,15));}
}
function profile(name:string,harness='claude-code',model='sonnet-5.5') {return agentProfiles.insert({name,harness,model,effort:null,mode:null,fast:false,maxMode:false,instructions:'',skills:[]});}
async function parent(graph:Parameters<typeof pipelines.insert>[0]['graph']) {
 const pipeline=pipelines.insert({name:'queue regression '+randomUUID(),graph,maxSteps:14});
 const result=await createTask({title:'queue regression',prompt:'complete current acceptance',workdir:process.env.AGETOR_DATA_DIR!,isolation:'none',pipelineId:pipeline.id});
 if('error'in result)throw Error(result.error);parents.push(result.task.id);return result.task.id;
}
test('dependency hold survives a fresh process, rechecks with bounded backoff, and advances once without a human retry',async()=>{
 let calls=0,available=false;const spy=spyOn(validation,'reconcileCardInputs').mockImplementation(async()=>{calls++;return available?{}:{hold:'required input #3 is OPEN'};});restore=()=>spy.mockRestore();
 const p=profile('input retry'),step=newStep({name:'Build',agentProfileId:p.id,instructions:marker+':done'});
 const id=await parent({steps:[step],edges:[],startStepId:step.id});await startTask(id);
 const first=tasks.get(id)!.pipelineRun!;expect(first.stepCount).toBe(0);expect(first.blocked[0]!.inputRetry!.attempt).toBe(1);expect(calls).toBe(1);
 const at=first.blocked[0]!.inputRetry!.at;
 const proc=Bun.spawn([process.execPath,'-e',`import {tasks} from './src/bun/db.ts'; console.log(JSON.stringify(tasks.get(${JSON.stringify(id)})?.pipelineRun?.blocked[0]?.inputRetry));`],{cwd:process.cwd(),env:{...process.env},stdout:'pipe',stderr:'pipe'});
 const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);expect(JSON.parse(output.trim())).toEqual({at,attempt:1});
 await runner.releaseSlotWaits(at-1);expect(calls).toBe(1);
 await Promise.all([runner.releaseSlotWaits(at),runner.releaseSlotWaits(at)]);expect(calls).toBe(2);
 const second=tasks.get(id)!.pipelineRun!;expect(second.stepCount).toBe(0);expect(second.blocked[0]!.inputRetry!.attempt).toBe(2);
 const next=second.blocked[0]!.inputRetry!.at;expect(next-Date.now()).toBeGreaterThan(55_000);
 available=true;await Promise.all([runner.releaseSlotWaits(next),runner.releaseSlotWaits(next)]);
 const done=await until(()=>tasks.get(id)?.pipelineRun?.status==='done'?tasks.get(id):null);
 expect(done.pipelineRun!.stepCount).toBe(1);expect(done.pipelineRun!.history).toHaveLength(1);expect(tasks.stepsForParent(id)).toHaveLength(1);
});
test('cancelled dependency hold and genuine questions are never automatically retried',async()=>{
 const spy=spyOn(validation,'reconcileCardInputs').mockResolvedValue({hold:'real source missing'});restore=()=>spy.mockRestore();
 const p=profile('cancel hold'),step=newStep({name:'Build',agentProfileId:p.id,instructions:marker+':done'}),id=await parent({steps:[step],edges:[],startStepId:step.id});await startTask(id);
 const run=tasks.get(id)!.pipelineRun!,at=run.blocked[0]!.inputRetry!.at;
 run.status='cancelled';tasks.setPipelineRun(id,run);await runner.releaseSlotWaits(at);expect(tasks.stepsForParent(id)).toHaveLength(0);
 run.status='blocked';delete run.blocked[0]!.inputRetry;run.blocked[0]!.message='permission requires user authority';tasks.setPipelineRun(id,run);
 await runner.releaseSlotWaits(at+999999);expect(tasks.stepsForParent(id)).toHaveLength(0);expect(spy).toHaveBeenCalledTimes(1);
});
test('Opus planning, Sonnet Build and GPT-6.1 Sol Review run before Finish with frozen role snapshots',async()=>{
 const roles=[profile('planner','claude-code','opus-5.5'),profile('builder','claude-code','sonnet-5.5'),profile('reviewer','codex','gpt-6.1-sol'),profile('finisher','codex','gpt-6-luna')];
 const steps=['Understand','Build','Review','Finish'].map((name,i)=>newStep({name,agentProfileId:roles[i]!.id,instructions:marker+':done'}));
 const id=await parent({steps,edges:steps.slice(1).map((s,i)=>({id:'e'+i,from:steps[i]!.id,to:s.id,label:''})),startStepId:steps[0]!.id});
 await startTask(id);
 // Edits to live profiles must not reroute any active acceptance snapshot.
 for(const p of roles)agentProfiles.update(p.id,{model:'unrelated-live-model'});
 const done=await until(()=>tasks.get(id)?.pipelineRun?.status==='done'?tasks.get(id):null);
 const children=tasks.stepsForParent(id);
 expect(done.pipelineRun!.history.map(h=>h.stepId)).toEqual(steps.map(s=>s.id));
 expect(steps.map(s=>children.find(t=>t.pipelineStepId===s.id)!.model)).toEqual(['opus-5.5','sonnet-5.5','gpt-6.1-sol','gpt-6-luna']);
 expect(done.pipelineRun!.history.every(h=>h.outcome==='succeeded')).toBe(true);expect(done.pipelineRun!.blocked).toHaveLength(0);
});
