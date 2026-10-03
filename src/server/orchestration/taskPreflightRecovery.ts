// A failed preflight can be closed only after proving that no execution was
// admitted. Closing reserves the old run ID as terminal; it never retries it.
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HumanReviewProofStore, isReviewRequestId, type HumanReviewReceipt } from "./humanReviewProof.ts";
import type { VaultRunConfig } from "./vaultRunConfig.ts";
import type { VaultTaskContract } from "./vaultTaskContract.ts";
import { loadApprovedTaskPlan } from "./approvedTaskPlan.ts";
import { checkoutFacts, reconciliationHash } from "./taskReconciliation.ts";
import type { FileTaskLedger } from "./singleTask.ts";
import type { FileScheduler, ScheduledWork, ScheduledEntry, SchedulerEvent } from "./scheduler.ts";

const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
async function bytes(path:string):Promise<Buffer|null>{
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>2_000_000)throw Error("Preflight record unsafe");
    const b=await readFile(path);if(b.length>2_000_000)throw Error("Preflight record grew");return b;
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e}
}
async function firstOutputName(path:string):Promise<string|null>{
  try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error("Task output unsafe");
    const directory=await opendir(path);try{return (await directory.read())?.name??null}finally{await directory.close()}
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e}
}
export async function withTaskPreflightLock<T>(root:string,runId:string,configSha256:string,run:()=>Promise<T>):Promise<T>{
  const path=join(root,runId+".preflight.lock"),file=await open(path,"wx",0o600),identity=await file.stat();
  const value=JSON.stringify({schema:"negi-task-preflight-owner/1",id:randomUUID(),runId,configSha256,pid:process.pid,at:new Date().toISOString()})+"\n";
  let saved=false;
  try{await file.writeFile(value);await file.sync();saved=true;return await run()}
  finally{await file.close();if(saved){const current=await lstat(path);
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||current.dev!==identity.dev||current.ino!==identity.ino||
      (await bytes(path))?.toString()!==value)throw Error("Preflight ownership changed; preserve lock");
    await unlink(path)}}
}
export interface PreflightRecoverySource{
  root:string;config:VaultRunConfig;configSha256:string;snapshotSha256:string;contract:VaultTaskContract;
  ledger:FileTaskLedger;scheduler:FileScheduler;isActive:()=>boolean;
  withStorage:<T>(run:()=>Promise<T>)=>Promise<T>;
}
export interface PreflightRecoveryDossier{
  runId:string;configSha256:string;snapshotSha256:string;requestId:string;requestedAt:string;
  requestSha256:string;errorSha256:string;authoritySha256:string;
  schedulerSha256:string;outputFiles:string[];
  checkout:Awaited<ReturnType<typeof checkoutFacts>>;
}
export interface PreflightRecoveryView{
  inspectionId:string;dossierSha256:string;observedAt:string;dossier:PreflightRecoveryDossier;
  canClose:boolean;heldReasons:string[];pendingCloseRequestId:string|null;
}
async function dossier(source:PreflightRecoverySource):Promise<PreflightRecoveryDossier>{
  const {root,config}=source;
  if(source.isActive())throw Error("Preflight is still active");
  const request=await bytes(join(root,config.runId+".request.json")),error=await bytes(join(root,config.runId+".error.json"));
  if(!request||!error)throw Error("Failed request evidence missing");
  const value=JSON.parse(request.toString());
  if(value.runId!==config.runId||value.configSha256!==source.configSha256||!isReviewRequestId(value.requestId)||
    !Number.isFinite(Date.parse(value.at)))throw Error("Preflight request identity changed");
  const snapshot=await bytes(config.snapshot);
  if(!snapshot||hash(snapshot)!==source.snapshotSha256)throw Error("Fixed preflight contract changed");
  const plan=await loadApprovedTaskPlan(config,source.contract);
  // Even an empty or unexpected execution record requires a different recovery
  // path. A generic failure message does not prove that submission was absent.
  if(await bytes(join(config.outputDir,"run.jsonl")))throw Error("Task execution record exists");
  const ledger=await source.ledger.read(),schedule=await source.scheduler.read();
  if(ledger.state||ledger.events.length||schedule.state?.entries.some(e=>e.work.id===config.runId))throw Error("Task execution was admitted");
  const first=await firstOutputName(config.outputDir),outputFiles=first?[first]:[];
  return {runId:config.runId,configSha256:source.configSha256,snapshotSha256:source.snapshotSha256,
    requestId:value.requestId,requestedAt:value.at,requestSha256:hash(request),errorSha256:hash(error),
    authoritySha256:reconciliationHash(plan??null),schedulerSha256:reconciliationHash(schedule.events),outputFiles,
    checkout:await checkoutFacts(config,source.contract.scope.allowedPaths)};
}
function held(d:PreflightRecoveryDossier,baseSha:string){
  const reasons:string[]=[];
  if(d.outputFiles.length)reasons.push("実行用フォルダーに記録があります。処理と成果を個別に照合してください。");
  if(!d.checkout.safe)reasons.push("差分のファイルを安全に照合できません。");
  if(d.checkout.head!==baseSha)reasons.push("契約の基準から現在の版が変わっています。");
  return reasons;
}
function work(source:PreflightRecoverySource):ScheduledWork{return {id:source.config.runId,parentId:null,dependencies:[],role:"sol",checkout:source.config.checkout,
  checkoutMode:"write",resources:source.config.resources.map(name=>({name,mode:"write"})),reserveUsd:0,
  execution:source.config.approvedPlan?"direct":"astra_to_sol"}}
