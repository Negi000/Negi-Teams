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
export type TaskAdmissionGuard = <T>(operation:()=>Promise<T>)=>Promise<T>;
export interface ScheduledVaultRunOptions {
  scheduler: FileScheduler;
  dispatchKey: string;
  run: VaultRunOptions;
  execute?: (options: VaultRunOptions) => Promise<TaskSnapshot>;
  signal?: AbortSignal;
  onCapacityReleased?: () => Promise<void>;
  admit?:TaskAdmissionGuard;
  taskMode?:"read_only_research"|"integration_resolution";
  beforeRelease?:()=>Promise<void>;
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
  const research = run.luna !== undefined && run.sol === undefined;
  if (!registered || registered.work.role !== (research ? "luna" : "sol") ||
      registered.work.checkoutMode !== (research ? "read" : "write") ||
      registered.work.taskMode !== (research ? "read_only_research" : options.taskMode) ||
      (registered.work.execution !== "direct" && registered.work.execution !== (research ? "astra_to_luna" : "astra_to_sol") &&
        !(registered.work.execution === undefined && !research)) ||
      resolve(registered.work.checkout).toLowerCase() !== resolve(run.cwd).toLowerCase()) {
    throw new Error("scheduled run does not match registered worker and checkout permissions");
  }
  if(registered.work.taskMode==="integration_resolution"&&(!options.admit||!run.approvedPlan||research))
    throw Error("Resolution requires restored source admission before scheduler claim");
  const claim=()=>scheduler.claim(run.runId,dispatchKey);
  if(options.admit)await options.admit(claim);else await claim();
  const record = async (keySuffix: string, action: SchedulerAction) => {
    const event: SchedulerEvent = { key: `${dispatchKey}:${keySuffix}`,
      at: new Date().toISOString(), action };
    await scheduler.append(event);
  };
  const confirmRelease=async()=>{
    try{await options.beforeRelease?.()}
    catch(error){await record("processes-unknown",{type:"unknown",workId:run.runId,
      reason:"Owned process termination has not been confirmed; retain checkout and execution slot"});throw error}
  };
  let result: TaskSnapshot;
  const isPipeline = registered.work.execution === "astra_to_sol" || registered.work.execution === "astra_to_luna";
  const checkpoint = async () => {
      if(research)await run.beforeWorker?.();else await run.beforeSol?.();
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
    };
  // Preserve the historical Sol checkpoint for injected callers, including its
  // after-wait contract recheck. Research has its own exact worker checkpoint.
  const executionRun:VaultRunOptions={...run,...(options.admit?{providerAdmission:options.admit}:{}),
    ...(isPipeline?(research?{beforeWorker:checkpoint}:{beforeSol:checkpoint}):{})};
  try {
    result = await (options.execute ?? runSingleTaskFromVault)(executionRun);
    if (isPipeline && ["ready_for_review", "accepted"].includes(result.status) &&
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
      await confirmRelease();
      await record("preflight-failed", { type: "settle", workId: run.runId,
        outcome: "failed", evidenceRef: "local:pre-dispatch-exception", actualCostUsd: null });
    } else {
      await record("outcome-unknown", { type: "unknown", workId: run.runId,
        reason: "task runner failed without proof that dispatch was avoided; inspect ledger and checkout" });
    }
    throw error;
  }
  if (result.status === "needs_reconciliation" || result.verification?.outcome==="unknown") {
    await record("outcome-unknown", { type: "unknown", workId: run.runId,
      reason: result.verification?.outcome==="unknown"?"Verification result unknown; inspect verification and process records":
        result.stopReason ?? "task provider outcome requires reconciliation" });
  } else if ((result.status === "ready_for_review" || result.status === "accepted") &&
             result.verification?.outcome === "passed") {
    await confirmRelease();
    await record("verified", { type: "settle", workId: run.runId,
      outcome: "verified", evidenceRef: result.verification.evidenceRef,
      actualCostUsd: actualApiCost(result) });
  } else {
    await confirmRelease();
    await record("failed", { type: "settle", workId: run.runId,
      outcome: "failed", evidenceRef: result.verification?.evidenceRef ??
        `ledger:${result.status}`, actualCostUsd: actualApiCost(result) });
  }
  return result;
}
