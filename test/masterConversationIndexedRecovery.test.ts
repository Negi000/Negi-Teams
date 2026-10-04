import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as nativeTest } from "node:test";
import { pathToFileURL } from "node:url";
import { MasterConversationAuthority, MasterConversationHeldError, type MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { signedMasterOwner } from "../src/server/orchestration/masterConversationOwner.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const hash=(raw:string)=>createHash("sha256").update(raw).digest("hex");
const test=(name:string,run:()=>Promise<void>)=>nativeTest(name,{skip:process.platform!=="win32"},run);
type Kind="thread-start"|"inspection"|"turn-admission";
interface F {dir:string;cwd:string;root:string;master:string;turnRoot:string;scheduler:FileScheduler;inventory:MasterConversationInventory;
  authority:MasterConversationAuthority;legacy:MasterConversationAuthority;request:MasterConversationRequest;owner:string;decisionId:string;proof:string}
async function stoppedOwner(f:Omit<F,"owner"|"proof"|"decisionId">,kind:Kind){
  const modules=resolve("src/server/orchestration"), code="import {readFile} from 'node:fs/promises';import {MasterConversationAuthority} from "+JSON.stringify(pathToFileURL(join(modules,"masterConversations.ts")).href)+
    ";import {FileScheduler} from "+JSON.stringify(pathToFileURL(join(modules,"scheduler.ts")).href)+
    ";let text='';for await(const part of process.stdin)text+=part;const q=JSON.parse(text),s=new FileScheduler(q.scheduler);const read=s.read.bind(s);"+
    (kind==="thread-start"?"":"s.read=async()=>{try{await readFile(q.owner);}catch(error){if(error.code==='ENOENT')return read();throw error;}process.exit(23);};")+
    "const a=new MasterConversationAuthority({root:q.root,turnRoot:q.turnRoot,masterId:'master',scheduler:s,stageStorage:'indexed'});"+
    (kind==="thread-start"?"await a.start(q.request,async mark=>{await mark();process.exit(23);});":kind==="inspection"?"await a.assertIdle(q.cwd);":"await a.admitTurn({cwd:q.cwd,requestId:q.request.requestId,model:'fixture',effort:'low',threadId:'old',text:'fixture input'});");
  const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{windowsHide:true,stdio:["pipe","ignore","pipe"]});
  let stderr="";child.stderr.on("data",p=>stderr+=p);
  const closed=new Promise<number|null>((accept,reject)=>{child.once("close",accept);child.once("error",reject)}),timer=setTimeout(()=>child.kill(),90000);
  child.stdin.end(JSON.stringify({root:f.root,turnRoot:f.turnRoot,scheduler:f.scheduler.path,owner:join(f.master,"owner.lock"),request:f.request,cwd:f.cwd}));
  try{assert.equal(await closed,23,stderr)}finally{clearTimeout(timer);child.kill();await closed}
  return readFile(join(f.master,"owner.lock"),"utf8");
}
async function fixture(kind:Kind,run:(f:F)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"negi-authority-indexed-recovery-")),cwd=join(dir,"checkout"),root=join(dir,"authority"),master=join(root,"masters","master"),turnRoot=join(dir,"turns");
  await mkdir(cwd);const scheduler=new FileScheduler(join(dir,"scheduler.jsonl")),legacy=new MasterConversationAuthority({root,turnRoot,masterId:"master",scheduler});
  const inventory=new MasterConversationInventory({root,masterId:"master",recoveryContext:{turnRoot,schedulerPath:scheduler.path}}),authority=new MasterConversationAuthority({root,turnRoot,masterId:"master",scheduler,stageStorage:"indexed"});
  const request:MasterConversationRequest={requestId:randomUUID(),masterId:"master",mode:"rotate",oldThreadId:"old",cwd,model:"fixture",effort:"low",provider:"fixture",settingsSha256:"a".repeat(64)};
  const base={dir,cwd,root,master,turnRoot,scheduler,legacy,inventory,authority,request};
  try{
    await legacy.assertIdle(cwd);await inventory.initialize();const owner=await stoppedOwner(base,kind),preview=await authority.ownerRecovery(cwd);
    assert.equal(preview?.ownerState,"dead");assert.equal(preview?.canRelease,true);assert.equal(preview?.recoveryState,"not_confirmed");
    await run({...base,owner,proof:preview!.proofSha256,decisionId:randomUUID()});
  }finally{assert.ok(resolve(root).startsWith(resolve(dir)+"\\"));await rm(dir,{recursive:true,force:true})}
}
const release=(f:F)=>f.authority.releaseOwner(f.cwd,f.decisionId,f.proof);

