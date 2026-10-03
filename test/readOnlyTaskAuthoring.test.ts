import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { LocalIntegrationExecutionService } from "../src/server/orchestration/integrationExecution.ts";
import { loadVaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";
import { registeredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import { setup, origin, planner, git } from "./helpers/taskAuthoringFixture.ts";
import { policyFixture } from "./helpers/policyFixture.ts";
import { LocalPolicyService } from "../src/server/orchestration/policyService.ts";

function researchConfig(config:VaultRunConfig):VaultRunConfig {
  const {sol, ...fixed}=config;
  return {...fixed,taskMode:"read_only_research",luna:{model:"gpt-6-luna",effort:"low"}};
}
function authoringConfig(f:Awaited<ReturnType<typeof setup>>) {
  return {storageRoot:join(f.root,"research-authoring"),profiles:[{...f.authoringConfig.profiles[0],
    templateRunId:undefined,project:"fixture",config:researchConfig(f.config)}]};
}
test("raw research profile produces a signed real Vault research contract, Luna plan and restart without dispatch",async()=>{
  const f=await setup();let restored:LocalTaskService|undefined;
  try {
    const config=authoringConfig(f);config.profiles[0].config.lunaPolicy="approved-policy/1";
    const authoring=await LocalTaskAuthoringService.open(config,f.tasks);
    const fixed=config.profiles[0];
    assert.deepEqual(new Set(authoring.policyWritableRoots()),new Set([fixed.repository,fixed.worktreeRoot,fixed.config.vault,fixed.config.checkout]));
    const policy=await policyFixture();
    try{await assert.rejects(LocalPolicyService.open({...policy.config,storageRoot:fixed.worktreeRoot},
      authoring.policyWritableRoots(),policy.secret),/overlaps model-writable/)}
    finally{await rm(policy.directory,{recursive:true,force:true})}
    const profile=await authoring.readProject("docs-project");
    assert.equal(profile.worker.model,"gpt-6-luna");assert.equal(profile.workerRole,"luna");
    assert.deepEqual(profile.integrationBases,[]);assert.equal(profile.decomposition.successors,"new_research_contract");
    const draft=await authoring.propose("docs-project",{...f.fields,objective:"調査の根拠と不明点を報告する",
      allowedPaths:["docs/base.txt"],implementationPlan:["指定ファイルを読み、根拠の位置と不明点を報告する"]},origin);
    assert.equal(draft.taskMode,"read_only_research");assert.equal(draft.worker.model,"gpt-6-luna");
    const approved=await authoring.finalize(draft.id,draft.hash,randomUUID()),run= f.tasks.authoringTemplate(approved.runId!);
    assert.equal(run.config.taskMode,"read_only_research");assert.equal(run.config.sol,undefined);
    assert.equal(run.config.lunaPolicy,"approved-policy/1");
    const contract=await loadVaultTaskContract(run.config.vault,run.config.snapshot,run.config.checkout);
    assert.equal(contract.taskClass,"read_only_research");
    assert.equal(contract.approvedPlan,undefined);assert.equal(run.contract.taskClass,"read_only_research");
    assert.match(await readFile(join(f.vault,"80_Tasks",`${contract.vaultId}.md`),"utf8"),/task_class: "read_only_research"/);
    const view=await f.tasks.snapshot(approved.runId!);assert.equal(view.luna!.model,"gpt-6-luna");assert.equal(view.sol,undefined);
    assert.equal(view.status,"not_started");assert.equal(git(f.repo,["status","--porcelain"]),"");
    assert.deepEqual(f.calls(),{astra:0,sol:0});await f.tasks.close();
    restored=await LocalTaskService.open(f.catalog,f.runtime);
    const restoredAuthoring=await LocalTaskAuthoringService.open(config,restored);
    assert.equal((await restoredAuthoring.list())[0].runId,approved.runId);
    assert.equal((await restored.snapshot(approved.runId!)).status,"not_started");assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await restored?.close();await f.close()}
});
test("research template profiles preserve worker and task class through concrete approval",async()=>{
  const f=await setup();let tasks:LocalTaskService|undefined;
  try {
    await f.tasks.close();const taskPath=join(f.vault,"80_Tasks","template.md");
    await writeFile(taskPath,(await readFile(taskPath,"utf8")).replace("kind: Task\n","kind: Task\ntask_class: read_only_research\n"));
    const snapshot=join(f.root,"research-template.json");
    execFileSync("python",[fileURLToPath(new URL("../scripts/negi_task_contract.py",import.meta.url)),"--vault",f.vault,
      "--id","NT-TASK-TEMPLATE","--project","fixture","--out",snapshot],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:"utf-8"}});
    tasks=await LocalTaskService.open({...f.catalog,runs:[{title:"Research template",config:{...researchConfig(f.config),snapshot}}]},f.runtime);
    const authoring=await LocalTaskAuthoringService.open(f.authoringConfig,tasks);
    const draft=await authoring.propose("docs-project",f.fields,origin),approved=await authoring.finalize(draft.id,draft.hash,randomUUID());
    assert.equal(draft.worker.model,"gpt-6-luna");assert.equal(tasks.authoringTemplate(approved.runId!).contract.taskClass,"read_only_research");
    assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await tasks?.close();await f.close()}
});
test("research decomposition and research-only integration view reject code dependencies and baselines before saving",async()=>{
  const f=await setup();let integrations:LocalIntegrationExecutionService|undefined;
  try {
    const authoring=await LocalTaskAuthoringService.open(authoringConfig(f),f.tasks),fields=f.fields;
    const graph={title:"Independent research",objective:"Report evidence",coordination:["Use the fixed base"],nodes:[
      {key:"first",dependsOn:[],handoff:"Findings",task:fields},
      {key:"second",dependsOn:[],handoff:"Unknowns",task:{...fields,title:"別の調査",allowedPaths:["docs/other.txt"]}}]};
    await assert.rejects(authoring.proposeDecomposition("docs-project",{...graph,nodes:[graph.nodes[0],{...graph.nodes[1],dependsOn:["first"]}]},origin),/independent roots only/);
    assert.equal((await authoring.list()).length,0);
    const base="base-"+"a".repeat(24);
    await assert.rejects(authoring.readProject("docs-project",[],base),/new fixed contract/);
    await assert.rejects(authoring.propose("docs-project",fields,origin,base),/new fixed contract/);
    await assert.rejects(authoring.proposeDecomposition("docs-project",graph,origin,base),/new fixed contract/);
    await assert.rejects(authoring.integrationBase("docs-project",base),/cannot use code/);
    await assert.rejects(authoring.publishIntegrationBase("docs-project",base,"a".repeat(64),randomUUID()),/cannot publish code/);
    assert.equal((await readdir(join(authoringConfig(f).storageRoot,"drafts"))).length,0);
    const tools=registeredTaskTools(f.tasks,origin.masterId,{service:authoring,planner});
    const result=await tools.invoke({threadId:origin.threadId,turnId:origin.turnId,callId:origin.callId,
      tool:"negi_propose_task_decomposition",arguments:{profile_id:"docs-project",decomposition:graph}});
    assert.equal(result.success,true,result.text);const value=JSON.parse(result.text);
    assert.equal(value.successorsRequireNewPlanAfterIntegration,false);assert.equal(value.successorsRequireNewResearchContract,true);
    assert.equal(value.tasks.length,2);assert.deepEqual(f.calls(),{astra:0,sol:0});
    const reviews=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[],cases:[]});
    integrations=await LocalIntegrationExecutionService.open(authoring,f.tasks,reviews);
    assert.deepEqual(await integrations.overview(),{profiles:[],profileId:null,sources:[],runs:[]});
    await assert.rejects(integrations.preview("docs-project",["a","b"]));
    await assert.rejects(integrations.start("docs-project",["a","b"],"a".repeat(64),randomUUID()));
    assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await integrations?.close();await f.close()}
});
