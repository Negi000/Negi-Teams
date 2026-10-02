import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { MasterConversationAuthority, MasterConversationHeldError, type MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";
import { scheduledMasterTurns } from "../src/server/orchestration/masterTurnAdmission.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import type { CodexThreadIdentity, CodexTurnObservation } from "../src/server/master/appServerClient.ts";
import { CodexAppServerBrain } from "../src/server/master/codexAppServerBrain.ts";
import { setup as taskFixture } from "./helpers/taskAuthoringFixture.ts";
import { submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";

const identity: CodexThreadIdentity = { threadId: "new-thread", requestedModel: "fixture-astra", resolvedModel: "fixture-astra", modelProvider: "fixture", rerouted: false };
const outcome: CodexTurnObservation = { turnId: "turn", status: "completed", finalText: "Saved response", contextInputTokens: 1, contextWindow: 100, lastUsage: null };
async function fixture(run: (data: { dir: string; cwd: string; root: string; turnRoot: string; scheduler: FileScheduler;
  authority: MasterConversationAuthority; request: MasterConversationRequest; reopen: () => MasterConversationAuthority }) => Promise<void>) {
 const dir = await mkdtemp(join(tmpdir(), "negi-conversation-"));
 const cwd=join(dir,"checkout"), state=join(dir,"state"), root=join(state,"conversations"), turnRoot=join(state,"master-turns");
 await mkdir(cwd);await mkdir(state);const scheduler=new FileScheduler(join(state,"scheduler.jsonl"));
 const reopen=()=>new MasterConversationAuthority({root,turnRoot,masterId:"master",scheduler});
 try { await run({dir,cwd,root,turnRoot,scheduler,authority:reopen(),reopen,
  request:{requestId:randomUUID(),masterId:"master",mode:"rotate",oldThreadId:"old-thread",cwd,model:"fixture-astra",effort:"low",provider:"fixture",settingsSha256:"a".repeat(64)}}); }
 finally { await rm(dir,{recursive:true,force:true}); }
}
const turnRequest=(cwd:string)=>({cwd,model:"fixture-astra",effort:"low",threadId:"old-thread",text:"Fixture input"});
const operationPath=(root:string,request:MasterConversationRequest)=>join(root,"masters",request.masterId,request.requestId);

test("signed ordered stages persist before empty thread callback; exact replay never invokes it twice",async()=>fixture(async f=>{
 let calls=0;const result=await f.authority.start(f.request,async mark=>{calls++;await mark();const files=await readdir(operationPath(f.root,f.request));assert.deepEqual(files.sort(),["00-requested.json","01-old_idle.json","02-start_dispatched.json"]);return identity;});
 assert.equal(result.stage,"completed");assert.equal(calls,1);assert.equal((await f.reopen().status(f.request.requestId))?.exclusionHeld,false);
 const repeated=await f.reopen().start(f.request,async()=>{throw Error("must not call");});assert.deepEqual(repeated,result);
 await assert.rejects(f.authority.start({...f.request,settingsSha256:"b".repeat(64)},async()=>identity),/reused/);
 await f.reopen().assertIdle(f.cwd);
}));

test("pre-dispatch failure is recorded unsent and same request cannot re-execute",async()=>fixture(async f=>{
 await assert.rejects(f.authority.start(f.request,async()=>{throw Error("startup failed before thread/start");}),/未作成/);
 assert.equal((await f.reopen().status(f.request.requestId))?.stage,"cancelled");
 let calls=0;assert.equal((await f.reopen().start(f.request,async()=>{calls++;return identity;})).stage,"cancelled");assert.equal(calls,0);
 await f.authority.assertIdle(f.cwd);
 assert.equal((await f.authority.start({...f.request,requestId:randomUUID()},async mark=>{await mark();return identity;})).stage,"completed");
}));

test("lost thread/start response holds same request, different requests and turn admission after reload",async()=>fixture(async f=>{
 await assert.rejects(f.authority.start(f.request,async mark=>{await mark();throw Error("lost ACK");}),/照合/);
 const status=await f.reopen().status(f.request.requestId);assert.equal(status?.stage,"needs_reconciliation");assert.equal(status?.exclusionHeld,false);
 let calls=0;assert.equal((await f.reopen().start(f.request,async()=>{calls++;return identity;})).stage,"needs_reconciliation");assert.equal(calls,0);
 await assert.rejects(f.reopen().start({...f.request,requestId:randomUUID()},async()=>identity),MasterConversationHeldError);
 await assert.rejects(f.reopen().admitTurn(f.cwd,async()=>{calls++;}),MasterConversationHeldError);assert.equal(calls,0);
}));

test("per-Master exclusion prevents duplicate reset and reservation during a dispatched callback",async()=>fixture(async f=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 const pending=f.authority.start(f.request,async mark=>{await mark();started();await held;return identity;});await ready;
 try { assert.equal((await f.reopen().status(f.request.requestId))?.exclusionHeld,true);await assert.rejects(f.reopen().admitTurn(f.cwd,async()=>{}),MasterConversationHeldError);await assert.rejects(f.reopen().start({...f.request,requestId:randomUUID()},async()=>identity),MasterConversationHeldError); }
 finally {release();await pending;}
}));

for(const [label,replacement] of [["same old thread",{...identity,threadId:"old-thread"}],["rerouted model",{...identity,resolvedModel:"wrong",rerouted:true}],["different provider",{...identity,modelProvider:"wrong"}]] as const)
 test("dispatched "+label+" remains unknown",async()=>fixture(async f=>{
  await assert.rejects(f.authority.start(f.request,async mark=>{await mark();return replacement;}),MasterConversationHeldError);
  assert.equal((await f.reopen().status(f.request.requestId))?.stage,"needs_reconciliation");await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
 }));

test("canonical signed record edits and removed/partial stages fail closed",async()=>fixture(async f=>{
 await f.authority.start(f.request,async mark=>{await mark();return identity;});const path=join(operationPath(f.root,f.request),"04-completed.json");const original=await readFile(path,"utf8");const changed=JSON.parse(original);changed.payload.reason="edited";await writeFile(path,JSON.stringify(changed)+"\n");
 await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);await assert.rejects(f.reopen().status(f.request.requestId),MasterConversationHeldError);
 await writeFile(path,original);await unlink(path);await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
 await writeFile(path,original.slice(0,-1));await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
}));

