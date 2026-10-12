/** Managed Pillar launches share its existing two-file flock protocol.
 * This is a launch guard, not an OS sandbox for arbitrary external commands. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {dataDir} from './db.ts';

export const HEAVY_BIN=path.join(dataDir,'bin','agetor-heavy');
export const HEAVY_TOOLS=path.join(dataDir,'bin','managed-heavy-tools');
export const HEAVY_SLOTS=path.resolve(dataDir)===path.join(homedir(),'.agetor')
  ? path.join(homedir(),'.cache','pillar','verify-slots') : path.join(dataDir,'heavy-slots');
export interface HeavyJob {pid:number;cwd:string;slot:number;}
const LOCK_PROBE="import fcntl,sys; f=open(sys.argv[1],'r');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('free')\nexcept BlockingIOError: print('held')";
export function heavyJobs(root=HEAVY_SLOTS):HeavyJob[] {
  const result:HeavyJob[]=[];
  for(let slot=0;slot<2;slot++) {
    const file=path.join(root,`slot${slot}.lock`);if(!existsSync(file))continue;
    const probe=Bun.spawnSync(['python3','-c',LOCK_PROBE,file],{stdout:'pipe',stderr:'pipe'});
    // An unlocked stale marker is not execution. Unknown locks stay occupied.
    if(probe.exitCode===0&&probe.stdout.toString().trim()==='free')continue;
    let match:RegExpMatchArray|null=null;
    try{match=readFileSync(file,'utf8').trim().match(/^pid=(\d+) cwd=(.+)$/);}catch{/* occupied, unknown owner */}
    result.push({pid:match?Number(match[1]):0,cwd:match?.[2]??'',slot});
  }
  return result;
}

export const HEAVY_SCRIPT=`#!/usr/bin/env python3
import contextlib, fcntl, importlib.util, os, pathlib, subprocess, sys, time
directory=pathlib.Path(${JSON.stringify(HEAVY_SLOTS)})
args=sys.argv[1:]
if args and args[0]=='--': args=args[1:]
if not args: raise SystemExit('usage: agetor-heavy -- command [args...]')
env=dict(os.environ)
# Normal env prefixes retain ordinary arguments; capacity overrides cannot win.
if pathlib.Path(args[0]).name=='env':
 args=args[1:]
 while args and '=' in args[0] and not args[0].startswith('-'):
  key,value=args.pop(0).split('=',1)
  if key not in ('CI','GITHUB_ACTIONS','PILLAR_VERIFY_SLOTS','PILLAR_VERIFY_SLOT_DIR') and not key.startswith('AGETOR_HEAVY_'): env[key]=value
 if not args or args[0].startswith('-'): raise SystemExit('unsupported env option; pass direct command argv')
env.pop('CI',None); env.pop('GITHUB_ACTIONS',None)
env['PILLAR_VERIFY_SLOTS']='2'; env['PILLAR_VERIFY_SLOT_DIR']=str(directory)
record=env.get('AGETOR_AWAIT_RECORD')
def state(value):
 if record: pathlib.Path(record,'resource-state').write_text(value)
root=subprocess.run(['git','rev-parse','--show-toplevel'],capture_output=True,text=True)
cwd=root.stdout.strip() if root.returncode==0 else os.getcwd()
def ancestors():
 result=set(); pid=os.getppid()
 for _ in range(64):
  if pid<=1 or pid in result: break
  result.add(pid)
  p=subprocess.run(['ps','-o','ppid=','-p',str(pid)],capture_output=True,text=True)
  try: pid=int(p.stdout.strip())
  except ValueError: break
 return result
def held(file):
 with open(file,'r') as check:
  try: fcntl.flock(check,fcntl.LOCK_EX|fcntl.LOCK_NB); return False
  except BlockingIOError: return True
def parent_lease():
 lineage=ancestors()
 token=env.get('AGETOR_HEAVY_PID')
 if token:
  try:
   pid=int(token); slot=int(env['AGETOR_HEAVY_SLOT']); fd=int(env.get('AGETOR_HEAVY_FD','-1'))
   file=directory/f'slot{slot}.lock'
   if slot not in (0,1) or env.get('AGETOR_HEAVY_DIR')!=str(directory) or pid not in lineage: raise ValueError()
   if file.read_text().strip()!=f'pid={pid} cwd={cwd}': raise ValueError()
   if fd>=0:
    try:
     a,b=os.fstat(fd),file.stat()
     if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino): raise ValueError()
     fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
     return pid,slot,fd
    except OSError: pass
   if not held(file): raise ValueError()
   return pid,slot,-1
  except (KeyError,ValueError,OSError): raise SystemExit('invalid managed heavy-job identity; no execution')
 # A legacy verifier owns this same guard but predates the env token.
 # Reuse only an exact live ancestor, same worktree and occupied kernel lock.
 for slot in range(2):
  file=directory/f'slot{slot}.lock'
  try:
   text=file.read_text().strip(); prefix,owned_cwd=text.split(' cwd=',1)
   pid=int(prefix.removeprefix('pid='))
   if pid in lineage and owned_cwd==cwd and held(file): return pid,slot,-1
  except (ValueError,OSError): pass
 return None
@contextlib.contextmanager
def lease(*_args,**_kwargs):
 inherited=parent_lease()
 if inherited:
  pid,slot,fd=inherited
  env.update(AGETOR_HEAVY_PID=str(pid),AGETOR_HEAVY_SLOT=str(slot),AGETOR_HEAVY_DIR=str(directory),AGETOR_HEAVY_FD=str(fd))
  os.environ.update(env)
  yield fd
  return
 directory.mkdir(parents=True,exist_ok=True); state('waiting'); handle=None
 while handle is None:
  for slot in range(2):
   candidate=open(directory/f'slot{slot}.lock','a+')
   try: fcntl.flock(candidate,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError: candidate.close(); continue
   candidate.seek(0); candidate.truncate(); candidate.write(f'pid={os.getpid()} cwd={cwd}\\n'); candidate.flush()
   handle=candidate; break
  if handle is None: time.sleep(0.2)
 fd=handle.fileno()
 env.update(AGETOR_HEAVY_PID=str(os.getpid()),AGETOR_HEAVY_SLOT=str(slot),AGETOR_HEAVY_DIR=str(directory),AGETOR_HEAVY_FD=str(fd))
 os.environ.update(env)
 try:
  state('running'); yield fd
 finally:
  state('finished'); handle.close()
verifier=next((i for i,a in enumerate(args) if pathlib.Path(a).name=='verify_changed.py'),None)
if verifier is not None:
 # Run the original planner/cache/runner unchanged, substituting only its
 # resource context so nested managed test children share one job lease.
 file=pathlib.Path(args[verifier]).resolve()
 spec=importlib.util.spec_from_file_location('agetor_managed_verifier',file)
 module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
 module.verification_slot=lease
 os.environ.update(env)
 raise SystemExit(module.main(args[verifier+1:]))
if pathlib.Path(args[0]).name in ('sh','bash','zsh'):
 raise SystemExit('Pass direct command argv; shell expressions are outside the managed guard')
with lease() as fd:
 code=subprocess.call(args,env=env,pass_fds=(fd,) if fd>=0 else ())
raise SystemExit(code)
`;

