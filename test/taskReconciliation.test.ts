import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { createTaskHttp } from "../src/server/orchestration/taskHttp.ts";
import { taskPageHtml } from "../src/server/orchestration/taskPage.ts";
import { FileTaskLedger, type TaskAction, type ProviderTurnEvidence } from "../src/server/orchestration/singleTask.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { inspectTaskExecutionOwner } from "../src/server/orchestration/taskExecutionOwner.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import type { VaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";
import { WindowsProcessTree } from "../src/server/master/windowsProcessTree.ts";
import { LocalStorageConsole } from "../src/server/orchestration/storageConsole.ts";

const git=(cwd:string,args:string[])=>execFileSync("git",args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]}).toString().trim();
async function fixture(operation:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,verificationUnknown=false){const f=await setup(verificationUnknown);try{await operation(f)}finally{f.release();await f.service.close();await rm(f.root,{recursive:true,force:true})}}
async function setup(verificationUnknown=false){
  const root=await mkdtemp(join(tmpdir(),"negi-recovery-")),checkout=join(root,"checkout"),vault=join(root,"vault"),outputDir=join(root,"output");
  await mkdir(checkout);await mkdir(join(checkout,"docs"));await mkdir(vault);
  await mkdir(join(checkout,"docs/sub"));await writeFile(join(checkout,"docs/sub/file.txt"),"delete fixture\n");
  await writeFile(join(checkout,"docs/base.txt"),"baseline\n");git(checkout,["init"]);git(checkout,["add","."]);
  git(checkout,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
  const contract:VaultTaskContract={schemaVersion:"negi-task-contract/1",vaultId:"NT-TASK-RECOVERY",version:1,sha256:"a".repeat(64),project:"fixture",
    objective:"中断したドキュメント作業を確認",acceptance:["人間レビューが必要"],baseSha:git(checkout,["rev-parse","HEAD"]),
    scope:{in:["one document"],out:["no publishing"],allowedPaths:["docs"]},invariants:["Keep existing files"],verification:["runtime"],
    escalation:["stop"],limits:{maxAttempts:1,timeLimitMinutes:5},sourceNotes:[]};
  const snapshot=join(root,"snapshot.json");await writeFile(snapshot,JSON.stringify(contract));
  const config:VaultRunConfig={executable:process.execPath,checkout,vault,outputDir,snapshot,schedulerPath:join(root,"scheduler.jsonl"),runId:"recovery-task",
    astra:{model:"gpt-6-astra",effort:"low"},sol:{model:"gpt-6.1-sol",effort:"low"},resources:["fixture-resource"],
    verification:[{requirement:"runtime",program:process.execPath,args:["--version"],timeoutMs:5000}]};
  const catalog={stateRoot:join(root,"state"),runs:[{title:"中断した作業",config}]};
  let providerCalls=0,executeCalls=0,status:ProviderTurnEvidence["status"]="interrupted",wait=false,release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve});
  const runtime={prepare:async(config:VaultRunConfig)=>({config,contract}),submit:submitVaultRun,
    inspectProvider:async(_config:VaultRunConfig,threadId:string,turnId:string):Promise<ProviderTurnEvidence>=>{
      providerCalls++;return{threadId,turnId,found:true,status,pagesRead:1,completeSearch:true,observedAtMs:Date.now(),source:"thread/turns/list",
        processSafety:{source:"thread/items/list",complete:true,pagesRead:1,itemCount:1,itemTypes:["agentMessage"],sha256:"c".repeat(64),noExecutableItems:true}};},
    execute:async(prepared: {config:VaultRunConfig},scheduler:FileScheduler)=>{
      executeCalls++;await scheduler.claim(config.runId,config.runId+":dispatch");
      const ledger=new FileTaskLedger(join(outputDir,"run.jsonl"));let n=0;
      const append=(action:TaskAction)=>ledger.append({key:`fixture:${n++}`,at:new Date().toISOString(),action});
      await append({type:"create",runId:config.runId,contract});
      await append({type:"start_attempt",attemptId:"astra-attempt",role:"astra",requestedModel:config.astra.model});
      await append({type:"bind_provider",attemptId:"astra-attempt",threadId:"thread-fixture",turnId:"turn-fixture"});
      await writeFile(join(prepared.config.checkout,"docs/result.txt"),"retained dirty work\n");
      await mkdir(join(outputDir,"artifacts"),{recursive:true});await writeFile(join(outputDir,"artifacts/astra-attempt.md"),"retained partial result\n");
      let state;
      if(verificationUnknown){
        const outputRef=join(outputDir,"artifacts/astra-attempt.md")+"#sha256="+createHash("sha256").update("retained partial result\n").digest("hex");
        await append({type:"complete_attempt",attemptId:"astra-attempt",resolvedModel:config.astra.model,threadId:"thread-fixture",turnId:"turn-fixture",outputRef});
        await append({type:"start_attempt",attemptId:"sol-attempt",role:"sol",requestedModel:config.sol.model});
        await append({type:"bind_provider",attemptId:"sol-attempt",threadId:"thread-sol",turnId:"turn-sol"});
        const solPath=join(outputDir,"artifacts/sol-attempt.md"),text="Completed synthetic work.\n";await writeFile(solPath,text);
        await append({type:"complete_attempt",attemptId:"sol-attempt",resolvedModel:config.sol.model,threadId:"thread-sol",turnId:"turn-sol",outputRef:solPath+"#sha256="+createHash("sha256").update(text).digest("hex")});
        state=await append({type:"verify",outcome:"unknown",evidenceRef:"local:verification-process-unconfirmed"});
      }else state=await append({type:"provider_unknown",attemptId:"astra-attempt",reason:"Synthetic connection loss"});
      await scheduler.append({key:"fixture:unknown",at:new Date().toISOString(),action:{type:"unknown",workId:config.runId,reason:"Synthetic connection loss"}});
      if(wait)await gate;return state;
    }};
  const service=await LocalTaskService.open(catalog,runtime);
  return {root,checkout,config,catalog,service,runtime,release,setWait:(value:boolean)=>{wait=value},setStatus:(value:ProviderTurnEvidence["status"])=>{status=value},
    calls:()=>({provider:providerCalls,execute:executeCalls})};
}
async function start(f:Awaited<ReturnType<typeof setup>>,live=false){
  const v=await f.service.snapshot(f.config.runId);await f.service.start(v.id,v.configSha256,randomUUID());
  const until=Date.now()+5000;for(;;){const view=await f.service.snapshot(v.id);if(view.status==="needs_reconciliation"&&(live||!view.live))return view;
    if(Date.now()>until)throw Error("Fixture did not settle");await new Promise(resolve=>setTimeout(resolve,10))}
}
test("indexed inspection serializes one Task, permits other scheduler writes during provider read and rejects stale facts",{skip:process.platform!=="win32"},async()=>fixture(async f=>{
  const original=await start(f);await f.service.close();
  const registration={...await LocalTaskService.inspectStorageRegistration(f.catalog),masterId:"negi-master"};
  const storage=new LocalStorageConsole(registration,()=>({maintenance:true,executionHeld:true,startupError:null}));
  for(const operation of ["authority-initialize","stage-adopt","runtime-adopt"] as const){const p=await storage.preview(operation);await storage.apply(p.decision)}
  let release!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(accept=>{release=accept}),observed=new Promise<void>(accept=>{entered=accept});
  const tasks=await LocalTaskService.open(f.catalog,{...f.runtime,inspectProvider:async(...args:Parameters<typeof f.runtime.inspectProvider>)=>{
    calls++;entered();await gate;return f.runtime.inspectProvider(...args);
  }},{storage:"indexed"});
  try{
    const inspection=tasks.inspectReconciliation(original.id,original.configSha256,randomUUID());
    // Attach the expected rejection before running the concurrent operations.
    const result=assert.rejects(inspection,/Task facts changed while inspecting/);
    await observed;
    await assert.rejects(tasks.inspectReconciliation(original.id,original.configSha256,randomUUID()),{code:"EEXIST"});assert.equal(calls,1);
    const scheduler=tasks.registeredScheduler(f.config.schedulerPath);
    await scheduler.append({key:"other-task-capacity",at:new Date().toISOString(),action:{type:"set_capacity",capacity:{maxConcurrent:2,planners:1,workers:1},sourceRef:"user:fixture"}});
    // Reaching this write before releasing the provider proves the root guard
    // was not retained over the read RPC; no wall-clock sleep assertion needed.
    release();await result;
    assert.equal((await scheduler.read()).state!.entries[0].status,"needs_reconciliation");
    assert.equal(calls,1);assert.equal((await tasks.snapshot(original.id)).status,"needs_reconciliation");
  }finally{release();await tasks.close()}
}));
test("unknown verification after completed Sol remains inspectable without enabling close",async()=>fixture(async f=>{
  f.setStatus("completed");const v=await start(f),before=await readFile(join(f.checkout,"docs/result.txt"));
  assert.equal((await new FileTaskLedger(join(f.config.outputDir,"run.jsonl")).read()).state?.status,"blocked");
  const inspection=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID());
  assert.equal(inspection.dossier.taskStatus,"blocked");assert.equal(inspection.dossier.attempt.role,"sol");
  assert.equal(inspection.dossier.attempt.state,"completed");assert.equal(inspection.canClose,false);
  assert.match(inspection.heldReasons.join("\n"),/検証結果が不明/);
  assert.deepEqual(f.calls(),{provider:1,execute:1});
  await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/uncertain/);
  assert.equal((await new FileScheduler(f.config.schedulerPath).read()).state?.entries[0].status,"needs_reconciliation");
  assert.deepEqual(await readFile(join(f.checkout,"docs/result.txt")),before);assert.deepEqual(f.calls(),{provider:1,execute:1});
},true));
test("explicit inspected close preserves dirty bytes, abandons the attempt permanently and verifies signed replay",async()=>fixture(async f=>{
  const v=await start(f),before=git(f.checkout,["status","--porcelain"]),bytes=await readFile(join(f.checkout,"docs/result.txt"));
  const request=randomUUID(),inspection=await f.service.inspectReconciliation(v.id,v.configSha256,request);
  assert.equal(inspection.canClose,true);assert.equal(inspection.dossier.owner.status,"finished");
  assert.deepEqual(await f.service.inspectReconciliation(v.id,v.configSha256,request),inspection);assert.equal(f.calls().provider,1);
  const closeId=randomUUID(),closed=await f.service.closeReconciliation(v.id,v.configSha256,closeId,inspection.inspectionId,inspection.dossierSha256);
  assert.equal(closed.status,"stopped");assert.equal(closed.canStart,false);assert.equal(closed.acceptedBy,null);assert.equal(closed.attempts[0].state,"abandoned");
  assert.equal((await new FileScheduler(f.config.schedulerPath).read()).state?.entries[0].status,"failed");
  assert.equal(git(f.checkout,["status","--porcelain"]),before);assert.deepEqual(await readFile(join(f.checkout,"docs/result.txt")),bytes);
  assert.equal(await readFile(join(f.config.outputDir,"artifacts/astra-attempt.md"),"utf8"),"retained partial result\n");
  await f.service.closeReconciliation(v.id,v.configSha256,closeId,inspection.inspectionId,inspection.dossierSha256);assert.equal(f.calls().provider,2);
  await f.service.close();const restored=await LocalTaskService.open(f.catalog,f.runtime);
  try{assert.equal((await restored.snapshot(v.id)).status,"stopped");assert.equal(f.calls().execute,1);assert.equal(f.calls().provider,2)}finally{await restored.close()}
  // A standalone reader must not silently trust a new close event.
  await assert.rejects(new FileTaskLedger(join(f.config.outputDir,"run.jsonl")).read(),/trusted reconciliation/);
  const proof=join(f.root,"state/reconciliation-proofs",closeId+".json"),signed=JSON.parse(await readFile(proof,"utf8"));
  signed.receipt.data.configSha256="f".repeat(64);await writeFile(proof,JSON.stringify(signed));
  await assert.rejects(f.service.snapshot(v.id),/signature/);
}));
test("terminal provider does not release a host still finishing, and missing legacy ownership stays held",async()=>fixture(async f=>{
  f.setWait(true);const v=await start(f,true),inspection=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID());
  assert.equal(inspection.dossier.owner.status,"live");assert.equal(inspection.canClose,false);
  await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/unavailable/);
  f.release();await f.service.close();assert.equal((await inspectTaskExecutionOwner(f.config.outputDir,v.id,v.configSha256,v.id+":dispatch")).status,"finished");
  await unlink(join(f.config.outputDir,"execution-owner.json"));
  const restored=await LocalTaskService.open(f.catalog,f.runtime);
  try{const missing=await restored.inspectReconciliation(v.id,v.configSha256,randomUUID());assert.equal(missing.dossier.owner.status,"missing");assert.equal(missing.canClose,false);
    await assert.rejects(restored.closeReconciliation(v.id,v.configSha256,randomUUID(),missing.inspectionId,missing.dossierSha256),/uncertain/)}finally{await restored.close()}
}));
test("byte changes and refreshed nonterminal provider status invalidate the close preview",async()=>fixture(async f=>{
  const v=await start(f),inspection=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID());
  await writeFile(join(f.checkout,"docs/result.txt"),"changed same path\n");
  await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/facts changed/);
  const refreshed=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID());f.setStatus("inProgress");
  await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,randomUUID(),refreshed.inspectionId,refreshed.dossierSha256),/terminal state changed/);
  assert.equal((await f.service.snapshot(v.id)).status,"needs_reconciliation");assert.equal(f.calls().execute,1);
}));
test("a direct provider PID exit never substitutes for missing process-tree containment",async()=>fixture(async f=>{
  const v=await start(f),owner=JSON.parse(await readFile(join(f.config.outputDir,"execution-owner.json"),"utf8"));
  await writeFile(join(f.config.outputDir,"execution-children.jsonl"),[
    {kind:"launch",role:"astra",ownerId:owner.id},{kind:"started",role:"astra",pid:process.pid,ownerId:owner.id},
    {kind:"exited",role:"astra",pid:process.pid,ownerId:owner.id}].map(e=>JSON.stringify(e)+"\n").join(""));
  const inspection=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID());
  assert.equal(inspection.dossier.owner.status,"finished");assert.equal(inspection.canClose,false);
  assert.match(inspection.heldReasons.join(" "),/実行枠/);
  await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/uncertain/);
  assert.equal((await new FileScheduler(f.config.schedulerPath).read()).state?.entries[0].status,"needs_reconciliation");
}));
test("fixed contract changes are rejected and old reconciled ledgers remain readable without redispatch",async()=>fixture(async f=>{
  const v=await start(f),path=join(f.config.outputDir,"run.jsonl"),original=await readFile(path,"utf8");
  const events=original.trim().split("\n").map(line=>JSON.parse(line));events[0].action.contract.acceptance=["changed acceptance"];
  await writeFile(path,events.map(e=>JSON.stringify(e)+"\n").join(""));
  await assert.rejects(f.service.inspectReconciliation(v.id,v.configSha256,randomUUID()),/fixed Task contract/);
  await writeFile(path,original);
  const ledger=new FileTaskLedger(path,Date.now,async()=>true);
  await ledger.append({key:"legacy:reconcile",at:new Date().toISOString(),action:{type:"reconcile",attemptId:"astra-attempt",outcome:"abandoned",evidenceRef:"legacy:operator-proof"}});
  assert.equal((await f.service.snapshot(v.id)).status,"needs_reconciliation");assert.equal(f.calls().execute,1);
}));
test("nested directory deletion and an approval exceeding 512KB remain inspectable through a bounded projection",async()=>fixture(async f=>{
    const before=await start(f);
    await rm(join(f.checkout,"docs/sub"),{recursive:true});
    const ledgerPath=join(f.config.outputDir,"run.jsonl"),events=(await readFile(ledgerPath,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    // Synthetic discarded approval history; no provider operation was executed.
    const bind=events.findIndex(e=>e.action.type==="bind_provider");events.splice(bind+1,0,{key:"long:approval",at:events[bind].at,action:{type:"request_approval",approval:{
      id:"long-approval",attemptId:"astra-attempt",threadId:"thread-fixture",turnId:"turn-fixture",operation:"fixture-text",target:"説明".repeat(100000),expiresAt:new Date(Date.now()+60000).toISOString()}}});
    await writeFile(ledgerPath,events.map(e=>JSON.stringify(e)+"\n").join(""));
    const inspection=await f.service.inspectReconciliation(before.id,before.configSha256,randomUUID());
    assert.ok(inspection.dossier.checkout.changedPaths.includes("docs/sub/file.txt"));assert.ok(Buffer.byteLength(JSON.stringify(inspection))<24000);
    assert.equal(inspection.dossier.approvals[0].target.length,500);assert.equal(inspection.dossier.approvals[0].targetTruncated,true);
    assert.equal(inspection.dossier.approvalSummary.count,1);
    assert.equal(inspection.dossier.checkout.safe,true);
}));
for(const legacy of [false,true])test(legacy?"historical pending close without job projection resumes its signed metadata":
  "a saved close with an interrupted scheduler write resumes only its metadata, without another provider call",async()=>fixture(async f=>{
  const v=await start(f),inspection=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID()),closeId=randomUUID();
  const append=FileScheduler.prototype.append;FileScheduler.prototype.append=async function(event,validate){
    if(event.key===`task-close:${closeId}:scheduler`)throw Error("Synthetic scheduler write interrupted");return append.call(this,event,validate)};
  try{await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,closeId,inspection.inspectionId,inspection.dossierSha256),/interrupted/)}
  finally{FileScheduler.prototype.append=append}
  if(legacy){
    // Construct the historical signed fixture shape, never mutate user proofs.
    const root=join(f.root,"state/reconciliation-proofs"),key=await readFile(join(root,"server-signing-key"));let digest="";
    for(const id of [inspection.inspectionId,closeId]){const path=join(root,id+".json"),envelope=JSON.parse(await readFile(path,"utf8"));
      const dossier=JSON.parse(envelope.receipt.data.dossier);delete dossier.owner.jobExit;
      digest=createHash("sha256").update(JSON.stringify(dossier)).digest("hex");
      envelope.receipt.data.dossier=JSON.stringify(dossier);envelope.receipt.artifactSha256=digest;
      envelope.signature=createHmac("sha256",key).update(JSON.stringify(envelope.receipt)).digest("hex");await writeFile(path,JSON.stringify(envelope)+"\n");
    }
    const path=join(f.config.outputDir,"recovery-close.json"),intent=JSON.parse(await readFile(path,"utf8"));intent.dossierSha256=digest;await writeFile(path,JSON.stringify(intent)+"\n");
  }
  assert.equal((await f.service.snapshot(v.id)).status,"needs_reconciliation");await f.service.close();
  const restored=await LocalTaskService.open(f.catalog,f.runtime);
  try{
    const pending=await restored.inspectReconciliation(v.id,v.configSha256,randomUUID());assert.equal(pending.pendingCloseRequestId,closeId);
    await assert.rejects(restored.closeReconciliation(v.id,v.configSha256,randomUUID(),pending.inspectionId,pending.dossierSha256),/original/);
    assert.equal((await restored.closeReconciliation(v.id,v.configSha256,closeId,pending.inspectionId,pending.dossierSha256)).status,"stopped");
    assert.deepEqual(f.calls(),{execute:1,provider:2});
  }finally{await restored.close()}
}));