test("missing signing key is not regenerated over existing operation evidence",async()=>fixture(async f=>{
 await f.authority.start(f.request,async mark=>{await mark();return identity;});await unlink(join(f.root,"signing-key.json"));
 await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);await assert.rejects(readFile(join(f.root,"signing-key.json")),{code:"ENOENT"});
}));

test("hardlinked stage and redirected authority directory are held",async()=>fixture(async f=>{
 await f.authority.start(f.request,async mark=>{await mark();return identity;});const stage=join(operationPath(f.root,f.request),"04-completed.json");await link(stage,join(f.dir,"linked-stage"));await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
 await unlink(join(f.dir,"linked-stage"));await f.reopen().assertIdle(f.cwd);
 const alias=join(f.dir,"alias");await symlink(f.root,alias,process.platform==="win32"?"junction":"dir");const authority=new MasterConversationAuthority({root:alias,turnRoot:f.turnRoot,masterId:"master",scheduler:f.scheduler});await assert.rejects(authority.assertIdle(f.cwd),MasterConversationHeldError);
}));

test("unknown and active Master claims cannot be bypassed with spare planner capacity or different thread",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration({maxConcurrent:4,planners:2,workers:2});const admission=scheduledMasterTurns({root:f.turnRoot,masterId:"master",scheduler:f.scheduler});
 const lease=await f.authority.admitTurn(f.cwd,()=>admission.reserve(turnRequest(f.cwd)));await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
 await lease.dispatching();await lease.unknown("lost result");const before=await f.scheduler.read();
 await assert.rejects(f.reopen().start(f.request,async()=>identity),MasterConversationHeldError);await assert.rejects(f.reopen().admitTurn(f.cwd,()=>admission.reserve({...turnRequest(f.cwd),threadId:"new-thread"})),MasterConversationHeldError);assert.deepEqual(await f.scheduler.read(),before);
}));

test("only exact terminal/cancelled/unsent evidence permits next admission",async()=>fixture(async f=>{
 const admission=scheduledMasterTurns({root:f.turnRoot,masterId:"master",scheduler:f.scheduler});const lease=await admission.reserve(turnRequest(f.cwd));await lease.dispatching();await lease.bind("turn");await lease.complete(outcome);await f.authority.assertIdle(f.cwd);
 const unsent=await admission.reserve(turnRequest(f.cwd));await unsent.cancelBeforeDispatch();await f.reopen().assertIdle(f.cwd);
 const path=join(f.turnRoot,lease.workId,"outcome.json");const record=JSON.parse(await readFile(path,"utf8"));record.finalText="different";await writeFile(path,JSON.stringify(record)+"\n");await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
}));

