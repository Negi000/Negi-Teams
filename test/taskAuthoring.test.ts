import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { test } from "node:test";
import { LocalTaskAuthoringService, type TaskPlanFields } from "../src/server/orchestration/taskAuthoring.ts";
import { createTaskAuthoringHttp } from "../src/server/orchestration/taskAuthoringHttp.ts";
import { taskPlanPageHtml } from "../src/server/orchestration/taskPlanPage.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { registeredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import { loadApprovedTaskPlan } from "../src/server/orchestration/approvedTaskPlan.ts";
import { loadVaultTaskContract, runSingleTaskFromVault } from "../src/server/orchestration/vaultTaskContract.ts";
import { submitVaultRun, verifyVaultRun, type PreparedVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { runScheduledVaultTask } from "../src/server/orchestration/scheduledVaultRun.ts";
import { FileTaskLedger, reduceTask } from "../src/server/orchestration/singleTask.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import type { SingleTaskClient } from "../src/server/orchestration/singleTaskRunner.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { LocalIntegrationReviewService } from "../src/server/orchestration/integrationReviewService.ts";
import { integrateVerifiedTasks } from "../src/server/orchestration/taskIntegration.ts";
import type { IntegrationReviewOptions } from "../src/server/orchestration/integrationReview.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { createHash } from "node:crypto";
import { taskDecomposition, type TaskDecompositionFields } from "../src/server/orchestration/taskDecomposition.ts";

import { setup, planner, origin, requestOrigin, git, note } from "./helpers/taskAuthoringFixture.ts";

test("resident Astra drafts once, concrete approval writes Vault and isolated run, direct Sol runs once",async()=>{
  const f=await setup();try{
    const tools=registeredTaskTools(f.tasks,origin.masterId,{service:f.authoring,planner});
    const call={threadId:origin.threadId,turnId:origin.turnId,callId:origin.callId,tool:"negi_propose_task",arguments:{profile_id:"docs-project",task:f.fields}};
    const proposal=await tools.invoke(call);assert.equal(proposal.success,true);const value=JSON.parse(proposal.text);
    assert.equal(value.executionStarted,false);assert.match(value.url,/^\/task-plans\?draft=/);
    assert.equal(JSON.parse((await tools.invoke(call)).text).draftId,value.draftId);
    assert.equal(f.tasks.list().length,1);assert.equal((await readdir(join(f.vault,"80_Tasks"))).length,1);assert.equal((await readdir(join(f.root,"worktrees"))).length,0);
    const approvalId=randomUUID(),draft=(await f.authoring.list())[0];
    const approved=await f.authoring.finalize(draft.id,draft.hash,approvalId);assert.equal(approved.status,"registered");assert.ok(approved.runId);assert.equal(f.tasks.list().length,2);
    const initial=await f.tasks.snapshot(approved.runId!);assert.equal(initial.status,"not_started");assert.equal(initial.acceptedBy,null);assert.notEqual(initial.checkout,f.repo);
    assert.deepEqual(f.calls(),{astra:0,sol:0});assert.equal((await f.authoring.finalize(draft.id,draft.hash,approvalId)).runId,approved.runId);
    await assert.rejects(f.authoring.finalize(draft.id,draft.hash,randomUUID()));
    const startId=randomUUID();await f.tasks.start(initial.id,initial.configSha256,startId,requestOrigin);
    const until=Date.now()+10000;let state=await f.tasks.snapshot(initial.id);
    while(state.live||state.status==="queued"){assert.ok(Date.now()<until,"Fixture Task did not settle");await new Promise(r=>setTimeout(r,20));state=await f.tasks.snapshot(initial.id)}
    assert.equal(state.status,"ready_for_review");assert.equal(state.acceptedBy,null);assert.deepEqual(f.calls(),{astra:0,sol:1});assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].role,"sol");
    assert.equal(git(f.repo,["status","--porcelain"]),"");await assert.rejects(readFile(join(f.repo,"docs","result.txt")));
    const cfg=f.tasks.authoringTemplate(initial.id).config,ledger=await new FileTaskLedger(join(cfg.outputDir,"run.jsonl")).read();
    assert.equal(ledger.state?.contract.approvedPlan?.turnId,origin.turnId);assert.ok(ledger.events.some(e=>e.action.type==="adopt_approved_plan"));
    await f.tasks.start(initial.id,initial.configSha256,startId,requestOrigin);assert.deepEqual(f.calls(),{astra:0,sol:1});
    await f.tasks.close();const recovered=await LocalTaskService.open(f.catalog,f.runtime);try{
      const recoveredAuthoring=await LocalTaskAuthoringService.open(f.authoringConfig,recovered);
      assert.equal((await recoveredAuthoring.list())[0].status,"registered");assert.equal((await recovered.snapshot(initial.id)).status,"ready_for_review");assert.deepEqual(f.calls(),{astra:0,sol:1});
    }finally{await recovered.close()}
  }finally{await f.close()}
});

