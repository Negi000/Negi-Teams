import assert from "node:assert/strict";
import { randomUUID,createHmac,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir,mkdtemp,readFile,readdir,writeFile,rm,link,unlink,rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test as nativeTest } from "node:test";
import { MasterConversationAuthority,MasterConversationHeldError,type MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { scheduledMasterTurns } from "../src/server/orchestration/masterTurnAdmission.ts";
import { observeWriter,recoverWriter } from "../src/server/orchestration/writerRecovery.ts";
import { MasterStorageHeldError } from "../src/server/orchestration/masterStorageGuard.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";

const bytes=(value:unknown)=>JSON.stringify(value)+"\n";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const identity={threadId:"new",requestedModel:"fixture",resolvedModel:"fixture",modelProvider:"fixture",rerouted:false};
// Exact-handle Master deletion is supported on Windows. Other OSes keep holds.
const test=(name:string,run:()=>Promise<void>)=>nativeTest(name,{skip:process.platform!=="win32"},run);
async function fixture(run:(f:{dir:string;cwd:string;root:string;master:string;turnRoot:string;scheduler:FileScheduler;request:MasterConversationRequest;reopen:()=>MasterConversationAuthority})=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"negi-master-owner-")),cwd=join(dir,"checkout"),state=join(dir,"state"),root=join(state,"conversations"),turnRoot=join(state,"master-turns");
 await mkdir(cwd);await mkdir(state);const scheduler=new FileScheduler(join(state,"scheduler.jsonl")),master=join(root,"masters","master");
 const request:MasterConversationRequest={requestId:randomUUID(),masterId:"master",mode:"rotate",oldThreadId:"old",cwd,model:"fixture",effort:"low",provider:"fixture",settingsSha256:"a".repeat(64)};
 try{await run({dir,cwd,root,master,turnRoot,scheduler,request,reopen:()=>new MasterConversationAuthority({root,turnRoot,masterId:"master",scheduler})});}
 finally{await rm(dir,{recursive:true,force:true});}
}
type F=Parameters<Parameters<typeof fixture>[0]>[0];
async function stoppedOwner(f:F,kind:"inspection"|"thread-start"|"admission-before"|"admission-queued"="inspection"){
 const authorityModule=pathToFileURL(join(process.cwd(),"src/server/orchestration/masterConversations.ts")).href;
 const schedulerModule=pathToFileURL(join(process.cwd(),"src/server/orchestration/scheduler.ts")).href;
 const operation=kind==="thread-start"?`await a.start(${JSON.stringify(f.request)},async mark=>{await mark();process.exit(23);});`:
  kind.startsWith("admission")?`await a.admitTurn(${JSON.stringify({cwd:f.cwd,model:"fixture",effort:"low",threadId:"old",text:"input",requestId:f.request.requestId})});`:`await a.assertIdle(${JSON.stringify(f.cwd)});`;
 const hook=kind==="thread-start"?"":kind==="admission-queued"?"s.tryClaim=async()=>process.exit(23);":
  `const read=s.read.bind(s);s.read=async()=>{try{await readFile(${JSON.stringify(join(f.master,"owner.lock"))},"utf8");}catch(error){if(error.code==="ENOENT")return read();throw error;}process.exit(23);};`;
 const script=`import {readFile} from "node:fs/promises";import {MasterConversationAuthority} from ${JSON.stringify(authorityModule)};import {FileScheduler} from ${JSON.stringify(schedulerModule)};const s=new FileScheduler(${JSON.stringify(f.scheduler.path)});const a=new MasterConversationAuthority({root:${JSON.stringify(f.root)},turnRoot:${JSON.stringify(f.turnRoot)},masterId:"master",scheduler:s});${hook}${operation}`;
 const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),windowsHide:true,stdio:["ignore","ignore","pipe"]});
 let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});assert.equal(code,23,stderr);
 return readFile(join(f.master,"owner.lock"),"utf8");
}
async function resign(f:F,value:Record<string,unknown>){
 const key=JSON.parse(await readFile(join(f.root,"signing-key.json"),"utf8")).key;
 delete value.signature;return bytes({...value,signature:createHmac("sha256",Buffer.from(key,"hex")).update(JSON.stringify(value)).digest("hex")});
}