for(const kind of ["thread-start","inspection","turn-admission"] as const)test("indexed authority recovers "+kind+" with the same signed decision and no model operation",async()=>fixture(kind,async f=>{
  const owner=JSON.parse(f.owner);assert.equal(owner.schema,"negi-master-conversation-owner/4");assert.deepEqual(owner.indexed.head,{seq:0,sha256:"0".repeat(64)});
  assert.equal(owner.indexed.contextSha256,hash(JSON.stringify({turnRoot:f.turnRoot,schedulerPath:f.scheduler.path})));
  const database=await readFile(f.inventory.databasePath);assert.equal(await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId),null);assert.deepEqual(await readFile(f.inventory.databasePath),database);
  assert.equal((await f.legacy.ownerRecovery(f.cwd))?.canRelease,false);await assert.rejects(f.legacy.releaseOwner(f.cwd,f.decisionId,f.proof),MasterConversationHeldError);
  await assert.rejects(f.legacy.ownerRecoveryStatus(f.cwd,f.decisionId),MasterConversationHeldError);
  const result=await release(f);assert.deepEqual(result,{decisionId:f.decisionId,requestId:JSON.parse(f.owner).operation.requestId,ownerReleased:true,operationComplete:false});
  const saved=await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId);assert.equal(saved?.state,"owner_released");assert.equal(saved?.ownerSha256,hash(f.owner));assert.equal(saved?.operationComplete,false);
  assert.equal(await f.authority.ownerRecovery(f.cwd),null);await assert.rejects(lstat(join(f.master,"owner.lock")),{code:"ENOENT"});
  const receipt=(await f.inventory.recoveryIntent(f.decisionId)).receipt!;assert.equal((await f.inventory.ownerRecoveryIntent(JSON.parse(f.owner).owner)).origin,"live");
  const after=await readFile(f.inventory.databasePath);await f.scheduler.ensureSubscriptionConfiguration();const scheduler=await readFile(f.scheduler.path);
  assert.deepEqual(await release(f),result);assert.deepEqual(await readFile(f.scheduler.path),scheduler);assert.deepEqual(await readFile(f.inventory.databasePath),after);
  assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes,receipt.bytes);
  if(kind==="thread-start"){
    let calls=0;assert.equal((await f.authority.start(f.request,async()=>{calls++;throw Error("must not replay")})).stage,"needs_reconciliation");assert.equal(calls,0);
  }else{await f.authority.assertIdle(f.cwd);await assert.rejects(lstat(f.turnRoot),{code:"ENOENT"});}
}));

for(const at of ["intent","native"] as const)test("authority reconnect reads the original "+at+" ACK without creating a new receipt",async()=>fixture("thread-start",async f=>{
  const originalAppend=MasterConversationInventory.prototype.appendRecoveryIntent,originalRelease=MasterConversationInventory.prototype.releaseRecoveryIntent;
  try{
    if(at==="intent")MasterConversationInventory.prototype.appendRecoveryIntent=async function(input){await originalAppend.call(this,input);throw Error("lost intent ACK")};
    else MasterConversationInventory.prototype.releaseRecoveryIntent=async function(input){await originalRelease.call(this,input);throw Error("lost native ACK")};
    await assert.rejects(release(f),MasterConversationHeldError);
  }finally{MasterConversationInventory.prototype.appendRecoveryIntent=originalAppend;MasterConversationInventory.prototype.releaseRecoveryIntent=originalRelease}
  const receipt=(await f.inventory.recoveryIntent(f.decisionId)).receipt!,database=await readFile(f.inventory.databasePath);
  const status=await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId);assert.equal(status?.state,at==="intent"?"intent_saved":"owner_released");
  assert.deepEqual(await readFile(f.inventory.databasePath),database);
  if(at==="intent"){
    const preview=await f.authority.ownerRecovery(f.cwd);assert.equal(preview?.recoveryDecisionId,f.decisionId);assert.equal(preview?.recoveryState,"intent_saved");assert.equal(preview?.canRelease,true);
    await assert.rejects(f.authority.releaseOwner(f.cwd,randomUUID(),f.proof),MasterConversationHeldError);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),f.owner);
  }
  await release(f);assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes,receipt.bytes);assert.deepEqual(await readFile(f.inventory.databasePath),database);
}));

