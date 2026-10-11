import {test,expect,beforeEach,afterEach} from 'bun:test';
import {preferences} from './db.ts';
import {claimIssue,releaseIssue,reserveRunner,releaseUnspawnedRunner,runnerUse,bindRunner} from './dispatch-claims.ts';
import {beginQueueCycle,completeQueueCycle,QUEUE_WAKE_PREF} from './queue-cycle.ts';

const keys=['step_slots','dispatch_issue_claims_v1','dispatch_runner_reservations_v1',QUEUE_WAKE_PREF];
let original:Record<string,string|null>={};
beforeEach(()=>{original=Object.fromEntries(keys.map(k=>[k,preferences.get(k)]));for(const k of keys)preferences.set(k,'{}');preferences.set('step_slots',JSON.stringify({max:8,heavy:{max:2,steps:['Finish']}}));});
afterEach(()=>{for(const k of keys)preferences.set(k,original[k]??'{}');});
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