test("a surviving independent database or sidecar disables native owner release and preserves its evidence",async()=>{
 for(const suffix of ["","-journal","-wal","-shm",".recoveries",".recoveries.pending"] as const)await fixture(async f=>{
  const ownerBytes=await stoppedOwner(f),authority=f.reopen(),before=await authority.ownerRecovery(f.cwd);
  assert.equal(before?.canRelease,true);const sibling=f.root+".inventory.sqlite3"+suffix;
  await writeFile(sibling,"retained independent evidence");
  const preview=await authority.ownerRecovery(f.cwd);assert.equal(preview?.ownerState,"dead");assert.equal(preview?.canRelease,false);
  assert.match(preview?.reason??"",/保存記録/);
  await assert.rejects(authority.releaseOwner(f.cwd,randomUUID(),before!.proofSha256),MasterConversationHeldError);
  const owner=JSON.parse(ownerBytes),receipt=await recoveryReceipt(f,ownerBytes,randomUUID(),before!.proofSha256);
  await assert.rejects(recoverWriter(f.master,"master",owner.operation,hash(ownerBytes),receipt),MasterStorageHeldError);
  assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),ownerBytes);
  assert.deepEqual(await readdir(f.master),["owner.lock"]);
  assert.equal(await readFile(sibling,"utf8"),"retained independent evidence");
 });
});

test("a sibling appearing after native receipt publication preserves the exact owner and durable receipt",async()=>fixture(async f=>{
 const ownerBytes=await stoppedOwner(f),preview=await f.reopen().ownerRecovery(f.cwd),decisionId=randomUUID();assert.equal(preview?.canRelease,true);
 const receipt=await recoveryReceipt(f,ownerBytes,decisionId,preview!.proofSha256),owner=JSON.parse(ownerBytes),database=f.root+".inventory.sqlite3";
 const code=String.raw`
import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import negi_recover_writer as m
r=json.load(sys.stdin); original=m.publish_receipt_windows
def published(*args):
    original(*args)
    Path(r['database']).write_bytes(b'late independent index')
m.publish_receipt_windows=published
try:
    m.recover_windows(Path(r['master']),'master','master-conversation',r['operation']['requestId'],r['operation']['hash'],r['ownerSha256'],r['receipt'])
    raise AssertionError('owner was removed')
except ValueError as error:
    assert 'Independent Master inventory requires migration' in str(error)
print(json.dumps({'held':True}))`;
 const child=spawn("python",["-B","-c",code,join(process.cwd(),"scripts")],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",bytes=>{stdout+=bytes;});child.stderr.on("data",bytes=>{stderr+=bytes;});
 const timer=setTimeout(()=>child.kill(),5000);
 const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
 child.stdin.end(JSON.stringify({master:f.master,database,operation:owner.operation,ownerSha256:hash(ownerBytes),receipt}));
 try {assert.equal(await closed,0,stderr);}finally {clearTimeout(timer);child.kill();await closed;}
 assert.deepEqual(JSON.parse(stdout),{held:true});
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),ownerBytes);
 assert.deepEqual((await readdir(join(f.master,"recoveries"))).sort(),[owner.owner+".json"]);
 assert.equal(await readFile(join(f.master,"recoveries",owner.owner+".json"),"utf8"),receipt);
 assert.equal(await readFile(database,"utf8"),"late independent index");
}));
async function recoveryReceipt(f:F,ownerBytes:string,decisionId:string,proofSha256:string){
 const key=JSON.parse(await readFile(join(f.root,"signing-key.json"),"utf8")).key;
 const payload={schemaVersion:"negi-master-owner-recovery/1",masterId:"master",decisionId,cwdSha256:hash(f.cwd),owner:JSON.parse(ownerBytes),proofSha256,action:"release-owner-only",at:new Date().toISOString()};
 return bytes({payload,signature:createHmac("sha256",Buffer.from(key,"hex")).update(JSON.stringify(payload)).digest("hex")});
}
async function nativeRecoveryCrash(f:F,ownerBytes:string,receipt:string,phase:"partial"|"published"|"removed"){
 const owner=JSON.parse(ownerBytes),scriptPath=join(process.cwd(),"scripts/negi_recover_writer.py");
 // Deliberate process exit at native boundaries; this is not a power-loss test.
 const hook=phase==="published"?`name='publish_receipt_windows' if os.name=='nt' else 'publish_receipt_linux'\noriginal=getattr(m,name)\ndef stopped(*args):\n original(*args)\n os._exit(23)\nsetattr(m,name,stopped)\n`:
  phase==="partial"?`if os.name=='nt':\n factory=m.windows_kernel\n def patched():\n  kernel=factory()\n  original=kernel.WriteFile\n  def partial(handle,buffer,size,count,overlapped):\n   original(handle,buffer,size//2,count,overlapped)\n   os._exit(23)\n  kernel.WriteFile=partial\n  return kernel\n m.windows_kernel=patched\nelse:\n original=os.write\n def partial(fd,raw):\n  original(fd,raw[:len(raw)//2])\n  os._exit(23)\n os.write=partial\n`:"";
 const script=`import os,importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('native',${JSON.stringify(scriptPath)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n${hook}fn=m.recover_windows if os.name=='nt' else m.recover_linux\nfn(Path(${JSON.stringify(f.master)}),'master','master-conversation',${JSON.stringify(owner.operation.requestId)},${JSON.stringify(owner.operation.hash)},${JSON.stringify(hash(ownerBytes))},${JSON.stringify(receipt)})\nos._exit(23)\n`;
 const child=spawn("python",["-c",script],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});assert.equal(code,23,stderr);
}

