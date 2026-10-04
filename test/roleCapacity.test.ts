import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler, schedulerCapacityUsage, type ScheduledWork, type SchedulerAction } from "../src/server/orchestration/scheduler.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runSingleTask, type SingleTaskClient } from "../src/server/orchestration/singleTaskRunner.ts";
import { runScheduledVaultTask } from "../src/server/orchestration/scheduledVaultRun.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";

const at = "2026-10-01T00:00:00Z";
async function record(scheduler: FileScheduler, action: SchedulerAction) {
  return scheduler.append({ key: randomUUID(), at, action });
}
function work(dir: string, id: string, overrides: Partial<ScheduledWork> = {}): ScheduledWork {
  return { id, parentId: null, dependencies: [], role: "sol", checkout: join(dir, id),
    checkoutMode: "write", resources: [], reserveUsd: 0, execution: "direct", ...overrides };
}
async function fixture(run: (scheduler: FileScheduler, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-role-capacity-"));
  try { await run(new FileScheduler(join(dir, "scheduler.jsonl")), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const planRef = "synthetic-plan.md#sha256=" + "a".repeat(64);
const finish = (scheduler: FileScheduler, workId: string) => record(scheduler,
  { type: "finish_planning", workId, planRef, threadId: "planning-thread", turnId: "planning-turn" });
const settle = (scheduler: FileScheduler, workId: string) => record(scheduler,
  { type: "settle", workId, outcome: "verified", evidenceRef: "synthetic:terminal", actualCostUsd: null });

test("subscription capacity defaults to planner one and workers two; legacy migration only appends", async () => {
  await fixture(async (scheduler, dir) => {
    const fresh = await scheduler.ensureSubscriptionConfiguration();
    assert.equal(fresh.maxConcurrent, 3); assert.deepEqual(fresh.roleLimits, { planners: 1, workers: 2 });
    const legacy = new FileScheduler(join(dir, "legacy.jsonl"));
    await record(legacy, { type: "configure", maxConcurrent: 1, budgetUsd: 0 });
    const original = await readFile(legacy.path);
    await legacy.ensureSubscriptionConfiguration();
    assert.deepEqual((await readFile(legacy.path)).subarray(0, original.length), original);
    assert.equal((await legacy.read()).state!.maxConcurrent, 1);
    assert.deepEqual((await legacy.read()).state!.roleLimits, { planners: 1, workers: 2 });
    for (const maxConcurrent of [3, 1, 3]) await legacy.ensureSubscriptionConfiguration({ maxConcurrent, planners: 1, workers: 2 });
    assert.equal((await legacy.read()).state!.maxConcurrent, 3);
    const events = (await legacy.read()).events;
    assert.equal(new Set(events.map(e => e.key)).size, 5);
    await legacy.ensureSubscriptionConfiguration();
    assert.equal((await legacy.read()).events.length, 5);
    await assert.rejects(legacy.ensureSubscriptionConfiguration({ maxConcurrent: 3, planners: -1, workers: 2 }), /bounded/);
    await assert.rejects(legacy.ensureSubscriptionConfiguration({ maxConcurrent: 65, planners: 1, workers: 2 }), /bounded/);
  });
});

test("two workers leave one planner slot, and planning release retains the writer until worker admission", async () => {
  await fixture(async (scheduler, dir) => {
    await scheduler.ensureSubscriptionConfiguration();
    for (const id of ["one", "two"]) {
      await record(scheduler, { type: "submit", work: work(dir, id) }); await scheduler.claim(id, "claim-" + id);
    }
    await record(scheduler, { type: "submit", work: work(dir, "pipeline", { execution: "astra_to_sol" }) });
    await scheduler.claim("pipeline", "pipeline-planner");
    let usage = schedulerCapacityUsage((await scheduler.read()).state!);
    assert.deepEqual([usage.global, usage.planners, usage.workers], [3, 1, 2]);
    await record(scheduler, { type: "submit", work: work(dir, "master", { role: "astra", checkoutMode: "read" }) });
    assert.equal(await scheduler.tryClaim("master", "master-blocked"), null);
    await assert.rejects(record(scheduler, { type: "finish_planning", workId: "pipeline", planRef: "missing-digest",
      threadId: "thread", turnId: "turn" }), /bound output evidence/);
    await finish(scheduler, "pipeline");
    const reopened = new FileScheduler(scheduler.path);
    usage = schedulerCapacityUsage((await reopened.read()).state!);
    assert.deepEqual([usage.global, usage.planners, usage.workers, usage.waitingWorkers], [2, 0, 2, 1]);
    assert.equal(await reopened.tryStartWorker("pipeline", "worker-admission"), null);
    await record(scheduler, { type: "submit", work: work(dir, "conflict", { checkout: join(dir, "pipeline") }) });
    assert.equal(await scheduler.tryClaim("conflict", "conflicting-writer"), null);
    assert.ok(await scheduler.tryClaim("master", "master-admission"));
    await settle(scheduler, "one");
    assert.ok(await reopened.tryStartWorker("pipeline", "worker-admission"));
    usage = schedulerCapacityUsage((await scheduler.read()).state!);
    assert.deepEqual([usage.global, usage.planners, usage.workers], [3, 1, 2]);
    await assert.rejects(scheduler.tryStartWorker("pipeline", "worker-admission"), /key already used/);
    await assert.rejects(scheduler.append({ key: "bypass", at, action: { type: "start_worker", workId: "conflict" } }), /atomic/);
  });
});

test("simultaneous worker admissions across scheduler instances cannot exceed the worker limit", async () => {
  await fixture(async (scheduler, dir) => {
    await scheduler.ensureSubscriptionConfiguration({ maxConcurrent: 3, planners: 1, workers: 1 });
    for (const id of ["a", "b"]) {
      await record(scheduler, { type: "submit", work: work(dir, id, { execution: "astra_to_sol" }) });
      await scheduler.claim(id, id + "-plan"); await finish(scheduler, id);
    }
    const outcomes = await Promise.all([scheduler.tryStartWorker("a", "a-worker"),
      new FileScheduler(scheduler.path).tryStartWorker("b", "b-worker")]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal(schedulerCapacityUsage((await scheduler.read()).state!).workers, 1);
  });
});

test("Astra to Luna research uses the planner then worker capacity and retains its read lease while waiting or unknown",async()=>{
  await fixture(async(scheduler,dir)=>{
    await scheduler.ensureSubscriptionConfiguration({maxConcurrent:2,planners:1,workers:1});
    await record(scheduler,{type:"submit",work:work(dir,"worker")});await scheduler.claim("worker","busy");
    await record(scheduler,{type:"submit",work:work(dir,"research",{role:"luna",checkoutMode:"read",taskMode:"read_only_research",execution:"astra_to_luna"})});
    await scheduler.claim("research","research-plan");
    let usage=schedulerCapacityUsage((await scheduler.read()).state!);assert.deepEqual([usage.global,usage.planners,usage.workers],[2,1,1]);
    await finish(scheduler,"research");usage=schedulerCapacityUsage((await scheduler.read()).state!);
    assert.deepEqual([usage.global,usage.planners,usage.workers,usage.waitingWorkers],[1,0,1,1]);
    await record(scheduler,{type:"submit",work:work(dir,"writer",{checkout:join(dir,"research")})});
    assert.equal(await scheduler.tryClaim("writer","no-write"),null);assert.equal(await scheduler.tryStartWorker("research","no-worker"),null);
    await settle(scheduler,"worker");assert.ok(await scheduler.tryStartWorker("research","luna-worker"));
    await record(scheduler,{type:"unknown",workId:"research",reason:"Luna result uncertain"});
    const reopened=new FileScheduler(scheduler.path);usage=schedulerCapacityUsage((await reopened.read()).state!);
    assert.deepEqual([usage.global,usage.planners,usage.workers,usage.unresolved],[1,0,1,1]);
    assert.equal(await reopened.tryClaim("writer","still-no-write"),null);
  });
});

test("unknown planning and working hold their respective roles; unphased history counts conservatively", async () => {
  await fixture(async (scheduler, dir) => {
    await scheduler.ensureSubscriptionConfiguration();
    for (const id of ["planning", "working"]) {
      await record(scheduler, { type: "submit", work: work(dir, id, { execution: "astra_to_sol" }) });
    }
    await scheduler.claim("working", "first"); await finish(scheduler, "working");
    await scheduler.tryStartWorker("working", "worker");
    await scheduler.claim("planning", "second");
    for (const workId of ["planning", "working"]) await record(scheduler, { type: "unknown", workId, reason: "lost provider" });
    const usage = schedulerCapacityUsage((await new FileScheduler(scheduler.path).read()).state!);
    assert.deepEqual([usage.planners, usage.workers, usage.global, usage.unresolved], [1, 1, 2, 2]);
    await assert.rejects(finish(scheduler, "planning"), /running pipeline/);
    for (const workId of ["planning", "working"]) await record(scheduler,
      { type: "reconcile", workId, outcome: "failed", evidenceRef: "synthetic:reviewed", actualCostUsd: null });
    await record(scheduler, { type: "submit", work: work(dir, "legacy", { execution: undefined }) });
    await scheduler.claim("legacy", "legacy-claim");
    const legacyUsage = schedulerCapacityUsage((await scheduler.read()).state!);
    assert.deepEqual([legacyUsage.planners, legacyUsage.workers, legacyUsage.legacyUnphased], [1, 1, 1]);
    await settle(scheduler, "legacy");
    assert.equal(schedulerCapacityUsage((await scheduler.read()).state!).global, 0);
    await assert.rejects(record(scheduler, { type: "submit", work: work(dir, "wrong-role",
      { execution: "astra_to_sol", role: "luna" }) }), /invalid/);
  });
});

test("lower limits drain active work and invalidated dependencies cannot start a waiting worker", async () => {
  await fixture(async (scheduler, dir) => {
    await scheduler.ensureSubscriptionConfiguration();
    await record(scheduler, { type: "submit", work: work(dir, "dependency") });
    await scheduler.claim("dependency", "dependency"); await settle(scheduler, "dependency");
    await record(scheduler, { type: "submit", work: work(dir, "pipeline", { execution: "astra_to_sol", dependencies: ["dependency"] }) });
    await scheduler.claim("pipeline", "plan"); await finish(scheduler, "pipeline");
    for (const id of ["a", "b"]) {
      await record(scheduler, { type: "submit", work: work(dir, id) }); await scheduler.claim(id, id);
    }
    await scheduler.ensureSubscriptionConfiguration({ maxConcurrent: 1, planners: 1, workers: 1 });
    assert.equal((await scheduler.read()).state!.entries.filter(e => e.status === "running").length, 3);
    assert.equal(await scheduler.tryStartWorker("pipeline", "wait"), null);
    await settle(scheduler, "a");
    assert.equal(await scheduler.tryStartWorker("pipeline", "still-wait"), null);
    await record(scheduler, { type: "invalidate", workId: "dependency", evidenceRef: "synthetic:defect", reason: "source invalid" });
    await settle(scheduler, "b");
    await assert.rejects(scheduler.tryStartWorker("pipeline", "invalidated"), /running pipeline/);
    const usage = schedulerCapacityUsage((await scheduler.read()).state!);
    assert.deepEqual([usage.global, usage.waitingWorkers, usage.unresolved], [0, 1, 1]);
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class SyntheticClient implements SingleTaskClient {
  turns = 0;
  constructor(readonly model: string, readonly onTurn: () => Promise<void> = async () => {}) {}
  async initialize() {}
  async discoverModels() { return [{ model: this.model, efforts: ["low"], inputModalities: ["text"] }]; }
  async startThread(options: Parameters<SingleTaskClient["startThread"]>[0]) {
    return { threadId: randomUUID(), requestedModel: options.model, resolvedModel: options.model,
      modelProvider: "synthetic", rerouted: false };
  }
  async startTurn() { this.turns++; return randomUUID(); }
  async waitForTurn(turnId: string) {
    await this.onTurn();
    return { turnId, status: "completed" as const, finalText: "Synthetic bounded output",
      contextInputTokens: null, contextWindow: null, lastUsage: null };
  }
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error("Controlled role transition did not arrive");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const contract = { schemaVersion: "negi-task-contract/1" as const, vaultId: "NT-SYNTHETIC-ROLE", version: 1,
  sha256: "a".repeat(64), project: "fixture", objective: "Synthetic capacity check", acceptance: ["bounded concurrency"],
  baseSha: "b".repeat(40), scope: { in: ["synthetic"], out: ["publishing"], allowedPaths: ["docs/result.md"] },
  invariants: [], verification: ["synthetic verification"], escalation: [],
  limits: { maxAttempts: 1, timeLimitMinutes: 5 }, sourceNotes: [] };

test("real runner checkpoints wait, cancel or expire before any Sol turn; changed plan blocks dispatch", async () => {
  for (const mode of ["release", "cancel", "expire", "changed-plan", "changed-during-wait"] as const) {
    await fixture(async (scheduler, dir) => {
      await scheduler.ensureSubscriptionConfiguration({ maxConcurrent: 3, planners: 1, workers: 1 });
      await record(scheduler, { type: "submit", work: work(dir, "held") }); await scheduler.claim("held", "held");
      await record(scheduler, { type: "submit", work: work(dir, "pipeline", { execution: "astra_to_sol" }) });
      const astra = new SyntheticClient("synthetic-astra"), sol = new SyntheticClient("synthetic-sol"), controller = new AbortController();
      const ledger = new FileTaskLedger(join(dir, "run.jsonl"));
      const options = { runId: "pipeline", cwd: join(dir, "pipeline"), ledger, artifactDir: join(dir, "artifacts"),
        contract, astra: { client: astra, model: astra.model, effort: "low" }, sol: { client: sol, model: sol.model, effort: "low" },
        turnTimeoutMs: 2000, deadlineAtMs: mode === "expire" ? Date.now() + 800 : undefined,
        beforeSol: mode === "changed-plan" ? async () => {
          const ref = (await ledger.read()).state!.attempts[0].outputRef!;
          await writeFile(ref.slice(0, ref.lastIndexOf("#sha256=")), "tampered");
        } : undefined,
        verify: async () => ({ outcome: "passed" as const, evidenceRef: "synthetic:verified" }) };
      const run = runScheduledVaultTask({ scheduler, dispatchKey: "dispatch", signal: controller.signal,
        run: options as unknown as Parameters<typeof runScheduledVaultTask>[0]["run"],
        execute: supplied => runSingleTask({ ...options, beforeSol: supplied.beforeSol }) });
      if (mode !== "changed-plan") {
        await until(async () => (await scheduler.read()).state!.entries.find(e => e.work.id === "pipeline")!.phase === "waiting_for_worker");
        assert.equal(sol.turns, 0);
        assert.equal(schedulerCapacityUsage((await scheduler.read()).state!).planners, 0);
        if (mode === "release") await settle(scheduler, "held");
        else if (mode === "cancel") controller.abort();
        else if (mode === "changed-during-wait") {
          const ref = (await ledger.read()).state!.attempts[0].outputRef!;
          await writeFile(ref.slice(0, ref.lastIndexOf("#sha256=")), "changed during worker wait");
          await settle(scheduler, "held");
        }
      }
      const state = await run;
      assert.equal(state.status, mode === "release" ? "ready_for_review" : "stopped");
      assert.equal(sol.turns, mode === "release" ? 1 : 0);
      assert.equal(state.acceptedBy, null);
      assert.equal((await scheduler.read()).state!.entries.find(e => e.work.id === "pipeline")!.status,
        mode === "release" ? "verified" : "failed");
      if (mode === "cancel") assert.match(state.stopReason!, /待機中に停止.*開始していません/);
      if (mode === "expire") assert.match(state.stopReason!, /制限時間.*開始していません/);
    });
  }
});

test("runner outcome uncertainty retains the active provider's role after reload", async () => {
  for (const lost of ["astra", "sol"] as const) await fixture(async (scheduler, dir) => {
    await scheduler.ensureSubscriptionConfiguration();
    await record(scheduler, { type: "submit", work: work(dir, "pipeline", { execution: "astra_to_sol" }) });
    const fail = async () => { throw Error("Synthetic provider disappeared"); };
    const astra = new SyntheticClient("synthetic-astra", lost === "astra" ? fail : undefined);
    const sol = new SyntheticClient("synthetic-sol", lost === "sol" ? fail : undefined);
    const base = { runId: "pipeline", cwd: join(dir, "pipeline"), ledger: new FileTaskLedger(join(dir, "run.jsonl")),
      artifactDir: join(dir, "artifacts"), contract, astra: { model: astra.model, effort: "low", client: astra },
      sol: { model: sol.model, effort: "low", client: sol }, turnTimeoutMs: 1000,
      verify: async () => ({ outcome: "passed" as const, evidenceRef: "synthetic:unused" }) };
    const state = await runScheduledVaultTask({ scheduler, dispatchKey: "dispatch",
      run: base as unknown as Parameters<typeof runScheduledVaultTask>[0]["run"],
      execute: options => runSingleTask({ ...base, beforeSol: options.beforeSol }) });
    assert.equal(state.status, "needs_reconciliation");
    const usage = schedulerCapacityUsage((await new FileScheduler(scheduler.path).read()).state!);
    assert.deepEqual([usage.global, usage.planners, usage.workers, usage.unresolved],
      lost === "astra" ? [1, 1, 0, 1] : [1, 0, 1, 1]);
    assert.equal(sol.turns, lost === "astra" ? 0 : 1); assert.equal(state.acceptedBy, null);
  });
});

test("Task service pipelines a third plan while two workers run, using the resident Master's planner slot", async () => {
  await fixture(async (scheduler, dir) => {
    const vault = join(dir, "vault"); await mkdir(vault);
    const masterCheckout = join(dir, "master"); await mkdir(masterCheckout);
    const snapshot = join(dir, "snapshot.json"); await writeFile(snapshot, JSON.stringify(contract));
    const workerGates = new Map(["a", "b", "c"].map(id => [id, gate()]));
    const planners = new Map<string, SyntheticClient>(), workers = new Map<string, SyntheticClient>();
    const runs = await Promise.all(["a", "b", "c"].map(async id => {
      const checkout = join(dir, id); await mkdir(checkout);
      return { title: id, config: { executable: process.execPath, checkout, vault, snapshot, outputDir: join(dir, "output-" + id),
        schedulerPath: scheduler.path, runId: id, astra: { model: "synthetic-astra", effort: "low" as const },
        sol: { model: "synthetic-sol", effort: "low" as const }, resources: [],
        verification: [{ requirement: "synthetic verification", program: process.execPath, args: ["--version"], timeoutMs: 5000 }] } };
    }));
    const service = await LocalTaskService.open({ stateRoot: join(dir, "state"), runs }, {
      prepare: async config => ({ config, contract }), submit: submitVaultRun,
      execute: async ({ config }, shared, signal, hooks) => {
        const astra = new SyntheticClient(config.astra.model), sol = new SyntheticClient(config.sol.model, () => workerGates.get(config.runId)!.promise);
        planners.set(config.runId, astra); workers.set(config.runId, sol);
        const base = { runId: config.runId, cwd: config.checkout, ledger: new FileTaskLedger(join(config.outputDir, "run.jsonl")),
          artifactDir: join(config.outputDir, "artifacts"), contract, astra: { ...config.astra, client: astra },
          sol: { ...config.sol, client: sol }, turnTimeoutMs: 5000,
          verify: async () => ({ outcome: "passed" as const, evidenceRef: "synthetic:verified" }) };
        return runScheduledVaultTask({ scheduler: shared, dispatchKey: config.runId + ":dispatch", signal,
          onCapacityReleased: hooks?.onCapacityReleased,
          run: base as unknown as Parameters<typeof runScheduledVaultTask>[0]["run"],
          execute: supplied => runSingleTask({ ...base, beforeSol: supplied.beforeSol }) });
      }
    });
    try {
      const original = await service.snapshot("a");
      for (const maxConcurrent of [1, 3]) {
        const reopened = await LocalTaskService.open({ stateRoot: join(dir, "state"), runs,
          capacity: { maxConcurrent, planners: 1, workers: 2 } });
        try {
          assert.equal((await reopened.snapshot("a")).configSha256, original.configSha256);
          assert.equal((await reopened.capacitySnapshot()).maxConcurrent, maxConcurrent);
        } finally { await reopened.close(); }
      }
      await assert.rejects(LocalTaskService.open({ stateRoot: join(dir, "state"), runs,
        capacity: { maxConcurrent: 3, planners: 1, workers: 2, untrusted: true } }), /bounded/);
      for (const id of ["a", "b"]) {
        const v = await service.snapshot(id); await service.start(id, v.configSha256, randomUUID());
        await until(async () => (await service.snapshot(id)).status === "working");
      }
      const admission = service.masterTurnAdmission("resident");
      const lease = await admission.reserve({ cwd: masterCheckout, model: "synthetic-astra", effort: "low",
        threadId: "resident-thread", text: "Hold the single planner slot" });
      const before = await service.capacitySnapshot();
      assert.deepEqual([before.usage.global, before.usage.planners, before.usage.workers], [3, 1, 2]);
      const third = await service.snapshot("c"); await service.start("c", third.configSha256, randomUUID());
      assert.equal((await service.snapshot("c")).status, "queued"); assert.equal(planners.has("c"), false);
      await lease.cancelBeforeDispatch();
      await until(async () => (await scheduler.read()).state!.entries.find(e => e.work.id === "c")?.phase === "waiting_for_worker");
      assert.equal(planners.get("c")!.turns, 1); assert.equal(workers.get("c")!.turns, 0);
      const waiting = await service.capacitySnapshot();
      assert.deepEqual([waiting.usage.global, waiting.usage.planners, waiting.usage.workers, waiting.usage.waitingWorkers], [2, 0, 2, 1]);
      const checkout = (await service.snapshot("c")).checkout;
      await record(scheduler, { type: "submit", work: work(dir, "conflict", { checkout }) });
      assert.equal(await scheduler.tryClaim("conflict", "double-write"), null);
      workerGates.get("a")!.release();
      await until(async () => (await service.snapshot("c")).status === "working");
      assert.equal((await service.capacitySnapshot()).usage.workers, 2);
      workerGates.get("b")!.release(); workerGates.get("c")!.release();
      await until(async () => (await service.capacitySnapshot()).usage.global === 0);
      for (const id of ["a", "b", "c"]) {
        assert.equal(planners.get(id)!.turns, 1); assert.equal(workers.get(id)!.turns, 1);
        const v = await service.snapshot(id); assert.equal(v.status, "ready_for_review"); assert.equal(v.acceptedBy, null);
      }
    } finally { for (const item of workerGates.values()) item.release(); await service.close(); }
  });
});