for(const phase of ["partial","published"] as const)test("actual native exit at "+phase+" reconnects through authority using only the committed UUID",async()=>fixture("thread-start",async f=>{
  const original=childProcess.spawn;
  const hook="import sys,os\nsys.path.insert(0,sys.argv[1])\nimport negi_master_conversation_inventory as m\nimport negi_recover_writer as n\n"+
    (phase==="partial"?"original=n.windows_kernel\nclass Proxy:\n def __init__(self,k):self.k=k\n def __getattr__(self,key):return getattr(self.k,key)\n def WriteFile(self,h,p,size,count,o):\n  self.k.WriteFile(h,p,size//2,count,o);os._exit(29)\nn.windows_kernel=lambda:Proxy(original())\n":
      "original=n._publish_receipt_windows\ndef stopped(*args,**kwargs):\n original(*args,**kwargs);os._exit(29)\nn._publish_receipt_windows=stopped\n")+"m.main()\n";
  const originalRelease=MasterConversationInventory.prototype.releaseRecoveryIntent;
  try{
    MasterConversationInventory.prototype.releaseRecoveryIntent=async function(input){
      childProcess.spawn=((binary,args,options)=>binary==="python"&&Array.isArray(args)&&typeof args[1]==="string"&&args[1].endsWith("negi_master_conversation_inventory.py")?
        original(binary,["-B","-c",hook,dirname(args[1])],options):original(binary,args,options)) as typeof spawn;syncBuiltinESMExports();
      return originalRelease.call(this,input);
    };
    await assert.rejects(release(f),MasterConversationHeldError);
  }finally{MasterConversationInventory.prototype.releaseRecoveryIntent=originalRelease;childProcess.spawn=original;syncBuiltinESMExports()}
  const receipt=(await f.inventory.recoveryIntent(f.decisionId)).receipt!,preview=await f.authority.ownerRecovery(f.cwd);
  assert.equal(preview?.recoveryDecisionId,f.decisionId);assert.equal(preview?.recoveryState,phase==="partial"?"intent_saved":"receipt_published");assert.equal(preview?.canRelease,true);
  assert.equal((await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId))?.state,phase==="partial"?"intent_saved":"receipt_published");
  await release(f);assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes,receipt.bytes);assert.deepEqual(await readdir(join(f.master,"recoveries")),[JSON.parse(f.owner).owner+".json"]);
}));

test("historical adopted receipt ACK stays readable without enabling an imported native release",async()=>fixture("thread-start",async f=>{
  // Construct historical owner/3 evidence. Production cannot downgrade owner/4.
  const {indexed:_baseline,signature:_oldSignature,...historical}=JSON.parse(f.owner);historical.schema="negi-master-conversation-owner/3";
  const key=Buffer.from(JSON.parse(await readFile(join(f.root,"signing-key.json"),"utf8")).key,"hex"),historicalOwner=signedMasterOwner(historical,key);
  await writeFile(join(f.master,"owner.lock"),historicalOwner);
  await unlink(f.inventory.databasePath);const preview=await f.legacy.ownerRecovery(f.cwd);assert.equal(preview?.canRelease,true);
  const result=await f.legacy.releaseOwner(f.cwd,f.decisionId,preview!.proofSha256),receipt=await readFile(join(f.master,"recoveries",JSON.parse(f.owner).owner+".json"),"utf8");
  const migration=await f.inventory.previewLegacyMigration();await f.inventory.migrateLegacy({decisionId:randomUUID(),expectedProofSha256:migration.proofSha256});
  assert.equal((await f.inventory.ownerRecoveryIntent(JSON.parse(f.owner).owner)).origin,"adopted");
  const database=await readFile(f.inventory.databasePath);assert.deepEqual(await f.authority.releaseOwner(f.cwd,f.decisionId,preview!.proofSha256),result);
  assert.equal((await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId))?.state,"owner_released");assert.deepEqual(await readFile(f.inventory.databasePath),database);
  assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes,receipt);
  await writeFile(join(f.master,"owner.lock"),historicalOwner);assert.equal((await f.authority.ownerRecovery(f.cwd))?.canRelease,false);
  await assert.rejects(release(f),MasterConversationHeldError);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),historicalOwner);
}));