test("absent recovery preview creates no files or native guard",async()=>fixture(async f=>{
 const names=await readdir(join(f.dir,"state"));assert.equal(await f.reopen().ownerRecovery(f.cwd),null);
 assert.deepEqual(await readdir(join(f.dir,"state")),names);assert.equal((await f.scheduler.read()).state,null);
}));

test("a live signed owner cannot be released and preview leaves every artifact unchanged",async()=>fixture(async f=>{
 let ready!:()=>void,release!:()=>void;const begun=new Promise<void>(r=>{ready=r;}),waiting=new Promise<void>(r=>{release=r;});
 const pending=f.reopen().start(f.request,async mark=>{await mark();ready();await waiting;return identity;});await begun;
 try{
  const before=await readFile(join(f.master,"owner.lock"),"utf8"),names=(await readdir(f.master)).sort();
  const preview=await f.reopen().ownerRecovery(f.cwd);assert.equal(preview?.ownerState,"live");assert.equal(preview?.canRelease,false);
  await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256),MasterConversationHeldError);
  assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);assert.deepEqual((await readdir(f.master)).sort(),names);
 }finally{release();await pending;}
}));

test("dead inspection before any side effect has explicit exact cleanup and idempotent same decision",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd);assert.equal(preview?.ownerState,"dead");assert.equal(preview?.canRelease,true);
 assert.equal(owner.schema,"negi-master-conversation-owner/3");assert.equal(owner.kind,"inspection");assert.equal(owner.operation.domain,"master-conversation");assert.match(owner.evidenceSha256,/^[0-9a-f]{64}$/);
 assert.equal(owner.processIdentity.platform,"windows");assert.equal(owner.processIdentity.pid,owner.pid);assert.match(owner.processIdentity.startToken,/^[1-9][0-9]{0,19}$/);
 await assert.rejects(readdir(join(f.master,"recoveries")),{code:"ENOENT"});
 const decision=randomUUID(),result=await f.reopen().releaseOwner(f.cwd,decision,preview!.proofSha256);
 assert.deepEqual(result,{decisionId:decision,requestId:owner.operation.requestId,ownerReleased:true,operationComplete:false});
 await assert.rejects(readFile(join(f.master,"owner.lock")),{code:"ENOENT"});
 const receipt=await readFile(join(f.master,"recoveries",owner.owner+".json"),"utf8");
 assert.deepEqual(await f.reopen().releaseOwner(f.cwd,decision,preview!.proofSha256),result);
 assert.equal(await readFile(join(f.master,"recoveries",owner.owner+".json"),"utf8"),receipt);
 await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256),MasterConversationHeldError);
 await f.reopen().assertStartupSafe(f.cwd);assert.equal((await f.scheduler.read()).state,null);
}));

