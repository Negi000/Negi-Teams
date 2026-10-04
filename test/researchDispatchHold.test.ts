import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { executeVaultRun, prepareVaultRun, submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { parseVaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import { researchFixture } from "./helpers/readOnlyTaskFixture.ts";

test("research cannot bypass native isolation hold through preflight or a prepared run",async()=>researchFixture(async data=>{
  const config=parseVaultRunConfig(data.config);
  const outputBefore=await readdir(config.outputDir);
  await assert.rejects(prepareVaultRun(config),/process-local MCP policy is not enforced/);
  // execute is public to the runner; bypassing prepare must not acquire an owner or scheduler slot.
  await assert.rejects(executeVaultRun({config,contract:data.contract},new FileScheduler(config.schedulerPath)),/process-local MCP policy is not enforced/);
  assert.deepEqual(await readdir(config.outputDir),outputBefore);
  for(const name of ["execution-owner.json","execution-guard.lock","execution-children.jsonl","run.jsonl"])
    assert.equal(await access(join(config.outputDir,name)).then(()=>true,()=>false),false);
  assert.equal(await access(config.schedulerPath).then(()=>true,()=>false),false);
}));

test("native and mixed Task compositions expose the research hold before an HTTP dispatch can create a request",async()=>researchFixture(async data=>{
  const reviews=await LocalReviewService.open({storageRoot:join(data.dir,"reviews"),writableRoots:[],cases:[]});
  const customExecute:typeof executeVaultRun=async()=>{throw Error("Synthetic execute must not be reached")};
  for(const runtime of [undefined,{prepare:prepareVaultRun,submit:submitVaultRun,execute:customExecute},
    {prepare:data.prepare,submit:submitVaultRun,execute:executeVaultRun}]){
    const tasks=await LocalTaskService.open(data.catalog,runtime);
    try{
      await tasks.connectReviews(reviews);
      const view=await tasks.snapshot(data.config.runId);
      const schedulerBefore=await readFile(data.config.schedulerPath);
      assert.equal(view.canStart,false);assert.equal(view.error,null);
      assert.match(view.startHoldReason!,/Lunaの調査は準備中/);
      await assert.rejects(tasks.start(view.id,view.configSha256,randomUUID()),/cannot be dispatched/);
      assert.equal(await access(join(data.dir,"task-state",view.id+".request.json")).then(()=>true,()=>false),false);
      assert.deepEqual(await readFile(data.config.schedulerPath),schedulerBefore);
    }finally{await tasks.close()}
  }
}));
