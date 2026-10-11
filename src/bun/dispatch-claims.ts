/** Durable CAS reservations in the existing preferences table; no schema migration. */
import { randomUUID } from 'node:crypto';
import { db, preferences, runs, tasks } from './db.ts';
import { currentSlots, isHeavyStep, slotDecision, slotUse, type SlotUse } from './step-slots.ts';
import { canonicalIssue } from '../shared/canonical-roadmap.ts';
import { awaitsFor } from './awaits.ts';
import { isQuotaPaused } from './usage-limit.ts';

const ISSUE_PREF = 'dispatch_issue_claims_v1';
const RUNNER_PREF = 'dispatch_runner_reservations_v1';
interface IssueClaim { token: string; taskId: string; pid: number; at: number; }
interface RunnerClaim { taskId: string; runId: string | null; pid: number; at: number; name: string; }
function read<T>(key: string): Record<string,T> {
  const raw=preferences.get(key);
  if (!raw) return {};
  const v=JSON.parse(raw);
  if (!v || typeof v!=='object' || Array.isArray(v)) throw new Error(`invalid durable dispatch state: ${key}`);
  return v;
}
function alive(pid: number): boolean { try { process.kill(pid,0);return true; } catch(e) { return (e as NodeJS.ErrnoException).code!=='ESRCH'; } }
function atomic<T>(fn:()=>T): T { return db.transaction(fn).immediate(); }

/** Claim before awaited creation. An uncertain owner is never timed out. */
export function claimIssue(url: string): { key: string; claim: IssueClaim } | { error: string } {
  const key=canonicalIssue(url);
  if (!key) return {error:'invalid canonical issue identity'};
  return atomic(()=>{
    const claims=read<IssueClaim>(ISSUE_PREF), previous=claims[key];
    if (previous) {
      const t=tasks.get(previous.taskId);
      // A bound card is reconciled by the caller's normal existing-card
      // check. A dead creator with no inserted row provably never spawned.
      if (t || alive(previous.pid)) return {error:`issue dispatch already claimed (${previous.taskId})`};
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
function measured(isLive:(id:string)=>boolean, claims:Record<string,RunnerClaim>, exclude?:string):SlotUse {
  const list=tasks.listLive(), slots=currentSlots();
  const without=list.map(t=>t.pipelineRun ? {...t,pipelineRun:{...t.pipelineRun,active:t.pipelineRun.active.filter(a=>a.taskId!==exclude)}} : t).filter(t=>t.id!==exclude);
  const use=slotUse(isLive,slots,without);
  const represented=new Set<string>();
  for(const t of without) {
    if(t.pipelineRun) for(const a of t.pipelineRun.active) {
      const child=tasks.get(a.taskId), settled=t.pipelineRun.history.find(h=>h.taskId===a.taskId&&h.seq===a.seq)?.outcome!=null;
      if((isLive(a.taskId)||(!settled&&!t.pipelineRun.blocked.some(b=>b.taskId===a.taskId))) && !(child?.pendingInteractionCount??0) && !isQuotaPaused(a.taskId)) represented.add(a.taskId);
    }
    else if(!t.pipelineParentId&&t.column==='running'&&!t.pendingInteractionCount&&!isQuotaPaused(t.id)) represented.add(t.id);
  }
  for(const [id,c] of Object.entries(claims)) {
    if(id===exclude) continue;
    const t=tasks.get(id), r=c.runId ? runs.get(c.runId) : t?.runId ? runs.get(t.runId) : null;
    if(c.runId&&!r) {if(!represented.has(id)){use.total++;if(isHeavyStep(c.name,slots))use.heavy++;}continue;}
    const detached=!!t?.worktreePath && awaitsFor(t.worktreePath,c.at).some(a=>!a.finished);
    if(!isLive(id)&&!detached&&r&&['succeeded','failed','cancelled'].includes(r.status)) {delete claims[id];continue;}
    if(!r&&!t&&!alive(c.pid)) {delete claims[id];continue;}
    // No spawn receipt plus a dead owner is safely absent, even when a
    // pre-inserted ready row survives. Running/orphaned rows remain held.
    if(!r&&!isLive(id)&&!alive(c.pid)) {delete claims[id];continue;}
    if(t?.pendingInteractionCount||isQuotaPaused(id)) continue;
    if(!represented.has(id)) {use.total++;if(isHeavyStep(c.name,slots))use.heavy++;}
  }
  return use;
}
export function runnerUse(isLive:(id:string)=>boolean):SlotUse {
  return atomic(()=>{const claims=read<RunnerClaim>(RUNNER_PREF);const use=measured(isLive,claims);preferences.set(RUNNER_PREF,JSON.stringify(claims));return use;});
}
export function reserveRunner(taskId:string,name:string,isLive:(id:string)=>boolean):{ok:true}|{error:string} {
  return atomic(()=>{
    const claims=read<RunnerClaim>(RUNNER_PREF), existing=claims[taskId];
    if(existing) {
      const t=tasks.get(taskId),r=existing.runId?runs.get(existing.runId):null;
      if(existing.runId&&!r)return {error:'runner spawn receipt is uncertain; no dispatch replay'};
      if(existing.pid===process.pid&&!existing.runId) return {ok:true};
      if(isLive(taskId)||r?.status==='running'||r?.status==='orphaned') return {error:'runner reservation is active or uncertain; reconcile its exact run first'};
      if(t?.worktreePath&&awaitsFor(t.worktreePath,existing.at).some(a=>!a.finished)) return {error:'runner reservation retains a detached command'};
      delete claims[taskId];
    }
    const use=measured(isLive,claims,taskId), decision=slotDecision(name,use,currentSlots());
    if(!decision.ok){preferences.set(RUNNER_PREF,JSON.stringify(claims));return {error:decision.why};}
    claims[taskId]={taskId,runId:null,pid:process.pid,at:Date.now(),name};preferences.set(RUNNER_PREF,JSON.stringify(claims));return {ok:true};
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