test("historical signed owner/2 recovery preserves its version and exact original receipt bytes",async()=>fixture(async f=>{
 const current=JSON.parse(await stoppedOwner(f)),{processIdentity:_token,signature:_signature,...oldPayload}=current;
 const original=await resign(f,{...oldPayload,schema:"negi-master-conversation-owner/2"});await writeFile(join(f.master,"owner.lock"),original);
 const preview=await f.reopen().ownerRecovery(f.cwd);assert.equal(preview?.ownerState,"dead");assert.equal(preview?.canRelease,true);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),original);
 const decision=randomUUID(),result=await f.reopen().releaseOwner(f.cwd,decision,preview!.proofSha256);
 assert.equal(result.operationComplete,false);const receipt=await readFile(join(f.master,"recoveries",current.owner+".json"),"utf8"),saved=JSON.parse(receipt);
 assert.equal(JSON.stringify(saved.payload.owner)+"\n",original);assert.equal(saved.payload.owner.schema,"negi-master-conversation-owner/2");assert.equal("processIdentity" in saved.payload.owner,false);
 assert.deepEqual(await f.reopen().releaseOwner(f.cwd,decision,preview!.proofSha256),result);
 assert.equal(await readFile(join(f.master,"recoveries",current.owner+".json"),"utf8"),receipt);
}));

test("malformed signed owner/3 creation identity preserves the owner and never publishes a receipt",async()=>fixture(async f=>{
 const good=JSON.parse(await stoppedOwner(f)),bad=await resign(f,{...good,processIdentity:{...good.processIdentity,startToken:"18446744073709551616"}});
 await writeFile(join(f.master,"owner.lock"),bad);await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
 const receipt=await recoveryReceipt(f,bad,randomUUID(),"a".repeat(64));await assert.rejects(recoverWriter(f.master,"master",good.operation,hash(bad),receipt),MasterStorageHeldError);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),bad);await assert.rejects(readdir(join(f.master,"recoveries")),{code:"ENOENT"});
}));

test("pre-admission owner pins unique work ID before reserve and can be cleaned with no claim",async()=>fixture(async f=>{
 const before=await stoppedOwner(f,"admission-before"),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd);
 assert.equal(owner.kind,"turn-admission");assert.equal(owner.operation.requestId,f.request.requestId);assert.equal((await f.scheduler.read()).state,null);
 await f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256);
 const nextId=randomUUID(),lease=await f.reopen().admitTurn({cwd:f.cwd,model:"fixture",effort:"low",threadId:"old",text:"explicit input",requestId:nextId});
 assert.equal(lease.workId,"master-"+nextId);await lease.cancelBeforeDispatch();await f.reopen().assertStartupSafe(f.cwd);
}));

test("dead owner after dispatch is cleaned without changing unknown stages or admitting a new operation",async()=>fixture(async f=>{
 await stoppedOwner(f,"thread-start");const path=join(f.master,f.request.requestId),names=(await readdir(path)).sort(),records=await Promise.all(names.map(name=>readFile(join(path,name),"utf8")));
 const preview=await f.reopen().ownerRecovery(f.cwd);assert.equal(preview?.canRelease,true);
 const result=await f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256);assert.equal(result.operationComplete,false);
 assert.deepEqual((await readdir(path)).sort(),names);assert.deepEqual(await Promise.all(names.map(name=>readFile(join(path,name),"utf8"))),records);
 assert.equal((await f.reopen().status(f.request.requestId))?.stage,"start_dispatched");assert.equal((await f.reopen().status(f.request.requestId))?.exclusionHeld,false);
 await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);
 let calls=0;assert.equal((await f.reopen().start(f.request,async()=>{calls++;return identity;})).stage,"needs_reconciliation");assert.equal(calls,0);
 await assert.rejects(f.reopen().start({...f.request,requestId:randomUUID()},async()=>identity),MasterConversationHeldError);assert.equal((await f.scheduler.read()).state,null);
}));

test("queued admission after crash remains held; cleanup cannot substitute for claim reconciliation",async()=>fixture(async f=>{
 const before=await stoppedOwner(f,"admission-queued"),state=await f.scheduler.read();
 assert.equal(state.state?.entries[0].work.id,"master-"+f.request.requestId);assert.equal(state.state?.entries[0].status,"queued");
 assert.equal(state.state?.entries[0].work.masterOwner?.requestSha256,hash(await readFile(join(f.turnRoot,"master-"+f.request.requestId,"request.json"),"utf8")));
 await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);assert.deepEqual(await f.scheduler.read(),state);
}));

test("partial and legacy owners are not adopted or removed",async()=>fixture(async f=>{
 await f.reopen().assertIdle(f.cwd);
 for(const raw of ["{",bytes({schemaVersion:"negi-master-conversation-owner/1",nonce:randomUUID(),pid:999999})]){
  await writeFile(join(f.master,"owner.lock"),raw);await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
  await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),"a".repeat(64)),MasterConversationHeldError);
  assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),raw);
 }
}));

