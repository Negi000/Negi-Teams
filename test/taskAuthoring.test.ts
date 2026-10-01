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

const planner = { model:"gpt-6-astra",effort:"medium" };
const origin = { kind:"master" as const,masterId:"native-master",threadId:"master-thread",turnId:"master-turn",callId:"plan-call",...planner };
const requestOrigin = { kind:origin.kind,masterId:origin.masterId,threadId:origin.threadId,turnId:origin.turnId,callId:origin.callId };
const git = (cwd:string,args:string[])=>execFileSync("git",args,{cwd,windowsHide:true,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const note = (id:string,kind:string,body:string,extra="") => `---\nid: ${id}\nkind: ${kind}\nproject: fixture\nscope: project\nstatus: active\nversion: 1\nupdated: 2026-10-01\nsensitivity: local\nsource_refs:\n  - user:fixture\n${extra}---\n${body}\n`;

async function setup() {
  const root=await mkdtemp(join(tmpdir(),"negi-authoring-")),repo=join(root,"repo"),vault=join(root,"vault");
  try {
  await mkdir(repo);await mkdir(join(repo,"docs"));await writeFile(join(repo,"docs","base.txt"),"base\n");
  git(repo,["init"]);git(repo,["add","."]);git(repo,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
  await mkdir(vault);await mkdir(join(vault,"10_Projects"));await mkdir(join(vault,"80_Tasks"));
  const spec=join(vault,"10_Projects","spec.md");await writeFile(spec,note("NT-SPEC-FIXTURE","Spec","Keep existing files; implement only the approved docs change.","required: true\n"));
  const baseSha=git(repo,["rev-parse","HEAD"]),templateTask=join(vault,"80_Tasks","template.md");
  const body={objective:"Existing fixed template",in_scope:["one docs change"],out_of_scope:["no publishing"],allowed_paths:["docs"],
    invariants:["Keep existing files"],acceptance:["requested document exists"],verification:["runtime available"],escalation:["stop on scope change"],base_sha:baseSha,max_attempts:1,time_limit_minutes:5};
  await writeFile(templateTask,note("NT-TASK-TEMPLATE","Task","```negi-task-contract\n"+JSON.stringify(body)+"\n```","approval_ref: user:fixture\ndepends_on:\n  - NT-SPEC-FIXTURE\n"));
  const snapshot=join(root,"template.json"),exporter=fileURLToPath(new URL("../scripts/negi_task_contract.py",import.meta.url));
  execFileSync("python",[exporter,"--vault",vault,"--id","NT-TASK-TEMPLATE","--project","fixture","--out",snapshot],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:"utf-8"}});
  const config:VaultRunConfig={executable:process.execPath,checkout:repo,vault,snapshot,outputDir:join(root,"template-output"),
    schedulerPath:join(root,"scheduler.jsonl"),runId:"template",astra:planner,sol:{model:"gpt-6.1-sol",effort:"medium"},resources:[],
    verification:[{requirement:"runtime available",program:process.execPath,args:["--version"],timeoutMs:5000}]};
  const catalog={stateRoot:join(root,"task-state"),runs:[{title:"Trusted template",config}]};
  const authoringConfig={storageRoot:join(root,"authoring"),profiles:[{id:"docs-project",title:"ドキュメント作業",templateRunId:"template",repository:repo,
    worktreeRoot:join(root,"worktrees"),allowedPaths:["docs"],maxAttempts:1,timeLimitMinutes:5}]};
  let astraCalls=0,solCalls=0;
  const prepare=async(config:VaultRunConfig)=>{const contract=await loadVaultTaskContract(config.vault,config.snapshot,config.checkout);
    return {config,contract,approvedPlan:await loadApprovedTaskPlan(config,contract)};};
  const runtime={prepare,submit:submitVaultRun,execute:async(prepared:PreparedVaultRun,scheduler:Parameters<typeof submitVaultRun>[1])=>{
    const {config}=prepared;
    const client=(role:"astra"|"sol"):SingleTaskClient=>({async initialize(){},async discoverModels(){return[{model:config[role].model,efforts:["medium"],inputModalities:["text"]}]},
      async startThread(options){if(role==="astra")astraCalls++;else solCalls++;return{threadId:`thread-${role}`,requestedModel:options.model,resolvedModel:options.model,modelProvider:"fixture",rerouted:false}},
      async startTurn(prompt){assert.match(prompt,/承認された文書を1件作る/);await writeFile(join(config.checkout,"docs","result.txt"),"approved fixture result\n");return`turn-${role}`},
      async waitForTurn(turnId){return{turnId,status:"completed",finalText:"Fixture result",contextInputTokens:null,contextWindow:null,lastUsage:null}}});
    return runScheduledVaultTask({scheduler,dispatchKey:`${config.runId}:dispatch`,run:{runId:config.runId,cwd:config.checkout,
      vaultDirectory:config.vault,snapshotPath:config.snapshot,artifactDir:join(config.outputDir,"artifacts"),ledger:new FileTaskLedger(join(config.outputDir,"run.jsonl")),
      astra:{...config.astra,client:client("astra")},sol:{...config.sol,client:client("sol")},approvedPlan:prepared.approvedPlan,
      turnTimeoutMs:5000,verify:()=>verifyVaultRun(prepared)},execute:runSingleTaskFromVault});
  }};
  const tasks=await LocalTaskService.open(catalog,runtime),authoring=await LocalTaskAuthoringService.open(authoringConfig,tasks);
  const refs=await authoring.readProject("docs-project");
  const fields:TaskPlanFields={title:"承認する新しい文書",objective:"承認された文書を1件作る",inScope:["docs/result.txtを追加"],outOfScope:["公開と既存文書の変更"],
    allowedPaths:["docs/result.txt"],invariants:["既存文書を維持する"],acceptance:["指定内容の文書が存在する"],escalation:["仕様変更が必要なら停止"],
    implementationPlan:["承認された文書を1件作る","指定チェックを実行して結果を報告する"],references:refs.sources.map(({id,version,sha256})=>({id,version,sha256})),maxAttempts:1,timeLimitMinutes:5};
  return {root,repo,vault,spec,config,catalog,authoringConfig,fields,tasks,authoring,runtime,calls:()=>({astra:astraCalls,sol:solCalls}),
    close:async()=>{await tasks.close();await rm(root,{recursive:true,force:true})}};
  } catch(error) { await rm(root,{recursive:true,force:true});throw error; }
}

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
    for(const script of taskPlanPageHtml().matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(script[1]);
  }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));await f.close()}
});

test("unapproved plan adoption cannot bypass the ledger state machine",()=>{
  const contract={vaultId:"id",version:1,sha256:"a".repeat(64),project:"fixture",objective:"test",acceptance:["test"],baseSha:"b".repeat(40)};
  const state=reduceTask(null,{key:"create",at:new Date().toISOString(),action:{type:"create",runId:"test",contract}});
  assert.throws(()=>reduceTask(state,{key:"forged-plan",at:new Date().toISOString(),action:{type:"adopt_approved_plan",approvalRef:"user:http-task-plan:forged",outputRef:"plan#sha256="+"a".repeat(64)}}));
});
