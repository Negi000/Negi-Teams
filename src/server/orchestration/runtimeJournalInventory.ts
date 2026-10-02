import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MasterTurnJournal } from "./masterTurnAdmission.ts";
import { FileScheduler, type SchedulerJournal } from "./scheduler.ts";
import { masterStorageTicket, withMasterStorageGuard } from "./masterStorageGuard.ts";
import { runtimeStoragePaths } from "./runtimeStoragePaths.ts";

export interface RuntimeHead { seq: number; sha256: string }
export interface RuntimeBaselinePreview { proofSha256: string; schedulerSha256: string; schedulerBytes: number; schedulerPresent: boolean; artifactCount: number }
export interface RuntimeInventoryAudit extends Omit<RuntimeBaselinePreview, "proofSha256"> {
  head: RuntimeHead; state: "clean" | "pending"; missing: string[];
}
const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const target = /^master-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(request|dispatch|provider|outcome|not-sent)\.json$/;
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Runtime inventory: " + reason); }
function fields(value: Record<string, unknown>, expected: string[]) {
  check(Object.keys(value).sort().join() === [...expected].sort().join(), "helper result fields");
}

/** Trusted server registration only. Explicit baseline uses the existing signing
 * authority; reading never bootstraps/replays. Both journals share one guard and
 * a root-wide index, independently of each Master's stage checkpoint. */
