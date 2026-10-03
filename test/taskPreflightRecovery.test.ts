import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { LocalTaskService,preflightClosureForStartup } from "../src/server/orchestration/taskService.ts";
import { createTaskHttp } from "../src/server/orchestration/taskHttp.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { withMasterStorageGuard } from "../src/server/orchestration/masterStorageGuard.ts";
import { submitVaultRun, type PreparedVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { observeRuntimeHelper } from "../src/server/orchestration/runtimeHelperObservation.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import type { VaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";

async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,indexed=false){
 const dir=await mkdtemp(join(tmpdir(),"negi-preflight-recovery-"));
 try{await run(await setup(dir,indexed))}finally{await rm(dir,{recursive:true,force:true})}
}
async function setup(dir:string,indexed:boolean){
 const checkout=join(dir,"checkout"),vault=join(dir,"vault"),stateRoot=join(dir,"state");await mkdir(checkout);await mkdir(vault);await mkdir(stateRoot);
 const git=(args:string[])=>execFileSync("git",args,{cwd:checkout,windowsHide:true,stdio:["ignore","pipe","pipe"]}).toString().trim();
 git(["init"]);await writeFile(join(checkout,"readme.md"),"Fixture baseline\n");git(["add","readme.md"]);
 git(["-c","user.name=Fixture","-c","user.email=fixture@invalid","commit","-m","Fixture baseline"]);
 const contract:VaultTaskContract={schemaVersion:"negi-task-contract/1",vaultId:"NT-PREFLIGHT-FIXTURE",version:1,sha256:"a".repeat(64),
  project:"fixture",objective:"Recover failed preflight",acceptance:["Human closes explicitly"],baseSha:git(["rev-parse","HEAD"]),
  scope:{in:["readme"],out:["no publishing"],allowedPaths:["readme.md"]},invariants:["Keep evidence"],verification:["focused"],
  escalation:["Hold unknown"],limits:{maxAttempts:1,timeLimitMinutes:5},sourceNotes:[]};
 const config:VaultRunConfig={executable:process.execPath,checkout,vault,snapshot:join(dir,"snapshot.json"),outputDir:join(dir,"output"),
  schedulerPath:join(dir,"scheduler.jsonl"),runId:"recovery-run",astra:{model:"gpt-6-astra",effort:"low"},sol:{model:"gpt-6.1-sol",effort:"low"},resources:[],
  verification:[{requirement:"focused",program:"node",args:["--version"],timeoutMs:5000}]};
 await writeFile(config.snapshot,JSON.stringify(contract));
 const catalog={stateRoot,runs:[{title:"開始前の復旧",config}]};
 let inventory:RuntimeJournalInventory|null=null;
 if(indexed){const root=join(stateRoot,"master-conversations"),turnRoot=join(stateRoot,"master-turns");await mkdir(join(root,"masters","master"),{recursive:true});await mkdir(turnRoot);
  await writeFile(join(root,"signing-key.json"),JSON.stringify({schemaVersion:"negi-master-conversation-key/1",key:randomBytes(32).toString("hex")})+"\n");
  await withMasterStorageGuard(root,async()=>{});inventory=new RuntimeJournalInventory({root,turnRoot,schedulerPath:config.schedulerPath});
  const preview=await inventory.previewBaseline();await inventory.adoptBaseline({decisionId:randomUUID(),expectedProofSha256:preview.proofSha256});
 }
 const options={...(indexed?{storage:"indexed" as const}:{}),preflightClosure:"close_unsubmitted/1" as const},runtime={prepare:async(_config:VaultRunConfig):Promise<PreparedVaultRun>=>{throw Error("Synthetic failed login")},
  submit:submitVaultRun,execute:async():Promise<never>=>{throw Error("Execution must not be called")}};
 const service=await LocalTaskService.open(catalog,runtime,options),view=await service.snapshot(config.runId),requestId=randomUUID();
 await service.start(view.id,view.configSha256,requestId);
 return {dir,config,contract,catalog,stateRoot,service,view,requestId,inventory,options,runtime,git};
}

