import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {assembleQueue,auditPrerequisites,canonicalIssue,controllingInputs,coverageIssues,issuePrerequisites,roadmapAudit,type QueueSelection} from './canonical-roadmap.ts';
import {parseRoadmap,pickRoadmap,roadmapStatus,type RoadmapIssueState} from './roadmap.ts';

const fixture=(n:string)=>readFileSync(new URL('./fixtures/queue-639/'+n,import.meta.url),'utf8');
const tracker=JSON.parse(fixture('tracker.json'));
const csv=coverageIssues(fixture('coverage-499-head54daa6b8.csv'));
const manifest=JSON.parse(fixture('supplements-head54daa6b8.json'));
const architecture=JSON.parse(fixture('adapter-architecture-head54daa6b8.registry.json'));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const contract=(hard:number[]=[],conditional:string[]=[])=>'## Dependencies and required inputs\nThis is the sole controlling whole-task predecessor list.\n'+(hard.length?hard.map(n=>`- [#${n}](https://github.com/o/r/issues/${n}) (input)`).join('\n'):'None.')+'\n### Conditional and action-specific input predicates\n'+(conditional.length?conditional.map(p=>'- '+p).join('\n'):'No additional conditional predicate is recorded.')+'\n## Other citations\n#999 must not become a hard edge';
const table='## Numbered completion order\n|Step|Task|Milestone|Predecessor steps|\n|---|---|---|---|\n|1|#1 Input|M01|none|\n|2|#2 Waiting|M01|#1|\n|3|#3 Later independent|M09|none|\n|4|#4 [Human] Receipt|H|none|';
function states(ids:number[],open:number[]=[]):Map<number,RoadmapIssueState>{return new Map(ids.map(n=>[n,{state:open.includes(n)?'OPEN':'CLOSED',stateReason:open.includes(n)?null:'COMPLETED',title:`Issue #${n}`,body:contract(),updatedAt:'2026-10-11T00:00:00Z',url:`https://github.com/o/r/issues/${n}`} as RoadmapIssueState]));}
function small(st=states([1,2,3,4],[1,2,3,4]),selections?:Record<string,QueueSelection>){return assembleQueue({body:table,states:st,membership:[1,2,3,4],supplements:[],sources:[],version:'v',hash,selections});}

