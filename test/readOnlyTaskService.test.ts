import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FileReviewChain } from "../src/server/orchestration/reviewChain.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { registeredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import { registerParallelReview } from "../scripts/negi_run_parallel_tasks.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { TaskExecutionOwner } from "../src/server/orchestration/taskExecutionOwner.ts";
import { completeResearch, researchFixture } from "./helpers/readOnlyTaskFixture.ts";

async function until(check:()=>Promise<boolean>){const deadline=Date.now()+30_000;
  while(!await check()){if(Date.now()>deadline)throw Error("Research fixture did not settle");await new Promise(r=>setTimeout(r,20))}}

test("research uses signed review, exact Astra notification, acceptance replay and revocation without code integration",async()=>researchFixture(async data=>{
  let dispatches=0;const runtime={prepare:data.prepare,submit:submitVaultRun,execute:async(...args:Parameters<typeof completeResearch>)=>{
    dispatches++;return completeResearch(...args)}};
  const reviewConfig={storageRoot:join(data.dir,"human-reviews"),writableRoots:[],cases:[]};
  const reviews=await LocalReviewService.open(reviewConfig),tasks=await LocalTaskService.open(data.catalog,runtime);
  try{assert.equal((await tasks.snapshot(data.config.runId)).canStart,false);
    await tasks.connectReviews(reviews);const before=await tasks.snapshot(data.config.runId);
    assert.equal(before.taskMode,"read_only_research");assert.equal(before.sol,undefined);assert.equal(before.luna!.model,"gpt-6-luna");
    assert.equal(before.canStart,true);
    const tool=await registeredTaskTools(tasks,"master").invoke({tool:"negi_read_task",arguments:{run_id:before.id},
      threadId:"original-astra",turnId:"delegation",callId:"read-call"});
    assert.equal(tool.success,true);const read=JSON.parse(tool.text);
    assert.equal(read.worker.model,"gpt-6-luna");assert.equal(read.workerRole,"luna");assert.equal(read.taskMode,"read_only_research");
    await tasks.start(before.id,before.configSha256,randomUUID(),{kind:"master",masterId:"master",threadId:"original-astra",turnId:"delegation",callId:"call"});
    await until(async()=>{const view=await tasks.snapshot(before.id);return Boolean(view.reviewId&&!view.live)});
    const result=await tasks.snapshot(before.id),review=await reviews.snapshot(result.reviewId!);
    const completed=(await new FileTaskLedger(join(data.config.outputDir,"run.jsonl")).read()).state!;
    const parallel=await registerParallelReview(tasks,{title:result.title,configSha256:result.configSha256,task:await data.prepare(data.config)},completed);
    assert.equal(parallel.reviewId,result.reviewId);assert.equal(dispatches,1);
    assert.equal(review.presentation!.kind,"read_only_research");assert.match(review.presentation!.changes,/docs\/base.md:1/);
    assert.equal(review.canAccept,true);assert.equal(result.acceptedBy,null);assert.equal(dispatches,1);
    const notifications=await tasks.resultNotifications();assert.equal(notifications.length,1);assert.equal(notifications[0].reviewId,review.id);
    const childrenPath=join(data.config.outputDir,"execution-children.jsonl"),children=await readFile(childrenPath,"utf8");
    for(const broken of ["",children.split("\n").filter(line=>!line||JSON.parse(line).role!=="luna").join("\n")]){
      await writeFile(childrenPath,broken);assert.equal((await reviews.snapshot(review.id)).canAccept,false);
      await assert.rejects(reviews.accept(review.id,review.artifactSha256,randomUUID()),/process termination/);
    }
    await writeFile(childrenPath,children);assert.equal((await reviews.snapshot(review.id)).canAccept,true);
    assert.equal(await tasks.prepareResultContext("master","other-astra","Read result"),null);
    const ready=await tasks.prepareResultContext("master","original-astra","Read result");assert.ok(ready);await ready.notSent();
    await assert.rejects(tasks.integrationSource(result.id,false),/cannot be code integration/);
    await assert.rejects(tasks.registerResultRevision(result.id,result.configSha256,[]),/new fixed contract/);
    const output=join(data.config.outputDir,"artifacts","luna.md"),original=await readFile(output);
    await writeFile(output,"Changed after verification\n");
    assert.equal((await tasks.snapshot(result.id)).status,"artifact_changed");
    await assert.rejects(reviews.accept(review.id,review.artifactSha256,randomUUID()),/changed/);
    await writeFile(output,original);const acceptance=randomUUID();await reviews.accept(review.id,review.artifactSha256,acceptance);
    assert.equal((await tasks.snapshot(result.id)).acceptedBy,`user:http-review:${acceptance}`);
    const accepted=await tasks.prepareResultContext("master","original-astra","Read accepted result");assert.ok(accepted);
    assert.equal(JSON.parse(accepted.text.split("\n").at(-1)!)[0].status,"accepted");await accepted.notSent();
    await tasks.close();
    const reloadedReviews=await LocalReviewService.open(reviewConfig),reloaded=await LocalTaskService.open(data.catalog,runtime);
    try{await reloaded.connectReviews(reloadedReviews);assert.equal((await reloaded.snapshot(result.id)).status,"accepted");
      await reloadedReviews.revoke(review.id,review.artifactSha256,randomUUID(),"内容を再確認します");
      assert.equal((await reloaded.snapshot(result.id)).status,"review_revoked");assert.equal((await reloaded.snapshot(result.id)).acceptedBy,null);
      const notice=(await reloaded.resultNotifications())[0];assert.equal(notice.status,"review_revoked");assert.equal(dispatches,1);
    }finally{await reloaded.close()}
  }finally{await tasks.close()}
}));

