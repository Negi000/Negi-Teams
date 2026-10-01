import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { setup, origin, git } from "./helpers/taskAuthoringFixture.ts";
import { LocalIntegrationExecutionService } from "../src/server/orchestration/integrationExecution.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { createIntegrationHttp } from "../src/server/orchestration/integrationHttp.ts";
import { integrationPageHtml } from "../src/server/orchestration/integrationPage.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";

async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean) { const deadline=Date.now()+90000;for(;;){const value=await read();if(done(value))return value;assert.ok(Date.now()<deadline,"Observed state did not settle");await new Promise(r=>setTimeout(r,50));} }
async function predecessors(f: Awaited<ReturnType<typeof setup>>) {
  const graph=await f.authoring.proposeDecomposition("docs-project",{title:"Two docs",objective:"Prepare independently",coordination:["Keep the same base"],nodes:[
   {key:"guide",dependsOn:[],handoff:"Guide",task:{...f.fields,title:"操作案内",allowedPaths:["docs/guide.txt"]}},
   {key:"checks",dependsOn:[],handoff:"Checks",task:{...f.fields,title:"確認手順",allowedPaths:["docs/checks.txt"]}}
  ]},{...origin,callId:"integration-ui-predecessors"});
  const ids=[];for(const d of graph)ids.push((await f.authoring.finalize(d.id,d.hash,randomUUID())).runId!);
  for(const id of ids){const v=await f.tasks.snapshot(id);await f.tasks.start(id,v.configSha256,randomUUID())}
  for(const id of ids)assert.equal((await until(()=>f.tasks.snapshot(id),v=>!v.live&&v.status!=="queued")).status,"ready_for_review");
  return ids;
}

