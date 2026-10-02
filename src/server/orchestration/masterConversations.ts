// Candidate server-owned empty-thread transactions; production uses only the read-only startup audit.
// The writer is not connected to provider RPC/UI until inventory, performance and owner recovery gates pass.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodexThreadIdentity } from "../master/appServerClient.ts";
import { assertMasterIdleEvidence } from "./masterIdleEvidence.ts";
import { readMasterTurnArtifact as artifact, verifyMasterTurnDirectory as directory } from "./masterTurnRecords.ts";
import type { FileScheduler } from "./scheduler.ts";

type Stage = "requested" | "old_idle" | "start_dispatched" | "bound" | "completed" | "cancelled" | "needs_reconciliation";
export interface MasterConversationRequest {
  requestId: string; masterId: string; mode: "start" | "rotate"; oldThreadId: string | null;
  cwd: string; model: string; effort: string; provider: string | null; settingsSha256: string;
}
interface RecordPayload {
  schemaVersion: "negi-master-conversation/1"; request: MasterConversationRequest;
  stage: Stage; previousSha256: string | null; identity: CodexThreadIdentity | null;
  reason: string | null; at: string;
}
export interface MasterConversationResult {
  request: MasterConversationRequest; stage: Stage; identity: CodexThreadIdentity | null; reason: string | null;
}
export interface MasterConversationStatus extends MasterConversationResult { exclusionHeld: boolean }
interface Operation { path: string; records: RecordPayload[]; bytes: string[] }
export class MasterConversationHeldError extends Error {
  constructor(message = "統括の会話または実行記録の照合が必要です。新しい処理は開始していません。") {
    super(message); this.name = "MasterConversationHeldError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Master conversation evidence: " + reason); }
function inside(root: string, path: string) {
  const rel = relative(process.platform === "win32" ? root.toLowerCase() : root, process.platform === "win32" ? path.toLowerCase() : path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function writeNew(path: string, bytes: string) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes, "utf8"); await file.sync(); } finally { await file.close(); }
}
function validRequest(value: MasterConversationRequest): boolean {
  return Object.keys(value).length === 9 && uuid.test(value.requestId) && /^[a-zA-Z0-9_-]{1,100}$/.test(value.masterId) &&
    ["start", "rotate"].includes(value.mode) && (value.mode === "start" ? value.oldThreadId === null : token(value.oldThreadId)) &&
    typeof value.cwd === "string" && isAbsolute(value.cwd) && token(value.model) && token(value.effort) &&
    (value.provider === null || token(value.provider)) && /^[0-9a-f]{64}$/.test(value.settingsSha256);
}
function validateIdentity(identity: CodexThreadIdentity, request: MasterConversationRequest) {
  check(identity && Object.keys(identity).length === 5 && token(identity.threadId) && identity.threadId !== request.oldThreadId &&
    identity.requestedModel === request.model && identity.resolvedModel === request.model && identity.rerouted === false &&
    token(identity.modelProvider) && (request.provider === null || identity.modelProvider === request.provider), "thread identity or pinned model/provider mismatch");
}
function nextStage(previous: Stage | null, next: Stage) {
  if (previous === null) return next === "requested";
  if (next === "cancelled") return ["requested", "old_idle"].includes(previous);
  if (next === "needs_reconciliation") return ["start_dispatched", "bound"].includes(previous);
  return ({ requested: "old_idle", old_idle: "start_dispatched", start_dispatched: "bound", bound: "completed" } as Partial<Record<Stage, Stage>>)[previous] === next;
}

export class MasterConversationAuthority {
  private readonly root: string;
  constructor(private readonly options: { root: string; turnRoot: string; masterId: string; scheduler: FileScheduler }) {
    check(isAbsolute(options.root) && isAbsolute(options.turnRoot) && /^[a-zA-Z0-9_-]{1,100}$/.test(options.masterId), "server registration invalid");
    this.root = resolve(options.root);
  }

