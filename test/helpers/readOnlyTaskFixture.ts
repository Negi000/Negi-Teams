import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { FileTaskLedger, type TaskAction } from "../../src/server/orchestration/singleTask.ts";
import { FileScheduler } from "../../src/server/orchestration/scheduler.ts";
import { verifyConfiguredCheckout } from "../../src/server/orchestration/checkoutVerification.ts";
import { submitVaultRun, type PreparedVaultRun, type TaskExecutionHooks } from "../../src/server/orchestration/vaultTaskExecution.ts";
import type { VaultTaskContract } from "../../src/server/orchestration/vaultTaskContract.ts";
import type { VaultRunConfig } from "../../src/server/orchestration/vaultRunConfig.ts";
import { AppServerProcess } from "../../src/server/master/appServerProcess.ts";
import { appServerChildEnv } from "../../src/server/master/appServerProcess.ts";

export const researchHash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
export async function researchFixture<T>(operation:(data:{dir:string;config:VaultRunConfig;contract:VaultTaskContract;
  configSha256:string;catalog:unknown;prepare:(config:VaultRunConfig)=>Promise<PreparedVaultRun>})=>Promise<T>):Promise<T>{
  const dir=await mkdtemp(join(tmpdir(),"negi-research-review-"));
  try{const checkout=join(dir,"checkout"),vault=join(dir,"vault"),outputDir=join(dir,"output");
    await mkdir(join(checkout,"docs"),{recursive:true});await mkdir(vault);await mkdir(outputDir);
    await writeFile(join(checkout,"docs","base.md"),"# Fixed baseline\n");
    const git=(args:string[])=>execFileSync("git",args,{cwd:checkout,windowsHide:true,stdio:["ignore","pipe","pipe"]}).toString().trim();
    git(["init"]);git(["add","."]);git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
    const contract:VaultTaskContract={schemaVersion:"negi-task-contract/1",vaultId:"NT-TASK-RESEARCH-FIXTURE",version:1,
      sha256:"a".repeat(64),project:"research-fixture",taskClass:"read_only_research",objective:"Explain the fixed baseline",
      baseSha:git(["rev-parse","HEAD"]),scope:{in:["Read docs/base.md"],out:["No edits or network"],allowedPaths:["docs/base.md"]},
      invariants:["Do not change files"],acceptance:["Report evidence and unknowns"],verification:["fixed baseline check"],
      escalation:["Hold unknowns"],limits:{maxAttempts:1,timeLimitMinutes:5},sourceNotes:[]};
    const snapshot=join(dir,"snapshot.json"),snapshotBytes=JSON.stringify(contract);await writeFile(snapshot,snapshotBytes);
    const config:VaultRunConfig={executable:process.execPath,checkout,vault,snapshot,outputDir,schedulerPath:join(dir,"scheduler.jsonl"),
      runId:"research-fixture",astra:{model:"gpt-6-astra",effort:"low"},taskMode:"read_only_research",luna:{model:"gpt-6-luna",effort:"low"},resources:[],
      verification:[{requirement:"fixed baseline check",program:process.execPath,args:["-e","require('node:assert/strict').equal(require('node:fs').readFileSync('docs/base.md','utf8'),'# Fixed baseline\\n')"],timeoutMs:5000}]};
    return await operation({dir,config,contract,configSha256:researchHash(JSON.stringify({config,snapshotSha256:researchHash(snapshotBytes)})),
      catalog:{stateRoot:join(dir,"task-state"),runs:[{title:"読み取り専用の調査",config}]},prepare:async config=>({config,contract})});
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}
export async function completeResearch(prepared:PreparedVaultRun,scheduler:FileScheduler,_signal?:AbortSignal,hooks?:TaskExecutionHooks){
  const {config,contract}=prepared;await scheduler.claim(config.runId,`${config.runId}:dispatch`);
  const ledger=new FileTaskLedger(join(config.outputDir,"run.jsonl"));let sequence=0;
  const append=(action:TaskAction)=>ledger.append({key:`fixture-${sequence++}`,at:new Date().toISOString(),action});
  await mkdir(join(config.outputDir,"artifacts"),{recursive:true});
  await append({type:"create",runId:config.runId,contract});
  for(const role of ["astra","luna"] as const){
    // Actual contained placeholder processes; their native exits are evidence,
    // while all model/thread content in this fixture remains synthetic.
    if(hooks?.executionOwner){const owner=hooks.executionOwner;await owner.launching(role);
      const process=await AppServerProcess.launchContained({executable:config.executable,args:["-e","setInterval(()=>{},1000)"],
        cwd:config.checkout,env:appServerChildEnv()},owner.processTreeRoot);
      await owner.started(role,process.pid,process.treeIdentity!);const exit=await process.stop();
      await owner.exited(role,process.pid,exit.treeReceipt);
    }
    const profile=role==="astra"?config.astra:config.luna!;
    await append({type:"start_attempt",attemptId:role,role,requestedModel:profile.model});
    await append({type:"bind_provider",attemptId:role,threadId:`thread-${role}`,turnId:`turn-${role}`});
    const text=role==="astra"?"Read the fixed file and report unknowns.":"# 調査結果\n\n根拠: docs/base.md:1 は `Fixed baseline`。\n\n不明: 実利用者による内容の確認。\n\n## Git diff\n\nこの見出しも調査成果の一部です。\n";
    const path=join(config.outputDir,"artifacts",`${role}.md`);await writeFile(path,text);
    const outputRef=`${path}#sha256=${researchHash(text)}`;
    await append({type:"complete_attempt",attemptId:role,resolvedModel:profile.model,threadId:`thread-${role}`,turnId:`turn-${role}`,outputRef});
    if(role==="astra"){
      await scheduler.append({key:"fixture:planning",at:new Date().toISOString(),action:{type:"finish_planning",workId:config.runId,
        planRef:outputRef,threadId:"thread-astra",turnId:"turn-astra"}});
      assert.ok(await scheduler.tryStartWorker(config.runId,`${config.runId}:worker`));
    }
  }
  const verification=await verifyConfiguredCheckout({...config,baseSha:contract.baseSha,allowedPaths:contract.scope.allowedPaths,
    requiredVerification:contract.verification,commands:config.verification,processOwner:hooks?.executionOwner});
  assert.equal(verification.outcome,"passed");
  const state=await append({type:"verify",...verification});
  await scheduler.append({key:"fixture:settle",at:new Date().toISOString(),action:{type:"settle",workId:config.runId,
    outcome:"verified",evidenceRef:verification.evidenceRef,actualCostUsd:null}});return state;
}
export async function prepareCompletedResearch(data:Parameters<Parameters<typeof researchFixture>[0]>[0]){
  const prepared=await data.prepare(data.config),scheduler=new FileScheduler(data.config.schedulerPath);
  await submitVaultRun(prepared,scheduler);return completeResearch(prepared,scheduler);
}
