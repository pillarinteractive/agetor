import {afterAll, expect, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Task} from '../shared/types.ts';
import type {AwaitRecord} from './awaits.ts';
import {rmTestDataDir} from './test-data-dir.ts';

const dir=mkdtempSync(path.join(tmpdir(),'agetor-resource-await-'));
process.env.AGETOR_DATA_DIR=dir;
const {readyToWake}=await import('./awaits.ts');
afterAll(()=>rmTestDataDir(dir));

function fixture() {
  const cwd='/synthetic/current', started=2_000_000;
  const job:AwaitRecord={id:'current-job',dir:'/synthetic/awaits/current-job',cwd,label:'review verification',cmd:'synthetic check',
    startedAt:started+1000,pid:null,exitCode:0,finished:true,notified:false,resourceState:'finished'};
  const handoff={status:'blocked',purpose:'review',summary:'Checks started',reason:'The existing check has not finished',
    next:null,openQuestions:[] as string[],artifacts:[path.join(job.dir,'log')],waitingOn:{on:'resource',ref:job.label}};
  const parent={id:'parent',column:'blocked',archivedAt:null,worktreePath:cwd,pendingInteractionCount:0,pipelineRun:{status:'blocked',
    active:[{taskId:'child',stepId:'review',seq:2}],blocked:[{taskId:'child',stepId:'review',kind:'step-blocked',message:'check pending'}],
    history:[{taskId:'child',stepId:'review',seq:1,startedAt:1_000_000,turnStartedAt:1_000_000,handoff:null},
      {taskId:'child',stepId:'review',seq:2,startedAt:started,turnStartedAt:started,handoff}],
    wait:{taskId:'child',stepId:'review',category:'resource',source:'declared',ref:job.label,state:'waiting'}}} as unknown as Task;
  const child={id:'child',column:'review',archivedAt:null,pipelineParentId:'parent',pendingInteractionCount:0} as Task;
  return {parent,child,job,handoff};
}

test('an exact completed registered resource await wakes the same blocked review with its honest result',()=>{
  const f=fixture();
  expect(readyToWake([f.parent,f.child],[f.job]).map(w=>[w.stepTaskId,w.done[0]?.id])).toEqual([['child','current-job']]);
  for (const exitCode of [1,null]) {
    expect(readyToWake([f.parent,f.child],[{...f.job,exitCode}])[0]?.done[0]?.exitCode).toBe(exitCode);
  }
});

test('resource notification waits for all current-turn commands and excludes already notified results',()=>{
  const f=fixture();
  expect(readyToWake([f.parent,f.child],[{...f.job,finished:false,exitCode:null,resourceState:'waiting'}])).toEqual([]);
  const sibling={...f.job,id:'other-current-job',dir:'/synthetic/awaits/other-current-job',finished:false,exitCode:null};
  expect(readyToWake([f.parent,f.child],[f.job,sibling])).toEqual([]);
  expect(readyToWake([f.parent,f.child],[{...f.job,notified:true}])).toEqual([]);
});

test('resource notification requires current execution, exact binding, same worktree, and current-turn timing',()=>{
  const f=fixture();
  expect(readyToWake([f.parent,f.child],[{...f.job,cwd:'/synthetic/other'}])).toEqual([]);
  expect(readyToWake([f.parent,f.child],[{...f.job,startedAt:1_500_000}])).toEqual([]);
  f.handoff.artifacts=[];f.handoff.waitingOn.ref='another job';
  expect(readyToWake([f.parent,f.child],[f.job])).toEqual([]);
  f.handoff.waitingOn.ref=f.job.label;f.parent.pipelineRun!.active=[];
  expect(readyToWake([f.parent,f.child],[f.job])).toEqual([]);
});

