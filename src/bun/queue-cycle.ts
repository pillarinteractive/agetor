import { randomUUID } from 'node:crypto';
import { preferences, reservationTransaction } from './db.ts';

export const QUEUE_WAKE_PREF='autopilot_queue_wake_v1';
interface WakeState { token?:string;pid?:number;project?:string;tracker?:number;startedAt?:number;nextAt?:number;emptyCycles?:number;cursor?:number;recent?:{at:number;outcome:string}[]; }
const read=():WakeState=>JSON.parse(preferences.get(QUEUE_WAKE_PREF)??'{}');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}};
let activeToken:string|null=null;

/** Finite deterministic scheduler cycles share a durable single-owner CAS.
 * A dead cycle is resumed from current facts, never a remembered LLM turn. */
export function beginQueueCycle(project:string,tracker:number):string|null {
  return reservationTransaction(()=>{
    const s=read();if(s.token&&s.pid&&alive(s.pid)&&(s.pid!==process.pid||activeToken===s.token))return null;
    const token=randomUUID();preferences.set(QUEUE_WAKE_PREF,JSON.stringify({...s,token,pid:process.pid,project,tracker,startedAt:Date.now()}));activeToken=token;return token;
  });
}
export function completeQueueCycle(token:string,outcome:'progress'|'full'|'empty'|'error'):number {
  try{return reservationTransaction(()=>{
    const s=read();if(s.token!==token)return 300_000;
    const emptyCycles=outcome==='empty'||outcome==='error'?(s.emptyCycles??0)+1:0;
    const delay=outcome==='full'?300_000:Math.min(300_000,30_000*2**Math.min(4,emptyCycles));
    const {token:_token,pid:_pid,...rest}=s;
    preferences.set(QUEUE_WAKE_PREF,JSON.stringify({...rest,emptyCycles,nextAt:Date.now()+delay,cursor:(s.cursor??0)+1,recent:[...(s.recent??[]),{at:Date.now(),outcome}].slice(-25)}));return delay;
  });}finally{if(activeToken===token)activeToken=null;}
}
export function restoredQueueDelay():number {
  try{return Math.max(0,Math.min(300_000,(read().nextAt??Date.now())-Date.now()));}catch{return 30_000;}
}