export class RuntimeJournalInventory {
  readonly databasePath: string;
  readonly registrationPath: string;
  private readonly root: string;
  private readonly context: Readonly<{ turnRoot: string; schedulerPath: string }>;
  constructor(options: { root: string; turnRoot: string; schedulerPath: string }) {
    check([options.root, options.turnRoot, options.schedulerPath].every(isAbsolute), "absolute server registration required");
    this.root = resolve(options.root);
    this.context = Object.freeze({ turnRoot: resolve(options.turnRoot), schedulerPath: resolve(options.schedulerPath) });
    const paths = runtimeStoragePaths(this.context.schedulerPath);
    this.databasePath = paths.database; this.registrationPath = paths.registration;
  }
  withStorage<T>(run: () => Promise<T>): Promise<T> {
    return withMasterStorageGuard(this.root, run, { createIfMissing: false });
  }
  private async invoke(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const frozen = structuredClone(extra);
    return this.withStorage(async () => {
      let filename = fileURLToPath(new URL("../../../scripts/negi_runtime_inventory.py", import.meta.url));
      try { await lstat(filename); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        filename = fileURLToPath(new URL("../../../../scripts/negi_runtime_inventory.py", import.meta.url));
      }
      const info = await lstat(filename); check(info.isFile() && !info.isSymbolicLink(), "fixed helper unavailable");
      const input = JSON.stringify({ action, root: this.root, context: this.context, ...frozen, storageTicket: masterStorageTicket(this.root) }) + "\n";
      check(Buffer.byteLength(input) <= 8_000_000, "input too large");
      const output = await new Promise<string>((accept, reject) => {
        const child = spawn("python", ["-B", filename], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
        let stdout = "", stderr = "", size = 0, failure: Error | null = null;
        // Baseline and mutation may have committed already. Wait for actual exit;
        // an elapsed deadline must not kill its transaction/cleanup and retry it.
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 8_000_000) { failure = Error("Runtime inventory: output limit; inspect saved intent"); child.kill(); } else stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 300); });
        child.on("error", error => { failure = error; }); child.stdin.on("error", error => { failure ??= error; });
        child.on("close", code => { if (failure) reject(failure); else if (code !== 0) reject(Error("Runtime inventory held: " + stderr.trim())); else accept(stdout); });
        child.stdin.end(input);
      });
      const value: unknown = JSON.parse(output);
      check(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(value) + "\n" === output, "noncanonical helper result");
      const row = value as Record<string, unknown>;
      check(row.schema === "negi-runtime-result/1" && row.action === action, "helper action mismatch");
      return row;
    });
  }
  private summary(row: Record<string, unknown>): Omit<RuntimeBaselinePreview, "proofSha256"> {
    check(typeof row.schedulerSha256 === "string" && sha.test(row.schedulerSha256) && Number.isSafeInteger(row.schedulerBytes) &&
      Number(row.schedulerBytes) >= 0 && Number(row.schedulerBytes) <= 64_000_000 && Number.isSafeInteger(row.artifactCount) &&
      Number(row.artifactCount) >= 0 && Number(row.artifactCount) <= 50_000 && typeof row.schedulerPresent === "boolean", "inventory summary invalid");
    return { schedulerSha256: row.schedulerSha256, schedulerBytes: Number(row.schedulerBytes), schedulerPresent: row.schedulerPresent, artifactCount: Number(row.artifactCount) };
  }
  private auditResult(row: Record<string, unknown>): RuntimeInventoryAudit {
    const result = this.summary(row), head = row.head as RuntimeHead;
    check(head && typeof head === "object" && !Array.isArray(head), "head missing"); fields(head as unknown as Record<string, unknown>, ["seq", "sha256"]);
    check(Number.isSafeInteger(head.seq) && head.seq >= 1 && head.seq <= 100_000 && sha.test(head.sha256) &&
      Array.isArray(row.missing) && row.missing.length <= result.artifactCount + 1 && row.missing.every(path => typeof path === "string" && (path === "scheduler" || target.test(path))) &&
      new Set(row.missing).size === row.missing.length && row.state === (row.missing.length ? "pending" : "clean"), "audit state invalid");
    return { ...result, head: { ...head }, missing: row.missing as string[], state: row.state as "clean" | "pending" };
  }
  async previewBaseline(): Promise<RuntimeBaselinePreview> {
    return this.withStorage(async () => {
      const row = await this.invoke("preview"); fields(row, ["schema", "action", "proofSha256", "schedulerSha256", "schedulerBytes", "schedulerPresent", "artifactCount"]);
      check(typeof row.proofSha256 === "string" && sha.test(row.proofSha256), "baseline proof invalid");
      const summary = this.summary(row);
      // A completed initial authority has already fenced default writers. Use
      // the same FileScheduler reducer in a private, read-only registration,
      // bound to the native pre/post preview. Never expose an unindexed writer.
      const reader = new FileScheduler(this.context.schedulerPath, { journal: {
        withStorage: run => this.withStorage(run),
        audit: async snapshot => {
          check(snapshot.path === this.context.schedulerPath && hash(snapshot.bytes) === summary.schedulerSha256 &&
            Buffer.byteLength(snapshot.bytes) === summary.schedulerBytes, "baseline scheduler differs from native preview");
        },
        appendIntent: async () => { throw Error("Baseline inspection cannot append scheduler events"); }
      } });
      await reader.read();
      check(JSON.stringify(await this.invoke("preview")) === JSON.stringify(row), "baseline changed during semantic inspection");
      return { ...summary, proofSha256: row.proofSha256 };
    });
  }
  async adoptBaseline(input: { decisionId: string; expectedProofSha256: string }): Promise<RuntimeInventoryAudit> {
    const frozen = { decisionId: input.decisionId, expectedProofSha256: input.expectedProofSha256 };
    check(uuid.test(frozen.decisionId) && sha.test(frozen.expectedProofSha256), "explicit decision/proof required");
    const row = await this.invoke("adopt", frozen);
    fields(row, ["schema", "action", "head", "state", "missing", "schedulerSha256", "schedulerBytes", "schedulerPresent", "artifactCount", "decisionId", "proofSha256"]);
    check(row.decisionId === frozen.decisionId && row.proofSha256 === frozen.expectedProofSha256, "baseline decision differs");
    return this.auditResult(row);
  }
  async audit(): Promise<RuntimeInventoryAudit> {
    const row = await this.invoke("audit"); fields(row, ["schema", "action", "head", "state", "missing", "schedulerSha256", "schedulerBytes", "schedulerPresent", "artifactCount"]);
    return this.auditResult(row);
  }
  private async clean(): Promise<RuntimeInventoryAudit> {
    const audit = await this.audit(); check(audit.state === "clean", "pending storage; preserve original intent"); return audit;
  }
  private verifyAppend(row: Record<string, unknown>, previous: RuntimeHead, bytes: string) {
    fields(row, ["schema", "action", "head", "dataSha256"]);
    const head = row.head as RuntimeHead;
    check(head && typeof head === "object" && !Array.isArray(head), "append head missing"); fields(head as unknown as Record<string, unknown>, ["seq", "sha256"]);
    check(head.seq === previous.seq + 1 && sha.test(head.sha256) && row.dataSha256 === hash(bytes), "committed intent differs");
  }
  schedulerJournal(): SchedulerJournal {
    return Object.freeze({ withStorage: <T>(run: () => Promise<T>) => this.withStorage(run),
      audit: async snapshot => {
        check(snapshot.path === this.context.schedulerPath, "scheduler registration changed");
        const row = await this.invoke("auditScheduler", { schedulerSha256: hash(snapshot.bytes), schedulerBytes: Buffer.byteLength(snapshot.bytes) });
        fields(row, ["schema", "action", "head", "state", "missing", "schedulerSha256", "schedulerBytes", "schedulerPresent", "artifactCount"]);
        check(this.auditResult(row).state === "clean", "pending storage; preserve original intent");
      },
      appendIntent: async input => {
        const frozen = structuredClone(input); check(frozen.path === this.context.schedulerPath, "scheduler registration changed");
        const before = await this.clean();
        const row = await this.invoke("appendScheduler", { expectedHead: before.head, bytes: frozen.bytes,
          previousSha256: hash(frozen.previousBytes), previousBytes: Buffer.byteLength(frozen.previousBytes) });
        this.verifyAppend(row, before.head, frozen.bytes);
      } } satisfies SchedulerJournal);
  }
  turnJournal(): MasterTurnJournal {
    return Object.freeze({ withStorage: <T>(run: () => Promise<T>) => this.withStorage(run), audit: async () => { await this.clean(); },
      appendIntent: async input => {
        const frozen = structuredClone(input), relativePath = frozen.workId + "/" + frozen.relativePath;
        check(target.test(relativePath), "turn target invalid");
        const before = await this.clean(); const row = await this.invoke("appendTurn", { expectedHead: before.head, relativePath, bytes: frozen.bytes });
        this.verifyAppend(row, before.head, frozen.bytes);
      } } satisfies MasterTurnJournal);
  }
}
