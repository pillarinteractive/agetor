/** Durable CAS reservations in the existing preferences table; no schema migration. */
import { randomUUID } from 'node:crypto';
import { preferences, runs, tasks, reservationTransaction } from './db.ts';
import path from 'node:path';
import { currentSlots, isHeavyStep, slotDecision, slotUse, type SlotUse } from './step-slots.ts';
import { canonicalIssue } from '../shared/canonical-roadmap.ts';
import { awaitsFor, listAwaits, type AwaitRecord } from './awaits.ts';
import {heavyJobs, type HeavyJob} from './heavy-jobs.ts';
import type {Task} from '../shared/types.ts';
import { isQuotaPaused } from './usage-limit.ts';

const ISSUE_PREF = 'dispatch_issue_claims_v1';
const RUNNER_PREF = 'dispatch_runner_reservations_v1';
interface IssueClaim { token: string; taskId: string; pid: number; at: number; }
interface RunnerClaim { taskId: string; ownerId?:string; runId: string | null; pid: number; at: number; name: string; }
function read<T>(key: string): Record<string,T> {
  const raw=preferences.get(key);
  if (!raw) return {};
  const v=JSON.parse(raw);
  if (!v || typeof v!=='object' || Array.isArray(v)) throw new Error(`invalid durable dispatch state: ${key}`);
  return v;
}
function alive(pid: number): boolean { try { process.kill(pid,0);return true; } catch(e) { return (e as NodeJS.ErrnoException).code!=='ESRCH'; } }
const atomic=reservationTransaction;
export interface OwnerEvidence { cards:Task[]; awaits:AwaitRecord[]; jobs:HeavyJob[]; }
const evidence=():OwnerEvidence=>({cards:tasks.listLive(),awaits:listAwaits(),jobs:heavyJobs()});
/** An await that only watches remote work (`ci-wait` polls GitHub CI). It runs
 * nothing on this machine, so a step parked on it holds no agent slot, no
 * verification slot and no card-owner place: the wake-up takes those again. */
export const isRemoteWait=(a:Pick<AwaitRecord,'cmd'>)=>/(^|[\s/])ci-wait(\s|$)/.test(a.cmd);
const inside=(root:string,value:string)=>value===root||value.startsWith(root+path.sep);
function ownerForCwd(cwd:string,list:Task[]):string|null {
  if(!cwd)return null;
  const t=list.filter(t=>t.worktreePath&&inside(path.resolve(t.worktreePath),path.resolve(cwd))).sort((a,b)=>b.worktreePath!.length-a.worktreePath!.length)[0];
  return t?.pipelineParentId??t?.id??null;
}
const ownerOf=(id:string,claims:Record<string,RunnerClaim>,list:Task[])=>claims[id]?.ownerId??list.find(t=>t.id===id)?.pipelineParentId??id;
const jobOwner=(j:HeavyJob,list:Task[])=>ownerForCwd(j.cwd,list)??(j.pid>0?`heavy:${j.pid}`:`heavy-slot:${j.slot}`);
function waitingDetached(id:string,isLive:(id:string)=>boolean,ev:OwnerEvidence):boolean {
  const t=ev.cards.find(t=>t.id===id);if(!t?.worktreePath||isLive(id))return false;
  const current=t.runId?runs.get(t.runId):null;
  if(current?.status==='running'||current?.status==='orphaned')return false;
  const owner=t.pipelineParentId??t.id;
  if(ev.jobs.some(j=>jobOwner(j,ev.cards)===owner))return false;
  const outstanding=ev.awaits.filter(a=>!a.finished&&!a.notified&&ownerForCwd(a.cwd,ev.cards)===owner);
  return outstanding.length>0&&outstanding.every(a=>a.resourceState==='waiting'||isRemoteWait(a));
}
/** Every progressing owner, including legacy detached work with no claim.
 * Card identity is independent of roadmap membership, issue state or queue. */
