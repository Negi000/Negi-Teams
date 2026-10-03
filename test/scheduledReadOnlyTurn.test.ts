import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler, type SchedulerEvent } from
  "../src/server/orchestration/scheduler.ts";
import { runScheduledReadOnlyTurn } from
  "../src/server/orchestration/scheduledReadOnlyTurn.ts";
import { LocalPolicyService } from "../src/server/orchestration/policyService.ts";
import { policyFixture } from "./helpers/policyFixture.ts";

function event(key: string, action: SchedulerEvent["action"]): SchedulerEvent {
  return { key, at: "2026-09-30T00:00:00Z", action };
}
function client(model: string, hold: Promise<void> = Promise.resolve()) {
  let turns = 0;
  return { get turns() { return turns; },
    async initialize() {},
    async discoverModels() { return [{ model, efforts: ["low"], inputModalities: ["text"] }]; },
    async startThread(options: { cwd: string; model: string; sandbox: string }) {
      assert.equal(options.sandbox, "read-only");
      return { threadId: model + "-thread", requestedModel: model,
        resolvedModel: model, modelProvider: "test", rerouted: false };
    },
    async startTurn() { turns++; return model + "-turn"; },
    async waitForTurn(turnId: string) {
      await hold;
      return { turnId, status: "completed" as const, finalText: "READ_ONLY_OK",
        contextInputTokens: null, contextWindow: null, lastUsage: null };
    },
  };
}