test("authenticated close preserves evidence and reserves the old run terminal across reload and other writers",async()=>fixture(async f=>{
 const {service,view,config}=f;
 const request=await readFile(join(f.stateRoot,config.runId+".request.json")),error=await readFile(join(f.stateRoot,config.runId+".error.json"));
 const first=await service.inspectPreflight(view.id,view.configSha256,randomUUID());assert.equal(first.canClose,true);
 assert.equal((await service.snapshot(view.id)).canInspectPreflight,true);
 const closeId=randomUUID(),closed=await service.closePreflight(view.id,view.configSha256,closeId,first.inspectionId,first.dossierSha256);
 assert.equal(closed.preflightClosed,true);assert.equal(closed.status,"cancelled");assert.equal(closed.canStart,false);assert.equal(closed.attempts.length,0);
 assert.equal(closed.canInspectPreflight,false);assert.deepEqual(await readFile(join(f.stateRoot,config.runId+".request.json")),request);
 assert.deepEqual(await readFile(join(f.stateRoot,config.runId+".error.json")),error);assert.equal(f.git(["status","--porcelain"]),"");
 await service.closePreflight(view.id,view.configSha256,closeId,first.inspectionId,first.dossierSha256);
 const scheduler=new FileScheduler(config.schedulerPath),events=(await scheduler.read()).events;
 assert.equal(events.filter(e=>e.action.type==="close_unsubmitted").length,1);assert.equal(events.some(e=>e.action.type==="submit"||e.action.type==="claim"),false);
 await assert.rejects(submitVaultRun({config,contract:f.contract},scheduler),/already registered/);
 const reload=await LocalTaskService.open(f.catalog,f.runtime,f.options);try{assert.equal((await reload.snapshot(view.id)).preflightClosed,true);
  assert.equal((await reload.start(view.id,view.configSha256,f.requestId)).status,"cancelled");
  await assert.rejects(reload.start(view.id,view.configSha256,randomUUID()),/already requested/);
 }finally{await reload.close();await service.close()}
}));

test("changed checkout, output ownership, scheduler admission and stale lock each hold preflight closure",async()=>fixture(async f=>{
 const {service,view,config}=f;try{
  const inspection=await service.inspectPreflight(view.id,view.configSha256,randomUUID());
  await writeFile(join(config.checkout,"readme.md"),"Changed after inspection\n");
  await assert.rejects(service.closePreflight(view.id,view.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/facts changed/);
  await mkdir(config.outputDir);await writeFile(join(config.outputDir,"execution-owner.json"),"Unknown owner");
  assert.equal((await service.inspectPreflight(view.id,view.configSha256,randomUUID())).canClose,false);
  await rm(config.outputDir,{recursive:true});
  await writeFile(join(f.stateRoot,view.id+".preflight.lock"),"Unknown previous operation");
  await assert.rejects(service.inspectPreflight(view.id,view.configSha256,randomUUID()),/EEXIST/);
  assert.equal(await readFile(join(f.stateRoot,view.id+".preflight.lock"),"utf8"),"Unknown previous operation");
  await rm(join(f.stateRoot,view.id+".preflight.lock"));
  await submitVaultRun({config,contract:f.contract},new FileScheduler(config.schedulerPath));
  await assert.rejects(service.inspectPreflight(view.id,view.configSha256,randomUUID()),/admitted/);
 }finally{await service.close()}
}));

test("a live start in another service cannot be inspected or closed",async()=>fixture(async f=>{
 // Use a second fixed run, since the first request is intentionally immutable.
 const config={...f.config,runId:"live-run",outputDir:join(f.dir,"live-output")},catalog={stateRoot:f.stateRoot,runs:[{title:"Live",config}]};
 let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const runtime={...f.runtime,prepare:async():Promise<never>=>{ready();await gate;throw Error("Synthetic failed preflight")}};
 const owner=await LocalTaskService.open(catalog,runtime,f.options),reader=await LocalTaskService.open(catalog,f.runtime,f.options),view=await owner.snapshot(config.runId);
 const operation=owner.start(view.id,view.configSha256,randomUUID());try{await started;
  await assert.rejects(reader.inspectPreflight(view.id,view.configSha256,randomUUID()),/EEXIST/);
  assert.equal((await reader.snapshot(view.id)).canStart,false);release();await operation;
  assert.equal((await reader.inspectPreflight(view.id,view.configSha256,randomUUID())).canClose,true);
 }finally{release();await operation;await owner.close();await reader.close();await f.service.close()}
}));

test("preflight HTTP requires cookie, same origin, fixed configuration and exact signed close target",async()=>fixture(async f=>{
 const handler=createTaskHttp(f.service,{token:"recovery-login"}),server=createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url!,"http://"+req.headers.host))){res.statusCode=404;res.end()}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();assert(address&&typeof address!=="string");
 const url=`http://127.0.0.1:${address.port}`,target=url+"/api/tasks/"+f.view.id;
 const post=(action:string,data:unknown,origin=url,cookie="ebi_auth=recovery-login")=>fetch(target+"/"+action,{method:"POST",headers:{Cookie:cookie,Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(data)});
 const input={requestId:randomUUID(),configSha256:f.view.configSha256};try{
  assert.equal((await post("inspect-preflight",input,url,"")).status,401);assert.equal((await post("inspect-preflight",input,"https://foreign.invalid")).status,403);
  assert.equal((await post("inspect-preflight",{...input,configSha256:"b".repeat(64)})).status,409);
  assert.equal((await post("inspect-preflight",{...input,extra:true})).status,409);
  const response=await post("inspect-preflight",input);assert.equal(response.status,200);const inspected=await response.json();
  const close={requestId:randomUUID(),configSha256:f.view.configSha256,inspectionId:inspected.inspectionId,dossierSha256:inspected.dossierSha256};
  assert.equal((await post("close-preflight",{...close,dossierSha256:"a".repeat(64)})).status,409);
  assert.equal((await post("close-preflight",close)).status,200);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await f.service.close()}
}));

