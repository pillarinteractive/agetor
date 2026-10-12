import {test,expect,afterAll} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const fixture=mkdtempSync(path.join(tmpdir(),'agetor-heavy-test-'));
process.env.AGETOR_DATA_DIR=path.join(fixture,'data');
const {HEAVY_BIN,HEAVY_SLOTS,HEAVY_TOOLS,installHeavyHelper,heavyJobs,managedHeavyEnv}=await import('./heavy-jobs.ts');
installHeavyHelper();
const cwd=path.join(fixture,'work'),bin=path.join(fixture,'tools');
mkdirSync(path.join(cwd,'.github/scripts'),{recursive:true});mkdirSync(bin);
if(Bun.spawnSync(['git','init','-q',cwd],{stdout:'pipe',stderr:'pipe'}).exitCode!==0)throw new Error('fixture git init failed');
const log=path.join(fixture,'commands.jsonl');
const tool=`#!/usr/bin/env python3\nimport json,os,pathlib,sys\nwith open(os.environ['TEST_LOG'],'a') as f: f.write(json.dumps({'name':pathlib.Path(sys.argv[0]).name,'args':sys.argv[1:],'ci':os.environ.get('CI'),'slots':os.environ.get('PILLAR_VERIFY_SLOTS'),'dir':os.environ.get('PILLAR_VERIFY_SLOT_DIR')})+'\\n')\nraise SystemExit(int(os.environ.get('TEST_EXIT','0')))\n`;
for(const name of ['pnpm','node'])writeFileSync(path.join(bin,name),tool,{mode:0o755});
writeFileSync(path.join(cwd,'.github/scripts/verify_changed.py'),`import contextlib,subprocess\n@contextlib.contextmanager\ndef verification_slot():\n raise RuntimeError('original resource context must be replaced')\n yield\ndef main(argv=None):\n with verification_slot():\n  return subprocess.call(['pnpm','test','nested-verifier'])\n`);
const env={...process.env,PATH:[HEAVY_TOOLS,bin,process.env.PATH].join(path.delimiter),TEST_LOG:log};
const start=(args:string[],extra:Record<string,string>={})=>Bun.spawn(args,{cwd,env:{...env,...extra},stdout:'pipe',stderr:'pipe'});
const stops=new Map<Bun.Subprocess,string>();
function blocker(){const file=path.join(fixture,'stop-'+crypto.randomUUID());const p=start([HEAVY_BIN,'--','python3','-c','import pathlib,sys,time\nwhile not pathlib.Path(sys.argv[1]).exists(): time.sleep(0.02)',file]);stops.set(p,file);return p;}
function stop(p:Bun.Subprocess){const file=stops.get(p);if(file)writeFileSync(file,'stop');else p.kill();}
async function until(check:()=>boolean,ms=5000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('fixture timeout');await Bun.sleep(20);}}
async function blockers(){
 const children=[blocker(),blocker()];
 try{await until(()=>heavyJobs().length===2);}catch(error){for(const p of children){stop(p);console.error(await new Response(p.stderr).text());}throw error;}return children;
}
function entries(){return existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];}
afterAll(()=>{rmSync(fixture,{recursive:true,force:true});});

test('managed pnpm and node Vitest routes wait behind two authoritative leases, preserve argv/exit and ignore capacity overrides',async()=>{
 const held=await blockers();const before=entries().length;
 const pnpm=start(['env','CI=1','PILLAR_VERIFY_SLOTS=999','PILLAR_VERIFY_SLOT_DIR=/tmp/forged-policy','PILLAR_VERIFY_SLOT_HELD=1','PILLAR_TEST_SLOT=off','pnpm','test','space arg'],{TEST_EXIT:'7',PILLAR_VERIFY_SLOT_HELD:'1',PILLAR_TEST_SLOT:'off'});
 const node=start(['node','/synthetic/node_modules/vitest/vitest.mjs','run','a.ts']);
 try{
  await Bun.sleep(250);expect(entries()).toHaveLength(before);expect(heavyJobs()).toHaveLength(2);
  stop(held[0]!);await held[0]!.exited;
  expect(await pnpm.exited).toBe(7);expect(await node.exited).toBe(0);
  const next=entries().slice(before);expect(next).toHaveLength(2);
  expect(next.find(e=>e.name==='pnpm').args).toEqual(['test','space arg']);
  for(const e of next){expect(e.ci).toBeNull();expect(e.slots).toBe('2');expect(e.dir).toBe(HEAVY_SLOTS);}
 }finally{for(const p of held)stop(p);await Promise.all(held.map(p=>p.exited));pnpm.kill();node.kill();}
},10000);

