// Admission wrapper for one Vault-backed Astra -> Sol run.
// A repeated dispatch key never starts the provider a second time.
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { runSingleTaskFromVault } from "./vaultTaskContract.ts";
import { TaskPreWorkerStopError } from "./singleTaskRunner.ts";
import type { TaskSnapshot } from "./singleTask.ts";
import { FileScheduler, type SchedulerAction, type SchedulerEvent } from "./scheduler.ts";

type VaultRunOptions = Parameters<typeof runSingleTaskFromVault>[0];
export interface ScheduledVaultRunOptions {
  scheduler: FileScheduler;
  dispatchKey: string;
  run: VaultRunOptions;
  execute?: (options: VaultRunOptions) => Promise<TaskSnapshot>;
  signal?: AbortSignal;
  onCapacityReleased?: () => Promise<void>;
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
  const executionRun: VaultRunOptions = registered.work.execution === "astra_to_sol" ? { ...run,
    beforeSol: async () => {
      await run.beforeSol?.();
      const planned = (await run.ledger.read()).state;
      const attempt = planned?.attempts.at(-1);
      if (planned?.runId !== run.runId || planned.status !== "ready_for_worker" || attempt?.role !== "astra" ||
          attempt.state !== "completed" || !attempt.outputRef || !attempt.threadId || !attempt.turnId)
        throw new Error("Astra terminal planning evidence missing");
      const at = attempt.outputRef.lastIndexOf("#sha256=");
      if (at < 1) throw new Error("Astra planning artifact digest missing");
      const path = attempt.outputRef.slice(0, at), expected = attempt.outputRef.slice(at + 8);
      const assertPlan = async () => {
        const root = await realpath(run.artifactDir), actual = await realpath(path);
        const rel = relative(root.toLowerCase(), actual.toLowerCase()), entry = await lstat(path);
        if (!rel || rel.startsWith("..") || isAbsolute(rel) || entry.isSymbolicLink() || !entry.isFile() || entry.size > 2_000_000 ||
            createHash("sha256").update(await readFile(actual)).digest("hex") !== expected)
          throw new Error("Astra planning artifact changed or outside run output");
      };
      await assertPlan();
      await record("planning-complete", { type: "finish_planning", workId: run.runId,
        planRef: attempt.outputRef, threadId: attempt.threadId, turnId: attempt.turnId });
      try { await options.onCapacityReleased?.(); } catch { /* the durable transition remains valid */ }
      for (;;) {
        if (options.signal?.aborted) throw new TaskPreWorkerStopError("作業枠の待機中に停止しました。作業は開始していません。");
        if (run.deadlineAtMs !== undefined && Date.now() >= run.deadlineAtMs)
          throw new TaskPreWorkerStopError("作業枠の待機中に制限時間を超えました。作業は開始していません。");
        if (await scheduler.tryStartWorker(run.runId, `${dispatchKey}:worker`)) break;
        try { await wait(100, undefined, { signal: options.signal }); }
        catch { throw new TaskPreWorkerStopError("作業枠の待機中に停止しました。作業は開始していません。"); }
      }
      // The wait can outlive an operator's edits. Check again while holding the worker lease.
      await assertPlan();
    } } : run;
  try {
    result = await (options.execute ?? runSingleTaskFromVault)(executionRun);
    if (registered.work.execution === "astra_to_sol" && ["ready_for_review", "accepted"].includes(result.status) &&
        (await scheduler.read()).state?.entries.find(entry => entry.work.id === run.runId)?.phase !== "working")
      throw new Error("Pipeline completed without a recorded worker admission");
  }
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
