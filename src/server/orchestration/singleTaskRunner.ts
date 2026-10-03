// Single Astra -> Sol task driver. A caller supplies already connected clients;
// this module does not spawn processes or choose credentials.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CodexAppServerClient, CodexThreadIdentity, CodexTurnObservation } from "../master/appServerClient.ts";
import { FileTaskLedger, type AttemptUsage, type ContractRef, type TaskAction, type TaskSnapshot, type TaskRole } from "./singleTask.ts";
import type { ApprovedTaskPlan } from "./approvedTaskPlan.ts";

export interface SingleTaskClient {
  initialize: CodexAppServerClient["initialize"];
  discoverModels: CodexAppServerClient["discoverModels"];
  startThread: CodexAppServerClient["startThread"];
  startTurn: CodexAppServerClient["startTurn"];
  waitForTurn: CodexAppServerClient["waitForTurn"];
}
/** Trusted scheduler cancellation while no worker provider turn has been sent. */
export class TaskPreWorkerStopError extends Error {}
export interface SingleTaskRunOptions {
  runId: string;
  contract: ContractRef;
  cwd: string;
  astra: { client: SingleTaskClient; model: string; effort: string };
  sol: { client: SingleTaskClient; model: string; effort: string };
  ledger: FileTaskLedger;
  artifactDir: string;
  turnTimeoutMs: number;
  deadlineAtMs?: number;
  beforeSol?: () => Promise<void>;
  astraContext?: string;
  approvedPlan?: ApprovedTaskPlan;
  solContext?: string;
  expectedModelProvider?: string;
  onProviderBound?: (data: { role: TaskRole; attemptId: string; threadId: string; turnId: string }) => Promise<void>;
  onProviderTerminal?: (data: { role: TaskRole; attemptId: string; threadId: string; turnId: string }) => Promise<void>;
  verify: (evidence: { contract: ContractRef; planRef: string; workRef: string }) =>
    Promise<{ outcome: "passed" | "failed" | "unknown"; evidenceRef: string }>;
}

const verificationResponsibility =
  `検証の担当: Solのターン終了後、ランナーが固定検証を呼び出して証拠を台帳に保存します。\n` +
  `検証コマンドが提示されていなければ推測・追加実行せず、その検証はランナーの結果待ちと報告してください。\n` +
  `契約が実装前の検証や停止を明示している場合は、その条件を守ってください。検証合格や人間受入を自己申告で確定しないでください。\n`;

function promptForAstra(contract: ContractRef, context: string | undefined): string {
  return `次の固定された契約について、Solへ渡せる短い実行計画を作ってください。\n` +
    `モデル作業の追加起動・subagent・別モデルCLI・新規チャット作成は行わず、この一件を直接扱ってください。\n` +
    `目的: ${contract.objective}\n受入条件: ${contract.acceptance.join(" / ")}\n` +
    (contract.scope ? `対象: ${contract.scope.in.join(" / ")}\n対象外: ${contract.scope.out.join(" / ")}\n` +
      `変更可能パス: ${contract.scope.allowedPaths.join(" / ")}\n` : "") +
    (contract.invariants ? `不変条件: ${contract.invariants.join(" / ")}\n` : "") +
    (contract.verification ? `必要な検証: ${contract.verification.join(" / ")}\n` : "") +
    verificationResponsibility +
    (contract.escalation ? `差戻し条件: ${contract.escalation.join(" / ")}\n` : "") +
    `参照: ${contract.vaultId} v${contract.version} sha256=${contract.sha256}\n` +
    `基準SHA: ${contract.baseSha}\n不明な点は不明と記してください。` +
    (context ? `\n\nVault Context Pack（関連知識の派生物）:\n${context}` : "");
}
function promptForSol(contract: ContractRef, plan: string, context: string | undefined): string {
  return `次の契約に沿って一件を実装し、変更内容と検証結果を報告してください。\n` +
    `モデル作業の追加起動・subagent・別モデルCLI・新規チャット作成は行わず、この一件を直接扱ってください。\n` +
    `目的: ${contract.objective}\n受入条件: ${contract.acceptance.join(" / ")}\n` +
    (contract.scope ? `対象: ${contract.scope.in.join(" / ")}\n対象外: ${contract.scope.out.join(" / ")}\n` +
      `変更可能パス: ${contract.scope.allowedPaths.join(" / ")}\n` : "") +
    (contract.invariants ? `不変条件: ${contract.invariants.join(" / ")}\n` : "") +
    (contract.verification ? `必要な検証: ${contract.verification.join(" / ")}\n` : "") +
    verificationResponsibility +
    (contract.escalation ? `差戻し条件: ${contract.escalation.join(" / ")}\n` : "") +
    `参照: ${contract.vaultId} v${contract.version} sha256=${contract.sha256}\n` +
    `基準SHA: ${contract.baseSha}\nAstraの計画:\n${plan}` +
    (context ? `\n\nVault Context Pack（関連知識の派生物）:\n${context}` : "");
}
async function writeArtifact(directory: string, attemptId: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${attemptId}.md`);
  const data = Buffer.from(text, "utf8");
  if (data.length > 2_000_000) throw new Error("model output too large for local artifact");
  const handle = await open(path, "wx");
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  return `${path}#sha256=${createHash("sha256").update(data).digest("hex")}`;
}