test('nested supported tools and a verifier share their exact ancestor job, without a second lease or deadlock',async()=>{
 const other=blocker();await until(()=>heavyJobs().length===1);
 try{
  const nested=start([HEAVY_BIN,'--','python3','-c',"import subprocess;raise SystemExit(subprocess.call(['pnpm','test','nested-direct']))"]);
  expect(await nested.exited).toBe(0);
  const verifier=start([HEAVY_BIN,'--','python3','.github/scripts/verify_changed.py']);
  expect(await verifier.exited).toBe(0);
  expect(entries().some(e=>e.args.includes('nested-direct'))).toBe(true);
  expect(entries().some(e=>e.args.includes('nested-verifier'))).toBe(true);
  expect(heavyJobs()).toHaveLength(1);
 }finally{stop(other);await other.exited;}
},10000);

test('native Vitest admission inherits only an authenticated held lease, so two outer jobs cannot deadlock on their own pool',async()=>{
 const other=blocker();await until(()=>heavyJobs().length===1);
 const nativeNode=Bun.which('node')!;
 const code=`const {spawn}=require('node:child_process');
 const fs=require('node:fs');
 if(process.env.PILLAR_TEST_SLOT==='off')throw new Error('skip override leaked');
 if(process.env.PILLAR_VERIFY_SLOT_HELD==='1'){
   console.log(JSON.stringify({held:process.env.PILLAR_VERIFY_SLOT_HELD,slots:process.env.PILLAR_VERIFY_SLOTS,directory:process.env.PILLAR_VERIFY_SLOT_DIR,pid:process.env.AGETOR_HEAVY_PID,slot:process.env.AGETOR_HEAVY_SLOT}));
 }else{
   // Faithful native admission: without the held marker it tries to flock
   // the same two occupied files. Bound this regression probe to one second.
   const child=spawn('python3',['-c',"import fcntl,os,pathlib,time,sys\\nd=pathlib.Path(os.environ['PILLAR_VERIFY_SLOT_DIR'])\\nend=time.time()+1\\nwhile time.time()<end:\\n for i in range(2):\\n  f=open(d/f'slot{i}.lock','a+')\\n  try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('held',flush=True);sys.exit(0)\\n  except BlockingIOError:f.close()\\n time.sleep(0.02)\\nsys.exit(23)"],{stdio:['pipe','pipe','inherit']});
   child.on('exit',code=>process.exit(code??24));
 }`;
 const nested=start([HEAVY_BIN,'--',nativeNode,'-e',code]);
 try{
  const [out,err]=await Promise.all([new Response(nested.stdout).text(),new Response(nested.stderr).text()]);
  expect(await nested.exited).toBe(0);expect(err).toBe('');
  const observed=JSON.parse(out.trim());expect(observed.held).toBe('1');expect(observed.slots).toBe('2');expect(observed.directory).toBe(HEAVY_SLOTS);expect(Number(observed.pid)).toBeGreaterThan(0);expect([0,1]).toContain(Number(observed.slot));
  expect(heavyJobs()).toHaveLength(1);
 }finally{stop(other);await other.exited;nested.kill();}
},10000);

test('forged unrelated parent identity fails closed; unlocked stale PID markers are not executing',async()=>{
 const held=await blockers();const before=entries().length;
 const marker=readFileSync(path.join(HEAVY_SLOTS,'slot0.lock'),'utf8').match(/^pid=(\d+)/)![1]!;
 const forged=start(['pnpm','test','forged'],{AGETOR_HEAVY_PID:marker,AGETOR_HEAVY_SLOT:'0',AGETOR_HEAVY_DIR:HEAVY_SLOTS,AGETOR_HEAVY_FD:'-1'});
 try{
  expect(await forged.exited).not.toBe(0);expect(entries()).toHaveLength(before);
 }finally{for(const p of held)stop(p);await Promise.all(held.map(p=>p.exited));}
 expect(heavyJobs()).toHaveLength(0);
 writeFileSync(path.join(HEAVY_SLOTS,'slot0.lock'),`pid=${process.pid} cwd=${cwd}\n`);
 expect(heavyJobs()).toHaveLength(0);
});

test('only managed Pillar workdirs receive routing; custom and absolute commands have an explicit boundary',()=>{
 expect(managedHeavyEnv('/not-a-pillar-workdir',{EXAMPLE:'same'})).toEqual({EXAMPLE:'same'});
 expect(managedHeavyEnv(cwd,{EXAMPLE:'same',PATH:bin})).toEqual({EXAMPLE:'same',PATH:HEAVY_TOOLS+path.delimiter+bin});
});

test('managed repository subdirectories receive the same routing; an unrelated nested repository is excluded',()=>{
 const sub=path.join(cwd,'apps/web');mkdirSync(sub,{recursive:true});
 expect(managedHeavyEnv(sub,{PATH:bin})).toEqual(managedHeavyEnv(cwd,{PATH:bin}));
 const unrelated=path.join(cwd,'other-repository');mkdirSync(unrelated);
 expect(Bun.spawnSync(['git','init','-q',unrelated],{stdout:'pipe',stderr:'pipe'}).exitCode).toBe(0);
 expect(managedHeavyEnv(unrelated,{PATH:bin})).toEqual({PATH:bin});
});