test("native boundary refuses later dead owner with same request instead of deleting by operation identity alone",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd);
 const receipt=await recoveryReceipt(f,before,randomUUID(),preview!.proofSha256),replacement=await resign(f,{...owner,owner:randomUUID()});
 await writeFile(join(f.master,"owner.lock"),replacement);
 await assert.rejects(recoverWriter(f.master,"master",owner.operation,hash(before),receipt),MasterStorageHeldError);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),replacement);
}));

test("legacy reused live PID, owner signature edits and hardlinked owner all preserve the hold",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),path=join(f.master,"owner.lock");
 const {processIdentity:_token,...legacy}=owner;
 await writeFile(path,await resign(f,{...legacy,schema:"negi-master-conversation-owner/2",pid:process.pid}));const reused=await f.reopen().ownerRecovery(f.cwd);
 assert.equal(reused?.ownerState,"live");await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),reused!.proofSha256),MasterConversationHeldError);
 await writeFile(path,bytes({...owner,kind:"thread-start"}));await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
 await writeFile(path,before);await link(path,join(f.dir,"linked-owner"));await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
 await unlink(join(f.dir,"linked-owner"));assert.equal((await f.reopen().ownerRecovery(f.cwd))?.canRelease,true);
}));

test("simulated owner/3 PID reuse releases only the recorded owner and leaves the live process intact",async()=>fixture(async f=>{
 const old=JSON.parse(await stoppedOwner(f)),inventory=new MasterConversationInventory({root:f.root,masterId:"master"}),live=await inventory.currentProcessIdentity();
 assert.notEqual(live.startToken,old.processIdentity.startToken);
 const reused=await resign(f,{...old,pid:live.pid,processIdentity:{...old.processIdentity,pid:live.pid}});await writeFile(join(f.master,"owner.lock"),reused);
 const preview=await f.reopen().ownerRecovery(f.cwd);assert.equal(preview?.ownerState,"dead");assert.equal(preview?.canRelease,true);
 await f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256);
 assert.deepEqual(await inventory.currentProcessIdentity(),live);
 const receipt=JSON.parse(await readFile(join(f.master,"recoveries",old.owner+".json"),"utf8"));
 assert.equal(JSON.stringify(receipt.payload.owner)+"\n",reused);
 await assert.rejects(readFile(join(f.master,"owner.lock")),{code:"ENOENT"});
}));

test("changed terminal evidence or removed target directory never becomes a releasable dead owner",async()=>fixture(async f=>{
 const lease=await scheduledMasterTurns({root:f.turnRoot,masterId:"master",scheduler:f.scheduler}).reserve({cwd:f.cwd,model:"fixture",effort:"low",threadId:"old",text:"known"});
 await lease.dispatching();await lease.bind("turn");await lease.complete({turnId:"turn",status:"completed",finalText:"known",contextInputTokens:null,contextWindow:null,lastUsage:null});
 const before=await stoppedOwner(f),path=join(f.turnRoot,lease.workId,"outcome.json"),original=await readFile(path,"utf8");
 await writeFile(path,bytes({...JSON.parse(original),finalText:"edited"}));await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
}));

test("missing target for a thread owner cannot hide a dispatched transaction",async()=>fixture(async f=>{
 const before=await stoppedOwner(f,"thread-start");await rm(join(f.master,f.request.requestId),{recursive:true,force:true});
 await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
}));

test("partial or conflicting immutable recovery receipt is retained and never overwritten",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd),root=join(f.master,"recoveries");
 await mkdir(root);const path=join(root,owner.owner+".json");await writeFile(path,"{");
 await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256),MasterConversationHeldError);
 assert.equal(await readFile(path,"utf8"),"{");assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
 await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);
}));

test("stale proof and wrong checkout make no recovery decision",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),other=join(f.dir,"other");await mkdir(other);
 await assert.rejects(f.reopen().ownerRecovery(other),MasterConversationHeldError);
 await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),"a".repeat(64)),MasterConversationHeldError);
 await assert.rejects(readdir(join(f.master,"recoveries")),{code:"ENOENT"});assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
}));