function observedUsage(result: CodexTurnObservation, threadId: string): AttemptUsage | null {
  const raw = result.lastUsage;
  if (!raw) return null;
  const token = (field: string): number | null => {
    const value = raw[field];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const inputTokens = token("inputTokens");
  const outputTokens = token("outputTokens");
  const cachedInputTokens = token("cachedInputTokens");
  const reasoningOutputTokens = token("reasoningOutputTokens");
  if ([inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens].every((x) => x === null)) return null;
  if ((inputTokens !== null && cachedInputTokens !== null && cachedInputTokens > inputTokens) ||
      (outputTokens !== null && reasoningOutputTokens !== null && reasoningOutputTokens > outputTokens)) return null;
  // `last` is an observed notification value; this adapter does not assert that
  // it covers the whole turn, nor infer an API charge from subscription usage.
  return { scope: "unknown", inputTokens, outputTokens, cachedInputTokens,
    reasoningOutputTokens, billing: "unknown", costUsd: null,
    sourceRef: `app-server:thread/tokenUsage/updated:${threadId}:${result.turnId}:last` };
}

export async function runSingleTask(options: SingleTaskRunOptions): Promise<TaskSnapshot> {
  if (!options.runId || !options.cwd || !Number.isSafeInteger(options.turnTimeoutMs) ||
      options.turnTimeoutMs < 1 ||
      (options.deadlineAtMs !== undefined && !Number.isSafeInteger(options.deadlineAtMs))) {
    throw new Error("run parameters invalid");
  }
  const expired = () => options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs;
  const out = resolve(options.artifactDir);
  let sequence = 0;
  async function append(action: TaskAction): Promise<TaskSnapshot> {
    sequence++;
    return options.ledger.append({ key: `${options.runId}:${sequence}`, at: new Date().toISOString(), action });
  }
  const existing = await options.ledger.read();
  // An interrupted prior run is never silently restarted. The caller must inspect
  // its stored attempt/provider IDs and reconcile it first.
  if (existing.state !== null) throw new Error("run ledger already exists; inspect before resuming");
  const pinnedContract = { ...options.contract, ...(options.approvedPlan ? { approvedPlan: {
    approvalRef: options.approvedPlan.approvalRef, threadId: options.approvedPlan.threadId,
    turnId: options.approvedPlan.turnId, callId: options.approvedPlan.callId } } : {}) };
  await append({ type: "create", runId: options.runId, contract: pinnedContract });
  if (expired()) return append({ type: "stop", reason: "Task time limit expired before planning" });

  async function attempt(role: "astra" | "sol", settings: SingleTaskRunOptions["astra"],
                         prompt: string): Promise<{ state: TaskSnapshot; text: string | null; ref: string | null }> {
    const attemptId = randomUUID();
    await append({ type: "start_attempt", attemptId, role, requestedModel: settings.model });
    let identity: CodexThreadIdentity;
    let turnId: string;
    let result: CodexTurnObservation;
    let catalog: Awaited<ReturnType<SingleTaskClient["discoverModels"]>>;
    try {
      await settings.client.initialize();
      catalog = await settings.client.discoverModels();
    } catch {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} capability discovery failed before dispatch` }), text: null, ref: null };
    }
    if (!catalog.some((item) => item.model === settings.model &&
        item.efforts.includes(settings.effort) && item.inputModalities.includes("text"))) {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} model, effort or text input unavailable in discovered catalog` }), text: null, ref: null };
    }
    if (expired()) {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} task time limit expired before dispatch` }), text: null, ref: null };
    }
    try {
      identity = await settings.client.startThread({ cwd: options.cwd, model: settings.model,
        sandbox: role === "astra" ? "read-only" : "workspace-write" });
      await append({ type: "bind_thread", attemptId, threadId: identity.threadId });
    } catch {
      return { state: await append({ type: "provider_unknown", attemptId,
        reason: `${role} thread creation or ledger binding not confirmed` }), text: null, ref: null };
    }
    if (identity.rerouted) {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} resolved model differs from requested model` }), text: null, ref: null };
    }
    if (options.expectedModelProvider && identity.modelProvider !== options.expectedModelProvider) {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} resolved provider differs from the permitted billing route` }), text: null, ref: null };
    }
    if (expired()) {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} task time limit expired before turn dispatch` }), text: null, ref: null };
    }
    try {
      turnId = await settings.client.startTurn(prompt, settings.effort);
      await append({ type: "bind_provider", attemptId, threadId: identity.threadId, turnId });
      await options.onProviderBound?.({ role, attemptId, threadId: identity.threadId, turnId });
      const remaining = options.deadlineAtMs === undefined ? options.turnTimeoutMs :
        Math.min(options.turnTimeoutMs, Math.max(1, options.deadlineAtMs - Date.now()));
      result = await settings.client.waitForTurn(turnId, remaining);
      await options.onProviderTerminal?.({ role, attemptId, threadId: identity.threadId, turnId });
    } catch {
      return { state: await append({ type: "provider_unknown", attemptId,
        reason: `${role} provider outcome not confirmed` }), text: null, ref: null };
    }
    if (result.status === "failed" || result.status === "interrupted") {
      return { state: await append({ type: "fail_attempt", attemptId,
        reason: `${role} turn ${result.status}` }), text: null, ref: null };
    }
    if (result.status !== "completed" || !result.finalText) {
      return { state: await append({ type: "provider_unknown", attemptId,
        reason: `${role} turn has no confirmed final answer` }), text: null, ref: null };
    }
    // The artifact and ledger are separate writes. If a crash occurs between them,
    // the attempt remains running and must be reconciled; it is never redispatched.
    let ref: string;
    try { ref = await writeArtifact(out, attemptId, result.finalText); }
    catch {
      return { state: await append({ type: "provider_unknown", attemptId,
        reason: `${role} output artifact could not be persisted` }), text: null, ref: null };
    }
    const state = await append({ type: "complete_attempt", attemptId,
      resolvedModel: identity.resolvedModel, threadId: identity.threadId,
      turnId, outputRef: ref, usage: observedUsage(result, identity.threadId) });
    return { state, text: result.finalText, ref };
  }

  const plan = options.approvedPlan ? {
    text: options.approvedPlan.text,
    ref: await writeArtifact(out, `${options.runId}-approved-plan`, options.approvedPlan.text),
    state: null as TaskSnapshot | null,
  } : await attempt("astra", options.astra, promptForAstra(options.contract, options.astraContext));
  if (options.approvedPlan) plan.state = await append({ type: "adopt_approved_plan",
    approvalRef: options.approvedPlan.approvalRef, outputRef: plan.ref! });
  if (!plan.state || plan.state.status !== "ready_for_worker" || !plan.text || !plan.ref) return plan.state!;
  if (plan.text.length > 20_000) {
    return append({ type: "stop", reason: "Astra plan exceeds the single-task handoff limit" });
  }
  if (expired()) return append({ type: "stop", reason: "Task time limit expired before Sol" });
  if (options.beforeSol) {
    try { await options.beforeSol(); }
    catch (error) { return append({ type: "stop", reason: error instanceof TaskPreWorkerStopError
      ? error.message : "Contract or checkout changed before Sol dispatch" }); }
  }
  const work = await attempt("sol", options.sol,
    promptForSol(options.contract, plan.text, options.solContext));
  if (work.state.status !== "verifying" || !work.ref) return work.state;
  if (expired()) return append({ type: "verify", outcome: "unknown",
    evidenceRef: "local:task-time-limit-expired-before-verification" });
  let verification: { outcome: "passed" | "failed" | "unknown"; evidenceRef: string };
  try { verification = await options.verify({ contract: options.contract,
    planRef: plan.ref, workRef: work.ref }); }
  catch { verification = { outcome: "unknown", evidenceRef: "local:verification-threw" }; }
  if (!verification.evidenceRef) verification = { outcome: "unknown", evidenceRef: "local:verification-evidence-missing" };
  return append({ type: "verify", ...verification });
}
