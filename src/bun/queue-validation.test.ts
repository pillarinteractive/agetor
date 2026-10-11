import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {queueValidator,type QueueValidationDeps} from './queue-validation.ts';
import {assembleQueue} from '../shared/canonical-roadmap.ts';
import type {Task} from '../shared/types.ts';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const table='## Numbered completion order\n|Step|Task|Milestone|Predecessor steps|\n|---|---|---|---|\n|1|#1 Input|M01|none|\n|2|#2 Work|M09|#1|';
const body=(n?:number)=>'## Dependencies and required inputs\nThis is the sole controlling whole-task predecessor list.\n'+(n?`- #${n} (Input)`:'None.')+'\n### Conditional and action-specific input predicates\nNo additional conditional predicate is recorded.';
function fixture(){
 const states=new Map<number,import('../shared/roadmap.ts').RoadmapIssueState>([[1,{state:'CLOSED',stateReason:'COMPLETED',body:body(),updatedAt:'a',url:'https://github.com/o/r/issues/1'}],[2,{state:'OPEN',stateReason:null,body:body(1),updatedAt:'b',url:'https://github.com/o/r/issues/2'}]]);
 const queue=assembleQueue({body:table,states,membership:[1,2],supplements:[],sources:[{url:'https://github.com/o/r/issues/639',revision:'pinned',hash:hash(table)}],version:'v',hash});
 let currentTracker=table,selection:string|null=null,ownership:string|null=null,cards:Task[]=[];
 const deps:QueueValidationDeps={tracker:async()=>({body:currentTracker,url:'https://github.com/o/r/issues/639'}),states:async()=>states,ownership:async()=>ownership,preference:k=>k==='autopilot'?JSON.stringify({enabled:true,project:'/p',roadmap:{issue:639}}):selection,cards:()=>cards};
 return {states,queue,deps,validate:queueValidator('/p',639,queue,2,undefined,deps),setTracker:(s:string)=>{currentTracker=s;},setSelection:(s:string)=>{selection=s;},setOwner:(s:string)=>{ownership=s;},setCards:(t:Task[])=>{cards=t;}};
}
test('before/after preparation guards reject a closed target or reopened predecessor',async()=>{
 const f=fixture();expect(await f.validate()).toBeNull();f.states.get(1)!.state='OPEN';expect(await f.validate()).toContain('no longer graph-complete');f.states.get(1)!.state='CLOSED';f.states.get(2)!.state='CLOSED';expect(await f.validate()).toContain('no longer open');
});
test('tracker, current acceptance or scoped selection changes invalidate only future dispatch',async()=>{
 const f=fixture();f.setTracker(table+'\nchanged');expect(await f.validate()).toContain('revision changed');f.setTracker(table);f.states.get(2)!.body+='\nnew AC';expect(await f.validate()).toContain('acceptance/input contract changed');
 const s=fixture();s.setSelection('new');expect(await s.validate()).toContain('dispositions changed');expect(s.queue.records.find(r=>r.issue===2)!.bodyHash).toBe(hash(body(1)));
});
test('concurrent exact external ownership blocks that candidate without controlling another card',async()=>{
 const f=fixture();f.setOwner('external Claude worker claims issue2');expect(await f.validate()).toContain('external Claude');expect(f.queue.records.find(r=>r.issue===1)!.hold).toBeNull();
});
test('live canonical card ownership cannot be duplicated even with differently cased URLs',async()=>{
 const f=fixture();f.setCards([{id:'owned',issueUrl:'https://github.com/O/R/issues/2/?q=1',archivedAt:null,pipelineParentId:null,column:'running',runId:'active'} as Task]);expect(await f.validate()).toContain('owned');
});