test("ordinary Sol progress does not change a current Master recovery proof",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration();
 const id="master-"+randomUUID();await f.scheduler.append({key:"ordinary",at:new Date().toISOString(),action:{type:"submit",work:{id,parentId:null,dependencies:[],role:"sol",checkout:f.cwd,checkoutMode:"write",resources:[],reserveUsd:0}}});
 await stoppedOwner(f);const preview=await f.reopen().ownerRecovery(f.cwd);
 await f.scheduler.claim(id,"ordinary-claim");await f.scheduler.append({key:"ordinary-result",at:new Date().toISOString(),action:{type:"settle",workId:id,outcome:"verified",evidenceRef:"fixture:known",actualCostUsd:null}});
 assert.equal((await f.reopen().ownerRecovery(f.cwd))?.proofSha256,preview!.proofSha256);
 const before=await readFile(f.scheduler.path,"utf8");await f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256);assert.equal(await readFile(f.scheduler.path,"utf8"),before);
}));

test("native master deletion requires exact bytes even for a valid operation identity",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before);
 await assert.rejects(recoverWriter(f.master,"master",owner.operation),/exact owner bytes/);
 assert.equal((await observeWriter(f.master,"master")).sha256,hash(before));assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
}));

test("turn admission before writing records binds the canonical checkout",async()=>fixture(async f=>{
 const before=await stoppedOwner(f,"admission-before"),other=join(f.dir,"other");await mkdir(other);
 await assert.rejects(f.reopen().ownerRecovery(other),MasterConversationHeldError);
 const preview=await f.reopen().ownerRecovery(f.cwd);await f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256);
 assert.equal(JSON.parse(before).cwdSha256,hash(f.cwd));
}));

test("completed target admission still needs separate reconciliation and cannot hide behind idle",async()=>fixture(async f=>{
 const before=await stoppedOwner(f,"admission-queued"),workId="master-"+f.request.requestId;
 await f.scheduler.append({key:"fixture-cancel",at:new Date().toISOString(),action:{type:"cancel_queued",workId,reason:"fixture separate reconciliation"}});
 await assert.rejects(f.reopen().ownerRecovery(f.cwd),MasterConversationHeldError);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
}));

test("an old decision ID cannot append a duplicate or poison the recovery inventory",async()=>fixture(async f=>{
 await stoppedOwner(f);const first=await f.reopen().ownerRecovery(f.cwd),decisionId=randomUUID();
 await f.reopen().releaseOwner(f.cwd,decisionId,first!.proofSha256);
 const names=await readdir(join(f.master,"recoveries")),before=await stoppedOwner(f),second=await f.reopen().ownerRecovery(f.cwd);
 await assert.rejects(f.reopen().releaseOwner(f.cwd,decisionId,second!.proofSha256),MasterConversationHeldError);
 assert.deepEqual(await readdir(join(f.master,"recoveries")),names);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
 await f.reopen().releaseOwner(f.cwd,randomUUID(),second!.proofSha256);await f.reopen().assertStartupSafe(f.cwd);
}));

for(const phase of ["partial","published","removed"] as const)test(`native process exit after receipt ${phase} retries only the exact decision`,async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd),decisionId=randomUUID();
 const receipt=await recoveryReceipt(f,before,decisionId,preview!.proofSha256);await nativeRecoveryCrash(f,before,receipt,phase);
 const root=join(f.master,"recoveries");
 if(phase!=="removed"){
  assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
  assert.equal((await f.reopen().ownerRecovery(f.cwd))?.proofSha256,preview!.proofSha256);
  await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256),MasterConversationHeldError);
 }else await assert.rejects(readFile(join(f.master,"owner.lock")),{code:"ENOENT"});
 if(phase==="partial"){
  assert.equal((await readFile(join(root,`.pending-${owner.owner}-${decisionId}.json`))).length,Math.floor(Buffer.byteLength(receipt)/2));
  // A staging record alone also holds ordinary startup; only exact-owner recovery accepts it.
  const savedOwner=join(f.dir,"fixture-owner");await rename(join(f.master,"owner.lock"),savedOwner);
  await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);await rename(savedOwner,join(f.master,"owner.lock"));
 }
 else assert.equal(await readFile(join(root,owner.owner+".json"),"utf8"),receipt);
 await f.reopen().releaseOwner(f.cwd,decisionId,preview!.proofSha256);await f.reopen().releaseOwner(f.cwd,decisionId,preview!.proofSha256);
 assert.deepEqual(await readdir(root),[owner.owner+".json"]);await f.reopen().assertStartupSafe(f.cwd);
 if(phase!=="partial")assert.equal(await readFile(join(root,owner.owner+".json"),"utf8"),receipt);
}));