function owners(isLive:(id:string)=>boolean,claims:Record<string,RunnerClaim>,ev:OwnerEvidence):Set<string> {
  const result=new Set<string>(),activeHeavy=new Set(ev.jobs.map(j=>jobOwner(j,ev.cards)));
  for(const t of ev.cards) {
    if(t.archivedAt!=null||t.pendingInteractionCount||isQuotaPaused(t.id))continue;
    const r=t.runId?runs.get(t.runId):null;
    if(isLive(t.id)||r?.status==='running'||r?.status==='orphaned')result.add(t.pipelineParentId??t.id);
    if(!t.pipelineParentId&&t.pipelineRun?.status==='running') {
      // Existing-child retries retain `active` while waiting for admission.
      // A terminal idle child is not a busy owner. Live/uncertain runs,
      // accepted reservations and detached jobs still count via their own
      // evidence below; never infer absence from the queue label alone.
      const queuedOnly=t.pipelineRun.blocked.length>0&&t.pipelineRun.blocked.every(b=>b.kind==='slot-wait')
        &&t.pipelineRun.active.every(a=>{
          const child=ev.cards.find(c=>c.id===a.taskId),receipt=child?.runId?runs.get(child.runId):null;
          return !!child&&!isLive(a.taskId)&&(!child.runId||!!receipt&&['succeeded','failed','cancelled'].includes(receipt.status));
        });
      const onlyAwait=t.pipelineRun.blocked.length>0&&t.pipelineRun.blocked.every(b=>b.kind==='await');
      const waitingOnly=onlyAwait&&!activeHeavy.has(t.id)&&t.pipelineRun.active.every(a=>!isLive(a.taskId)&&!['running','orphaned'].includes(runs.get(ev.cards.find(c=>c.id===a.taskId)?.runId??'')?.status??''));
      if(!waitingOnly&&!queuedOnly)result.add(t.id);
    }
  }
  for(const id of Object.keys(claims))if(!waitingDetached(id,isLive,ev))result.add(ownerOf(id,claims,ev.cards));
  for(const a of ev.awaits) {
    if(a.finished||a.notified||isRemoteWait(a))continue;
    const owner=ownerForCwd(a.cwd,ev.cards);if(!owner)continue;
    if(a.resourceState==='waiting'&&!activeHeavy.has(owner))continue;
    result.add(owner);
  }
  for(const owner of activeHeavy)result.add(owner);
  return result;
}
export function activeCardOwners(isLive:(id:string)=>boolean,ev:OwnerEvidence=evidence()):Set<string> {
  return atomic(()=>{const claims=read<RunnerClaim>(RUNNER_PREF);measured(isLive,claims,undefined,ev);preferences.set(RUNNER_PREF,JSON.stringify(claims));return owners(isLive,claims,ev);});
}

/** Claim before awaited creation. An uncertain owner is never timed out. */
export function claimIssue(url: string, isLive:(id:string)=>boolean=()=>false): { key: string; claim: IssueClaim } | { error: string } {
  const key=canonicalIssue(url);
  if (!key) return {error:'invalid canonical issue identity'};
  return atomic(()=>{
    const claims=read<IssueClaim>(ISSUE_PREF), previous=claims[key];
    if (previous) {
      const t=tasks.get(previous.taskId);
      if (alive(previous.pid)) return {error:`issue dispatch already claimed (${previous.taskId})`};
      if (t) {
        const bound=[t,...tasks.stepsForParent(t.id)];
        const runnerClaims=read<RunnerClaim>(RUNNER_PREF);
        const uncertain=bound.some(card=>{
          const receipt=runnerClaims[card.id];
          return isLive(card.id) || card.column==='running' || card.runId&&!runs.get(card.runId)
            || receipt?.runId&&!runs.get(receipt.runId)
            || receipt&&!receipt.runId&&alive(receipt.pid)
            || runs.listForTask(card.id).some(r=>!['succeeded','failed','cancelled'].includes(r.status))
            || card.worktreePath&&awaitsFor(card.worktreePath,previous.at).some(a=>!a.finished);
        });
        const terminal=(t.column==='done'||t.archivedAt!=null)
          && (!t.pipelineRun||['done','cancelled','idle'].includes(t.pipelineRun.status));
        if (!terminal||uncertain) return {error:`issue dispatch already claimed (${previous.taskId})`};
      }
      delete claims[key];
    }
    const claim={token:randomUUID(),taskId:randomUUID(),pid:process.pid,at:Date.now()};
    claims[key]=claim;preferences.set(ISSUE_PREF,JSON.stringify(claims));
    return {key,claim};
  });
}
export function releaseIssue(key: string, token: string): void {
  atomic(()=>{const claims=read<IssueClaim>(ISSUE_PREF);if(claims[key]?.token===token){delete claims[key];preferences.set(ISSUE_PREF,JSON.stringify(claims));}});
}