test("a saved close decision resumes only explicitly with the same identity after publication failure",async()=>fixture(async f=>{
 const {service,view}=f;try{
  const inspected=await service.inspectPreflight(view.id,view.configSha256,randomUUID()),closeId=randomUUID();
  const scheduler=service.registeredScheduler(f.config.schedulerPath),append=scheduler.append.bind(scheduler);
  scheduler.append=async()=>{throw Error("Synthetic publication failure before intent")};
  await assert.rejects(service.closePreflight(view.id,view.configSha256,closeId,inspected.inspectionId,inspected.dossierSha256),/publication failure/);
  scheduler.append=append;
  assert.equal((await service.snapshot(view.id)).status,"preflight_failed");
  const reread=await service.inspectPreflight(view.id,view.configSha256,randomUUID());assert.equal(reread.pendingCloseRequestId,closeId);
  assert.equal(reread.inspectionId,inspected.inspectionId);assert.equal(reread.canClose,true);
  await assert.rejects(service.closePreflight(view.id,view.configSha256,randomUUID(),inspected.inspectionId,inspected.dossierSha256),/original preflight close/);
  await service.closePreflight(view.id,view.configSha256,closeId,inspected.inspectionId,inspected.dossierSha256);
  assert.equal((await service.snapshot(view.id)).preflightClosed,true);
 }finally{await service.close()}
}));

