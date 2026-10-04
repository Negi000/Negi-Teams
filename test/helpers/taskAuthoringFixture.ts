import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LocalTaskAuthoringService, type TaskPlanFields } from "../../src/server/orchestration/taskAuthoring.ts";
import { LocalTaskService } from "../../src/server/orchestration/taskService.ts";
import { loadApprovedTaskPlan } from "../../src/server/orchestration/approvedTaskPlan.ts";
import { loadVaultTaskContract, runSingleTaskFromVault } from "../../src/server/orchestration/vaultTaskContract.ts";
import { submitVaultRun, verifyVaultRun, type PreparedVaultRun } from "../../src/server/orchestration/vaultTaskExecution.ts";
import { runScheduledVaultTask } from "../../src/server/orchestration/scheduledVaultRun.ts";
import { FileTaskLedger } from "../../src/server/orchestration/singleTask.ts";
import type { VaultRunConfig } from "../../src/server/orchestration/vaultRunConfig.ts";
import type { SingleTaskClient } from "../../src/server/orchestration/singleTaskRunner.ts";

const planner = { model:"gpt-6-astra",effort:"medium" };
const origin = { kind:"master" as const,masterId:"native-master",threadId:"master-thread",turnId:"master-turn",callId:"plan-call",...planner };
const requestOrigin = { kind:origin.kind,masterId:origin.masterId,threadId:origin.threadId,turnId:origin.turnId,callId:origin.callId };
const git = (cwd:string,args:string[])=>execFileSync("git",args,{cwd,windowsHide:true,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const note = (id:string,kind:string,body:string,extra="") => `---\nid: ${id}\nkind: ${kind}\nproject: fixture\nscope: project\nstatus: active\nversion: 1\nupdated: 2026-10-01\nsensitivity: local\nsource_refs:\n  - user:fixture\n${extra}---\n${body}\n`;

async function setup(verification?: (root: string) => VaultRunConfig["verification"], fixtureHooks?: {
  write?: (prepared: PreparedVaultRun, prompt: string) => Promise<void>;
  thread?: (prepared: PreparedVaultRun) => Promise<void>;
}) {
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
  const snapshot=join(root,"template.json"),exporter=fileURLToPath(new URL("../../scripts/negi_task_contract.py",import.meta.url));
  execFileSync("python",[exporter,"--vault",vault,"--id","NT-TASK-TEMPLATE","--project","fixture","--out",snapshot],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:"utf-8"}});
  const config:VaultRunConfig={executable:process.execPath,checkout:repo,vault,snapshot,outputDir:join(root,"template-output"),
    schedulerPath:join(root,"scheduler.jsonl"),runId:"template",astra:planner,sol:{model:"gpt-6.1-sol",effort:"medium"},resources:[],
    verification:verification?.(root) ?? [{requirement:"runtime available",program:process.execPath,args:["--version"],timeoutMs:5000}]};
  const catalog={stateRoot:join(root,"task-state"),runs:[{title:"Trusted template",config}]};
  const authoringConfig={storageRoot:join(root,"authoring"),profiles:[{id:"docs-project",title:"ドキュメント作業",templateRunId:"template",repository:repo,
    worktreeRoot:join(root,"worktrees"),allowedPaths:["docs"],maxAttempts:1,timeLimitMinutes:5}]};
  let astraCalls=0,solCalls=0;const prompts:string[]=[];
  const prepare=async(config:VaultRunConfig)=>{const contract=await loadVaultTaskContract(config.vault,config.snapshot,config.checkout);
    return {config,contract,approvedPlan:await loadApprovedTaskPlan(config,contract)};};
  const runtime={prepare,submit:submitVaultRun,execute:async(prepared:PreparedVaultRun,scheduler:Parameters<typeof submitVaultRun>[1],_signal?:AbortSignal,hooks?:import("../../src/server/orchestration/vaultTaskExecution.ts").TaskExecutionHooks)=>{
    const {config}=prepared;
    const client=(role:"astra"|"sol"):SingleTaskClient=>({async initialize(){},async discoverModels(){return[{model:config[role].model,efforts:["medium"],inputModalities:["text"]}]},
      async startThread(options){if(role==="astra")astraCalls++;else solCalls++;await fixtureHooks?.thread?.(prepared);return{threadId:`thread-${role}`,requestedModel:options.model,resolvedModel:options.model,modelProvider:"fixture",rerouted:false}},
      async startTurn(prompt){prompts.push(prompt);if(fixtureHooks?.write)await fixtureHooks.write(prepared,prompt);else{assert.match(prompt,/承認された文書を1件作る/);await writeFile(join(config.checkout,prepared.contract.scope.allowedPaths[0]),"approved fixture result\n")}return`turn-${role}`},
      async waitForTurn(turnId){return{turnId,status:"completed",finalText:"Fixture result",contextInputTokens:null,contextWindow:null,lastUsage:null}}});
    return runScheduledVaultTask({scheduler,admit:hooks?.admit,taskMode:config.taskMode,dispatchKey:`${config.runId}:dispatch`,run:{runId:config.runId,cwd:config.checkout,
      vaultDirectory:config.vault,snapshotPath:config.snapshot,artifactDir:join(config.outputDir,"artifacts"),ledger:new FileTaskLedger(join(config.outputDir,"run.jsonl")),
      astra:{...config.astra,client:client("astra")},sol:{...config.sol,client:client("sol")},approvedPlan:prepared.approvedPlan,
      turnTimeoutMs:5000,verify:()=>verifyVaultRun(prepared)},execute:runSingleTaskFromVault});
  }};
  const tasks=await LocalTaskService.open(catalog,runtime),authoring=await LocalTaskAuthoringService.open(authoringConfig,tasks);
  const refs=await authoring.readProject("docs-project");
  const fields:TaskPlanFields={title:"承認する新しい文書",objective:"承認された文書を1件作る",inScope:["docs/result.txtを追加"],outOfScope:["公開と既存文書の変更"],
    allowedPaths:["docs/result.txt"],invariants:["既存文書を維持する"],acceptance:["指定内容の文書が存在する"],escalation:["仕様変更が必要なら停止"],
    implementationPlan:["承認された文書を1件作る","指定チェックを実行して結果を報告する"],references:refs.sources.map(({id,version,sha256})=>({id,version,sha256})),maxAttempts:1,timeLimitMinutes:5};
  return {root,repo,vault,spec,config,catalog,authoringConfig,fields,tasks,authoring,runtime,prompts,calls:()=>({astra:astraCalls,sol:solCalls}),
    close:async()=>{await tasks.close();await rm(root,{recursive:true,force:true})}};
  } catch(error) { await rm(root,{recursive:true,force:true});throw error; }
}


export { setup, planner, origin, requestOrigin, git, note };
