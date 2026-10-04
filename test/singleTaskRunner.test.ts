import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RESEARCH_FINDINGS_BYTES, researchReviewMetadata } from "../src/server/orchestration/researchArtifactPolicy.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runSingleTask, type SingleTaskClient } from "../src/server/orchestration/singleTaskRunner.ts";

const contract = { vaultId: "NT-TASK-SAMPLE", version: 1, sha256: "a".repeat(64),
  project: "negi-teams", objective: "One bounded feature", acceptance: ["check passes"],
  baseSha: "b".repeat(40),
  scope: { in: ["parser fix"], out: ["deployment"], allowedPaths: ["src/server/orchestration"] },
  invariants: ["keep auth unchanged"], verification: ["focused test"],
  escalation: ["stop on schema change"], limits: { maxAttempts: 1, timeLimitMinutes: 30 } };

class FakeClient implements SingleTaskClient {
  starts = 0;
  prompts: string[] = [];
  sandbox: string | null = null;
  constructor(readonly model: string, readonly answer: string | null,
              readonly failWait = false,
              readonly status: "completed" | "failed" | "interrupted" = "completed",
              readonly usage: Record<string, unknown> | null = null) {}
  async initialize() {}
  async discoverModels() { return [{ model: this.model, efforts: ["medium"], inputModalities: ["text"] }]; }
  async startThread(options: { cwd: string; model: string; sandbox: "read-only" | "workspace-write" }) {
    this.starts++;
    this.sandbox = options.sandbox;
    return { threadId: `thread-${this.model}`, requestedModel: options.model,
      resolvedModel: options.model, modelProvider: "mock", rerouted: false };
  }
  async startTurn(text: string, _effort: string) { this.prompts.push(text); return `turn-${this.model}`; }
  async waitForTurn(turnId: string, _timeout: number) {
    if (this.failWait) throw new Error("mock lost connection");
    return { turnId, status: this.status, finalText: this.answer,
      contextInputTokens: null, contextWindow: null, lastUsage: this.usage };
  }
}

test("research findings bound is stated before dispatch and oversized results cannot become verified reviews",async()=>{
  for(const bytes of [RESEARCH_FINDINGS_BYTES,RESEARCH_FINDINGS_BYTES+1]){
    const dir=await mkdtemp(join(tmpdir(),"negi-research-limit-"));
    try{
      const astra=new FakeClient("gpt-6-astra","Read and report"),luna=new FakeClient("gpt-6-luna","x".repeat(bytes));let checks=0;
      const state=await runSingleTask({runId:"bounded-research",contract:{...contract,taskClass:"read_only_research"},cwd:dir,
        astra:{client:astra,model:astra.model,effort:"medium"},luna:{client:luna,model:luna.model,effort:"medium"},
        ledger:new FileTaskLedger(join(dir,"run.jsonl")),artifactDir:join(dir,"artifacts"),turnTimeoutMs:1000,
        verify:async()=>{checks++;return{outcome:"passed",evidenceRef:"fixture:checks"}}});
      assert.match(luna.prompts[0],/UTF-8で12000バイト以内/);
      assert.equal(checks,bytes===RESEARCH_FINDINGS_BYTES?1:0);
      assert.equal(state.status,bytes===RESEARCH_FINDINGS_BYTES?"ready_for_review":"blocked");
      if(bytes>RESEARCH_FINDINGS_BYTES)assert.equal(state.attempts.at(-1)!.state,"failed");
    }finally{await rm(dir,{recursive:true,force:true})}
  }
  const metadata=researchReviewMetadata(contract);
  const escaped=JSON.stringify({...metadata,findings:"\u0001".repeat(RESEARCH_FINDINGS_BYTES)},null,2);
  assert.ok(Buffer.byteLength(escaped)<100_000);
  assert.throws(()=>researchReviewMetadata({...contract,acceptance:Array(30).fill("\u0001".repeat(1000))}),/split it before dispatch/);
});