  private async prepare(cwd: string) {
    const canonicalCwd = await realpath(resolve(cwd));
    await directory(dirname(this.root));
    check(!inside(canonicalCwd, this.root) && !inside(canonicalCwd, this.options.turnRoot) && !inside(canonicalCwd, this.options.scheduler.path), "state must be outside the checkout");
    await mkdir(this.root, { recursive: true }); await directory(this.root);
    const entries = await readdir(this.root);
    check(entries.every(name => ["signing-key.json", "masters"].includes(name)), "unexpected authority entry");
    let key = await artifact(join(this.root, "signing-key.json"), 1000);
    if (!key) {
      if (entries.includes("masters")) { await directory(join(this.root, "masters")); check((await readdir(join(this.root, "masters"))).length === 0, "signing key missing for existing records"); }
      try { await writeNew(join(this.root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: randomBytes(32).toString("hex") }) + "\n"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      key = await artifact(join(this.root, "signing-key.json"), 1000);
    }
    check(key && Object.keys(key.value).length === 2 && key.value.schemaVersion === "negi-master-conversation-key/1" &&
      typeof key.value.key === "string" && /^[0-9a-f]{64}$/.test(key.value.key), "signing key invalid");
    const masters = join(this.root, "masters"); await mkdir(masters, { recursive: true }); await directory(masters);
    const master = join(masters, this.options.masterId); await mkdir(master, { recursive: true }); await directory(master);
    return { master, key: Buffer.from(key.value.key, "hex"), keyBytes: key.bytes, canonicalCwd };
  }

  private async withLock<T>(cwd: string, run: (state: Awaited<ReturnType<MasterConversationAuthority["prepare"]>>) => Promise<T>): Promise<T> {
    let state;
    try { state = await this.prepare(cwd); } catch { throw new MasterConversationHeldError(); }
    const path = join(state.master, "owner.lock");
    const bytes = JSON.stringify({ schemaVersion: "negi-master-conversation-owner/1", nonce: randomUUID(), pid: process.pid }) + "\n";
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch { throw new MasterConversationHeldError("会話の変更または実行受付が進行中か、所有者の照合が必要です。自動では再試行しません。"); }
    const pinned = await file.stat();
    try {
      await file.writeFile(bytes, "utf8"); await file.sync();
      return await run(state);
    } finally {
      try {
        const current = await lstat(path), record = await artifact(path, 8000);
        check(current.dev === pinned.dev && current.ino === pinned.ino && record?.bytes === bytes, "owner lock replaced; keep hold");
        await unlink(path); // Remove only this exact live owner; never steal an old lock.
      } finally { await file.close(); }
    }
  }

  private async readOperation(path: string, key: Buffer): Promise<Operation> {
    const identity = await directory(path), names = (await readdir(path)).sort();
    check(uuid.test(path.substring(path.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1)) && names.length > 0 && names.length <= 5, "operation directory invalid");
    const operation: Operation = { path, records: [], bytes: [] };
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      check(/^0[0-4]-[a-z_]+\.json$/.test(name) && name.startsWith(`0${index}-`), "noncontiguous journal");
      const record = await artifact(join(path, name), 24_000);
      check(record && Object.keys(record.value).length === 2 && record.value.payload && typeof record.value.payload === "object" && !Array.isArray(record.value.payload) &&
        typeof record.value.signature === "string" && /^[0-9a-f]{64}$/.test(record.value.signature), "signed record shape");
      const payload = record.value.payload as RecordPayload;
      const signature = createHmac("sha256", key).update(JSON.stringify(payload)).digest();
      check(timingSafeEqual(signature, Buffer.from(record.value.signature, "hex")), "record signature mismatch");
      check(Object.keys(payload).length === 7 && payload.schemaVersion === "negi-master-conversation/1" && payload.request &&
        validRequest(payload.request) && payload.request.masterId === this.options.masterId && path.endsWith(payload.request.requestId) &&
        name === `0${index}-${payload.stage}.json` && nextStage(operation.records.at(-1)?.stage ?? null, payload.stage) &&
        payload.previousSha256 === (operation.bytes.length ? hash(operation.bytes.at(-1)!) : null) &&
        (index === 0 || isDeepStrictEqual(payload.request, operation.records[0]!.request)) &&
        typeof payload.at === "string" && Number.isFinite(Date.parse(payload.at)) &&
        (payload.reason === null || (typeof payload.reason === "string" && payload.reason.length <= 1000)), "journal identity/transition");
      if (payload.identity) validateIdentity(payload.identity, payload.request);
      if (["bound", "completed"].includes(payload.stage)) check(payload.identity, "bound identity missing");
      if (!["bound", "completed", "needs_reconciliation"].includes(payload.stage)) check(payload.identity === null, "unexpected identity");
      if (operation.records.at(-1)?.identity) check(isDeepStrictEqual(payload.identity, operation.records.at(-1)!.identity), "bound identity changed");
      operation.records.push(payload); operation.bytes.push(record.bytes);
    }
    check(identity === await directory(path) && isDeepStrictEqual(names, (await readdir(path)).sort()), "operation changed while reading");
    for (let index = 0; index < names.length; index++) check((await artifact(join(path, names[index]!), 24_000))?.bytes === operation.bytes[index], "stage changed while reading");
    return operation;
  }

