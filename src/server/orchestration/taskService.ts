// A trusted local catalog connects Task Contract execution to the web UI.
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FileScheduler, parseSchedulerCapacity, schedulerCapacityUsage, schedulerWorkEligible, type ScheduledPhase } from "./scheduler.ts";
import { guardMasterAdmission, scheduledMasterTurns, type MasterTurnAdmission } from "./masterTurnAdmission.ts";
import { MasterConversationAuthority } from "./masterConversations.ts";
import type { ConfigurationAdmission } from "./projectConfiguration.ts";
import { FileTaskLedger, type TaskEvent, type TaskSnapshot } from "./singleTask.ts";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import { assertVaultRunOutputPaths, canonicalVaultRunRegistration, parseVaultRunConfig, type VaultRunConfig } from "./vaultRunConfig.ts";
import { executeVaultRun, prepareVaultRun, submitVaultRun, verifyVaultRun, type PreparedVaultRun, type TaskOperationApproval } from "./vaultTaskExecution.ts";
import { captureTaskReview, taskReviewCheckoutFingerprint, verifyTaskReviewCheckout, type TaskReviewManifest } from "./taskReviewArtifact.ts";
import { ReviewDecisionBusyError, type LocalReviewService } from "./reviewService.ts";
import { setTimeout as wait } from "node:timers/promises";
import type { TaskAdmissionGuard } from "./scheduledVaultRun.ts";
import { loadVaultTaskContract } from "./vaultTaskContract.ts";
import { assertVerificationCoverage } from "./vaultRunConfig.ts";
import type { IntegrationSource } from "./taskIntegration.ts";
import { readTaskRevision, replayRevisionReview, revisionMatchesTask, taskManifestName,
  taskRevisionHash, writeTaskRevisionPointer, type PinnedTaskRevision, type TaskRevisionJournal } from "./taskRevision.ts";
import { TaskResultStore, TaskResultSourceChangedError, type TaskResultContext } from "./taskResults.ts";
import type { TaskResultNotice, TaskResultSummary } from "../../shared/taskResults.ts";
import type { MasterOrigin } from "../../shared/conversations.ts";
import { readMasterTurnOrigin } from "./masterTurnRecords.ts";
import { TaskExecutionOwner } from "./taskExecutionOwner.ts";
import { LocalTaskReconciliation, type InspectTaskProvider, type TaskReconciliationView } from "./taskReconciliation.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function inside(root: string, path: string): boolean {
  const rel = relative(root.toLowerCase(), path.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function localDestination(raw: string, directory: boolean): Promise<string> {
  if (!isAbsolute(raw)) throw new Error("Task catalog paths must be absolute");
  const path = resolve(raw);
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()))
      throw new Error("Task catalog destination has an unsafe type");
    return realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}
async function readJson(path: string): Promise<unknown | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 2_000_000) throw new Error("Task state file invalid");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeNew(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
}
interface CatalogRun { title: string; config: VaultRunConfig; configSha256: string;
  snapshotSha256: string; contract: Record<string, unknown> }
export type TaskRequestOrigin = { kind: "browser" } | { kind: "master"; masterId: string;
  threadId: string; turnId: string; callId: string };
interface StartRequest { runId: string; requestId: string; configSha256: string; at: string;
  requestedBy?: TaskRequestOrigin }
function checkedOrigin(value: TaskRequestOrigin): TaskRequestOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task request origin invalid");
  if (value.kind === "browser" && Object.keys(value).length === 1) return { kind: "browser" };
  if (value.kind === "master" && Object.keys(value).length === 5 &&
      [value.masterId, value.threadId, value.turnId, value.callId].every(id => typeof id === "string" &&
        id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id))) return {
          kind: "master", masterId: value.masterId, threadId: value.threadId, turnId: value.turnId, callId: value.callId };
  throw new Error("Task request origin invalid");
}
export interface TaskRunView {
  id: string; title: string; configSha256: string; project: string; objective: string;
  taskId: string; version: number; baseSha: string; checkout: string;
  acceptance: string[]; allowedPaths: string[]; verification: string[];
  outOfScope: string[]; invariants: string[];
  astra: VaultRunConfig["astra"]; sol: VaultRunConfig["sol"];
  status: string; canStart: boolean; canStop: boolean; live: boolean;
  executionPhase: ScheduledPhase | null;
  stopRequested: boolean; error: string | null; verificationOutcome: string | null;
  acceptedBy: string | null; attempts: Array<{ role: string; model: string;
    state: string; usage: TaskSnapshot["attempts"][number]["usage"] }>;
  reviewId: string | null;
  approvals: Array<TaskOperationApproval & { approvalSha256: string; canDecide: boolean }>;
  resultRevisionCount: number;
  requestedBy?: TaskRequestOrigin;
  resultNotificationError?: string;
}
interface Runtime {
  prepare: typeof prepareVaultRun;
  submit: typeof submitVaultRun;
  execute: typeof executeVaultRun;
  prepareRevision?: (config: VaultRunConfig, state: TaskSnapshot) => Promise<PreparedVaultRun>;
  inspectProvider?: InspectTaskProvider;
}

export class LocalTaskService {
  private configurationAdmission:ConfigurationAdmission=operation=>operation();
  bindConfigurationAdmission(admission:ConfigurationAdmission){this.configurationAdmission=admission;}
  private readonly admissionGuards=new Map<string,TaskAdmissionGuard>();
  bindAdmissionGuard(id:string,guard:TaskAdmissionGuard):void{this.registered(id);this.admissionGuards.set(id,guard)}
  private readonly startChecks = new Map<string, () => Promise<string | null>>();
  private readonly prepared = new Map<string, PreparedVaultRun>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly starts = new Map<string, Promise<TaskRunView>>();
  private pumping = false;
  private pumpAgain = false;
  private closing = false;
  private reviews: LocalReviewService | null = null;
  private knowledgeProofDirectory?: string;
  private readonly manifests = new Map<string, TaskReviewManifest>();
  private readonly reviewSyncs = new Map<string, Promise<void>>();
  private readonly manifestLoads = new Map<string, Promise<TaskReviewManifest | null>>();
  private readonly revisions = new Map<string, { fingerprint: string; promise: Promise<TaskRunView> }>();
  private readonly approvals = new Map<string, Map<string, { approval: TaskOperationApproval;
    decide: (allow: boolean, approvalRef: string, at: string, requestId: string) => Promise<void> }>>();
  private resultListener: ((results: TaskResultSummary[]) => void) | null = null;
  private detachReviewResults: (()=>void) | null = null;
  private readonly settlements = new Set<Promise<void>>();
  private resultRecovery:Promise<void>|null=null;
  private constructor(private readonly root: string, private readonly runs: CatalogRun[],
    private readonly scheduler: FileScheduler, private readonly runtime: Runtime,
    private readonly operationProofs: HumanReviewProofStore, private readonly resultStore: TaskResultStore,
    private readonly reconciliation: LocalTaskReconciliation) {
    resultStore.subscribe(results => this.resultListener?.(results.filter(n =>
      runs.some(run => run.config.runId === n.runId && run.configSha256 === n.configSha256))));
  }

