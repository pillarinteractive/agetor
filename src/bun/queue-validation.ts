import { createHash } from 'node:crypto';
import path from 'node:path';
import { run } from './github.ts';
import { preferences, tasks } from './db.ts';
import { loadRoadmapStates, loadRoadmapTracker, QUEUE_SELECTIONS_PREF } from './roadmap-fetch.ts';
import { canonicalIssue, controllingInputs, applicableInputs, type CanonicalQueue, type QueueRecord } from '../shared/canonical-roadmap.ts';
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
export async function reconcileCardInputs(taskId:string, states:typeof loadRoadmapStates=loadRoadmapStates):Promise<{hold?:string;note?:string}> {
  const facts=JSON.parse(preferences.get(CARD_FACTS)??'{}') as Record<string,CardFacts>,f=facts[taskId];if(!f)return {};
  const current=await states(f.project,[f.record.issue,...f.record.applicableInputs]);
  if('error'in current)return {hold:current.error};
  const changed:string[]=[];
  const target=current.get(f.record.issue);
  if(target?.state!=='OPEN')return {hold:`#${f.record.issue} closed or unreadable; reconcile current ownership before another step`};
  if(!target.body||!target.updatedAt)return {hold:`#${f.record.issue} current contract/revision is unreadable`};
  const applicable=applicableInputs(controllingInputs(target.body),f.record.selection);
  if(hash(target.body??'')!==f.record.bodyHash)changed.push(`issue #${f.record.issue} acceptance/input contract changed after dispatch`);
  for(const i of f.inputs)if(applicable.inputs.includes(i.issue)&&hash(current.get(i.issue)?.body??'')!==i.hash)changed.push(`producer #${i.issue} contract changed after dispatch`);
  const added=applicable.inputs.filter(n=>!f.record.applicableInputs.includes(n));
  if(added.length)changed.push(`current required inputs added: ${added.map(n=>'#'+n).join(', ')}`);
  const removed=f.record.applicableInputs.filter(n=>!applicable.inputs.includes(n));
  if(removed.length)changed.push(`current controlling contract removed inputs: ${removed.map(n=>'#'+n).join(', ')}`);
  const message=changed.join('; ');
  const latest=JSON.parse(preferences.get(CARD_FACTS)??'{}') as Record<string,CardFacts>;
  if(message&&latest[taskId]&&latest[taskId].changes.at(-1)?.message!==message){latest[taskId].changes=[...latest[taskId].changes,{at:Date.now(),message}].slice(-25);preferences.set(CARD_FACTS,JSON.stringify(latest));}
  if(applicable.hold)return {hold:applicable.hold};
  const missing=applicable.inputs.filter(n=>!current.has(n));
  if(missing.length) {
    const extra=await states(f.project,[f.record.issue,...missing]);
    if('error'in extra)return {hold:extra.error};
    const refreshed=extra.get(f.record.issue);
    if(refreshed?.state!=='OPEN'||refreshed.updatedAt!==target.updatedAt||hash(refreshed.body??'')!==hash(target.body))return {hold:'owning contract changed during input reconciliation; waiting for a coherent fresh read'};
    for(const [n,value] of extra)current.set(n,value);
  }
  for(const n of applicable.inputs) {
    const input=current.get(n);
    if(input?.state!=='CLOSED'||input.stateReason!=='COMPLETED'||!input.body||!input.updatedAt)return {hold:`required input #${n} is not graph-complete with readable current contract/evidence`};
  }
  if(!message)return {};
  return {note:`Dispatch graph ${f.graphVersion} and its original acceptance snapshot remain recorded. ${message}. Read the CURRENT owning issues and reconcile the complete plan, inputs and all acceptance before proceeding. Review independently checks the current complete contract. Missing real authority/artifacts remain holds; do not close the issue using stale acceptance.`};
}
export interface QueueValidationDeps {
  tracker:typeof loadRoadmapTracker;
  states:typeof loadRoadmapStates;
  ownership:(project:string,issue:number,paths?:string[])=>Promise<string|null>;
  preference:(key:string)=>string|null;
  cards:typeof tasks.listLive;
}

