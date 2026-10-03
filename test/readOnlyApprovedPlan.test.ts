import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runSingleTask, type SingleTaskClient } from "../src/server/orchestration/singleTaskRunner.ts";
import { researchFixture } from "./helpers/readOnlyTaskFixture.ts";

test("approved research plan calls only Luna in read-only mode without a second Astra plan",async()=>researchFixture(async data=>{
  let workerTurns=0,checks=0;
  const forbidden=new Proxy({},{get:()=>()=>{throw Error("Approved plan must not initialize Astra")}}) as SingleTaskClient;
  const luna:SingleTaskClient={initialize:async()=>{},discoverModels:async()=>[{model:"gpt-6-luna",efforts:["low"],inputModalities:["text"]}],
    startThread:async options=>{assert.equal(options.readOnlyContract,true);assert.equal(options.sandbox,"read-only");
      return{threadId:"luna-thread",requestedModel:options.model,resolvedModel:options.model,modelProvider:"fixture",rerouted:false}},
    startTurn:async prompt=>{workerTurns++;assert.match(prompt,/署名した調査計画/);return"luna-turn"},
    waitForTurn:async turnId=>({turnId,status:"completed",finalText:"根拠: docs/base.md:1。",contextInputTokens:null,contextWindow:null,lastUsage:null})};
  const approvedPlan={text:"署名した調査計画",approvalRef:"user:http-task-plan:fixture",threadId:"original-astra",turnId:"original-plan",callId:"proposal"};
  const state=await runSingleTask({runId:data.config.runId,contract:{...data.contract,approvedPlan},cwd:data.config.checkout,
    astra:{client:forbidden,...data.config.astra},luna:{client:luna,...data.config.luna!},ledger:new FileTaskLedger(join(data.config.outputDir,"direct.jsonl")),
    artifactDir:join(data.config.outputDir,"direct-artifacts"),turnTimeoutMs:1000,
    approvedPlan,
    verify:async()=>{checks++;return{outcome:"passed",evidenceRef:"fixture:verified"}}});
  assert.deepEqual(state.attempts.map(a=>a.role),["luna"]);assert.equal(workerTurns,1);assert.equal(checks,1);
  assert.equal(state.status,"ready_for_review");assert.equal(state.acceptedBy,null);
}));
test("an oversized fixed research contract is rejected before any provider or Task ledger starts",async()=>researchFixture(async data=>{
  let calls=0;const forbidden=new Proxy({},{get:()=>()=>{calls++;throw Error("must not initialize")}}) as SingleTaskClient;
  const ledger=new FileTaskLedger(join(data.config.outputDir,"oversized.jsonl"));
  await assert.rejects(runSingleTask({runId:data.config.runId,contract:{...data.contract,acceptance:Array(30).fill("\u0001".repeat(1000))},
    cwd:data.config.checkout,astra:{client:forbidden,...data.config.astra},luna:{client:forbidden,...data.config.luna!},ledger,
    artifactDir:join(data.config.outputDir,"unused-artifacts"),turnTimeoutMs:1000,verify:async()=>{throw Error("must not verify")}}),/split it before dispatch/);
  assert.equal(calls,0);assert.equal((await ledger.read()).state,null);
}));