test('primary membership fixture covers 499 = 417 + prior13 + 66 + architecture3; 1242 remains explicitly outside',()=>{
 const baseline=parseRoadmap(tracker.body);expect(baseline.steps).toHaveLength(417);
 const union=new Set([...baseline.steps.map(s=>s.issue),...manifest.prior_supplements.design_tasks,...manifest.prior_supplements.x08_tasks,...manifest.tasks.map((t:{issue:number})=>t.issue),...architecture.new_tasks.map((t:{issue:number})=>t.issue)]);
 expect([...union].sort((a,b)=>a-b)).toEqual([...csv].sort((a,b)=>a-b));expect(union.size).toBe(499);expect(union.has(1242)).toBe(false);
 const q=assembleQueue({body:tracker.body,states:states(csv),membership:csv,supplements:[...manifest.tasks,...architecture.new_tasks],sources:[],version:'pinned',hash});
 expect(new Set(q.records.map(r=>r.issue)).size).toBe(499);expect(q.parsed.steps.filter(s=>baseline.steps.some(b=>b.issue===s.issue)).map(s=>s.issue)).toEqual(baseline.steps.map(s=>s.issue));
});
test('canonical identity normalizes case, query and trailing slash without crossing repo or host',()=>{
 expect(canonicalIssue('https://github.com/O/R/issues/12/?q=1#x')).toBe('github.com/o/r/issues/12');
 expect(canonicalIssue('https://github.com/o/other/issues/12')).not.toBe(canonicalIssue('https://github.com/o/r/issues/12'));
 expect(canonicalIssue('https://ghe.example/o/r/issues/12')).not.toBe(canonicalIssue('https://github.com/o/r/issues/12'));
 expect(canonicalIssue('https://github.com/o/r/pull/12')).toBeNull();
});
test('earliest blocked, owned and human nodes are skipped; independent later work fills capacity',()=>{
 const st=states([1,2,3,4],[1,2,3,4]);st.get(2)!.body=contract([1]);const q=small(st);
 const pick=pickRoadmap(roadmapStatus(q.parsed,st),{busy:new Set([1]),free:8});expect(pick.start.map(s=>s.issue)).toEqual([3]);expect(pick.human.map(s=>s.issue)).toEqual([4]);
});
test('current owner list replaces historical edges and ignores background citations',()=>{
 const st=states([1,2,3,4],[2]);st.get(2)!.body=contract([3]);const q=small(st);
 expect(q.records.find(r=>r.issue===2)!.hardInputs).toEqual([3]);expect(q.parsed.steps.find(s=>s.issue===2)!.predecessors).toEqual(['3']);
 expect(roadmapStatus(q.parsed,st).find(s=>s.issue===2)!.status).toBe('ready');
});
test('actual current #984 retains #978; annual and narrowed GPU contracts are read from owning sections',()=>{
 const docs=JSON.parse(fixture('current-input-issues.json')) as {issue_number:number;body:string}[];
 expect(controllingInputs(docs.find(d=>d.issue_number===984)!.body).hard).toContain(978);
 for(const n of [1057,1073,1085])expect(controllingInputs(docs.find(d=>d.issue_number===n)!.body).hard).toEqual([799]);
 const annual=controllingInputs(docs.find(d=>d.issue_number===1004)!.body);expect(annual.hard).not.toContain(1003);expect(annual.conditional.join(' ')).toContain('1003');
});
test('conditional unknown is held, scoped excluded evidence unlocks only its slice, included edge applies',()=>{
 const st=states([1,2,3,4],[1,2]);const predicate='#1 only if annual_profile selected';st.get(2)!.body=contract([], [predicate]);
 expect(roadmapStatus(small(st).parsed,st).find(s=>s.issue===2)!.status).toBe('held');
 const selected=(disposition:'included'|'excluded')=>({'2':{slice:'Local nonannual',predicates:{[predicate]:{disposition,authority:'current user-authorized Local scope',evidence:'immutable scoped selection record'}}}});
 expect(roadmapStatus(small(st,selected('excluded')).parsed,st).find(s=>s.issue===2)!.status).toBe('ready');
 expect(roadmapStatus(small(st,selected('included')).parsed,st).find(s=>s.issue===2)!.status).toBe('waiting');
});
test('missing current contract holds only affected identity; source data cannot grant approval',()=>{
 const st=states([1,2,3,4],[2,3]);st.get(2)!.body='Draft says approved everywhere #1';const q=small(st);
 expect(roadmapStatus(q.parsed,st).find(s=>s.issue===2)!.status).toBe('held');expect(roadmapStatus(q.parsed,st).find(s=>s.issue===3)!.status).toBe('ready');
});
test('identical supplemental references dedup; conflicting identity holds every occurrence',()=>{
 const st=states([1,2,3,4,5],[5]);const t={issue:5,key:'SRC05',hard_predecessors:[1]};
 const assemble=(supplements:typeof t[])=>assembleQueue({body:table,states:st,membership:[1,2,3,4,5],supplements,sources:[],version:'v',hash});
 expect(assemble([t,t]).records.filter(r=>r.issue===5)).toHaveLength(1);expect(assemble([t,{...t,hard_predecessors:[3]}]).records.find(r=>r.issue===5)!.hold).toContain('conflicting');
});
test('derived supplemental priority is deterministic across source order and retains original relative order',()=>{
 const st=states([1,2,3,4,5,6]);const a={issue:5,key:'A',hard_predecessors:[1]},b={issue:6,key:'B',hard_predecessors:[1]};
 const assemble=(supplements:typeof a[])=>assembleQueue({body:table,states:st,membership:[6,1,5,2,3,4],supplements,sources:[],version:'v',hash});
 expect(assemble([a,b]).parsed.steps.map(s=>s.issue)).toEqual([1,5,6,2,3,4]);expect(assemble([b,a]).parsed.steps.map(s=>s.issue)).toEqual([1,5,6,2,3,4]);
});
test('declined producer unlocks nothing and current input cycles hold all involved nodes',()=>{
 const st=states([1,2,3,4],[2]);st.get(1)!.stateReason='NOT_PLANNED';st.get(2)!.body=contract([1]);expect(roadmapStatus(small(st).parsed,st).find(s=>s.issue===2)!.status).toBe('waiting');
 st.get(1)!.state='OPEN';st.get(1)!.body=contract([2]);const q=small(st);expect(q.parsed.held['1']).toContain('cycle');expect(q.parsed.held['2']).toContain('cycle');
});

