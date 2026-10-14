import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {queueValidator,externalIssueHold,freezeCardInputs,reconcileCardInputs,type QueueValidationDeps,type ExternalOwnershipDeps} from './queue-validation.ts';
import {preferences} from './db.ts';
import {randomUUID} from 'node:crypto';
import {assembleQueue} from '../shared/canonical-roadmap.ts';
import type {Task} from '../shared/types.ts';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const table='## Numbered completion order\n|Step|Task|Milestone|Predecessor steps|\n|---|---|---|---|\n|1|#1 Input|M01|none|\n|2|#2 Work|M09|#1|';
const body=(n?:number)=>'## Dependencies and required inputs\nThis is the sole controlling whole-task predecessor list.\n'+(n?`- #${n} (Input)`:'None.')+'\n### Conditional and action-specific input predicates\nNo additional conditional predicate is recorded.';
function fixture(){
 const states=new Map<number,import('../shared/roadmap.ts').RoadmapIssueState>([[1,{state:'CLOSED',stateReason:'COMPLETED',body:body(),updatedAt:'a',url:'https://github.com/o/r/issues/1'}],[2,{state:'OPEN',stateReason:null,body:body(1),updatedAt:'b',url:'https://github.com/o/r/issues/2'}]]);
 const queue=assembleQueue({body:table,states,membership:[1,2],supplements:[],sources:[{url:'https://github.com/o/r/issues/639',revision:'pinned',hash:hash(table)}],version:'v',hash});
 let currentTracker=table,selection:string|null=null,ownership:string|null=null,cards:Task[]=[],config=JSON.stringify({enabled:true,project:'/p',roadmap:{issue:639}});
 const deps:QueueValidationDeps={tracker:async()=>({body:currentTracker,url:'https://github.com/o/r/issues/639'}),states:async()=>states,ownership:async()=>ownership,preference:k=>k==='autopilot'?config:selection,cards:()=>cards};
 return {states,queue,deps,validate:queueValidator('/p',639,queue,2,undefined,deps),setConfig:(s:string)=>{config=s;},setTracker:(s:string)=>{currentTracker=s;},setSelection:(s:string)=>{selection=s;},setOwner:(s:string)=>{ownership=s;},setCards:(t:Task[])=>{cards=t;}};
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

for(const changed of ['configuration','selection'] as const) {
 test(`${changed} changed during awaited evidence prevents dispatch`,async()=>{
  const f=fixture();let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  f.deps.states=async()=>{await gate;return f.states;};
  const pending=f.validate();
  if(changed==='configuration')f.setConfig(JSON.stringify({enabled:false,project:'/p',roadmap:{issue:639}}));
  else f.setSelection('new selection');
  release();expect(await pending).toContain(changed==='configuration'?'configuration changed':'dispositions changed');
 });
}

function externalFixture() {
 const pid=process.pid+1000;let cwd='/p/packages/core-go',branch='feature/other',ahead=1,readable=true,state:'alive'|'dead'|'unknown'='alive',untracked='packages/core-go/new.go\0',tracked='docs/guide.md\0';
 const deps:ExternalOwnershipDeps={cards:()=>[],pidState:()=>state,command:async args=>{
  let stdout='';
  if(args[0]==='ps')stdout=`${pid} /usr/local/bin/claude`;
  else if(args[0]==='lsof')return {ok:readable,stdout:readable?`p${pid}\nn${cwd}\n`:'',stderr:'',exitCode:readable?0:1};
  else if(args[0]==='gh')stdout='[]';
  else if(args.includes('worktree'))stdout=`worktree /p\nbranch refs/heads/${branch}\n`;
  else if(args.includes('rev-list'))stdout=`${ahead}\n`;
  else if(args.includes('diff'))stdout=tracked;
  else if(args.includes('ls-files'))stdout=untracked;
  return {ok:true,stdout,stderr:'',exitCode:0};
 }};
 return {deps,setRead:(v:boolean)=>{readable=v;},setState:(v:typeof state)=>{state=v;},setCwd:(v:string)=>{cwd=v;},setUntracked:(v:string)=>{untracked=v;},setTracked:(v:string)=>{tracked=v;},setBranch:(v:string)=>{branch=v;},setAhead:(v:number)=>{ahead=v;}};
}
test('unreadable live or uncertain worker cwd is a hold; proven dead worker is absent',async()=>{
 const f=externalFixture();f.setRead(false);
 expect(await externalIssueHold('/p',2,['packages/core-go'],f.deps)).toContain('ownership remains unknown');
 f.setState('unknown');expect(await externalIssueHold('/p',2,['packages/core-go'],f.deps)).toContain('ownership remains unknown');
 f.setState('dead');expect(await externalIssueHold('/p',2,['packages/core-go'],f.deps)).toBeNull();
});
test('worker in a project subdirectory owns overlapping untracked paths; verified disjoint work can proceed',async()=>{
 const f=externalFixture();
 expect(await externalIssueHold('/p',2,['packages/core-go'],f.deps)).toContain('new.go');
 expect(await externalIssueHold('/p',2,['apps/web'],f.deps)).toBeNull();
 f.setUntracked('');f.setTracked('');expect(await externalIssueHold('/p',2,['apps/web'],f.deps)).toContain('no established scoped');
 f.setCwd('/unrelated');expect(await externalIssueHold('/p',2,['apps/web'],f.deps)).toBeNull();
});
test('untracked ownership handles newline filenames and directory overlap in either direction',async()=>{
 const f=externalFixture();f.setUntracked('packages/core-go/name\nwith-newline.go\0');
 expect(await externalIssueHold('/p',2,['packages/core-go'],f.deps)).toContain('overlapping');
});

function reconcileFixture() {
 const f=fixture(),id=randomUUID(),reads:number[][]=[];
 freezeCardInputs('/p',639,f.queue,2,id);
 const read:QueueValidationDeps['states']=async(_p,numbers)=>{reads.push(numbers);return new Map(numbers.flatMap(n=>f.states.has(n)?[[n,f.states.get(n)!]]:[]));};
 return {...f,id,reads,read};
}
test('handoff fetches newly required hard inputs, holds OPEN producer and preserves frozen inputs/audit',async()=>{
 const f=reconcileFixture();f.states.set(3,{state:'OPEN',stateReason:null,body:body(),updatedAt:'c',url:'https://github.com/o/r/issues/3'});
 f.states.get(2)!.body=body(1).replace('- #1 (Input)','- #1 (Input)\n- #3 (Input)');f.states.get(2)!.updatedAt='new';
 expect((await reconcileCardInputs(f.id,f.read)).hold).toContain('#3');expect(f.reads).toEqual([[2,1],[2,3]]);
 const frozen=JSON.parse(preferences.get('autopilot_card_inputs_v1')!)[f.id];
 expect(frozen.record.applicableInputs).toEqual([1]);expect(frozen.changes[0].message).toContain('added: #3');
 f.states.get(3)!.state='CLOSED';f.states.get(3)!.stateReason='NOT_PLANNED';expect((await reconcileCardInputs(f.id,f.read)).hold).toContain('#3');
 f.states.get(3)!.stateReason='COMPLETED';expect((await reconcileCardInputs(f.id,f.read)).note).toContain('original acceptance snapshot');
 f.states.get(3)!.body='';expect((await reconcileCardInputs(f.id,f.read)).hold).toContain('readable');
});
test('new unresolved conditional remains held; removed predecessor does not gate the current contract',async()=>{
 const f=reconcileFixture();f.states.get(2)!.body=body().replace('No additional conditional predicate is recorded.','- #3 only if annual_profile selected');
 expect((await reconcileCardInputs(f.id,f.read)).hold).toContain('unresolved selected-slice');
 f.states.get(2)!.body=body();f.states.get(1)!.state='OPEN';
 expect((await reconcileCardInputs(f.id,f.read)).hold).toBeUndefined();
 expect((await reconcileCardInputs(f.id,f.read)).note).toContain('removed inputs: #1');
});
test('contract changed during new input fetch retains a coherent-read hold',async()=>{
 const f=reconcileFixture();f.states.get(2)!.body=body(3);
 let count=0;const read:typeof f.read=async(p,n)=>{if(++count===2)f.states.get(2)!.updatedAt='changed during await';return f.read(p,n);};
 // Use copies: a real network response never mutates the earlier response.
 const copied:typeof f.read=async(p,n)=>{const result=await read(p,n);return 'error'in result?result:new Map([...result].map(([k,v])=>[k,{...v}]));};
 expect((await reconcileCardInputs(f.id,copied)).hold).toContain('coherent fresh read');
});
test('a session in the project checkout with no tracked change and nothing unpushed owns nothing',async()=>{
 const f=externalFixture();f.setBranch('develop');f.setTracked('');f.setUntracked('docs/plans/owner-notes.md\0');f.setAhead(0);f.setCwd('/p');
 expect(await externalIssueHold('/p',2,[],f.deps)).toBeNull();
 expect(await externalIssueHold('/p',2,['docs/plans'],f.deps)).toBeNull();
 f.setAhead(1);expect(await externalIssueHold('/p',2,['docs/plans'],f.deps)).toContain('overlapping');
 f.setAhead(0);f.setTracked('docs/plans/x.md\0');expect(await externalIssueHold('/p',2,['docs/plans'],f.deps)).toContain('overlapping');
});
