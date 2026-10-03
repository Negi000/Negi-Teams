// Phase 4: one durable admission point for registered local work.
// This does not start a model, grant filesystem access, or enforce an OS sandbox.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { verifyMasterTurnDirectory } from "./masterTurnRecords.ts";
import { runtimeStoragePaths } from "./runtimeStoragePaths.ts";

export type ScheduledRole = "astra" | "sol" | "luna";
export type ScheduledStatus = "queued" | "running" | "needs_reconciliation" |
  "verified" | "failed" | "blocked" | "cancelled";
export interface ResourceClaim { name: string; mode: "read" | "write" }
export interface SchedulerRoleLimits { planners: number; workers: number }
export interface SchedulerCapacity extends SchedulerRoleLimits { maxConcurrent: number }
export type ScheduledPhase = "planning" | "waiting_for_worker" | "working";
export const DEFAULT_SUBSCRIPTION_CAPACITY: Readonly<SchedulerCapacity> = Object.freeze({
  maxConcurrent: 3, planners: 1, workers: 2 });
export function parseSchedulerCapacity(raw: unknown): SchedulerCapacity {
  reject(Boolean(raw) && typeof raw === "object" && !Array.isArray(raw), "capacity must be an object");
  const value = raw as Record<string, unknown>;
  reject(Object.keys(value).length === 3 && ["maxConcurrent", "planners", "workers"].every(key =>
    Number.isSafeInteger(value[key]) && (value[key] as number) >= (key === "maxConcurrent" ? 1 : 0) &&
    (value[key] as number) <= 64), "capacity requires bounded global, planner and worker limits");
  return { maxConcurrent: value.maxConcurrent as number, planners: value.planners as number, workers: value.workers as number };
}
export interface ScheduledWork {
  id: string;
  parentId: string | null;
  dependencies: string[];
  role: ScheduledRole;
  checkout: string;
  checkoutMode: "read" | "write";
  resources: ResourceClaim[];
  reserveUsd: number;
  /** Old unphased Sol writers conservatively reserve both role limits until terminal. */
  execution?: "direct" | "astra_to_sol" | "astra_to_luna";
  /** A Luna implementation role alone is not a read-only permission boundary. */
  taskMode?: "read_only_research";
  /** Server-owned binding for resident Master records. Legacy records lack this binding. */
  masterOwner?: { masterId: string; requestSha256: string };
}
export interface ScheduledEntry {
  work: ScheduledWork;
  status: ScheduledStatus;
  claimKey: string | null;
  evidenceRef: string | null;
  reason: string | null;
  actualCostUsd: number | null;
  phase?: ScheduledPhase;
  planningEvidence?: { planRef: string; threadId: string; turnId: string };
  workerClaimKey?: string;
}
export interface SchedulerSnapshot {
  maxConcurrent: number;
  budgetUsd: number;
  entries: ScheduledEntry[];
  roleLimits?: SchedulerRoleLimits;
}
export type SchedulerAction =
  | { type: "configure"; maxConcurrent: number; budgetUsd: number; roleLimits?: SchedulerRoleLimits }
  | { type: "set_capacity"; capacity: SchedulerCapacity; sourceRef: string }
  | { type: "submit"; work: ScheduledWork }
  | { type: "close_unsubmitted"; work: ScheduledWork; evidenceRef: string }
  | { type: "claim"; workId: string }
  | { type: "finish_planning"; workId: string; planRef: string; threadId: string; turnId: string }
  | { type: "start_worker"; workId: string }
  | { type: "unknown"; workId: string; reason: string }
  | { type: "settle"; workId: string; outcome: "verified" | "failed";
      evidenceRef: string; actualCostUsd: number | null }
  | { type: "reconcile"; workId: string; outcome: "verified" | "failed";
      evidenceRef: string; actualCostUsd: number | null }
  | { type: "invalidate"; workId: string; evidenceRef: string; reason: string }
  | { type: "revalidate"; workId: string; evidenceRef: string; validationWorkId?: string }
  | { type: "cancel_queued"; workId: string; reason: string };