export interface ExternalOwnershipDeps {
  command: typeof run;
  pidState: (pid: number) => 'alive' | 'dead' | 'unknown';
  cards: typeof tasks.listLive;
}
const ownershipDeps: ExternalOwnershipDeps = {
  command: run,
  pidState: pid => {
    try { process.kill(pid, 0); return 'alive'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
  },
  cards: () => tasks.listLive(),
};
const containsPath = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
const overlapsPath = (a: string, b: string) => {
  const left = path.posix.normalize(a).replace(/\/$/, '');
  const right = path.posix.normalize(b).replace(/\/$/, '');
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
};

/** Read-only exact external claims. No process control, adoption or lock clearing. */
export async function externalIssueHold(project:string,issue:number,paths:string[]=[],deps:ExternalOwnershipDeps=ownershipDeps):Promise<string|null> {
  const command=deps.command;
  const [ps,wt,prs]=await Promise.all([
    command(['ps','-axo','pid=,comm='],project,10_000,process.env),
    command(['git','worktree','list','--porcelain'],project,10_000,process.env),
    command(['gh','pr','list','--state','open','--limit','100','--json','number,headRefName,body'],project,30_000,process.env),
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
    const cdirs=await Promise.all(workers.map(pid=>command(['lsof','-a','-p',String(pid),'-d','cwd','-Fn'],project,10_000,process.env)));
    for(let i=0;i<cdirs.length;i++) {
      const r=cdirs[i]!;
      const cwd=r.stdout.match(/^n(.+)$/m)?.[1];
      if(!r.ok||!cwd) {
        // Only ESRCH proves absence. Inaccessible or malformed cwd evidence
        // cannot establish that a live worker is unrelated to this project.
        if(deps.pidState(workers[i]!)==='dead')continue;
        return `external worker ${workers[i]} cwd is unreadable; ownership remains unknown`;
      }
      const tree=worktrees.filter(t=>t.path&&containsPath(path.resolve(t.path),path.resolve(cwd)))
        .sort((a,b)=>b.path!.length-a.path!.length)[0];
      if(!tree)continue;
      if(tree.branch&&issuePattern.test(tree.branch))return `external worker ${workers[i]} owns ${tree.branch}`;
      const known=deps.cards().some(t=>t.worktreePath===tree.path);
      if(known)continue;
      const [diff,untracked]=await Promise.all([
        command(['git','diff','--name-only','-z','HEAD'],tree.path!,10_000,process.env),
        command(['git','ls-files','--others','--exclude-standard','-z'],tree.path!,10_000,process.env),
      ]);
      // The project's own checkout with no tracked change and nothing unpushed
      // is where the owner's interactive sessions sit: it is not building an
      // issue (that needs a branch or a commit), and its untracked files are
      // the owner's notes. Counting it held every candidate while such a
      // session stayed open (2026-10-14: no card started for 8 hours).
      if(tree===worktrees[0]&&diff.ok&&!diff.stdout.replace(/\0/g,'')) {
        const ahead=await command(['git','rev-list','--count','@{upstream}..HEAD'],tree.path!,10_000,process.env);
        if(ahead.ok&&ahead.stdout.trim()==='0')continue;
      }
      if(!diff.ok||!untracked.ok||!paths.length)return `external worker ${workers[i]} in ${cwd} has unresolved ownership for this candidate`;
      const touched=[...diff.stdout.split('\0'),...untracked.stdout.split('\0')].filter(Boolean);
      const pr=open.find(p=>p.headRefName===tree.branch);
      if(pr) {
        const files=await command(['gh','api','--paginate',`repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`,'-q','.[].filename'],project,30_000,process.env);
        if(!files.ok)return `external PR #${pr.number} ownership footprint is unreadable`;
        touched.push(...files.stdout.split('\n').filter(Boolean));
      }
      if(!touched.length)return `external worker ${workers[i]} has no established scoped ownership footprint`;
      const overlaps=touched.filter(p=>paths.some(q=>overlapsPath(p,q)));
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
  const configAtCreation=deps.preference('autopilot');
  const invalidated=()=> {
    if(deps.preference(QUEUE_SELECTIONS_PREF)!==selectionAtCreation)return 'selected-slice dispositions changed; fresh dispatch required';
    if(deps.preference('autopilot')!==configAtCreation)return 'scheduler configuration changed';
    try {
      const config=JSON.parse(configAtCreation??'{}');
      if(!config.enabled||config.project!==project||config.roadmap?.issue!==tracker)return 'scheduler configuration changed';
    }catch{return 'scheduler configuration is unreadable';}
    return null;
  };
  return async()=>{
    if(!record)return 'candidate has no versioned queue record';
    if(record.hold)return record.hold;
    const before=invalidated();if(before)return before;
    const [doc,states,external]=await Promise.all([
      deps.tracker(project,tracker),
      deps.states(project,[issue,...record.applicableInputs]),
      deps.ownership(project,issue,record.paths),
    ]);
    const after=invalidated();if(after)return after;
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