test("normal integration HTTP creates only its own worktree, preserves sources, stops queued work, restores without replay and resumes into signed review/baseline",async()=>{
 const f=await setup();let service:LocalIntegrationExecutionService|null=null,restoredTasks:LocalTaskService|null=null;
 try{
  const reviews=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[],cases:[]});await f.tasks.connectReviews(reviews);
  const ids=await predecessors(f);
  const originalHead=git(f.repo,["rev-parse","HEAD"]),originalStatus=git(f.repo,["status","--porcelain"]);
  const sourcePins=await Promise.all(ids.map(async id=>{const v=await f.tasks.snapshot(id);return{checkout:v.checkout,status:git(v.checkout,["status","--porcelain"]),index:git(v.checkout,["diff","--cached"])};}));
  const scheduler=new FileScheduler(f.config.schedulerPath);
  await scheduler.append({key:"test-one-worker",at:new Date().toISOString(),action:{type:"set_capacity",capacity:{maxConcurrent:2,planners:1,workers:1},sourceRef:"user:fixture-one-worker"}});
  await scheduler.append({key:"hold-worker",at:new Date().toISOString(),action:{type:"submit",work:{id:"held-worker",parentId:null,dependencies:[],role:"sol",checkout:f.repo,checkoutMode:"write",resources:[],reserveUsd:0}}});await scheduler.claim("held-worker","claim-held-worker");
  service=await LocalIntegrationExecutionService.open(f.authoring,f.tasks,reviews);
  const preview=await service.preview("docs-project",ids),request=randomUUID();
  assert.deepEqual(preview.paths,["docs/checks.txt","docs/guide.txt"]);assert.equal(preview.verification.length,1);
  await assert.rejects(service.preview("docs-project",[ids[0],ids[0]]));await assert.rejects(service.preview("foreign",ids));
  await assert.rejects(service.start("docs-project",ids,"f".repeat(64),randomUUID()));
  const first=await service.start("docs-project",ids,preview.hash,request);assert.equal(first.status,"queued");assert.equal(first.live,true);
  assert.equal((await service.start("docs-project",ids,preview.hash,request)).id,first.id);
  assert.equal((await service.start("docs-project",ids,preview.hash,randomUUID())).id,first.id);
  await assert.rejects(service.start("docs-project",[ids[0],"template"],preview.hash,request));
  assert.equal(await lstat(join(f.root,"worktrees",first.id)).then(()=>true),true);assert.equal((await readdir(join(f.root,"authoring","integrations",first.id))).includes("output"),false);
  await assert.rejects(service.stop(first.id,"f".repeat(64),randomUUID()));assert.equal((await service.stop(first.id,first.hash,randomUUID())).status,"cancelled");
  const second=await service.start("docs-project",ids,preview.hash,randomUUID());assert.notEqual(second.id,first.id);assert.equal(second.status,"queued");
  await service.close();service=await LocalIntegrationExecutionService.open(f.authoring,f.tasks,reviews);
  const restored=await service.snapshot(second.id);assert.equal(restored.live,false);assert.equal(restored.canResume,true);
  assert.equal((await readdir(join(f.root,"authoring","integrations",second.id))).includes("output"),false);
  const other=await LocalIntegrationExecutionService.open(f.authoring,f.tasks,reviews),append=FileScheduler.prototype.append;
  const register=reviews.registerPinnedResult.bind(reviews);let registered=()=>{},releaseRegistration=()=>{};
  const registrationBarrier=new Promise<void>(r=>registered=r),registrationGate=new Promise<void>(r=>releaseRegistration=r);
  reviews.registerPinnedResult=async(...args:Parameters<typeof register>)=>{if(args[0].id.startsWith("integration-")){registered();await registrationGate}return register(...args)};
  let arrived=()=>{},release=()=>{};const barrier=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
  FileScheduler.prototype.append=async function(event){if(event.action.type==="settle"&&event.action.workId===second.id){arrived();await gate}return append.call(this,event)};
  const auth={token:"integration-fixture-cookie"};const handler=createIntegrationHttp(service,auth);
  const http=createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url!,"http://localhost"))){res.writeHead(404);res.end()}});await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));
  try{
   const url=`http://127.0.0.1:${(http.address()as import("node:net").AddressInfo).port}`,cookie={Cookie:"ebi_auth="+auth.token};
   assert.equal((await fetch(url+"/api/integrations")).status,401);assert.equal((await fetch(url+"/integrations",{redirect:"manual"})).status,302);
   assert.equal((await fetch(url+"/integrations",{headers:cookie})).status,200);
   assert.equal((await fetch(url+"/api/integrations/preview",{method:"POST",headers:{...cookie,"Content-Type":"application/json"},body:JSON.stringify({profileId:"docs-project",sourceRunIds:ids})})).status,403);
   const headers={...cookie,Origin:url,"Content-Type":"application/json"};
   assert.equal((await fetch(url+"/api/integrations/start",{method:"POST",headers,body:JSON.stringify({profileId:"docs-project",sourceRunIds:ids,expectedHash:preview.hash,requestId:randomUUID(),checkout:f.repo})})).status,409);
   const details=await fetch(url+"/api/integrations/"+second.id,{headers:cookie});assert.equal(details.status,200);assert.equal((await details.json()).canResume,true);
   await scheduler.append({key:"release-worker",at:new Date().toISOString(),action:{type:"settle",workId:"held-worker",outcome:"verified",evidenceRef:"local:verified-held-fixture",actualCostUsd:null}});
   const resume=await fetch(url+"/api/integrations/"+second.id+"/resume",{method:"POST",headers,body:JSON.stringify({expectedHash:second.hash,requestId:randomUUID()})});assert.equal(resume.status,200);
   await barrier;let stopDone=false;
   const lateStop=other.stop(second.id,second.hash,randomUUID()).then(()=>null,error=>error).finally(()=>stopDone=true);
   await new Promise(r=>setTimeout(r,50));assert.equal(stopDone,false,"Stop must wait behind the final settlement lock");release();
   assert.match(String(await lateStop),/already settled/);
   assert.equal(await lstat(join(f.root,"authoring","integrations",second.id,"stop-request.json")).then(()=>true).catch(()=>false),false);
   await registrationBarrier;const publishing=await service.snapshot(second.id);
   assert.equal(publishing.status,"verifying");assert.equal(publishing.reviewId,null);assert.equal(publishing.live,true);releaseRegistration();
  }finally{release();releaseRegistration();reviews.registerPinnedResult=register;FileScheduler.prototype.append=append;await other.close();await new Promise<void>((r,j)=>http.close(e=>e?j(e):r()))}
  const settled=await until(()=>service!.snapshot(second.id),v=>!v.live&&v.status!=="queued");assert.equal(settled.status,"ready_for_review",await readFile(join(f.root,"authoring","integrations",second.id,"error.json"),"utf8").catch(()=>JSON.stringify(settled)));assert.ok(settled.reviewId);assert.equal(settled.error,null);
  const review=await reviews.snapshot(settled.reviewId!);assert.equal(review.status,"awaiting_review");assert.equal(review.canAccept,true);assert.equal(review.integration?.sources.length,2);
  const integrationCheckout=join(f.root,"worktrees",second.id);assert.equal((await readFile(join(integrationCheckout,"docs/guide.txt"),"utf8")).trim(),"approved fixture result");
  await reviews.accept(review.id,review.artifactSha256,randomUUID());const base=(await reviews.snapshot(review.id)).integration!.baselines![0];
  const published=await f.authoring.publishIntegrationBase("docs-project",base.id,review.artifactSha256,randomUUID());assert.notEqual(published.baseSha,originalHead);
  assert.equal(git(f.repo,["rev-parse","HEAD"]),originalHead);assert.equal(git(f.repo,["status","--porcelain"]),originalStatus);
  for(const p of sourcePins){assert.equal(git(p.checkout,["status","--porcelain"]),p.status);assert.equal(git(p.checkout,["diff","--cached"]),p.index)}assert.deepEqual(f.calls(),{astra:0,sol:2});
  await service.close();service=await LocalIntegrationExecutionService.open(f.authoring,f.tasks,reviews);assert.equal((await service.snapshot(second.id)).status,"ready_for_review");assert.equal((await reviews.snapshot(review.id)).status,"accepted");
  await service.close();
  await f.tasks.close();restoredTasks=await LocalTaskService.open(f.catalog,f.runtime);await restoredTasks.connectReviews(reviews);
  const originalProfile=f.authoring.integrationConfiguration().profiles[0],newProfile={...originalProfile,id:"new-conditions",title:"新しい条件",active:true,allowedPaths:["docs/checks.txt"]};
  const historical=await LocalTaskAuthoringService.open({storageRoot:f.authoringConfig.storageRoot,strictProfileHistory:true,
    profiles:[{...originalProfile,active:false},newProfile,{...originalProfile,id:"other-project",project:"foreign-project",active:true}]},restoredTasks);
  service=await LocalIntegrationExecutionService.open(historical,restoredTasks,reviews);
  assert.equal((await service.snapshot(second.id)).reviewId,review.id);assert.equal((await reviews.snapshot(review.id)).status,"accepted");
  assert.deepEqual(await historical.integrationBase("docs-project",published.id),published);
  assert.equal((await reviews.snapshot(review.id)).integration!.baselines!.find(b=>b.profileId==="docs-project")!.canPublish,false);
  assert.ok(!(await reviews.snapshot(review.id)).integration!.baselines!.some(b=>b.profileId==="new-conditions"),"Narrowed scope cannot inherit the wider integration");
  assert.ok(!(await reviews.snapshot(review.id)).integration!.baselines!.some(b=>b.profileId==="other-project"),"Another logical project cannot inherit this integration");
  await assert.rejects(historical.publishIntegrationBase("docs-project",published.id,review.artifactSha256,randomUUID()),/retired/);
  assert.equal((await service.overview()).profileId,"new-conditions");
  const events=(await scheduler.read()).events;assert.equal(events.filter(e=>e.action.type==="claim"&&e.action.workId===second.id).length,1);assert.equal(events.filter(e=>e.action.type==="claim"&&e.action.workId===first.id).length,0);
 }finally{await service?.close();await restoredTasks?.close();await f.close()}
});

