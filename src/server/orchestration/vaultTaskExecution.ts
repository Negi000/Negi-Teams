// Shared server/CLI execution. Browser input never supplies executable commands.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppServerProcess } from "../master/appServerProcess.ts";
import { boundedAppServerArgs, researchAppServerArgs, subscriptionChildEnv } from "../master/boundedAppServer.ts";
import { RESEARCH_CODEX_VERSION, assertResearchDispatchIsolation } from "../master/researchToolPolicy.ts";
import { FileScheduler } from "./scheduler.ts";
import { FileTaskLedger, type ReconciliationVerifier, type TaskSnapshot, type TaskRole } from "./singleTask.ts";
import type { CodexApprovalRequest } from "../master/appServerClient.ts";
import { runScheduledVaultTask, type TaskAdmissionGuard } from "./scheduledVaultRun.ts";
import { loadVaultTaskContract,
  runSingleTaskFromVault, type VaultTaskContract } from "./vaultTaskContract.ts";
import { assertVaultRunOutputPaths, assertVerificationCoverage, assertVaultWorkerContract, vaultWorker, canonicalVaultRunRegistration, type VaultRunConfig } from "./vaultRunConfig.ts";
import { loadApprovedTaskPlan, type ApprovedTaskPlan } from "./approvedTaskPlan.ts";
import { verifyConfiguredCheckout } from "./checkoutVerification.ts";
import { TaskExecutionOwner } from "./taskExecutionOwner.ts";
import { researchReviewMetadata } from "./researchArtifactPolicy.ts";

const exec = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function assertResearchHost(platform:NodeJS.Platform=process.platform):void{
  if(platform!=="win32")throw Error("Read-only research requires Windows Job process containment; this host is unsupported");
}
export async function assertResearchExecutable(config:VaultRunConfig):Promise<void>{
  assertResearchHost();
  const entry=await lstat(config.executable),actual=await realpath(config.executable);
  const normalized=(path:string)=>process.platform==="win32"?resolve(path).toLowerCase():resolve(path);
  if(!entry.isFile()||entry.isSymbolicLink()||normalized(actual)!==normalized(config.executable))
    throw Error("Research executable identity changed before launch");
  const version=await exec(actual,["--version"],{encoding:"utf8",windowsHide:true,timeout:20_000,env:subscriptionChildEnv()});
  if(version.stdout.trim()!==RESEARCH_CODEX_VERSION)throw Error("Research Codex version requires tool-authority compatibility review");
}
export interface PreparedVaultRun { config: VaultRunConfig; contract: VaultTaskContract; approvedPlan?: ApprovedTaskPlan; executionConfigSha256?:string }
export interface TaskOperationApproval {
  id: string; attemptId: string; threadId: string; turnId: string;
  operation: string; target: string; expiresAt: string;
  targetKnown?: boolean;
}
export interface TaskExecutionHooks {
  executionOwner?: TaskExecutionOwner;
  admit?:TaskAdmissionGuard;
  knowledgeProofDirectory?: string;
  contextCacheDirectory?: string;
  onApproval: (approval: TaskOperationApproval,
    decide: (allow: boolean, approvalRef: string, at: string, requestId: string) => Promise<void>) => void;
  verifyApproval: ReconciliationVerifier;
  onCapacityReleased?: () => Promise<void>;
}

export async function prepareVaultRun(raw: VaultRunConfig): Promise<PreparedVaultRun> {
  if(raw.taskMode==="read_only_research")assertResearchDispatchIsolation();
  const registered=await canonicalVaultRunRegistration(raw);
  const executionConfigSha256=hash(JSON.stringify({config:registered,snapshotSha256:hash(await readFile(registered.snapshot))}));
  const config = { ...registered, executable: await realpath(registered.executable) };
  if (!(await stat(config.executable)).isFile()) throw new Error("Codex executable is not a regular file");
  if(config.taskMode==="read_only_research")await assertResearchExecutable(config);
  const login = await exec(config.executable, ["login", "status"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000, env: subscriptionChildEnv() });
  if (!login.stdout.includes("Logged in using ChatGPT") && !login.stderr.includes("Logged in using ChatGPT"))
    throw new Error("Codex is not logged in using ChatGPT; refusing model dispatch");
  const contract = await loadVaultTaskContract(config.vault, config.snapshot, config.checkout);
  assertVaultWorkerContract(config,contract);
  if(config.taskMode==="read_only_research")researchReviewMetadata(contract,config.verification.map(c=>c.requirement));
  assertVerificationCoverage(contract.verification, config.verification);
  await assertVaultRunOutputPaths(config);
  const approvedPlan = await loadApprovedTaskPlan(config, contract);
  return { config, contract,executionConfigSha256, ...(approvedPlan ? { approvedPlan } : {}) };
}