test("missing or corrupt close evidence is held on reload and cannot receive an idempotent success",async()=>fixture(async f=>{
 const {service,view}=f;try{
  const inspected=await service.inspectPreflight(view.id,view.configSha256,randomUUID()),closeId=randomUUID();
  await service.closePreflight(view.id,view.configSha256,closeId,inspected.inspectionId,inspected.dossierSha256);
  const files=[join(f.stateRoot,view.id+".preflight-close.json"),join(f.stateRoot,"preflight-proofs",closeId+".json"),join(f.stateRoot,"preflight-proofs",inspected.inspectionId+".json")];
  for(const path of files){const original=await readFile(path);await rm(path);
   let held=await service.snapshot(view.id);assert.equal(held.status,"needs_reconciliation");assert.equal(held.preflightClosed,false);assert.equal(held.preflightCloseHeld,true);assert.equal(held.canStart,false);
   await assert.rejects(service.closePreflight(view.id,view.configSha256,closeId,inspected.inspectionId,inspected.dossierSha256));
   await writeFile(path,"Corrupt saved evidence");held=await service.snapshot(view.id);assert.equal(held.preflightClosed,false);assert.equal(held.status,"needs_reconciliation");
   await writeFile(path,original);assert.equal((await service.snapshot(view.id)).preflightClosed,true);
  }
  const reload=await LocalTaskService.open(f.catalog,f.runtime);try{assert.equal((await reload.snapshot(view.id)).preflightClosed,true)}finally{await reload.close()}
  await mkdir(f.config.outputDir);await writeFile(join(f.config.outputDir,"execution-owner.json"),"Unexpected external owner");
  await writeFile(join(f.config.outputDir,"review-manifest.json"),"Unexpected later review");
  const internal=service as unknown as {ensureReview:()=>Promise<never>},originalReview=internal.ensureReview;let reviewReads=0;
  internal.ensureReview=async()=>{reviewReads++;throw Error("Unknown later review must not be adopted")};
  assert.equal((await service.snapshot(view.id)).preflightCloseHeld,true);assert.equal(reviewReads,0);internal.ensureReview=originalReview;
  const reviewStore=await LocalReviewService.open({storageRoot:join(f.dir,"review-store"),writableRoots:[],cases:[]});
  const reloaded=await LocalTaskService.open(f.catalog,f.runtime,f.options);
  try{await reloaded.connectReviews(reviewStore);assert.equal((await reloaded.snapshot(view.id)).preflightCloseHeld,true);
    assert.equal(await readFile(join(f.config.outputDir,"review-manifest.json"),"utf8"),"Unexpected later review");assert.deepEqual(reviewStore.list(),[]);
  }finally{await reloaded.close()}
  assert.equal((await service.snapshot(view.id)).preflightCloseHeld,true);await rm(f.config.outputDir,{recursive:true});
  await mkdir(f.config.outputDir);await writeFile(join(f.config.outputDir,"run.jsonl"),"");
  assert.equal((await service.snapshot(view.id)).preflightCloseHeld,true);
 }finally{await service.close()}
}));

