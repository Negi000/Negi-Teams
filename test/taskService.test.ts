import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { createTaskHttp } from "../src/server/orchestration/taskHttp.ts";
import { taskPageHtml } from "../src/server/orchestration/taskPage.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { FileTaskLedger, type TaskAction } from "../src/server/orchestration/singleTask.ts";
import { submitVaultRun, type PreparedVaultRun, type TaskExecutionHooks, type TaskOperationApproval } from "../src/server/orchestration/vaultTaskExecution.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import type { VaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";
import { LocalReviewService, ReviewDecisionBusyError } from "../src/server/orchestration/reviewService.ts";
import { FileReviewChain } from "../src/server/orchestration/reviewChain.ts";
import { registeredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import { MasterStorageHeldError } from "../src/server/orchestration/masterStorageGuard.ts";

async function fixture(run: (data: { dir: string; config: VaultRunConfig; catalog: unknown;
  contract: VaultTaskContract; prepare: (config: VaultRunConfig) => Promise<PreparedVaultRun> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-task-ui-"));
  try {
    const checkout = join(dir, "checkout"), vault = join(dir, "vault");
    await mkdir(checkout); await mkdir(vault);
    const contract: VaultTaskContract = { schemaVersion: "negi-task-contract/1",
      vaultId: "NT-TASK-SYNTHETIC", version: 1, sha256: "a".repeat(64), project: "fixture",
      objective: "Synthetic one-file result", acceptance: ["Explicit review required"],
      baseSha: "b".repeat(40), scope: { in: ["one file"], out: ["no publishing"], allowedPaths: ["docs/result.md"] },
      invariants: ["No auth changes"], verification: ["focused check"], escalation: ["Stop outside scope"],
      limits: { maxAttempts: 1, timeLimitMinutes: 5 }, sourceNotes: [] };
    const snapshot = join(dir, "snapshot.json");
    await writeFile(snapshot, JSON.stringify(contract));
    const config: VaultRunConfig = { executable: process.execPath, checkout, vault, snapshot,
      outputDir: join(dir, "output"), schedulerPath: join(dir, "scheduler.jsonl"), runId: "synthetic-run",
      astra: { model: "gpt-6-astra", effort: "low" }, sol: { model: "gpt-6.1-sol", effort: "low" },
      resources: [], verification: [{ requirement: "focused check", program: "node", args: ["--version"], timeoutMs: 5000 }] };
    const catalog = { stateRoot: join(dir, "task-state"), runs: [{ title: "合成Task", config }] };
    await run({ dir, config, contract, catalog, prepare: async (config) => ({ config, contract }) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function completed(prepared: PreparedVaultRun, scheduler: FileScheduler,
  evidenceRef = "synthetic:check") {
  const { config, contract } = prepared;
  await scheduler.claim(config.runId, `${config.runId}:dispatch`);
  const ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl"));
  let i = 0;
  const append = (action: TaskAction) => ledger.append({ key: `event-${i++}`, at: new Date().toISOString(), action });
  await append({ type: "create", runId: config.runId, contract });
  for (const role of ["astra", "sol"] as const) {
    await append({ type: "start_attempt", attemptId: role, role, requestedModel: config[role].model });
    await append({ type: "bind_provider", attemptId: role, threadId: `thread-${role}`, turnId: `turn-${role}` });
    const plan = "Synthetic plan", planPath = join(config.outputDir, "synthetic-plan.md");
    if (role === "astra") await writeFile(planPath, plan);
    const outputRef = role === "astra" ? `${planPath}#sha256=${createHash("sha256").update(plan).digest("hex")}` : "synthetic:output";
    await append({ type: "complete_attempt", attemptId: role, resolvedModel: config[role].model,
      threadId: `thread-${role}`, turnId: `turn-${role}`, outputRef });
    if (role === "astra") {
      await scheduler.append({ key: `${config.runId}:planning-complete`, at: new Date().toISOString(), action: {
        type: "finish_planning", workId: config.runId, planRef: outputRef, threadId: "thread-astra", turnId: "turn-astra" } });
      assert.ok(await scheduler.tryStartWorker(config.runId, `${config.runId}:worker`));
    }
  }
  const state = await append({ type: "verify", outcome: "passed", evidenceRef });
  await scheduler.append({ key: `${config.runId}:settle`, at: new Date().toISOString(), action: {
    type: "settle", workId: config.runId, outcome: "verified", evidenceRef, actualCostUsd: null } });
  return state;
}
async function until(predicate: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Synthetic runner did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("busy review decision keeps queued work until the lock is released, then dispatches once",async()=>{
 await fixture(async({catalog,config,prepare})=>{
  let busy=true,checks=0,calls=0;
  const service=await LocalTaskService.open(catalog,{prepare,submit:submitVaultRun,execute:async(prepared,scheduler,_signal,hooks)=>{
   const run=async()=>{calls++;return completed(prepared,scheduler)};return hooks?.admit?hooks.admit(run):run();
  }});
  try{
   service.bindAdmissionGuard(config.runId,async operation=>{checks++;if(checks>1&&busy)throw new ReviewDecisionBusyError();return operation()});
   const initial=await service.snapshot(config.runId);await service.start(initial.id,initial.configSha256,randomUUID());
   await until(async()=>checks>1);assert.equal(calls,0);assert.equal((await service.snapshot(initial.id)).status,"queued");
   busy=false;await until(async()=>(await service.snapshot(initial.id)).status==="ready_for_review");assert.equal(calls,1);assert.equal((await service.snapshot(initial.id)).error,null);
   const events=(await new FileScheduler(config.schedulerPath).read()).events;assert.equal(events.filter(e=>e.action.type==="claim").length,1);assert.equal(events.filter(e=>e.action.type==="cancel_queued").length,0);
  }finally{busy=false;await service.close()}
 });
});

test("a live Task preflight stays pending without publishing an uncertain result, while another reader holds the request", async () => {
  await fixture(async ({ catalog, prepare, config }) => {
    let release!: () => void, ready!: () => void, count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const runtime = { prepare: async (input: typeof config) => { ready(); await gate; return prepare(input); },
      submit: submitVaultRun, execute: async (...args: Parameters<typeof completed>) => { count++; return completed(...args); } };
    const service = await LocalTaskService.open(catalog, runtime);
    const initial = await service.snapshot(config.runId), requestId = randomUUID();
    const starting = service.start(initial.id, initial.configSha256, requestId);
    try {
      await entered;
      const pending = await service.snapshot(initial.id); assert.equal(pending.status, "queued");
      assert.equal(pending.live, true); assert.equal(pending.canStart, false); assert.equal(pending.canStop, false);
      assert.deepEqual(await service.resultNotifications(), []); assert.equal(count, 0);
      assert.equal((await service.start(initial.id, initial.configSha256, requestId)).status, "queued");
      const other = await LocalTaskService.open(catalog, runtime);
      try { const held = await other.snapshot(initial.id); assert.equal(held.status, "needs_reconciliation");
        assert.equal(held.live, false); assert.equal(held.canStart, false); assert.equal(count, 0); }
      finally { await other.close(); }
      release(); await starting;
      await until(async () => (await service.snapshot(initial.id)).status === "ready_for_review");
      assert.equal(count, 1);
    } finally { release(); await starting; await service.close(); }
  });
});

for (const point of ["prepare", "before-submit", "after-submit", "uncertain-journal"] as const) {
  test(`Task preflight failure at ${point} saves private-safe evidence without replay`, async () => {
    await fixture(async ({ dir, catalog, config, prepare }) => {
      let executions = 0, prepares = 0, submits = 0;
      const privateDetail = "PRIVATE_FIXTURE_PATH_AND_TOKEN";
      let originalLog = "";
      const runtime = { prepare: async (input: VaultRunConfig) => {
        prepares++; if (point === "prepare") throw new MasterStorageHeldError(privateDetail); return prepare(input);
      }, submit: async (prepared: PreparedVaultRun, scheduler: FileScheduler) => {
        submits++;
        if (point === "after-submit") await submitVaultRun(prepared, scheduler);
        if (point === "uncertain-journal") { originalLog = await readFile(config.schedulerPath, "utf8");
          await writeFile(config.schedulerPath, originalLog + "partial-intent"); }
        throw Object.assign(new Error(privateDetail), { code: "EIO" });
      }, execute: async (...args: Parameters<typeof completed>) => { executions++; return completed(...args); } };
      const service = await LocalTaskService.open(catalog, runtime);
      try {
        const initial = await service.snapshot(config.runId), requestId = randomUUID();
        const start = service.start(initial.id, initial.configSha256, requestId);
        if (point === "uncertain-journal") await assert.rejects(start); else await start;
        const bytes = await readFile(join(dir, "task-state", initial.id + ".error.json"), "utf8"), failure = JSON.parse(bytes).failure;
        assert.equal(bytes.includes(privateDetail), false); assert.equal(failure.schema, "negi-task-preflight-failure/1");
        assert.equal(failure.stage, point === "prepare" ? "prepare" : "scheduler_submission");
        assert.equal(failure.code, point === "prepare" ? "STORAGE_HELD" : "EIO");
        assert.match(failure.classificationSha256, /^[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(failure.at)));
        assert.equal(failure.schedulerSubmission, "unknown"); assert.equal("causeSha256" in failure, false);
        if (point === "uncertain-journal") await writeFile(config.schedulerPath, originalLog);
        const held = await service.start(initial.id, initial.configSha256, requestId);
        assert.equal(held.canStart, false); assert.equal(held.live, false);
        assert.equal(held.status, point === "after-submit" ? "queued" : "preflight_failed");
        await assert.rejects(service.start(initial.id, initial.configSha256, randomUUID()), /already requested/);
        await service.close(); const restored = await LocalTaskService.open(catalog, runtime);
        try { assert.equal((await restored.start(initial.id, initial.configSha256, requestId)).canStart, false); }
        finally { await restored.close(); }
        assert.equal(prepares, 1); assert.equal(submits, point === "prepare" ? 0 : 1); assert.equal(executions, 0);
      } finally { if (point === "uncertain-journal" && originalLog) await writeFile(config.schedulerPath, originalLog); await service.close(); }
    });
  });
}

test("Task failure evidence is durable before a stalled scheduler observation", async () => {
  await fixture(async ({ dir, catalog, config }) => {
    let service!: LocalTaskService, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), stalled = new Promise<void>(resolve => { entered = resolve; });
    const runtime = { prepare: async () => {
      const scheduler = service.registeredScheduler(config.schedulerPath), read = scheduler.read.bind(scheduler);
      scheduler.read = async () => { entered(); await gate; return read(); };
      throw new MasterStorageHeldError("PRIVATE_FAILURE");
    }, submit: submitVaultRun, execute: completed };
    service = await LocalTaskService.open(catalog, runtime);
    const initial = await service.snapshot(config.runId), starting = service.start(initial.id, initial.configSha256, randomUUID());
    try {
      await stalled;
      const failure = JSON.parse(await readFile(join(dir, "task-state", initial.id + ".error.json"), "utf8")).failure;
      assert.equal(failure.stage, "prepare"); assert.equal(failure.schedulerSubmission, "unknown");
      assert.deepEqual(Object.keys(failure).sort(), ["at", "classificationSha256", "code", "schedulerSubmission", "schema", "stage"]);
      release(); assert.equal((await starting).status, "preflight_failed");
    } finally { release(); await starting; await service.close(); }
  });
});

test("native planner uses the UI scheduler once and persists its origin without human acceptance", async () => {
  await fixture(async ({ catalog, prepare, config, dir }) => {
    let count = 0;
    const runtime = { prepare, submit: submitVaultRun, execute: async (...args: Parameters<typeof completed>) => {
      count++; return completed(...args); } };
    const service = await LocalTaskService.open(catalog, runtime);
    const pushed: import("../src/shared/taskResults.ts").TaskResultSummary[][]=[];
    service.subscribeResults(results=>pushed.push(results));
    const tools = registeredTaskTools(service, "planner");
    const context = { threadId: "thread-native", turnId: "turn-native", callId: "dispatch-1" };
    try {
      const list = await tools.invoke({ ...context, tool: "negi_list_tasks", arguments: {} });
      assert.equal(list.success, true);
      const row = JSON.parse(list.text).tasks[0];
      assert.equal(row.project, "fixture"); assert.equal(list.text.includes(config.checkout), false);
      const read = await tools.invoke({ ...context, tool: "negi_read_task", arguments: { run_id: row.id } });
      assert.deepEqual(JSON.parse(read.text).acceptance, ["Explicit review required"]);
      assert.deepEqual(JSON.parse(read.text).taskContract.limits, { maxAttempts: 1, timeLimitMinutes: 5 });
      assert.equal(read.text.includes(config.checkout), false);
      const call = { ...context, tool: "negi_dispatch_task", arguments: { run_id: row.id, config_sha256: row.configSha256 } };
      const results = await Promise.all([tools.invoke(call), tools.invoke(call)]);
      assert.equal(results.every(result => result.success), true);
      await until(async () => { const v = await service.snapshot(row.id); return v.status === "ready_for_review" && !v.live; });
      assert.equal(count, 1);
      const view = await service.snapshot(row.id);
      assert.deepEqual(view.requestedBy, { kind: "master", masterId: "planner", ...context });
      assert.equal(view.acceptedBy, null); assert.equal(view.verificationOutcome, "passed");
      await until(async () => pushed.some(results=>results.length===1));
      assert.equal(pushed[0][0].update?.kind,"initial");
      const notices = await tools.invoke({ ...context, tool: "negi_list_task_results", arguments: {} });
      const notice = JSON.parse(notices.text).notifications[0];
      assert.equal(notices.success, true); assert.equal(notice.status, "ready_for_review");
      assert.equal(notice.acceptedBy, null); assert.equal(notice.delivery.state, "pending");
      assert.equal(notices.text.includes(config.checkout), false);
      assert.equal(JSON.parse((await tools.invoke({ ...context, threadId: "other-thread", tool: "negi_list_task_results", arguments: {} })).text).notifications.length, 0);
      assert.equal(JSON.parse((await registeredTaskTools(service, "other-master").invoke({ ...context, tool: "negi_list_task_results", arguments: {} })).text).notifications.length, 0);
      assert.equal(await service.prepareResultContext("planner", "other-thread", "input"), null);
      const packed = await tools.prepareResultContext!(context.threadId, "Describe this result");
      assert.ok(packed); assert.match(packed.text, /same|固定結果/);
      await packed.notSent();
      assert.equal((await tools.invoke(call)).success, true); assert.equal(count, 1);
      assert.equal((await tools.invoke({ ...call, callId: "another-dispatch" })).success, false);
      const requestPath = join(dir, "task-state", row.id + ".request.json");
      const request = JSON.parse(await readFile(requestPath, "utf8"));
      await assert.rejects(service.start(row.id, row.configSha256, request.requestId), /already requested/);
      assert.equal((await new FileScheduler(config.schedulerPath).read()).state?.entries.length, 1);
    } finally { await service.close(); }
    const restarted = await LocalTaskService.open(catalog, runtime);
    try {
      await restarted.recoverResultNotifications();
      assert.equal((await restarted.resultNotifications()).length, 1);
      assert.equal((await restarted.resultNotifications())[0].delivery.state, "not_sent");
      const retried = await restarted.prepareResultContext("planner", context.threadId, "Later authorized send");
      assert.ok(retried); await retried.notSent();
      const view = await restarted.snapshot(config.runId);
      assert.deepEqual(view.requestedBy, { kind: "master", masterId: "planner", ...context });
      assert.equal(view.acceptedBy, null); assert.equal(count, 1);
    } finally { await restarted.close(); }
    const replacement = await LocalTaskService.open({ stateRoot: join(dir, "task-state"), runs: [
      { title: "Replacement catalog", config: { ...config, runId: "replacement", outputDir: join(dir, "replacement-output") } }] }, runtime);
    try {
      assert.equal((await replacement.resultNotifications()).length, 0);
      assert.equal(await replacement.prepareResultContext("planner", context.threadId, "New catalog input"), null);
      assert.equal(count, 1);
      assert.match(await readFile(join(dir, "task-state", "task-results", "results.jsonl"), "utf8"), /synthetic-run/);
    } finally { await replacement.close(); }
  });
});

test("a Task queued by a resident Master starts after the shared Master lease releases", async () => {
  await fixture(async ({ catalog, prepare, config }) => {
    let count = 0;
    const service = await LocalTaskService.open(catalog, { prepare, submit: submitVaultRun,
      execute: async (...args) => { count++; return completed(args[0], args[1]); } });
    try {
      const admission = service.masterTurnAdmission("master");
      const lease = await admission.reserve({ cwd: config.checkout, model: "synthetic-astra", effort: "medium",
        threadId: "resident-thread", text: "Dispatch the registered Task" });
      await lease.dispatching(); await lease.bind("resident-turn");
      const view = await service.snapshot(config.runId);
      await service.start(view.id, view.configSha256, randomUUID(), { kind: "master", masterId: "master",
        threadId: "resident-thread", turnId: "resident-turn", callId: "dispatch-call" });
      assert.equal((await service.snapshot(view.id)).status, "queued"); assert.equal(count, 0);
      await lease.complete({ turnId: "resident-turn", status: "completed", finalText: "Task queued",
        contextInputTokens: null, contextWindow: null, lastUsage: null });
      await until(async () => { const v = await service.snapshot(view.id); return v.status === "ready_for_review" && !v.live; });
      assert.equal(count, 1); assert.equal((await service.snapshot(view.id)).acceptedBy, null);
      const entries = (await new FileScheduler(config.schedulerPath).read()).state!.entries;
      assert.equal(entries.length, 2); assert.equal(entries.every(e => e.status === "verified"), true);
      assert.deepEqual(entries.map(e => e.work.role), ["astra", "sol"]);
    } finally { await service.close(); }
  });
});

test("planner cannot alter fixed scope, model, command, configuration or review through native tools", async () => {
  await fixture(async ({ catalog, prepare, config }) => {
    let prepared = 0;
    const service = await LocalTaskService.open(catalog, { prepare: async value => { prepared++; return prepare(value); },
      submit: submitVaultRun, execute: completed });
    const tools = registeredTaskTools(service, "planner"), context = { threadId: "t", turnId: "u", callId: "c" };
    try {
      const v = await service.snapshot(config.runId);
      for (const [tool, args] of [
        ["negi_dispatch_task", { run_id: v.id, config_sha256: "0".repeat(64) }],
        ["negi_dispatch_task", { run_id: v.id, config_sha256: v.configSha256, command: "publish" }],
        ["negi_dispatch_task", { run_id: v.id, config_sha256: v.configSha256, model: "other" }],
        ["negi_read_task", { run_id: v.id, allowedPaths: ["secret"] }],
        ["negi_accept_task", { run_id: v.id }],
        ["negi_approve_task", { run_id: v.id }],
        ["negi_list_tasks", { project: "", offset: 0 }],
        ["negi_list_tasks", { offset: -1 }],
        ["negi_read_task", { run_id: "missing" }],
      ] as const) {
        const result = await tools.invoke({ ...context, tool, arguments: args });
        assert.equal(result.success, false); assert.equal(JSON.parse(result.text).noAutomaticRetry, true);
      }
      assert.equal(prepared, 0); assert.equal((await service.snapshot(v.id)).canStart, true);
      assert.equal((await tools.invoke({ ...context, tool: "negi_list_tasks", arguments: { project: "other" } })).success, true);
      assert.throws(() => registeredTaskTools(service, "../bad"), /identity invalid/);
      assert.equal((await tools.invoke({ ...context, turnId: "\n", tool: "negi_list_tasks", arguments: {} })).success, false);
    } finally { await service.close(); }
  });
});

test("native and browser race consumes one Task request and never restarts the losing dispatch", async () => {
  await fixture(async ({ catalog, prepare, config }) => {
    let count = 0;
    const service = await LocalTaskService.open(catalog, { prepare, submit: submitVaultRun,
      execute: async (...args) => { count++; return completed(args[0], args[1]); } });
    try {
      const view = await service.snapshot(config.runId), tools = registeredTaskTools(service, "planner");
      const results = await Promise.allSettled([service.start(view.id, view.configSha256, randomUUID()),
        tools.invoke({ threadId: "t", turnId: "u", callId: "c", tool: "negi_dispatch_task",
          arguments: { run_id: view.id, config_sha256: view.configSha256 } })]);
      const successes = results.filter(result => result.status === "fulfilled" &&
        (!("success" in result.value) || result.value.success));
      assert.equal(successes.length, 1);
      await until(async () => { const v = await service.snapshot(view.id); return v.status === "ready_for_review" && !v.live; });
      assert.equal(count, 1); assert.equal((await service.snapshot(view.id)).acceptedBy, null);
    } finally { await service.close(); }
  });
});

test("planner does not dispatch a Task whose mandatory contract exceeds the native response bound", async () => {
  await fixture(async ({ catalog, prepare, config, contract }) => {
    contract.acceptance = Array.from({ length: 35 }, (_, i) => `${i}:` + "a".repeat(800));
    await writeFile(config.snapshot, JSON.stringify(contract));
    let prepared = 0;
    const service = await LocalTaskService.open(catalog, { prepare: async config => { prepared++; return prepare(config); },
      submit: submitVaultRun, execute: completed });
    try {
      const view = await service.snapshot(config.runId), tools = registeredTaskTools(service, "planner");
      const result = await tools.invoke({ threadId: "t", turnId: "u", callId: "c", tool: "negi_dispatch_task",
        arguments: { run_id: view.id, config_sha256: view.configSha256 } });
      assert.equal(result.success, false); assert.equal(prepared, 0);
      assert.equal((await service.snapshot(view.id)).canStart, true);
    } finally { await service.close(); }
  });
});

test("legacy Task request without recorded origin remains readable and is not attributed to a human", async () => {
  await fixture(async ({ catalog, prepare, config, dir }) => {
    const runtime = { prepare, submit: submitVaultRun, execute: completed };
    const service = await LocalTaskService.open(catalog, runtime), requestId = randomUUID();
    try {
      const view = await service.snapshot(config.runId);
      await service.start(view.id, view.configSha256, requestId);
      await until(async () => !(await service.snapshot(view.id)).live);
      assert.deepEqual((await service.snapshot(view.id)).requestedBy, { kind: "browser" });
    } finally { await service.close(); }
    const path = join(dir, "task-state", config.runId + ".request.json");
    const request = JSON.parse(await readFile(path, "utf8")); delete request.requestedBy;
    await writeFile(path, JSON.stringify(request));
    const restarted = await LocalTaskService.open(catalog, runtime);
    try {
      const view = await restarted.snapshot(config.runId);
      assert.equal(view.requestedBy, undefined); assert.equal(view.acceptedBy, null);
      assert.equal((await restarted.start(view.id, view.configSha256, requestId)).requestedBy, undefined);
    } finally { await restarted.close(); }
  });
});

test("authenticated Task requests dispatch once and stop at review, including concurrent retries", async () => {
  await fixture(async ({ catalog, prepare }) => {
    let count = 0;
    const service = await LocalTaskService.open(catalog, { prepare, submit: submitVaultRun,
      execute: async (...args) => { count++; return completed(args[0], args[1]); } });
    try {
      const view = await service.snapshot("synthetic-run"), id = randomUUID();
      assert.equal(view.canStart, true);
      await Promise.all([service.start(view.id, view.configSha256, id), service.start(view.id, view.configSha256, id)]);
      await until(async () => { const state = await service.snapshot(view.id); return state.status === "ready_for_review" && !state.live; });
      const result = await service.snapshot(view.id);
      assert.equal(count, 1); assert.equal(result.canStart, false); assert.equal(result.acceptedBy, null);
      assert.equal(result.attempts.length, 2);
      await service.start(view.id, view.configSha256, id);
      assert.equal(count, 1);
      await assert.rejects(service.start(view.id, view.configSha256, randomUUID()), /already requested/);
    } finally { await service.close(); }
  });
});

test("a changed fixed snapshot fails before dispatch and is not automatically retried", async () => {
  await fixture(async ({ catalog, config, prepare, dir }) => {
    let count = 0;
    const service = await LocalTaskService.open(catalog, { prepare: async (config) => { count++; return prepare(config); },
      submit: submitVaultRun, execute: completed });
    const view = await service.snapshot("synthetic-run");
    await writeFile(config.snapshot, "{}");
    const result = await service.start(view.id, view.configSha256, randomUUID());
    assert.equal(result.status, "preflight_failed"); assert.equal(result.canStart, false); assert.equal(count, 0);
    assert.match(await readFile(join(dir, "task-state", `${view.id}.request.json`), "utf8"), /configSha256/);
    await service.close();
  });
});

test("unknown provider outcomes retain the slot, and reopening never redispatches them", async () => {
  await fixture(async ({ catalog, config, prepare, contract }) => {
    let count = 0;
    const runtime = { prepare, submit: submitVaultRun, execute: async (run: PreparedVaultRun, scheduler: FileScheduler, signal?: AbortSignal) => {
      count++;
      await scheduler.claim(config.runId, "synthetic:dispatch");
      const ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl"));
      await ledger.append({ key: "create", at: new Date().toISOString(), action: { type: "create", runId: config.runId, contract } });
      await ledger.append({ key: "start", at: new Date().toISOString(), action: {
        type: "start_attempt", attemptId: "astra", role: "astra", requestedModel: run.config.astra.model } });
      assert.ok(signal);
      await new Promise<void>((resolve) => {
        // The HTTP stop can arrive during the ledger append above.
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Synthetic connection closed");
    } };
    const service = await LocalTaskService.open(catalog, runtime);
    const view = await service.snapshot(config.runId), requestId = randomUUID();
    await service.start(view.id, view.configSha256, requestId);
    await until(async () => (await service.snapshot(view.id)).status === "planning");
    assert.equal((await service.stop(view.id, view.configSha256)).stopRequested, true);
    await service.close();
    const reloaded = await LocalTaskService.open(catalog, runtime);
    try {
      const result = await reloaded.snapshot(view.id);
      assert.equal(result.live, false); assert.equal(result.status, "needs_reconciliation");
      await reloaded.start(view.id, view.configSha256, requestId);
      assert.equal(count, 1);
      assert.equal((await new FileScheduler(config.schedulerPath).read()).state?.entries[0].status, "needs_reconciliation");
      await assert.rejects(reloaded.stop(view.id, view.configSha256), /No live process handle/);
    } finally { await reloaded.close(); }
  });
});

test("queued Tasks can be cancelled without a provider handle and are not restarted after reload", async () => {
  await fixture(async ({ catalog, config, prepare }) => {
    const scheduler = new FileScheduler(config.schedulerPath);
    await scheduler.append({ key: "init", at: new Date().toISOString(), action: { type: "configure", maxConcurrent: 1, budgetUsd: 0 } });
    await scheduler.append({ key: "block", at: new Date().toISOString(), action: { type: "submit", work: {
      id: "existing", parentId: null, dependencies: [], role: "sol", checkout: config.checkout,
      checkoutMode: "write", resources: [], reserveUsd: 0 } } });
    await scheduler.claim("existing", "existing-dispatch");
    let count = 0;
    const runtime = { prepare, submit: submitVaultRun, execute: async (prepared: PreparedVaultRun, scheduler: FileScheduler) => { count++; return completed(prepared, scheduler); } };
    const service = await LocalTaskService.open(catalog, runtime), view = await service.snapshot(config.runId);
    const requestId = randomUUID();
    await service.start(view.id, view.configSha256, requestId);
    assert.equal((await service.snapshot(view.id)).status, "queued");
    await service.close();
    const reloaded = await LocalTaskService.open(catalog, runtime);
    try {
      await reloaded.start(view.id, view.configSha256, requestId);
      assert.equal(count, 0);
      assert.equal((await reloaded.stop(view.id, view.configSha256)).status, "cancelled");
    } finally { await reloaded.close(); }
  });
});

test("catalog requires one scheduler and keeps state outside every registered writable tree", async () => {
  await fixture(async ({ catalog, config, prepare, dir }) => {
    const runtime = { prepare, submit: submitVaultRun, execute: completed };
    await assert.rejects(LocalTaskService.open({ ...(catalog as object), stateRoot: join(config.checkout, "state") }, runtime), /outside/);
    const other = { ...config, runId: "other", outputDir: join(config.vault, "out"), schedulerPath: join(config.vault, "scheduler") };
    await assert.rejects(LocalTaskService.open({ ...(catalog as object), runs: [
      { title: "first", config }, { title: "second", config: other } ] }, runtime), /outside/);
    await assert.rejects(LocalTaskService.open({ ...(catalog as object), runs: [
      { title: "first", config }, { title: "second", config: { ...config,
        runId: "other", outputDir: join(config.outputDir, "nested"), schedulerPath: join(config.vault, "..", "other-scheduler") } } ] }, runtime));
    const otherVault = join(dir, "other-vault");
    await mkdir(otherVault);
    await assert.rejects(LocalTaskService.open({ ...(catalog as object), runs: [
      { title: "first", config: { ...config, outputDir: join(otherVault, "first-output") } },
      { title: "second", config: { ...config, vault: otherVault, runId: "other", outputDir: join(dir, "other-output") } }
    ] }, runtime), /outside every checkout and Vault/);
  });
});

test("Task HTTP requires cookie authentication and same-origin, pinned mutations", async () => {
  await fixture(async ({ catalog, prepare, config }) => {
    let count = 0;
    const service = await LocalTaskService.open(catalog, { prepare, submit: submitVaultRun,
      execute: async (...args) => { count++; return completed(args[0], args[1]); } });
    const handler = createTaskHttp(service, { token: "synthetic-task-login" });
    const server = createServer(async (req, res) => {
      if (!await handler(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`, cookie = { Cookie: "ebi_auth=synthetic-task-login" };
    try {
      assert.equal((await fetch(`${url}/api/tasks`)).status, 401);
      assert.equal((await fetch(`${url}/api/tasks?summary=1`)).status, 401);
      assert.equal((await fetch(`${url}/api/tasks/capacity/summary`)).status, 401);
      assert.equal((await fetch(`${url}/api/tasks/results/summary`)).status, 401);
      assert.equal((await fetch(`${url}/api/tasks/results/summary`, { method: "POST", headers: cookie })).status, 405);
      const capacityResponse = await fetch(`${url}/api/tasks/capacity/summary`, { headers: cookie });
      assert.equal(capacityResponse.headers.get("cache-control"), "no-store");
      const capacity = await capacityResponse.json();
      assert.deepEqual(capacity, { maxConcurrent: 3, planners: 1, workers: 2,
        usage: { global: 0, planners: 0, workers: 0, waitingWorkers: 0, unresolved: 0, legacyUnphased: 0 }, draining: false });
      assert.equal((await fetch(`${url}/api/tasks/capacity/summary`, { method: "POST", headers: cookie })).status, 405);
      assert.deepEqual(await (await fetch(`${url}/api/tasks/capacity/summary`, { headers: cookie })).json(), capacity);
      assert.equal((await fetch(`${url}/api/tasks`, { headers: { Authorization: "Bearer synthetic-task-login" } })).status, 401);
      const view = await (await fetch(`${url}/api/tasks/synthetic-run`, { headers: cookie })).json();
      const summary = await (await fetch(`${url}/api/tasks?summary=1`, { headers: cookie })).json();
      assert.equal(summary[0].status, "not_started"); assert.equal(summary[0].canStart, true);
      assert.equal(summary[0].approvalCount, 0); assert.equal(count, 0);
      assert.equal(summary[0].checkout, undefined); assert.equal(summary[0].configSha256, undefined);
      const input = { configSha256: view.configSha256, requestId: randomUUID() };
      const post = (origin: string | null, value = input) => fetch(`${url}/api/tasks/synthetic-run/start`, {
        method: "POST", headers: { ...cookie, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(value) });
      assert.equal((await post(null)).status, 403);
      assert.equal((await post("https://outside.example")).status, 403);
      assert.equal((await post(url, { ...input, configSha256: "0".repeat(64) })).status, 409);
      assert.equal(count, 0);
      assert.equal((await post(url)).status, 200);
      await until(async () => { const state = await service.snapshot(view.id); return state.status === "ready_for_review" && !state.live; });
      assert.equal(count, 1);
      const completedSummary = await (await fetch(`${url}/api/tasks?summary=1`, { headers: cookie })).json();
      assert.equal(completedSummary[0].status, "ready_for_review");
      assert.equal(completedSummary[0].canStart, false); assert.equal(completedSummary[0].live, false);
      await until(async () => (await service.resultNotifications()).length === 1);
      const resultResponse = await fetch(`${url}/api/tasks/results/summary`, { headers: cookie });
      assert.equal(resultResponse.headers.get("cache-control"), "no-store");
      const notices = await resultResponse.json(); assert.equal(notices.length, 1);
      assert.equal(notices[0].origin.kind, "browser"); assert.equal(notices[0].acceptedBy, null);
      assert.equal(JSON.stringify(notices).includes(config.checkout), false);
      assert.equal(await service.prepareResultContext("master", "thread", "input"), null);
    } finally { await service.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

test("Task page script parses and keeps model output out of HTML interpolation", () => {
  const html = taskPageHtml();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length >= 1);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Script(script));
    assert.doesNotMatch(script, /innerHTML|sessionStorage|indexedDB/);
    // The only persisted browser value is the non-sensitive theme preference.
    const storageKeys = [...script.matchAll(/localStorage\.(?:getItem|setItem)\(['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.ok(storageKeys.every(key => key === "negi-theme"));
  }
  assert.match(html, /min-height:48px/);
});

test("a frozen Git review binds signed acceptance and revocation to the corresponding Task", async () => {
  await fixture(async ({ dir, config, contract, catalog, prepare }) => {
    const git = (args: string[]) => execFileSync("git", args, { cwd: config.checkout,
      encoding: "utf8", windowsHide: true }).trim();
    git(["init", "--quiet"]); git(["config", "user.name", "Synthetic Test"]);
    git(["config", "user.email", "synthetic@example.invalid"]);
    await mkdir(join(config.checkout, "docs"));
    await writeFile(join(config.checkout, "docs", "base.md"), "Synthetic base\n");
    git(["add", "."]); git(["commit", "--quiet", "-m", "synthetic baseline"]);
    contract.baseSha = git(["rev-parse", "HEAD"]);
    await writeFile(config.snapshot, JSON.stringify(contract));
    const runtime = { prepare, submit: submitVaultRun,
      execute: async (prepared: PreparedVaultRun, scheduler: FileScheduler) => {
        await writeFile(join(config.checkout, "docs", "result.md"), "# Synthetic result\nVerified fixture only.\n");
        const bytes = Buffer.from('{"synthetic":true,"mechanicalChecksPassed":true}\n');
        const evidence = join(config.outputDir, "verification.json");
        await writeFile(evidence, bytes);
        return completed(prepared, scheduler, `${evidence}#sha256=${createHash("sha256").update(bytes).digest("hex")}`);
      } };
    const reviews = await LocalReviewService.open({ storageRoot: join(dir, "human-reviews"), writableRoots: [], cases: [] });
    const service = await LocalTaskService.open(catalog, runtime);
    await service.connectReviews(reviews);
    const view = await service.snapshot(config.runId);
    await service.start(view.id, view.configSha256, randomUUID(), { kind: "master", masterId: "master",
      threadId: "review-thread", turnId: "delegation-turn", callId: "review-call" });
    await until(async () => (await service.snapshot(view.id)).reviewId !== null, 30_000);
    try {
      await until(async () => (await service.resultNotifications()).length === 1);
      const initialNotification=(await service.resultNotifications())[0];
      const result = await service.snapshot(view.id);
      assert.equal(result.status, "ready_for_review"); assert.ok(result.reviewId);
      const review = await reviews.snapshot(result.reviewId);
      assert.match(review.content, /New file: docs\/result.md/);
      assert.equal(review.canAccept, true);
      await writeFile(join(config.checkout, "docs", "result.md"), "Changed after verification\n");
      assert.equal((await service.snapshot(view.id)).status, "artifact_changed");
      const invalidated=await service.prepareResultContext("master", "review-thread", "Read the result");assert.ok(invalidated);
      assert.equal(JSON.parse(invalidated.text.split("\n").at(-1)!)[0].status,"artifact_changed");await invalidated.notSent();
      await assert.rejects(reviews.accept(review.id, review.artifactSha256, randomUUID()), /changed/);
      await writeFile(join(config.checkout, "docs", "result.md"), "# Synthetic result\nVerified fixture only.\n");
      const restoredContext = await service.prepareResultContext("master", "review-thread", "Read the restored result");
      assert.ok(restoredContext); await restoredContext.notSent();
      const id = randomUUID();
      const notificationLock=join(dir,"task-state","task-results","results.jsonl.lock");
      await writeFile(notificationLock,"owned notification contention fixture",{flag:"wx"});
      try{
        const decision=await reviews.accept(review.id, review.artifactSha256, id);
        assert.equal(decision.status,"accepted");assert.match(decision.resultNotificationError??"",/操作は保存済み/);
      }finally{await unlink(notificationLock)}
      assert.equal((await service.snapshot(view.id)).status, "accepted");
      assert.equal((await service.snapshot(view.id)).acceptedBy, `user:http-review:${id}`);
      const acceptedNotices=await service.resultNotifications();
      assert.equal(acceptedNotices[0].acceptedBy,`user:http-review:${id}`);assert.equal(acceptedNotices[0].update?.kind,"accepted");
      assert.equal(acceptedNotices.find(n=>n.id===initialNotification.id)?.acceptedBy,null);
      const acceptedContext=await service.prepareResultContext("master","review-thread","Read the accepted result");assert.ok(acceptedContext);
      assert.equal(JSON.parse(acceptedContext.text.split("\n").at(-1)!)[0].status,"accepted");await acceptedContext.notSent();
      // Forward slashes from a Windows CLI identify the same physical output root.
      const manifestPath = join(config.outputDir, "review-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.review.artifactRoot = manifest.review.artifactRoot.replaceAll("\\", "/");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const reloadedReviews = await LocalReviewService.open({ storageRoot: join(dir, "human-reviews"), writableRoots: [], cases: [] });
      const reloaded = await LocalTaskService.open(catalog, runtime);
      await reloaded.connectReviews(reloadedReviews);
      assert.equal((await reloaded.snapshot(view.id)).status, "accepted");
      await reloadedReviews.revoke(review.id, review.artifactSha256, randomUUID(), "Synthetic withdrawal");
      assert.equal((await reloaded.snapshot(view.id)).status, "review_revoked");
      assert.equal((await reloaded.snapshot(view.id)).acceptedBy, null);
      const revokedNotices=await reloaded.resultNotifications();assert.equal(revokedNotices[0].update?.kind,"revoked");
      assert.equal(revokedNotices[0].status,"review_revoked");assert.equal(revokedNotices[0].acceptedBy,null);
      const beforeReload=revokedNotices.map(n=>n.id);await reloaded.recoverResultNotifications();
      assert.deepEqual((await reloaded.resultNotifications()).map(n=>n.id),beforeReload);
      const revokeContext=await reloaded.prepareResultContext("master","review-thread","Read the withdrawal");assert.ok(revokeContext);
      assert.equal(JSON.parse(revokeContext.text.split("\n").at(-1)!)[0].status,"review_revoked");await revokeContext.notSent();
      await reloaded.close();
    } finally { await service.close(); }
  });
});

test("live operation approvals bind the full target, expire, and require signed proof on reload", async () => {
  await fixture(async ({ catalog, config, contract, prepare, dir }) => {
    let providerResponses = 0;
    const runtime = { prepare, submit: submitVaultRun,
      execute: async (_run: PreparedVaultRun, scheduler: FileScheduler, signal?: AbortSignal, hooks?: TaskExecutionHooks) => {
        assert.ok(hooks);
        await scheduler.claim(config.runId, "approval-dispatch");
        const ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl"), Date.now, undefined, undefined, hooks.verifyApproval);
        const append = (key: string, action: TaskAction, at = new Date().toISOString()) => ledger.append({ key, action, at });
        await append("create", { type: "create", runId: config.runId, contract });
        await append("start", { type: "start_attempt", role: "astra", attemptId: "attempt-a", requestedModel: config.astra.model });
        await append("bind", { type: "bind_provider", attemptId: "attempt-a", threadId: "thread-a", turnId: "turn-a" });
        const approval: TaskOperationApproval = { id: "operation-a", attemptId: "attempt-a", threadId: "thread-a", turnId: "turn-a",
          operation: "item/commandExecution/requestApproval", target: "Synthetic command\nCwd: fixture", targetKnown: true,
          expiresAt: new Date(Date.now() + 15_000).toISOString() };
        await append("request", { type: "request_approval", approval });
        let release!: () => void;
        const response = new Promise<void>((resolve) => { release = resolve; });
        signal?.addEventListener("abort", () => release(), { once: true });
        hooks.onApproval(approval, async (allow, approvalRef, at, id) => {
          await append(`task-operation:${id}`, { type: "decide_approval", approvalId: approval.id,
            attemptId: approval.attemptId, threadId: approval.threadId, turnId: approval.turnId,
            operation: approval.operation, target: approval.target, decision: allow ? "allow" : "deny", approvalRef }, at);
          providerResponses++; release();
        });
        await response;
        const state = await append("failed", { type: "fail_attempt", attemptId: "attempt-a", reason: "Synthetic provider response observed" });
        await scheduler.append({ key: "settle", at: new Date().toISOString(), action: {
          type: "settle", workId: config.runId, outcome: "failed", evidenceRef: "synthetic:operation-complete", actualCostUsd: null } });
        return state;
      } };
    const service = await LocalTaskService.open(catalog, runtime), view = await service.snapshot(config.runId);
    try {
      await service.start(view.id, view.configSha256, randomUUID());
      await until(async () => (await service.snapshot(view.id)).approvals[0]?.canDecide === true);
      const pending = (await service.snapshot(view.id)).approvals[0];
      await assert.rejects(service.decideApproval(view.id, view.configSha256, randomUUID(),
        pending.id, "0".repeat(64), "allow"), /changed/);
      assert.equal(providerResponses, 0);
      const requestId = randomUUID();
      await service.decideApproval(view.id, view.configSha256, requestId, pending.id, pending.approvalSha256, "deny");
      await until(async () => !(await service.snapshot(view.id)).live);
      assert.equal(providerResponses, 1);
      await assert.rejects(service.decideApproval(view.id, view.configSha256, requestId,
        pending.id, pending.approvalSha256, "deny"), /no live provider handle/);
      const reloaded = await LocalTaskService.open(catalog, runtime);
      assert.equal((await reloaded.snapshot(view.id)).approvals.length, 0);
      await reloaded.close();
      const proofPath = join(dir, "task-state", "operation-proofs", `${requestId}.json`);
      const proof = JSON.parse(await readFile(proofPath, "utf8"));
      proof.receipt.data.decision = "allow";
      await writeFile(proofPath, JSON.stringify(proof));
      await assert.rejects(service.snapshot(view.id), /signature/);
    } finally { await service.close(); }
  });
});

for (const revisionMode of ["success", "partial-evidence", "outside-scope", "concurrent-feedback", "verification-mutates-result", "omitted-correction"] as const)
test(`local revision ${revisionMode}: immutable evidence, recovery and no model redispatch`, async () => {
  await fixture(async ({ dir, config, contract, catalog, prepare }) => {
    const git = (args: string[]) => execFileSync("git", args, { cwd: config.checkout, encoding: "utf8", windowsHide: true }).trim();
    git(["init", "--quiet"]); git(["config", "user.name", "Synthetic Revision"]);
    git(["config", "user.email", "synthetic@example.invalid"]); git(["config", "core.autocrlf", "false"]);
    await mkdir(join(config.checkout, "docs")); await writeFile(join(config.checkout, "docs/base.md"), "Synthetic baseline\n");
    git(["add", "."]); git(["commit", "--quiet", "-m", "synthetic revision baseline"]);
    contract.baseSha = git(["rev-parse", "HEAD"]); await writeFile(config.snapshot, JSON.stringify(contract));
    if(revisionMode==="concurrent-feedback")config.verification[0]={...config.verification[0],program:process.execPath,
      args:["-e",`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(dir,"checks-started"))},'ready');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(dir,"feedback-saved"))})){clearInterval(t);process.exit(0)}},20);`],timeoutMs:10000};
    if(revisionMode==="verification-mutates-result")config.verification[0]={...config.verification[0],program:process.execPath,
      args:["-e","require('node:fs').appendFileSync('docs/result.md','Changed by checks\\n')"]};
    let dispatches = 0;
    const runtime = { prepare, submit: submitVaultRun, prepareRevision: async (config: VaultRunConfig) => ({ config, contract }),
      execute: async (prepared: PreparedVaultRun, scheduler: FileScheduler) => {
        dispatches++;
        await writeFile(join(config.checkout, "docs/result.md"), "# Synthetic A\nNeeds correction.\n");
        const bytes = Buffer.from('{"synthetic":true,"mechanicalChecksPassed":true}\n');
        const evidence = join(config.outputDir, "verification.json"); await writeFile(evidence, bytes);
        return completed(prepared, scheduler, `${evidence}#sha256=${createHash("sha256").update(bytes).digest("hex")}`);
      } };
    const reviewConfig = { storageRoot: join(dir, "human-reviews"), writableRoots: [], cases: [] };
    const reviews = await LocalReviewService.open(reviewConfig), service = await LocalTaskService.open(catalog, runtime);
    await service.connectReviews(reviews);
    const before = await service.snapshot(config.runId); await service.start(before.id, before.configSha256, randomUUID());
    await until(async () => (await service.snapshot(before.id)).reviewId !== null, 30_000);
    const viewA = await service.snapshot(before.id), reviewA = await reviews.snapshot(viewA.reviewId!);
    const previewA = await readFile(join(config.outputDir, "review-result.md"));
    const originalManifestPath = join(config.outputDir, "review-manifest.json");
    const originalManifest = JSON.parse(await readFile(originalManifestPath, "utf8"));
    originalManifest.review.artifactRoot = originalManifest.review.artifactRoot.replaceAll("\\", "/");
    await writeFile(originalManifestPath, JSON.stringify(originalManifest));
    const note = join(config.outputDir, "agent-note.md"), text = "Synthetic targeted correction.\n";
    await writeFile(note, text);
    await new FileReviewChain(join(config.outputDir, "review.jsonl")).append({ key: "agent-correction", at: new Date().toISOString(),
      action: { type: "feedback", feedback: { id: "agent-correction", source: "agent", kind: "correction", scope: "current_task",
        targetSha256: reviewA.artifactSha256, textRef: `local-agent:${note}#sha256=${createHash("sha256").update(text).digest("hex")}` } } });
    await new FileScheduler(config.schedulerPath).append({ key: "audit", at: new Date().toISOString(), action: {
      type: "invalidate", workId: config.runId, evidenceRef: "synthetic:content-audit", reason: "Synthetic correction required" } });
    assert.equal((await service.snapshot(before.id)).status, "quality_issue");
    await writeFile(join(config.checkout, "docs/result.md"), "# Synthetic B\nCorrected locally.\n");
    if(revisionMode==="omitted-correction"){
      await reviews.feedback(reviewA.id,{artifactSha256:reviewA.artifactSha256,requestId:randomUUID(),text:"Another current correction",
        kind:"correction",scope:"current_task"});
      await assert.rejects(service.registerResultRevision(before.id,before.configSha256,["agent-correction"]),/every current correction/);
      assert.equal((await new FileScheduler(config.schedulerPath).read()).state!.entries.some(e=>e.work.id.endsWith(":local-revision-1")),false);
      assert.equal((await service.snapshot(before.id)).resultRevisionCount,0);assert.equal((await reviews.snapshot(reviewA.id)).feedback.length,2);
      assert.deepEqual(await readFile(join(config.outputDir,"review-result.md")),previewA);await service.close();return;
    }
    if(revisionMode==="concurrent-feedback"||revisionMode==="verification-mutates-result"){
      const revision=service.registerResultRevision(before.id,before.configSha256,["agent-correction"]);
      const rejected=assert.rejects(revision,/changed during revision verification/);
      if(revisionMode==="concurrent-feedback"){
        await until(async()=>Boolean(await readFile(join(dir,"checks-started"),"utf8").catch(()=>null)),30_000);
        await reviews.feedback(reviewA.id,{artifactSha256:reviewA.artifactSha256,requestId:randomUUID(),text:"Concurrent new correction",
          kind:"correction",scope:"current_task"});await writeFile(join(dir,"feedback-saved"),"saved");
      }
      await rejected;
      const scheduler=(await new FileScheduler(config.schedulerPath).read()).state!;
      assert.equal(scheduler.entries.find(e=>e.work.id.endsWith(":local-revision-1"))!.status,"failed");
      assert.equal((await service.snapshot(before.id)).resultRevisionCount,0);assert.equal(dispatches,1);
      assert.deepEqual(await readFile(join(config.outputDir,"review-result.md")),previewA);
      if(revisionMode==="concurrent-feedback")assert.equal((await reviews.snapshot(reviewA.id)).feedback.length,2);
      await service.close();return;
    }
    if (revisionMode !== "success") {
      if (revisionMode === "partial-evidence") await writeFile(join(config.outputDir, "verification-r1.json"), "partial evidence\n");
      else await writeFile(join(config.checkout, "outside.md"), "Outside the contract\n");
      await assert.rejects(service.registerResultRevision(before.id, before.configSha256, ["agent-correction"]),
        revisionMode === "partial-evidence" ? /EEXIST/ : /verification failed/);
      const scheduler = new FileScheduler(config.schedulerPath);
      const child = (await scheduler.read()).state!.entries.find((entry) => entry.work.id.endsWith(":local-revision-1"))!;
      assert.equal(child.status, revisionMode === "partial-evidence" ? "needs_reconciliation" : "failed");
      assert.deepEqual(await readFile(join(config.outputDir, "review-result.md")), previewA);
      assert.equal((await reviews.snapshot(viewA.reviewId!)).canAccept, false);
      await service.close();
      const reloaded = await LocalTaskService.open(catalog, runtime);
      try {
        await reloaded.connectReviews(await LocalReviewService.open(reviewConfig));
        assert.equal((await reloaded.snapshot(before.id)).resultRevisionCount, 0);
        assert.equal(dispatches, 1);
      } finally { await reloaded.close(); }
      return;
    }
    const results = await Promise.all([service.registerResultRevision(before.id, before.configSha256, ["agent-correction"]),
      service.registerResultRevision(before.id, before.configSha256, ["agent-correction"])]);
    assert.equal(results[0].resultRevisionCount, 1); assert.equal(results[0].acceptedBy, null); assert.equal(dispatches, 1);
    const revisionNotices=await service.resultNotifications();
    assert.equal(revisionNotices[0].update?.kind,"revision");assert.equal(revisionNotices[0].update?.resultRevision,1);
    assert.equal(revisionNotices.filter(n=>!n.supersededBy).length,1);
    const noticeIds=revisionNotices.map(n=>n.id);await service.recoverResultNotifications();
    assert.deepEqual((await service.resultNotifications()).map(n=>n.id),noticeIds);
    assert.deepEqual(await readFile(join(config.outputDir, "review-result.md")), previewA);
    await assert.rejects(new FileTaskLedger(join(config.outputDir, "run.jsonl")).read(), /trusted result revision unavailable/);
    await service.close();
    // Simulate a crash after the local journal but before the final metadata writes.
    await unlink(join(config.outputDir, "review-current.json"));
    const taskPath = join(config.outputDir, "run.jsonl"), taskBytes = await readFile(taskPath, "utf8");
    await writeFile(taskPath, taskBytes.split("\n").filter((line) => !line.includes('"reverify_result"')).join("\n"));
    const scheduleBytes = await readFile(config.schedulerPath, "utf8");
    await writeFile(config.schedulerPath, scheduleBytes.split("\n").filter((line) => {
      if (!line) return true; const event = JSON.parse(line);
      return !event.key.startsWith("task-revision:");
    }).join("\n"));
    const reloadedReviews = await LocalReviewService.open(reviewConfig), reloaded = await LocalTaskService.open(catalog, runtime);
    try {
      await reloaded.connectReviews(reloadedReviews);
      const viewB = await reloaded.snapshot(before.id), reviewB = await reloadedReviews.snapshot(viewB.reviewId!);
      assert.equal(viewB.status, "ready_for_review"); assert.equal(viewB.resultRevisionCount, 1); assert.equal(dispatches, 1);
      assert.equal(reviewB.previousSha256, reviewA.artifactSha256); assert.equal(reviewB.canAccept, true);
      const integrationSource = await reloaded.integrationSource(before.id);
      assert.equal((await integrationSource.readManifest!()).revision, 1);
      assert.match((await integrationSource.readState()).verification!.evidenceRef, /verification-r1\.json#sha256=[a-f0-9]{64}$/);
      await assert.rejects(reloadedReviews.accept(reviewB.id, reviewA.artifactSha256, randomUUID()), /版/);
      await reloadedReviews.accept(reviewB.id, reviewB.artifactSha256, randomUUID());
      assert.equal((await reloaded.snapshot(before.id)).status, "accepted");
      const journalPath = join(config.outputDir, "revision-1.json"), journalBytes = await readFile(journalPath);
      const journal = JSON.parse(journalBytes.toString()); journal.manifestSha256 = "0".repeat(64);
      await writeFile(journalPath, JSON.stringify(journal));
      await assert.rejects(reloaded.snapshot(before.id), /manifest bytes changed/);
      await writeFile(journalPath, journalBytes);
    } finally { await reloaded.close(); }
  });
});
