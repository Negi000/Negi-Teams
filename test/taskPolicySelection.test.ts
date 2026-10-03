import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalPolicyService, type ReadOnlyPolicySource } from "../src/server/orchestration/policyService.ts";
import { FileTaskLedger, reduceTask } from "../src/server/orchestration/singleTask.ts";
import { runSingleTaskFromVault } from "../src/server/orchestration/vaultTaskContract.ts";
import { assertTaskWorkerProfileRegistration, parseVaultRunConfig, type VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import { selectTaskWorkerProfile } from "../src/server/orchestration/taskProfileSelection.ts";
import { verifyConfiguredCheckout } from "../src/server/orchestration/checkoutVerification.ts";
import { captureReadOnlyTaskReview, verifyReadOnlyTaskReview } from "../src/server/orchestration/readOnlyTaskReview.ts";
import { executeVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { loadVaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";
import { submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { TaskExecutionOwner } from "../src/server/orchestration/taskExecutionOwner.ts";
import { AppServerProcess, appServerChildEnv } from "../src/server/master/appServerProcess.ts";
import { LocalTaskReconciliation } from "../src/server/orchestration/taskReconciliation.ts";
import { policyFixture } from "./helpers/policyFixture.ts";
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const catalog = [{ model: "gpt-6-luna", efforts: ["medium", "low"], inputModalities: ["text"] }];
const profile = { model: "gpt-6-luna", effort: "medium" };
const chosen = { ...profile, effort: "low", policyId: "v1", policyHash: "a".repeat(64), stateSha256: "b".repeat(64) };

async function fixture<T>(body: (data: { dir: string; checkout: string; vault: string; snapshot: string;
  config: (id: string) => Promise<VaultRunConfig> }) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-task-policy-"));
  try {
    const checkout = join(dir, "checkout"), vault = join(dir, "vault"), snapshot = join(dir, "snapshot.json");
    await mkdir(join(checkout, "docs"), { recursive: true }); await mkdir(join(vault, "80_Tasks"), { recursive: true });
    await writeFile(join(checkout, "docs", "base.md"), "# Fixed baseline\n");
    const git = (args: string[]) => execFileSync("git", args, { cwd: checkout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    git(["init"]); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "baseline"]);
    const contract = { objective: "Explain the baseline", in_scope: ["Read docs/base.md"], out_of_scope: ["No changes"],
      allowed_paths: ["docs/base.md"], invariants: ["Keep all files unchanged"], acceptance: ["Report evidence and unknowns"],
      verification: ["fixed baseline check"], escalation: ["Hold unknowns"], base_sha: git(["rev-parse", "HEAD"]), max_attempts: 1, time_limit_minutes: 5 };
    await writeFile(join(vault, "80_Tasks", "task.md"), `---\nid: TASK-POLICY\nkind: Task\nproject: negi\nscope: project\nstatus: active\nversion: 1\nupdated: 2026-10-03\nsensitivity: local\nsource_refs:\n  - user:fixture\napproval_ref: user:fixture\ntask_class: read_only_research\n---\n# Task\n\n\`\`\`negi-task-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
    execFileSync("python", [fileURLToPath(new URL("../scripts/negi_task_contract.py", import.meta.url)), "--vault", vault,
      "--id", "TASK-POLICY", "--project", "negi", "--out", snapshot], { windowsHide: true, stdio: "pipe" });
    await body({ dir, checkout, vault, snapshot, config: async id => {
      const outputDir = join(dir, id); await mkdir(outputDir);
      return parseVaultRunConfig({ executable: process.execPath, checkout, vault, snapshot, outputDir,
        schedulerPath: join(dir, "scheduler.jsonl"), runId: id, astra: { model: "gpt-6-astra", effort: "medium" },
        taskMode: "read_only_research", luna: profile, lunaPolicy: "approved-policy/1", resources: [],
        verification: [{ requirement: "fixed baseline check", program: process.execPath,
          args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('docs/base.md','utf8'),'# Fixed baseline\\n')"], timeoutMs: 5000 }] });
    } });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
function client(model: string, onTurn: (effort: string) => Promise<void>) {
  return { initialize: async () => {}, discoverModels: async () => [{ ...catalog[0], model }],
    startThread: async (input: { sandbox: string; readOnlyContract?: boolean }) => {
      assert.equal(input.sandbox, "read-only"); assert.equal(input.readOnlyContract, true);
      return { threadId: `thread-${model}`, requestedModel: model, resolvedModel: model, modelProvider: "mock", rerouted: false };
    }, startTurn: async (_prompt: string, effort: string) => { await onTurn(effort); return `turn-${model}`; },
    waitForTurn: async (turnId: string) => ({ turnId, status: "completed" as const,
      finalText: "根拠: docs/base.md:1。未知: 利用者の受入。", contextInputTokens: null, contextWindow: null, lastUsage: null }) };
}
async function run(config: VaultRunConfig, source?: ReadOnlyPolicySource, onAstra: () => Promise<void> = async () => {},
  beforeWorker?: () => Promise<void>, processOwner?: TaskExecutionOwner) {
  const ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl")), efforts: string[] = [];
  const result = await runSingleTaskFromVault({ runId: config.runId, cwd: config.checkout, vaultDirectory: config.vault,
    snapshotPath: config.snapshot, ledger, artifactDir: join(config.outputDir, "artifacts"), turnTimeoutMs: 5000,
    astra: { ...config.astra, client: client(config.astra.model, async () => { await onAstra(); }) },
    luna: { ...config.luna!, client: client(config.luna!.model, async effort => { efforts.push(effort); }) },
    ...(source ? { approvedResearchPolicy: source } : {}), verify: async evidence => verifyConfiguredCheckout({ ...config,
      baseSha: evidence.contract.baseSha, allowedPaths: evidence.contract.scope!.allowedPaths,
      requiredVerification: evidence.contract.verification!, commands: config.verification, processOwner }), ...(beforeWorker ? { beforeWorker } : {}) });
  return { result, ledger, efforts };
}

test("normal Vault Task pins signed policy before Astra; rollback changes only the next run and review preserves its pin", { skip: process.platform !== "win32" }, async () => fixture(async data => {
  const policy = await policyFixture();
  try {
    const source = await LocalPolicyService.open(policy.config, [data.checkout, data.vault], policy.secret);
    const decide = async (op: "approve" | "activate" | "rollback") => source.decide("v1", op,
      { requestId: randomUUID(), expectedSha256: (await source.list()).sha256, ...(op === "rollback" ? { reason: "fixture rollback" } : {}) });
    await decide("approve"); await decide("activate");
    const config = await data.config("first");
    const { result, efforts, ledger } = await run(config, source, async () => {
      const pinned = (await new FileTaskLedger(join(config.outputDir, "run.jsonl")).read()).state!.contract.workerProfileSelection!;
      assert.equal(pinned.policyId, "v1"); assert.equal(pinned.effort, "low");
      await decide("rollback");
    });
    assert.equal(result.status, "ready_for_review"); assert.deepEqual(efforts, ["low"]);
    assert.equal(result.attempts.at(-1)!.requestedEffort, "low");
    assert.deepEqual((await ledger.read()).state!.contract.workerProfileSelection, result.contract.workerProfileSelection);
    const configHash = hash(JSON.stringify({ config, snapshotSha256: hash(await readFile(config.snapshot)) }));
    const manifest = await captureReadOnlyTaskReview(config, configHash, "Policy fixture", result);
    const preview = JSON.parse(await readFile(join(config.outputDir, "review-result.md"), "utf8"));
    assert.equal(preview.workerProfileSelection.policyId, "v1");
    await verifyReadOnlyTaskReview(config, manifest, result);
    const tampered = structuredClone(result); tampered.contract.workerProfileSelection!.policyHash = "c".repeat(64);
    await assert.rejects(verifyReadOnlyTaskReview(config, manifest, tampered), /changed/);
    const next = await run(await data.config("second"), source);
    assert.deepEqual(next.efforts, ["medium"]); assert.equal(next.result.contract.workerProfileSelection!.source, "default");
    assert.equal(next.result.contract.workerProfileSelection!.policyId, null);
    let reselections = 0;
    await assert.rejects(run(config, { select: async () => { reselections++; return chosen; } }), /ledger already exists/);
    assert.equal(reselections, 0);
  } finally { await rm(policy.directory, { recursive: true, force: true }); }
}));

test("an active signed version cannot fall back when its catalog or evidence is unavailable", { skip: process.platform !== "win32" }, async () => {
  const policy = await policyFixture();
  try {
    const source = await LocalPolicyService.open(policy.config, [policy.checkout], policy.secret);
    for(const op of ["approve", "activate"] as const)await source.decide("v1", op,
      { requestId: randomUUID(), expectedSha256: (await source.list()).sha256 });
    const limitedClient = { initialize: async () => {}, discoverModels: async () => [{ ...catalog[0], efforts: ["medium"] }] };
    await assert.rejects(selectTaskWorkerProfile(source, limitedClient, profile), /unavailable.*catalog/);
    await writeFile(join(policy.evidence, "v1-one-candidate.md"), "changed evidence");
    await assert.rejects(selectTaskWorkerProfile(source, limitedClient, profile), /evidence unavailable/);
  } finally { await rm(policy.directory, { recursive: true, force: true }); }
});

test("explicit research profile stays explicit without policy opt-in", async () => fixture(async data => {
  const config = await data.config("explicit"); delete config.lunaPolicy;
  const { result, efforts } = await run(config);
  assert.deepEqual(efforts, ["medium"]); assert.equal(result.contract.workerProfileSelection, undefined);
  assertTaskWorkerProfileRegistration(config, result.contract);
}));

test("unavailable, corrupt or model-changing selection stops before Task artifacts and both turns", async () => fixture(async data => {
  const config = await data.config("held"); let calls = 0;
  const source: ReadOnlyPolicySource = { select: async () => { calls++; throw Error("Active policy evidence unavailable"); } };
  await assert.rejects(run(config, source), /evidence unavailable/); assert.equal(calls, 1);
  assert.equal(await access(join(config.outputDir, "run.jsonl")).then(() => true, () => false), false);
  assert.equal(await access(join(config.outputDir, "artifacts")).then(() => true, () => false), false);
  for(const selection of [{ ...chosen, model: "gpt-6-astra" }, { ...chosen, effort: "unavailable" }, { ...chosen, policyHash: "invalid" }])
    await assert.rejects(selectTaskWorkerProfile({ select: async input => {
      input.catalog.push({ model: selection.model, efforts: [selection.effort], inputModalities: ["text"] }); return selection;
    } }, { initialize: async () => {}, discoverModels: async () => structuredClone(catalog) }, profile), /invalid or unavailable/);
}));

test("registration and replay reject effort drift, missing pins and permission-bearing extensions", () => {
  const selection = { role: "luna" as const, source: "approved-policy" as const, defaultProfile: profile, ...chosen };
  const config = { taskMode: "read_only_research", luna: profile, lunaPolicy: "approved-policy/1" } as VaultRunConfig;
  assertTaskWorkerProfileRegistration(config, { workerProfileSelection: selection });
  assert.throws(() => assertTaskWorkerProfileRegistration(config, {}), /fixed registration/);
  assert.throws(() => assertTaskWorkerProfileRegistration({ ...config, lunaPolicy: undefined }, { workerProfileSelection: selection }), /fixed registration/);
  const contract = { vaultId: "task", version: 1, sha256: "a".repeat(64), baseSha: "a".repeat(40), project: "negi",
    objective: "fixture", acceptance: ["fixture"], taskClass: "read_only_research", workerProfileSelection: selection };
  const create = { key: "create", at: new Date().toISOString(), action: { type: "create" as const, runId: "fixture", contract } };
  const state = reduceTask(null, create); state.status = "ready_for_worker";
  const start = { key: "start", at: create.at, action: { type: "start_attempt" as const, attemptId: "luna", role: "luna" as const,
    requestedModel: selection.model, requestedEffort: "medium" } };
  assert.throws(() => reduceTask(state, start), /pinned worker profile/);
  assert.throws(() => reduceTask(null, { ...create, action: { ...create.action, contract: { ...contract,
    workerProfileSelection: { ...selection, sandbox: "workspace-write" } as typeof selection } } }), /pinned worker profile/);
});

test("normal native dispatcher remains held before policy selection or provider startup", async () => fixture(async data => {
  const config = await data.config("native-held"); let selections = 0;
  const contract = JSON.parse(await readFile(config.snapshot, "utf8"));
  await assert.rejects(executeVaultRun({ config, contract }, new FileScheduler(config.schedulerPath), undefined,
    { approvedResearchPolicy: { select: async () => { selections++; return chosen; } }, onApproval: () => {}, verifyApproval: async () => false }),
  /process-local MCP policy is not enforced/);
  assert.equal(selections, 0);
  assert.equal(await access(join(config.outputDir, "execution-owner.json")).then(() => true, () => false), false);
}));

test("Task service requires a fixed authority only for new opted-in runs, passes it to execution and reopens saved pins", { skip: process.platform !== "win32" }, async () => fixture(async data => {
  const config = await data.config("service"), stateRoot = join(data.dir, "task-state");
  const catalog = { stateRoot, runs: [{ title: "Policy Task fixture", config }] };
  const reviews = await LocalReviewService.open({ storageRoot: join(data.dir, "reviews"), writableRoots: [], cases: [] });
  let selections = 0, executions = 0;
  const source: ReadOnlyPolicySource = { select: async () => { selections++; return chosen; } };
  const runtime = { prepare: async (config: VaultRunConfig) => ({ config,
    contract: await loadVaultTaskContract(config.vault, config.snapshot, config.checkout) }), submit: submitVaultRun,
    execute: (async (prepared, scheduler, _signal, hooks) => {
      executions++; assert.equal(hooks!.approvedResearchPolicy, source); assert.equal(prepared.config.lunaPolicy, "approved-policy/1");
      await scheduler.claim(config.runId, `${config.runId}:dispatch`);
      // Owned Node placeholders prove the product's termination check without
      // starting any provider, authentication flow or model turn.
      const owner = hooks!.executionOwner!;
      for(const role of ["astra", "luna"] as const) {
        await owner.launching(role);
        const child = await AppServerProcess.launchContained({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"],
          cwd: config.checkout, env: appServerChildEnv() }, owner.processTreeRoot);
        await owner.started(role, child.pid, child.treeIdentity!);
        const exit = await child.stop(); await owner.exited(role, child.pid, exit.treeReceipt);
      }
      const { result } = await run(prepared.config, hooks!.approvedResearchPolicy, undefined, async () => {
        const astra = (await new FileTaskLedger(join(config.outputDir, "run.jsonl")).read()).state!.attempts[0];
        await scheduler.append({ key: "fixture:plan", at: new Date().toISOString(), action: { type: "finish_planning", workId: config.runId,
          planRef: astra.outputRef!, threadId: astra.threadId!, turnId: astra.turnId! } });
        assert.ok(await scheduler.tryStartWorker(config.runId, "fixture:worker"));
      }, owner);
      await scheduler.append({ key: "fixture:verified", at: new Date().toISOString(), action: { type: "settle", workId: config.runId,
        outcome: "verified", evidenceRef: result.verification!.evidenceRef, actualCostUsd: null } });
      return result;
    }) satisfies typeof executeVaultRun };
  const tasks = await LocalTaskService.open(catalog, runtime);
  try {
    await tasks.connectReviews(reviews);
    const held = await tasks.snapshot(config.runId); assert.equal(held.canStart, false); assert.match(held.error!, /調査の設定を確認/);
    await assert.rejects(tasks.start(held.id, held.configSha256, randomUUID()), /cannot be dispatched/);
    assert.equal(await access(join(stateRoot, config.runId + ".request.json")).then(() => true, () => false), false);
    tasks.connectResearchPolicy(source);
    assert.throws(() => tasks.connectResearchPolicy({ select: async () => null }), /cannot change/);
    const ready = await tasks.snapshot(config.runId); assert.equal(ready.canStart, true);
    await tasks.start(ready.id, ready.configSha256, randomUUID());
    for(let i = 0; i < 200; i++) {
      const current = await tasks.snapshot(config.runId);
      if(!current.live && current.reviewId)break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = await tasks.snapshot(config.runId);
    assert.equal(result.status, "ready_for_review", result.error ?? undefined); assert.equal(result.workerProfileSelection!.policyId, "v1");
    assert.ok(result.reviewId); assert.equal(selections, 1); assert.equal(executions, 1);
  } finally { await tasks.close(); }
  const reopened = await LocalTaskService.open(catalog, runtime);
  try {
    await reopened.connectReviews(reviews);
    const saved = await reopened.snapshot(config.runId);
    assert.equal(saved.workerProfileSelection!.effort, "low"); assert.equal(saved.canStart, false); assert.equal(saved.error, null);
    assert.ok(saved.reviewId); assert.equal(selections, 1); assert.equal(executions, 1);
  } finally { await reopened.close(); }
}));

test("uncertain research reconciliation keeps the original pin and closes only from current signed inspection", async () => fixture(async data => {
  const config = await data.config("uncertain"), contract = await loadVaultTaskContract(config.vault, config.snapshot, config.checkout);
  const scheduler = new FileScheduler(config.schedulerPath), ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl"));
  const snapshotSha256 = hash(await readFile(config.snapshot)), configSha256 = hash(JSON.stringify({ config, snapshotSha256 }));
  await submitVaultRun({ config, contract }, scheduler); await scheduler.claim(config.runId, config.runId + ":dispatch");
  const selection = { role: "luna" as const, source: "approved-policy" as const, defaultProfile: profile, ...chosen };
  const append = (key: string, action: Parameters<typeof ledger.append>[0]["action"]) => ledger.append({ key, at: new Date().toISOString(), action });
  await append("create", { type: "create", runId: config.runId, contract: { ...contract, workerProfileSelection: selection } });
  await append("start", { type: "start_attempt", attemptId: "astra", role: "astra", requestedModel: config.astra.model });
  await append("bind", { type: "bind_provider", attemptId: "astra", threadId: "fixture-thread", turnId: "fixture-turn" });
  await append("unknown", { type: "provider_unknown", attemptId: "astra", reason: "fixture transport lost" });
  await scheduler.append({ key: "unknown", at: new Date().toISOString(), action: { type: "unknown", workId: config.runId, reason: "fixture unknown" } });
  const owner = await TaskExecutionOwner.acquire(config.outputDir, config.runId, configSha256, config.runId + ":dispatch");
  await owner.finish(); // No provider process was ever started in this fixture.
  let inspections = 0;
  const reconciliation = await LocalTaskReconciliation.open(join(data.dir, "reconciliation"), async (_config, threadId, turnId) => {
    inspections++; return { threadId, turnId, found: true, status: "interrupted", pagesRead: 1, completeSearch: true,
      observedAtMs: Date.now(), source: "thread/turns/list", processSafety: { source: "thread/items/list", complete: true,
        pagesRead: 1, itemCount: 1, itemTypes: ["agentMessage"], sha256: "c".repeat(64), noExecutableItems: true } };
  });
  const source = { config, configSha256, snapshotSha256, ledger, scheduler, isActive: () => false };
  source.ledger = new FileTaskLedger(ledger.path, Date.now, reconciliation.verifier(source));
  const preview = await reconciliation.inspect(source, randomUUID());
  assert.equal(preview.canClose, true); assert.equal(inspections, 1);
  await reconciliation.close(source, randomUUID(), preview.inspectionId, preview.dossierSha256);
  assert.equal(inspections, 2); assert.equal((await source.ledger.read()).state!.status, "stopped");
  assert.deepEqual((await source.ledger.read()).state!.contract.workerProfileSelection, selection);
  assert.equal((await scheduler.read()).state!.entries[0].status, "failed");
}));