export interface SchedulerEvent { key: string; at: string; action: SchedulerAction }

/** Server-owned durable storage participant. It must use a reentrant storage
 * scope, audit exact snapshots, and commit an intent before returning. These
 * callbacks must not call this scheduler or dispatch a provider. */
export interface SchedulerJournal {
  withStorage<T>(run: () => Promise<T>): Promise<T>;
  audit(snapshot: { path: string; bytes: string; state: SchedulerSnapshot | null; events: SchedulerEvent[] }): Promise<void>;
  appendIntent(input: { path: string; previousBytes: string; bytes: string; event: SchedulerEvent }): Promise<void>;
}
interface SchedulerFileStamp { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }
interface SchedulerRead { state: SchedulerSnapshot | null; events: SchedulerEvent[]; bytes: string; stamp: SchedulerFileStamp | null; parentIdentity: string | null }
function fileStamp(stat: SchedulerFileStamp): SchedulerFileStamp {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, nlink: stat.nlink };
}

function reject(unless: boolean, reason: string): asserts unless {
  if (!unless) throw new Error(`Scheduler rejected: ${reason}`);
}
function money(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function active(entry: ScheduledEntry): boolean {
  return entry.status === "running" || entry.status === "needs_reconciliation";
}
function validRoleLimits(value: SchedulerRoleLimits): boolean {
  return Boolean(value) && Number.isSafeInteger(value.planners) && value.planners >= 0 &&
    Number.isSafeInteger(value.workers) && value.workers >= 0;
}
function pipeline(work: ScheduledWork): boolean {
  return work.execution === "astra_to_sol" || work.execution === "astra_to_luna";
}
function capacityDemand(entry: ScheduledEntry): { planners: number; workers: number; global: number } {
  if (pipeline(entry.work)) return entry.phase === "waiting_for_worker"
    ? { planners: 0, workers: 0, global: 0 } : entry.phase === "working"
      ? { planners: 0, workers: 1, global: 1 } : { planners: 1, workers: 0, global: 1 };
  const legacy = entry.work.execution === undefined && entry.work.role === "sol" && entry.work.checkoutMode === "write";
  return { planners: entry.work.role === "astra" || legacy ? 1 : 0,
    workers: entry.work.role === "astra" ? 0 : 1, global: 1 };
}
export function schedulerCapacityUsage(state: SchedulerSnapshot) {
  const usage = { global: 0, planners: 0, workers: 0, waitingWorkers: 0, unresolved: 0, legacyUnphased: 0 };
  for (const entry of state.entries.filter(active)) {
    const demand = capacityDemand(entry);
    usage.global += demand.global; usage.planners += demand.planners; usage.workers += demand.workers;
    if (entry.phase === "waiting_for_worker") usage.waitingWorkers++;
    if (entry.status === "needs_reconciliation") usage.unresolved++;
    if (entry.work.execution === undefined && entry.work.role === "sol" && entry.work.checkoutMode === "write") usage.legacyUnphased++;
  }
  return usage;
}
function hasCapacity(state: SchedulerSnapshot, demand: ReturnType<typeof capacityDemand>): boolean {
  const usage = schedulerCapacityUsage(state);
  return usage.global + demand.global <= state.maxConcurrent && (!state.roleLimits ||
    (usage.planners + demand.planners <= state.roleLimits.planners && usage.workers + demand.workers <= state.roleLimits.workers));
}
function resourceKey(name: string): string { return name.trim().toLowerCase(); }
function claims(work: ScheduledWork): ResourceClaim[] {
  return [{ name: `checkout:${resolve(work.checkout).toLowerCase()}`, mode: work.checkoutMode },
    ...work.resources.map((claim) => ({ name: resourceKey(claim.name), mode: claim.mode }))];
}
function conflicts(a: ScheduledWork, b: ScheduledWork): boolean {
  return claims(a).some((left) => claims(b).some((right) =>
    left.name === right.name && (left.mode === "write" || right.mode === "write")));
}
function consumedBudget(state: SchedulerSnapshot): number {
  return state.entries.reduce((sum, entry) => {
    if (active(entry)) return sum + entry.work.reserveUsd;
    if (entry.status === "verified" || entry.status === "failed") {
      // When billing is unavailable, keep the planning reservation consumed.
      // This is a dispatch budget, never a claim about the actual invoice.
      return sum + (entry.actualCostUsd ?? entry.work.reserveUsd);
    }
    return sum;
  }, 0);
}
export function schedulerWorkEligible(state: SchedulerSnapshot, entry: ScheduledEntry): boolean {
  if (entry.status !== "queued") return false;
  if (!entry.work.dependencies.every((id) =>
    state.entries.find((candidate) => candidate.work.id === id)?.status === "verified")) return false;
  if (!hasCapacity(state, capacityDemand(entry))) return false;
  if (consumedBudget(state) + entry.work.reserveUsd > state.budgetUsd) return false;
  return !state.entries.some((other) => active(other) && conflicts(entry.work, other.work));
}
export function schedulerWorkerEligible(state: SchedulerSnapshot, entry: ScheduledEntry): boolean {
  return entry.status === "running" && pipeline(entry.work) && entry.phase === "waiting_for_worker" &&
    Boolean(entry.planningEvidence) && entry.work.dependencies.every(id =>
      state.entries.find(candidate => candidate.work.id === id)?.status === "verified") &&
    hasCapacity(state, { planners: 0, workers: 1, global: 1 });
}
function blockDependents(state: SchedulerSnapshot): void {
  let changed: boolean;
  do {
    changed = false;
    for (const entry of state.entries) {
      if (entry.status !== "queued") continue;
      const failed = entry.work.dependencies.find((id) => {
        const status = state.entries.find((candidate) => candidate.work.id === id)?.status;
        return status === "failed" || status === "blocked" || status === "cancelled";
      });
      if (!failed) continue;
      entry.status = "blocked";
      entry.reason = `dependency ${failed} did not verify`;
      changed = true;
    }
  } while (changed);
}

export function reduceScheduler(state: SchedulerSnapshot | null,
                                event: SchedulerEvent): SchedulerSnapshot {
  reject(Boolean(event.key) && Number.isFinite(Date.parse(event.at)), "event key/time missing");
  const action = event.action;
  if (action.type === "configure") {
    reject(state === null && Number.isSafeInteger(action.maxConcurrent) &&
      action.maxConcurrent > 0 && money(action.budgetUsd) &&
      (action.roleLimits === undefined || validRoleLimits(action.roleLimits)), "invalid or repeated configuration");
    return { maxConcurrent: action.maxConcurrent, budgetUsd: action.budgetUsd, entries: [],
      ...(action.roleLimits ? { roleLimits: structuredClone(action.roleLimits) } : {}) };
  }
  reject(state !== null, "configure first");
  const next = structuredClone(state);
  if (action.type === "set_capacity") {
    reject(Boolean(action.capacity) && Number.isSafeInteger(action.capacity.maxConcurrent) &&
      action.capacity.maxConcurrent > 0 && validRoleLimits(action.capacity) && Boolean(action.sourceRef), "capacity update invalid");
    // Lower limits gate new starts while existing work finishes or is reconciled.
    next.maxConcurrent = action.capacity.maxConcurrent;
    next.roleLimits = { planners: action.capacity.planners, workers: action.capacity.workers };
    return next;
  }
  if (action.type === "submit" || action.type === "close_unsubmitted") {
    const work = action.work;
    if (action.type === "close_unsubmitted") reject(work.role === "sol" && work.checkoutMode === "write" &&
      work.masterOwner === undefined && work.parentId === null && work.dependencies.length === 0 && work.reserveUsd === 0 &&
      /^user:preflight-close:[0-9a-f-]{36}$/.test(action.evidenceRef), "invalid unsubmitted close");
    reject(work.masterOwner === undefined || (Boolean(work.masterOwner) && typeof work.masterOwner === "object" && !Array.isArray(work.masterOwner) && Object.keys(work.masterOwner).length === 2 &&
      /^master-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(work.id) && work.role === "astra" && work.checkoutMode === "read" &&
      typeof work.masterOwner.masterId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(work.masterOwner.masterId) &&
      typeof work.masterOwner.requestSha256 === "string" && /^[0-9a-f]{64}$/.test(work.masterOwner.requestSha256)), "invalid Master owner binding");
    reject(Boolean(work.id) && !next.entries.some((entry) => entry.work.id === work.id) &&
      Boolean(work.checkout) && isAbsolute(work.checkout) && Array.isArray(work.dependencies) &&
      Array.isArray(work.resources) && money(work.reserveUsd) &&
      ["astra", "sol", "luna"].includes(work.role) &&
      ["read", "write"].includes(work.checkoutMode) &&
      (work.role !== "astra" || work.checkoutMode === "read") &&
      (work.taskMode === undefined ? work.execution !== "astra_to_luna" :
        work.taskMode === "read_only_research" && work.role === "luna" && work.checkoutMode === "read" &&
        work.resources.every(claim=>claim.mode==="read") &&
        (work.execution === "direct" || work.execution === "astra_to_luna")) &&
      (work.execution === undefined || work.execution === "direct" ||
        (work.execution === "astra_to_sol" && work.role === "sol" && work.checkoutMode === "write") ||
        (work.execution === "astra_to_luna" && work.role === "luna" && work.checkoutMode === "read" &&
          work.resources.every(claim=>claim.mode==="read"))), "invalid or duplicate work");
    reject(work.parentId === null || next.entries.some((entry) => entry.work.id === work.parentId),
      "parent must be registered");
    reject(new Set(work.dependencies).size === work.dependencies.length &&
      work.dependencies.every((id) => next.entries.some((entry) => entry.work.id === id)),
      "dependencies must be registered once before child");
    const keys = claims(work).map((claim) => claim.name);
    reject(work.resources.every((claim) => Boolean(resourceKey(claim.name)) &&
      ["read", "write"].includes(claim.mode)) && new Set(keys).size === keys.length,
      "resource claims invalid or repeated");
    next.entries.push({ work: structuredClone(work), status: action.type === "close_unsubmitted" ? "cancelled" : "queued", claimKey: null,
      evidenceRef: action.type === "close_unsubmitted" ? action.evidenceRef : null,
      reason: action.type === "close_unsubmitted" ? "未実行を照合し、開始要求を終了しました。新しい作業は契約案から作成してください。" : null, actualCostUsd: null,
      ...(pipeline(work) ? { phase: "planning" as const } : {}) });
    blockDependents(next);
    return next;
  }
  const entry = next.entries.find((candidate) => candidate.work.id === action.workId);
  reject(Boolean(entry), "work not registered");
  if (action.type === "claim") {
    reject(schedulerWorkEligible(next, entry!), "work not eligible for a slot");
    entry!.status = "running";
    entry!.claimKey = event.key;
    return next;
  }
  if (action.type === "finish_planning") {
    reject(entry!.status === "running" && pipeline(entry!.work) && entry!.phase === "planning" &&
      typeof action.planRef === "string" && /^.{1,4096}#sha256=[a-f0-9]{64}$/.test(action.planRef) &&
      [action.threadId, action.turnId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id)),
      "planning release requires a running pipeline and bound output evidence");
    entry!.phase = "waiting_for_worker";
    entry!.planningEvidence = { planRef: action.planRef, threadId: action.threadId, turnId: action.turnId };
    return next;
  }
  if (action.type === "start_worker") {
    reject(schedulerWorkerEligible(next, entry!), "worker not eligible for a slot");
    entry!.phase = "working";
    entry!.workerClaimKey = event.key;
    return next;
  }
  if (action.type === "unknown") {
    reject(entry!.status === "running" && Boolean(action.reason), "unknown requires running work and reason");
    entry!.status = "needs_reconciliation";
    entry!.reason = action.reason;
    return next;
  }
  if (action.type === "settle" || action.type === "reconcile") {
    reject(entry!.status === (action.type === "settle" ? "running" : "needs_reconciliation") &&
      ["verified", "failed"].includes(action.outcome) && Boolean(action.evidenceRef) &&
      (action.actualCostUsd === null || money(action.actualCostUsd)),
    "settlement requires matching state, evidence and valid cost");
    entry!.status = action.outcome;
    entry!.evidenceRef = action.evidenceRef;
    entry!.actualCostUsd = action.actualCostUsd;
    entry!.reason = null;
    blockDependents(next);
    return next;
  }
  if (action.type === "invalidate") {
    reject(entry!.status === "verified" && Boolean(action.evidenceRef) &&
      Boolean(action.reason), "only verified work can be invalidated with evidence");
    entry!.status = "failed";
    entry!.reason = `invalidated: ${action.reason}; evidence=${action.evidenceRef}`;
    // A completed dependent is no longer a verified integration when a source fails.
    // A running dependent remains reserved until provider reconciliation.
    const affected = new Set([action.workId]);
    let changed: boolean;
    do {
      changed = false;
      for (const dependent of next.entries) {
        if (!dependent.work.dependencies.some((id) => affected.has(id)) ||
            affected.has(dependent.work.id)) continue;
        affected.add(dependent.work.id);
        changed = true;
        if (dependent.status === "verified") dependent.status = "failed";
        else if (dependent.status === "running") dependent.status = "needs_reconciliation";
        else if (dependent.status === "queued") dependent.status = "blocked";
        dependent.reason = `dependency invalidated by ${action.workId}; event=${event.key}`;
      }
    } while (changed);
    return next;
  }
  if (action.type === "revalidate") {
    const validation = action.validationWorkId ? next.entries.find((item) => item.work.id === action.validationWorkId) : null;
    reject(!action.validationWorkId || Boolean(validation && validation.work.parentId === entry!.work.id &&
      validation.work.id.startsWith(entry!.work.id + ":local-revision-") && validation.status === "running" &&
      validation.work.checkoutMode === "write" &&
      resolve(validation.work.checkout).toLowerCase() === resolve(entry!.work.checkout).toLowerCase()),
      "local validation lease does not match this job");
    reject(["failed", "verified"].includes(entry!.status) && Boolean(entry!.claimKey && action.evidenceRef) &&
      !next.entries.some((other) => active(other) && other !== validation && conflicts(entry!.work, other.work)),
      "local revalidation requires a terminal claimed job and no active conflicting writer");
    entry!.status = "verified";
    entry!.evidenceRef = action.evidenceRef;
    entry!.reason = null;
    // Previously invalidated dependents remain blocked/failed. They need new work.
    return next;
  }
  reject(action.type === "cancel_queued" && entry!.status === "queued" && Boolean(action.reason),
    "only queued work can be cancelled");
  entry!.status = "cancelled";
  entry!.reason = action.reason;
  blockDependents(next);
  return next;
}