test('declared resource wakes exclude prior-turn receipts even inside the legacy five-second window',()=>{
  const f=fixture();
  const history=f.parent.pipelineRun!.history[1]!;
  for(const offset of [-4000,-1000,-1]) {
    expect(readyToWake([f.parent,f.child],[{...f.job,startedAt:history.turnStartedAt!+offset}])).toEqual([]);
  }
  // A seconds-only timestamp in the turn's first second cannot prove ownership.
  history.turnStartedAt=2_000_492;
  expect(readyToWake([f.parent,f.child],[{...f.job,startedAt:2_000_000}])).toEqual([]);
  expect(readyToWake([f.parent,f.child],[{...f.job,startedAt:2_001_000}])).toHaveLength(1);
});

test('explicit foreign, stale or conflicting job references cannot be satisfied by an unrelated local log',()=>{
  const f=fixture();
  const foreign={...f.job,id:'foreign-job',label:'foreign check',dir:'/synthetic/awaits/foreign-job',cwd:'/synthetic/foreign',finished:false,exitCode:null};
  f.handoff.waitingOn.ref=foreign.id;f.parent.pipelineRun!.wait!.ref=foreign.id;
  expect(readyToWake([f.parent,f.child],[f.job,foreign])).toEqual([]);
  f.handoff.waitingOn.ref=foreign.label;f.parent.pipelineRun!.wait!.ref=foreign.label;
  expect(readyToWake([f.parent,f.child],[f.job,foreign])).toEqual([]);
  // A local label that happens to equal the foreign ID cannot shadow it.
  f.handoff.waitingOn.ref=foreign.id;f.parent.pipelineRun!.wait!.ref=foreign.id;
  expect(readyToWake([f.parent,f.child],[{...f.job,label:foreign.id},foreign])).toEqual([]);
  f.handoff.waitingOn.ref='missing-job';f.parent.pipelineRun!.wait!.ref='missing-job';
  expect(readyToWake([f.parent,f.child],[f.job])).toEqual([]);
  f.handoff.waitingOn.ref=f.job.id;f.parent.pipelineRun!.wait!.ref=foreign.id;
  expect(readyToWake([f.parent,f.child],[f.job,foreign])).toEqual([]);
  const stale={...foreign,cwd:f.job.cwd,startedAt:1_500_000,finished:true,exitCode:0};
  f.handoff.waitingOn.ref=stale.id;f.parent.pipelineRun!.wait!.ref=stale.id;
  expect(readyToWake([f.parent,f.child],[f.job,stale])).toEqual([]);
});

test('job id and scoped label can bind the same receipt; log fallback requires absent explicit references',()=>{
  const f=fixture();
  f.handoff.waitingOn.ref=f.job.id;f.parent.pipelineRun!.wait!.ref=f.job.label;
  expect(readyToWake([f.parent,f.child],[f.job])).toHaveLength(1);
  delete (f.handoff.waitingOn as {ref?:string}).ref;f.parent.pipelineRun!.wait!.ref=null;
  expect(readyToWake([f.parent,f.child],[f.job])).toHaveLength(1);
  // Labels are scoped to the current turn/worktree; another card can reuse one.
  const elsewhere={...f.job,id:'elsewhere',cwd:'/synthetic/elsewhere'};
  f.handoff.waitingOn.ref=f.job.label;f.parent.pipelineRun!.wait!.ref=f.job.label;
  expect(readyToWake([f.parent,f.child],[f.job,elsewhere])).toHaveLength(1);
});

test('owner requests, permissions, cancelled runs, and live children remain held',()=>{
  for (const change of ['question','permission','owner','interaction','cancelled','running','escalated','unclassified'] as const) {
    const f=fixture();
    if(change==='question')f.handoff.openQuestions=['May I skip the check?'];
    if(change==='permission')f.handoff.reason='Access was denied; credentials required';
    if(change==='owner')f.handoff.waitingOn.on='owner';
    if(change==='interaction')f.child.pendingInteractionCount=1;
    if(change==='cancelled')f.parent.pipelineRun!.status='cancelled';
    if(change==='running')f.child.column='running';
    if(change==='escalated')f.parent.pipelineRun!.wait!.state='escalated';
    if(change==='unclassified')delete f.parent.pipelineRun!.wait;
    expect(readyToWake([f.parent,f.child],[f.job])).toEqual([]);
  }
});
