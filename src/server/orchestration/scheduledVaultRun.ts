// Admission wrapper for one Vault-backed Astra -> Sol run.
// A repeated dispatch key never starts the provider a second time.
import { resolve } from "node:path";
import { runSingleTaskFromVault } from "./vaultTaskContract.ts";
import type { TaskSnapshot } from "./singleTask.ts";
import { FileScheduler, type SchedulerAction, type SchedulerEvent } from "./scheduler.ts";

type VaultRunOptions = Parameters<typeof runSingleTaskFromVault>[0];
export interface ScheduledVaultRunOptions {
  scheduler: FileScheduler;
  dispatchKey: string;
  run: VaultRunOptions;
  execute?: (options: VaultRunOptions) => Promise<TaskSnapshot>;
}

function actualApiCost(state: TaskSnapshot): number | null {
  if (!state.attempts.length || state.attempts.some((attempt) =>
    attempt.usage?.billing !== "api_actual" || attempt.usage.costUsd === null)) return null;
  return state.attempts.reduce((sum, attempt) => sum + attempt.usage!.costUsd!, 0);
}

export async function runScheduledVaultTask(options: ScheduledVaultRunOptions): Promise<TaskSnapshot> {
  const { scheduler, dispatchKey, run } = options;
  if (!dispatchKey || !run.runId) throw new Error("scheduled run identity missing");
  const current = (await scheduler.read()).state;
  const registered = current?.entries.find((entry) => entry.work.id === run.runId);
  if (!registered || registered.work.role !== "sol" ||
      registered.work.checkoutMode !== "write" ||
      resolve(registered.work.checkout).toLowerCase() !== resolve(run.cwd).toLowerCase()) {
    throw new Error("scheduled run does not match registered Sol checkout");
  }
  await scheduler.claim(run.runId, dispatchKey);
  const record = async (keySuffix: string, action: SchedulerAction) => {
    const event: SchedulerEvent = { key: `${dispatchKey}:${keySuffix}`,
      at: new Date().toISOString(), action };
    await scheduler.append(event);
  };
  let result: TaskSnapshot;
  try { result = await (options.execute ?? runSingleTaskFromVault)(run); }
  catch (error) {
    // Once a task attempt was recorded, a provider may have performed work.
    // Keep the checkout and slot reserved until the provider and diff are reviewed.
    let state: TaskSnapshot | null = null;
    let ledgerRead = false;
    try { state = (await run.ledger.read()).state; ledgerRead = true; }
    catch { /* keep the reservation when ledger inspection fails */ }
    if (ledgerRead && (state === null || state.attempts.length === 0)) {
      await record("preflight-failed", { type: "settle", workId: run.runId,
        outcome: "failed", evidenceRef: "local:pre-dispatch-exception", actualCostUsd: null });
    } else {
      await record("outcome-unknown", { type: "unknown", workId: run.runId,
        reason: "task runner failed without proof that dispatch was avoided; inspect ledger and checkout" });
    }
    throw error;
  }
  if (result.status === "needs_reconciliation") {
    await record("outcome-unknown", { type: "unknown", workId: run.runId,
      reason: result.stopReason ?? "task provider outcome requires reconciliation" });
  } else if ((result.status === "ready_for_review" || result.status === "accepted") &&
             result.verification?.outcome === "passed") {
    await record("verified", { type: "settle", workId: run.runId,
      outcome: "verified", evidenceRef: result.verification.evidenceRef,
      actualCostUsd: actualApiCost(result) });
  } else {
    await record("failed", { type: "settle", workId: run.runId,
      outcome: "failed", evidenceRef: result.verification?.evidenceRef ??
        `ledger:${result.status}`, actualCostUsd: actualApiCost(result) });
  }
  return result;
}
