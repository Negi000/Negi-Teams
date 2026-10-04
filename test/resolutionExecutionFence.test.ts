import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { parseVaultRunConfig, assertVaultWorkerContract } from "../src/server/orchestration/vaultRunConfig.ts";
import { executeVaultRun, type PreparedVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { runScheduledVaultTask } from "../src/server/orchestration/scheduledVaultRun.ts";
import { runSingleTask } from "../src/server/orchestration/singleTaskRunner.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const exec=promisify(execFile),approvedPlan={text:"Resolve pinned code",approvalRef:"user:http-task-plan:fixture",threadId:"master",turnId:"turn",callId:"call"};
test("resolution config, standalone CLIs, scheduler and low-level runner require source admission",async()=>{
 const root=await mkdtemp(join(tmpdir(),"negi-resolution-fence-"));try{
  const raw={executable:process.execPath,checkout:root,vault:root,snapshot:join(root,"missing-snapshot.json"),outputDir:join(root,"output"),
   schedulerPath:join(root,"scheduler.jsonl"),runId:"resolution",astra:{model:"fixture",effort:"medium"},sol:{model:"fixture",effort:"medium"},
   taskMode:"integration_resolution",approvedPlan:{proofDirectory:join(root,"authority"),requestId:"11111111-1111-4111-a111-111111111111"},resources:[],verification:[]};
  const config=parseVaultRunConfig(raw);assert.equal(config.taskMode,"integration_resolution");
  assert.throws(()=>parseVaultRunConfig({...raw,approvedPlan:undefined}),/signed approved plan/);
  assert.throws(()=>parseVaultRunConfig({...raw,luna:{model:"fixture",effort:"medium"}}),/ambiguous/);
  assert.throws(()=>parseVaultRunConfig({...raw,taskMode:"unknown"}),/ambiguous/);
  assert.throws(()=>assertVaultWorkerContract(config,{}),/explicit configuration/);
  assert.throws(()=>assertVaultWorkerContract({...config,taskMode:undefined} as typeof config,{taskClass:"integration_resolution"}),/explicit configuration/);
  const configPath=join(root,"config.json"),catalogPath=join(root,"catalog.json"),reviewPath=join(root,"reviews.json");
  await writeFile(configPath,JSON.stringify(raw));await writeFile(catalogPath,JSON.stringify({stateRoot:join(root,"state"),runs:[{title:"Resolution",config:raw}]}));
  await writeFile(reviewPath,"{}");
  for(const [script,args]of [["negi_run_vault_task.ts",[configPath]],["negi_run_parallel_tasks.ts",[catalogPath,reviewPath]]] as const){
   await assert.rejects(exec(process.execPath,["--import","tsx",fileURLToPath(new URL("../scripts/"+script,import.meta.url)),...args],
    {cwd:fileURLToPath(new URL("..",import.meta.url)),windowsHide:true,timeout:15_000}),error=>{
      assert.match(String((error as {stderr:string}).stderr),/restored contract\/source admission service/);return true});
  }
  await assert.rejects(readFile(config.schedulerPath),{code:"ENOENT"});
  const contract={taskClass:"integration_resolution",vaultId:"NT-TASK-FENCE",version:1,sha256:"a".repeat(64),project:"fixture",objective:"Resolve code",
   acceptance:["checks pass"],baseSha:"b".repeat(40),scope:{in:["code"],out:["publishing"],allowedPaths:["src"]},invariants:["retain sources"],
   verification:["checks"],escalation:["stop on stale source"],limits:{maxAttempts:1,timeLimitMinutes:5}};
  const scheduler=new FileScheduler(config.schedulerPath);
  await assert.rejects(executeVaultRun({config,contract,approvedPlan} as unknown as PreparedVaultRun,scheduler),/source admission/);
  await assert.rejects(readFile(config.schedulerPath),{code:"ENOENT"});
  let calls=0;const client={async initialize(){calls++},async discoverModels(){return[]},async startThread(){throw Error("must not run")},
   async startTurn(){throw Error("must not run")},async waitForTurn(){throw Error("must not run")}},role={client,model:"fixture",effort:"medium"};
  const run={runId:config.runId,contract,cwd:root,astra:role,sol:role,approvedPlan,ledger:new FileTaskLedger(join(root,"run.jsonl")),
   artifactDir:join(root,"artifacts"),turnTimeoutMs:1000,verify:async()=>({outcome:"passed" as const,evidenceRef:"must not run"})};
  await assert.rejects(runSingleTask(run),/source admission/);assert.equal((await run.ledger.read()).state,null);
  await scheduler.ensureSubscriptionConfiguration();const work={id:config.runId,parentId:null,dependencies:[],role:"sol" as const,checkout:root,
   checkoutMode:"write" as const,execution:"direct" as const,taskMode:"integration_resolution" as const,resources:[],reserveUsd:0};
  for(const change of [{role:"luna"},{checkoutMode:"read"},{execution:"astra_to_sol"}])
   await assert.rejects(scheduler.append({key:"invalid-"+JSON.stringify(change),at:new Date().toISOString(),action:{type:"submit",work:{...work,...change} as typeof work}}));
  await scheduler.append({key:"submit",at:new Date().toISOString(),action:{type:"submit",work}});
  const before=await readFile(config.schedulerPath);
  await assert.rejects(runScheduledVaultTask({scheduler,dispatchKey:"dispatch",run,taskMode:"integration_resolution"}),/restored source admission/);
  await assert.rejects(runScheduledVaultTask({scheduler,dispatchKey:"dispatch",run,admit:async operation=>operation()}),/registered worker/);
  assert.deepEqual(await readFile(config.schedulerPath),before);assert.equal(calls,0);
 }finally{await rm(root,{recursive:true,force:true})}
});