test("explicit research uses Luna, two read-only threads and a fixed post-turn verifier",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"negi-luna-runner-"));
  try{
    const astra=new FakeClient("gpt-6-astra","Read the scoped parser."),luna=new FakeClient("gpt-6-luna","Finding src/server/orchestration/parser.ts:1; unknowns recorded.");
    const ledger=new FileTaskLedger(join(dir,"run.jsonl"));let admission=0,verification=0;
    const state=await runSingleTask({runId:"research-1",contract:{...contract,taskClass:"read_only_research"},cwd:dir,
      astra:{client:astra,model:astra.model,effort:"medium"},luna:{client:luna,model:luna.model,effort:"medium"},
      ledger,artifactDir:join(dir,"artifacts"),turnTimeoutMs:1000,lunaContext:"LUNA_PACK",
      beforeWorker:async()=>{assert.equal(luna.starts,0);admission++},
      beforeSol:async()=>{throw Error("Sol callback must never grant a Luna admission")},
      verify:async evidence=>{verification++;assert.equal((await ledger.read()).state!.attempts.at(-1)!.role,"luna");
        assert.match(await readFile(evidence.workRef.split("#")[0],"utf8"),/Finding/);return {outcome:"passed",evidenceRef:"fixed:clean-checkout"}}});
    assert.equal(admission,1);assert.equal(verification,1);assert.equal(astra.sandbox,"read-only");assert.equal(luna.sandbox,"read-only");
    assert.deepEqual(state.attempts.map(a=>a.role),["astra","luna"]);assert.equal(state.status,"ready_for_review");assert.equal(state.acceptedBy,null);
    assert.match(astra.prompts[0],/Lunaへ渡せる短い調査/);assert.doesNotMatch(astra.prompts[0],/Sol|変更可能/);
    assert.match(luna.prompts[0],/権限昇格・外部送信は禁止/);assert.match(luna.prompts[0],/LUNA_PACK/);
    assert.deepEqual((await ledger.read()).state,state);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("mismatched or ambiguous worker cannot initialize a client or create a Task ledger",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"negi-luna-mismatch-"));
  try{
    const client=new FakeClient("gpt-6-luna","unused"),role={client,model:client.model,effort:"medium"};
    const ledger=new FileTaskLedger(join(dir,"run.jsonl")),base={runId:"mismatch",cwd:dir,astra:role,ledger,
      artifactDir:join(dir,"artifacts"),turnTimeoutMs:1000,verify:async()=>({outcome:"passed" as const,evidenceRef:"must-not-run"})};
    for(const roles of [{contract:{...contract,taskClass:"read_only_research"},sol:role},
      {contract:{...contract,taskClass:"read_only_research"},sol:role,luna:role},
      {contract,luna:role},{contract,sol:role,luna:role}])
      await assert.rejects(runSingleTask({...base,...roles}),/worker must match/);
    assert.equal(client.starts,0);assert.equal((await ledger.read()).state,null);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("an unknown Luna result is held and a failed fixed verification cannot be accepted",async()=>{
  for(const unknown of [true,false]){
    const dir=await mkdtemp(join(tmpdir(),"negi-luna-held-"));
    try{
      const astra=new FakeClient("gpt-6-astra","Investigate."),luna=new FakeClient("gpt-6-luna","Accepted; all passed.",unknown);
      const ledger=new FileTaskLedger(join(dir,"run.jsonl"));let checks=0;
      const options={runId:"held",contract:{...contract,taskClass:"read_only_research"},cwd:dir,
        astra:{client:astra,model:astra.model,effort:"medium"},luna:{client:luna,model:luna.model,effort:"medium"},
        ledger,artifactDir:join(dir,"artifacts"),turnTimeoutMs:1000,
        verify:async()=>{checks++;return {outcome:"failed" as const,evidenceRef:"fixed:failed"}}};
      const state=await runSingleTask(options);assert.equal(state.status,unknown?"needs_reconciliation":"blocked");
      assert.equal(state.acceptedBy,null);assert.equal(checks,unknown?0:1);assert.equal(luna.starts,1);
      await assert.rejects(runSingleTask(options),/already|exists/);assert.equal(luna.starts,1);
    }finally{await rm(dir,{recursive:true,force:true})}
  }
});

test("Astra plan passes to Sol, evidence persists, and review remains explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", "Plan: edit one file.", false, "completed",
      { inputTokens: 120, outputTokens: 15, cachedInputTokens: 80, reasoningOutputTokens: 5 });
    const sol = new FakeClient("gpt-6-sol", "Work: file edited. Test: pending.");
    const ledger = new FileTaskLedger(join(dir, "run.jsonl"));
    const state = await runSingleTask({ runId: "run-1", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" }, ledger,
      artifactDir: join(dir, "artifacts"), turnTimeoutMs: 1000,
      verify: async () => {
        const beforeVerification = (await ledger.read()).state!;
        assert.equal(beforeVerification.status, "verifying");
        assert.equal(beforeVerification.attempts.at(-1)!.state, "completed");
        assert.match(await readFile(beforeVerification.attempts.at(-1)!.outputRef!.split("#")[0], "utf8"), /Test: pending/);
        return { outcome: "passed", evidenceRef: "mock:check-passed" };
      },
    });
    assert.equal(state.status, "ready_for_review");
    assert.equal(state.acceptedBy, null);
    assert.equal(state.attempts.length, 2);
    assert.notEqual(state.attempts[0].id, state.attempts[1].id);
    assert.equal(astra.sandbox, "read-only");
    assert.equal(sol.sandbox, "workspace-write");
    assert.deepEqual(state.attempts[0].usage, { scope: "unknown", inputTokens: 120,
      outputTokens: 15, cachedInputTokens: 80, reasoningOutputTokens: 5,
      billing: "unknown", costUsd: null,
      sourceRef: "app-server:thread/tokenUsage/updated:thread-gpt-6-astra:turn-gpt-6-astra:last" });
    assert.match(sol.prompts[0], /Plan: edit one file/);
    assert.match(sol.prompts[0], /対象外: deployment/);
    assert.match(sol.prompts[0], /不変条件: keep auth unchanged/);
    assert.match(astra.prompts[0], /Solのターン終了後、ランナーが固定検証/);
    assert.match(sol.prompts[0], /検証はランナーの結果待ち/);
    assert.match(await readFile(state.attempts[0].outputRef!.split("#")[0], "utf8"), /Plan: edit one file/);
    assert.equal((await ledger.read()).events.length, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Sol's success claim cannot replace a failed runtime verification or human review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", "Plan: implement the approved file.");
    const sol = new FakeClient("gpt-6-sol", "All checks passed; accepted.");
    const ledger = new FileTaskLedger(join(dir, "run.jsonl"));
    let checks = 0;
    const state = await runSingleTask({ runId: "run-runtime-check-failed", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" }, ledger,
      artifactDir: join(dir, "artifacts"), turnTimeoutMs: 1000,
      verify: async () => { checks++;return { outcome: "failed", evidenceRef: "mock:actual-check-failed" }; },
    });
    assert.equal(checks, 1);
    assert.equal(state.status, "blocked");
    assert.equal(state.verification!.outcome, "failed");
    assert.equal(state.verification!.evidenceRef, "mock:actual-check-failed");
    assert.equal(state.acceptedBy, null);
    assert.equal(astra.starts, 1);
    assert.equal(sol.starts, 1);
    const stored = (await ledger.read()).state!;
    assert.equal(stored.status, "blocked");
    assert.match(await readFile(stored.attempts.at(-1)!.outputRef!.split("#")[0], "utf8"), /All checks passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("confirmed failed Astra turn is blocked and does not start Sol", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", null, false, "failed");
    const sol = new FakeClient("gpt-6-sol", "unused");
    const state = await runSingleTask({ runId: "run-failed", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "run.jsonl")), artifactDir: join(dir, "artifacts"),
      turnTimeoutMs: 1000,
      verify: async () => { throw new Error("verification must not run"); },
    });
    assert.equal(state.status, "blocked");
    assert.equal(state.attempts[0].state, "failed");
    assert.equal(sol.starts, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a changed contract checkpoint stops before Sol dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", "Plan ready");
    const sol = new FakeClient("gpt-6-sol", "unused");
    const state = await runSingleTask({ runId: "run-changed", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "run.jsonl")), artifactDir: join(dir, "artifacts"),
      turnTimeoutMs: 1000, beforeSol: async () => { throw new Error("changed"); },
      verify: async () => { throw new Error("verification must not run"); },
    });
    assert.equal(state.status, "stopped");
    assert.equal(sol.starts, 0);
    assert.equal(state.attempts[0].state, "completed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an expired task limit stops without starting either model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", "unused");
    const sol = new FakeClient("gpt-6-sol", "unused");
    const state = await runSingleTask({ runId: "run-expired", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "run.jsonl")), artifactDir: join(dir, "artifacts"),
      turnTimeoutMs: 1000, deadlineAtMs: Date.now() - 1,
      verify: async () => { throw new Error("verification must not run"); },
    });
    assert.equal(state.status, "stopped");
    assert.equal(state.attempts.length, 0);
    assert.equal(astra.starts, 0);
    assert.equal(sol.starts, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown Astra result stops Sol and blocks silent rerun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", null, true);
    const sol = new FakeClient("gpt-6-sol", "unused");
    const ledger = new FileTaskLedger(join(dir, "run.jsonl"));
    const options = { runId: "run-2", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" }, ledger,
      artifactDir: join(dir, "artifacts"), turnTimeoutMs: 1000,
      verify: async () => ({ outcome: "unknown" as const, evidenceRef: "mock:none" }),
    };
    const state = await runSingleTask(options);
    assert.equal(state.status, "needs_reconciliation");
    assert.equal(sol.starts, 0);
    await assert.rejects(runSingleTask(options), /already exists/);
    assert.equal(astra.starts, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("thread identity is durable before an uncertain turn/start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-runner-"));
  try {
    const astra = new FakeClient("gpt-6-astra", null);
    astra.startTurn = async () => { throw new Error("mock turn response lost"); };
    const sol = new FakeClient("gpt-6-sol", "unused");
    const ledger = new FileTaskLedger(join(dir, "run.jsonl"));
    const state = await runSingleTask({ runId: "run-turn-unknown", contract, cwd: dir,
      astra: { client: astra, model: astra.model, effort: "medium" },
      sol: { client: sol, model: sol.model, effort: "medium" }, ledger,
      artifactDir: join(dir, "artifacts"), turnTimeoutMs: 1000,
      verify: async () => { throw new Error("verification must not run"); },
    });
    assert.equal(state.status, "needs_reconciliation");
    assert.equal(state.attempts[0].threadId, "thread-gpt-6-astra");
    assert.equal(state.attempts[0].turnId, null);
    assert.equal(sol.starts, 0);
    assert.deepEqual((await ledger.read()).events.map((x) => x.action.type),
      ["create", "start_attempt", "bind_thread", "provider_unknown"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