test("a later owner is preserved and a historical decision does not authorize deleting it",async()=>fixture("inspection",async f=>{
  await release(f);const later=await stoppedOwner(f,"inspection"),database=await readFile(f.inventory.databasePath);
  assert.equal((await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId))?.state,"different_owner");
  await assert.rejects(release(f),MasterConversationHeldError);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),later);assert.deepEqual(await readFile(f.inventory.databasePath),database);
}));

test("missing authority key or database is a hold and is never bootstrapped by recovery preview/status",async()=>{
  for(const missing of ["root","key","database"])await fixture("inspection",async f=>{
    if(missing==="root")await rm(f.root,{recursive:true});else await unlink(missing==="key"?join(f.root,"signing-key.json"):f.inventory.databasePath);
    await assert.rejects(f.authority.ownerRecovery(f.cwd),MasterConversationHeldError);await assert.rejects(f.authority.ownerRecoveryStatus(f.cwd,f.decisionId),MasterConversationHeldError);
    await assert.rejects(release(f),MasterConversationHeldError);
    await assert.rejects(lstat(missing==="root"?f.root:missing==="key"?join(f.root,"signing-key.json"):f.inventory.databasePath),{code:"ENOENT"});
  });
});

test("foreign scheduler lock, stale proof and a different checkout never write a recovery decision",async()=>fixture("inspection",async f=>{
  const database=await readFile(f.inventory.databasePath),lock=f.scheduler.path+".lock";await writeFile(lock,"foreign writer",{flag:"wx"});
  await assert.rejects(release(f),MasterConversationHeldError);assert.equal(await readFile(lock,"utf8"),"foreign writer");await unlink(lock);
  await assert.rejects(f.authority.releaseOwner(f.cwd,f.decisionId,"b".repeat(64)),MasterConversationHeldError);
  const other=join(f.dir,"other-checkout");await mkdir(other);await assert.rejects(f.authority.releaseOwner(other,f.decisionId,f.proof),MasterConversationHeldError);
  assert.deepEqual(await readFile(f.inventory.databasePath),database);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),f.owner);await assert.rejects(lstat(join(f.master,"recoveries")),{code:"ENOENT"});
}));

test("fixed server registration survives caller mutation and rejects a changed scheduler path",async()=>fixture("inspection",async f=>{
  const options={root:f.root,turnRoot:f.turnRoot,masterId:"master",scheduler:f.scheduler,stageStorage:"indexed" as const},authority=new MasterConversationAuthority(options);
  options.root=join(f.dir,"wrong-root");options.turnRoot=join(f.dir,"wrong-turns");options.masterId="wrong-master";
  assert.equal((await authority.ownerRecovery(f.cwd))?.canRelease,true);
  const path=f.scheduler.path;(f.scheduler as unknown as {path:string}).path=join(f.dir,"wrong-scheduler.jsonl");
  await assert.rejects(authority.ownerRecovery(f.cwd),MasterConversationHeldError);await assert.rejects(authority.releaseOwner(f.cwd,f.decisionId,f.proof),MasterConversationHeldError);
  (f.scheduler as unknown as {path:string}).path=path;await authority.releaseOwner(f.cwd,f.decisionId,f.proof);await assert.rejects(lstat(options.root),{code:"ENOENT"});
}));