test("an empty Windows job receipt still cannot close real provider work because external brokers are unproven",{skip:process.platform!=="win32"},async()=>fixture(async f=>{
  const v=await start(f),owner=JSON.parse(await readFile(join(f.config.outputDir,"execution-owner.json"),"utf8"));
  const tree=await WindowsProcessTree.launch({executable:process.execPath,args:["-e","process.exit(0)"],cwd:f.checkout,env:process.env,trustedRoot:join(f.root,"job-fixture")});
  const result=await tree.exited;assert.ok(result.receipt);
  await writeFile(join(f.config.outputDir,"execution-children.jsonl"),[
    {kind:"launch",role:"astra",ownerId:owner.id},{kind:"started",role:"astra",pid:tree.identity.rootPid,tree:tree.identity,ownerId:owner.id},
    {kind:"exited",role:"astra",pid:tree.identity.rootPid,tree:result.receipt,ownerId:owner.id}].map(e=>JSON.stringify(e)+"\n").join(""));
  const inspection=await f.service.inspectReconciliation(v.id,v.configSha256,randomUUID());
  assert.equal(inspection.dossier.owner.jobExit,"confirmed");assert.equal(inspection.canClose,false);
  assert.match(inspection.heldReasons.join(" "),/外部サービス/);
  await assert.rejects(f.service.closeReconciliation(v.id,v.configSha256,randomUUID(),inspection.inspectionId,inspection.dossierSha256),/uncertain/);
  assert.equal((await new FileScheduler(f.config.schedulerPath).read()).state?.entries[0].status,"needs_reconciliation");
}));
test("authenticated same-origin recovery HTTP accepts only pinned identities and the page script parses",async()=>fixture(async f=>{
  const v=await start(f),handle=createTaskHttp(f.service,{token:"fixture-auth",noAuth:false}),server=createServer((req,res)=>{
    void handle(req,res,new URL(req.url!,"http://fixture")).then(handled=>{if(!handled){res.writeHead(404);res.end()}})});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  const path=`/api/tasks/${v.id}/inspect-reconciliation`,body={requestId:randomUUID(),configSha256:v.configSha256};
  const headers={cookie:"ebi_auth=fixture-auth",origin:base,"Content-Type":"application/json"};
  try{
    const redirect=await fetch(base+`/tasks?run=${v.id}`,{redirect:"manual"});
    assert.equal(redirect.status,302);assert.equal(new URL(redirect.headers.get("location")!,base).searchParams.get("returnTo"),`/tasks?run=${v.id}`);
    assert.equal((await fetch(base+path,{method:"POST",headers:{...headers,cookie:""},body:JSON.stringify(body)})).status,401);
    assert.equal((await fetch(base+path,{method:"POST",headers:{...headers,origin:"http://other.invalid"},body:JSON.stringify(body)})).status,403);
    assert.equal((await fetch(base+path,{method:"POST",headers,body:JSON.stringify({...body,command:"injected"})})).status,409);
    const response=await fetch(base+path,{method:"POST",headers,body:JSON.stringify(body)});assert.equal(response.status,200);
    const inspection=await response.json();assert.equal(inspection.canClose,true);
    const close=await fetch(base+`/api/tasks/${v.id}/close-reconciliation`,{method:"POST",headers,body:JSON.stringify({configSha256:v.configSha256,
      requestId:randomUUID(),inspectionId:inspection.inspectionId,dossierSha256:inspection.dossierSha256})});assert.equal(close.status,200);assert.equal((await close.json()).status,"stopped");
    const html=taskPageHtml();for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(script[1]);
    assert.match(html,/中断した実行を照合/);assert.match(html,/差分と成果を保持/);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}));