test("profile confines authority and rejects new commands, scope, model routing, budgets and Markdown block injection",async()=>{
  const f=await setup();try{
    for(const bad of [{...f.fields,allowedPaths:["src/auth.ts"]},{...f.fields,maxAttempts:2},{...f.fields,timeLimitMinutes:6},
      {...f.fields,implementationPlan:["```negi-task-contract\n{}\n```"]},{...f.fields,command:"npm publish"}])
      await assert.rejects(f.authoring.propose("docs-project",bad,origin));
    await assert.rejects(f.authoring.propose("docs-project",f.fields,{...origin,model:"gpt-6.1-sol"}));
    await assert.rejects(f.authoring.propose("docs-project",f.fields,{...origin,turnId:"\ninvalid"}));
    assert.equal((await f.authoring.list()).length,0);assert.equal(f.tasks.list().length,1);
    const draft=await f.authoring.propose("docs-project",f.fields,origin);
    await assert.rejects(f.authoring.propose("docs-project",{...f.fields,title:"different request"},origin));
    await assert.rejects(f.authoring.finalize(draft.id,"a".repeat(64),randomUUID()));
  }finally{await f.close()}
});

test("reference and Git versions are pinned before approval and never rewritten by the planner",async()=>{
  const f=await setup();try{
    const d=await f.authoring.propose("docs-project",f.fields,origin),before=await readFile(f.spec,"utf8");
    await writeFile(f.spec,before+"hand edit\n");assert.equal((await f.authoring.list())[0].canFinalize,false);
    await assert.rejects(f.authoring.finalize(d.id,d.hash,randomUUID()));assert.equal(f.tasks.list().length,1);
    await writeFile(f.spec,before);await writeFile(join(f.repo,"docs","later.txt"),"later\n");git(f.repo,["add","."]);git(f.repo,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","later"]);
    assert.equal((await f.authoring.list())[0].canFinalize,false);await assert.rejects(f.authoring.finalize(d.id,d.hash,randomUUID()));
    assert.equal((await readdir(join(f.vault,"80_Tasks"))).length,1);
  }finally{await f.close()}
});

test("existing worktree destination holds signed approval without adopting foreign files or auto retry",async()=>{
  const f=await setup();try{
    const d=await f.authoring.propose("docs-project",f.fields,origin),destination=join(f.root,"worktrees",`task-${d.id}`);await mkdir(destination);await writeFile(join(destination,"owned-by-user.txt"),"preserve\n");
    const approvalId=randomUUID();await assert.rejects(f.authoring.finalize(d.id,d.hash,approvalId));
    const current=(await f.authoring.list())[0];assert.equal(current.status,"attention");assert.equal(current.canFinalize,false);assert.equal(f.tasks.list().length,1);
    assert.equal((await f.authoring.finalize(d.id,d.hash,approvalId)).status,"attention");
    await f.tasks.close();const tasks=await LocalTaskService.open(f.catalog,f.runtime);try{
      const recovered=await LocalTaskAuthoringService.open(f.authoringConfig,tasks);assert.equal((await recovered.list())[0].status,"attention");assert.equal(tasks.list().length,1);
      assert.equal(await readFile(join(destination,"owned-by-user.txt"),"utf8"),"preserve\n");assert.deepEqual(f.calls(),{astra:0,sol:0});
    }finally{await tasks.close()}
  }finally{await f.close()}
});

test("signed snapshot, authority and profile changes prevent dispatch or recovery of an altered run",async()=>{
  const f=await setup();try{
    const d=await f.authoring.propose("docs-project",f.fields,origin),v=await f.authoring.finalize(d.id,d.hash,randomUUID());
    const config=f.tasks.authoringTemplate(v.runId!).config,contract=await loadVaultTaskContract(config.vault,config.snapshot,config.checkout);
    await assert.rejects(loadApprovedTaskPlan({...config,sol:{...config.sol,model:"different-model"}},contract));
    await assert.rejects(loadApprovedTaskPlan(config,{...contract,acceptance:["forged"]}));
    const receiptPath=join(config.approvedPlan!.proofDirectory,config.approvedPlan!.requestId+".json"),bytes=await readFile(receiptPath,"utf8"),envelope=JSON.parse(bytes);envelope.receipt.data.plan="forged";await writeFile(receiptPath,JSON.stringify(envelope));
    await assert.rejects(loadApprovedTaskPlan(config,contract));await writeFile(receiptPath,bytes);
    await f.tasks.close();const tasks=await LocalTaskService.open(f.catalog,f.runtime);try{
      const changed=structuredClone(f.authoringConfig);changed.profiles[0].allowedPaths=["docs/base.txt"];
      const recovered=await LocalTaskAuthoringService.open(changed,tasks);assert.equal((await recovered.list())[0].canFinalize,false);assert.equal(tasks.list().length,1);
    }finally{await tasks.close()}
  }finally{await f.close()}
});

test("lost approval pointer is recovered as pending authority; no automatic creation or model dispatch",async()=>{
  const f=await setup();try{
    const d=await f.authoring.propose("docs-project",f.fields,origin),v=await f.authoring.finalize(d.id,d.hash,randomUUID());
    await unlink(join(f.root,"authoring","runs",v.runId!,"approval.json"));
    assert.equal((await f.authoring.list())[0].status,"registered");
    await f.tasks.close();const tasks=await LocalTaskService.open(f.catalog,f.runtime);try{
      const recovered=await LocalTaskAuthoringService.open(f.authoringConfig,tasks);assert.equal((await recovered.list())[0].status,"registered");assert.equal(tasks.list().length,2);assert.deepEqual(f.calls(),{astra:0,sol:0});
    }finally{await tasks.close()}
  }finally{await f.close()}
});

test("concurrent server instances publish one draft for the same planner call",async()=>{
  const f=await setup();try{
    const second=await LocalTaskAuthoringService.open(f.authoringConfig,f.tasks);
    const drafts=await Promise.all([f.authoring.propose("docs-project",f.fields,origin),second.propose("docs-project",f.fields,origin)]);
    assert.equal(drafts[0].id,drafts[1].id);assert.equal(drafts[0].hash,drafts[1].hash);assert.equal((await f.authoring.list()).length,1);
    assert.equal(f.tasks.list().length,1);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});

test("separate server writers cannot approve the same draft twice and stale locks do not authorize replay",async()=>{
  const f=await setup();try{
    const d=await f.authoring.propose("docs-project",f.fields,origin),second=await LocalTaskAuthoringService.open(f.authoringConfig,f.tasks);
    const attempts=await Promise.allSettled([f.authoring.finalize(d.id,d.hash,randomUUID()),second.finalize(d.id,d.hash,randomUUID())]);
    assert.equal(attempts.filter(a=>a.status==="fulfilled").length,1);assert.equal(f.tasks.list().length,2);
    assert.equal((await readdir(join(f.root,"authoring","approvals"))).filter(n=>n.endsWith(".json")).length,1);
    const next=await f.authoring.propose("docs-project",{...f.fields,title:"別の契約案"},{...origin,callId:"next-call"});
    await writeFile(join(f.root,"authoring","writer.lock"),"stale writer evidence\n");
    assert.equal((await f.authoring.list()).find(v=>v.id===next.id)?.canFinalize,false);
    await assert.rejects(f.authoring.finalize(next.id,next.hash,randomUUID()));assert.equal(f.tasks.list().length,2);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});

test("approval API requires cookie, same origin and exact draft hash; response retry never executes a Task",async()=>{
  const f=await setup(),handler=createTaskAuthoringHttp(f.authoring,{token:"fixture-token"});
  const server=createServer(async(req,res)=>{try{if(!await handler(req,res,new URL(req.url!,"http://fixture"))){res.writeHead(404);res.end()}}catch{res.writeHead(500);res.end()}});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  try{
    const d=await f.authoring.propose("docs-project",f.fields,origin),path=base+`/api/task-plans/${d.id}/finalize`,requestId=randomUUID();
    const options={method:"POST",headers:{"Content-Type":"application/json",Cookie:"ebi_auth=fixture-token",Origin:base},body:JSON.stringify({expectedHash:d.hash,requestId})};
    assert.equal((await fetch(base+"/api/task-plans")).status,401);
    assert.equal((await fetch(path,{...options,headers:{...options.headers,Origin:"https://evil.example"}})).status,403);
    assert.equal((await fetch(path,{...options,headers:{...options.headers,Cookie:""}})).status,401);
    assert.equal((await fetch(path,{...options,body:JSON.stringify({expectedHash:d.hash,requestId,checkout:"arbitrary"})})).status,409);
    const response=await fetch(path,options);assert.equal(response.status,200);assert.equal((await response.json()).status,"registered");
    assert.equal((await fetch(path,options)).status,200);assert.equal(f.tasks.list().length,2);assert.deepEqual(f.calls(),{astra:0,sol:0});
    assert.equal((await fetch(path,{headers:options.headers})).status,405);
    const page=await fetch(base+"/task-plans",{headers:{Cookie:"ebi_auth=fixture-token"}});assert.equal(page.status,200);assert.match(await page.text(),/この契約を確定/);
    const group=await f.authoring.proposeDecomposition("docs-project",decomposition(f.fields),{...origin,callId:"api-graph"});
    const successor=group.find(d=>d.status==="waiting_dependencies")!;
    assert.equal((await fetch(base+`/api/task-plans/${successor.id}/finalize`,{...options,body:JSON.stringify({expectedHash:successor.hash,requestId:randomUUID()})})).status,409);
    const catalog=await fetch(base+"/api/task-plans",{headers:options.headers});assert.equal(catalog.status,200);
    assert.equal((await catalog.json()).find((d:{id:string})=>d.id===successor.id).canFinalize,false);assert.equal(f.tasks.list().length,2);
    for(const script of taskPlanPageHtml().matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(script[1]);
  }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));await f.close()}
});

test("unapproved plan adoption cannot bypass the ledger state machine",()=>{
  const contract={vaultId:"id",version:1,sha256:"a".repeat(64),project:"fixture",objective:"test",acceptance:["test"],baseSha:"b".repeat(40)};
  const state=reduceTask(null,{key:"create",at:new Date().toISOString(),action:{type:"create",runId:"test",contract}});
  assert.throws(()=>reduceTask(state,{key:"forged-plan",at:new Date().toISOString(),action:{type:"adopt_approved_plan",approvalRef:"user:http-task-plan:forged",outputRef:"plan#sha256="+"a".repeat(64)}}));
});

function decomposition(fields:TaskPlanFields):TaskDecompositionFields {
  return {title:"案内と確認手順を用意する",objective:"二つの独立文書を準備してから統合した案内を作る",coordination:["既存文書を保ち、各文書の用語を揃える"],nodes:[
    {key:"guide",dependsOn:[],handoff:"単独で読める案内文書",task:{...fields,title:"使い方の案内"}},
    {key:"checks",dependsOn:[],handoff:"確認できる項目の一覧",task:{...fields,title:"確認手順",allowedPaths:["docs/checks.txt"]}},
    {key:"combined",dependsOn:["guide","checks"],handoff:"二つの成果を統合した版で案内を更新する",task:{...fields,title:"統合後の案内"}},
  ]};
}

test("decomposition validates cycles, missing edges, disjoint writers and bounded authority before publication",async()=>{
  const f=await setup();try{
    const good=decomposition(f.fields);
    const bad=[
      {...good,nodes:good.nodes.map(n=>n.key==="guide"?{...n,dependsOn:["combined"]}:n)},
      {...good,nodes:good.nodes.map(n=>n.key==="combined"?{...n,dependsOn:["missing"]}:n)},
      {...good,nodes:good.nodes.map(n=>n.key==="guide"?{...n,dependsOn:["guide"]}:n)},
      {...good,nodes:good.nodes.map(n=>n.key==="checks"?{...n,task:{...n.task,allowedPaths:["docs/result.txt"]}}:n)},
      {...good,nodes:good.nodes.map(n=>n.key==="checks"?{...n,task:{...n.task,allowedPaths:["docs/result.txt/sub"]}}:n)},
      {...good,nodes:[...good.nodes,good.nodes[0]]},
      {...good,nodes:[good.nodes[0]]},
      {...good,nodes:good.nodes.map(n=>({...n,task:{...n.task,command:"publish"}}))},
      {...good,nodes:good.nodes.map(n=>({...n,task:{...n.task,maxAttempts:2}}))},
      {...good,execute:true},
    ];
    for(const raw of bad)await assert.rejects(f.authoring.proposeDecomposition("docs-project",raw,origin));
    assert.throws(()=>taskDecomposition({...good,nodes:[good.nodes[0],{...good.nodes[1],task:{...f.fields,allowedPaths:["DOCS/RESULT.TXT"]}}]},raw=>raw as TaskPlanFields),/overlap/);
    await assert.rejects(f.authoring.proposeDecomposition("docs-project",good,{...origin,model:"gpt-6.1-sol"}));
    assert.equal((await f.authoring.list()).length,0);assert.equal((await readdir(join(f.root,"authoring","decompositions"))).length,0);
    assert.equal(f.tasks.list().length,1);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});

test("native decomposition publishes one graph, roots use the same direct Sol execution, successors never dispatch at the old base",async()=>{
  const f=await setup();try{
    const tools=registeredTaskTools(f.tasks,origin.masterId,{service:f.authoring,planner});
    const call={threadId:origin.threadId,turnId:origin.turnId,callId:origin.callId,tool:"negi_propose_task_decomposition",arguments:{profile_id:"docs-project",decomposition:decomposition(f.fields)}};
    for (const field of ["key", "dependsOn"] as const) {
      const invalid = structuredClone(call);
      if (field === "key") invalid.arguments.decomposition.nodes[1].key = "private_value_123";
      else invalid.arguments.decomposition.nodes[1].dependsOn = ["private_value_123"];
      const rejected = await tools.invoke(invalid), diagnosis = JSON.parse(rejected.text);
      assert.equal(rejected.success, false); assert.equal(diagnosis.code, "invalid_decomposition_key");
      assert.equal(diagnosis.field, `decomposition.nodes[1].${field}`);
      assert.equal(diagnosis.saved, false); assert.equal(diagnosis.executionStarted, false);
      assert.equal(diagnosis.noAutomaticRetry, true); assert.ok(!rejected.text.includes("private_value_123"));
      assert.equal((await f.authoring.list()).length, 0);
      assert.equal((await readdir(join(f.root,"authoring","decompositions"))).length, 0);
      assert.equal(f.tasks.list().length, 1); assert.deepEqual(f.calls(), { astra: 0, sol: 0 });
    }
    const response=await tools.invoke(call);assert.equal(response.success,true);const result=JSON.parse(response.text);
    assert.equal(result.tasks.length,3);assert.equal(result.executionStarted,false);assert.equal(result.successorsRequireNewPlanAfterIntegration,true);
    assert.deepEqual(JSON.parse((await tools.invoke(call)).text),result);
    assert.equal(registeredTaskTools(f.tasks,origin.masterId).definitions.some(d=>d.name===call.tool),false);
    let rows=await f.authoring.list();const roots=rows.filter(d=>d.canFinalize),successor=rows.find(d=>d.decomposition?.key==="combined")!;
    assert.equal(roots.length,2);assert.equal(successor.status,"waiting_dependencies");assert.equal(successor.canFinalize,false);
    await assert.rejects(f.authoring.finalize(successor.id,successor.hash,randomUUID()),/Successor/);
    assert.equal((await readdir(join(f.root,"authoring","approvals"))).filter(n=>n.endsWith(".json")).length,0);
    const rootTasks=[];
    for(const root of roots){
      const view=await f.authoring.finalize(root.id,root.hash,randomUUID()),task=await f.tasks.snapshot(view.runId!);
      const config=f.tasks.authoringTemplate(view.runId!).config;
      assert.match(await readFile(join(f.vault,"80_Tasks",task.taskId+".md"),"utf8"),/元の依頼と分解/);
      assert.equal(config.schedulerPath,f.config.schedulerPath);assert.equal(task.baseSha,git(f.repo,["rev-parse","HEAD"]));
      if(!rootTasks.length){assert.equal(task.canStart,false);assert.match(task.error!,/すべて確定/);
        await assert.rejects(f.tasks.start(task.id,task.configSha256,randomUUID(),requestOrigin),/cannot be dispatched/);
        assert.equal((await f.tasks.snapshot(task.id)).status,"not_started");}
      rootTasks.push(task);
    }
    for(const task of rootTasks)await f.tasks.start(task.id,task.configSha256,randomUUID(),requestOrigin);
    const deadline=Date.now()+60000;let tasks;
    do{tasks=await Promise.all(f.tasks.list().map(t=>f.tasks.snapshot(t.id)));if(tasks.filter(t=>t.id!=="template").every(t=>t.status==="ready_for_review"))break;await new Promise(r=>setTimeout(r,50))}while(Date.now()<deadline);
    assert.equal(tasks!.filter(t=>t.id!=="template").length,2);
    assert.deepEqual(tasks!.filter(t=>t.id!=="template").map(t=>[t.status,t.acceptedBy]),[["ready_for_review",null],["ready_for_review",null]],"Both isolated roots must reach review without human acceptance");
    assert.deepEqual(f.calls(),{astra:0,sol:2});assert.equal(git(f.repo,["status","--porcelain"]),"");
    // Successful predecessors alone do not supply their code into the successor checkout.
    await assert.rejects(f.authoring.finalize(successor.id,successor.hash,randomUUID()),/Successor/);
    await f.tasks.close();const tasks2=await LocalTaskService.open(f.catalog,f.runtime);try{
      const recovered=await LocalTaskAuthoringService.open(f.authoringConfig,tasks2);rows=await recovered.list();
      assert.equal(rows.filter(r=>r.status==="registered").length,2);assert.equal(rows.find(r=>r.id===successor.id)?.status,"waiting_dependencies");
      assert.equal(tasks2.list().length,3);assert.deepEqual(f.calls(),{astra:0,sol:2});
    }finally{await tasks2.close()}
  }finally{await f.close()}
});

test("separate graph publishers deduplicate the actual call and reject single/graph reuse and changed approval sources",async()=>{
  const f=await setup();try{
    const second=await LocalTaskAuthoringService.open(f.authoringConfig,f.tasks),input=decomposition(f.fields);
    const [a,b]=await Promise.all([f.authoring.proposeDecomposition("docs-project",input,origin),second.proposeDecomposition("docs-project",input,origin)]);
    assert.deepEqual(a,b);assert.equal((await readdir(join(f.root,"authoring","decompositions"))).length,1);assert.equal((await f.authoring.list()).length,3);
    await assert.rejects(f.authoring.propose("docs-project",f.fields,origin));
    await assert.rejects(f.authoring.proposeDecomposition("docs-project",{...input,title:"different"},origin));
    const root=a.find(d=>d.canFinalize)!;
    await writeFile(f.spec,(await readFile(f.spec,"utf8"))+"\nNew requirement.\n");
    assert.equal((await f.authoring.list()).find(d=>d.id===root.id)?.status,"attention");
    await assert.rejects(f.authoring.finalize(root.id,root.hash,randomUUID()));
    assert.equal(f.tasks.list().length,1);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});

test("new repository base and graph tampering hold all unapproved children without partial contracts",async()=>{
  const f=await setup();try{
    const drafts=await f.authoring.proposeDecomposition("docs-project",decomposition(f.fields),origin),root=drafts.find(d=>d.canFinalize)!;
    await writeFile(join(f.repo,"docs","base.txt"),"integrated base\n");git(f.repo,["add","docs/base.txt"]);
    git(f.repo,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","integrated fixture"]);
    assert.equal((await f.authoring.list()).filter(d=>d.status==="attention").length,3);
    await assert.rejects(f.authoring.finalize(root.id,root.hash,randomUUID()));
    const path=join(f.root,"authoring","decompositions",root.decomposition!.id+".json"),raw=JSON.parse(await readFile(path,"utf8"));
    raw.fields.nodes[2].dependsOn=[];await writeFile(path,JSON.stringify(raw));await assert.rejects(f.authoring.list(),/integrity/);
    assert.equal((await readdir(join(f.vault,"80_Tasks"))).length,1);assert.equal((await readdir(join(f.root,"worktrees"))).length,0);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});


test("reviewed integration becomes the pinned new base for native successor authoring and one Sol execution",async()=>{
 const f=await setup();try{
  const reviews=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[],cases:[]});await f.tasks.connectReviews(reviews);
  const drafts=await f.authoring.proposeDecomposition("docs-project",{title:"Two predecessors",objective:"Prepare two documents",coordination:["Preserve the original base"],nodes:[
   {key:"a",dependsOn:[],handoff:"First document",task:{...f.fields,allowedPaths:["docs/a.txt"]}},
   {key:"b",dependsOn:[],handoff:"Second document",task:{...f.fields,allowedPaths:["docs/b.txt"]}}
  ]},{...origin,callId:"predecessors"});
  const approved=[];for(const d of drafts)approved.push(await f.authoring.finalize(d.id,d.hash,randomUUID()));
  for(const d of approved){const initial=await f.tasks.snapshot(d.runId!);await f.tasks.start(initial.id,initial.configSha256,randomUUID());}
  const until=Date.now()+60000;for(const d of approved){let v=await f.tasks.snapshot(d.runId!);while(v.live||v.status==="queued"){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,20));v=await f.tasks.snapshot(d.runId!)}assert.equal(v.status,"ready_for_review")}
  const checkout=join(f.root,"integration-checkout"),baseSha=git(f.repo,["rev-parse","HEAD"]);git(f.repo,["worktree","add","--detach",checkout,baseSha]);
  const scheduler=new FileScheduler(f.config.schedulerPath),sourceIds=approved.map(d=>d.runId!);
  await scheduler.append({key:"integration-submit",at:new Date().toISOString(),action:{type:"submit",work:{id:"combined",parentId:null,dependencies:sourceIds,role:"sol",checkout,checkoutMode:"write",resources:[],reserveUsd:0}}});
  const outputDir=join(f.root,"integration-output"),sources=await Promise.all(sourceIds.map(id=>f.tasks.integrationSource(id)));
  const options={id:"combined",checkout,baseSha,outputDir,scheduler,sources,verify:async()=>{const path=join(outputDir,"command-verification.json"),bytes=Buffer.from(JSON.stringify({mechanicalChecksPassed:true,checks:[{requirement:"Both documents exist",passed:true}]}));await writeFile(path,bytes);return{outcome:"passed" as const,evidenceRef:path+"#sha256="+createHash("sha256").update(bytes).digest("hex")}}};
  const result=await integrateVerifiedTasks(options);
  const reviewOptions:IntegrationReviewOptions={...options,title:"Combined predecessor result",limits:"Synthetic only",evidenceSha256:result.evidenceRef.split("#sha256=")[1]};
  await LocalIntegrationReviewService.register([reviewOptions],reviews,f.authoring);
  const manifest=JSON.parse(await readFile(join(outputDir,"integration-review-manifest.json"),"utf8"));
  await assert.rejects(f.authoring.bindIntegration({...reviewOptions,sources:[{...sources[0],config:{...sources[0].config,vault:f.root}},sources[1]]},manifest,reviews),/protected authoring storage/);
  const id=reviews.list().find(r=>r.id.startsWith("integration-"))!.id,initial=await reviews.snapshot(id),choice=initial.integration!.baselines![0];
  await assert.rejects(f.authoring.publishIntegrationBase("docs-project",choice.id,initial.artifactSha256,randomUUID()));
  await reviews.accept(id,initial.artifactSha256,randomUUID());
  const before=git(checkout,["status","--porcelain"]),index=git(checkout,["diff","--cached"]),request=randomUUID();
  const base=await f.authoring.publishIntegrationBase("docs-project",choice.id,initial.artifactSha256,request);
  assert.notEqual(base.baseSha,baseSha);assert.equal(git(f.repo,["rev-parse","HEAD"]),baseSha);assert.equal(git(checkout,["status","--porcelain"]),before);assert.equal(git(checkout,["diff","--cached"]),index);
  assert.equal(git(f.repo,["show",base.baseSha+":docs/a.txt"]),"approved fixture result");assert.equal(git(f.repo,["show",base.baseSha+":docs/b.txt"]),"approved fixture result");
  assert.deepEqual(await f.authoring.publishIntegrationBase("docs-project",choice.id,initial.artifactSha256,request),base);
  const authoringHttp=createTaskAuthoringHttp(f.authoring,{token:"fixture-auth"}),http=createServer(async(req,res)=>{if(!await authoringHttp(req,res,new URL(req.url!,"http://localhost"))){res.writeHead(404);res.end()}});await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));
  try{
   const url=`http://127.0.0.1:${(http.address() as import("node:net").AddressInfo).port}`,path=`/api/task-plans/baselines/${base.id}`,body=JSON.stringify({profileId:"docs-project",artifactSha256:initial.artifactSha256,requestId:request});
   assert.equal((await fetch(url+path+"?profile=docs-project")).status,401);
   assert.equal((await fetch(url+path,{method:"POST",headers:{Cookie:"ebi_auth=fixture-auth","Content-Type":"application/json"},body})).status,403);
   const readable=await fetch(url+path+"?profile=docs-project",{headers:{Cookie:"ebi_auth=fixture-auth"}});assert.equal(readable.status,200);assert.equal((await readable.json()).baseSha,base.baseSha);
   assert.equal((await fetch(url+path,{method:"POST",headers:{Cookie:"ebi_auth=fixture-auth",Origin:url,"Content-Type":"application/json"},body:JSON.stringify({profileId:"docs-project",artifactSha256:"f".repeat(64),requestId:randomUUID()})})).status,409);
  }finally{await new Promise<void>((r,j)=>http.close(e=>e?j(e):r()))}
  const tools=registeredTaskTools(f.tasks,origin.masterId,{service:f.authoring,planner});
  const read=await tools.invoke({threadId:origin.threadId,turnId:origin.turnId,callId:"read-base",tool:"negi_read_project",arguments:{profile_id:"docs-project",baseline_id:base.id}});assert.equal(read.success,true);assert.equal(JSON.parse(read.text).integrationBase.baseSha,base.baseSha);
  const proposal=await tools.invoke({threadId:origin.threadId,turnId:origin.turnId,callId:"successor",tool:"negi_propose_task",arguments:{profile_id:"docs-project",baseline_id:base.id,task:f.fields}});assert.equal(proposal.success,true);
  const d=(await f.authoring.list()).find(d=>d.id===JSON.parse(proposal.text).draftId)!;assert.equal(d.baseSha,base.baseSha);assert.equal(d.integrationBase?.reviewId,id);
  await assert.rejects(f.authoring.propose("docs-project",f.fields,{...origin,callId:"successor"}));
  const successor=await f.authoring.finalize(d.id,d.hash,randomUUID()),v=await f.tasks.snapshot(successor.runId!);
  assert.equal(git(v.checkout,["rev-parse","HEAD"]),base.baseSha);assert.equal(git(v.checkout,["status","--porcelain"]),"");assert.equal((await readFile(join(v.checkout,"docs/a.txt"),"utf8")).trim(),"approved fixture result");
  await f.tasks.start(v.id,v.configSha256,randomUUID());const successorUntil=Date.now()+60000;let settled=await f.tasks.snapshot(v.id);while(settled.live||settled.status==="queued"){assert.ok(Date.now()<successorUntil);await new Promise(r=>setTimeout(r,20));settled=await f.tasks.snapshot(v.id)}assert.equal(settled.status,"ready_for_review");assert.equal(settled.acceptedBy,null);assert.deepEqual(f.calls(),{astra:0,sol:3});
  const held=await f.authoring.propose("docs-project",{...f.fields,allowedPaths:["docs/held.txt"]},{...origin,callId:"held"},base.id);const heldRun=await f.authoring.finalize(held.id,held.hash,randomUUID());
  await f.tasks.close();const restoredTasks=await LocalTaskService.open(f.catalog,f.runtime);try{
   const restored=await LocalTaskAuthoringService.open(f.authoringConfig,restoredTasks);assert.equal((await restoredTasks.snapshot(heldRun.runId!)).canStart,false);
   await LocalIntegrationReviewService.register([reviewOptions],reviews,restored);assert.equal((await restoredTasks.snapshot(heldRun.runId!)).canStart,true);
   await reviews.revoke(id,initial.artifactSha256,randomUUID(),"Withdraw predecessor acceptance");const blocked=await restoredTasks.snapshot(heldRun.runId!);assert.equal(blocked.canStart,false);await assert.rejects(restoredTasks.start(blocked.id,blocked.configSha256,randomUUID()));assert.deepEqual(f.calls(),{astra:0,sol:3});
   assert.equal((await restoredTasks.snapshot(v.id)).status,"ready_for_review");assert.equal(git(checkout,["status","--porcelain"]),before);
  }finally{await restoredTasks.close()}
 }finally{await f.close()}
});
