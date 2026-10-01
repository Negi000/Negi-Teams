// Phase 4: one durable admission point for registered local work.
// This does not start a model, grant filesystem access, or enforce an OS sandbox.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

export type ScheduledRole = "astra" | "sol" | "luna";
export type ScheduledStatus = "queued" | "running" | "needs_reconciliation" |
  "verified" | "failed" | "blocked" | "cancelled";
export interface ResourceClaim { name: string; mode: "read" | "write" }
export interface ScheduledWork {
  id: string;
  parentId: string | null;
  dependencies: string[];
  role: ScheduledRole;
  checkout: string;
  checkoutMode: "read" | "write";
  resources: ResourceClaim[];
  reserveUsd: number;
}
export interface ScheduledEntry {
  work: ScheduledWork;
  status: ScheduledStatus;
  claimKey: string | null;
  evidenceRef: string | null;
  reason: string | null;
  actualCostUsd: number | null;
}
export interface SchedulerSnapshot {
  maxConcurrent: number;
  budgetUsd: number;
  entries: ScheduledEntry[];
}
export type SchedulerAction =
  | { type: "configure"; maxConcurrent: number; budgetUsd: number }
  | { type: "submit"; work: ScheduledWork }
  | { type: "claim"; workId: string }
  | { type: "unknown"; workId: string; reason: string }
  | { type: "settle"; workId: string; outcome: "verified" | "failed";
      evidenceRef: string; actualCostUsd: number | null }
  | { type: "reconcile"; workId: string; outcome: "verified" | "failed";
      evidenceRef: string; actualCostUsd: number | null }
  | { type: "invalidate"; workId: string; evidenceRef: string; reason: string }
  | { type: "revalidate"; workId: string; evidenceRef: string; validationWorkId?: string }
  | { type: "cancel_queued"; workId: string; reason: string };
export interface SchedulerEvent { key: string; at: string; action: SchedulerAction }

function reject(unless: boolean, reason: string): asserts unless {
  if (!unless) throw new Error(`Scheduler rejected: ${reason}`);
}
function money(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function active(entry: ScheduledEntry): boolean {
  return entry.status === "running" || entry.status === "needs_reconciliation";
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
  if (state.entries.filter(active).length >= state.maxConcurrent) return false;
  if (consumedBudget(state) + entry.work.reserveUsd > state.budgetUsd) return false;
  return !state.entries.some((other) => active(other) && conflicts(entry.work, other.work));
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
      action.maxConcurrent > 0 && money(action.budgetUsd), "invalid or repeated configuration");
    return { maxConcurrent: action.maxConcurrent, budgetUsd: action.budgetUsd, entries: [] };
  }
  reject(state !== null, "configure first");
  const next = structuredClone(state);
  if (action.type === "submit") {
    const work = action.work;
    reject(Boolean(work.id) && !next.entries.some((entry) => entry.work.id === work.id) &&
      Boolean(work.checkout) && isAbsolute(work.checkout) && Array.isArray(work.dependencies) &&
      Array.isArray(work.resources) && money(work.reserveUsd) &&
      ["astra", "sol", "luna"].includes(work.role) &&
      ["read", "write"].includes(work.checkoutMode) &&
      (work.role !== "astra" || work.checkoutMode === "read"), "invalid or duplicate work");
    reject(work.parentId === null || next.entries.some((entry) => entry.work.id === work.parentId),
      "parent must be registered");
    reject(new Set(work.dependencies).size === work.dependencies.length &&
      work.dependencies.every((id) => next.entries.some((entry) => entry.work.id === id)),
      "dependencies must be registered once before child");
    const keys = claims(work).map((claim) => claim.name);
    reject(work.resources.every((claim) => Boolean(resourceKey(claim.name)) &&
      ["read", "write"].includes(claim.mode)) && new Set(keys).size === keys.length,
      "resource claims invalid or repeated");
    next.entries.push({ work: structuredClone(work), status: "queued", claimKey: null,
      evidenceRef: null, reason: null, actualCostUsd: null });
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
  constructor(path: string) { this.path = resolve(path); }

  async read(): Promise<{ state: SchedulerSnapshot | null; events: SchedulerEvent[] }> {
    let data: string;
    try { data = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: null, events: [] };
      throw error;
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
    return { state, events };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 2_000;
    let lock: Awaited<ReturnType<typeof open>>;
    for (;;) {
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
        await wait(10);
      }
    }
    try { return await fn(); }
    finally { await lock.close(); await unlink(lockPath); }
  }

  private async write(event: SchedulerEvent): Promise<void> {
    const file = await open(this.path, "a");
    try { await file.writeFile(JSON.stringify(event) + "\n", "utf8"); await file.sync(); }
    finally { await file.close(); }
  }

  async append(event: SchedulerEvent): Promise<SchedulerSnapshot> {
    const pinned = structuredClone(event);
    reject(pinned.action.type !== "claim", "use claim or startNext for dispatch");
    return this.withLock(async () => {
      const current = await this.read();
      const old = current.events.find((item) => item.key === pinned.key);
      if (old) {
        reject(same(old.action, pinned.action), "idempotency key reused for different action");
        return current.state!;
      }
      const next = reduceScheduler(current.state, pinned);
      await this.write(pinned);
      return next;
    });
  }

  /** Preserve the configured capacity; subscription turns do not borrow an API budget. */
  async ensureSubscriptionConfiguration(): Promise<SchedulerSnapshot> {
    return this.withLock(async () => {
      const current = await this.read();
      if (current.state) {
        reject(current.state.budgetUsd === 0, "subscription scheduler must not share an API budget");
        return current.state;
      }
      const event: SchedulerEvent = { key: "subscription:configure", at: new Date().toISOString(),
        action: { type: "configure", maxConcurrent: 1, budgetUsd: 0 } };
      const next = reduceScheduler(null, event);
      await this.write(event);
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
      const current = await this.read();
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
      await this.write(event);
      return next.entries.find((entry) => entry.work.id === workId)!;
    });
  }

  async startNext(key: string = randomUUID()): Promise<ScheduledEntry | null> {
    return this.withLock(async () => {
      const current = await this.read();
      reject(current.state !== null, "scheduler not configured");
      reject(!current.events.some((item) => item.key === key),
        "claim key already used; inspect the existing dispatch");
      const candidate = current.state!.entries.find((entry) => schedulerWorkEligible(current.state!, entry));
      if (!candidate) return null;
      const event: SchedulerEvent = { key, at: new Date().toISOString(),
        action: { type: "claim", workId: candidate.work.id } };
      reduceScheduler(current.state, event);
      await this.write(event);
      return { ...candidate, status: "running", claimKey: key };
    });
  }
}