export async function submitVaultRun(prepared: PreparedVaultRun, scheduler: FileScheduler): Promise<void> {
  const { config } = prepared;
  assertVaultWorkerContract(config,prepared.contract);
  const worker=vaultWorker(config);
  await mkdir(config.outputDir, { recursive: true });
  await scheduler.ensureSubscriptionConfiguration();
  if ((await scheduler.read()).state?.entries.some((entry) => entry.work.id === config.runId))
    throw new Error("Run ID already registered; inspect it before any new attempt");
  await scheduler.append({ key: `${config.runId}:submit`, at: new Date().toISOString(),
    action: { type: "submit", work: { id: config.runId, parentId: null, dependencies: [],
      role: worker.role, checkout: config.checkout, checkoutMode: worker.checkoutMode,
      ...(worker.role==="luna"?{taskMode:"read_only_research" as const}:{}),
      execution: config.approvedPlan ? "direct" : worker.role==="luna"?"astra_to_luna":"astra_to_sol",
      resources: config.resources.map((name) => ({ name, mode: worker.checkoutMode })), reserveUsd: 0 } } });
}

export async function verifyVaultRun(prepared: PreparedVaultRun, signal?: AbortSignal, outputName = "verification.json",processOwner?:TaskExecutionOwner) {
  if (!/^verification(?:-r[1-9][0-9]?)?\.json$/.test(outputName)) throw new Error("Verification output name invalid");
  const { config, contract } = prepared;
  assertVaultWorkerContract(config,contract);
  return verifyConfiguredCheckout({ ...config, baseSha: contract.baseSha, allowedPaths: contract.scope.allowedPaths,
    requiredVerification: contract.verification, commands: config.verification,processOwner }, signal, outputName);
}

