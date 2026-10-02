import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { MasterConversationInventory } from "./masterConversationInventory.ts";
import { RuntimeJournalInventory } from "./runtimeJournalInventory.ts";
import { MasterConversationAuthority } from "./masterConversations.ts";
import { FileScheduler } from "./scheduler.ts";
import type { TaskStorageRegistration } from "./taskService.ts";
import { StorageBootstrap } from "./storageBootstrap.ts";

export type StorageOperation = "authority-initialize" | "stage-adopt" | "runtime-adopt" | "database-recover";
export interface StorageDecision {
  operation: StorageOperation; decisionId: string; proofSha256: string; registrationSha256: string;
}
export interface StorageConsoleState {
  maintenance: boolean; executionHeld: boolean; startupError: string | null;
}
const operations: readonly StorageOperation[] = ["authority-initialize", "stage-adopt", "runtime-adopt", "database-recover"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
export function checkedStorageDecision(raw: unknown): StorageDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Storage decision invalid");
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "decisionId,operation,proofSha256,registrationSha256" ||
      !operations.includes(row.operation as StorageOperation) || typeof row.decisionId !== "string" || !uuid.test(row.decisionId) ||
      typeof row.proofSha256 !== "string" || !sha.test(row.proofSha256) ||
      typeof row.registrationSha256 !== "string" || !sha.test(row.registrationSha256)) throw Error("Storage decision fields invalid");
  return { operation: row.operation as StorageOperation, decisionId: row.decisionId,
    proofSha256: row.proofSha256, registrationSha256: row.registrationSha256 };
}

/** Fixed server registration. Neither paths nor a storage mode come from HTTP.
 * Normal execution remains disabled after adoption; this console never starts,
 * dispatches, retries or reports completion of a provider operation. */
export class LocalStorageConsole {
  readonly registrationSha256: string;
  private readonly stage: MasterConversationInventory;
  private readonly runtime: RuntimeJournalInventory;
  private readonly bootstrap: StorageBootstrap;
  private applying = false;
  private readonly registration: Readonly<TaskStorageRegistration & { masterId: string }>;
  constructor(registration: TaskStorageRegistration & { masterId: string }, private readonly host: () => StorageConsoleState) {
    this.registration = Object.freeze({ ...registration });
    this.stage = new MasterConversationInventory({ root: registration.root, masterId: registration.masterId,
      recoveryContext: { turnRoot: registration.turnRoot, schedulerPath: registration.schedulerPath } });
    this.runtime = new RuntimeJournalInventory(registration);
    this.bootstrap = new StorageBootstrap(this.registration);
    this.registrationSha256 = createHash("sha256").update(JSON.stringify(this.registration)).digest("hex");
  }
  /** Before opening any default service, fence registered stage/runtime storage
   * and sidecars. No index activation or opportunistic root initialization. */
  async assertLegacyExecutionAllowed() {
    await new MasterConversationAuthority({ ...this.registration,
      scheduler: new FileScheduler(this.registration.schedulerPath) }).assertStorageCompatible();
  }
  private async requireExistingAuthority() {
    const root = await lstat(this.registration.root), key = await lstat(join(this.registration.root, "signing-key.json"));
    if (!root.isDirectory() || root.isSymbolicLink() || !key.isFile() || key.isSymbolicLink()) throw Error("Existing storage authority required");
  }
  async status() {
    // Audit does not create a missing root, key or database. Keep failures visible
    // without exposing helper output, file contents or private signing material.
    let stage: { state: "clean" | "pending" | "held"; artifactCount: number | null } = { state: "held", artifactCount: null };
    let runtime: { state: "clean" | "pending" | "held"; artifactCount: number | null } = { state: "held", artifactCount: null };
    let exists = false;try { await this.requireExistingAuthority();exists = true; } catch {}
    if (exists) {
      try { const result = await this.stage.audit();stage = { state: result.state, artifactCount: result.artifactCount }; } catch {}
      try { const result = await this.runtime.audit();runtime = { state: result.state, artifactCount: result.artifactCount }; } catch {}
    }
    const state = this.host();
    return { ...state, registration: this.registration, registrationSha256: this.registrationSha256,
      stage: { ...stage, scope: "master" as const, masterId: this.registration.masterId },
      runtime: { ...runtime, scope: "root" as const }, bootstrap: await this.bootstrap.status(),
      applying: this.applying, canApply: state.maintenance && state.executionHeld && !this.applying };
  }
  async preview(operation: StorageOperation) {
    if (!operations.includes(operation)) throw Error("Storage preview operation invalid");
    if (operation === "authority-initialize") {
      const result = await this.bootstrap.preview();
      return { decision: { operation, decisionId: result.decisionId, proofSha256: result.proofSha256,
        registrationSha256: this.registrationSha256 }, summary: result };
    }
    await this.requireExistingAuthority();
    const result = operation === "stage-adopt" ? await this.stage.previewLegacyMigration() :
      operation === "runtime-adopt" ? await this.runtime.previewBaseline() : await this.stage.previewDatabaseRecovery();
    return { decision: { operation, decisionId: randomUUID(), proofSha256: result.proofSha256,
      registrationSha256: this.registrationSha256 }, summary: result };
  }
  async apply(input: StorageDecision) {
    const decision = checkedStorageDecision(input);
    const state = this.host();
    if (decision.registrationSha256 !== this.registrationSha256 || !state.maintenance || !state.executionHeld || this.applying)
      throw Error("Storage maintenance registration held");
    this.applying = true;
    try {
      const current = this.host();if (!current.maintenance || !current.executionHeld) throw Error("Storage maintenance ended");
      const proof = { decisionId: decision.decisionId, expectedProofSha256: decision.proofSha256 };
      if (decision.operation === "authority-initialize") {
        const result = await this.bootstrap.apply(proof);
        return { decision, result, executionStarted: false, activation: "held" as const };
      }
      await this.requireExistingAuthority();
      const result = decision.operation === "stage-adopt" ? await this.stage.migrateLegacy(proof) :
        decision.operation === "runtime-adopt" ? await this.runtime.adoptBaseline(proof) : await this.stage.recoverDatabase(proof);
      return { decision, result, executionStarted: false, activation: "held" as const };
    } finally { this.applying = false; }
  }
}
