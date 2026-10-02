// Independent candidate primitive. Not connected to MasterConversationAuthority,
// provider RPC, startup, owner recovery or UI until migration/recovery gates pass.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { masterStorageTicket, withMasterStorageGuard } from "./masterStorageGuard.ts";

export interface MasterInventoryHead { seq: number; sha256: string }
export interface MasterInventoryAudit {
  head: MasterInventoryHead; state: "clean" | "pending"; artifactCount: number; missing: string[];
}
export interface MasterInventoryIntent { head: MasterInventoryHead; relativePath: string; artifactSha256: string }
export interface MasterInventoryArtifact extends MasterInventoryAudit {
  relativePath: string; bytes: string; artifactSha256: string;
}
export interface MasterInventoryProcessIdentity { platform: "windows" | "linux"; pid: number; startToken: string }
export interface MasterInventoryMigrationPreview {
  proofSha256: string; masterCount: number; stageCount: number; receiptCount: number;
}
export interface MasterInventoryMigrationResult extends MasterInventoryMigrationPreview { decisionId: string }
export interface MasterInventoryDatabaseRecoveryPreview {
  proofSha256: string; databaseSha256: string; journalSha256: string; recoveredSha256: string;
  masterCount: number; artifactCount: number; missingCount: number;
}
export interface MasterInventoryDatabaseRecoveryResult extends MasterInventoryDatabaseRecoveryPreview { decisionId: string; recovered: true }
const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const path = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/0[0-4]-(requested|old_idle|start_dispatched|bound|completed|cancelled|needs_reconciliation)|recoveries\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const stagePath = (value: string) => path.test(value) && !value.startsWith("recoveries/");
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Master inventory: " + reason); }
function fields(value: Record<string, unknown>, names: string[]) {
  check(Object.keys(value).sort().join() === names.sort().join(), "helper result fields");
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function head(value: unknown): MasterInventoryHead {
  check(value && typeof value === "object" && !Array.isArray(value), "checkpoint required");
  const row = value as Record<string, unknown>;
  fields(row, ["seq", "sha256"]);
  check(Number.isSafeInteger(row.seq) && Number(row.seq) >= 0 && Number(row.seq) <= 60_000 && typeof row.sha256 === "string" && sha.test(row.sha256), "checkpoint invalid");
  return row as unknown as MasterInventoryHead;
}
async function script() {
  let filename = fileURLToPath(new URL("../../../scripts/negi_master_conversation_inventory.py", import.meta.url));
  try { await lstat(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    filename = fileURLToPath(new URL("../../../../scripts/negi_master_conversation_inventory.py", import.meta.url));
  }
  const info = await lstat(filename);
  check(info.isFile() && !info.isSymbolicLink(), "fixed helper unavailable");
  return filename;
}

async function invoke(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frozen = structuredClone(request);
  return frozen.action === "processIdentity" ? invokeHeld(frozen) : withMasterStorageGuard(String(frozen.root), () => invokeHeld(frozen),
    { createIfMissing: !["audit", "lookup", "previewMigration", "previewDatabaseRecovery", "recoverDatabase"].includes(String(frozen.action)) });
}

async function invokeHeld(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ticket = request.action === "processIdentity" ? undefined : masterStorageTicket(String(request.root));
  const input = JSON.stringify({ ...request, ...(ticket ? { storageTicket: ticket } : {}) }) + "\n";
  check(Buffer.byteLength(input) <= 100_000, "input too large");
  const filename = await script();
  // No shell, no payload/key in command line. Wait for exit even after timeout.
  const output = await new Promise<string>((accept, reject) => {
    const child = spawn("python", ["-B", filename], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let stdout = "", stderr = "", size = 0, failure: Error | null = null;
    // Do not terminate an explicit adoption on an elapsed-time deadline: it may
    // already have created its one permitted DB. Wait for its actual exit. The
    // Database preview also owns disposable full-history clones: an elapsed-time
    // kill would bypass their cleanup. Wait for actual exit and release the guard.
    const timeout = ["migrate", "recoverDatabase", "previewDatabaseRecovery"].includes(String(request.action)) ? null :
      request.action === "previewMigration" ? 15 * 60_000 : 30_000;
    const timer = timeout === null ? null : setTimeout(() => { failure = Error("Master inventory: helper timeout; operation outcome needs inspection"); child.kill(); }, timeout);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 8_000_000) { failure = Error("Master inventory: helper output limit"); child.kill(); }
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 500); });
    child.on("error", error => { failure = error; });
    child.stdin.on("error", error => { failure ??= error; });
    child.on("close", code => { if (timer) clearTimeout(timer); if (failure) reject(failure);
      else if (code !== 0) reject(Error("Master inventory helper held: " + stderr.trim())); else accept(stdout); });
    child.stdin.end(input);
  });
  const value: unknown = JSON.parse(output);
  check(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(value) + "\n" === output, "noncanonical helper result");
  const row = value as Record<string, unknown>;
  check(row.schema === "negi-master-inventory-result/1" && row.action === request.action && row.masterId === request.masterId, "helper registration mismatch");
  return row;
}