/** Exact resource use, plus accepted-but-not-yet-inserted/spawned starts. */
function measured(isLive:(id:string)=>boolean, claims:Record<string,RunnerClaim>, exclude?:string,ev:OwnerEvidence=evidence()):SlotUse {
  const list=tasks.listLive(), slots=currentSlots();
  const without=list.map(t=>t.pipelineRun ? {...t,pipelineRun:{...t.pipelineRun,active:t.pipelineRun.active.filter(a=>a.taskId!==exclude)}} : t).filter(t=>t.id!==exclude);
  const use=slotUse(isLive,slots,without);
  const represented=new Set<string>(), heavyRepresented=new Set<string>();
  for(const t of without) {
    if(t.pipelineRun) for(const a of t.pipelineRun.active) {
      const child=tasks.get(a.taskId), settled=t.pipelineRun.history.find(h=>h.taskId===a.taskId&&h.seq===a.seq)?.outcome!=null;
      if((isLive(a.taskId)||(!settled&&!t.pipelineRun.blocked.some(b=>b.taskId===a.taskId))) && !(child?.pendingInteractionCount??0) && !isQuotaPaused(a.taskId)) {
        represented.add(a.taskId);
        const name=t.pipelineRun.snapshot?.graph.steps.find(s=>s.id===a.stepId)?.name??'';
        if(isHeavyStep(name,slots))heavyRepresented.add(a.taskId);
      }
    }
    else if(!t.pipelineParentId&&t.column==='running'&&!t.pendingInteractionCount&&!isQuotaPaused(t.id)) {
      represented.add(t.id);if(isHeavyStep(t.title??'',slots))heavyRepresented.add(t.id);
    }
  }
  for(const [id,c] of Object.entries(claims)) {
    if(id===exclude) continue;
    const t=tasks.get(id), current=t?.runId?runs.get(t.runId):null, r=c.runId ? runs.get(c.runId) : current;
    if(c.runId&&!r) {if(!represented.has(id))use.total++;if(!heavyRepresented.has(id)&&isHeavyStep(c.name,slots))use.heavy++;continue;}
    const detached=!!t?.worktreePath && awaitsFor(t.worktreePath,c.at,ev.awaits).some(a=>!a.finished);
    // An accepted retry may still point at the task's previous terminal run.
    // A live creator's unbound reservation has no completion receipt yet;
    // another core cannot use that older run (or its local liveness) to free it.
    const acceptedUnbound=!c.runId&&alive(c.pid);
    if(!acceptedUnbound&&!isLive(id)&&!detached&&r&&['succeeded','failed','cancelled'].includes(r.status)&&(!t?.runId||current&&['succeeded','failed','cancelled'].includes(current.status))) {delete claims[id];continue;}
    if(!r&&!t&&!alive(c.pid)) {delete claims[id];continue;}
    // No spawn receipt plus a dead owner is safely absent, even when a
    // pre-inserted ready row survives. Running/orphaned rows remain held.
    if(!r&&!isLive(id)&&!alive(c.pid)) {delete claims[id];continue;}
    if(t?.pendingInteractionCount||isQuotaPaused(id)||waitingDetached(id,isLive,ev)) continue;
    if(!represented.has(id))use.total++;
    if(!heavyRepresented.has(id)&&isHeavyStep(c.name,slots))use.heavy++;
  }
  const representedOwners=new Set([...represented,...Object.keys(claims).filter(id=>id!==exclude)].map(id=>ownerOf(id,claims,ev.cards)));
  const heavyOwners=new Set([...heavyRepresented].map(id=>ownerOf(id,claims,ev.cards)));
  for(const [id,c]of Object.entries(claims))if(id!==exclude&&!waitingDetached(id,isLive,ev)&&isHeavyStep(c.name,slots))heavyOwners.add(ownerOf(id,claims,ev.cards));
  const detachedOwners=new Set(ev.jobs.map(j=>jobOwner(j,ev.cards)));
  for(const a of ev.awaits)if(!a.finished&&!a.notified&&a.resourceState!=='waiting'&&!isRemoteWait(a)) {
    const owner=ownerForCwd(a.cwd,ev.cards);if(owner)detachedOwners.add(owner);
  }
  for(const owner of detachedOwners)if(!representedOwners.has(owner))use.total++;
  for(const a of ev.awaits)if(!a.finished&&!a.notified&&a.resourceState!=='waiting'&&!isRemoteWait(a)) {
    const owner=ownerForCwd(a.cwd,ev.cards);if(!owner||heavyOwners.has(owner))continue;
    const parent=ev.cards.find(t=>t.id===owner),run=parent?.pipelineRun;
    const heavy=/verify_changed\.py|agetor-heavy/.test(a.cmd)||run?.active.some(active=>isHeavyStep(run.snapshot?.graph.steps.find(s=>s.id===active.stepId)?.name??'',slots));
    if(heavy){use.heavy++;heavyOwners.add(owner);}
  }
  const jobsByOwner=new Map<string,number>();
  for(const j of ev.jobs){const owner=jobOwner(j,ev.cards);jobsByOwner.set(owner,(jobsByOwner.get(owner)??0)+1);}
  for(const [owner,count]of jobsByOwner)use.heavy+=Math.max(0,count-(heavyOwners.has(owner)?1:0));
  return use;
}
export function runnerUse(isLive:(id:string)=>boolean,ev:OwnerEvidence=evidence()):SlotUse {
  return atomic(()=>{const claims=read<RunnerClaim>(RUNNER_PREF);const use=measured(isLive,claims,undefined,ev);preferences.set(RUNNER_PREF,JSON.stringify(claims));return use;});
}
export function reserveRunner(taskId:string,name:string,isLive:(id:string)=>boolean,ownerId?:string):{ok:true}|{error:string} {
  return atomic(()=>{
    const claims=read<RunnerClaim>(RUNNER_PREF), existing=claims[taskId],ev=evidence();
    const owner=ownerId??tasks.get(taskId)?.pipelineParentId??taskId;
    if(existing) {
      const t=tasks.get(taskId),r=existing.runId?runs.get(existing.runId):null;
      if(existing.runId&&!r)return {error:'runner spawn receipt is uncertain; no dispatch replay'};
      const current=t?.runId?runs.get(t.runId):null;
      if(existing.pid===process.pid&&!existing.runId&&!isLive(taskId)&&!['running','orphaned'].includes(current?.status??'')) {
        return existing.name===name&&ownerOf(taskId,claims,ev.cards)===owner?{ok:true}:{error:'runner reservation resource identity changed; no dispatch replay'};
      }
      if(!existing.runId&&alive(existing.pid)||t?.runId&&!current||isLive(taskId)||r?.status==='running'||r?.status==='orphaned'||current?.status==='running'||current?.status==='orphaned') return {error:'runner reservation is active or uncertain; reconcile its exact run first'};
      if(t?.worktreePath&&awaitsFor(t.worktreePath,existing.at,ev.awaits).some(a=>!a.finished)) return {error:'runner reservation retains a detached command'};
      delete claims[taskId];
    }
    // Move only our own never-spawned parent booking into its first child.
    const booking=owner!==taskId?claims[owner]:null;
    if(booking&&booking.pid===process.pid&&!booking.runId)delete claims[owner];
    const use=measured(isLive,claims,taskId,ev),cardOwners=owners(isLive,claims,ev),slots=currentSlots();
    if(!cardOwners.has(owner)&&cardOwners.size>=slots.max){preferences.set(RUNNER_PREF,JSON.stringify(claims));return {error:`waiting for a slot — ${cardOwners.size} of ${slots.max} card owners busy`};}
    const decision=slotDecision(name,use,slots);
    if(!decision.ok){preferences.set(RUNNER_PREF,JSON.stringify(claims));return {error:decision.why};}
    claims[taskId]={taskId,ownerId:owner,runId:null,pid:process.pid,at:Date.now(),name};preferences.set(RUNNER_PREF,JSON.stringify(claims));return {ok:true};
  });
}
export function bindRunner(taskId:string,runId:string):void {
  atomic(()=>{const claims=read<RunnerClaim>(RUNNER_PREF);const c=claims[taskId];if(c&&c.pid===process.pid){c.runId=runId;preferences.set(RUNNER_PREF,JSON.stringify(claims));}});
}
/** Only a proven never-spawned failure releases directly. Terminal runs
 * are reconciled against exact run/held/detached evidence at the next wake. */
export function releaseUnspawnedRunner(taskId:string):void {
  atomic(()=>{const claims=read<RunnerClaim>(RUNNER_PREF);const c=claims[taskId];if(c&&c.pid===process.pid&&!c.runId){delete claims[taskId];preferences.set(RUNNER_PREF,JSON.stringify(claims));}});
}

/** Called only after deleteTask's awaited process/session teardown, before
 * its run receipts are removed. Detached commands retain their reservation. */
export function releaseDeletedRunner(taskId:string):void {
  atomic(()=>{
    const claims=read<RunnerClaim>(RUNNER_PREF),c=claims[taskId],t=tasks.get(taskId);
    if(c&&!(t?.worktreePath&&awaitsFor(t.worktreePath,c.at).some(a=>!a.finished))) {
      delete claims[taskId];preferences.set(RUNNER_PREF,JSON.stringify(claims));
    }
  });
}