  static async open(raw: unknown, runtime: Runtime = { prepare: prepareVaultRun,
    submit: submitVaultRun, execute: executeVaultRun }): Promise<LocalTaskService> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Task catalog invalid");
    const row = raw as Record<string, unknown>;
    const capacity = row.capacity === undefined ? undefined : parseSchedulerCapacity(row.capacity);
    if (typeof row.stateRoot !== "string" || !Array.isArray(row.runs) ||
        row.runs.length > 100) throw new Error("Task catalog roots/runs invalid");
    const root = await localDestination(row.stateRoot, true);
    const runs: CatalogRun[] = [];
    let schedulerPath: string | null = row.schedulerPath === undefined ? null :
      await localDestination(String(row.schedulerPath), false);
    for (const entry of row.runs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Task catalog run invalid");
      const item = entry as Record<string, unknown>;
      if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 200) throw new Error("Task title invalid");
      const config = await canonicalVaultRunRegistration(parseVaultRunConfig(item.config));
      await assertVaultRunOutputPaths(config);
      if (schedulerPath && schedulerPath.toLowerCase() !== config.schedulerPath.toLowerCase())
        throw new Error("All catalog runs must share one scheduler");
      schedulerPath = config.schedulerPath;
      if (inside(config.checkout, root) || inside(config.vault, root)) throw new Error("Task state must be outside checkout and Vault");
      const snapshot = await readJson(config.snapshot);
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Task snapshot invalid");
      const contract = snapshot as Record<string, unknown>;
      if (contract.schemaVersion !== "negi-task-contract/1" || typeof contract.objective !== "string" ||
          typeof contract.project !== "string" || typeof contract.vaultId !== "string" ||
          !Number.isSafeInteger(contract.version) || typeof contract.baseSha !== "string" ||
          !Array.isArray(contract.acceptance) || !Array.isArray(contract.verification)) throw new Error("Task snapshot metadata invalid");
      const snapshotSha256 = hash(await readFile(config.snapshot));
      runs.push({ title: item.title, config, contract, snapshotSha256,
        configSha256: hash(JSON.stringify({ config, snapshotSha256 })) });
    }
    if (new Set(runs.map((run) => run.config.runId)).size !== runs.length) throw new Error("Task run IDs repeated");
    for (const run of runs) for (const other of runs) {
      if (inside(other.config.checkout, run.config.outputDir) || inside(other.config.checkout, run.config.schedulerPath) ||
          inside(other.config.checkout, run.config.snapshot) || inside(other.config.checkout, root) ||
          inside(other.config.vault, run.config.outputDir) || inside(other.config.vault, run.config.schedulerPath) ||
          (run !== other && (inside(run.config.outputDir, other.config.outputDir) || inside(other.config.outputDir, run.config.outputDir))))
        throw new Error("Task catalog state must be outside every checkout and Vault, with distinct run outputs");
    }
    if (!schedulerPath) throw new Error("Task catalog requires a shared scheduler path");
    await mkdir(root, { recursive: true });
    const operationProofs = await HumanReviewProofStore.open(join(root, "operation-proofs"));
    const scheduler = new FileScheduler(schedulerPath!);
    await scheduler.ensureSubscriptionConfiguration(capacity);
    const results = await TaskResultStore.open(join(root, "task-results"));
    const reconciliation=await LocalTaskReconciliation.open(join(root,"reconciliation-proofs"),runtime.inspectProvider);
    return new LocalTaskService(root, runs, scheduler, runtime, operationProofs, results,reconciliation);
  }
  list(): Array<{ id: string; title: string }> { return this.runs.map((run) => ({ id: run.config.runId, title: run.title })); }
  async requestOrigin(id: string): Promise<TaskRequestOrigin | null> {
    const request = await this.request(this.registered(id));
    return request?.requestedBy ? checkedOrigin(request.requestedBy) : null;
  }
  originEvidence(origin: MasterOrigin) {
    return readMasterTurnOrigin(join(this.root, "master-turns"), this.scheduler, origin);
  }
  subscribeResults(listener: (results: TaskResultSummary[]) => void): void { this.resultListener = listener; }
  async resultNotifications(): Promise<TaskResultSummary[]> {
    await this.recoverResultNotifications();
    return (await this.resultStore.list()).filter(n => this.runs.some(run =>
      run.config.runId === n.runId && run.configSha256 === n.configSha256)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async resultSource(id: string) {
    const run = this.registered(id), request = await this.request(run), view = await this.snapshot(id);
    if (!request || view.live || ["not_started", "queued", "planning", "ready_for_worker", "working", "verifying"].includes(view.status)) return null;
    const ledger = (await this.ledger(run).read()).state;
    const entry = (await this.scheduler.read()).state?.entries.find(e => e.work.id === id) ?? null;
    const core = { runId: view.id, title: view.title.replace(/[\r\n\0]/g, " "), project: view.project,
      taskId: view.taskId, version: view.version, configSha256: view.configSha256,
      status: view.status, verificationOutcome: view.verificationOutcome, acceptedBy: view.acceptedBy,
      reviewId: view.reviewId, reason: view.error ? "詳細な状態をTask画面で確認してください。" : null, origin: request.requestedBy ?? { kind: "browser" as const } };
    return { core, sourceSha256: hash(JSON.stringify({ core, requestId: request.requestId, ledger, entry })),
      facts:{resultRevision:view.resultRevisionCount,artifactSha256:this.manifests.get(id)?.review.verifiedArtifactSha256??null} };
  }
  private async publishResult(id: string): Promise<void> {
    return this.withResultSource(()=>this.publishResultOnce(id));
  }
  private withResultSource<T>(operation:()=>Promise<T>):Promise<T> {
    return this.reviews ? this.reviews.withResultSource(operation) : operation();
  }
  private async publishResultOnce(id: string): Promise<void> {
    for(let attempt=0;attempt<2;attempt++){
      const source = await this.resultSource(id); if (!source) return;
      const notice: TaskResultNotice = { ...source.core, sourceSha256: source.sourceSha256,
        id: hash("negi-task-result/1\n" + id + "\n" + source.core.configSha256), createdAt: new Date().toISOString() };
      try{await this.resultStore.publish(notice,source.facts,async()=>{
        const fresh=await this.resultSource(id);return Boolean(fresh&&fresh.sourceSha256===source.sourceSha256&&
          JSON.stringify(fresh.facts)===JSON.stringify(source.facts));
      });return}catch(error){if(!(error instanceof TaskResultSourceChangedError)||attempt===1)throw error}
    }
  }
  /** Restores notices from durable Task facts; never resumes a model or Task. */
  async recoverResultNotifications(): Promise<void> {
    if(this.resultRecovery)return this.resultRecovery;
    const operation=this.recoverResultNotificationsOnce();this.resultRecovery=operation;
    try{await operation}finally{this.resultRecovery=null}
  }
  private async recoverResultNotificationsOnce():Promise<void>{
    const failures: unknown[] = [];
    for (const run of this.runs) try { await this.publishResult(run.config.runId); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Task result recovery requires inspection");
  }
  async prepareResultContext(masterId: string, threadId: string, input: string): Promise<TaskResultContext | null> {
    // Refresh originating runs before selecting a version. This repairs a saved
    // review/revision whose notification append was interrupted, without a turn.
    for(const run of this.runs){const origin=(await this.request(run))?.requestedBy;
      if(origin?.kind==="master"&&origin.masterId===masterId&&origin.threadId===threadId)await this.publishResult(run.config.runId);
    }
    return this.resultStore.prepareContext(masterId, threadId, input, async notice => {
      if (!this.runs.some(run => run.config.runId === notice.runId && run.configSha256 === notice.configSha256)) return false;
      const source = await this.resultSource(notice.runId);
      return Boolean(source && source.sourceSha256 === notice.sourceSha256 && source.core.configSha256 === notice.configSha256);
    },operation=>this.withResultSource(operation));
  }
  async capacitySnapshot() {
    const state = (await this.scheduler.read()).state;
    if (!state || !state.roleLimits) throw new Error("Task role capacity not configured");
    const usage = schedulerCapacityUsage(state);
    return { maxConcurrent: state.maxConcurrent, ...state.roleLimits, usage,
      draining: usage.global > state.maxConcurrent || usage.planners > state.roleLimits.planners || usage.workers > state.roleLimits.workers };
  }
  /** A resident planner uses the exact scheduler and a server-owned evidence directory. */
  masterTurnAdmission(masterId: string): MasterTurnAdmission {
    const admission=scheduledMasterTurns({ root: join(this.root, "master-turns"), masterId,
      scheduler: this.scheduler, onReleased: () => this.pump() });
    const conversations = this.masterConversationAuthority(masterId);
    // Startup is a read-only audit. The reset writer requires its inventory/recovery
    // gates before it can be used by normal dispatch; do not create crash locks here.
    return guardMasterAdmission({ reserve: request => this.configurationAdmission(() => admission.reserve(request)),
      assertIdle: cwd => conversations.assertStartupSafe(cwd) }, () => conversations.assertStorageCompatible());
  }
  /** Shared server-owned exclusion and signed empty-thread journal. No provider/UI dispatch here. */
  masterConversationAuthority(masterId: string): MasterConversationAuthority {
    return new MasterConversationAuthority({ root: join(this.root, "master-conversations"),
      turnRoot: join(this.root, "master-turns"), masterId, scheduler: this.scheduler,onReleased:()=>this.pump() });
  }
  /** Fixed catalog metadata for the planner. Does not disclose local paths or run commands. */
  dispatchCatalog(): Array<{ id: string; title: string; project: string; taskId: string; version: number; configSha256: string }> {
    return this.runs.map(run => ({ id: run.config.runId, title: run.title, project: String(run.contract.project),
      taskId: String(run.contract.vaultId), version: Number(run.contract.version), configSha256: run.configSha256 }));
  }
  /** Complete pinned Task Contract; provider launch and verification commands stay server-owned. */
  dispatchContract(id: string): Record<string, unknown> { return structuredClone(this.registered(id).contract); }
  /** Server-owned admission conditions; model/HTTP callers cannot supply or replace them. */
  bindStartCheck(id: string, check: () => Promise<string | null>): void {
    this.registered(id); this.startChecks.set(id, check);
  }
  /** Trusted server authoring configuration only. Never exposed as an HTTP/model tool. */
  authoringTemplate(id: string): { config: VaultRunConfig; contract: Record<string, unknown> } {
    const run = this.registered(id);
    return { config: structuredClone(run.config), contract: structuredClone(run.contract) };
  }
  /** Trusted startup profile, without inventing an active Task Contract. */
  async validateAuthoringConfiguration(raw: unknown): Promise<VaultRunConfig> {
    const config = parseVaultRunConfig(raw);
    if (config.approvedPlan) throw new Error("Authoring configuration cannot grant a Task approval");
    config.checkout = await realpath(config.checkout); config.vault = await realpath(config.vault);
    config.executable = await realpath(config.executable);
    config.schedulerPath = await localDestination(config.schedulerPath, false);
    if (config.schedulerPath.toLowerCase() !== this.scheduler.path.toLowerCase()) throw new Error("Authoring profile must share the scheduler");
    for (const writable of [config.checkout,config.vault,...this.knowledgeRegistrations().flatMap(r=>[r.checkout,r.vault])])
      for (const target of [this.root,config.schedulerPath,config.snapshot,config.outputDir])
        if (inside(writable,target) || inside(target,writable)) throw new Error("Authoring evidence overlaps writable source roots");
    await assertVaultRunOutputPaths(config); return config;
  }
  /** Recovered signed authoring outputs join the same catalog and scheduler. No dispatch. */
  async registerAuthoredRun(title: string, raw: VaultRunConfig): Promise<void> {
    if (this.closing || !title.trim() || title.length > 200 || !raw.approvedPlan) throw new Error("Authored Task registration invalid");
    const config = parseVaultRunConfig(raw);
    config.checkout = await realpath(config.checkout); config.vault = await realpath(config.vault);
    config.outputDir = await localDestination(config.outputDir, true);
    config.schedulerPath = await localDestination(config.schedulerPath, false);
    if (config.schedulerPath.toLowerCase() !== this.scheduler.path.toLowerCase())
      throw new Error("Authored Task must use the shared scheduler");
    // A recovered result may already have a dirty checkout or changed Vault.
    // Registration restores visibility only; normal start/review preflight checks freshness.
    const contract = await readJson(config.snapshot) as import("./vaultTaskContract.ts").VaultTaskContract;
    if (!contract || contract.schemaVersion !== "negi-task-contract/1") throw new Error("Authored Task snapshot invalid");
    const { loadApprovedTaskPlan } = await import("./approvedTaskPlan.ts");
    await loadApprovedTaskPlan(config, contract);
    assertVerificationCoverage(contract.verification, config.verification);
    await assertVaultRunOutputPaths(config);
    const snapshotSha256 = hash(await readFile(config.snapshot));
    const candidate: CatalogRun = { title, config, snapshotSha256, contract: contract as unknown as Record<string, unknown>,
      configSha256: hash(JSON.stringify({ config, snapshotSha256 })) };
    const existing = this.runs.find(run => run.config.runId === config.runId);
    if (existing) {
      if (existing.configSha256 !== candidate.configSha256 || existing.title !== title)
        throw new Error("Authored Task registration conflicts with current catalog");
      return;
    }
    if (this.runs.length >= 100) throw new Error("Task catalog limit reached");
    for (const run of [...this.runs, candidate]) {
      for (const target of [this.root, config.snapshot, config.outputDir, config.schedulerPath, config.approvedPlan!.proofDirectory])
        if (inside(run.config.checkout, target) || inside(run.config.vault, target)) throw new Error("Authored Task storage overlaps a writable root");
      for (const target of [run.config.outputDir, run.config.snapshot, run.config.schedulerPath, this.root])
        if (inside(config.checkout, target) || inside(config.vault, target)) throw new Error("New Task root overlaps catalog evidence");
      if (run !== candidate && (inside(run.config.outputDir, config.outputDir) || inside(config.outputDir, run.config.outputDir)))
        throw new Error("Authored Task output must be distinct");
    }
    await this.reviews?.registerWritableRoots([config.checkout]);
    // Re-check after asynchronous validation: concurrent registration cannot duplicate an ID.
    if (this.runs.some(run => run.config.runId === config.runId)) throw new Error("Concurrent Task registration; inspect current catalog");
    this.runs.push(candidate);
  }
  /** Server configuration only; neither paths nor scope are supplied by HTTP. */
  knowledgeRegistrations(): Array<{ vault: string; project: string; checkout: string }> {
    return this.runs.map((run) => ({ vault: run.config.vault,
      project: String(run.contract.project), checkout: run.config.checkout }));
  }
  connectKnowledge(proofDirectory: string): void {
    if (this.knowledgeProofDirectory && this.knowledgeProofDirectory !== proofDirectory)
      throw new Error("Knowledge authority cannot change during a server session");
    this.knowledgeProofDirectory = proofDirectory;
  }
  async knowledgeSource(id: string): Promise<{ vault: string; project: string; taskClass: string;
    sourceNotes: Array<{ id: string; version: number; sha256: string; path: string }> }> {
    const run = this.registered(id);
    if (hash(await readFile(run.config.snapshot)) !== run.snapshotSha256)
      throw new Error("Knowledge source Task snapshot changed");
    return { vault: run.config.vault, project: String(run.contract.project),
      taskClass: typeof run.contract.taskClass === "string" ? run.contract.taskClass : "unclassified",
      sourceNotes: structuredClone(run.contract.sourceNotes) as Array<{ id: string; version: number; sha256: string; path: string }> };
  }
  /** Trusted readers for local integration; no provider dispatch or acceptance. */
  async integrationSource(id: string, preflight = true): Promise<IntegrationSource> {
    const run = this.registered(id);
    const readState = async () => {
      const manifest = await this.ensureReview(run);
      if (!manifest || !this.reviews) throw new Error("Integration requires a registered review result");
      const review = await this.reviews.snapshot(manifest.review.id,{includeRelations:false});
      if (review.integrityError || review.status === "revoked") throw new Error("Integration source review requires correction or reconciliation");
      await verifyTaskReviewCheckout(run.config, manifest);
      const state = (await this.ledger(run).read()).state;
      if (!state) throw new Error("Integration source Task state unavailable");
      return state;
    };
    if (preflight) await readState();
    return { config: structuredClone(run.config), configSha256: run.configSha256, readState,
      readManifest: async () => { await readState(); return structuredClone((await this.ensureReview(run))!); } };
  }
  async connectReviews(service: LocalReviewService): Promise<void> {
    await service.registerWritableRoots(this.runs.map((run) => run.config.checkout));
    this.reviews = service;
    for (const run of this.runs) await this.ensureReview(run);
    this.detachReviewResults?.();
    this.detachReviewResults=service.subscribeResultChanges(async caseId=>{
      for(const [id,manifest] of this.manifests)if(manifest.review.id===caseId)await this.publishResult(id);
    });
  }
  private async ensureReview(run: CatalogRun): Promise<TaskReviewManifest | null> {
    if(!this.reviews)return null;
    const cached=this.manifests.get(run.config.runId);if(cached)return cached;
    if(!await readJson(join(run.config.outputDir,"review-manifest.json"))&&
      !await readJson(join(run.config.outputDir,"review-current.json")))return null;
    return this.withResultSource(()=>this.ensureReviewLocked(run));
  }
  private async ensureReviewLocked(run: CatalogRun): Promise<TaskReviewManifest | null> {
    const pending = this.manifestLoads.get(run.config.runId);
    if (pending) return pending;
    const operation = this.ensureReviewOnce(run);
    this.manifestLoads.set(run.config.runId, operation);
    try { return await operation; } finally { this.manifestLoads.delete(run.config.runId); }
  }
  private async ensureReviewOnce(run: CatalogRun): Promise<TaskReviewManifest | null> {
    if (!this.reviews) return null;
    if (this.manifests.has(run.config.runId)) return this.manifests.get(run.config.runId)!;
    const pointer = await readJson(join(run.config.outputDir, "review-current.json")) as
      { schema?: string; number?: number; revisionRef?: string } | null;
    if (pointer) {
      if (pointer.schema !== "negi-task-review-current/1" || !Number.isSafeInteger(pointer.number))
        throw new Error("Task revision pointer invalid");
      let pinned = await readTaskRevision(run.config, run.configSha256, pointer.number!);
      if (pointer.revisionRef !== pinned.revisionRef) throw new Error("Task revision pointer hash changed");
      if (pointer.number! < 99 && await readJson(join(run.config.outputDir, `revision-${pointer.number! + 1}.json`))) {
        pinned = await readTaskRevision(run.config, run.configSha256, pointer.number! + 1);
        await writeTaskRevisionPointer(run.config, pinned);
      }
      return this.adoptRevision(run, pinned);
    }
    const raw = await readJson(join(run.config.outputDir, "review-manifest.json"));
    if (!raw) return null;
    const manifest = raw as TaskReviewManifest;
    const output = run.config.outputDir;
    if (manifest.schema !== "negi-task-review/1" || manifest.runId !== run.config.runId ||
        manifest.configSha256 !== run.configSha256 || manifest.baseSha !== run.contract.baseSha ||
        manifest.review?.id !== `task-${hash(run.config.runId).slice(0, 24)}` ||
        resolve(manifest.review.artifactRoot) !== resolve(output) || resolve(manifest.review.ledgerPath) !== join(output, "review.jsonl") ||
        resolve(manifest.review.evidencePath) !== join(output, "verification.json") || !Array.isArray(manifest.files) ||
        !manifest.files.every((file) => typeof file.path === "string" && !file.path.includes("\\") &&
          !file.path.split("/").some((part) => !part || part === ".." || part === ".")))
      throw new Error("Task review manifest does not match its registered output");
    // A durable journal may precede the atomic pointer when the process stops.
    // Recover only that next local revision, without repeating its checks or model turn.
    const next = (manifest.revision ?? 0) + 1;
    if (await readJson(join(output, `revision-${next}.json`))) {
      const pinned = await readTaskRevision(run.config, run.configSha256, next);
      await writeTaskRevisionPointer(run.config, pinned);
      return this.adoptRevision(run, pinned);
    }
    await this.reviews.registerCase(manifest.review);
    this.manifests.set(run.config.runId, manifest);
    this.bindReviewCheck(run, manifest);
    return manifest;
  }
  private bindReviewCheck(run: CatalogRun, manifest: TaskReviewManifest): void {
    this.reviews!.bindCurrentCheck(manifest.review.id, async () => {
      await verifyTaskReviewCheckout(run.config, manifest);
      const state = (await this.ledger(run).read()).state;
      if (state?.verification?.evidenceRef !== `${manifest.review.evidencePath}#sha256=${manifest.review.evidenceSha256}`)
        throw new Error("Task revision metadata is not yet recorded");
      const scheduled = (await this.scheduler.read()).state?.entries.find((entry) => entry.work.id === run.config.runId);
      if (scheduled?.status !== "verified" || scheduled.evidenceRef !== state.verification.evidenceRef)
        throw new Error("Task execution/revision requires scheduler reconciliation before acceptance");
    });
  }
  private ledger(run: CatalogRun): FileTaskLedger {
    return new FileTaskLedger(join(run.config.outputDir, "run.jsonl"), Date.now,
      this.reconciliation.verifier(run),
      ({ event, state }) => this.verifyHumanDecision(run, event, state),
      ({ event, state }) => this.verifyOperationDecision(run, event, state),
      ({ event, state }) => this.verifyResultRevision(run, event, state));
  }
  private reconciliationSource(run:CatalogRun){
    return {config:run.config,configSha256:run.configSha256,snapshotSha256:run.snapshotSha256,
      ledger:this.ledger(run),scheduler:this.scheduler,isActive:()=>this.active.has(run.config.runId)||this.closing};
  }
  async inspectReconciliation(id:string,configSha256:string,requestId:string):Promise<TaskReconciliationView>{
    const run=this.registered(id);if(configSha256!==run.configSha256)throw Error("Task reconciliation target changed");
    return this.reconciliation.inspect(this.reconciliationSource(run),requestId);
  }
  async closeReconciliation(id:string,configSha256:string,requestId:string,inspectionId:string,dossierSha256:string):Promise<TaskRunView>{
    return this.withResultSource(()=>this.closeReconciliationLocked(id,configSha256,requestId,inspectionId,dossierSha256));
  }
  private async closeReconciliationLocked(id:string,configSha256:string,requestId:string,inspectionId:string,dossierSha256:string):Promise<TaskRunView>{
    const run=this.registered(id);if(configSha256!==run.configSha256)throw Error("Task reconciliation target changed");
    await this.reconciliation.close(this.reconciliationSource(run),requestId,inspectionId,dossierSha256);
    try{await this.publishResult(id)}catch{/* Task facts remain authoritative; notification revision is separate. */}
    void this.pump().catch(()=>{});return this.snapshot(id);
  }
  private async verifyResultRevision(run: CatalogRun, event: TaskEvent, state: TaskSnapshot): Promise<boolean> {
    if (!this.reviews || event.action.type !== "reverify_result") return false;
    const match = event.action.revisionRef.match(/^local:task-revision:([1-9][0-9]?):sha256=([0-9a-f]{64})$/i);
    if (!match) return false;
    const pinned = await readTaskRevision(run.config, run.configSha256, Number(match[1]));
    const j = pinned.journal;
    const review = await this.reviews.readState(pinned.manifest.review.id);
    return revisionMatchesTask(pinned, state) && pinned.revisionRef === event.action.revisionRef &&
      event.action.fromEvidenceRef === j.fromEvidenceRef && event.action.evidenceRef === j.evidenceRef &&
      event.key === `task-revision:${j.number}` && event.at === j.at && review.revisions.some((revision) =>
        revision.fromSha256 === j.fromArtifactSha256 && revision.toSha256 === j.artifactSha256 &&
        revision.sameObjective && JSON.stringify(revision.feedbackIds) === JSON.stringify(j.feedbackIds));
  }
  private async adoptRevision(run: CatalogRun, pinned: PinnedTaskRevision): Promise<TaskReviewManifest> {
    if (!this.reviews) throw new Error("Task revision requires the review service");
    const schedule = (await this.scheduler.read()).state;
    const scheduled = schedule?.entries.find((entry) => entry.work.id === run.config.runId);
    const validation = schedule?.entries.find((entry) => entry.work.id === pinned.journal.validationWorkId);
    if (!scheduled || !["failed", "verified"].includes(scheduled.status) ||
        !validation || !["running", "verified"].includes(validation.status) ||
        validation.work.parentId !== run.config.runId || validation.work.checkout !== run.config.checkout)
      throw new Error("Task revision requires a terminal provider outcome and its own local validation lease");
    await replayRevisionReview(pinned, (item) => this.reviews!.readCandidateState(item));
    await this.reviews.registerRevision(pinned.journal.fromArtifactSha256, pinned.manifest.review);
    this.bindReviewCheck(run, pinned.manifest);
    const ledger = this.ledger(run);
    const state = (await ledger.read()).state;
    if (!state || !revisionMatchesTask(pinned, state)) throw new Error("Task revision no longer matches its fixed contract");
    if (state.verification?.evidenceRef === pinned.journal.fromEvidenceRef) {
      // Only local metadata is replayed. No checkout write or model turn is repeated.
      await verifyTaskReviewCheckout(run.config, pinned.manifest);
      await ledger.append({ key: `task-revision:${pinned.journal.number}`, at: pinned.journal.at,
        action: { type: "reverify_result", fromEvidenceRef: pinned.journal.fromEvidenceRef,
          evidenceRef: pinned.journal.evidenceRef, revisionRef: pinned.revisionRef } });
    } else if (state.verification?.evidenceRef !== pinned.journal.evidenceRef)
      throw new Error("Task evidence differs from both revision checkpoints");
    if (scheduled.status !== "verified" || scheduled.evidenceRef !== pinned.journal.evidenceRef)
      await this.scheduler.append({ key: `task-revision:${pinned.journal.number}:revalidate`, at: pinned.journal.at,
        action: { type: "revalidate", workId: run.config.runId, evidenceRef: pinned.journal.evidenceRef,
          ...(validation.status === "running" ? { validationWorkId: pinned.journal.validationWorkId } : {}) } });
    if (validation.status === "running") await this.scheduler.append({ key: `task-revision:${pinned.journal.number}:local-settle`,
      at: pinned.journal.at, action: { type: "settle", workId: pinned.journal.validationWorkId,
        outcome: "verified", evidenceRef: pinned.journal.evidenceRef, actualCostUsd: null } });
    this.manifests.set(run.config.runId, pinned.manifest);
    return pinned.manifest;
  }
  /** Register a locally applied correction. No browser-provided edits or model dispatch. */
  async registerResultRevision(id: string, configSha256: string, feedbackIds: string[]): Promise<TaskRunView> {
    const run = this.registered(id);
    if (!this.reviews || this.closing || configSha256 !== run.configSha256 || this.active.has(id) ||
        !Array.isArray(feedbackIds) || !feedbackIds.length || feedbackIds.length > 20 ||
        new Set(feedbackIds).size !== feedbackIds.length || !feedbackIds.every((value) => typeof value === "string" && value.length < 200))
      throw new Error("Task revision request invalid");
    const ids = [...feedbackIds].sort(), fingerprint = hash(JSON.stringify({ configSha256, ids }));
    const pending = this.revisions.get(id);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error("Another Task revision is in progress");
      return pending.promise;
    }
    const operation = (async()=>{const view=await this.registerResultRevisionOnce(run, ids);
      try{await this.publishResult(id);return view}catch{return{...view,resultNotificationError:
        "修正版は保存済みです。Taskの通知を更新できません。再読み込みして現在の状態を確認してください。"}}})();
    this.revisions.set(id, { fingerprint, promise: operation });
    try { return await operation; } finally { this.revisions.delete(id); }
  }
  private async registerResultRevisionOnce(run: CatalogRun, feedbackIds: string[]): Promise<TaskRunView> {
    const {previous,state,reviewStateSha256}=await this.withResultSource(async()=>{
    const previous = await this.ensureReview(run);
    const state = (await this.ledger(run).read()).state;
    if (!previous || !state || state.status !== "ready_for_review" || state.acceptedBy !== null ||
        state.stopReason?.startsWith("Human acceptance revoked:")) throw new Error("Task revision requires an unaccepted verified result");
    const review = await this.reviews!.snapshot(previous.review.id,{includeRelations:false});
    if (review.status !== "awaiting_review" || !feedbackIds.every((id) => review.feedback.some((item) =>
      item.id === id && item.kind === "correction" && item.targetSha256 === previous.review.verifiedArtifactSha256 &&
      (item.authenticated || (item.source === "agent" && item.text !== null)))))
      throw new Error("Task revision requires authenticated or pinned agent corrections targeting the current artifact");
    const outstanding=review.feedback.filter(item=>item.kind==="correction"&&item.targetSha256===previous.review.verifiedArtifactSha256);
    if(outstanding.some(item=>!feedbackIds.includes(item.id)))throw Error("Task revision must address every current correction");
    if(review.feedback.some(item=>item.kind==="new_requirement"&&item.scope==="current_task"&&
      item.targetSha256===previous.review.verifiedArtifactSha256))throw Error("New Task requirements need a new fixed contract");
    const reviewStateSha256=hash(JSON.stringify(await this.reviews!.readState(previous.review.id)));
    return{previous,state,reviewStateSha256};
    });
    let changed = false;
    try { await verifyTaskReviewCheckout(run.config, previous); } catch { changed = true; }
    if (!changed) throw new Error("Task result has not changed; do not repeat verification");
    if (hash(await readFile(run.config.snapshot)) !== run.snapshotSha256) throw new Error("Task snapshot changed before revision");
    const prepared = this.runtime.prepareRevision ? await this.runtime.prepareRevision(run.config, state) : {
      config: run.config, contract: await loadVaultTaskContract(run.config.vault, run.config.snapshot, run.config.checkout,
        undefined, { baseSha: state.contract.baseSha, sha256: state.contract.sha256 }) };
    if (prepared.contract.sha256 !== state.contract.sha256 || prepared.contract.version !== state.contract.version ||
        prepared.contract.baseSha !== state.contract.baseSha) throw new Error("Task revision changed its fixed contract");
    assertVerificationCoverage(prepared.contract.verification, run.config.verification);
    await assertVaultRunOutputPaths(run.config);
    const number = (previous.revision ?? 0) + 1;
    if (number > 99) throw new Error("Task revision limit reached");
    const schedule = (await this.scheduler.read()).state;
    const parent = schedule?.entries.find((entry) => entry.work.id === run.config.runId);
    if (!parent || !["verified", "failed"].includes(parent.status)) throw new Error("Task revision provider outcome is not terminal");
    const validationWorkId = `${run.config.runId}:local-revision-${number}`;
    await this.scheduler.append({ key: `${validationWorkId}:submit`, at: new Date().toISOString(),
      action: { type: "submit", work: { ...parent.work, execution: "direct", id: validationWorkId, parentId: run.config.runId, dependencies: [] } } });
    try { await this.scheduler.claim(validationWorkId, `${validationWorkId}:local-dispatch`); }
    catch (error) {
      await this.scheduler.append({ key: `${validationWorkId}:cancel-before-checks`, at: new Date().toISOString(), action: {
        type: "cancel_queued", workId: validationWorkId, reason: "Local validation could not acquire the shared execution slot" } });
      throw error;
    }
    try {
    const checkoutBeforeChecks=await taskReviewCheckoutFingerprint(run.config);
    const verification = await verifyVaultRun(prepared, undefined, `verification-r${number}.json`);
    if (verification.outcome !== "passed") {
      await this.scheduler.append({ key: `${validationWorkId}:failed`, at: new Date().toISOString(), action: {
        type: "settle", workId: validationWorkId, outcome: "failed", evidenceRef: verification.evidenceRef, actualCostUsd: null } });
      throw new Error("Task revision verification failed; preserve and inspect its evidence");
    }
    return await this.withResultSource(async()=>{
    const current=(await this.ledger(run).read()).state, currentReview=await this.reviews!.snapshot(previous.review.id,{includeRelations:false});
    if(JSON.stringify(current)!==JSON.stringify(state)||currentReview.status!=="awaiting_review"||
      currentReview.artifactSha256!==previous.review.verifiedArtifactSha256||
      hash(JSON.stringify(await this.reviews!.readState(previous.review.id)))!==reviewStateSha256||
      await taskReviewCheckoutFingerprint(run.config)!==checkoutBeforeChecks){
      await this.scheduler.append({key:`${validationWorkId}:source-changed`,at:new Date().toISOString(),action:{
        type:"settle",workId:validationWorkId,outcome:"failed",evidenceRef:verification.evidenceRef,actualCostUsd:null}});
      throw Error("Task result or review changed during revision verification; no revision was adopted");
    }
    const revised = structuredClone(state); revised.verification = verification;
    const manifest = await captureTaskReview(run.config, run.configSha256, run.title, revised, { revision: number, deferLedger: true });
    if(await taskReviewCheckoutFingerprint(run.config)!==checkoutBeforeChecks)throw Error("Task checkout changed during revision capture; inspect partial evidence");
    const journal: TaskRevisionJournal = { schema: "negi-task-revision/1", number, runId: run.config.runId,
      configSha256: run.configSha256, contractSha256: state.contract.sha256, contractVersion: state.contract.version,
      baseSha: state.contract.baseSha, fromManifestSha256: taskRevisionHash(await readFile(join(run.config.outputDir, taskManifestName(number - 1)))),
      manifestSha256: taskRevisionHash(await readFile(join(run.config.outputDir, taskManifestName(number)))),
      fromArtifactSha256: previous.review.verifiedArtifactSha256, artifactSha256: manifest.review.verifiedArtifactSha256,
      objectiveId: `${state.contract.vaultId}@${state.contract.version}:${state.contract.sha256}`,
      feedbackIds, fromEvidenceRef: state.verification!.evidenceRef, evidenceRef: verification.evidenceRef,
      at: new Date().toISOString(), modelTurnStarted: false, validationWorkId };
    await writeNew(join(run.config.outputDir, `revision-${number}.json`), journal);
    const pinned = await readTaskRevision(run.config, run.configSha256, number);
    await writeTaskRevisionPointer(run.config, pinned);
    this.manifests.delete(run.config.runId);
    await this.ensureReview(run);
    return this.snapshot(run.config.runId);
    });
    } catch (error) {
      // A complete journal can be replayed on reload. Earlier failures keep the
      // lease reserved for inspection, since partially saved evidence is uncertain.
      let durable = false;
      try { await readTaskRevision(run.config, run.configSha256, number); durable = true; } catch { /* incomplete */ }
      const child = (await this.scheduler.read()).state?.entries.find((entry) => entry.work.id === validationWorkId);
      if (!durable && child?.status === "running") await this.scheduler.append({
        key: `${validationWorkId}:unknown`, at: new Date().toISOString(), action: {
          type: "unknown", workId: validationWorkId,
          reason: "Local revision stopped before its durable journal; preserve evidence and reconcile manually" } });
      this.manifests.delete(run.config.runId);
      throw error;
    }
  }
  private async verifyOperationDecision(run: CatalogRun, event: TaskEvent, state: TaskSnapshot): Promise<boolean> {
    if (event.action.type !== "decide_approval") return false;
    const action = event.action, id = action.approvalRef?.match(/^user:task-operation:([0-9a-f-]{36})$/i)?.[1];
    if (!id) return false;
    const receipt = await this.operationProofs.read(id);
    const approval = state.approvals.find((item) => item.id === action.approvalId);
    if (!approval) return false;
    const { decision: _decision, ...scope } = approval;
    return Boolean(receipt && receipt.action === "operation" && receipt.caseId === run.config.runId &&
      receipt.runId === state.runId && receipt.at === event.at && receipt.artifactSha256 === hash(JSON.stringify(scope)) &&
      receipt.data.configSha256 === run.configSha256 && receipt.data.approvalId === action.approvalId &&
      receipt.data.attemptId === action.attemptId && receipt.data.threadId === action.threadId &&
      receipt.data.turnId === action.turnId && receipt.data.operation === action.operation &&
      receipt.data.target === action.target && receipt.data.decision === action.decision &&
      event.key === `task-operation:${receipt.id}`);
  }
  private async verifyHumanDecision(run: CatalogRun, event: TaskEvent, state: TaskSnapshot): Promise<boolean> {
    const manifest = this.manifests.get(run.config.runId);
    if (!this.reviews || !manifest ||
        (event.action.type !== "accept" && event.action.type !== "revoke_acceptance")) return false;
    const ref = event.action.type === "accept" ? event.action.reviewer : event.action.reasonRef;
    const receipt = await this.reviews.receipt(ref);
    const kind = event.action.type === "accept" ? "accept" : "revoke";
    return Boolean(receipt && receipt.action === kind && receipt.caseId === manifest.review.id &&
      receipt.runId === state.runId && state.runId === run.config.runId && receipt.at === event.at &&
      receipt.artifactSha256 === manifest.review.verifiedArtifactSha256 &&
      state.contract.sha256 === run.contract.sha256 && state.contract.version === run.contract.version &&
      state.contract.baseSha === manifest.baseSha && event.key === `task-human:${receipt.id}:${kind}` &&
      (kind === "revoke" || (receipt.data.evidenceSha256 === manifest.review.evidenceSha256 &&
        state.verification?.evidenceRef === `${manifest.review.evidencePath}#sha256=${manifest.review.evidenceSha256}`)));
  }
  private async syncReview(run: CatalogRun, manifest: TaskReviewManifest): Promise<void> {
    const review=await this.reviews!.readState(manifest.review.id),state=(await this.ledger(run).read()).state;
    if(state&&!((review.acceptance&&state.status==="ready_for_review"&&!state.stopReason?.startsWith("Human acceptance revoked:"))||
      (review.revoked&&state.status==="accepted")))return;
    return this.withResultSource(()=>this.syncReviewLocked(run,manifest));
  }
  private async syncReviewLocked(run: CatalogRun, manifest: TaskReviewManifest): Promise<void> {
    const pending = this.reviewSyncs.get(run.config.runId);
    if (pending) return pending;
    const operation = this.syncReviewOnce(run, manifest);
    this.reviewSyncs.set(run.config.runId, operation);
    try { await operation; } finally { this.reviewSyncs.delete(run.config.runId); }
  }
  private async syncReviewOnce(run: CatalogRun, manifest: TaskReviewManifest): Promise<void> {
    const review = await this.reviews!.readState(manifest.review.id);
    const ledger = this.ledger(run);
    let state = (await ledger.read()).state;
    if (!state) throw new Error("Task review has no corresponding execution ledger");
    if (review.acceptance && state.status === "ready_for_review" && !state.stopReason?.startsWith("Human acceptance revoked:")) {
      const ref = review.acceptance.approvalRef, receipt = await this.reviews!.receipt(ref);
      if (!receipt) throw new Error("Task acceptance proof unavailable");
      state = await ledger.append({ key: `task-human:${receipt.id}:accept`, at: receipt.at,
        action: { type: "accept", reviewer: ref } });
    }
    if (review.revoked && state.status === "accepted") {
      const ref = review.revoked.reasonRef, receipt = await this.reviews!.receipt(ref);
      if (!receipt) throw new Error("Task revocation proof unavailable");
      await ledger.append({ key: `task-human:${receipt.id}:revoke`, at: receipt.at,
        action: { type: "revoke_acceptance", reasonRef: ref } });
    }
  }
  private registered(id: string): CatalogRun {
    const run = this.runs.find((item) => item.config.runId === id);
    if (!run) throw new Error("Task run is not registered");
    return run;
  }
  private requestPath(id: string): string { return join(this.root, `${id}.request.json`); }
  private async request(run: CatalogRun): Promise<StartRequest | null> {
    const value = await readJson(this.requestPath(run.config.runId)) as StartRequest | null;
    if (value && (value.runId !== run.config.runId || value.configSha256 !== run.configSha256 ||
        !isReviewRequestId(value.requestId) || !Number.isFinite(Date.parse(value.at))))
      throw new Error("Stored Task request differs from the registered configuration");
    if (value?.requestedBy !== undefined) checkedOrigin(value!.requestedBy!);
    return value;
  }
  async snapshot(id: string): Promise<TaskRunView> {
    const run = this.registered(id);
    const request = await this.request(run);
    let state = (await this.ledger(run).read()).state;
    const entry = (await this.scheduler.read()).state?.entries.find((item) => item.work.id === id);
    const active = this.active.get(id);
    // A running/queued Task has no result adoption to perform. Its status read
    // must remain available while another accepted baseline holds the gate.
    const executing=Boolean(active||entry?.status==="queued");
    const manifest = executing ? this.manifests.get(id)??null : await this.ensureReview(run);
    if (manifest&&!executing) { await this.syncReview(run, manifest); state=(await this.ledger(run).read()).state; }
    const error = await readJson(join(this.root, `${id}.error.json`)) as { error?: string } | null;
    const interrupted = !active && entry && ["running", "needs_reconciliation"].includes(entry.status);
    let status = interrupted ? "needs_reconciliation" : state?.status ?? entry?.status ??
      (request ? error ? "preflight_failed" : "needs_reconciliation" : "not_started");
    let reviewError: string | null = null;
    if (manifest) {
      const review = await this.reviews!.snapshot(manifest.review.id,{includeRelations:false});
      if (review.status === "revoked") status = "review_revoked";
      if (review.integrityError) { status = review.qualityIssue ? "quality_issue" : "artifact_changed"; reviewError = review.integrityError; }
    } else if (state?.status === "ready_for_review" && this.reviews)
      reviewError = "Webレビュー用の固定差分を生成できませんでした。ローカルの成果と検証証拠を確認してください。";
    const scope = run.contract.scope as { allowedPaths?: string[]; out?: string[] } | undefined;
    let startError:string|null=null;
    if(!request&&!entry&&!state&&!this.closing)try{startError=await this.startChecks.get(id)?.()??null}
    catch{startError="開始条件を照合できません。契約案の状態を確認してください。"}
    return { id, title: run.title, configSha256: run.configSha256,
      project: run.contract.project as string, objective: run.contract.objective as string,
      taskId: run.contract.vaultId as string, version: run.contract.version as number,
      baseSha: run.contract.baseSha as string, checkout: run.config.checkout,
      acceptance: run.contract.acceptance as string[], allowedPaths: scope?.allowedPaths ?? [],
      outOfScope: scope?.out ?? [], invariants: run.contract.invariants as string[] ?? [],
      verification: run.contract.verification as string[], astra: run.config.astra, sol: run.config.sol,
      status, executionPhase: entry?.phase ?? null, canStart: !request && !entry && !state && !this.closing && !startError,
      canStop: Boolean(active || entry?.status === "queued"), live: Boolean(active),
      stopRequested: active?.controller.signal.aborted ?? false,
      error: error?.error ?? reviewError ?? state?.stopReason ?? entry?.reason ?? startError,
      verificationOutcome: state?.verification?.outcome ?? null, acceptedBy: state?.acceptedBy ?? null,
      attempts: state?.attempts.map((attempt) => ({ role: attempt.role,
        model: attempt.resolvedModel ?? attempt.requestedModel, state: attempt.state, usage: attempt.usage })) ?? [],
      reviewId: manifest?.review.id ?? null,
      resultRevisionCount: state?.resultRevisions?.length ?? 0,
      ...(request?.requestedBy ? { requestedBy: structuredClone(request.requestedBy) } : {}),
      approvals: (state?.approvals ?? []).filter((approval) => approval.decision === "pending").map((approval) => {
        const { decision: _decision, ...scope } = approval;
        return { ...scope, approvalSha256: hash(JSON.stringify(scope)),
          canDecide: Boolean(active && !active.controller.signal.aborted &&
            this.approvals.get(id)?.has(approval.id) && Date.now() < Date.parse(approval.expiresAt)) };
      }) };
  }
  async start(id: string, configSha256: string, requestId: string,
              requestedBy: TaskRequestOrigin = { kind: "browser" }): Promise<TaskRunView> {
    const run = this.registered(id);
    const origin = checkedOrigin(requestedBy);
    if (this.closing || configSha256 !== run.configSha256 || !isReviewRequestId(requestId)) throw new Error("Task request identity invalid");
    const existing = await this.request(run);
    if (existing) {
      if (existing.requestId !== requestId.toLowerCase() || (existing.requestedBy &&
          JSON.stringify(existing.requestedBy) !== JSON.stringify(origin))) throw new Error("Task was already requested; inspect the existing run");
      return this.snapshot(id);
    }
    if (this.starts.has(id)) { await this.starts.get(id); return this.start(id, configSha256, requestId, origin); }
    const operation = this.startNew(run, requestId.toLowerCase(), origin);
    this.starts.set(id, operation);
    try { return await operation; } finally { this.starts.delete(id); }
  }
  private async startNew(run: CatalogRun, requestId: string, requestedBy: TaskRequestOrigin): Promise<TaskRunView> {
    const guard=this.admissionGuards.get(run.config.runId),operation=()=>this.startNewOnce(run,requestId,requestedBy);
    const result=await this.configurationAdmission(()=>guard?guard(operation):operation());
    void this.pump().catch(()=>{});return result;
  }
  private async startNewOnce(run: CatalogRun, requestId: string, requestedBy: TaskRequestOrigin): Promise<TaskRunView> {
    const id = run.config.runId;
    if (!(await this.snapshot(id)).canStart) throw new Error("Task cannot be dispatched again");
    await writeNew(this.requestPath(id), { runId: id, requestId, configSha256: run.configSha256,
      requestedBy, at: new Date().toISOString() });
    try {
      if (hash(await readFile(run.config.snapshot)) !== run.snapshotSha256) throw new Error("Task snapshot changed");
      const prepared = await this.runtime.prepare(run.config);
      if (this.closing) throw new Error("Server stopped before Task submission");
      await this.runtime.submit(prepared, this.scheduler);
      this.prepared.set(id, prepared);
    } catch {
      await writeNew(join(this.root, `${id}.error.json`), { error: "実行前の確認に失敗しました。契約・認証・checkout・台帳を確認してください。" });
      await this.publishResult(id);
    }
    return this.snapshot(id);
  }
  private async pump(): Promise<void> {
    if (this.closing) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      const state = (await this.scheduler.read()).state;
      if (!state) return;
      for (const [id, prepared] of this.prepared) {
        const entry = state.entries.find((item) => item.work.id === id);
        if (this.active.has(id) || !entry || !schedulerWorkEligible(state, entry)) continue;
        const controller = new AbortController();
        let owner: TaskExecutionOwner | undefined;
        const promise = Promise.resolve().then(async () => {
          owner = await TaskExecutionOwner.acquire(prepared.config.outputDir, id, this.registered(id).configSha256, `${id}:dispatch`);
          return this.runtime.execute(prepared, this.scheduler, controller.signal, {
          executionOwner: owner,
          admit:this.admissionGuards.has(id)?operation=>this.admitWhenAvailable(id,operation,controller.signal,
            Date.now()+prepared.contract.limits.timeLimitMinutes*60_000):undefined,
          onCapacityReleased: () => this.pump(),
          knowledgeProofDirectory: this.knowledgeProofDirectory,
          verifyApproval: ({ event, state }) => this.verifyOperationDecision(this.registered(id), event, state),
          onApproval: (approval, decide) => {
            if (!this.approvals.has(id)) this.approvals.set(id, new Map());
            this.approvals.get(id)!.set(approval.id, { approval: structuredClone(approval), decide });
          } }); })
          .then(async (result) => {
            if (result.status === "ready_for_review" && this.reviews) {
              try {
                const run = this.registered(id);
                await captureTaskReview(prepared.config, run.configSha256, run.title, result);
                await this.ensureReview(run);
              } catch { /* execution remains unaccepted; the Task view shows the missing preview */ }
            }
          })
          .catch(async () => {
            const current = (await this.scheduler.read()).state?.entries.find((item) => item.work.id === id);
            if(current?.status==="queued"&&this.admissionGuards.has(id)){
              await writeNew(join(this.root,`${id}.error.json`),{error:"先行成果の受入・版または実行前の照合を確認してください。モデルは開始していません。"});
              await this.scheduler.append({key:`${id}:admission-held`,at:new Date().toISOString(),action:{type:"cancel_queued",workId:id,reason:"Integration baseline admission was not confirmed before provider startup"}});
            }
            if (current?.status === "running") await this.scheduler.append({ key: `${id}:ui-unknown`, at: new Date().toISOString(),
              action: { type: "unknown", workId: id, reason: "UI runner stopped without a confirmed terminal outcome" } });
          }).finally(async () => {
            try { await owner?.finish(); } finally {
              this.active.delete(id); this.prepared.delete(id); this.approvals.delete(id);
            }
            try { await this.publishResult(id); } catch { /* durable Task facts remain available for recovery */ }
            void this.pump().catch(() => {});
          }).catch(() => {});
        this.active.set(id, { controller, promise });
        this.settlements.add(promise);
        void promise.then(() => this.settlements.delete(promise));
        // Read fresh capacity after the next dispatch claim rather than using this snapshot again.
        break;
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) { this.pumpAgain = false; void this.pump().catch(() => {}); }
    }
  }
  private async admitWhenAvailable<T>(id:string,operation:()=>Promise<T>,signal:AbortSignal,deadline:number):Promise<T> {
    for(;;){
      if(signal.aborted||this.closing||Date.now()>=deadline)throw Error("Task stopped before integration admission");
      try{return await this.admissionGuards.get(id)!(operation)}
      catch(error){if(!(error instanceof ReviewDecisionBusyError))throw error;await wait(100,undefined,{signal})}
    }
  }
  async stop(id: string, configSha256: string): Promise<TaskRunView> {
    const run = this.registered(id);
    if (configSha256 !== run.configSha256) throw new Error("Task stop target changed");
    const active = this.active.get(id);
    if (active) active.controller.abort();
    else {
      const entry = (await this.scheduler.read()).state?.entries.find((item) => item.work.id === id);
      if (entry?.status === "queued") {
        this.prepared.delete(id);
        await this.scheduler.append({ key: `${id}:ui-cancel`, at: new Date().toISOString(),
          action: { type: "cancel_queued", workId: id, reason: "Authenticated browser requested cancellation" } });
        await this.publishResult(id);
      } else throw new Error("No live process handle; inspect provider and checkout before reconciliation");
    }
    return this.snapshot(id);
  }
  async decideApproval(id: string, configSha256: string, requestId: string, approvalId: string,
    approvalSha256: string, decision: "allow" | "deny"): Promise<TaskRunView> {
    const run = this.registered(id), active = this.active.get(id);
    const handle = this.approvals.get(id)?.get(approvalId);
    if (!active || active.controller.signal.aborted || !handle || configSha256 !== run.configSha256 ||
        !isReviewRequestId(requestId) || !["allow", "deny"].includes(decision) ||
        (decision === "allow" && handle.approval.targetKnown !== true) ||
        hash(JSON.stringify(handle.approval)) !== approvalSha256 || Date.now() > Date.parse(handle.approval.expiresAt))
      throw new Error("Operation approval is expired, changed or has no live provider handle");
    const approval = handle.approval;
    const receipt = await this.operationProofs.create({ id: requestId, action: "operation", caseId: id,
      runId: id, artifactSha256: approvalSha256, verificationRef: null,
      data: { configSha256, approvalId, attemptId: approval.attemptId, threadId: approval.threadId,
        turnId: approval.turnId, operation: approval.operation, target: approval.target, decision } });
    await handle.decide(decision === "allow", `user:task-operation:${receipt.id}`, receipt.at, receipt.id);
    this.approvals.get(id)?.delete(approvalId);
    return this.snapshot(id);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.settlements]);
    this.detachReviewResults?.();this.detachReviewResults=null;
  }
}
