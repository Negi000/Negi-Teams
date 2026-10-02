import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TaskStorageRegistration } from "./taskService.ts";
import { FileScheduler } from "./scheduler.ts";

type Registration = Readonly<TaskStorageRegistration & { masterId: string }>;
const sha = /^[0-9a-f]{64}$/;
export class StorageBootstrap {
  private readonly registration: Registration;
  constructor(registration: Registration) { this.registration = Object.freeze({ ...registration }); }
  private async invoke(action: "preview" | "status" | "apply", proof?: { decisionId: string; expectedProofSha256: string }) {
    const input = JSON.stringify({ action, registration: this.registration, ...proof }) + "\n";
    if (Buffer.byteLength(input) > 24000) throw Error("Storage bootstrap input limit");
    let path = fileURLToPath(new URL("../../../scripts/negi_storage_bootstrap.py", import.meta.url));
    try { await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      path = fileURLToPath(new URL("../../../../scripts/negi_storage_bootstrap.py", import.meta.url));
    }
    const info = await lstat(path);if (!info.isFile() || info.isSymbolicLink()) throw Error("Storage bootstrap helper invalid");
    const output = await new Promise<string>((accept, reject) => {
      const child = spawn("python", ["-B", path], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "", size = 0, failure: Error | null = null;
      child.stdout.setEncoding("utf8");child.stderr.resume();
      child.stdout.on("data", (chunk: string) => { size += Buffer.byteLength(chunk);if (size > 24000) { failure = Error("Storage bootstrap output limit");child.kill(); } else stdout += chunk; });
      child.on("error", error => { failure = error; });child.stdin.on("error", error => { failure ??= error; });
      // Publication/handle cleanup must reach actual close; elapsed time is not
      // proof that a signed intent or native directory move did not commit.
      child.on("close", code => { if (failure || code !== 0) reject(failure ?? Error("Storage bootstrap held"));else accept(stdout); });
      child.stdin.end(input);
    });
    const row = JSON.parse(output) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row) || JSON.stringify(row) + "\n" !== output ||
        row.schema !== "negi-storage-bootstrap-result/1" || row.action !== action || action !== "status" && (typeof row.proofSha256 !== "string" || !sha.test(row.proofSha256))) throw Error("Storage bootstrap result invalid");
    return row;
  }
  async preview() {
    const row = await this.invoke("preview");
    if (Object.keys(row).sort().join() !== "action,createsAuthority,decisionId,masterCount,proofSha256,publicationComplete,schedulerBytes,schedulerPresent,schedulerSha256,schema" || row.masterCount !== 1 || row.createsAuthority !== true ||
        typeof row.schedulerSha256 !== "string" || !sha.test(row.schedulerSha256) || !Number.isSafeInteger(row.schedulerBytes) || Number(row.schedulerBytes) < 0 || Number(row.schedulerBytes) > 64000000 ||
        typeof row.schedulerPresent !== "boolean" || typeof row.publicationComplete !== "boolean" ||
        typeof row.decisionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.decisionId)) throw Error("Storage bootstrap preview invalid");
    // Use the existing reducer without opening a writer or bypassing its normal
    // persistent fence. Native proof binds these exact bytes before publication.
    // Completed publication is a historical ACK: a later runtime fault must not
    // prevent acknowledgement of this original root/key/turns/receipt decision.
    if (!row.publicationComplete) {
      const reader = new FileScheduler(this.registration.schedulerPath, { journal: {
        withStorage: run => run(), audit: async snapshot => {
          if (snapshot.path !== this.registration.schedulerPath ||
              (createHash("sha256").update(snapshot.bytes).digest("hex") !== row.schedulerSha256 || Buffer.byteLength(snapshot.bytes) !== row.schedulerBytes))
            throw Error("Storage bootstrap scheduler differs from preview");
        }, appendIntent: async () => { throw Error("Storage bootstrap inspection cannot append"); }
      } });
      await reader.read();
      const after = await this.invoke("preview");
      const withoutId = (value: Record<string, unknown>) => { const copy = { ...value };delete copy.decisionId;return JSON.stringify(copy); };
      if (withoutId(after) !== withoutId(row)) throw Error("Storage bootstrap changed during scheduler inspection");
    }
    return { proofSha256: row.proofSha256 as string, decisionId: row.decisionId, masterCount: 1, createsAuthority: true };
  }
  async status(): Promise<{ state: "available" | "existing" | "pending" | "ready" | "held" }> {
    try {
      const row = await this.invoke("status");
      if (Object.keys(row).sort().join() !== "action,schema,state" || !["available", "existing", "pending", "ready"].includes(String(row.state))) throw Error("Storage bootstrap state invalid");
      return { state: row.state as "available" | "existing" | "pending" | "ready" };
    } catch { return { state: "held" }; }
  }
  async apply(proof: { decisionId: string; expectedProofSha256: string }) {
    const frozen = { ...proof }, preview = await this.preview();
    if (preview.proofSha256 !== frozen.expectedProofSha256) throw Error("Storage bootstrap preview proof changed");
    const row = await this.invoke("apply", frozen);
    if (Object.keys(row).sort().join() !== "action,decisionId,initialized,proofSha256,schema" || row.decisionId !== frozen.decisionId ||
        row.proofSha256 !== frozen.expectedProofSha256 || row.initialized !== true) throw Error("Storage bootstrap accepted decision differs");
    return { decisionId: frozen.decisionId, proofSha256: frozen.expectedProofSha256, initialized: true };
  }
}
