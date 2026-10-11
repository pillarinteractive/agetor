import {test,expect,beforeEach,afterEach} from 'bun:test';
import {preferences,tasks,runs} from './db.ts';
import {randomUUID} from 'node:crypto';
import type {Task,Run} from '../shared/types.ts';
import {claimIssue,releaseIssue,reserveRunner,releaseUnspawnedRunner,runnerUse,bindRunner} from './dispatch-claims.ts';
import {beginQueueCycle,completeQueueCycle,QUEUE_WAKE_PREF} from './queue-cycle.ts';

const keys=['step_slots','dispatch_issue_claims_v1','dispatch_runner_reservations_v1',QUEUE_WAKE_PREF];
let original:Record<string,string|null>={};
let created:string[]=[];
beforeEach(()=>{original=Object.fromEntries(keys.map(k=>[k,preferences.get(k)]));for(const k of keys)preferences.set(k,'{}');preferences.set('step_slots',JSON.stringify({max:8,heavy:{max:2,steps:['Finish']}}));});
afterEach(()=>{for(const id of created)tasks.delete(id);created=[];for(const k of keys)preferences.set(k,original[k]??'{}');});
test('concurrent canonical issue claims reserve before any awaited insert; host/repo remain separate',async()=>{
 const claims=await Promise.all(Array.from({length:20},()=>Promise.resolve(claimIssue('https://github.com/O/R/issues/12/?q=1'))));expect(claims.filter(c=>!('error'in c))).toHaveLength(1);
 expect('error'in claimIssue('https://github.com/o/other/issues/12')).toBe(false);
 const first=claims.find(c=>!('error'in c))!;if('error'in first)throw new Error(first.error);releaseIssue(first.key,'wrong-token');expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(true);releaseIssue(first.key,first.claim.token);expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(false);
});
test('20 overlapping pending starts fill exactly8 global reservations; release admits exactlyone',async()=>{
 const result=await Promise.all(Array.from({length:20},(_,i)=>Promise.resolve(reserveRunner('pending-'+i,'Build',()=>false))));expect(result.filter(r=>'ok'in r)).toHaveLength(8);expect(runnerUse(()=>false).total).toBe(8);
 releaseUnspawnedRunner('pending-0');expect(reserveRunner('replacement','Build',()=>false)).toEqual({ok:true});expect('error'in reserveRunner('ninth','Build',()=>false)).toBe(true);
});
test('two heavy slots stay inside eight total runners and do not prevent ordinary work',()=>{
 expect(reserveRunner('h1','Finish',()=>false)).toEqual({ok:true});expect(reserveRunner('h2','Finish',()=>false)).toEqual({ok:true});expect('error'in reserveRunner('h3','Finish',()=>false)).toBe(true);
 for(let i=0;i<6;i++)expect(reserveRunner('b'+i,'Build',()=>false)).toEqual({ok:true});expect(runnerUse(()=>false)).toEqual({total:8,heavy:2});
});
test('uncertain spawn receipt remains owned, with no time-based replay or release',()=>{
 reserveRunner('uncertain','Build',()=>false);bindRunner('uncertain','missing-run-receipt');releaseUnspawnedRunner('uncertain');expect(runnerUse(()=>false).total).toBe(1);expect('error'in reserveRunner('uncertain','Build',()=>false)).toBe(true);
});
test('proven dead creator before insert releases; uncertain live creator never expires',()=>{
 preferences.set('dispatch_runner_reservations_v1',JSON.stringify({dead:{taskId:'dead',runId:null,pid:2147483647,at:1,name:'Build'},live:{taskId:'live',runId:null,pid:process.pid,at:1,name:'Build'}}));expect(runnerUse(()=>false).total).toBe(1);
 preferences.set('dispatch_issue_claims_v1',JSON.stringify({'github.com/o/r/issues/12':{taskId:'never-inserted',token:'old',pid:2147483647,at:1}}));expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(false);
});
test('fresh cycles serialize, complete and back off without accumulating context or unbounded audit',()=>{
 const first=beginQueueCycle('/synthetic',639)!;expect(beginQueueCycle('/synthetic',639)).toBeNull();expect(completeQueueCycle(first,'full')).toBe(300000);
 for(let i=0;i<100;i++){const token=beginQueueCycle('/synthetic',639)!;expect(completeQueueCycle(token,'empty')).toBeLessThanOrEqual(300000);}
 const state=JSON.parse(preferences.get(QUEUE_WAKE_PREF)!);expect(state.recent).toHaveLength(25);expect(state.cursor).toBe(101);expect(state.token).toBeUndefined();expect(JSON.stringify(state).length).toBeLessThan(2500);
});

function card(column:Task['column'],title='Finish') {
 const id=randomUUID(),now=Date.now();created.push(id);
 return tasks.insert({id,title,prompt:'synthetic',column,agent:'claude-code',model:'sonnet-5.5',effort:null,mode:'auto',workdir:'/synthetic',worktreePath:null,branch:null,branchSource:'created',baseRef:null,isolation:'none',runId:null,createdAt:now,updatedAt:now,archivedAt:null,taskType:'task',prUrl:null,fast:false,maxMode:false,references:[],backlog:[],draft:null,plans:[],agentProfileId:null,agentProfile:null,pipelineId:null,pipelineRun:null,pipelineParentId:null,pipelineStepId:null,hasOpenableRun:false,pendingInteractionCount:0,openTerminalCount:0});
}
function receipt(id:string,status:Run['status']) {
 const runId=randomUUID();runs.insert({id:runId,taskId:id,agent:'claude-code',status,startedAt:Date.now(),endedAt:status==='running'?null:Date.now(),exitCode:status==='running'?null:0,tmuxSession:null,claudeSessionId:null,codexSessionId:null,cursorSessionId:null,geminiSessionId:null,fxSessionId:null});tasks.update(id,{runId});return runId;
}
test('two represented standalone Finish runners consume both heavy slots without double counting',()=>{
 const ids=[card('running').id,card('running').id];
 const claims=Object.fromEntries(ids.map(id=>[id,{taskId:id,runId:receipt(id,'running'),pid:process.pid,at:Date.now(),name:'Finish'}]));
 preferences.set('dispatch_runner_reservations_v1',JSON.stringify(claims));
 expect(runnerUse(id=>ids.includes(id))).toEqual({total:2,heavy:2});
 expect('error'in reserveRunner('third-heavy','Finish',id=>ids.includes(id))).toBe(true);
 expect(reserveRunner('ordinary','Build',id=>ids.includes(id))).toEqual({ok:true});
 // Legacy running rows with no claim are still represented heavy workers.
 preferences.set('dispatch_runner_reservations_v1','{}');expect(runnerUse(id=>ids.includes(id))).toEqual({total:2,heavy:2});
});
test('dead issue creator with provably terminal Done card recovers after restart; active or uncertain receipt does not',()=>{
 const t=card('done');const seed=()=>preferences.set('dispatch_issue_claims_v1',JSON.stringify({'github.com/o/r/issues/12':{taskId:t.id,token:'crashed',pid:2147483647,at:1}}));
 seed();expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(false);
 seed();expect('error'in claimIssue('https://github.com/o/r/issues/12',id=>id===t.id)).toBe(true);
 const runId=receipt(t.id,'orphaned');seed();expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(true);
 runs.update(runId,{status:'succeeded'});seed();expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(false);
 tasks.update(t.id,{runId:'missing-receipt'});seed();expect('error'in claimIssue('https://github.com/o/r/issues/12')).toBe(true);
});