test("an admission target appearing after its owner preview prevents recovery",async()=>fixture("turn-admission",async f=>{
  const database=await readFile(f.inventory.databasePath);await mkdir(join(f.turnRoot,"master-"+f.request.requestId),{recursive:true});
  await assert.rejects(release(f),MasterConversationHeldError);assert.deepEqual(await readFile(f.inventory.databasePath),database);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),f.owner);
}));

test("an unrelated missing receipt is storage_pending in both preview and saved-decision status",async()=>fixture("inspection",async f=>{
  await release(f);const historical=(await f.inventory.recoveryIntent(f.decisionId)).receipt!;
  const later=await stoppedOwner(f,"inspection"),preview=await f.authority.ownerRecovery(f.cwd),decisionId=randomUUID();assert.equal(preview?.canRelease,true);
  const original=MasterConversationInventory.prototype.releaseRecoveryIntent;
  try{
    MasterConversationInventory.prototype.releaseRecoveryIntent=async()=>{throw Error("stopped after intent")};
    await assert.rejects(f.authority.releaseOwner(f.cwd,decisionId,preview!.proofSha256),MasterConversationHeldError);
  }finally{MasterConversationInventory.prototype.releaseRecoveryIntent=original}
  const current=(await f.inventory.recoveryIntent(decisionId)).receipt!;
  // Construct the exact post-publication fixture; actual native exits are covered above.
  await writeFile(join(f.master,current.relativePath),current.bytes,{flag:"wx"});await unlink(join(f.master,historical.relativePath));
  const database=await readFile(f.inventory.databasePath),held=await f.authority.ownerRecovery(f.cwd),status=await f.authority.ownerRecoveryStatus(f.cwd,decisionId);
  assert.equal(held?.canRelease,false);assert.equal(held?.recoveryDecisionId,decisionId);assert.equal(held?.recoveryState,"storage_pending");
  assert.equal(status?.state,"storage_pending");assert.equal(status?.ownerReleased,false);
  await assert.rejects(f.authority.releaseOwner(f.cwd,decisionId,preview!.proofSha256),MasterConversationHeldError);
  assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),later);assert.deepEqual(await readFile(f.inventory.databasePath),database);
  await writeFile(join(f.master,historical.relativePath),historical.bytes,{flag:"wx"}); // Fixture restoration, no product repair API.
  assert.equal((await f.authority.ownerRecovery(f.cwd))?.recoveryState,"receipt_published");assert.equal((await f.authority.ownerRecoveryStatus(f.cwd,decisionId))?.state,"receipt_published");
  await f.authority.releaseOwner(f.cwd,decisionId,preview!.proofSha256);
}));

test("owner acquisition anchors reject a future head, a changed prefix, another context and an unsigned change",async()=>fixture("inspection",async f=>{
  await release(f);const original=await stoppedOwner(f,"inspection"),base=JSON.parse(original);
  assert.equal(base.indexed.head.seq,1);assert.deepEqual((await f.inventory.ownerBaseline(hash(original))).head,base.indexed.head);
  const key=Buffer.from(JSON.parse(await readFile(join(f.root,"signing-key.json"),"utf8")).key,"hex"),database=await readFile(f.inventory.databasePath);
  for(const kind of ["future","prefix","context","unsigned"]){
    const row=structuredClone(base);
    if(kind==="future")row.indexed.head.seq++;
    else if(kind==="prefix")row.indexed.head.sha256="b".repeat(64);
    else row.indexed.contextSha256="c".repeat(64);
    const {signature:_signature,...payload}=row,corrupt=kind==="unsigned"?JSON.stringify(row)+"\n":signedMasterOwner(payload,key);
    await writeFile(join(f.master,"owner.lock"),corrupt);
    await assert.rejects(f.inventory.ownerBaseline(hash(corrupt)),kind==="future"?/ahead/:kind==="prefix"?/prefix changed/:kind==="context"?/context changed/:/HMAC/);
    await assert.rejects(f.authority.ownerRecovery(f.cwd),MasterConversationHeldError);
    assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),corrupt);assert.deepEqual(await readFile(f.inventory.databasePath),database);
  }
  await writeFile(join(f.master,"owner.lock"),original);assert.equal((await f.authority.ownerRecovery(f.cwd))?.canRelease,true);
}));

