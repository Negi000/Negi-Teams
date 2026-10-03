// Explicit browser reconciliation. Inspecting never resumes a Task or releases a claim.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadApprovedTaskPlan } from "./approvedTaskPlan.ts";
import type { VaultTaskContract } from "./vaultTaskContract.ts";
import { AppServerProcess } from "../master/appServerProcess.ts";
import { boundedAppServerArgs, subscriptionChildEnv } from "../master/boundedAppServer.ts";
import { HumanReviewProofStore, isReviewRequestId, type HumanReviewReceipt } from "./humanReviewProof.ts";
import { inspectTaskExecutionOwner, type TaskExecutionOwnerView } from "./taskExecutionOwner.ts";
import { FileTaskLedger, type Attempt, type ProviderTurnEvidence, type ReconciliationVerifier, type TaskSnapshot } from "./singleTask.ts";
import type { FileScheduler, ScheduledEntry } from "./scheduler.ts";
import type { VaultRunConfig } from "./vaultRunConfig.ts";

export const reconciliationHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byteHash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
export interface TaskReconciliationSource {
  config:VaultRunConfig;configSha256:string;snapshotSha256:string;
  ledger:FileTaskLedger;scheduler:FileScheduler;isActive:()=>boolean;
  assertStorage?: ()=>Promise<void>;
}
export interface TaskReconciliationDossier {
  runId:string;configSha256:string;snapshotSha256:string;
  contract:Pick<TaskSnapshot["contract"],"vaultId"|"version"|"sha256"|"baseSha"> & {scope:{allowedPaths:string[]}};taskStatus:string;attempt:Attempt;
  approvals:Array<{id:string;operation:string;target:string;targetSha256:string;targetTruncated:boolean;decision:string}>;
  approvalSummary:{count:number;omitted:number;sha256:string};
  ledger:{sha256:string;count:number;lastKey:string|null;stateSha256:string};
  scheduler:{sha256:string;count:number;lastKey:string|null;entry:ScheduledEntry};
  owner:TaskExecutionOwnerView;
  checkout:{head:string;indexSha256:string;diffSha256:string;filesSha256:string;
    changedPaths:string[];outsideAllowedPaths:string[];safe:boolean};
  artifact:{state:"absent"|"present"|"unsafe";sha256:string|null;bytes:number|null};
  authoritySha256:string;
  provider:ProviderTurnEvidence|null;providerError:string|null;
}
export interface TaskReconciliationView {
  inspectionId:string;dossierSha256:string;observedAt:string;dossier:TaskReconciliationDossier;
  canClose:boolean;heldReasons:string[];pendingCloseRequestId:string|null;
}
export type InspectTaskProvider=(config:VaultRunConfig,threadId:string,turnId:string)=>Promise<ProviderTurnEvidence>;
export const inspectTaskProvider:InspectTaskProvider=async(config,threadId,turnId)=>{
  const options={executable:await realpath(config.executable),cwd:config.checkout,
    args:boundedAppServerArgs(true),env:subscriptionChildEnv(),client:{transportTimeoutMs:20_000}};
  const provider=process.platform==="win32"?await AppServerProcess.launchContained(options,join(config.outputDir,"inspection-process-trees")):AppServerProcess.launch(options);
  try{
    await provider.client.initialize();const account=await provider.client.readAccountMode();
    if(account.type!=="chatgpt"||!account.requiresOpenaiAuth)throw Error("Task inspection requires ChatGPT login");
    return await provider.client.inspectProviderTurnProcessSafety(threadId,turnId,{cwd:config.checkout,modelProvider:"openai"});
  }finally{await provider.stop()}
};