export const HEAVY_ROUTE_SCRIPT=`#!/usr/bin/env python3
import os, pathlib, shutil, sys
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
managed=${JSON.stringify(HEAVY_TOOLS)}
paths=[p for p in os.environ.get('PATH','').split(os.pathsep) if os.path.realpath(p)!=os.path.realpath(managed)]
real=shutil.which(name,path=os.pathsep.join(paths))
if not real: raise SystemExit('managed tool not found: '+name)
words=[a.lower() for a in args]
scripts=('test','build','verify','lint','typecheck','check','coverage','vitest','jest','playwright','tsc','vite')
def testword(word): return any(word==s or word.startswith(s+':') or word.startswith(s+'-') for s in scripts)
heavy=(name=='go' and any(w in ('test','build','vet') for w in words)) or (name in ('vitest','vite','tsc','jest','playwright'))
if name in ('pnpm','npm','npx','bun'): heavy=heavy or any(testword(w) for w in words) or any(w in ('install','ci','exec','x') for w in words)
if name=='node': heavy=any(any(s in pathlib.Path(a).as_posix().lower() for s in ('vitest','jest','playwright','typescript/bin/tsc','vite/bin')) for a in args)
if heavy: os.execv(${JSON.stringify(HEAVY_BIN)},[${JSON.stringify(HEAVY_BIN)},'--',real,*args])
os.execv(real,[real,*args])
`;

export function installHeavyHelper():void {
  mkdirSync(path.dirname(HEAVY_BIN),{recursive:true});
  if(!existsSync(HEAVY_BIN)||readFileSync(HEAVY_BIN,'utf8')!==HEAVY_SCRIPT)writeFileSync(HEAVY_BIN,HEAVY_SCRIPT,{mode:0o755});
  mkdirSync(HEAVY_TOOLS,{recursive:true});
  const route=path.join(HEAVY_TOOLS,'route');
  if(!existsSync(route)||readFileSync(route,'utf8')!==HEAVY_ROUTE_SCRIPT)writeFileSync(route,HEAVY_ROUTE_SCRIPT,{mode:0o755});
  for(const tool of ['go','pnpm','npm','npx','bun','node','vitest','vite','tsc','jest','playwright'])if(!existsSync(path.join(HEAVY_TOOLS,tool)))symlinkSync('route',path.join(HEAVY_TOOLS,tool));
}
export function managedPillarRoot(cwd:string):string|null {
  const git=Bun.spawnSync(['git','-C',cwd,'rev-parse','--show-toplevel'],{stdout:'pipe',stderr:'pipe'});
  if(git.exitCode!==0)return null;
  const root=git.stdout.toString().trim();
  return root&&existsSync(path.join(root,'.github/scripts/verify_changed.py'))?root:null;
}
export function managedHeavyEnv(cwd:string,env:Record<string,string>={}):Record<string,string> {
  if(!managedPillarRoot(cwd))return env;
  installHeavyHelper();
  return {...env,PATH:[HEAVY_TOOLS,env.PATH??process.env.PATH??''].join(path.delimiter)};
}
export const HEAVY_INSTRUCTIONS=`All test/build commands, including direct Vitest, pnpm test, Go tests and builds, must use ${HEAVY_BIN} -- <direct command argv>. Supported managed tool names also route through the same two machine verification slots as verify_changed.py. Nested children reuse their exact parent job lease. Never set CI/GITHUB_ACTIONS or change slot directories/counts to bypass local capacity. For a command that may exceed five minutes including queue wait, use agetor-await with this wrapper once, end your turn, and wait for its completion notification. Do not stop a queued job, poll it, duplicate it or claim unrun checks passed. Absolute executable paths, custom scripts and external processes remain outside PATH routing; use the explicit wrapper for them. This launch guard is not an OS sandbox.`;
