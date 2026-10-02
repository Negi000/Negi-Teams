// Independent candidate primitive. Not connected to MasterConversationAuthority,
// provider RPC, startup, owner recovery or UI until migration/recovery gates pass.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MasterInventoryHead { seq: number; sha256: string }
export interface MasterInventoryAudit {
  head: MasterInventoryHead; state: "clean" | "pending"; artifactCount: number; missing: string[];
}
export interface MasterInventoryIntent { head: MasterInventoryHead; relativePath: string; artifactSha256: string }
export interface MasterInventoryArtifact extends MasterInventoryAudit {
  relativePath: string; bytes: string; artifactSha256: string;
}
export interface MasterInventoryProcessIdentity { platform: "windows" | "linux"; pid: number; startToken: string }
const sha = /^[0-9a-f]{64}$/;
const path = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/0[0-4]-(requested|old_idle|start_dispatched|bound|completed|cancelled|needs_reconciliation)\.json$/;
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Master inventory: " + reason); }
function fields(value: Record<string, unknown>, names: string[]) {
  check(Object.keys(value).sort().join() === names.sort().join(), "helper result fields");
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function head(value: unknown): MasterInventoryHead {
  check(value && typeof value === "object" && !Array.isArray(value), "checkpoint required");
  const row = value as Record<string, unknown>;
  fields(row, ["seq", "sha256"]);
  check(Number.isSafeInteger(row.seq) && Number(row.seq) >= 0 && Number(row.seq) <= 50_000 && typeof row.sha256 === "string" && sha.test(row.sha256), "checkpoint invalid");
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
  const input = JSON.stringify(request) + "\n";
  check(Buffer.byteLength(input) <= 100_000, "input too large");
  const filename = await script();
  // No shell, no payload/key in command line. Wait for exit even after timeout.
  const output = await new Promise<string>((accept, reject) => {
    const child = spawn("python", ["-B", filename], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let stdout = "", stderr = "", size = 0, failure: Error | null = null;
    const timer = setTimeout(() => { failure = Error("Master inventory: helper timeout; operation outcome needs inspection"); child.kill(); }, 30_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 8_000_000) { failure = Error("Master inventory: helper output limit"); child.kill(); }
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 500); });
    child.on("error", error => { failure = error; });
    child.stdin.on("error", error => { failure ??= error; });
    child.on("close", code => { clearTimeout(timer); if (failure) reject(failure);
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
  private auditResult(row: Record<string, unknown>): MasterInventoryAudit {
    const checkpoint = head(row.head);
    check(["clean", "pending"].includes(String(row.state)) && Number.isSafeInteger(row.artifactCount) &&
      Number(row.artifactCount) >= 0 && Number(row.artifactCount) <= 50_000 && Array.isArray(row.missing) &&
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
    check(sha.test(frozen.ownerSha256) && path.test(frozen.relativePath) && typeof frozen.bytes === "string" && Buffer.byteLength(frozen.bytes) <= 24_000, "stage intent input invalid");
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