  private async operations(master: string, key: Buffer) {
    const identity = await directory(master), names = (await readdir(master)).filter(name => name !== "owner.lock").sort();
    check(names.length <= 10_000 && names.every(name => uuid.test(name)), "unexpected Master conversation entry");
    const operations: Operation[] = [];
    for (const name of names) operations.push(await this.readOperation(join(master, name), key));
    check(identity === await directory(master) && isDeepStrictEqual(names, (await readdir(master)).filter(name => name !== "owner.lock").sort()), "Master conversation inventory changed");
    return operations;
  }
  private async idle(state: Awaited<ReturnType<MasterConversationAuthority["prepare"]>>) {
    const operations = await this.operations(state.master, state.key);
    check(operations.every(op => ["completed", "cancelled"].includes(op.records.at(-1)!.stage)), "unfinished conversation transaction");
    await assertMasterIdleEvidence(this.options.turnRoot, this.options.masterId, this.options.scheduler);
    check((await artifact(join(this.root, "signing-key.json"), 1000))?.bytes === state.keyBytes, "signing key changed");
    return operations;
  }

  /** Candidate writer audit; not used by production startup or normal turn dispatch. */
  async assertIdle(cwd: string): Promise<void> {
    await this.withLock(cwd, async state => { try { await this.idle(state); } catch { throw new MasterConversationHeldError(); } });
  }
  /** Turn reservation and empty-thread rotation use this same per-Master lock. */
  async admitTurn<T>(cwd: string, reserve: () => Promise<T>): Promise<T> {
    return this.withLock(cwd, async state => { try { await this.idle(state); } catch { throw new MasterConversationHeldError(); } return reserve(); });
  }