test("a matching owner still cannot be removed without its signed decision",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before);
 await assert.rejects(recoverWriter(f.master,"master",owner.operation,hash(before)),/signed receipt/);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
 await assert.rejects(readdir(join(f.master,"recoveries")),{code:"ENOENT"});
}));

test("parallel different decisions publish at most one receipt and never remove a later owner",async()=>fixture(async f=>{
 await stoppedOwner(f);const preview=await f.reopen().ownerRecovery(f.cwd),decisions=[randomUUID(),randomUUID()];
 const results=await Promise.allSettled(decisions.map(id=>f.reopen().releaseOwner(f.cwd,id,preview!.proofSha256)));
 const names=await readdir(join(f.master,"recoveries"));assert.equal(names.length,1);
 const accepted=JSON.parse(await readFile(join(f.master,"recoveries",names[0]!),"utf8")).payload.decisionId;
 assert.ok(decisions.includes(accepted));assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
 await f.reopen().releaseOwner(f.cwd,accepted,preview!.proofSha256);await f.reopen().assertStartupSafe(f.cwd);
}));

test("a new owner appearing after native release stays in place and prevents success",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),processIdentity=await new MasterConversationInventory({root:f.root,masterId:"master"}).currentProcessIdentity();
 const replacement=await resign(f,{...JSON.parse(before),owner:randomUUID(),pid:process.pid,processIdentity}),path=join(f.master,"owner.lock");
 const authority=f.reopen(),preview=await authority.ownerRecovery(f.cwd);
 const methods=authority as unknown as {ownerRecoveryEvidence:(...args:unknown[])=>Promise<unknown>};
 const original=methods.ownerRecoveryEvidence.bind(authority);
 methods.ownerRecoveryEvidence=async(...args)=>{
  try{await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await writeFile(path,replacement,{flag:"wx"});}
  return original(...args);
 };
 await assert.rejects(authority.releaseOwner(f.cwd,randomUUID(),preview!.proofSha256),MasterConversationHeldError);
 assert.equal(await readFile(path,"utf8"),replacement);assert.equal((await f.reopen().ownerRecovery(f.cwd))?.ownerState,"live");
}));

test("native Master root must match the signed owner even with exact owner bytes",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd),other=join(f.root,"masters","other");await mkdir(other);
 await writeFile(join(other,"owner.lock"),before);
 const receipt=await recoveryReceipt(f,before,randomUUID(),preview!.proofSha256);
 await assert.rejects(recoverWriter(other,"master",owner.operation,hash(before),receipt),/exact owner and decision/);
 assert.equal(await readFile(join(other,"owner.lock"),"utf8"),before);await assert.rejects(readdir(join(other,"recoveries")),{code:"ENOENT"});
}));

test("an exact saved decision remains readable after later terminal or unknown work",async()=>fixture(async f=>{
 await stoppedOwner(f);const authority=f.reopen(),preview=await authority.ownerRecovery(f.cwd),decisionId=randomUUID();
 await authority.releaseOwner(f.cwd,decisionId,preview!.proofSha256);
 const lease=await authority.admitTurn({cwd:f.cwd,model:"fixture",effort:"low",threadId:"old",text:"later",requestId:randomUUID()});await lease.cancelBeforeDispatch();
 let callbacks=0;await authority.start(f.request,async mark=>{await mark();callbacks++;return identity;});
 const result=await authority.releaseOwner(f.cwd,decisionId,preview!.proofSha256);assert.equal(result.ownerReleased,true);assert.equal(callbacks,1);
 const later=await authority.admitTurn({cwd:f.cwd,model:"fixture",effort:"low",threadId:"new",text:"later unknown",requestId:randomUUID()});await later.dispatching();await later.unknown("fixture lost response");
 const before=await f.scheduler.read();await authority.releaseOwner(f.cwd,decisionId,preview!.proofSha256);assert.deepEqual(await f.scheduler.read(),before);
 await assert.rejects(authority.assertStartupSafe(f.cwd),MasterConversationHeldError);
}));