// These historical mock execution cases await an enforced native MCP policy.
// They are pending, not evidence that research dispatch is currently available.
const researchPending="Codex 0.160.0 has no process-local enforced empty MCP allowlist";
test("two independent read-only roles can run within two global slots", {skip:researchPending}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-read-slots-"));
  try {
    const one = join(dir, "astra"), two = join(dir, "luna"), out = join(dir, "out");
    await Promise.all([mkdir(one), mkdir(two)]);
    const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 2, budgetUsd: 0 }));
    for (const [id, role, checkout] of [
      ["a", "astra", one], ["l", "luna", two],
    ] as const) {
      await scheduler.append(event(`submit-${id}`, { type: "submit", work: {
        id, parentId: null, dependencies: [], role, checkout,
        checkoutMode: "read", resources: [], reserveUsd: 0 } }));
    }
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const astra = client("gpt-6-astra", hold);
    const luna = client("gpt-6-luna", hold);
    const run = (workId: string, cwd: string, model: string,
                 selected: ReturnType<typeof client>) => runScheduledReadOnlyTurn({
      scheduler, dispatchKey: `dispatch-${workId}`, workId, client: selected,
      cwd, model, effort: "low", prompt: "Read-only bounded analysis", artifactDir: out,
      timeoutMs: 1000, verify: async (text) => text === "READ_ONLY_OK" });
    const running = Promise.all([run("a", one, "gpt-6-astra", astra),
      run("l", two, "gpt-6-luna", luna)]);
    for (let i = 0; i < 100; i++) {
      const statuses = (await scheduler.read()).state?.entries.map((item) => item.status);
      if (statuses?.every((status) => status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual((await scheduler.read()).state?.entries.map((item) => item.status),
      ["running", "running"]);
    release();
    const results = await running;
    assert.deepEqual(results.map((item) => item.status), ["verified", "verified"]);
    assert.equal(astra.turns, 1);
    assert.equal(luna.turns, 1);
    await assert.rejects(run("l", two, "gpt-6-luna", luna), /claim key already used/);
    assert.equal(luna.turns, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider error leaves the read-only slot for reconciliation", {skip:researchPending}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-read-error-"));
  try {
    const checkout = join(dir, "luna");
    await mkdir(checkout);
    const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    await scheduler.append(event("submit", { type: "submit", work: {
      id: "l", parentId: null, dependencies: [], role: "luna", checkout,
      checkoutMode: "read", resources: [], reserveUsd: 0 } }));
    const selected = { ...client("gpt-6-luna"),
      async waitForTurn() { throw new Error("provider timeout"); } };
    await assert.rejects(runScheduledReadOnlyTurn({ scheduler,
      dispatchKey: "dispatch-l", workId: "l", client: selected,
      cwd: checkout, model: "gpt-6-luna", effort: "low", prompt: "Read-only check",
      artifactDir: join(dir, "out"), timeoutMs: 1000, verify: async () => true }),
    /provider timeout/);
    assert.equal((await scheduler.read()).state?.entries[0].status, "needs_reconciliation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("opt-in dispatch pins one signed version while rollback affects the next turn; explicit profiles win", { skip: researchPending }, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    const decide = async (op: "approve" | "activate" | "rollback") => service.decide("v1", op, {
      requestId: randomUUID(), expectedSha256: (await service.list()).sha256, reason: op === "rollback" ? "検証用の差し戻し" : undefined });
    await decide("approve"); await decide("activate");
    const scheduler = new FileScheduler(join(fixture.directory, "scheduler.jsonl"));
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    const register = async (id: string) => scheduler.append(event(`submit-${id}`, { type: "submit", work: {
      id, parentId: null, dependencies: [], role: "luna", checkout: fixture.checkout,
      checkoutMode: "read", resources: [], reserveUsd: 0 } }));
    let release!: () => void, started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { started = resolve; });
    const efforts: string[] = [];
    const provider = { ...client("gpt-6-luna", hold),
      async discoverModels() { return [{ model: "gpt-6-luna", efforts: ["medium", "low"], inputModalities: ["text"] }]; },
      async startTurn(_prompt: string, effort: string) { efforts.push(effort); started(); return "pinned-turn"; } };
    const run = (id: string, approvedPolicy?: LocalPolicyService) => runScheduledReadOnlyTurn({ scheduler,
      dispatchKey: `dispatch-${id}`, workId: id, client: provider, cwd: fixture.checkout, model: "gpt-6-luna", effort: "medium",
      approvedPolicy, prompt: "Read-only fixed task", artifactDir: join(fixture.directory, "out"), timeoutMs: 1000, verify: async () => true });
    await register("pinned");
    const running = run("pinned", service); await start; await decide("rollback"); release();
    const result = await running;
    assert.equal(result.profile.source, "approved-policy"); assert.equal(result.profile.policyId, "v1");
    assert.equal(result.profile.effort, "low"); assert.deepEqual(efforts, ["low"]);
    const pin = JSON.parse(await readFile(result.profile.selectionRef.split("#sha256=")[0], "utf8"));
    assert.equal(pin.policyHash, result.profile.policyHash); assert.equal(pin.effort, "low");
    await register("default"); const fallback = await run("default", service);
    assert.equal(fallback.profile.source, "default"); assert.equal(fallback.profile.effort, "medium");
    // A new active candidate must never override a dispatch that has no opt-in.
    const freshConfig = { ...fixture.config, storageRoot: join(fixture.directory, "second-authority") };
    const activeService = await LocalPolicyService.open(freshConfig, [fixture.checkout], fixture.secret);
    for (const op of ["approve", "activate"] as const) await activeService.decide("v1", op, {
      requestId: randomUUID(), expectedSha256: (await activeService.list()).sha256 });
    await register("explicit"); const explicit = await run("explicit");
    assert.equal(explicit.profile.source, "explicit"); assert.equal(explicit.profile.effort, "medium");
    assert.deepEqual(efforts, ["low", "medium", "medium"]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("policy evidence failure stops dispatch without weakening read-only scheduler boundaries", {skip:researchPending}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-read-policy-error-"));
  try {
    const checkout = join(dir, "checkout"); await mkdir(checkout);
    const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    await scheduler.append(event("submit", { type: "submit", work: { id: "l", parentId: null, dependencies: [],
      role: "luna", checkout, checkoutMode: "read", resources: [], reserveUsd: 0 } }));
    const provider = client("gpt-6-luna");
    await assert.rejects(runScheduledReadOnlyTurn({ scheduler, dispatchKey: "dispatch-l", workId: "l", client: provider,
      cwd: checkout, model: "gpt-6-luna", effort: "low", approvedPolicy: { async select() { throw Error("altered evidence"); } },
      prompt: "Read-only", artifactDir: join(dir, "out"), timeoutMs: 1000, verify: async () => true }), /altered evidence/);
    assert.equal(provider.turns, 0); assert.equal((await scheduler.read()).state!.entries[0].status, "needs_reconciliation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scheduled research is held for every role before claims, policy selection, artifacts or provider calls",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"negi-read-isolation-hold-"));
  try{
    const checkout=join(dir,"checkout"),out=join(dir,"out");await mkdir(checkout);
    const scheduler=new FileScheduler(join(dir,"scheduler.jsonl"));
    await scheduler.append(event("configure",{type:"configure",maxConcurrent:2,budgetUsd:0}));
    for(const role of ["astra","sol","luna"] as const)await scheduler.append(event("submit-"+role,{type:"submit",work:{
      id:role,parentId:null,dependencies:[],role,checkout,checkoutMode:"read",resources:[],reserveUsd:0}}));
    const before=await readFile(scheduler.path);let policies=0,providerCalls=0;
    for(const role of ["astra","sol","luna"] as const){
      const provider={...client("gpt-6-"+role),initialize:async()=>{providerCalls++}};
      await assert.rejects(runScheduledReadOnlyTurn({scheduler,dispatchKey:"dispatch-"+role,workId:role,client:provider,
        cwd:checkout,model:"gpt-6-"+role,effort:"low",prompt:"Read the fixed scope",artifactDir:out,timeoutMs:1000,
        approvedPolicy:{select:async()=>{policies++;return null}},verify:async()=>{throw Error("Must not verify")}}),/process-local MCP policy is not enforced/);
      assert.equal(provider.turns,0);
    }
    assert.equal(providerCalls,0);assert.equal(policies,0);
    assert.deepEqual(await readFile(scheduler.path),before);
    assert.equal(await access(out).then(()=>true,()=>false),false);
  }finally{await rm(dir,{recursive:true,force:true})}
});