test("new closure writer is disabled by default and can be enabled only by trusted startup configuration",async()=>fixture(async f=>{
 const reader=await LocalTaskService.open(f.catalog,f.runtime);try{
  const inspection=await reader.inspectPreflight(f.view.id,f.view.configSha256,randomUUID());assert.equal(inspection.canClose,false);
  await assert.rejects(reader.closePreflight(f.view.id,f.view.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/explicit writer activation/);
  assert.equal((await reader.registeredScheduler(f.config.schedulerPath).read()).events.some(e=>e.action.type==="close_unsubmitted"),false);
  assert.deepEqual(preflightClosureForStartup(undefined),{});assert.throws(()=>preflightClosureForStartup("true"),/activation invalid/);
  assert.deepEqual(preflightClosureForStartup("close_unsubmitted/1"),{preflightClosure:"close_unsubmitted/1"});
 }finally{await reader.close();await f.service.close()}
}));

test("shutdown waits for owned preflight to finish and release its durable lock",async()=>fixture(async f=>{
 const config={...f.config,runId:"shutdown-run",outputDir:join(f.dir,"shutdown-output")},catalog={stateRoot:f.stateRoot,runs:[{title:"Shutdown",config}]};
 let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const runtime={...f.runtime,prepare:async()=>{ready();await gate;return {config,contract:f.contract}}};
 const service=await LocalTaskService.open(catalog,runtime),view=await service.snapshot(config.runId),operation=service.start(view.id,view.configSha256,randomUUID());
 try{await started;let completed=false;const closing=service.close().then(()=>completed=true);
  await new Promise(r=>setTimeout(r,50));assert.equal(completed,false);assert((await readdir(f.stateRoot)).includes(config.runId+".preflight.lock"));
  release();await operation;await closing;assert.equal(completed,true);assert.equal((await readdir(f.stateRoot)).includes(config.runId+".preflight.lock"),false);
  assert.equal((await service.registeredScheduler(config.schedulerPath).read()).state?.entries.some(e=>e.work.id===config.runId),false);
 }finally{release();await operation;await service.close();await f.service.close()}
}));

test("prior reader fails closed on the new terminal event: all readers must be upgraded before writer activation",async()=>{
 const legacy=await readFile(new URL("./fixtures/scheduler-before-preflight.ts.txt",import.meta.url),"utf8");
 const code=ts.transpileModule(legacy.replace(/^import .*\r?\n/gm,""),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exported:any={},context:any={exports:exported,structuredClone,resolve:join,isAbsolute:()=>true};new Script(code).runInNewContext(context);
 const initial=exported.reduceScheduler(null,{key:"configure",at:new Date().toISOString(),action:{type:"configure",maxConcurrent:1,budgetUsd:0}});
 const copy=structuredClone(initial),event={key:"preflight-close:"+randomUUID(),at:new Date().toISOString(),action:{type:"close_unsubmitted",evidenceRef:"user:preflight-close:"+randomUUID(),
  work:{id:"old-reader-run",parentId:null,dependencies:[],role:"sol",checkout:join(tmpdir(),"fixture"),checkoutMode:"write",resources:[],reserveUsd:0,execution:"direct"}}};
 assert.throws(()=>exported.reduceScheduler(initial,event),/work not registered/);assert.equal(JSON.stringify(initial),JSON.stringify(copy));
});

test("native indexed close publishes one terminal intent and remains clean",{skip:process.platform!=="win32"},async()=>fixture(async f=>{
 try{const inspected=await f.service.inspectPreflight(f.view.id,f.view.configSha256,randomUUID());
  await f.service.closePreflight(f.view.id,f.view.configSha256,randomUUID(),inspected.inspectionId,inspected.dossierSha256);
  assert.equal((await f.inventory!.audit()).state,"clean");
  const events=(await f.service.registeredScheduler(f.config.schedulerPath).read()).events;
  assert.equal(events.filter(e=>e.action.type==="close_unsubmitted").length,1);
  assert.equal(events.some(e=>e.action.type==="submit"||e.action.type==="claim"),false);
 }finally{await f.service.close()}
},true));

test("real indexed recovery closes only clean no-admission state and leaves a partial native intent held",{skip:process.platform!=="win32"},async()=>fixture(async f=>{
 const {service,view}=f;try{
  const inspected=await service.inspectPreflight(view.id,view.configSha256,randomUUID());assert.equal(inspected.canClose,true);
  const scheduler=service.registeredScheduler(f.config.schedulerPath),prior=await readFile(f.config.schedulerPath,"utf8"),event={key:"held-intent",at:new Date().toISOString(),
   action:{type:"submit" as const,work:{id:"other-run",parentId:null,dependencies:[],role:"sol" as const,checkout:f.config.checkout,checkoutMode:"write" as const,resources:[],reserveUsd:0}}};
  await f.inventory!.schedulerJournal().appendIntent({path:f.config.schedulerPath,previousBytes:prior,bytes:JSON.stringify(event)+"\n",event});
  assert.equal((await f.inventory!.audit()).state,"pending");
  await assert.rejects(service.closePreflight(view.id,view.configSha256,randomUUID(),inspected.inspectionId,inspected.dossierSha256),/storage requires reconciliation/);
  assert.equal(await readFile(f.config.schedulerPath,"utf8"),prior);
  assert.equal((await readdir(f.stateRoot)).some(name=>name.endsWith(".preflight-close.json")),false);
 }finally{await service.close()}
},true));

test("readonly helper timeout awaits actual close; mutating helper is not killed or retried",async()=>{
 const child=spawn(process.execPath,["-e","process.stdin.resume();setInterval(()=>{},1000)"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let closed=false;child.on("close",()=>closed=true);
 await assert.rejects(observeRuntimeHelper(child,"{}\n",true,100),/readonly inspection timed out/);assert.equal(closed,true);
 const mutation=spawn(process.execPath,["-e","process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{process.stdout.write('saved');process.exit(0)},200))"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
 assert.equal(await observeRuntimeHelper(mutation,"{}\n",false,10),"saved");assert.equal(mutation.killed,false);
});