test("fresh parallel CLI adoption registers and restores a research result before any TaskService review cache",async()=>researchFixture(async data=>{
  const runtime={prepare:data.prepare,submit:submitVaultRun,execute:async()=>{throw Error("adoption must not dispatch")}};
  const reviewConfig={storageRoot:join(data.dir,"human-reviews"),writableRoots:[],cases:[]};
  const reviews=await LocalReviewService.open(reviewConfig),tasks=await LocalTaskService.open(data.catalog,runtime);
  try{
    await tasks.connectReviews(reviews);const initial=await tasks.snapshot(data.config.runId);
    const prepared=await data.prepare(data.config),scheduler=new FileScheduler(data.config.schedulerPath);
    await submitVaultRun(prepared,scheduler);
    const owner=await TaskExecutionOwner.acquire(data.config.outputDir,data.config.runId,initial.configSha256,`${data.config.runId}:dispatch`);
    let completed;
    try{completed=await completeResearch(prepared,scheduler,undefined,{executionOwner:owner,onApproval:async()=>{},verifyApproval:()=>false})}
    finally{await owner.finish()}
    await assert.rejects(readFile(join(data.config.outputDir,"review-manifest.json")),{code:"ENOENT"});
    const adopted=await registerParallelReview(tasks,{title:"読み取り専用の調査",configSha256:data.configSha256,task:prepared},completed);
    assert.ok(adopted.reviewId);const review=await reviews.snapshot(adopted.reviewId!);assert.equal(review.canAccept,true,JSON.stringify(review));
    const manifest=JSON.parse(await readFile(join(data.config.outputDir,"review-manifest.json"),"utf8"));
    assert.equal(manifest.schema,"negi-task-readonly-review/1");assert.equal(manifest.diff,undefined);
    await tasks.close();const restored=await LocalTaskService.open(data.catalog,runtime);
    try{const restoredReviews=await LocalReviewService.open(reviewConfig);await restored.connectReviews(restoredReviews);
      assert.equal((await restored.snapshot(data.config.runId)).reviewId,adopted.reviewId);
      assert.equal((await restoredReviews.snapshot(adopted.reviewId!)).canAccept,true);
    }finally{await restored.close()}
  }finally{await tasks.close()}
}));

test("partial research registration holds success notifications and resumes create-only review without dispatch",async()=>researchFixture(async data=>{
  let dispatches=0;const runtime={prepare:data.prepare,submit:submitVaultRun,execute:async(...args:Parameters<typeof completeResearch>)=>{
    dispatches++;return completeResearch(...args)}};
  const reviewConfig={storageRoot:join(data.dir,"human-reviews"),writableRoots:[],cases:[]};
  const reviews=await LocalReviewService.open(reviewConfig),tasks=await LocalTaskService.open(data.catalog,runtime);
  reviews.registerPinnedResult=async(item,runId,artifactRef)=>{
    const chain=new FileReviewChain(item.ledgerPath);if(!(await chain.read()).state)await chain.append({key:"pinned-result:create",at:new Date().toISOString(),
      action:{type:"create",caseId:item.id,runId,artifact:{ref:artifactRef,sha256:item.verifiedArtifactSha256,objectiveId:runId}}});
    throw Error("Injected interruption before verification/registration");
  };
  try{await tasks.connectReviews(reviews);const before=await tasks.snapshot(data.config.runId);
    await tasks.start(before.id,before.configSha256,randomUUID());await until(async()=>!(await tasks.snapshot(before.id)).live);
    const held=await tasks.snapshot(before.id);assert.equal(held.reviewId,null);assert.match(held.error??"",/調査成果/);
    assert.deepEqual(await tasks.resultNotifications(),[]);assert.equal(dispatches,1);
    const pinned=await readFile(join(data.config.outputDir,"review-result.md")),manifest=await readFile(join(data.config.outputDir,"review-manifest.json"));
    await tasks.close();const restoredReviews=await LocalReviewService.open(reviewConfig),restored=await LocalTaskService.open(data.catalog,runtime);
    try{await restored.connectReviews(restoredReviews);const ready=await restored.snapshot(before.id);assert.ok(ready.reviewId);
      assert.equal((await restoredReviews.snapshot(ready.reviewId!)).canAccept,true);assert.equal((await restored.resultNotifications()).length,1);
      assert.deepEqual(await readFile(join(data.config.outputDir,"review-result.md")),pinned);
      assert.deepEqual(await readFile(join(data.config.outputDir,"review-manifest.json")),manifest);assert.equal(dispatches,1);
    }finally{await restored.close()}
  }finally{await tasks.close()}
}));