export class FileScheduler {
  readonly path: string;
  private readonly registeredPath: string;
  private readonly journal: SchedulerJournal | undefined;
  constructor(path: string, options: { journal?: SchedulerJournal } = {}) {
    this.path = this.registeredPath = resolve(path);
    const journal = options.journal;
    if (journal) {
      reject([journal.withStorage, journal.audit, journal.appendIntent].every(fn => typeof fn === "function"), "journal registration invalid");
      this.journal = Object.freeze({ withStorage: journal.withStorage.bind(journal),
        audit: journal.audit.bind(journal), appendIntent: journal.appendIntent.bind(journal) });
    }
  }

  async read(): Promise<{ state: SchedulerSnapshot | null; events: SchedulerEvent[] }> {
    const read = async () => { const value = await this.readChecked(); return { state: value.state, events: value.events }; };
    return this.journal ? this.journal.withStorage(read) : read();
  }

  private assertPath(): void {
    reject(this.path === this.registeredPath, "registered scheduler path changed");
  }

  /** Default writers must not bypass an explicit runtime index, even if its DB
   * is missing or bootstrap was interrupted. Does not open SQLite or repair. */
  async assertStorageCompatible(): Promise<void> {
    this.assertPath();
    if (this.journal) return;
    await this.assertRuntimeUnregistered();
  }

