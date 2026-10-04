import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
// Native exclusion is process-lifetime; callers authorize the exact signed
// operation before invoking this fixed-name writer recovery boundary.
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { invokeMasterStorage, masterStorageTicket, withMasterStorageGuard } from "./masterStorageGuard.ts";
import { promisify } from "node:util";
import { isReviewRequestId } from "./humanReviewProof.ts";

export interface WriterOperation { domain:"vault-initialization"|"project-configuration"|"project-setup"|"master-conversation";requestId:string;hash:string }
export type WriterKind="vault"|"configuration"|"setup"|"master";
export interface WriterObservation { state:"absent"|"live"|"dead"|"unknown";operation:WriterOperation|null;sha256:string|null;legacyGuard:boolean }
export function canRecoverWriter(value:WriterObservation,operation:WriterOperation){
  return !value.legacyGuard&&(value.state==="absent"||value.state==="dead"&&value.operation?.domain===operation.domain&&
    value.operation.requestId===operation.requestId.toLowerCase()&&value.operation.hash===operation.hash);
}
export async function preflightWriters(entries:Array<{root:string;kind:WriterKind}>,operation:WriterOperation){
  const values=await Promise.all(entries.map(e=>observeWriter(e.root,e.kind)));
  if(values.some(v=>v.state==="live"))throw Error("Writer is still live; preserve every writer");
  if(values.some(v=>!canRecoverWriter(v,operation)))throw Error("Writer ownership is live, unknown or belongs to another operation; preserve every writer");
  return values;
}
const exec=promisify(execFile);
async function script(){
  let path=fileURLToPath(new URL("../../../scripts/negi_recover_writer.py",import.meta.url));
  try{await lstat(path)}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
    path=fileURLToPath(new URL("../../../../scripts/negi_recover_writer.py",import.meta.url));}
  if(!(await lstat(path)).isFile())throw Error("Native writer recovery helper missing");
  return path;
}
export async function observeWriter(root:string,kind:WriterKind):Promise<WriterObservation>{
  const result=await exec("python",[await script(),"--root",root,"--kind",kind,"--inspect"],
    {windowsHide:true,timeout:10000,maxBuffer:20000,env:{...withoutControlPlaneEnv(),PYTHONIOENCODING:"utf-8"}});
  const value=JSON.parse(result.stdout) as WriterObservation,op=value?.operation;
  if(!value||Array.isArray(value)||Object.keys(value).sort().join()!=="legacyGuard,operation,sha256,state"||
    !["absent","live","dead","unknown"].includes(value.state)||typeof value.legacyGuard!=="boolean"||
    value.sha256!==null&&(typeof value.sha256!=="string"||! /^[0-9a-f]{64}$/.test(value.sha256))||
    op!==null&&(!op||Array.isArray(op)||Object.keys(op).sort().join()!=="domain,hash,requestId"||
      !["project-setup","project-configuration","vault-initialization","master-conversation"].includes(op.domain)||
      !isReviewRequestId(op.requestId)||op.requestId!==op.requestId.toLowerCase()||! /^[0-9a-f]{64}$/.test(op.hash))||
    (["absent","unknown"].includes(value.state)?op!==null:op===null)||
    value.state==="absent"&&value.sha256!==null)throw Error("Native writer observation invalid");
  return value;
}
export async function recoverWriter(root:string,kind:WriterKind,operation:WriterOperation,ownerSha256?:string,receiptBytes?:string){
  if(kind==="master"&&(!ownerSha256||! /^[0-9a-f]{64}$/.test(ownerSha256)))throw Error("Master recovery requires exact owner bytes");
  if(ownerSha256!==undefined&&! /^[0-9a-f]{64}$/.test(ownerSha256))throw Error("Recovery owner hash invalid");
  if(receiptBytes!==undefined&&(kind!=="master"||Buffer.byteLength(receiptBytes)>8000))throw Error("Recovery receipt invalid");
  if (kind === "master") {
    if (!receiptBytes) throw Error("Master recovery requires a bounded signed receipt");
    if (operation.domain !== "master-conversation" || basename(dirname(root)) !== "masters" || JSON.parse(receiptBytes).payload?.masterId !== basename(root)) throw Error("Master root must match exact owner and decision");
    const authorityRoot = dirname(dirname(root)), frozenOperation = structuredClone(operation), frozenReceipt = receiptBytes;
    return withMasterStorageGuard(authorityRoot, async () => {
      const ticket = masterStorageTicket(authorityRoot);
      const result = await invokeMasterStorage({ action: "recover-master", root: authorityRoot, requestId: frozenOperation.requestId.toLowerCase(),
        hash: frozenOperation.hash, ownerSha256, receipt: frozenReceipt, ...(ticket ? { storageTicket: ticket } : {}) });
      if (Object.keys(result).join() !== "released" || typeof result.released !== "boolean") throw Error("Native Master recovery result invalid");
      return result.released;
    });
  }
  const path=await script();
  const result=await exec("python",[path,"--root",root,"--kind",kind,"--domain",operation.domain,
    "--request-id",operation.requestId.toLowerCase(),"--hash",operation.hash,...(ownerSha256?["--owner-sha256",ownerSha256]:[]),
    ...(receiptBytes?["--receipt-json",receiptBytes]:[])],
    {windowsHide:true,timeout:10000,maxBuffer:20000,env:{...withoutControlPlaneEnv(),PYTHONIOENCODING:"utf-8"}});
  const value=JSON.parse(result.stdout) as {released:boolean};
  if(!value||Array.isArray(value)||Object.keys(value).join()!=="released"||typeof value.released!=="boolean")throw Error("Native writer recovery result invalid");
  return value.released;
}
