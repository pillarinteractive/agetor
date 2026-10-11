import { createHash } from 'node:crypto';
import { run } from './github.ts';
import { preferences, tasks } from './db.ts';
import { loadRoadmapStates, loadRoadmapTracker, QUEUE_SELECTIONS_PREF } from './roadmap-fetch.ts';
import { canonicalIssue, type CanonicalQueue, type QueueRecord } from '../shared/canonical-roadmap.ts';
import { neverStarted } from '../shared/autopilot.ts';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const CARD_FACTS='autopilot_card_inputs_v1';
interface CardFacts {project:string;tracker:number;graphVersion:string;record:QueueRecord;inputs:{issue:number;hash:string;updatedAt:string|null}[];changes:{at:number;message:string}[];}
export function freezeCardInputs(project:string,tracker:number,queue:CanonicalQueue,issue:number,taskId:string):void {
  const facts=JSON.parse(preferences.get(CARD_FACTS)??'{}') as Record<string,CardFacts>;
  if(facts[taskId])return;
  const record=queue.records.find(r=>r.issue===issue);if(!record)throw new Error('missing frozen dispatch record');
  facts[taskId]={project,tracker,graphVersion:queue.version,record,inputs:record.applicableInputs.map(n=>{const r=queue.records.find(r=>r.issue===n);return {issue:n,hash:r?.bodyHash??'',updatedAt:r?.updatedAt??null};}),changes:[]};
  preferences.set(CARD_FACTS,JSON.stringify(facts));
}
/** Safe step boundary: do not overwrite the frozen contract. A changed
 * contract is explicitly reconciled by the next planner/Build/Review;
 * reopened required inputs park only this card. */
export async function reconcileCardInputs(taskId:string):Promise<{hold?:string;note?:string}> {
  const facts=JSON.parse(preferences.get(CARD_FACTS)??'{}') as Record<string,CardFacts>,f=facts[taskId];if(!f)return {};
  const current=await loadRoadmapStates(f.project,[f.record.issue,...f.record.applicableInputs]);
  if('error'in current)return {hold:current.error};
  const changed:string[]=[];
  const target=current.get(f.record.issue);
  if(target?.state!=='OPEN')return {hold:`#${f.record.issue} closed or unreadable; reconcile current ownership before another step`};
  for(const n of f.record.applicableInputs)if(current.get(n)?.state!=='CLOSED'||current.get(n)?.stateReason!=='COMPLETED')return {hold:`required input #${n} is no longer graph-complete; waiting for its current contract/evidence`};
  if(hash(target.body??'')!==f.record.bodyHash)changed.push(`issue #${f.record.issue} acceptance/input contract changed after dispatch`);
  for(const i of f.inputs)if(hash(current.get(i.issue)?.body??'')!==i.hash)changed.push(`producer #${i.issue} contract changed after dispatch`);
  if(!changed.length)return {};
  const message=changed.join('; '),note=`Dispatch graph ${f.graphVersion} and its original acceptance snapshot remain recorded. ${message}. Read the CURRENT owning issues and reconcile the complete plan, inputs and all acceptance before proceeding. Review independently checks the current complete contract. Missing real authority/artifacts remain holds; do not close the issue using stale acceptance.`;
  const latest=JSON.parse(preferences.get(CARD_FACTS)??'{}') as Record<string,CardFacts>;
  if(latest[taskId]&&latest[taskId].changes.at(-1)?.message!==message){latest[taskId].changes=[...latest[taskId].changes,{at:Date.now(),message}].slice(-25);preferences.set(CARD_FACTS,JSON.stringify(latest));}
  return {note};
}
export interface QueueValidationDeps {
  tracker:typeof loadRoadmapTracker;
  states:typeof loadRoadmapStates;
  ownership:(project:string,issue:number,paths?:string[])=>Promise<string|null>;
  preference:(key:string)=>string|null;
  cards:typeof tasks.listLive;
}