export class TaskPreflightRecovery{
  private constructor(private readonly proofs:HumanReviewProofStore){}
  static async open(root:string){return new TaskPreflightRecovery(await HumanReviewProofStore.open(join(root,"preflight-proofs"),512_000))}
  private view(receipt:HumanReviewReceipt,source:PreflightRecoverySource,pending:string|null=null):PreflightRecoveryView{
    if(receipt.action!=="operation"||receipt.data.domain!=="task-preflight-inspect"||receipt.runId!==source.config.runId||
      receipt.caseId!==source.config.runId||receipt.data.configSha256!==source.configSha256)throw Error("Preflight inspection proof differs");
    const d=JSON.parse(receipt.data.dossier) as PreflightRecoveryDossier;
    if(receipt.artifactSha256!==reconciliationHash(d))throw Error("Preflight inspection hash differs");
    const reasons=held(d,source.contract.baseSha);
    return {inspectionId:receipt.id,dossierSha256:receipt.artifactSha256,observedAt:receipt.at,dossier:d,
      canClose:!reasons.length,heldReasons:reasons,pendingCloseRequestId:pending};
  }
  private async intent(source:PreflightRecoverySource){
    const b=await bytes(join(source.root,source.config.runId+".preflight-close.json"));if(!b)return null;
    const i=JSON.parse(b.toString());
    if(Object.keys(i).length!==3||!isReviewRequestId(i.requestId)||!isReviewRequestId(i.inspectionId)||
      !/^[0-9a-f]{64}$/.test(i.dossierSha256))throw Error("Preflight close intent unsafe");
    return i as {requestId:string;inspectionId:string;dossierSha256:string};
  }
  private lock<T>(source:PreflightRecoverySource,run:()=>Promise<T>){
    return withTaskPreflightLock(source.root,source.config.runId,source.configSha256,()=>source.withStorage(run));
  }
  /** A terminal projection is not proof of a human decision. Read the complete
   * signed chain on every closed view; missing metadata remains a hold. Current
   * checkout edits after closure do not rewrite the historical decision. */
  async verifyClosed(source:PreflightRecoverySource,entry:ScheduledEntry,events:SchedulerEvent[]):Promise<boolean>{
    const id=entry.evidenceRef?.match(/^user:preflight-close:([0-9a-f-]{36})$/)?.[1];if(!id||entry.status!=="cancelled"||entry.claimKey!==null)return false;
    const pending=await this.intent(source),receipt=await this.proofs.read(id);
    if(!pending||pending.requestId!==id||!receipt||receipt.action!=="operation"||receipt.data.domain!=="task-preflight-close"||
      receipt.caseId!==source.config.runId||receipt.runId!==source.config.runId||receipt.data.configSha256!==source.configSha256||
      receipt.data.inspectionId!==pending.inspectionId||receipt.artifactSha256!==pending.dossierSha256)return false;
    const inspection=await this.proofs.read(pending.inspectionId);if(!inspection)return false;
    const view=this.view(inspection,source);
    if(!view.canClose||view.dossierSha256!==pending.dossierSha256||view.dossier.runId!==source.config.runId||
      view.dossier.configSha256!==source.configSha256||view.dossier.snapshotSha256!==source.snapshotSha256)return false;
    const request=await bytes(join(source.root,source.config.runId+".request.json")),error=await bytes(join(source.root,source.config.runId+".error.json")),snapshot=await bytes(source.config.snapshot);
    if(!request||!error||!snapshot||hash(request)!==view.dossier.requestSha256||hash(error)!==view.dossier.errorSha256||hash(snapshot)!==source.snapshotSha256)return false;
    if(await bytes(join(source.config.outputDir,"run.jsonl")))return false;
    const ledger=await source.ledger.read();if(ledger.state||ledger.events.length)return false;
    if(await firstOutputName(source.config.outputDir))return false;
    if(reconciliationHash(await loadApprovedTaskPlan(source.config,source.contract)??null)!==view.dossier.authoritySha256)return false;
    const event=events.find(e=>e.key==="preflight-close:"+id);
    return Boolean(event&&event.at===receipt.at&&event.action.type==="close_unsubmitted"&&event.action.evidenceRef===entry.evidenceRef&&
      reconciliationHash(event.action.work)===reconciliationHash(work(source))&&reconciliationHash(entry.work)===reconciliationHash(work(source)));
  }
  async inspect(source:PreflightRecoverySource,id:string):Promise<PreflightRecoveryView>{
    if(!isReviewRequestId(id))throw Error("Preflight inspection UUID required");id=id.toLowerCase();
    return this.lock(source,async()=>{
      const pending=await this.intent(source),old=await this.proofs.read(pending?.inspectionId??id);
      if(old){const view=this.view(old,source,pending?.requestId??null);
        if(pending&&pending.dossierSha256!==view.dossierSha256)throw Error("Saved close inspection changed");
        if(reconciliationHash(await dossier(source))!==view.dossierSha256){view.canClose=false;view.heldReasons.push("確認した状態が変わっています。差分と実行記録を再確認してください。")}
        return view}
      const first=await dossier(source);
      if(source.isActive()||reconciliationHash(await dossier(source))!==reconciliationHash(first))throw Error("Preflight changed during inspection");
      return this.view(await this.proofs.create({id,action:"operation",caseId:source.config.runId,runId:source.config.runId,
        artifactSha256:reconciliationHash(first),verificationRef:null,data:{domain:"task-preflight-inspect",configSha256:source.configSha256,dossier:JSON.stringify(first)}}),source);
    });
  }
  async close(source:PreflightRecoverySource,id:string,inspectionId:string,dossierSha256:string):Promise<void>{
    if(!isReviewRequestId(id)||!isReviewRequestId(inspectionId)||!/^[0-9a-f]{64}$/.test(dossierSha256))throw Error("Preflight close identity invalid");
    id=id.toLowerCase();inspectionId=inspectionId.toLowerCase();
    return this.lock(source,async()=>{
      const inspection=await this.proofs.read(inspectionId);
      if(!inspection)throw Error("Preflight inspection missing");
      const view=this.view(inspection,source);
      if(!view.canClose||view.dossierSha256!==dossierSha256||source.isActive())throw Error("Preflight remains uncertain");
      const expected={requestId:id,inspectionId,dossierSha256},pending=await this.intent(source);
      if(pending&&JSON.stringify(pending)!==JSON.stringify(expected))throw Error("Resume the original preflight close decision");
      const receipt=await this.proofs.read(id),evidenceRef="user:preflight-close:"+id;
      if(receipt&&(receipt.action!=="operation"||receipt.data.domain!=="task-preflight-close"||receipt.runId!==source.config.runId||
        receipt.caseId!==source.config.runId||receipt.data.configSha256!==source.configSha256||receipt.data.inspectionId!==inspectionId||
        receipt.artifactSha256!==dossierSha256))throw Error("Preflight close UUID reused");
      const schedule=await source.scheduler.read(),entry=schedule.state?.entries.find(e=>e.work.id===source.config.runId);
      if(receipt&&entry?.status==="cancelled"&&entry.claimKey===null&&entry.evidenceRef===evidenceRef){
        if(!await this.verifyClosed(source,entry,schedule.events))throw Error("Saved preflight close proof incomplete");return;
      }
      if(reconciliationHash(await dossier(source))!==dossierSha256)throw Error("Preflight facts changed after inspection");
      if(!pending){const f=await open(join(source.root,source.config.runId+".preflight-close.json"),"wx",0o600);
        try{await f.writeFile(JSON.stringify(expected)+"\n");await f.sync()}finally{await f.close()}}
      const decision=receipt??await this.proofs.create({id,action:"operation",caseId:source.config.runId,runId:source.config.runId,
        artifactSha256:dossierSha256,verificationRef:null,data:{domain:"task-preflight-close",configSha256:source.configSha256,inspectionId}});
      // One event creates a terminal reservation. There is no queued interval
      // in which another writer can claim the old request.
      await source.scheduler.append({key:"preflight-close:"+id,at:decision.at,action:{type:"close_unsubmitted",work:work(source),evidenceRef}},async current=>
        !source.isActive()&&!current.state?.entries.some(e=>e.work.id===source.config.runId)&&
        reconciliationHash(current.events)===view.dossier.schedulerSha256&&reconciliationHash(await dossier(source))===dossierSha256);
    });
  }
}