test("pre-submit orphan and partial request hold without inventing owner or releasing capacity",async()=>fixture(async f=>{
 await mkdir(f.turnRoot);const orphan=join(f.turnRoot,"master-"+randomUUID());await mkdir(orphan);await assert.rejects(f.authority.assertIdle(f.cwd),MasterConversationHeldError);
 const request={schemaVersion:"negi-master-turn/1",workId:orphan.substring(orphan.lastIndexOf(process.platform==="win32"?"\\":"/")+1),masterId:"master",...turnRequest(f.cwd),inputSha256:"b".repeat(64),at:new Date().toISOString()};await writeFile(join(orphan,"request.json"),JSON.stringify(request)+"\n");await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);
 assert.equal((await f.scheduler.read()).state,null);
}));

test("actual stopped child leaves dispatched request and owner lock held, with read-only status",async()=>fixture(async f=>{
 const module=pathToFileURL(join(process.cwd(),"src/server/orchestration/masterConversations.ts")).href;const schedulerModule=pathToFileURL(join(process.cwd(),"src/server/orchestration/scheduler.ts")).href;
 const script=`import {MasterConversationAuthority} from ${JSON.stringify(module)};import {FileScheduler} from ${JSON.stringify(schedulerModule)};const a=new MasterConversationAuthority({root:${JSON.stringify(f.root)},turnRoot:${JSON.stringify(f.turnRoot)},masterId:"master",scheduler:new FileScheduler(${JSON.stringify(f.scheduler.path)})});await a.start(${JSON.stringify(f.request)},async mark=>{await mark();process.exit(23);});`;
 const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk;});const exit=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});assert.equal(exit,23,stderr);
 assert.equal((await f.reopen().status(f.request.requestId))?.stage,"start_dispatched");assert.equal((await f.reopen().status(f.request.requestId))?.exclusionHeld,true);await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);assert.ok((await readFile(join(f.root,"masters","master","owner.lock"),"utf8")).includes('"pid"'));
}));

test("read-only status of absent authority does not create files",async()=>fixture(async f=>{
 assert.equal(await f.authority.status(f.request.requestId),null);await assert.rejects(readdir(f.root),{code:"ENOENT"});
}));

test("startup audit of absent authority leaves all state unchanged",async()=>fixture(async f=>{
 const before=await readdir(join(f.dir,"state"));
 await f.authority.assertStartupSafe(f.cwd);
 assert.deepEqual(await readdir(join(f.dir,"state")),before);
 assert.equal((await f.scheduler.read()).state,null);
 await assert.rejects(readdir(f.root),{code:"ENOENT"});
}));

test("startup audit accepts durable terminal stages without creating a lock; unfinished stages remain held",async()=>fixture(async f=>{
 await f.authority.start(f.request,async mark=>{await mark();return identity;});
 const path=operationPath(f.root,f.request),names=(await readdir(path)).sort();
 const bytes=await Promise.all(names.map(name=>readFile(join(path,name),"utf8")));
 const key=await readFile(join(f.root,"signing-key.json"),"utf8");
 await f.reopen().assertStartupSafe(f.cwd);
 await assert.rejects(readFile(join(f.root,"masters","master","owner.lock")),{code:"ENOENT"});
 assert.deepEqual(await readdir(path).then(values=>values.sort()),names);
 assert.deepEqual(await Promise.all(names.map(name=>readFile(join(path,name),"utf8"))),bytes);
 assert.equal(await readFile(join(f.root,"signing-key.json"),"utf8"),key);
 await unlink(join(path,"04-completed.json"));
 await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);
 assert.deepEqual((await readdir(path)).sort(),names.slice(0,-1));
}));

test("startup audit holds a conversation lock that appears during scheduler inspection",async()=>fixture(async f=>{
 await f.authority.start(f.request,async mark=>{await mark();return identity;});
 const read=f.scheduler.read.bind(f.scheduler);let changed=false;
 const path=join(f.root,"masters","master","owner.lock");
 f.scheduler.read=async()=>{
  if(!changed){changed=true;await writeFile(path,JSON.stringify({schemaVersion:"negi-master-conversation-owner/1",nonce:randomUUID(),pid:process.pid})+"\n");}
  return read();
 };
 await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);
 assert.ok(await readFile(path,"utf8"));
}));

test("startup audit holds a previously absent conversation root that appears during turn inspection",async()=>fixture(async f=>{
 const read=f.scheduler.read.bind(f.scheduler);let changed=false;
 f.scheduler.read=async()=>{if(!changed){changed=true;await mkdir(f.root);}return read();};
 await assert.rejects(f.reopen().assertStartupSafe(f.cwd),MasterConversationHeldError);
 assert.deepEqual(await readdir(f.root),[]);
}));