async function regular(path:string,max:number):Promise<Buffer|null>{
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max)throw Error("Reconciliation file is unsafe or too large");
    const data=await readFile(path);if(data.length>max)throw Error("Reconciliation file grew");return data;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error}
}
function git(root:string,args:string[]){
  return execFileSync("git",["-c","core.fsmonitor=false",...args],{cwd:root,windowsHide:true,timeout:10_000,
    maxBuffer:8_000_000,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"},stdio:["ignore","pipe","pipe"]});
}
async function checkoutFacts(config:VaultRunConfig,allowed:string[]):Promise<TaskReconciliationDossier["checkout"]>{
  const root=await realpath(config.checkout),top=await realpath(git(root,["rev-parse","--show-toplevel"]).toString().trim());
  if(root!==top)throw Error("Task reconciliation requires the registered Git root");
  const changedPaths=[...new Set(Buffer.concat([git(root,["diff","--name-only","--no-renames","-z","HEAD"]),
    git(root,["ls-files","--others","--exclude-standard","-z"])]).toString("utf8").split("\0").filter(Boolean))].sort();
  if(changedPaths.length>200)throw Error("Too many changed files to reconcile safely");
  const files:unknown[]=[];let safe=true,total=0;
  for(const path of changedPaths){
    const absolute=join(root,path),rel=relative(root,absolute);
    if(!rel||rel.startsWith("..")||isAbsolute(rel))throw Error("Task checkout path escaped");
    let parent=dirname(absolute);while(parent!==root){
      try{if((await lstat(parent)).isSymbolicLink()){safe=false;break}}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
      parent=dirname(parent);
    }
    if(!safe){files.push([path,"unsafe"]);continue}
    try{const s=await lstat(absolute);
      if(!s.isFile()||s.isSymbolicLink()||s.size>5_000_000){safe=false;files.push([path,"unsafe"]);continue}
      const data=await regular(absolute,5_000_000);total+=data!.length;
      if(total>20_000_000)throw Error("Changed Task files exceed reconciliation limit");
      files.push([path,s.mode,data!.length,byteHash(data!)]);
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;files.push([path,"deleted"])}
  }
  return {head:git(root,["rev-parse","HEAD"]).toString().trim(),
    indexSha256:byteHash(Buffer.concat([git(root,["ls-files","--stage","-z"]),git(root,["ls-files","-v","-z"])])),
    diffSha256:byteHash(Buffer.concat([git(root,["diff","--cached","--binary","--no-ext-diff","--no-textconv","HEAD"]),
      git(root,["diff","--binary","--no-ext-diff","--no-textconv"])])),filesSha256:reconciliationHash(files),changedPaths,
    outsideAllowedPaths:changedPaths.filter(path=>!allowed.some(scope=>path===scope||path.startsWith(scope+"/"))),safe};
}
async function artifactFacts(config:VaultRunConfig,attempt:Attempt):Promise<TaskReconciliationDossier["artifact"]>{
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(attempt.id))return{state:"unsafe",sha256:null,bytes:null};
  const root=join(config.outputDir,"artifacts");
  try{const s=await lstat(root);if(!s.isDirectory()||s.isSymbolicLink())return{state:"unsafe",sha256:null,bytes:null};
    const data=await regular(join(root,attempt.id+".md"),2_000_000);
    return data?{state:"present",sha256:byteHash(data),bytes:data.length}:{state:"absent",sha256:null,bytes:null};
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return{state:"absent",sha256:null,bytes:null};
    return{state:"unsafe",sha256:null,bytes:null}}
}
async function storedContract(source:TaskReconciliationSource,state:TaskSnapshot):Promise<string>{
  const snapshot=await regular(source.config.snapshot,2_000_000);
  if(!snapshot||byteHash(snapshot)!==source.snapshotSha256)throw Error("Task snapshot changed before reconciliation");
  const fixed=JSON.parse(snapshot.toString()) as VaultTaskContract;
  const {contextPacks,approvedPlan,...original}=state.contract;
  if(state.runId!==source.config.runId||!isDeepStrictEqual(original,fixed))throw Error("Execution ledger differs from its fixed Task contract");
  if(contextPacks){
    for(const role of ["astra","sol"] as const){const pack=contextPacks[role];
      const root=join(source.config.outputDir,"artifacts"),rel=relative(root,pack.path);
      if(!rel||rel.startsWith("..")||isAbsolute(rel)||dirname(pack.path)!==root||(await lstat(root)).isSymbolicLink()||
        !/^[0-9a-f]{64}$/.test(pack.sha256))throw Error("Task context pack identity invalid");
      const data=await regular(pack.path,512_000);if(!data||byteHash(data)!==pack.sha256)throw Error("Task context pack changed");
    }
  }
  const plan=await loadApprovedTaskPlan(source.config,fixed);
  const expected=plan?{approvalRef:plan.approvalRef,threadId:plan.threadId,turnId:plan.turnId,callId:plan.callId}:undefined;
  if(!isDeepStrictEqual(approvedPlan,expected))throw Error("Task approved plan identity differs");
  return reconciliationHash({contextPacks,approvedPlan});
}
async function localDossier(source:TaskReconciliationSource):Promise<TaskReconciliationDossier>{
  const {config}=source;
  await regular(join(config.outputDir,"run.jsonl"),8_000_000);await regular(config.schedulerPath,8_000_000);
  const ledger=await source.ledger.read(),schedule=await source.scheduler.read(),state=ledger.state;
  const entry=schedule.state?.entries.find(e=>e.work.id===config.runId);
  const unknownVerification=state?.verification?.outcome==="unknown";
  const attempt=state?([...state.attempts].reverse().find(a=>["unknown","running"].includes(a.state))??
    (unknownVerification?state.attempts.at(-1):undefined)):undefined;
  if(!state||!entry||!attempt||!["running","needs_reconciliation"].includes(entry.status)||
    !(["needs_reconciliation","planning","working"].includes(state.status)||(state.status==="blocked"&&unknownVerification))||
    entry.claimKey!==`${config.runId}:dispatch`||entry.work.checkout!==config.checkout)
    throw Error("This phase requires a separate recovery decision; no uncertain provider attempt can be closed");
  const authoritySha256=await storedContract(source,state);
  const owner=await inspectTaskExecutionOwner(config.outputDir,config.runId,source.configSha256,entry.claimKey);
  return {runId:config.runId,configSha256:source.configSha256,snapshotSha256:source.snapshotSha256,
    contract:{vaultId:state.contract.vaultId,version:state.contract.version,sha256:state.contract.sha256,baseSha:state.contract.baseSha,
      scope:{allowedPaths:state.contract.scope?.allowedPaths??[]}},taskStatus:state.status,attempt,
    approvals:state.approvals.slice(-100).map(a=>({id:a.id.slice(0,160),operation:a.operation.slice(0,200),target:a.target.slice(0,500),
      targetSha256:byteHash(a.target),targetTruncated:a.target.length>500,decision:a.decision})),
    approvalSummary:{count:state.approvals.length,omitted:Math.max(0,state.approvals.length-100),sha256:reconciliationHash(state.approvals)},
    ledger:{sha256:reconciliationHash(ledger.events),count:ledger.events.length,lastKey:ledger.events.at(-1)?.key??null,stateSha256:reconciliationHash(state)},
    scheduler:{sha256:reconciliationHash(schedule.events),count:schedule.events.length,lastKey:schedule.events.at(-1)?.key??null,entry},owner,
    checkout:await checkoutFacts(config,state.contract.scope?.allowedPaths??[]),artifact:await artifactFacts(config,attempt),
    authoritySha256,provider:null,providerError:null};
}
function terminal(d:TaskReconciliationDossier){const p=d.provider;return Boolean(p&&p.found&&p.completeSearch&&
  p.threadId===d.attempt.threadId&&p.turnId===d.attempt.turnId&&["completed","failed","interrupted"].includes(p.status??"")&&
  p.source==="thread/turns/list"&&Number.isSafeInteger(p.pagesRead)&&p.pagesRead>0&&p.pagesRead<=20&&Number.isFinite(p.observedAtMs));}
function reasons(d:TaskReconciliationDossier):string[]{
  const held:string[]=[];
  if(!["running","unknown"].includes(d.attempt.state))held.push("検証結果が不明です。検証記録と残っている処理を照合してください。");
  if(!terminal(d))held.push("保存された実行の終了をプロバイダーで確認できません。");
  const safety=d.provider?.processSafety,passive=["agentMessage","userMessage","reasoning","plan","contextCompaction"];
  if(!safety||safety.source!=="thread/items/list"||!safety.complete||!safety.noExecutableItems||
    !Number.isSafeInteger(safety.pagesRead)||safety.pagesRead<1||safety.pagesRead>20||
    !Number.isSafeInteger(safety.itemCount)||safety.itemCount<0||safety.itemCount>2000||
    !Array.isArray(safety.itemTypes)||safety.itemTypes.some(type=>!passive.includes(type))||! /^[0-9a-f]{64}$/.test(safety.sha256))
    held.push("コマンド等が残した処理の終了を確認できません。実行枠を保持して照合してください。");
  if(!["finished","dead"].includes(d.owner.status))held.push(({missing:"元の実行の所有記録がありません。",live:"元の実行プロセスが終了したと確認できません。",unknown:"元の実行の所有記録を照合できません。"} as Record<string,string>)[d.owner.status]??"実行の終了確認が必要です。");
  // Job receipts cover inherited descendants, not WMI/services or other brokers.
  // Neither a direct PID exit nor an empty job proves all initiated work ended.
  if(d.owner.childPids.length)held.push(d.owner.jobExit==="confirmed"?
    "所属する処理の終了は確認しましたが、外部サービス経由で起動した処理は確認できないため、実行枠を保持します。":
    "起動した処理全体の終了を確認できないため、実行枠の解放を保留しています。");
  if(!d.checkout.safe||d.artifact.state==="unsafe")held.push("差分または成果ファイルを安全に読み取れません。");
  return held;
}
const withoutProvider=(d:TaskReconciliationDossier)=>({...d,provider:null,providerError:null});
interface CloseIntent {requestId:string;inspectionId:string;dossierSha256:string}

export class LocalTaskReconciliation {
  private constructor(private readonly proofs:HumanReviewProofStore,private readonly inspectProvider:InspectTaskProvider){}
  static async open(root:string,inspectProvider:InspectTaskProvider=inspectTaskProvider){
    return new LocalTaskReconciliation(await HumanReviewProofStore.open(root,512_000),inspectProvider);
  }
  private view(receipt:HumanReviewReceipt,pending:string|null=null):TaskReconciliationView{
    const dossier=JSON.parse(receipt.data.dossier) as TaskReconciliationDossier;
    if(receipt.action!=="task-inspect"||receipt.artifactSha256!==reconciliationHash(dossier))throw Error("Task inspection proof invalid");
    const heldReasons=reasons(dossier);
    return {inspectionId:receipt.id,dossierSha256:receipt.artifactSha256,observedAt:receipt.at,dossier,
      canClose:heldReasons.length===0,heldReasons,pendingCloseRequestId:pending};
  }
  private async intent(source:TaskReconciliationSource):Promise<CloseIntent|null>{
    const raw=await regular(join(source.config.outputDir,"recovery-close.json"),4000);
    if(!raw)return null;const intent=JSON.parse(raw.toString()) as CloseIntent;
    if(!isReviewRequestId(intent.requestId)||!isReviewRequestId(intent.inspectionId)||! /^[0-9a-f]{64}$/.test(intent.dossierSha256)||Object.keys(intent).length!==3)
      throw Error("Task recovery intent invalid");return intent;
  }
  private async sameLocalArtifacts(source:TaskReconciliationSource,dossier:TaskReconciliationDossier,includeCheckout=true):Promise<boolean>{
    const state=(await source.ledger.read()).state;
    const owner=await inspectTaskExecutionOwner(source.config.outputDir,source.config.runId,source.configSha256,`${source.config.runId}:dispatch`);
    // Historical signed previews lack the new derived job projection. Their raw
    // owner bytes are still pinned by sha256; preserve exact pending retries.
    const {jobExit,...historicalOwner}=owner;void jobExit;
    return !source.isActive()&&Boolean(state&&await storedContract(source,state)===dossier.authoritySha256)&&
      reconciliationHash(dossier.owner.jobExit===undefined?historicalOwner:owner)===reconciliationHash(dossier.owner)&&
      (!includeCheckout||reconciliationHash(await checkoutFacts(source.config,dossier.contract.scope?.allowedPaths??[]))===reconciliationHash(dossier.checkout))&&
      reconciliationHash(await artifactFacts(source.config,dossier.attempt))===reconciliationHash(dossier.artifact);
  }
  async inspect(source:TaskReconciliationSource,requestId:string):Promise<TaskReconciliationView>{
    if(!isReviewRequestId(requestId))throw Error("Task inspection request invalid");
    return this.locked(source,requestId,()=>this.inspectLocked(source,requestId));
  }
  private async inStorage<T>(source:TaskReconciliationSource,operation:()=>Promise<T>):Promise<T>{
    // Scheduler reads/appends own the native runtime guard. Git, provider RPC
    // and proof scans must not hold it while other claims are completing.
    await source.assertStorage?.();return operation();
  }
  /** A retained Task already occupies its scheduler claim. Serialize its
   * read-only provider inspection without blocking other Tasks' journal writes.
   * A crash leaves this record held; no PID guess or automatic lock removal. */
  private async locked<T>(source:TaskReconciliationSource,requestId:string,operation:()=>Promise<T>):Promise<T>{
    const path=join(source.config.outputDir,"reconciliation.lock"),lock=await open(path,"wx",0o600);
    const identity=await lock.stat(),bytes=JSON.stringify({schema:"negi-task-inspection-owner/1",id:randomUUID(),requestId,
      runId:source.config.runId,configSha256:source.configSha256,pid:process.pid,at:new Date().toISOString()})+"\n";
    let published=false;
    try{await lock.writeFile(bytes);await lock.sync();published=true;return await operation()}
    finally{
      await lock.close();
      if(published){const current=await lstat(path);
        if(current.isSymbolicLink()||!current.isFile()||current.dev!==identity.dev||current.ino!==identity.ino||
          (await regular(path,32000))?.toString("utf8")!==bytes)throw Error("Task inspection owner changed; preserve the lock");
        await unlink(path);
      }
    }
  }
  private async inspectLocked(source:TaskReconciliationSource,requestId:string):Promise<TaskReconciliationView>{
    const pending=await this.intent(source);
    if(pending){const original=await this.proofs.read(pending.inspectionId);
      if(!original||original.caseId!==source.config.runId||original.data.configSha256!==source.configSha256||original.artifactSha256!==pending.dossierSha256)
        throw Error("Pending recovery inspection differs");
      const view=this.view(original,pending.requestId);
      if(!await this.sameLocalArtifacts(source,view.dossier)){
        view.canClose=false;view.heldReasons.push("終了判断後の差分・成果・実行状態が変わっています。実行枠を保持して照合してください。");
      }
      return view;}
    const old=await this.proofs.read(requestId);
    if(old){if(old.caseId!==source.config.runId||old.data.configSha256!==source.configSha256)throw Error("Inspection identity reused");return this.view(old)}
    const dossier=await this.inStorage(source,()=>localDossier(source));
    if(dossier.attempt.threadId&&dossier.attempt.turnId){
      try{dossier.provider=await this.inspectProvider(source.config,dossier.attempt.threadId,dossier.attempt.turnId)}
      catch{dossier.providerError="プロバイダーの保存状態を取得できません。ログインと接続を確認してください。"}
    }
    return this.inStorage(source,async()=>{
      if(reconciliationHash(await localDossier(source))!==reconciliationHash(withoutProvider(dossier)))
        throw Error("Task facts changed while inspecting provider");
      const receipt=await this.proofs.create({id:requestId,action:"task-inspect",caseId:source.config.runId,runId:source.config.runId,
        artifactSha256:reconciliationHash(dossier),verificationRef:null,data:{configSha256:source.configSha256,dossier:JSON.stringify(dossier)}});
      return this.view(receipt);
    });
  }
  verifier(source:Pick<TaskReconciliationSource,"config"|"configSha256">):ReconciliationVerifier{
    return async({event,state,events})=>{
      if(event.action.type!=="close_uncertain_attempt"||!events)return false;
      const id=event.action.evidenceRef.match(/^user:task-close:([0-9a-f-]{36})$/i)?.[1];
      const receipt=id?await this.proofs.read(id):null;if(!receipt||receipt.action!=="task-close")return false;
      const dossier=JSON.parse(receipt.data.dossier) as TaskReconciliationDossier;
      const fresh=JSON.parse(receipt.data.freshProvider) as ProviderTurnEvidence;
      return receipt.caseId===source.config.runId&&receipt.runId===state.runId&&receipt.at===event.at&&
        receipt.data.configSha256===source.configSha256&&receipt.artifactSha256===reconciliationHash(dossier)&&
        event.key===`task-close:${receipt.id}`&&event.action.attemptId===dossier.attempt.id&&
        reconciliationHash(events)===dossier.ledger.sha256&&reconciliationHash(state)===dossier.ledger.stateSha256&&
        reasons(dossier).length===0&&reasons({...dossier,provider:fresh}).length===0&&fresh.status===dossier.provider?.status;
    };
  }
  async close(source:TaskReconciliationSource,requestId:string,inspectionId:string,dossierSha256:string):Promise<void>{
    if(!isReviewRequestId(requestId)||!isReviewRequestId(inspectionId)||source.isActive())throw Error("Task close request unavailable");
    requestId=requestId.toLowerCase();inspectionId=inspectionId.toLowerCase();
    return this.locked(source,requestId,async()=>{
      const original=await this.proofs.read(inspectionId);
      if(!original||original.caseId!==source.config.runId||original.data.configSha256!==source.configSha256||original.artifactSha256!==dossierSha256)
        throw Error("Task inspection changed");
      const view=this.view(original),dossier=view.dossier;
      if(!view.canClose||source.isActive())throw Error("Task execution or provider remains uncertain");
      const intent=await this.intent(source),expected={requestId,inspectionId,dossierSha256};
      if(intent&&JSON.stringify(intent)!==JSON.stringify(expected))throw Error("Resume the original Task close decision");
      let receipt=await this.proofs.read(requestId);
      if(receipt){if(receipt.action!=="task-close"||receipt.caseId!==source.config.runId||receipt.artifactSha256!==dossierSha256||
        receipt.data.inspectionId!==inspectionId||receipt.data.configSha256!==source.configSha256)throw Error("Task close request identity reused")}
      let fresh:ProviderTurnEvidence|null=null;
      if(!receipt){
        const current=await this.inStorage(source,()=>localDossier(source));
        if(reconciliationHash(current)!==reconciliationHash(withoutProvider(dossier)))throw Error("Task facts changed after inspection");
        fresh=await this.inspectProvider(source.config,dossier.attempt.threadId!,dossier.attempt.turnId!);
        if(reasons({...dossier,provider:fresh}).length||fresh.status!==dossier.provider?.status||
          reconciliationHash(fresh.processSafety)!==reconciliationHash(dossier.provider?.processSafety))throw Error("Provider terminal state changed");
      }
      await this.inStorage(source,async()=>{
      if(!receipt){
        // Re-pin after the provider read and a fresh runtime audit.
        if(source.isActive()||reconciliationHash(await localDossier(source))!==reconciliationHash(withoutProvider(dossier)))
          throw Error("Task facts changed while checking provider");
        if(!intent){const f=await open(join(source.config.outputDir,"recovery-close.json"),"wx",0o600);
          try{await f.writeFile(JSON.stringify(expected)+"\n");await f.sync()}finally{await f.close()}}
        receipt=await this.proofs.create({id:requestId,action:"task-close",caseId:source.config.runId,runId:source.config.runId,
          artifactSha256:dossierSha256,verificationRef:null,data:{configSha256:source.configSha256,inspectionId,
            dossier:JSON.stringify(dossier),freshProvider:JSON.stringify(fresh)}});
      }
      if(!await this.sameLocalArtifacts(source,dossier))throw Error("Task local facts changed after saved close decision");
      const evidenceRef=`user:task-close:${receipt.id}`,key=`task-close:${receipt.id}`;
      await source.ledger.append({key,at:receipt.at,action:{type:"close_uncertain_attempt",attemptId:dossier.attempt.id,evidenceRef}});
      const action=dossier.scheduler.entry.status==="running"?"settle":"reconcile";
      await source.scheduler.append({key:key+":scheduler",at:receipt.at,action:{type:action,workId:source.config.runId,
        outcome:"failed",evidenceRef,actualCostUsd:null}},async current=>{
          const entry=current.state?.entries.find(e=>e.work.id===source.config.runId);
          const ledger=await source.ledger.read();
          return !source.isActive()&&reconciliationHash(entry)===reconciliationHash(dossier.scheduler.entry)&&
            reconciliationHash(current.events.slice(0,dossier.scheduler.count))===dossier.scheduler.sha256&&
            ledger.events.at(-1)?.key===key&&ledger.state?.status==="stopped"&&
            // The checkout was rechecked above. The scheduler guard protects
            // saved execution facts, not external edits to the checkout.
            await this.sameLocalArtifacts(source,dossier,false);
        });
      });
    });
  }
}