export async function executeVaultRun(prepared: PreparedVaultRun, scheduler: FileScheduler,
                                      signal?: AbortSignal, hooks?: TaskExecutionHooks): Promise<TaskSnapshot> {
  const { config, contract } = prepared;
  assertVaultWorkerContract(config,contract);
  const workerProfile=vaultWorker(config),research=workerProfile.role==="luna";
  if(research)assertResearchDispatchIsolation();
  // One deadline covers both roles and verification, not a fresh budget per turn.
  const deadline = AbortSignal.timeout(contract.limits.timeLimitMinutes * 60_000);
  const deadlineAtMs = Date.now() + contract.limits.timeLimitMinutes * 60_000;
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl"), Date.now, undefined, undefined, hooks?.verifyApproval);
  const owner = hooks?.executionOwner ?? await TaskExecutionOwner.acquire(config.outputDir, config.runId,
    prepared.executionConfigSha256??hash(JSON.stringify({config,snapshotSha256:hash(await readFile(config.snapshot))})), `${config.runId}:dispatch`);
  // Admission occurs before opening either provider process.
  try { return await runScheduledVaultTask({ scheduler, dispatchKey: `${config.runId}:dispatch`, signal,
    admit:hooks?.admit,
    beforeRelease:()=>owner.assertProcessesEnded(),
    onCapacityReleased: hooks?.onCapacityReleased,
    run: { runId: config.runId, cwd: config.checkout, vaultDirectory: config.vault,
      snapshotPath: config.snapshot, ledger, artifactDir: join(config.outputDir, "artifacts"),
      turnTimeoutMs: Math.min(600_000, contract.limits.timeLimitMinutes * 60_000),
      deadlineAtMs,
      astra: { client: null as never, ...config.astra },
      ...(research?{luna:{client:null as never,...workerProfile.profile}}:{sol:{client:null as never,...workerProfile.profile}}),
      ...(prepared.approvedPlan ? { approvedPlan: prepared.approvedPlan } : {}),
      verify: () => verifyVaultRun(prepared, signal,"verification.json",owner) },
    execute: async (options) => {
      if (signal?.aborted) throw new Error("Run stopped before provider dispatch");
      const bindings = new Map<TaskRole, { attemptId: string; threadId: string; turnId: string }>();
      const queued: Array<{ role: TaskRole; request: CodexApprovalRequest }> = [];
      let approvalJobs: Promise<void> = Promise.resolve();
      let astra: AppServerProcess | null = null;
      let worker: AppServerProcess | null = null;
      const register = async (role: TaskRole, request: CodexApprovalRequest) => {
        const provider = role === "astra" ? astra : worker;
        const bound = bindings.get(role);
        if (!provider || !bound || bound.threadId !== request.threadId || bound.turnId !== request.turnId)
          throw new Error("Operation approval does not match the active Task attempt");
        const id = hash(JSON.stringify({ role, request })).slice(0, 32);
        const approval: TaskOperationApproval = { id, attemptId: bound.attemptId,
          threadId: request.threadId, turnId: request.turnId, operation: request.method,
          target: request.target + (request.cwd ? `\n作業ディレクトリ: ${request.cwd}` : ""),
          targetKnown: request.targetKnown && (request.method !== "item/commandExecution/requestApproval" || request.cwd !== null),
          expiresAt: new Date(request.expiresAtMs).toISOString() };
        await ledger.append({ key: `operation-request:${id}`, at: new Date().toISOString(),
          action: { type: "request_approval", approval } });
        hooks!.onApproval(approval, async (allow, approvalRef, at, requestId) => {
          if ((allow && !approval.targetKnown) || signal?.aborted || Date.now() > request.expiresAtMs ||
              !provider.client.pendingApprovals.some((item) => item.id === request.id &&
                item.threadId === request.threadId && item.turnId === request.turnId && item.target === request.target))
            throw new Error("Operation approval is no longer live");
          // The human authorization is recorded before the response is sent.
          await ledger.append({ key: `task-operation:${requestId}`, at, action: {
            type: "decide_approval", approvalId: id, ...bound, operation: request.method,
            target: approval.target, decision: allow ? "allow" : "deny", approvalRef } });
          provider.client.answerApproval(request, allow);
        });
      };
      const onApproval = (role: TaskRole) => research ? (request:CodexApprovalRequest)=>{
        // A research contract cannot be escalated by the browser or a model.
        const provider=role==="astra"?astra:worker;
        try{provider?.client.answerApproval(request,false)}catch{/* the provider has ended */}
      } : hooks ? (request: CodexApprovalRequest) => {
        if (!bindings.has(role)) { queued.push({ role, request }); return; }
        approvalJobs = approvalJobs.then(() => register(role, request)).catch(() => {
          const provider = role === "astra" ? astra : worker;
          try { provider?.client.answerApproval(request, false); } catch { /* provider may be gone */ }
        });
      } : undefined;
      const stop = () => { if (astra) void astra.stop().catch(()=>{}); if (worker) void worker.stop().catch(()=>{}); };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        if (!prepared.approvedPlan) {
          if(research)await assertResearchExecutable(config);
          await owner.launching("astra");
          const launch={ executable: config.executable,
            args: research?researchAppServerArgs():boundedAppServerArgs(true), env: subscriptionChildEnv(), cwd: config.checkout,
            client: { transportTimeoutMs: 20_000, onApproval: onApproval("astra") } };
          astra=process.platform==="win32"?await AppServerProcess.launchContained(launch,owner.processTreeRoot):AppServerProcess.launch(launch);
          await owner.started("astra", astra.pid,astra.treeIdentity??undefined);
        }
        if(research)await assertResearchExecutable(config);
        await owner.launching(workerProfile.role);
        const launch={ executable: config.executable,
          args: research?researchAppServerArgs():boundedAppServerArgs(true), env: subscriptionChildEnv(), cwd: config.checkout,
          client: { transportTimeoutMs: 20_000, onApproval: onApproval(workerProfile.role) } };
        worker=process.platform==="win32"?await AppServerProcess.launchContained(launch,owner.processTreeRoot):AppServerProcess.launch(launch);
        await owner.started(workerProfile.role, worker.pid,worker.treeIdentity??undefined);
        for (const provider of [...(astra ? [astra] : []), worker]) {
          await provider.client.initialize();
          const account = await provider.client.readAccountMode();
          if (account.type !== "chatgpt" || !account.requiresOpenaiAuth)
            throw new Error("Task execution requires ChatGPT account authentication");
        }
        const beforeWorker=async()=>{
          if(signal?.aborted)throw Error("User requested stop");
          if(prepared.approvedPlan&&JSON.stringify(await loadApprovedTaskPlan(config,contract))!==JSON.stringify(prepared.approvedPlan))
            throw Error("Approved Task plan changed before worker");
          if(research)await options.beforeWorker?.();else await options.beforeSol?.();
          if(signal?.aborted)throw Error("User requested stop");
        };
        return await runSingleTaskFromVault({ ...options,
          knowledgeProofDirectory: hooks?.knowledgeProofDirectory,
          contextCacheDirectory: hooks?.contextCacheDirectory,
          astra: { client: astra?.client ?? null as never, ...config.astra },
          ...(research?{luna:{client:worker.client,...workerProfile.profile}}:{sol:{client:worker.client,...workerProfile.profile}}),
          expectedModelProvider: "openai",
          onProviderBound: async (bound) => {
            bindings.set(bound.role, bound);
            for (let i = queued.length - 1; i >= 0; i--) {
              if (queued[i].role !== bound.role) continue;
              const next = queued.splice(i, 1)[0];
              approvalJobs = approvalJobs.then(() => register(next.role, next.request));
            }
            await approvalJobs;
          },
          onProviderTerminal: async (bound) => {
            await approvalJobs;
            const state = (await ledger.read()).state;
            for (const approval of state?.approvals ?? []) if (approval.decision === "pending" &&
                approval.attemptId === bound.attemptId) await ledger.append({
              key: `operation-discard:${approval.id}`, at: new Date().toISOString(),
              action: { type: "discard_approval", approvalId: approval.id, reason: "provider_turn_ended" } });
          },
          ...(research?{beforeWorker}:{beforeSol:beforeWorker}) });
      } finally {
        signal?.removeEventListener("abort", stop);
        const stopped = await Promise.allSettled(([ ["astra", astra], [workerProfile.role, worker] ] as const)
          .filter((entry) => entry[1] !== null).map(async ([role, provider]) => {
            const exit=await provider!.stop();await owner.exited(role, provider!.pid,exit.treeReceipt);
          }));
        const failed = stopped.find((item) => item.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
    } }); } finally { if (!hooks?.executionOwner) await owner.finish(); }
}
