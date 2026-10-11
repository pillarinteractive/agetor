import {test,expect,mock} from 'bun:test';
// Run this file in its own Bun process: it replaces the network boundary.
const revision='1'.repeat(40);
const table='## Numbered completion order\n|Step|Task|Milestone|Predecessor steps|\n|---|---|---|---|\n|1|#1 Input|M01|none|\n|2|#2 Later independent|M09|none|';
const body=table+`\nhttps://github.com/o/r/blob/${revision}/docs/plans/roadmap-review-coverage.csv\nhttps://github.com/o/r/blob/${revision}/docs/plans/roadmap-supplements.json`;
const contract='## Dependencies and required inputs\nThis is the sole controlling whole-task predecessor list.\nNone.\n### Conditional and action-specific input predicates\nNo additional conditional predicate is recorded.';
let manifest: string|null=null,sibling: string|null=null;
mock.module('./github.ts',()=>({run:async(cmd:string[])=>{
 let stdout='';
 if(cmd[1]==='issue')stdout=JSON.stringify({body,url:'https://github.com/o/r/issues/639'});
 else if(cmd[2]==='graphql')stdout=JSON.stringify({data:{repository:Object.fromEntries([1,2,3].map(n=>['i'+n,{number:n,state:n===1?'CLOSED':'OPEN',stateReason:n===1?'COMPLETED':null,body:contract,updatedAt:'a',url:`https://github.com/o/r/issues/${n}`}]))}});
 else if(cmd[2]?.includes('coverage'))stdout='issue,baseline\n1,x\n2,x\n3,x';
 else {
  const response=cmd[2]?.includes('adapter-architecture')?sibling:manifest;
  if(response===null)return {ok:false,stdout:'',stderr:'transient source read failure',exitCode:1};
  stdout=response;
 }
 return {ok:true,stdout,stderr:'',exitCode:0};
}}));
const {loadCanonicalQueue,QUEUE_FACTS_PREF}=await import('./roadmap-fetch.ts');
const {preferences}=await import('./db.ts');
const {roadmapStatus,pickRoadmap}=await import('../shared/roadmap.ts');
test('failed linked supplement preserves last verified facts and refuses partial dispatch',async()=>{
 preferences.set(QUEUE_FACTS_PREF,'verified prior graph');manifest=null;
 expect(await loadCanonicalQueue('/synthetic',639)).toHaveProperty('error');
 expect(preferences.get(QUEUE_FACTS_PREF)).toBe('verified prior graph');
 manifest=JSON.stringify({tasks:[{issue:3,key:'EARLY',hard_predecessors:[1]}]});
 const result=await loadCanonicalQueue('/synthetic',639);if('error'in result)throw Error(result.error);
 expect(pickRoadmap(roadmapStatus(result.parsed,result.states),{busy:new Set(),free:1}).start.map(s=>s.issue)).toEqual([3]);
});
test('invalid or unreadable explicit architecture source preserves the complete prior graph',async()=>{
 const prior=preferences.get(QUEUE_FACTS_PREF);
 for(const invalid of ['{}','{"tasks":[{}]}','invalid JSON']) {
  manifest=invalid;expect(await loadCanonicalQueue('/synthetic',639)).toHaveProperty('error');
  expect(preferences.get(QUEUE_FACTS_PREF)).toBe(prior);
 }
 manifest=JSON.stringify({tasks:[],adapter_architecture_batch:{registry:'adapter-architecture-2026-10-11.registry.json'}});
 sibling=null;expect(await loadCanonicalQueue('/synthetic',639)).toHaveProperty('error');
 sibling='{}';expect(await loadCanonicalQueue('/synthetic',639)).toHaveProperty('error');
 expect(preferences.get(QUEUE_FACTS_PREF)).toBe(prior);
});