test("production startup guard rejects unknown claim before any provider process launch",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration({maxConcurrent:4,planners:2,workers:2});const lease=await scheduledMasterTurns({root:f.turnRoot,masterId:"master",scheduler:f.scheduler}).reserve(turnRequest(f.cwd));await lease.dispatching();await lease.unknown("unknown old turn");let launches=0;
 const before=await readFile(f.scheduler.path,"utf8");
 const brain=new CodexAppServerBrain({executable:process.execPath,args:[],effort:"low",turnTimeoutMs:1000,admission:{reserve:async()=>{throw Error("no reserve at startup");},assertIdle:cwd=>f.authority.assertStartupSafe(cwd)},launch:()=>{launches++;throw Error("must not launch");}});
 await assert.rejects(brain.start({cwd:f.cwd,model:"fixture-astra",permissionMode:"plan",systemPrompt:null,controlMcp:null,mcpConfigPath:null,resumeSessionId:null,extraArgs:[]}),MasterConversationHeldError);assert.equal(launches,0);await brain.stop();
 assert.equal(await readFile(f.scheduler.path,"utf8"),before);await assert.rejects(readdir(f.root),{code:"ENOENT"});
}));

test("stop during asynchronous startup admission cannot launch after guard returns",async()=>fixture(async f=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let launches=0;
 const brain=new CodexAppServerBrain({executable:process.execPath,args:[],effort:"low",turnTimeoutMs:1000,admission:{reserve:async()=>{throw Error("unexpected");},assertIdle:async()=>held},launch:()=>{launches++;throw Error("must not launch");}});
 const starting=brain.start({cwd:f.cwd,model:"fixture-astra",permissionMode:"plan",systemPrompt:null,controlMcp:null,mcpConfigPath:null,resumeSessionId:null,extraArgs:[]});await brain.stop();release();await assert.rejects(starting,/stopped before/);assert.equal(launches,0);
}));

test("changed lock owner is retained rather than deleting another owner's path",async()=>fixture(async f=>{
 const owner=join(f.root,"masters","master","owner.lock");
 await assert.rejects(f.authority.start(f.request,async mark=>{await mark();await writeFile(owner,JSON.stringify({schemaVersion:"negi-master-conversation-owner/1",nonce:randomUUID(),pid:process.pid})+"\n");return identity;}),/owner lock replaced/);
 assert.equal((await f.reopen().status(f.request.requestId))?.exclusionHeld,true);await assert.rejects(f.reopen().admitTurn(f.cwd,async()=>{}),MasterConversationHeldError);assert.ok(await readFile(owner,"utf8"));
}));

test("editing canonical Master owner cannot bypass unknown startup or admission",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration({maxConcurrent:4,planners:2,workers:2});const lease=await scheduledMasterTurns({root:f.turnRoot,masterId:"master",scheduler:f.scheduler}).reserve(turnRequest(f.cwd));await lease.dispatching();await lease.unknown("lost");
 const path=join(f.turnRoot,lease.workId,"request.json"),request=JSON.parse(await readFile(path,"utf8"));request.masterId="another-master";await writeFile(path,JSON.stringify(request)+"\n");const before=await f.scheduler.read();await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);await assert.rejects(f.reopen().admitTurn(f.cwd,async()=>{}),MasterConversationHeldError);assert.deepEqual(await f.scheduler.read(),before);
}));

test("unresolved legacy owner is held globally; known terminal legacy evidence remains readable",async()=>fixture(async f=>{
 const lease=await scheduledMasterTurns({root:f.turnRoot,masterId:"legacy-master",scheduler:f.scheduler}).reserve(turnRequest(f.cwd));const lines=(await readFile(f.scheduler.path,"utf8")).trim().split("\n").map(line=>JSON.parse(line));for(const line of lines)if(line.action.type==="submit")delete line.action.work.masterOwner;await writeFile(f.scheduler.path,lines.map(line=>JSON.stringify(line)+"\n").join(""));
 await assert.rejects(f.reopen().assertIdle(f.cwd),MasterConversationHeldError);await lease.dispatching();await lease.bind("turn");await lease.complete(outcome);await f.reopen().assertIdle(f.cwd);
}));

test("ordinary registered Task prefix is not classified as a resident Master",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration();await f.scheduler.append({key:"ordinary-submit",at:new Date().toISOString(),action:{type:"submit",work:{id:"master-ordinary-task",parentId:null,dependencies:[],role:"astra",checkout:f.cwd,checkoutMode:"read",resources:[],reserveUsd:0}}});await f.authority.assertIdle(f.cwd);
}));