test("a separately authenticated operation after the acquisition head is not normalized into this owner",async()=>fixture("inspection",async f=>{
  // Fixture replacement creates valid other-writer history, then restores the stopped owner.
  await unlink(join(f.master,"owner.lock"));
  const request={...f.request,requestId:randomUUID()};
  assert.equal((await f.authority.start(request,async mark=>{await mark();return {threadId:"other-fixture",requestedModel:"fixture",resolvedModel:"fixture",modelProvider:"fixture",rerouted:false}})).stage,"completed");
  await writeFile(join(f.master,"owner.lock"),f.owner,{flag:"wx"});const database=await readFile(f.inventory.databasePath);
  await assert.rejects(f.inventory.ownerBaseline(hash(f.owner)),/another writer/);await assert.rejects(f.inventory.audit(),/another writer/);
  await assert.rejects(f.authority.ownerRecovery(f.cwd),MasterConversationHeldError);await assert.rejects(release(f),MasterConversationHeldError);
  assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),f.owner);assert.deepEqual(await readFile(f.inventory.databasePath),database);
}));

test("historical indexed receipt keeps its original acquisition prefix after a later indexed operation",async()=>fixture("inspection",async f=>{
  const result=await release(f),receipt=(await f.inventory.recoveryIntent(f.decisionId)).receipt!;
  const request={...f.request,requestId:randomUUID()};
  assert.equal((await f.authority.start(request,async mark=>{await mark();return {threadId:"later-fixture",requestedModel:"fixture",resolvedModel:"fixture",modelProvider:"fixture",rerouted:false}})).stage,"completed");
  assert.equal((await f.inventory.audit()).head.seq,6);const database=await readFile(f.inventory.databasePath);
  assert.equal((await f.authority.ownerRecoveryStatus(f.cwd,f.decisionId))?.state,"owner_released");assert.deepEqual(await release(f),result);
  assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes,receipt.bytes);assert.deepEqual(await readFile(f.inventory.databasePath),database);
}));

test("a missing index cannot downgrade an indexed owner or receipt to legacy recovery or adoption",async()=>{
  await fixture("inspection",async f=>{
    await unlink(f.inventory.databasePath);assert.equal((await f.legacy.ownerRecovery(f.cwd))?.canRelease,false);
    await assert.rejects(f.legacy.releaseOwner(f.cwd,f.decisionId,f.proof),MasterConversationHeldError);
    const owner=JSON.parse(f.owner),child=spawn("python",["-B",resolve("scripts/negi_recover_writer.py"),"--root",f.master,"--kind","master","--domain","master-conversation",
      "--request-id",owner.operation.requestId,"--hash",owner.operation.hash,"--owner-sha256",hash(f.owner)],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
    let stderr="";child.stderr.on("data",p=>stderr+=p);const code=await new Promise<number|null>((accept,reject)=>{child.once("close",accept);child.once("error",reject)});
    assert.equal(code,1,stderr);assert.match(stderr,/requires its original inventory/);assert.equal(await readFile(join(f.master,"owner.lock"),"utf8"),f.owner);
    await assert.rejects(lstat(join(f.master,"recoveries")),{code:"ENOENT"});await assert.rejects(lstat(join(f.master,"owner-recovery-flock-v2.lock")),{code:"ENOENT"});
  });
  await fixture("inspection",async f=>{
    await release(f);const receipt=(await f.inventory.recoveryIntent(f.decisionId)).receipt!;await unlink(f.inventory.databasePath);
    await assert.rejects(f.inventory.previewLegacyMigration(),/original inventory/);await assert.rejects(f.legacy.ownerRecoveryStatus(f.cwd,f.decisionId),MasterConversationHeldError);
    await assert.rejects(lstat(f.inventory.databasePath),{code:"ENOENT"});assert.equal(await readFile(join(f.master,receipt.relativePath),"utf8"),receipt.bytes);
  });
});