/** Create-only explicit bootstrap; audit and lookup never initialize or repair. */
export class MasterConversationInventory {
  readonly databasePath: string;
  private readonly root: string;
  private readonly masterId: string;
  constructor(options: { root: string; masterId: string }) {
    check(isAbsolute(options.root) && /^[a-zA-Z0-9_-]{1,100}$/.test(options.masterId), "server registration invalid");
    this.root = resolve(options.root); this.masterId = options.masterId; this.databasePath = this.root + ".inventory.sqlite3";
  }
  private request(action: string, extra: Record<string, unknown> = {}) {
    return { action, root: this.root, masterId: this.masterId, ...extra };
  }
  async initialize(): Promise<void> {
    fields(await invoke(this.request("initialize")), ["schema", "action", "masterId"]);
  }
  async registerEmptyMaster(): Promise<void> {
    fields(await invoke(this.request("register")), ["schema", "action", "masterId"]);
  }
  private migrationSummary(row: Record<string, unknown>): MasterInventoryMigrationPreview {
    check(typeof row.proofSha256 === "string" && sha.test(row.proofSha256) && Number.isSafeInteger(row.masterCount) &&
      Number(row.masterCount) > 0 && Number(row.masterCount) <= 10_000 && Number.isSafeInteger(row.stageCount) &&
      Number(row.stageCount) >= 0 && Number(row.stageCount) <= 50_000 && Number.isSafeInteger(row.receiptCount) &&
      Number(row.receiptCount) >= 0 && Number(row.receiptCount) <= 50_000 &&
      Number(row.stageCount) + Number(row.receiptCount) <= 100_000, "migration result invalid");
    return { proofSha256: row.proofSha256, masterCount: Number(row.masterCount), stageCount: Number(row.stageCount), receiptCount: Number(row.receiptCount) };
  }
  /** Read-only snapshot; the persistent root guard must already be installed. */
  async previewLegacyMigration(): Promise<MasterInventoryMigrationPreview> {
    const row = await invoke(this.request("previewMigration"));
    fields(row, ["schema", "action", "masterId", "proofSha256", "masterCount", "stageCount", "receiptCount"]);
    return this.migrationSummary(row);
  }
  /** Explicit create-only adoption; retry the same decision to inspect its commit. */
  async migrateLegacy(input: { decisionId: string; expectedProofSha256: string }): Promise<MasterInventoryMigrationResult> {
    const frozen = { decisionId: input.decisionId, expectedProofSha256: input.expectedProofSha256 };
    check(uuid.test(frozen.decisionId) && sha.test(frozen.expectedProofSha256), "migration decision/proof required");
    const row = await invoke(this.request("migrate", frozen));
    fields(row, ["schema", "action", "masterId", "proofSha256", "masterCount", "stageCount", "receiptCount", "decisionId"]);
    const result = this.migrationSummary(row);
    check(row.decisionId === frozen.decisionId && result.proofSha256 === frozen.expectedProofSha256, "accepted migration differs from decision");
    return { ...result, decisionId: frozen.decisionId };
  }
  async currentProcessIdentity(): Promise<MasterInventoryProcessIdentity> {
    const row = await invoke(this.request("processIdentity"));
    fields(row, ["schema", "action", "masterId", "processIdentity"]);
    check(row.processIdentity && typeof row.processIdentity === "object" && !Array.isArray(row.processIdentity), "process identity missing");
    const value = row.processIdentity as Record<string, unknown>;
    fields(value, ["platform", "pid", "startToken"]);
    check(value.pid === process.pid && typeof value.startToken === "string" &&
      (value.platform === "windows" && /^[0-9]{1,30}$/.test(value.startToken) || value.platform === "linux" && /^[0-9a-f-]{36}:[0-9]{1,30}$/.test(value.startToken)), "parent process identity invalid");
    return value as unknown as MasterInventoryProcessIdentity;
  }
  private databaseRecoveryPreview(row: Record<string, unknown>): MasterInventoryDatabaseRecoveryPreview {
    check([row.proofSha256, row.databaseSha256, row.journalSha256, row.recoveredSha256].every(value => typeof value === "string" && sha.test(value)) &&
      Number.isSafeInteger(row.masterCount) && Number(row.masterCount) > 0 && Number(row.masterCount) <= 10_000 &&
      Number.isSafeInteger(row.artifactCount) && Number(row.artifactCount) >= 0 && Number(row.artifactCount) <= 100_000 &&
      Number.isSafeInteger(row.missingCount) && Number(row.missingCount) >= 0 && Number(row.missingCount) <= Number(row.artifactCount), "database recovery result invalid");
    return { proofSha256: String(row.proofSha256), databaseSha256: String(row.databaseSha256), journalSha256: String(row.journalSha256), recoveredSha256: String(row.recoveredSha256),
      masterCount: Number(row.masterCount), artifactCount: Number(row.artifactCount), missingCount: Number(row.missingCount) };
  }
  /** Copies and audits a disposable rollback result; original files stay intact. */
  async previewDatabaseRecovery(): Promise<MasterInventoryDatabaseRecoveryPreview> {
    const row = await invoke(this.request("previewDatabaseRecovery"));
    fields(row, ["schema", "action", "masterId", "proofSha256", "databaseSha256", "journalSha256", "recoveredSha256", "masterCount", "artifactCount", "missingCount"]);
    return this.databaseRecoveryPreview(row);
  }
  /** Explicit exact-decision SQLite rollback; no elapsed-time kill or auto retry. */
  async recoverDatabase(input: { decisionId: string; expectedProofSha256: string }): Promise<MasterInventoryDatabaseRecoveryResult> {
    const frozen = { decisionId: input.decisionId, expectedProofSha256: input.expectedProofSha256 };
    check(uuid.test(frozen.decisionId) && sha.test(frozen.expectedProofSha256), "database recovery decision/proof required");
    const row = await invoke(this.request("recoverDatabase", frozen));
    fields(row, ["schema", "action", "masterId", "proofSha256", "databaseSha256", "journalSha256", "recoveredSha256", "masterCount", "artifactCount", "missingCount", "decisionId", "recovered"]);
    const preview = this.databaseRecoveryPreview(row);
    check(row.decisionId === frozen.decisionId && preview.proofSha256 === frozen.expectedProofSha256 && row.recovered === true, "database recovery differs from decision");
    return { ...preview, decisionId: frozen.decisionId, recovered: true };
  }
  private auditResult(row: Record<string, unknown>): MasterInventoryAudit {
    const checkpoint = head(row.head);
    check(["clean", "pending"].includes(String(row.state)) && Number.isSafeInteger(row.artifactCount) &&
      Number(row.artifactCount) >= 0 && Number(row.artifactCount) <= 60_000 && Array.isArray(row.missing) &&
      row.missing.length <= Number(row.artifactCount) && row.missing.every(name => typeof name === "string" && path.test(name)) &&
      new Set(row.missing).size === row.missing.length && row.state === (row.missing.length ? "pending" : "clean") &&
      checkpoint.seq === row.artifactCount, "audit result invalid");
    return { head: checkpoint, state: row.state as "clean" | "pending", artifactCount: Number(row.artifactCount), missing: row.missing as string[] };
  }
  async audit(): Promise<MasterInventoryAudit> {
    const row = await invoke(this.request("audit"));
    fields(row, ["schema", "action", "masterId", "head", "state", "artifactCount", "missing"]);
    return this.auditResult(row);
  }
  async appendStageIntent(input: { expectedHead: MasterInventoryHead; ownerSha256: string; relativePath: string; bytes: string }): Promise<MasterInventoryIntent> {
    // Freeze before the first await: a committed intent must not be compared with
    // a caller's subsequently changed input object.
    const frozen = { expectedHead: { seq: input.expectedHead.seq, sha256: input.expectedHead.sha256 },
      ownerSha256: input.ownerSha256, relativePath: input.relativePath, bytes: input.bytes };
    head(frozen.expectedHead);
    check(sha.test(frozen.ownerSha256) && stagePath(frozen.relativePath) && typeof frozen.bytes === "string" && Buffer.byteLength(frozen.bytes) <= 24_000, "stage intent input invalid");
    const row = await invoke(this.request("append", frozen));
    fields(row, ["schema", "action", "masterId", "head", "relativePath", "artifactSha256"]);
    const checkpoint = head(row.head);
    check(checkpoint.seq === frozen.expectedHead.seq + 1 && row.relativePath === frozen.relativePath && row.artifactSha256 === hash(frozen.bytes), "append result differs from intent");
    return { head: checkpoint, relativePath: frozen.relativePath, artifactSha256: row.artifactSha256 as string };
  }
  async lookup(relativePath: string): Promise<MasterInventoryArtifact> {
    check(path.test(relativePath), "artifact lookup path invalid");
    const row = await invoke(this.request("lookup", { relativePath }));
    fields(row, ["schema", "action", "masterId", "head", "state", "artifactCount", "missing", "relativePath", "bytes", "artifactSha256"]);
    const audit = this.auditResult(row);
    check(row.relativePath === relativePath && typeof row.bytes === "string" && Buffer.byteLength(row.bytes) <= 24_000 &&
      typeof row.artifactSha256 === "string" && sha.test(row.artifactSha256) && row.artifactSha256 === hash(row.bytes), "indexed artifact invalid");
    return { ...audit, relativePath, bytes: row.bytes as string, artifactSha256: row.artifactSha256 };
  }
}