test("another server can stop preflight without poisoning retry and stop a running verification without publishing",async()=>{
 const f=await setup(root=>[{requirement:"runtime available",program:process.execPath,args:["-e",
  `if(require('node:path').basename(process.cwd()).startsWith('integration-')){require('node:fs').writeFileSync(${JSON.stringify(join(root,"verifying.marker"))},'ready');setTimeout(()=>{},10000)}`],timeoutMs:15000}]);
 let a:LocalIntegrationExecutionService|null=null,b:LocalIntegrationExecutionService|null=null,release=()=>{};
 try{
  const reviews=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[],cases:[]});await f.tasks.connectReviews(reviews);
  const ids=await predecessors(f);a=await LocalIntegrationExecutionService.open(f.authoring,f.tasks,reviews);b=await LocalIntegrationExecutionService.open(f.authoring,f.tasks,reviews);
  const preview=await a.preview("docs-project",ids),request=randomUUID(),id="integration-"+request;
  let captured=false,arrived=()=>{};const barrier=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r),original=f.tasks.integrationSource.bind(f.tasks);
  f.tasks.integrationSource=async(...args:Parameters<typeof original>)=>{
   if(!captured&&await lstat(join(f.root,"authoring","integrations",id,"dispatch.lock")).then(()=>true).catch(()=>false)){captured=true;arrived();await gate}
   return original(...args);
  };
  await a.start("docs-project",ids,preview.hash,request);await barrier;
  assert.equal((await b.stop(id,preview.hash,randomUUID())).status,"cancelled");release();
  const cancelled=await until(()=>a!.snapshot(id),v=>!v.live);assert.equal(cancelled.error,null);assert.equal(cancelled.status,"cancelled");
  f.tasks.integrationSource=original;
  const retry=await a.start("docs-project",ids,preview.hash,randomUUID());assert.notEqual(retry.id,id);
  await until(()=>lstat(join(f.root,"verifying.marker")).then(()=>true).catch(()=>false),v=>v);
  await b.stop(retry.id,retry.hash,randomUUID());
  const held=await until(()=>a!.snapshot(retry.id),v=>!v.live);assert.equal(held.status,"needs_reconciliation");assert.equal(held.reviewId,null);
  assert.equal(await lstat(join(f.root,"authoring","integrations",retry.id,"result.json")).then(()=>true).catch(()=>false),false);
  assert.equal((await new FileScheduler(f.config.schedulerPath).read()).state?.entries.find(e=>e.work.id===retry.id)?.status,"needs_reconciliation");
  assert.equal((await readFile(join(f.root,"worktrees",retry.id,"docs/guide.txt"),"utf8")).trim(),"approved fixture result");
 }finally{release();await a?.close();await b?.close();await f.close()}
});

test("integration page ships parseable script and no configuration mutation in the browser",()=>{
 const html=integrationPageHtml();for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(script[1]);
 assert.match(html,/統合して検証/);assert.doesNotMatch(html,/program:|worktreeRoot|storageRoot/);
});