test("bound ownership permits independent Masters while preserving another unknown claim",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration({maxConcurrent:4,planners:2,workers:2});const other=await scheduledMasterTurns({root:f.turnRoot,masterId:"another-master",scheduler:f.scheduler}).reserve(turnRequest(f.cwd));await other.dispatching();await other.unknown("another owned Master remains unknown");await f.authority.assertIdle(f.cwd);
 const current=await f.authority.admitTurn(f.cwd,()=>scheduledMasterTurns({root:f.turnRoot,masterId:"master",scheduler:f.scheduler}).reserve({...turnRequest(f.cwd),threadId:"current"}));assert.equal((await f.scheduler.read()).state?.entries.find(e=>e.work.id===other.workId)?.status,"needs_reconciliation");await current.cancelBeforeDispatch();await f.authority.assertIdle(f.cwd);
}));

test("scheduler rejects forged Master bindings on ordinary work",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration();await assert.rejects(f.scheduler.append({key:"forged-owner",at:new Date().toISOString(),action:{type:"submit",work:{id:"ordinary-task",parentId:null,dependencies:[],role:"astra",checkout:f.cwd,checkoutMode:"read",resources:[],reserveUsd:0,masterOwner:{masterId:"master",requestSha256:"a".repeat(64)}}}}),/invalid Master owner/);
 assert.equal((await f.scheduler.read()).state?.entries.length,0);
}));

test("scheduler rejects coerced owner/hash values instead of storing ambiguous ownership",async()=>fixture(async f=>{
 await f.scheduler.ensureSubscriptionConfiguration();
 for(const masterOwner of [{masterId:["master"],requestSha256:"a".repeat(64)},{masterId:"master",requestSha256:["a".repeat(64)]}])
  await assert.rejects(f.scheduler.append({key:randomUUID(),at:new Date().toISOString(),action:{type:"submit",work:{id:"master-"+randomUUID(),parentId:null,dependencies:[],role:"astra",checkout:f.cwd,checkoutMode:"read",resources:[],reserveUsd:0,masterOwner:masterOwner as unknown as {masterId:string;requestSha256:string}}}}),/invalid Master owner/);
 assert.equal((await f.scheduler.read()).state?.entries.length,0);
}));

test("TaskService wires read-only startup and keeps ordinary reservation inside one configuration admission",async()=>{
 const f=await taskFixture();
 try {
  let admissions=0,entered=false;
  f.tasks.bindConfigurationAdmission(async operation=>{assert.equal(entered,false);entered=true;admissions++;try{return await operation();}finally{entered=false;}});
  const admission=f.tasks.masterTurnAdmission("master");
  const conversationRoot=join(f.catalog.stateRoot,"master-conversations");
  await admission.assertIdle!(f.repo);assert.equal(admissions,0);await assert.rejects(readdir(conversationRoot),{code:"ENOENT"});
  const lease=await admission.reserve(turnRequest(f.repo));assert.equal(admissions,1);
  await lease.dispatching();await lease.unknown("known old claim must hold next startup");
  const before=await readFile(f.config.schedulerPath,"utf8");
  await assert.rejects(admission.assertIdle!(f.repo),MasterConversationHeldError);
  assert.equal(await readFile(f.config.schedulerPath,"utf8"),before);assert.equal(admissions,1);
  await assert.rejects(readdir(conversationRoot),{code:"ENOENT"});assert.deepEqual(f.calls(),{astra:0,sol:0});
 } finally {await f.close();}
});

test("normal Sol Task registered through submitVaultRun may use a Master-shaped UUID without blocking startup",async()=>{
 const f=await taskFixture();
 try {
  const scheduler=new FileScheduler(f.config.schedulerPath),config={...f.config,runId:"master-"+randomUUID()};
  const prepared=await f.runtime.prepare(config);await submitVaultRun(prepared,scheduler);
  const entry=(await scheduler.read()).state!.entries.find(e=>e.work.id===config.runId)!;
  assert.equal(entry.work.role,"sol");assert.equal(entry.work.masterOwner,undefined);
  const before=await readFile(scheduler.path,"utf8");
  await f.tasks.masterTurnAdmission("master").assertIdle!(f.repo);
  assert.equal(await readFile(scheduler.path,"utf8"),before);
  await assert.rejects(readdir(join(f.catalog.stateRoot,"master-turns")),{code:"ENOENT"});
  assert.deepEqual(f.calls(),{astra:0,sol:0});
 } finally {await f.close();}
});