  private async startupEvidence() {
    await directory(dirname(this.root));
    let rootIdentity: string;
    try { rootIdentity = await directory(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const names = (await readdir(this.root)).sort();
    check(isDeepStrictEqual(names, ["masters", "signing-key.json"]), "startup authority entries invalid");
    const key = await artifact(join(this.root, "signing-key.json"), 1000);
    check(key && Object.keys(key.value).length === 2 && key.value.schemaVersion === "negi-master-conversation-key/1" &&
      typeof key.value.key === "string" && /^[0-9a-f]{64}$/.test(key.value.key), "startup signing key invalid");
    const masters = join(this.root, "masters"), mastersIdentity = await directory(masters);
    const mastersNames = (await readdir(masters)).sort();
    check(mastersNames.length <= 10_000 && mastersNames.every(name => /^[a-zA-Z0-9_-]{1,100}$/.test(name)), "startup Master inventory invalid");
    const master = join(masters, this.options.masterId);
    let masterIdentity: string | null = null;
    try { masterIdentity = await directory(master); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let operations: Operation[] = [];
    if (masterIdentity) {
      check(await artifact(join(master, "owner.lock"), 8000) === null, "conversation owner requires reconciliation");
      operations = await this.operations(master, Buffer.from(key.value.key, "hex"));
      check(operations.every(op => ["completed", "cancelled"].includes(op.records.at(-1)!.stage)), "conversation transaction incomplete");
    }
    check(rootIdentity === await directory(this.root) && mastersIdentity === await directory(masters) &&
      isDeepStrictEqual(names, (await readdir(this.root)).sort()) && isDeepStrictEqual(mastersNames, (await readdir(masters)).sort()) &&
      (await artifact(join(this.root, "signing-key.json"), 1000))?.bytes === key.bytes, "startup authority changed");
    return { rootIdentity, mastersIdentity, mastersNames, masterIdentity, keyBytes: key.bytes, operations };
  }

  /** Production bootstrap audit. Read-only: no signing key, journal, owner lock or repair. */
  async assertStartupSafe(cwd: string): Promise<void> {
    try {
      const canonical = await realpath(resolve(cwd));
      check(!inside(canonical, this.root) && !inside(canonical, this.options.turnRoot) && !inside(canonical, this.options.scheduler.path), "state inside checkout");
      const before = await this.startupEvidence();
      await assertMasterIdleEvidence(this.options.turnRoot, this.options.masterId, this.options.scheduler);
      check(isDeepStrictEqual(before, await this.startupEvidence()), "startup authority changed during turn audit");
    } catch { throw new MasterConversationHeldError(); }
  }

  /** Read the same request after reconnect/crash. No mkdir, key creation, replay or lock stealing. */
  async status(requestId: string): Promise<MasterConversationStatus | null> {
    check(uuid.test(requestId), "request ID invalid");
    try {
      let rootIdentity: string;
      try { rootIdentity = await directory(this.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const key = await artifact(join(this.root, "signing-key.json"), 1000);
      check(key && Object.keys(key.value).length === 2 && key.value.schemaVersion === "negi-master-conversation-key/1" &&
        typeof key.value.key === "string" && /^[0-9a-f]{64}$/.test(key.value.key), "status signing key invalid");
      await directory(join(this.root, "masters"));
      const master = join(this.root, "masters", this.options.masterId);
      try { await directory(master); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const operations = await this.operations(master, Buffer.from(key.value.key, "hex"));
      const owner = await artifact(join(master, "owner.lock"), 8000);
      if (owner) check(Object.keys(owner.value).length === 3 && owner.value.schemaVersion === "negi-master-conversation-owner/1" &&
        uuid.test(String(owner.value.nonce)) && Number.isSafeInteger(owner.value.pid) && Number(owner.value.pid) > 0, "status owner invalid");
      check(rootIdentity === await directory(this.root) && (await artifact(join(this.root, "signing-key.json"), 1000))?.bytes === key.bytes, "status authority changed");
      const last = operations.find(op => op.records[0]!.request.requestId === requestId)?.records.at(-1);
      return last ? structuredClone({ request: last.request, stage: last.stage, identity: last.identity, reason: last.reason, exclusionHeld: owner !== null }) : null;
    } catch { throw new MasterConversationHeldError(); }
  }

  /** A trusted callback must persist dispatch intent immediately before thread/start. */
  async start(raw: MasterConversationRequest, run: (markDispatched: () => Promise<void>) => Promise<CodexThreadIdentity>): Promise<MasterConversationResult> {
    const request = structuredClone(raw);
    check(validRequest(request) && request.masterId === this.options.masterId, "request invalid");
    request.cwd = await realpath(resolve(request.cwd));
    check(Buffer.byteLength(JSON.stringify(request)) <= 16_000, "request exceeds durable record bound");
    return this.withLock(request.cwd, async state => {
      const operations = await this.operations(state.master, state.key);
      const existing = operations.find(op => op.records[0]!.request.requestId === request.requestId);
      if (existing) {
        check(isDeepStrictEqual(existing.records[0]!.request, request), "request ID reused for different conditions");
        const last = existing.records.at(-1)!;
        return structuredClone({ request, stage: ["completed", "cancelled"].includes(last.stage) ? last.stage : "needs_reconciliation", identity: last.identity, reason: last.reason });
      }
      try { await this.idle(state); } catch { throw new MasterConversationHeldError(); }
      const path = join(state.master, request.requestId); await mkdir(path);
      const operation: Operation = { path, records: [], bytes: [] };
      const append = async (stage: Stage, identity: CodexThreadIdentity | null = null, reason: string | null = null) => {
        check(nextStage(operation.records.at(-1)?.stage ?? null, stage), "invalid transition");
        check((await artifact(join(this.root, "signing-key.json"), 1000))?.bytes === state.keyBytes, "signing key changed");
        const payload: RecordPayload = { schemaVersion: "negi-master-conversation/1", request, stage,
          previousSha256: operation.bytes.length ? hash(operation.bytes.at(-1)!) : null, identity, reason, at: new Date().toISOString() };
        const signature = createHmac("sha256", state.key).update(JSON.stringify(payload)).digest("hex");
        const bytes = JSON.stringify({ payload, signature }) + "\n";
        await writeNew(join(path, `0${operation.records.length}-${stage}.json`), bytes);
        operation.records.push(payload); operation.bytes.push(bytes);
      };
      await append("requested"); await append("old_idle");
      let dispatched = false, marking = false;
      try {
        const identity = structuredClone(await run(async () => {
          check(!dispatched && !marking, "dispatch intent already requested"); marking = true;
          await append("start_dispatched"); dispatched = true;
        }));
        check(dispatched, "provider callback omitted dispatch intent");
        validateIdentity(identity, request);
        await append("bound", identity); await append("completed", identity);
        return structuredClone({ request, stage: "completed", identity, reason: null });
      } catch {
        // Failed intent persistence may leave a partial file; never reinterpret it as unsent.
        const uncertain = dispatched || marking;
        try { await append(uncertain ? "needs_reconciliation" : "cancelled", operation.records.at(-1)?.identity ?? null,
          uncertain ? "thread/start or its durable outcome is unknown; inspect this request before continuing" : "thread/start was not dispatched"); }
        catch { /* Partial/unknown evidence remains a startup hold; no replay. */ }
        throw new MasterConversationHeldError(uncertain ? "新しい会話の作成結果を確認できません。同じ要求の照合が必要です。自動では再作成しません。" : "新しい会話は未作成です。準備を確認してから、別の要求で明示的に再試行してください。");
      }
    });
  }
}
