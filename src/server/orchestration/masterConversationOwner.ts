// Candidate owner proof. Recovery never starts, cancels, settles or replays a provider operation.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readMasterTurnArtifact as artifact, verifyMasterTurnDirectory as directory } from "./masterTurnRecords.ts";
import type { FileScheduler } from "./scheduler.ts";
import type { WriterOperation } from "./writerRecovery.ts";

export type MasterOwnerKind = "inspection" | "turn-admission" | "thread-start";
export interface MasterOwnerPayload {
  schema: "negi-master-conversation-owner/2"; pid: number; owner: string; createdAt: string;
  masterId: string; kind: MasterOwnerKind; cwdSha256: string; operation: WriterOperation; evidenceSha256: string;
}
export interface MasterOwner extends MasterOwnerPayload { signature: string }
export const masterOwnerAuxiliary = ["owner.lock", "owner-recovery-flock-v2.lock", "recoveries"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
export const masterEvidenceHash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Master owner evidence: " + reason); }
export function signedMasterOwner(payload: MasterOwnerPayload, key: Buffer): string {
  const signature = createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
  const bytes = JSON.stringify({ ...payload, signature }) + "\n";
  check(Buffer.byteLength(bytes) <= 2000, "owner exceeds native boundary");
  return bytes;
}
export function validatedMasterOwner(value: Record<string, unknown>, masterId: string, key: Buffer): MasterOwner {
  const owner = value as unknown as MasterOwner;
  check(Object.keys(value).length === 10 && owner.schema === "negi-master-conversation-owner/2" && owner.masterId === masterId &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid <= 0x7fffffff && typeof owner.owner === "string" && uuid.test(owner.owner) &&
    typeof owner.createdAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(owner.createdAt) && Number.isFinite(Date.parse(owner.createdAt)) &&
    ["inspection", "turn-admission", "thread-start"].includes(owner.kind) && owner.operation && Object.keys(owner.operation).length === 3 &&
    owner.operation.domain === "master-conversation" && typeof owner.operation.requestId === "string" && uuid.test(owner.operation.requestId) &&
    typeof owner.operation.hash === "string" && sha.test(owner.operation.hash) &&
    typeof owner.cwdSha256 === "string" && sha.test(owner.cwdSha256) &&
    typeof owner.evidenceSha256 === "string" && sha.test(owner.evidenceSha256) && typeof owner.signature === "string" && sha.test(owner.signature), "owner shape or legacy owner");
  const { signature, ...payload } = owner;
  const expected = createHmac("sha256", key).update(JSON.stringify(payload)).digest();
  check(timingSafeEqual(expected, Buffer.from(signature, "hex")), "owner signature mismatch");
  return owner;
}

async function fingerprint(path: string) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "unsafe evidence file");
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}
async function inventory(root: string, exclude: Set<string>, master: boolean, include?:Set<string>) {
  let identity: string;
  try { identity = await directory(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = (await readdir(root)).sort(), entries: unknown[] = [];
  check(names.length <= 10_000, "evidence inventory limit");
  for (const name of names) {
    if (exclude.has(name)) continue;
    if (master && masterOwnerAuxiliary.includes(name)) {
      if (name === "owner-recovery-flock-v2.lock") {
        const info = await fingerprint(join(root, name));check(info.size === 0, "native guard changed");
      } else if (name === "recoveries") await directory(join(root, name));
      continue;
    }
    check(master ? uuid.test(name) : /^master-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name), "unexpected inventory entry");
    if(include&&!include.has(name))continue;
    const path = join(root, name), childIdentity = await directory(path), files = (await readdir(path)).sort();
    check(files.length <= 5, "unexpected evidence files");
    const data = [];
    for (const file of files) {
      check(master ? /^0[0-4]-[a-z_]+\.json$/.test(file) : ["request.json", "dispatch.json", "provider.json", "outcome.json", "not-sent.json"].includes(file), "unexpected evidence file");
      data.push([file, await fingerprint(join(path, file))]);
    }
    check(childIdentity === await directory(path) && isDeepStrictEqual(files, (await readdir(path)).sort()), "evidence directory changed");
    entries.push([name, childIdentity, data]);
  }
  check(identity === await directory(root) && isDeepStrictEqual(names, (await readdir(root)).sort()), "evidence inventory changed");
  return { identity, entries };
}

/** Pin non-target conversation/turn evidence. Receipts are validated separately;
 * their deletion/tail rollback needs a future anchored inventory. */
export async function masterOwnerEvidence(options: { root: string; master: string; masterId:string; turnRoot: string; scheduler: FileScheduler }, kind: MasterOwnerKind, requestId: string) {
  const before = await options.scheduler.read();
  const targetWork = kind === "turn-admission" ? "master-" + requestId : null;
  const entries=before.state?.entries.filter(entry=>entry.work.id!==targetWork&&(entry.work.masterOwner?
    entry.work.masterOwner.masterId===options.masterId:/^master-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.work.id)&&entry.work.role==="astra"&&entry.work.checkoutMode==="read"))??[];
  const ids=new Set(entries.map(entry=>entry.work.id));
  const events = before.events.filter(event => {
    const action = event.action;
    return action.type==="configure"||action.type==="set_capacity"||ids.has("workId" in action ? action.workId : "work" in action ? action.work.id : "");
  });
  const schedulerState = before.state && { ...before.state, entries };
  const key = await artifact(join(options.root, "signing-key.json"), 1000);check(key, "signing key missing");
  const master = await inventory(options.master, new Set(kind === "thread-start" ? [requestId] : []), true);
  const turns = await inventory(options.turnRoot, new Set(targetWork ? [targetWork] : []), false,ids);
  check(isDeepStrictEqual(before, await options.scheduler.read()) && (await artifact(join(options.root, "signing-key.json"), 1000))?.bytes === key.bytes, "baseline changed");
  return masterEvidenceHash(JSON.stringify({ master, turns, events, schedulerState, keyBytes: key.bytes }));
}