test("valid long UTF8 cwd never expands a recovery receipt beyond the bound",async()=>fixture(async f=>{
 const cwd=join(f.dir,...Array.from({length:20},()=>"界".repeat(140)));await mkdir(cwd,{recursive:true});assert.ok(Buffer.byteLength(cwd)>8000);
 const longFixture={...f,cwd},before=await stoppedOwner(longFixture,"admission-before"),preview=await f.reopen().ownerRecovery(cwd),decisionId=randomUUID();
 await f.reopen().releaseOwner(cwd,decisionId,preview!.proofSha256);await f.reopen().releaseOwner(cwd,decisionId,preview!.proofSha256);
 const receipt=await readFile(join(f.master,"recoveries",JSON.parse(before).owner+".json"),"utf8");
 assert.ok(Buffer.byteLength(receipt)<2000);assert.equal(JSON.parse(receipt).payload.cwdSha256,hash(cwd));assert.equal("cwd" in JSON.parse(receipt).payload,false);
}));

nativeTest("Linux Master deletion rejects before any guard, receipt or pathname mutation",async()=>fixture(async f=>{
 await stoppedOwner(f);const before=await readFile(join(f.master,"owner.lock"),"utf8"),names=await readdir(f.master),scriptPath=join(process.cwd(),"scripts/negi_recover_writer.py");
 const script=`import importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('native',${JSON.stringify(scriptPath)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\ntry:\n m.recover_linux(Path(${JSON.stringify(f.master)}),'master','master-conversation','unused','unused')\nexcept ValueError as error:\n assert 'unsupported on Linux' in str(error)\nelse:\n raise AssertionError('unsafe deletion was allowed')\n`;
 const child=spawn("python",["-c",script],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});assert.equal(code,0,stderr);
 assert.deepEqual(await readdir(f.master),names);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
}));

nativeTest("non-Windows authority preview diagnoses a dead owner and preserves the unsupported hold",{skip:process.platform==="win32"},async()=>fixture(async f=>{
 const before=await stoppedOwner(f),names=await readdir(f.master),preview=await f.reopen().ownerRecovery(f.cwd);
 assert.equal(preview?.ownerState,"dead");assert.equal(preview?.canRelease,false);assert.match(preview!.reason!,/このOS.*解除.*保持/);
 await assert.rejects(f.reopen().releaseOwner(f.cwd,randomUUID(),preview!.proofSha256),MasterConversationHeldError);
 assert.deepEqual(await readdir(f.master),names);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);
 await assert.rejects(readdir(join(f.master,"recoveries")),{code:"ENOENT"});
}));

nativeTest("native receipt capacity reserves new entries and accepts exact retry at the boundary",async()=>{
 const scriptPath=join(process.cwd(),"scripts/negi_recover_writer.py"),script=`import importlib.util\nspec=importlib.util.spec_from_file_location('native',${JSON.stringify(scriptPath)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nnames=[str(i)+'.json' for i in range(9999)]\nm.receipt_names(names,'pending','final')\nfor entries in [names+['last.json'],names+['last.json','extra.json']]:\n try:\n  m.receipt_names(entries,'pending','final')\n except ValueError:\n  pass\n else:\n  raise AssertionError('new receipt crossed cap')\nm.receipt_names(names+['final'],'pending','final')\nm.receipt_names(names+['pending'],'pending','final')\n`;
 const child=spawn("python",["-c",script],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});assert.equal(code,0,stderr);
});

test("the native guard rejects a newly full inventory before publishing or unlinking",async()=>fixture(async f=>{
 const before=await stoppedOwner(f),owner=JSON.parse(before),preview=await f.reopen().ownerRecovery(f.cwd),receipt=await recoveryReceipt(f,before,randomUUID(),preview!.proofSha256);
 const scriptPath=join(process.cwd(),"scripts/negi_recover_writer.py"),script=`import importlib.util,os\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('native',${JSON.stringify(scriptPath)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\noriginal=os.listdir\ndef listed(path):\n return [str(i)+'.json' for i in range(10000)] if os.fspath(path)==${JSON.stringify(join(f.master,"recoveries"))} else original(path)\nos.listdir=listed\ntry:\n m.recover_windows(Path(${JSON.stringify(f.master)}),'master','master-conversation',${JSON.stringify(owner.operation.requestId)},${JSON.stringify(owner.operation.hash)},${JSON.stringify(hash(before))},${JSON.stringify(receipt)})\nexcept ValueError as error:\n assert 'No capacity' in str(error)\nelse:\n raise AssertionError('capacity overflow deleted owner')\n`;
 const child=spawn("python",["-c",script],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});assert.equal(code,0,stderr);
 assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),before);assert.deepEqual(await readdir(join(f.master,"recoveries")),[]);
}));