  private async assertRuntimeUnregistered(): Promise<void> {
    this.assertPath();
    const paths = runtimeStoragePaths(this.registeredPath);
    for (const path of [paths.registration, paths.database, ...["-journal", "-wal", "-shm"].map(suffix => paths.database + suffix),
      this.registeredPath + ".negi-storage-bootstrap.json", this.registeredPath + ".negi-storage-bootstrap.json.pending"]) {
      try { await lstat(path); throw new Error("Scheduler rejected: registered runtime index requires its journal writer"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.assertPath();
  }

  /** Serialize unindexed turn artifacts with explicit runtime adoption. No
   * scheduler method may be called inside this trusted publication callback. */
  async withUnindexedArtifacts<T>(run: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.assertRuntimeUnregistered();
      const result = await run();
      await this.assertRuntimeUnregistered();
      return result;
    });
  }

  private async capture(): Promise<SchedulerRead> {
    this.assertPath();
    await this.assertStorageCompatible();
    let data: string;
    let stamp: SchedulerFileStamp | null = null;
    let parentIdentity: string | null = null;
    if (this.journal) {
      parentIdentity = await verifyMasterTurnDirectory(dirname(this.registeredPath));
      let before;
      try { before = await lstat(this.registeredPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!before) data = "";
      else {
        reject(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, "unsafe journal scheduler file");
        stamp = fileStamp(before);
        const file = await open(this.registeredPath, "r");
        try {
          reject(same(stamp, fileStamp(await file.stat())), "scheduler changed before read");
          const raw = await file.readFile(); data = raw.toString("utf8");
          reject(Buffer.from(data, "utf8").equals(raw) && same(stamp, fileStamp(await file.stat())) &&
            same(stamp, fileStamp(await lstat(this.registeredPath))), "scheduler changed or has invalid UTF-8");
        } finally { await file.close(); }
      }
    } else {
      try { data = await readFile(this.registeredPath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") data = ""; else throw error; }
    }
    reject(!data || data.endsWith("\n"), "incomplete event log tail");
    let state: SchedulerSnapshot | null = null;
    const events: SchedulerEvent[] = [];
    const keys = new Set<string>();
    for (const line of data.split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as SchedulerEvent;
      reject(!keys.has(event.key), "duplicate event key");
      keys.add(event.key);
      state = reduceScheduler(state, event);
      events.push(event);
    }
    this.assertPath();
    return { state, events, bytes: data, stamp, parentIdentity };
  }

  private async readChecked(): Promise<SchedulerRead> {
    const current = await this.capture();
    if (this.journal) {
      await this.journal.audit(structuredClone({ path: this.registeredPath, bytes: current.bytes, state: current.state, events: current.events }));
      const after = await this.capture();
      reject(current.bytes === after.bytes && same(current.stamp, after.stamp) && current.parentIdentity === after.parentIdentity, "scheduler changed during journal audit");
    }
    return current;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.journal ? this.journal.withStorage(() => this.withFileLock(fn)) : this.withFileLock(fn);
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    this.assertPath();
    await this.assertStorageCompatible();
    if (this.journal) {
      await verifyMasterTurnDirectory(dirname(this.registeredPath));
    }
    this.assertPath();
    await mkdir(dirname(this.registeredPath), { recursive: true });
    const lockPath = `${this.registeredPath}.lock`;
    const deadline = Date.now() + 2_000;
    let lock: Awaited<ReturnType<typeof open>>;
    for (;;) {
      this.assertPath();
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows may report EPERM while an exclusive lock is being closed or
        // deleted. Retry the same bounded exclusive open; never remove its owner.
        if (!(code === "EEXIST" || (process.platform === "win32" && code === "EPERM")) || Date.now() >= deadline) throw error;
        await wait(10);
      }
    }
    try { this.assertPath(); const result = await fn(); this.assertPath(); return result; }
    finally { await lock.close(); await unlink(lockPath); }
  }

  private async write(event: SchedulerEvent, current: SchedulerRead): Promise<void> {
    this.assertPath();
    await this.assertStorageCompatible();
    const bytes = JSON.stringify(event) + "\n";
    if (this.journal) {
      await this.journal.appendIntent(structuredClone({ path: this.registeredPath, previousBytes: current.bytes, bytes, event }));
      const before = await this.capture();
      reject(current.bytes === before.bytes && same(current.stamp, before.stamp) && current.parentIdentity === before.parentIdentity, "scheduler changed after journal intent");
      // Existing logs must not be recreated after deletion. The create-only path
      // also rejects a file which appeared after an absent snapshot.
      const file = await open(this.registeredPath, current.stamp ? "r+" : "wx+", 0o600);
      try {
        this.assertPath();
        const pinned = await file.stat();
        reject(pinned.isFile() && pinned.nlink === 1 && (current.stamp ? same(current.stamp, fileStamp(pinned)) : pinned.size === 0), "scheduler replaced before publication");
        const raw = Buffer.from(bytes, "utf8"), position = Buffer.byteLength(current.bytes, "utf8");
        let offset = 0;
        while (offset < raw.length) {
          this.assertPath();
          const { bytesWritten } = await file.write(raw, offset, raw.length - offset, position + offset);
          reject(bytesWritten > 0, "scheduler publication made no progress"); offset += bytesWritten;
        }
        await file.sync();
        this.assertPath();
        const after = await lstat(this.registeredPath);
        reject(after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && after.dev === pinned.dev && after.ino === pinned.ino,
          "scheduler replaced during publication");
      } finally { await file.close(); }
      const saved = await this.readChecked();
      reject(saved.bytes === current.bytes + bytes && saved.parentIdentity === current.parentIdentity, "scheduler publication differs from committed intent");
      return;
    }
    const file = await open(this.registeredPath, "a");
    try { this.assertPath(); await file.writeFile(bytes, "utf8"); await file.sync(); this.assertPath(); }
    finally { await file.close(); }
  }

  async append(event: SchedulerEvent, validate?: (current: {state:SchedulerSnapshot|null;events:SchedulerEvent[]}) => Promise<boolean>): Promise<SchedulerSnapshot> {
    const pinned = structuredClone(event);
    reject(pinned.action.type !== "claim" && pinned.action.type !== "start_worker", "use atomic claim methods for dispatch");
    return this.withLock(async () => {
      const current = await this.readChecked();
      const old = current.events.find((item) => item.key === pinned.key);
      if (old) {
        reject(same(old.action, pinned.action), "idempotency key reused for different action");
        return current.state!;
      }
      if(validate)reject(await validate(structuredClone({state:current.state,events:current.events})), "current scheduler evidence changed");
      const next = reduceScheduler(current.state, pinned);
      await this.write(pinned, current);
      return next;
    });
  }

  /** Append capacity changes; never rewrite historical configuration or an active claim. */
  async ensureSubscriptionConfiguration(capacity?: SchedulerCapacity): Promise<SchedulerSnapshot> {
    const explicit = capacity === undefined ? undefined : parseSchedulerCapacity(structuredClone(capacity));
    return this.withLock(async () => {
      const current = await this.readChecked();
      if (current.state) {
        reject(current.state.budgetUsd === 0, "subscription scheduler must not share an API budget");
        const desired = explicit ?? { maxConcurrent: current.state.maxConcurrent,
          ...(current.state.roleLimits ?? { planners: 1, workers: 2 }) };
        if (current.state.maxConcurrent === desired.maxConcurrent && same(current.state.roleLimits,
            { planners: desired.planners, workers: desired.workers })) return current.state;
        const event: SchedulerEvent = { key: `subscription:capacity:${randomUUID()}`, at: new Date().toISOString(),
          action: { type: "set_capacity", capacity: desired,
            sourceRef: explicit ? "server:trusted-task-catalog-capacity" : "server:role-limits-migration/1" } };
        const next = reduceScheduler(current.state, event);
        await this.write(event, current);
        return next;
      }
      const desired = explicit ?? DEFAULT_SUBSCRIPTION_CAPACITY;
      const event: SchedulerEvent = { key: "subscription:configure", at: new Date().toISOString(),
        action: { type: "configure", maxConcurrent: desired.maxConcurrent, budgetUsd: 0,
          roleLimits: { planners: desired.planners, workers: desired.workers } } };
      const next = reduceScheduler(null, event);
      await this.write(event, current);
      return next;
    });
  }

  async claim(workId: string, key: string = randomUUID()): Promise<ScheduledEntry> {
    const entry = await this.tryClaim(workId, key);
    reject(entry !== null, "work not eligible for a slot");
    return entry;
  }

  /** A capacity miss is known before dispatch; corrupt logs and reused keys still throw. */
  async tryClaim(workId: string, key: string = randomUUID()): Promise<ScheduledEntry | null> {
    return this.withLock(async () => {
      const current = await this.readChecked();
      reject(current.state !== null, "scheduler not configured");
      reject(!current.events.some((item) => item.key === key),
        "claim key already used; inspect the existing dispatch");
      const entry = current.state.entries.find((item) => item.work.id === workId);
      reject(Boolean(entry), "work not registered");
      reject(entry!.status === "queued", "work is not queued; inspect the existing dispatch");
      if (!schedulerWorkEligible(current.state, entry!)) return null;
      const event: SchedulerEvent = { key, at: new Date().toISOString(),
        action: { type: "claim", workId } };
      const next = reduceScheduler(current.state, event);
      await this.write(event, current);
      return next.entries.find((entry) => entry.work.id === workId)!;
    });
  }

  async tryStartWorker(workId: string, key: string): Promise<ScheduledEntry | null> {
    return this.withLock(async () => {
      const current = await this.readChecked();
      reject(current.state !== null, "scheduler not configured");
      reject(!current.events.some(item => item.key === key), "worker claim key already used; inspect the existing dispatch");
      const entry = current.state.entries.find(item => item.work.id === workId);
      reject(Boolean(entry) && entry!.status === "running" && entry!.phase === "waiting_for_worker",
        "worker must be waiting in a running pipeline");
      if (!schedulerWorkerEligible(current.state, entry!)) return null;
      const event: SchedulerEvent = { key, at: new Date().toISOString(), action: { type: "start_worker", workId } };
      const next = reduceScheduler(current.state, event);
      await this.write(event, current);
      return next.entries.find(item => item.work.id === workId)!;
    });
  }

  async startNext(key: string = randomUUID()): Promise<ScheduledEntry | null> {
    return this.withLock(async () => {
      const current = await this.readChecked();
      reject(current.state !== null, "scheduler not configured");
      reject(!current.events.some((item) => item.key === key),
        "claim key already used; inspect the existing dispatch");
      const candidate = current.state!.entries.find((entry) => schedulerWorkEligible(current.state!, entry));
      if (!candidate) return null;
      const event: SchedulerEvent = { key, at: new Date().toISOString(),
        action: { type: "claim", workId: candidate.work.id } };
      reduceScheduler(current.state, event);
      await this.write(event, current);
      return { ...candidate, status: "running", claimKey: key };
    });
  }
}
