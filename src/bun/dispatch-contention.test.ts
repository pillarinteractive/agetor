import {test,expect} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const fixture=mkdtempSync(path.join(tmpdir(),'agetor-contention-test-'));process.env.AGETOR_DATA_DIR=fixture;
const {db,preferences}=await import('./db.ts');
const {reserveRunner}=await import('./dispatch-claims.ts');
const {beginQueueCycle,completeQueueCycle,QUEUE_WAKE_PREF}=await import('./queue-cycle.ts');
const source=new URL('./dispatch-claims.ts',import.meta.url).href;
async function writer(seconds:number){
 const p=Bun.spawn(['python3','-c',"import sqlite3,sys,time;d=sqlite3.connect(sys.argv[1]);d.execute('BEGIN IMMEDIATE');print('held',flush=True);time.sleep(float(sys.argv[2]));d.rollback()",path.join(fixture,'agetor.sqlite'),String(seconds)],{stdout:'pipe',stderr:'pipe'});
 const reader=p.stdout.getReader();await reader.read();reader.releaseLock();return p;
}
test('independent writers racing the final free slot admit exactly one durable owner after bounded contention',async()=>{
 preferences.set('step_slots',JSON.stringify({max:8,heavy:{max:2,steps:['Finish']}}));preferences.set('dispatch_runner_reservations_v1','{}');
 for(let i=0;i<7;i++)expect(reserveRunner('existing-'+i,'Build',()=>false)).toEqual({ok:true});
 const held=await writer(0.25);
 const children=['race-a','race-b'].map(id=>Bun.spawn([process.execPath,'--eval',`const m=await import(${JSON.stringify(source)});console.log(JSON.stringify(m.reserveRunner(${JSON.stringify(id)},'Build',()=>false)));await Bun.sleep(1500);`],{env:{...process.env,AGETOR_DATA_DIR:fixture},stdout:'pipe',stderr:'pipe'}));
 const results=await Promise.all(children.map(async p=>{const out=await new Response(p.stdout).text();expect(await p.exited).toBe(0);return JSON.parse(out.trim().split('\n').at(-1)!);}));
 expect(results.filter(r=>r.ok)).toHaveLength(1);expect(Object.keys(JSON.parse(preferences.get('dispatch_runner_reservations_v1')!))).toHaveLength(8);await held.exited;
},10000);
test('exhausted busy retry remains bounded and the exact local cycle can reconcile after unlock without clearing foreign receipts',async()=>{
 const token=beginQueueCycle('/synthetic',639)!;const before=preferences.get('dispatch_runner_reservations_v1');
 const held=await writer(4);const started=performance.now();
 expect(()=>completeQueueCycle(token,'error')).toThrow();expect(performance.now()-started).toBeLessThan(3600);expect(preferences.get(QUEUE_WAKE_PREF)).toContain(token);
 await held.exited;const next=beginQueueCycle('/synthetic',639);expect(next).toBeTruthy();expect(next).not.toBe(token);completeQueueCycle(next!,'empty');expect(preferences.get(QUEUE_WAKE_PREF)).not.toContain('"token"');expect(preferences.get('dispatch_runner_reservations_v1')).toBe(before);
 expect(db.query('PRAGMA busy_timeout').get()).toEqual({timeout:1000});
},10000);