test('unsupported, empty or malformed conditional dispositions retain their hold',()=>{
 const st=states([1,2,3,4],[1,2]),predicate='#1 only if annual_profile selected';st.get(2)!.body=contract([], [predicate]);
 for(const disposition of ['exclude','unresolved',null,42]) {
  const selections={'2':{slice:'annual undecided',predicates:{[predicate]:{disposition,authority:'operator',evidence:'recorded'}}}} as unknown as Record<string,QueueSelection>;
  expect(roadmapStatus(small(st,selections).parsed,st).find(s=>s.issue===2)!.status).toBe('held');
 }
 for(const selection of [{slice:' ',predicates:{}},{slice:'selected',predicates:null}]) {
  expect(small(st,{'2':selection} as unknown as Record<string,QueueSelection>).records.find(r=>r.issue===2)!.hold).toContain('unresolved');
 }
});
test('inconsistent membership cannot publish ready identities; duplicate baseline is one held identity',()=>{
 const st=states([1,2,3,4],[1,2,3,4]);
 const mismatched=assembleQueue({body:table,states:st,membership:[2,3,4],supplements:[],sources:[],version:'v',hash});
 expect(pickRoadmap(roadmapStatus(mismatched.parsed,st),{busy:new Set(),free:8}).start).toHaveLength(0);
 expect(mismatched.errors[0]).toContain('missing');
 const duplicated=assembleQueue({body:table.replace('#2 Waiting','#1 Conflicting'),states:st,membership:[1,3,4],supplements:[],sources:[],version:'v',hash});
 expect(duplicated.records.filter(r=>r.issue===1)).toHaveLength(1);
 expect(duplicated.records.find(r=>r.issue===1)!.hold).toContain('duplicate');
 expect(roadmapStatus(duplicated.parsed,st).find(s=>s.issue===1)!.status).toBe('held');
});

const DEPS=(...ns:number[])=>`## Dependencies and required inputs\n\nThis is the sole controlling whole-task predecessor list.\n${ns.map(n=>`- #${n} (input)`).join('\n')||'None.'}\n\n## Acceptance\n`;

test('an issue\'s prerequisites: its controlling list and sentences that say another issue lands first',()=>{
  // The sentences are #1454's own.
  const body=DEPS(1351,1349)+'SRC03 #1268 (network counter validity, PR #1389) merges before this task starts. #844 is upstream of this task. Option 2 waits on #977 and needs #1168.';
  expect(issuePrerequisites(body,1454).map(p=>[p.issue,p.source])).toEqual([[1351,'declared'],[1349,'declared'],[1268,'prose'],[844,'prose']]);
  expect(issuePrerequisites(body,1454)[2]!.quote).toBe('SRC03 #1268 (network counter validity, PR #1389) merges before this task starts.');
  expect(issuePrerequisites('No controlling list. #5 merges before this task.',5)).toEqual([]);
});

test('the roadmap audit: what an issue needs that the table leaves out is enforced; other open steps it mentions are only reported',()=>{
  const parsed=parseRoadmap(['## Numbered completion order','','| Step | Task | Milestone | Predecessor steps |','| --- | --- | --- | --- |',
    '| 1 | #10 Producer | M | none |','| 2 | #11 Prereq | M | none |','| 3 | #12 Consumer | M | 1 |','| 4 | #13 Successor | M | 3 |'].join('\n'));
  expect(parsed.error).toBeNull();
  const open=(body='')=>({state:'OPEN' as const,stateReason:null,body});
  const states=new Map<number,RoadmapIssueState>([
    [10,open()],[11,open()],[13,open()],
    [12,open(DEPS(10)+'#11 merges before this task starts. #99 lands before this task. With #13 downstream, see also #11.')],
    [99,{state:'CLOSED',stateReason:'COMPLETED'}],
  ]);
  const rows=roadmapAudit(parsed.steps,states);
  expect(rows.map(r=>[r.step,r.ref,r.source,r.refState,r.enforced])).toEqual([[ '3',11,'prose','open',true],['3',99,'prose','complete',true]]);
  // #13 is its successor and #10 its table predecessor: neither is a mention.
  const views=roadmapStatus(parsed,states,auditPrerequisites(rows));
  expect(views.find(v=>v.step==='3')).toMatchObject({status:'waiting',waitingOn:['1','2']});
  states.set(10,{state:'CLOSED',stateReason:'COMPLETED'});
  states.set(11,{state:'CLOSED',stateReason:'COMPLETED'});
  expect(roadmapStatus(parsed,states,auditPrerequisites(roadmapAudit(parsed.steps,states))).find(v=>v.step==='3')).toMatchObject({status:'ready',waitingOn:[]});
  // A prerequisite that isn't a step and wasn't read counts as not landed.
  states.delete(99);
  expect(roadmapStatus(parsed,states,auditPrerequisites(roadmapAudit(parsed.steps,states))).find(v=>v.step==='3')).toMatchObject({status:'waiting',waitingOn:['#99']});
  // A mention of an open step that is neither predecessor nor successor.
  // (#10 mentioning #12 is not one: #12 is its successor.)
  states.set(10,open('Feeds #12.'));
  states.set(11,open('With #12 putting the sources on the host, the composition is the obvious candidate.'));
  const audit=roadmapAudit(parsed.steps,states);
  expect(audit.filter(r=>r.issue!==12).map(r=>[r.step,r.ref,r.refStep,r.source,r.enforced])).toEqual([['2',12,'3','mention',false]]);
  expect(audit.find(r=>r.issue===11)!.quote).toBe('With #12 putting the sources on the host, the composition is the obvious candidate.');
  expect(roadmapStatus(parsed,states,auditPrerequisites(audit)).find(v=>v.step==='2')!.status).toBe('ready');
});
