// Candidate server-owned empty-thread transactions; production uses only the read-only startup audit.
// The writer is not connected to provider RPC/UI until inventory, performance and full reconciliation gates pass.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodexThreadIdentity } from "../master/appServerClient.ts";
import { assertMasterIdleEvidence } from "./masterIdleEvidence.ts";
import { readMasterTurnArtifact as artifact, verifyMasterTurnDirectory as directory } from "./masterTurnRecords.ts";
import type { FileScheduler } from "./scheduler.ts";
import { masterOwnerAuxiliary, masterOwnerEvidence, signedMasterOwner, validatedMasterOwner, type MasterOwnerKind, type MasterOwner } from "./masterConversationOwner.ts";
import { observeWriter, recoverWriter, type WriterOperation } from "./writerRecovery.ts";
import { guardMasterAdmission, scheduledMasterTurns, type MasterTurnRequest, type MasterTurnLease } from "./masterTurnAdmission.ts";

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
export interface MasterOwnerRecoveryPreview {
  ownerId:string; requestId:string; kind:MasterOwnerKind; ownerState:"live"|"dead"|"unknown";
  ownerSha256:string; proofSha256:string; canRelease:boolean; reason:string|null;
}
interface RecoveryPayload {
  schemaVersion:"negi-master-owner-recovery/1"; masterId:string; decisionId:string; cwdSha256:string;
  owner:MasterOwner; proofSha256:string; action:"release-owner-only"; at:string;
}
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
  constructor(private readonly options: { root: string; turnRoot: string; masterId: string; scheduler: FileScheduler; onReleased?: () => Promise<void> }) {
    check(isAbsolute(options.root) && isAbsolute(options.turnRoot) && /^[a-zA-Z0-9_-]{1,100}$/.test(options.masterId), "server registration invalid");
    this.root = resolve(options.root);
  }

  private async legacyInventoryAbsent(): Promise<boolean> {
    const database = this.root + ".inventory.sqlite3";
    const present = await Promise.all(["", "-journal", "-wal", "-shm"].map(async suffix => {
      try { await lstat(database + suffix); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }));
    // The owner/2 writer does not index stage or recovery receipt intents yet.
    // Even a valid DB must not silently admit this older writer. Do not open it
    // with SQLite: a read could roll back a hot journal before explicit recovery.
    return present.every(value => !value);
  }

  private async requireLegacyInventoryAbsent(): Promise<void> {
    try { if (await this.legacyInventoryAbsent()) return; } catch { /* Ambiguous access remains a hold. */ }
    throw new MasterConversationHeldError("会話の保存記録を照合してください。新しい操作は保留されています。");
  }

  /** Read-only compatibility gate for process/thread/turn dispatch and leases. */
  async assertStorageCompatible(): Promise<void> { await this.requireLegacyInventoryAbsent(); }

  private async prepare(cwd: string) {
    // Check before any mkdir or key creation, including when the entire old
    // authority disappeared but its independent sibling DB survived.
    await this.requireLegacyInventoryAbsent();
    const canonicalCwd = await realpath(resolve(cwd));
    await directory(dirname(this.root));
    check(!inside(canonicalCwd, this.root) && !inside(canonicalCwd, this.options.turnRoot) && !inside(canonicalCwd, this.options.scheduler.path), "state must be outside the checkout");
    await this.requireLegacyInventoryAbsent();
    await mkdir(this.root, { recursive: true }); await directory(this.root);
    const entries = await readdir(this.root);
    check(entries.every(name => ["signing-key.json", "masters"].includes(name)), "unexpected authority entry");
    let key = await artifact(join(this.root, "signing-key.json"), 1000);
    if (!key) {
      if (entries.includes("masters")) { await directory(join(this.root, "masters")); check((await readdir(join(this.root, "masters"))).length === 0, "signing key missing for existing records"); }
      await this.requireLegacyInventoryAbsent();
      try { await writeNew(join(this.root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: randomBytes(32).toString("hex") }) + "\n"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      key = await artifact(join(this.root, "signing-key.json"), 1000);
    }
    check(key && Object.keys(key.value).length === 2 && key.value.schemaVersion === "negi-master-conversation-key/1" &&
      typeof key.value.key === "string" && /^[0-9a-f]{64}$/.test(key.value.key), "signing key invalid");
    await this.requireLegacyInventoryAbsent();
    const masters = join(this.root, "masters"); await mkdir(masters, { recursive: true }); await directory(masters);
    await this.requireLegacyInventoryAbsent();
    const master = join(masters, this.options.masterId); await mkdir(master, { recursive: true }); await directory(master);
    await this.requireLegacyInventoryAbsent();
    return { master, key: Buffer.from(key.value.key, "hex"), keyBytes: key.bytes, canonicalCwd };
  }

  private async withLock<T>(cwd: string, run: (state: Awaited<ReturnType<MasterConversationAuthority["prepare"]>>) => Promise<T>,
      target?: { kind: MasterOwnerKind; operation: WriterOperation }): Promise<T> {
    let state;
    try { state = await this.prepare(cwd); } catch { throw new MasterConversationHeldError(); }
    const path = join(state.master, "owner.lock");
    const kind = target?.kind ?? "inspection";
    const operation: WriterOperation = target?.operation ?? { domain:"master-conversation", requestId:randomUUID(), hash:hash(JSON.stringify({masterId:this.options.masterId,cwd:state.canonicalCwd,kind})) };
    const evidenceOptions = { ...this.options, root:this.root, master:state.master };
    let evidenceSha256:string;
    try{evidenceSha256 = await masterOwnerEvidence(evidenceOptions,kind,operation.requestId);}catch{throw new MasterConversationHeldError();}
    const bytes = signedMasterOwner({ schema:"negi-master-conversation-owner/2", owner:randomUUID(), pid:process.pid,
      createdAt:new Date().toISOString(), masterId:this.options.masterId, kind, cwdSha256:hash(state.canonicalCwd), operation, evidenceSha256 },state.key);
    await this.requireLegacyInventoryAbsent();
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch { throw new MasterConversationHeldError("会話の変更または実行受付が進行中か、所有者の照合が必要です。自動では再試行しません。"); }
    const pinned = await file.stat();
    try {
      await file.writeFile(bytes, "utf8"); await file.sync();
      await this.requireLegacyInventoryAbsent();
      check(evidenceSha256 === await masterOwnerEvidence(evidenceOptions,kind,operation.requestId), "evidence changed before owner admission");
      await this.requireLegacyInventoryAbsent();
      return await run(state);
    } finally {
      try {
        // An index appearing during this operation makes its owner evidence
        // part of the required migration/reconciliation. Preserve it.
        await this.requireLegacyInventoryAbsent();
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

  private async operations(master: string, key: Buffer, pendingOwner?:string) {
    await this.recoveryDecisions(master,key,pendingOwner);
    const nativeGuard = await lstat(join(master,"owner-recovery-flock-v2.lock")).catch(error=>{
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return null;
    });
    if(nativeGuard)check(nativeGuard.isFile()&&!nativeGuard.isSymbolicLink()&&nativeGuard.nlink===1&&nativeGuard.size===0,"native guard invalid");
    const identity = await directory(master), names = (await readdir(master)).filter(name => !masterOwnerAuxiliary.includes(name)).sort();
    check(names.length <= 10_000 && names.every(name => uuid.test(name)), "unexpected Master conversation entry");
    const operations: Operation[] = [];
    for (const name of names) operations.push(await this.readOperation(join(master, name), key));
    check(identity === await directory(master) && isDeepStrictEqual(names, (await readdir(master)).filter(name => !masterOwnerAuxiliary.includes(name)).sort()), "Master conversation inventory changed");
    return operations;
  }

  private validateRecoveryRecord(value:Record<string,unknown>,name:string,key:Buffer) {
    const payload=value.payload as RecoveryPayload,signature=value.signature;
    check(Object.keys(value).length===2&&payload&&!Array.isArray(payload)&&Object.keys(payload).length===8&&payload.schemaVersion==="negi-master-owner-recovery/1"&&
      payload.masterId===this.options.masterId&&typeof payload.decisionId==="string"&&uuid.test(payload.decisionId)&&typeof payload.cwdSha256==="string"&&/^[0-9a-f]{64}$/.test(payload.cwdSha256)&&
      typeof payload.proofSha256==="string"&&/^[0-9a-f]{64}$/.test(payload.proofSha256)&&payload.action==="release-owner-only"&&
      typeof payload.at==="string"&&Number.isFinite(Date.parse(payload.at))&&typeof signature==="string"&&/^[0-9a-f]{64}$/.test(signature),"recovery shape");
    validatedMasterOwner(payload.owner as unknown as Record<string,unknown>,this.options.masterId,key);
    check(payload.owner.cwdSha256===payload.cwdSha256&&name===payload.owner.owner+".json"&&
      timingSafeEqual(createHmac("sha256",key).update(JSON.stringify(payload)).digest(),Buffer.from(signature,"hex")),"recovery signature/owner mismatch");
    return payload;
  }

  private async recoveryDecisions(master:string,key:Buffer,pendingOwner?:string) {
    const root=join(master,"recoveries");
    try {await directory(root);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
    const identity=await directory(root),names=(await readdir(root)).sort(),rows:Array<{payload:RecoveryPayload;bytes:string}>=[];
    check(names.length<=10_000,"recovery inventory limit");
    for(const name of names){
      const pending=/^\.pending-([0-9a-f-]{36})-([0-9a-f-]{36})\.json$/.exec(name);
      if(pending){
        check(pendingOwner===pending[1]&&uuid.test(pending[1]!)&&uuid.test(pending[2]!),"pending recovery requires its exact owner");
        const info=await lstat(join(root,name));check(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=8000,"unsafe pending recovery");
        continue; // Never treat incomplete staging bytes as an accepted decision.
      }
      check(/^[0-9a-f-]{36}\.json$/.test(name),"unexpected recovery entry");
      const record=await artifact(join(root,name),8000);check(record,"recovery record missing");
      const payload=this.validateRecoveryRecord(record.value,name,key);
      check(!rows.some(row=>row.payload.decisionId===payload.decisionId),"duplicate recovery decision");rows.push({payload,bytes:record.bytes});
    }
    check(identity===await directory(root)&&isDeepStrictEqual(names,(await readdir(root)).sort()),"recovery inventory changed");
    for(const row of rows)check((await artifact(join(root,row.payload.owner.owner+".json"),8000))?.bytes===row.bytes,"recovery decision changed");
    return rows;
  }

  private async recoveryState(cwd:string) {
    const canonicalCwd=await realpath(resolve(cwd));
    check(!inside(canonicalCwd,this.root)&&!inside(canonicalCwd,this.options.turnRoot)&&!inside(canonicalCwd,this.options.scheduler.path),"recovery state inside checkout");
    try {await directory(this.root);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
    check(isDeepStrictEqual((await readdir(this.root)).sort(),["masters","signing-key.json"]),"recovery authority entries invalid");
    const keyRecord=await artifact(join(this.root,"signing-key.json"),1000);
    check(keyRecord&&Object.keys(keyRecord.value).length===2&&keyRecord.value.schemaVersion==="negi-master-conversation-key/1"&&
      typeof keyRecord.value.key==="string"&&/^[0-9a-f]{64}$/.test(keyRecord.value.key),"recovery key invalid");
    await directory(join(this.root,"masters"));const master=join(this.root,"masters",this.options.masterId);
    try {await directory(master);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
    return {canonicalCwd,master,key:Buffer.from(keyRecord.value.key,"hex"),keyBytes:keyRecord.bytes};
  }

  private async ownerRecoveryEvidence(state:NonNullable<Awaited<ReturnType<MasterConversationAuthority["recoveryState"]>>>,owner:MasterOwner) {
    check(owner.cwdSha256===hash(state.canonicalCwd),"owner checkout changed");
    const operations=await this.operations(state.master,state.key,owner.owner),target=operations.find(op=>op.records[0]!.request.requestId===owner.operation.requestId);
    check(operations.every(op=>op===target||["completed","cancelled"].includes(op.records.at(-1)!.stage)),"another conversation requires reconciliation");
    if(owner.kind==="thread-start")check(target&&hash(JSON.stringify(target.records[0]!.request)+"\n")===owner.operation.hash&&
      target.records[0]!.request.cwd===state.canonicalCwd,"recovery target request missing/changed");
    if(owner.kind==="inspection")check(owner.operation.hash===hash(JSON.stringify({masterId:this.options.masterId,cwd:state.canonicalCwd,kind:owner.kind})),"inspection conditions changed");
    if(owner.kind==="turn-admission"){
      // This release handles only an admission stopped before any request/claim.
      // Existing target records need their own durable reconciliation first.
      const targetWork="master-"+owner.operation.requestId;
      try{await lstat(join(this.options.turnRoot,targetWork));throw Error("admission target exists; preserve owner");}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      check(!(await this.options.scheduler.read()).state?.entries.some(entry=>entry.work.id===targetWork),"admission claim exists; preserve owner");
    }
    await assertMasterIdleEvidence(this.options.turnRoot,this.options.masterId,this.options.scheduler);
    const evidenceSha256=await masterOwnerEvidence({...this.options,root:this.root,master:state.master},owner.kind,owner.operation.requestId);
    check(evidenceSha256===owner.evidenceSha256,"owner baseline changed; preserve hold");
    check((await artifact(join(this.root,"signing-key.json"),1000))?.bytes===state.keyBytes,"recovery key changed");
    const proofSha256=hash(JSON.stringify({masterId:this.options.masterId,cwd:state.canonicalCwd,keyBytes:state.keyBytes,
      ownerBytes:JSON.stringify(owner)+"\n",ownerState:"dead",operations:operations.map(op=>op.bytes),evidenceSha256}));
    return {operations,evidenceSha256,proofSha256};
  }

  /** Read-only preview. No native guard, key, decision, owner or provider is created. */
  async ownerRecovery(cwd:string):Promise<MasterOwnerRecoveryPreview|null> {
    try{
      const state=await this.recoveryState(cwd);if(!state)return null;
      const record=await artifact(join(state.master,"owner.lock"),2000);if(!record)return null;
      const owner=validatedMasterOwner(record.value,this.options.masterId,state.key),before=await this.ownerRecoveryEvidence(state,owner);
      const observed=await observeWriter(state.master,"master");
      check(observed.sha256===hash(record.bytes)&&observed.operation&&isDeepStrictEqual(observed.operation,owner.operation)&&!observed.legacyGuard,"native owner observation changed");
      const after=await this.ownerRecoveryEvidence(state,owner);
      check(before.proofSha256===after.proofSha256&&(await artifact(join(state.master,"owner.lock"),2000))?.bytes===record.bytes,"owner evidence changed during preview");
      const ownerState=observed.state==="dead"?"dead":observed.state==="live"?"live":"unknown";
      const supported=process.platform==="win32";
      const compatible=await this.legacyInventoryAbsent();
      return {ownerId:owner.owner,requestId:owner.operation.requestId,kind:owner.kind,ownerState,ownerSha256:hash(record.bytes),
        proofSha256:before.proofSha256,canRelease:ownerState==="dead"&&supported&&compatible,
        reason:!compatible?"会話の保存記録との照合が必要です。所有記録を保持しています。":ownerState!=="dead"?"所有者の終了を確認できません。所有記録を保持しています。":supported?null:"このOSでは正確な所有記録の解除を保証できません。所有記録を保持しています。"};
    }catch{throw new MasterConversationHeldError();}
  }

  /** Explicit exact-owner cleanup. Repeating the same decision never executes a model operation. */
  async releaseOwner(cwd:string,decisionId:string,expectedProofSha256:string):Promise<{decisionId:string;requestId:string;ownerReleased:true;operationComplete:false}> {
    check(uuid.test(decisionId)&&/^[0-9a-f]{64}$/.test(expectedProofSha256),"recovery decision invalid");
    try{
      await this.requireLegacyInventoryAbsent();
      const state=await this.recoveryState(cwd);check(state,"recovery authority absent");
      let record=await artifact(join(state.master,"owner.lock"),2000);
      const owner=record?validatedMasterOwner(record.value,this.options.masterId,state.key):null;
      const decisions=await this.recoveryDecisions(state.master,state.key,owner?.owner),existing=decisions.find(row=>row.payload.decisionId===decisionId);
      if(!record){
        check(existing&&existing.payload.cwdSha256===hash(state.canonicalCwd)&&existing.payload.proofSha256===expectedProofSha256,"absent owner has no matching decision");
        // The receipt describes this past exact owner. Later legitimate work
        // must not turn a lost response into a new recovery/model operation.
        check((await artifact(join(state.master,"recoveries",existing.payload.owner.owner+".json"),8000))?.bytes===existing.bytes&&
          (await artifact(join(this.root,"signing-key.json"),1000))?.bytes===state.keyBytes,"saved decision changed");
        check(await artifact(join(state.master,"owner.lock"),2000)===null,"a new owner appeared");
        await this.requireLegacyInventoryAbsent();
        return {decisionId,requestId:existing.payload.owner.operation.requestId,ownerReleased:true,operationComplete:false};
      }
      check(owner,"owner absent");const preview=await this.ownerRecovery(cwd);
      check(preview?.canRelease&&preview.proofSha256===expectedProofSha256&&preview.ownerSha256===hash(record.bytes),"owner recovery preview is stale or live");
      const target=decisions.find(row=>row.payload.owner.owner===owner.owner);
      check(!existing||existing===target,"decision already belongs to another owner");
      check(!target||target.payload.decisionId===decisionId,"another decision already owns this recovery");
      check(target||decisions.length<10_000,"no capacity for a new recovery decision");
      const root=join(state.master,"recoveries");
      const pendingNames=await readdir(root).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return [];});
      check(pendingNames.every(name=>!name.startsWith(".pending-")||name===`.pending-${owner.owner}-${decisionId}.json`),"another pending decision owns recovery");
      const path=join(root,owner.owner+".json");
      let receiptBytes=target?.bytes;
      if(!target){
        const payload:RecoveryPayload={schemaVersion:"negi-master-owner-recovery/1",masterId:this.options.masterId,decisionId,cwdSha256:hash(state.canonicalCwd),
          owner,proofSha256:expectedProofSha256,action:"release-owner-only",at:new Date().toISOString()};
        receiptBytes=JSON.stringify({payload,signature:createHmac("sha256",state.key).update(JSON.stringify(payload)).digest("hex")})+"\n";
      }
      check(receiptBytes&&Buffer.byteLength(receiptBytes)<=8000,"recovery receipt exceeds boundary");
      const payload=this.validateRecoveryRecord(JSON.parse(receiptBytes),owner.owner+".json",state.key);
      check(payload.decisionId===decisionId&&payload.cwdSha256===hash(state.canonicalCwd)&&payload.proofSha256===expectedProofSha256&&
        isDeepStrictEqual(payload.owner,owner),"recovery decision changed");
      check((await this.ownerRecovery(cwd))?.proofSha256===expectedProofSha256,"evidence changed before native owner release");
      await this.requireLegacyInventoryAbsent();
      await recoverWriter(state.master,"master",owner.operation,hash(record.bytes),receiptBytes);
      check(await artifact(join(state.master,"owner.lock"),2000)===null,"owner was replaced after native release");
      check((await artifact(path,8000))?.bytes===receiptBytes&&(await this.ownerRecoveryEvidence(state,owner)).proofSha256===expectedProofSha256,"recovery evidence changed after native release");
      check(await artifact(join(state.master,"owner.lock"),2000)===null,"new owner appeared after recovery");
      await this.requireLegacyInventoryAbsent();
      return {decisionId,requestId:owner.operation.requestId,ownerReleased:true,operationComplete:false};
    }catch{throw new MasterConversationHeldError();}
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
  async admitTurn(raw: MasterTurnRequest & {requestId:string}): Promise<MasterTurnLease> {
    check(uuid.test(raw.requestId), "admission request invalid");
    const cwd=await realpath(resolve(raw.cwd)),request={cwd,model:raw.model,effort:raw.effort,threadId:raw.threadId,text:raw.text};
    const workId="master-"+raw.requestId,requestedAt=new Date().toISOString();
    const requestBytes=JSON.stringify({schemaVersion:"negi-master-turn/1",workId,masterId:this.options.masterId,...request,inputSha256:hash(request.text),at:requestedAt})+"\n";
    return this.withLock(cwd, async state => {
      try { await this.idle(state); } catch { throw new MasterConversationHeldError(); }
      await this.requireLegacyInventoryAbsent();
      return guardMasterAdmission(scheduledMasterTurns({...this.options,root:this.options.turnRoot,workId,requestedAt}),
        () => this.requireLegacyInventoryAbsent()).reserve(request);
    },{kind:"turn-admission",operation:{domain:"master-conversation",requestId:raw.requestId,hash:hash(requestBytes)}});
  }

  private async startupEvidence() {
    await this.requireLegacyInventoryAbsent();
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
    await this.requireLegacyInventoryAbsent();
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
      if (owner) validatedMasterOwner(owner.value,this.options.masterId,Buffer.from(key.value.key,"hex"));
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
      await this.requireLegacyInventoryAbsent();
      const path = join(state.master, request.requestId); await mkdir(path);
      const operation: Operation = { path, records: [], bytes: [] };
      const append = async (stage: Stage, identity: CodexThreadIdentity | null = null, reason: string | null = null) => {
        check(nextStage(operation.records.at(-1)?.stage ?? null, stage), "invalid transition");
        check((await artifact(join(this.root, "signing-key.json"), 1000))?.bytes === state.keyBytes, "signing key changed");
        await this.requireLegacyInventoryAbsent();
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
        await this.requireLegacyInventoryAbsent();
        const identity = structuredClone(await run(async () => {
          check(!dispatched && !marking, "dispatch intent already requested"); marking = true;
          await this.requireLegacyInventoryAbsent();
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
    },{kind:"thread-start",operation:{domain:"master-conversation",requestId:request.requestId,hash:hash(JSON.stringify(request)+"\n")}});
  }
}
