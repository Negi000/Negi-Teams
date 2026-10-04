import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runSingleTask, type SingleTaskClient } from "../src/server/orchestration/singleTaskRunner.ts";

const contract={vaultId:"NT-TASK-ADMISSION",version:1,sha256:"a".repeat(64),project:"fixture",objective:"Resolve selected results",
  acceptance:["fixed checks pass"],baseSha:"b".repeat(40),scope:{in:["one file"],out:["publication"],allowedPaths:["src"]},
  invariants:["preserve source results"],verification:["fixed checks"],escalation:["stop on stale source"],limits:{maxAttempts:1,timeLimitMinutes:5}};
const approvedPlan={text:"Combine pinned results",approvalRef:"user:http-task-plan:fixture",threadId:"master",turnId:"plan",callId:"proposal"};

test("provider source admission distinguishes a known unsent thread/turn from an invoked unknown RPC",async()=>{
  for(const scenario of ["deny-thread","deny-turn","unknown-thread","unknown-turn","normal","deny-astra"]){
    const root=await mkdtemp(join(tmpdir(),"negi-provider-admission-"));
    try{
      let threads=0,turns=0,checks=0,admissions=0;
      const client:SingleTaskClient={async initialize(){},async discoverModels(){return[{model:"fixture",efforts:["medium"],inputModalities:["text"]}]},
        async startThread(options){threads++;if(scenario==="unknown-thread")throw Error("RPC connection lost");
          return{threadId:"thread",requestedModel:options.model,resolvedModel:options.model,modelProvider:"fixture",rerouted:false}},
        async startTurn(){turns++;if(scenario==="unknown-turn")throw Error("RPC outcome unknown");return"turn"},
        async waitForTurn(turnId){return{turnId,status:"completed",finalText:"Work ready",contextInputTokens:null,contextWindow:null,lastUsage:null}}};
      const role={model:"fixture",effort:"medium",client},ledger=new FileTaskLedger(join(root,"run.jsonl"));
      const state=await runSingleTask({runId:scenario,contract,cwd:root,astra:role,sol:role,ledger,artifactDir:join(root,"artifacts"),turnTimeoutMs:1000,
        ...(scenario==="deny-astra"?{}:{approvedPlan}),
        providerAdmission:async operation=>{admissions++;if(scenario==="deny-thread"||scenario==="deny-astra"||scenario==="deny-turn"&&admissions===2)
          throw Error("Pinned source changed");return operation()},verify:async()=>{checks++;return{outcome:"passed",evidenceRef:"fixture:checks"}}});
      assert.equal(state.acceptedBy,null);
      assert.equal(threads,scenario==="deny-thread"||scenario==="deny-astra"?0:1);
      assert.equal(turns,scenario==="normal"||scenario==="unknown-turn"?1:0);
      assert.equal(checks,scenario==="normal"?1:0);
      const events=(await ledger.read()).events;
      if(scenario.startsWith("unknown")){assert.equal(state.status,"needs_reconciliation");assert.ok(events.some(e=>e.action.type==="provider_unknown"));}
      else if(scenario.startsWith("deny")){assert.equal(state.attempts.at(-1)!.state,"failed");assert.ok(events.some(e=>e.action.type==="fail_attempt"));
        assert.ok(!events.some(e=>e.action.type==="provider_unknown"));if(scenario==="deny-astra")assert.equal(state.attempts[0].role,"astra");}
      else{assert.equal(state.status,"ready_for_review");assert.equal(admissions,2);}
    }finally{await rm(root,{recursive:true,force:true})}
  }
});

test("source guard stays held through the awaited provider dispatch",async()=>{
  const root=await mkdtemp(join(tmpdir(),"negi-provider-guard-"));
  try{
    let guarded=false;
    const client:SingleTaskClient={async initialize(){},async discoverModels(){return[{model:"fixture",efforts:["medium"],inputModalities:["text"]}]},
      async startThread(options){assert.equal(guarded,true);await new Promise(r=>setTimeout(r,10));assert.equal(guarded,true);
        return{threadId:"thread",requestedModel:options.model,resolvedModel:options.model,modelProvider:"fixture",rerouted:false}},
      async startTurn(){assert.equal(guarded,true);await new Promise(r=>setTimeout(r,10));assert.equal(guarded,true);return"turn"},
      async waitForTurn(turnId){assert.equal(guarded,false);return{turnId,status:"completed",finalText:"Ready",contextInputTokens:null,contextWindow:null,lastUsage:null}}};
    const role={model:"fixture",effort:"medium",client};
    const state=await runSingleTask({runId:"guarded",contract,cwd:root,astra:role,sol:role,approvedPlan,ledger:new FileTaskLedger(join(root,"run.jsonl")),
      artifactDir:join(root,"artifacts"),turnTimeoutMs:1000,providerAdmission:async operation=>{assert.equal(guarded,false);guarded=true;
        try{return await operation()}finally{guarded=false}},verify:async()=>({outcome:"passed",evidenceRef:"fixture:checks"})});
    assert.equal(state.status,"ready_for_review");
  }finally{await rm(root,{recursive:true,force:true})}
});
