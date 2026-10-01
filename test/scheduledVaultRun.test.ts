import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler, type SchedulerEvent } from "../src/server/orchestration/scheduler.ts";
import { FileTaskLedger, type ContractRef, type TaskSnapshot } from "../src/server/orchestration/singleTask.ts";
import { runScheduledVaultTask } from "../src/server/orchestration/scheduledVaultRun.ts";

const at = "2026-09-30T12:00:00Z";
const contract: ContractRef = { vaultId: "NT-TASK", version: 1, sha256: "a".repeat(64),
  project: "negi-teams", objective: "Bounded change", acceptance: ["local verification"],
  baseSha: "b".repeat(40) };
function event(key: string, action: SchedulerEvent["action"]): SchedulerEvent {
  return { key, at, action };
}
function result(runId: string, status: TaskSnapshot["status"]): TaskSnapshot {
  return { runId, contract, status, attempts: [], approvals: [], providerObservations: [],
    verification: status === "ready_for_review" ? { outcome: "passed", evidenceRef: "test:verified" } : null,
    stopReason: status === "needs_reconciliation" ? "provider result unknown" : null,
    stoppedFrom: null, acceptedBy: null };
}
async function fixture(run: (data: { scheduler: FileScheduler; checkout: string;
  ledger: FileTaskLedger; options: Parameters<typeof runScheduledVaultTask>[0]["run"] }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-scheduled-"));
  const checkout = join(dir, "checkout");
  const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
  const ledger = new FileTaskLedger(join(dir, "task.jsonl"));
  const options = { runId: "run-a", cwd: checkout, ledger } as
    Parameters<typeof runScheduledVaultTask>[0]["run"];
  try {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    await scheduler.append(event("submit", { type: "submit", work: {
      id: "run-a", parentId: null, dependencies: [], role: "sol", checkout,
      checkoutMode: "write", resources: [], reserveUsd: 0 } }));
    await run({ scheduler, checkout, ledger, options });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("verified run frees the slot, while repeated dispatch key cannot call provider", async () => {
  await fixture(async ({ scheduler, options }) => {
    let calls = 0;
    const execute = async () => { calls++; return result("run-a", "ready_for_review"); };
    await runScheduledVaultTask({ scheduler, dispatchKey: "dispatch-a", run: options, execute });
    assert.equal((await scheduler.read()).state?.entries[0]?.status, "verified");
    assert.equal((await scheduler.read()).state?.entries[0]?.evidenceRef, "test:verified");
    await assert.rejects(runScheduledVaultTask({ scheduler, dispatchKey: "dispatch-a",
      run: options, execute }), /claim key already used/);
    assert.equal(calls, 1);
  });
});

test("unknown provider result keeps the checkout and global slot reserved", async () => {
  await fixture(async ({ scheduler, checkout, options }) => {
    await scheduler.append(event("submit-b", { type: "submit", work: {
      id: "run-b", parentId: null, dependencies: [], role: "sol", checkout,
      checkoutMode: "write", resources: [], reserveUsd: 0 } }));
    await runScheduledVaultTask({ scheduler, dispatchKey: "dispatch-a", run: options,
      execute: async () => result("run-a", "needs_reconciliation") });
    assert.equal((await scheduler.read()).state?.entries[0]?.status, "needs_reconciliation");
    assert.equal(await scheduler.startNext("blocked"), null);
  });
});

test("pre-dispatch exception releases a job; exception after an attempt stays unknown", async () => {
  await fixture(async ({ scheduler, ledger, options }) => {
    await assert.rejects(runScheduledVaultTask({ scheduler, dispatchKey: "preflight", run: options,
      execute: async () => { throw new Error("preflight failed"); } }), /preflight failed/);
    assert.equal((await scheduler.read()).state?.entries[0]?.status, "failed");

    await scheduler.append(event("second", { type: "submit", work: {
      id: "run-b", parentId: null, dependencies: [], role: "sol", checkout: options.cwd + "-second",
      checkoutMode: "write", resources: [], reserveUsd: 0 } }));
    await ledger.append({ key: "create", at, action: { type: "create", runId: "run-b", contract } });
    await ledger.append({ key: "attempt", at, action: { type: "start_attempt", attemptId: "a",
      role: "astra", requestedModel: "gpt-6-astra" } });
    const secondOptions = { ...options, runId: "run-b", cwd: options.cwd + "-second" };
    await assert.rejects(runScheduledVaultTask({ scheduler, dispatchKey: "after-attempt",
      run: secondOptions, execute: async () => { throw new Error("provider failed"); } }),
      /provider failed/);
    assert.equal((await scheduler.read()).state?.entries[1]?.status, "needs_reconciliation");
  });
});
