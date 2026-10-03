// A research result is an immutable output artifact, never an empty Git review.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
import { parseMarkdown } from "../../client/markdown.ts";
import type { RegisteredReviewCase } from "./reviewService.ts";
import type { TaskReviewPresentation } from "./reviewPresentation.ts";
import type { TaskSnapshot } from "./singleTask.ts";
import { assertTaskWorkerProfileRegistration, assertVaultWorkerContract, type VaultRunConfig } from "./vaultRunConfig.ts";
import { RESEARCH_FINDINGS_BYTES, researchReviewMetadata } from "./researchArtifactPolicy.ts";

const hash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const samePath=(a:string,b:string)=>process.platform==="win32"?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
export interface ReadOnlyTaskReviewManifest {
  schema:"negi-task-readonly-review/1";
  resultKind:"read-only-artifact";
  runId:string; configSha256:string; baseSha:string;
  contract:{vaultId:string;version:number;sha256:string};
  attempt:{id:string;threadId:string;turnId:string;outputRef:string;outputSha256:string};
  review:RegisteredReviewCase;
}
function git(config:VaultRunConfig,args:string[]):string {
  return execFileSync("git",args,{cwd:config.checkout,env:withoutControlPlaneEnv(),encoding:"utf8",
    windowsHide:true,timeout:20_000,maxBuffer:150_000}).trim();
}
async function regular(path:string,limit:number,root?:string):Promise<Buffer>{
  if(!isAbsolute(path))throw Error("Research artifact path must be absolute");
  if(root){const rel=relative(root,path);if(!rel||rel.startsWith("..")||isAbsolute(rel))throw Error("Research artifact escaped its output root");
    for(let dir=dirname(path);;dir=dirname(dir)){
      const entry=await lstat(dir);
      if(!entry.isDirectory()||entry.isSymbolicLink()||!samePath(await realpath(dir),dir))throw Error("Research artifact directory changed");
      if(samePath(dir,root))break;
    }
  }
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>limit||!samePath(await realpath(path),path))
    throw Error("Research artifact type, path or size is unsafe");
  const file=await open(path,"r");
  try{const entry=await file.stat();
    if(!entry.isFile()||entry.nlink!==1||entry.dev!==before.dev||entry.ino!==before.ino||entry.size!==before.size||entry.mtimeMs!==before.mtimeMs)
      throw Error("Research artifact identity changed before read");
    const bytes=await file.readFile(),after=await file.stat(),current=await lstat(path);
    if(bytes.length>limit||after.size!==entry.size||after.mtimeMs!==entry.mtimeMs||after.ctimeMs!==entry.ctimeMs||
      current.isSymbolicLink()||current.dev!==entry.dev||current.ino!==entry.ino||current.nlink!==1||!samePath(await realpath(path),path))
      throw Error("Research artifact changed during read");
    new TextDecoder("utf-8",{fatal:true}).decode(bytes);return bytes;
  }finally{await file.close()}
}
async function pin(path:string,bytes:Buffer,root:string):Promise<void>{
  try{const file=await open(path,"wx",0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}}
  catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error}
  if(hash(await regular(path,100_000,root))!==hash(bytes))throw Error("Research review differs from an existing pinned version");
}
async function derive(config:VaultRunConfig,configSha256:string,title:string,state:TaskSnapshot){
  assertVaultWorkerContract(config,state.contract);
  if(config.taskMode!=="read_only_research"||state.runId!==config.runId||
    !["ready_for_review","accepted"].includes(state.status)||state.verification?.outcome!=="passed"||state.resultRevisions?.length)
    throw Error("Research review requires its completed, verified fixed Task");
  const snapshotBytes=await regular(config.snapshot,2_000_000),snapshot=JSON.parse(snapshotBytes.toString("utf8"));
  assertTaskWorkerProfileRegistration(config,state.contract);
  const {contextPacks:_packs,approvedPlan:_plan,workerProfileSelection,...contract}=state.contract;
  if(hash(JSON.stringify({config,snapshotSha256:hash(snapshotBytes)}))!==configSha256||!isDeepStrictEqual(contract,snapshot))
    throw Error("Research contract or registration changed after verification");
  const attempt=state.attempts.at(-1);
  if(!attempt||attempt.role!=="luna"||attempt.state!=="completed"||!attempt.threadId||!attempt.turnId||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(attempt.id)||state.attempts.some(a=>a.state!=="completed"||!["astra","luna"].includes(a.role)))
    throw Error("Research review requires the exact completed Luna attempt");
  if(workerProfileSelection && (attempt.requestedModel !== workerProfileSelection.model ||
      attempt.resolvedModel !== workerProfileSelection.model || attempt.requestedEffort !== workerProfileSelection.effort))
    throw Error("Research attempt differs from its pinned Policy profile");
  const artifact=join(config.outputDir,"artifacts",`${attempt.id}.md`),match=attempt.outputRef?.match(/^(.+)#sha256=([a-f0-9]{64})$/);
  if(!match||!samePath(match[1],artifact))throw Error("Research output is not the fixed Luna artifact");
  const findings=await regular(artifact,RESEARCH_FINDINGS_BYTES,config.outputDir);
  if(hash(findings)!==match[2]||!findings.toString("utf8").trim())throw Error("Research output changed or is empty");
  const evidencePath=join(config.outputDir,"verification.json"),proof=state.verification.evidenceRef.match(/^(.+)#sha256=([a-f0-9]{64})$/);
  if(!proof||!samePath(proof[1],evidencePath))throw Error("Research verification is not the registered local evidence");
  const evidenceBytes=await regular(evidencePath,2_000_000,config.outputDir),evidence=JSON.parse(evidenceBytes.toString("utf8"));
  const expectedChecks=[...config.verification.map(c=>({requirement:c.requirement,program:c.program,args:c.args})),
    {requirement:"git diff --check",program:"git",args:["diff","--check"]}];
  if(hash(evidenceBytes)!==proof[2]||evidence.runId!==config.runId||evidence.baseSha!==state.contract.baseSha||
    evidence.taskMode!=="read_only_research"||evidence.baseMatches!==true||evidence.cleanAtStart!==true||evidence.cleanAtEnd!==true||
    evidence.mechanicalChecksPassed!==true||evidence.stoppedDuringVerification!==false||evidence.humanAcceptance!==null||
    !isDeepStrictEqual(evidence.changedPaths,[])||!isDeepStrictEqual(evidence.outsideScope,[])||
    !isDeepStrictEqual(evidence.requiredVerification,state.contract.verification)||!Array.isArray(evidence.checks)||
    evidence.checks.length!==expectedChecks.length||evidence.checks.some((c:Record<string,unknown>,i:number)=>!c||c.passed!==true||
      !isDeepStrictEqual({requirement:c.requirement,program:c.program,args:c.args},expectedChecks[i])||
      ![c.outputSha256,c.stderrSha256].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v))))
    throw Error("Research verification bytes or fixed checks differ");
  if(git(config,["rev-parse","HEAD"])!==state.contract.baseSha||git(config,["status","--porcelain","--untracked-files=all"]))
    throw Error("Research checkout changed after verification");
  const content=Buffer.from(JSON.stringify({...researchReviewMetadata(state.contract,config.verification.map(c=>c.requirement)),
    findings:findings.toString("utf8"),...(workerProfileSelection?{workerProfileSelection}:{})},null,2)+"\n");
  if(content.length>100_000)throw Error("Research result exceeds bounded web review preview");
  const review:RegisteredReviewCase={id:`task-${hash(config.runId).slice(0,24)}`,title,
    ledgerPath:join(config.outputDir,"review.jsonl"),artifactRoot:config.outputDir,verifiedArtifactSha256:hash(content),
    evidencePath,evidenceSha256:hash(evidenceBytes),verificationSummary:"固定された調査成果・基準SHA・可視変更ゼロと検証コマンドを確認しました。",
    limits:"調査内容と受入条件の達成は利用者が確認してください。Gitで見える変更とコマンド終了状態の検証で、全filesystemや外部processの隔離を証明するものではありません。訂正は新しい契約で依頼してください。"};
  const manifest:ReadOnlyTaskReviewManifest={schema:"negi-task-readonly-review/1",resultKind:"read-only-artifact",runId:config.runId,
    configSha256,baseSha:state.contract.baseSha,contract:{vaultId:state.contract.vaultId,version:state.contract.version,sha256:state.contract.sha256},
    attempt:{id:attempt.id,threadId:attempt.threadId,turnId:attempt.turnId,outputRef:attempt.outputRef!,outputSha256:match[2]},review};
  return {manifest,content,artifactPath:join(config.outputDir,"review-result.md")};
}
export async function captureReadOnlyTaskReview(config:VaultRunConfig,configSha256:string,title:string,state:TaskSnapshot):Promise<ReadOnlyTaskReviewManifest>{
  const result=await derive(config,configSha256,title,state);
  await pin(result.artifactPath,result.content,config.outputDir);
  await pin(join(config.outputDir,"review-manifest.json"),Buffer.from(JSON.stringify(result.manifest)+"\n"),config.outputDir);
  await verifyReadOnlyTaskReview(config,result.manifest,state);return result.manifest;
}
export async function verifyReadOnlyTaskReview(config:VaultRunConfig,manifest:ReadOnlyTaskReviewManifest,state:TaskSnapshot):Promise<void>{
  const current=await derive(config,manifest.configSha256,manifest.review.title,state);
  if(!isDeepStrictEqual(current.manifest,manifest)||hash(await regular(current.artifactPath,100_000,config.outputDir))!==hash(current.content)||
    !isDeepStrictEqual(JSON.parse((await regular(join(config.outputDir,"review-manifest.json"),100_000,config.outputDir)).toString("utf8")),manifest))
    throw Error("Research review manifest or pinned content changed");
}
export async function loadReadOnlyTaskReview(config:VaultRunConfig):Promise<ReadOnlyTaskReviewManifest|null>{
  let bytes:Buffer;try{bytes=await regular(join(config.outputDir,"review-manifest.json"),100_000,config.outputDir)}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error}
  const manifest=JSON.parse(bytes.toString("utf8"));
  if(manifest?.schema!=="negi-task-readonly-review/1"||manifest.resultKind!=="read-only-artifact"||manifest.runId!==config.runId||
    !manifest.review||manifest.review.id!==`task-${hash(config.runId).slice(0,24)}`||
    !samePath(manifest.review.artifactRoot,config.outputDir)||!samePath(manifest.review.ledgerPath,join(config.outputDir,"review.jsonl"))||
    !samePath(manifest.review.evidencePath,join(config.outputDir,"verification.json")))throw Error("Research review manifest kind or registration differs");
  return manifest;
}
export function readOnlyTaskReviewPresentation(content:string):TaskReviewPresentation|null{
  try{const value=JSON.parse(content);if(value.schema!=="negi-task-readonly-artifact/1"||typeof value.findings!=="string"||
      !Array.isArray(value.acceptance)||!value.acceptance.every((v:unknown)=>typeof v==="string")||!Array.isArray(value.verification?.checks))return null;
    return {kind:"read_only_research",acceptance:value.acceptance.map((v:string)=>`- ${v}`).join("\n"),changes:value.findings,
      blocks:parseMarkdown(value.findings),checks:value.verification.checks.map((c:{requirement:string;passed:boolean})=>({requirement:c.requirement,passed:c.passed}))};
  }catch{return null}
}