/** Read-only exact external claims. No process control, adoption or lock clearing. */
export async function externalIssueHold(project:string,issue:number,paths:string[]=[]):Promise<string|null> {
  const [ps,wt,prs]=await Promise.all([
    run(['ps','-axo','pid=,comm='],project,10_000,process.env),
    run(['git','worktree','list','--porcelain'],project,10_000,process.env),
    run(['gh','pr','list','--state','open','--limit','100','--json','number,headRefName,body'],project,30_000,process.env),
  ]);
  if(!ps.ok||!wt.ok||!prs.ok)return 'external ownership could not be verified';
  try {
    const open=JSON.parse(prs.stdout) as {number:number;headRefName:string;body:string}[];
    const issuePattern=new RegExp(`(?:^|[/_-])(?:issue[-_])?${issue}(?:$|[/_-])`);
    const closingPattern=new RegExp(`\\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\\s+(?:https://github\\.com/[^/]+/[^/]+/issues/)?#?${issue}\\b`,'i');
    const owned=open.find(p=>issuePattern.test(p.headRefName)||closingPattern.test(p.body));
    if(owned)return `open PR #${owned.number} already owns this issue`;
    const workers=ps.stdout.split('\n').filter(l=>/(?:\/|\s)(?:claude|claude\.exe|codex|cursor-agent|gemini)$/.test(l.trim())).map(l=>Number(l.trim().split(/\s+/)[0])).filter(n=>n!==process.pid);
    const worktrees=wt.stdout.split(/\n\n/).map(b=>({path:b.match(/^worktree (.+)$/m)?.[1],branch:b.match(/^branch refs\/heads\/(.+)$/m)?.[1]}));
    const cdirs=await Promise.all(workers.map(pid=>run(['lsof','-a','-p',String(pid),'-d','cwd','-Fn'],project,10_000,process.env)));
    for(let i=0;i<cdirs.length;i++) {
      const r=cdirs[i]!;
      // A worker exiting during the probe is absent; an unreadable live
      // process stays unknown only if it may belong to this project.
      if(!r.ok)continue;
      const cwd=r.stdout.match(/^n(.+)$/m)?.[1];
      const tree=worktrees.find(t=>t.path===cwd);
      if(!tree)continue;
      if(tree.branch&&issuePattern.test(tree.branch))return `external worker ${workers[i]} owns ${tree.branch}`;
      const known=tasks.listLive().some(t=>t.worktreePath===cwd);
      if(known)continue;
      const diff=await run(['git','diff','--name-only','HEAD'],cwd!,10_000,process.env);
      if(!diff.ok||!paths.length)return `external worker ${workers[i]} in ${cwd} has unresolved ownership for this candidate`;
      const touched=diff.stdout.split('\n').filter(Boolean);
      const pr=open.find(p=>p.headRefName===tree.branch);
      if(pr) {
        const files=await run(['gh','api','--paginate',`repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`,'-q','.[].filename'],project,30_000,process.env);
        if(!files.ok)return `external PR #${pr.number} ownership footprint is unreadable`;
        touched.push(...files.stdout.split('\n').filter(Boolean));
      }
      if(!touched.length)return `external worker ${workers[i]} has no established scoped ownership footprint`;
      const overlaps=touched.filter(p=>paths.some(q=>p===q||p.startsWith(q.replace(/\/$/,'')+'/')));
      if(overlaps.length)return `external worker ${workers[i]} owns overlapping candidate paths: ${overlaps.slice(0,3).join(', ')}`;
    }
    return null;
  }catch{return 'external ownership response is unusable';}
}

/** Candidate and applicable inputs refresh after awaits; active acceptance
 * snapshots remain frozen. A changed graph invalidates pending dispatch. */
export function queueValidator(project:string,tracker:number,queue:CanonicalQueue,issue:number,cardId?:string,deps:QueueValidationDeps={tracker:loadRoadmapTracker,states:loadRoadmapStates,ownership:externalIssueHold,preference:k=>preferences.get(k),cards:()=>tasks.listLive()}):()=>Promise<string|null> {
  const record=queue.records.find(r=>r.issue===issue);
  const selectionAtCreation=deps.preference(QUEUE_SELECTIONS_PREF);
  return async()=>{
    if(!record)return 'candidate has no versioned queue record';
    if(record.hold)return record.hold;
    if(deps.preference(QUEUE_SELECTIONS_PREF)!==selectionAtCreation)return 'selected-slice dispositions changed; fresh dispatch required';
    const config=JSON.parse(deps.preference('autopilot')??'{}');
    if(!config.enabled||config.project!==project||config.roadmap?.issue!==tracker)return 'scheduler configuration changed';
    const [doc,states,external]=await Promise.all([
      deps.tracker(project,tracker),
      deps.states(project,[issue,...record.applicableInputs]),
      deps.ownership(project,issue,record.paths),
    ]);
    if('error'in doc)return doc.error;
    if(hash(doc.body)!==queue.sources[0]?.hash)return 'tracker/source revision changed; fresh cycle required';
    if('error'in states)return states.error;
    if(external)return external;
    const target=states.get(issue);
    if(target?.state!=='OPEN')return 'target issue is no longer open or readable';
    if(target.updatedAt!==record.updatedAt||hash(target.body??'')!==record.bodyHash)return 'current acceptance/input contract changed; fresh cycle required';
    for(const input of record.applicableInputs) {
      const state=states.get(input);
      if(state?.state!=='CLOSED'||state.stateReason!=='COMPLETED')return `input #${input} is no longer graph-complete`;
      const prior=queue.records.find(r=>r.issue===input);
      if(prior&&(state.updatedAt!==prior.updatedAt||hash(state.body??'')!==prior.bodyHash))return `input #${input} contract changed; fresh cycle required`;
    }
    const identity=canonicalIssue(target.url);
    const other=deps.cards().find(t=>!t.pipelineParentId&&t.archivedAt==null&&t.id!==cardId&&canonicalIssue(t.issueUrl)===identity&&(!neverStarted(t)||t.column==='done'));
    return other?`existing card ${other.id} owns this issue`:null;
  };
}
