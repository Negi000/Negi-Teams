// An authenticated human confirms an exact startup profile. No model or configured
// verification command runs here; existing Vault notes and Git work are read only.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import { parseVaultRunConfig, type VaultRunConfig } from "./vaultRunConfig.ts";

const exec = promisify(execFile), hash = (v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const inside=(a:string,b:string)=>{const r=relative(a.toLowerCase(),b.toLowerCase());return !r||(!r.startsWith("..")&&!isAbsolute(r))};
const label=(v:unknown)=>typeof v==="string"&&/^[a-zA-Z0-9._-]{1,100}$/.test(v);
interface Settings { id:string; title:string; project:string; repository:string; vault:string; executable:string;
  allowedPaths:string[]; astra:VaultRunConfig["astra"]; sol:VaultRunConfig["sol"]; verification:VaultRunConfig["verification"];
  maxAttempts:number; timeLimitMinutes:number }
export interface ProjectSetupPreview { schema:"negi-project-setup/1"; settings:Settings; baseSha:string;
  sources:Array<{id:string;kind:string;version:number;sha256:string;path:string}>; hash:string }
interface Publication { requestId:string; preview:ProjectSetupPreview }
async function boundedJson(path:string,maximum=24000):Promise<unknown> {
  const f=await lstat(path);if(!f.isFile()||f.isSymbolicLink()||f.size>maximum)throw Error("Setup file is invalid");
  const bytes=await readFile(path);if(bytes.length>maximum)throw Error("Setup file grew beyond limit");return JSON.parse(bytes.toString("utf8"));
}
async function existing(raw:unknown,kind:"file"|"directory"):Promise<string> {
  if(typeof raw!=="string"||!isAbsolute(raw)||raw.length>2048||/[\0\r\n]/.test(raw))throw Error("Absolute setup path required");
  const f=await lstat(raw);if(f.isSymbolicLink()||(kind==="file"?!f.isFile():!f.isDirectory()))throw Error("Setup path type invalid");return realpath(raw);
}
export class LocalProjectSetup {
  private constructor(readonly root:string,private readonly proofs:HumanReviewProofStore){}
  static async open(raw:string,protectedRoots:string[]=[]):Promise<LocalProjectSetup> {
    if(!isAbsolute(raw))throw Error("NEGI_SETUP_ROOT must be absolute");
    const path=resolve(raw);let root:string;
    try{root=await existing(path,"directory")}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;root=join(await realpath(dirname(path)),basename(path))}
    for(const p of protectedRoots){const source=await realpath(p);if(inside(source,root)||inside(root,source))throw Error("Setup storage overlaps source root")}
    await mkdir(root,{recursive:true});return new LocalProjectSetup(root,await HumanReviewProofStore.open(join(root,"profile-approvals")));
  }
  async current():Promise<ProjectSetupPreview|null> {
    let publication:Publication;try{publication=await boundedJson(join(this.root,"setup.json")) as Publication}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e}
    const {hash:expected,...core}=publication.preview??{},receipt=await this.proofs.read(publication.requestId);
    if(!receipt||!isReviewRequestId(publication.requestId)||expected!==hash(core)||receipt.action!=="operation"||
      receipt.caseId!=="project-setup"||receipt.runId!==core.settings?.id||receipt.artifactSha256!==expected||
      receipt.verificationRef!==null||!isDeepStrictEqual(receipt.data,{domain:"project-setup",preview:JSON.stringify(publication.preview)}))throw Error("Signed setup configuration differs");
    return publication.preview;
  }
  async preview(raw:unknown):Promise<ProjectSetupPreview> {
    const p=structuredClone(raw) as Record<string,unknown>,keys=["id","title","project","repository","vault","executable","allowedPaths","astra","sol","verification","maxAttempts","timeLimitMinutes"];
    if(!p||Array.isArray(p)||Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||
      !label(p.id)||!label(p.project)||typeof p.title!=="string"||!p.title.trim()||p.title.length>160||/[\0\r\n]/.test(p.title)||
      !Number.isSafeInteger(p.maxAttempts)||Number(p.maxAttempts)<1||Number(p.maxAttempts)>3||
      !Number.isSafeInteger(p.timeLimitMinutes)||Number(p.timeLimitMinutes)<1||Number(p.timeLimitMinutes)>480)throw Error("Setup fields invalid");
    if(Buffer.byteLength(JSON.stringify(raw))>12000)throw Error("Setup settings too large");
    const repository=await existing(p.repository,"directory"),vault=await existing(p.vault,"directory"),executable=await existing(p.executable,"file");
    if(inside(repository,vault)||inside(vault,repository))throw Error("Repository and Vault must be separate");
    for(const source of [repository,vault])if(inside(source,this.root)||inside(this.root,source))throw Error("Setup evidence overlaps model writable roots");
    if(!Array.isArray(p.allowedPaths)||!p.allowedPaths.length||p.allowedPaths.length>20||!p.allowedPaths.every(v=>
      typeof v==="string"&&v.length<=300&&!/[\\:*?\[\]{}\r\n\0]/.test(v)&&v.split("/").every(s=>s&&s!=="."&&s!==".."&&s.toLowerCase()!==".git"))||
      new Set(p.allowedPaths).size!==p.allowedPaths.length)throw Error("Allowed paths invalid");
    const config=parseVaultRunConfig({executable,checkout:repository,vault,snapshot:join(this.root,"profile","not-a-task.json"),outputDir:join(this.root,"profile"),
      schedulerPath:join(this.root,"scheduler.jsonl"),runId:p.id,astra:p.astra,sol:p.sol,verification:p.verification,resources:[]});
    if(!config.verification.length||!config.verification.every(c=>isAbsolute(c.program)))throw Error("Explicit verification programs required");
    for(const c of config.verification)c.program=await existing(c.program,"file");
    if(new Set(config.verification.map(c=>c.requirement)).size!==config.verification.length||
      ![config.astra,config.sol].every(r=>["low","medium","high","xhigh","max","ultra"].includes(r.effort)))throw Error("Setup roles/checks invalid");
    const top=(await exec("git",["rev-parse","--show-toplevel"],{cwd:repository,windowsHide:true,timeout:10000})).stdout.trim();
    if((await realpath(top)).toLowerCase()!==repository.toLowerCase())throw Error("Repository must be Git root");
    await this.cleanRepository(repository);
    const baseSha=(await exec("git",["rev-parse","HEAD"],{cwd:repository,windowsHide:true,timeout:10000})).stdout.trim().toLowerCase();
    if(!/^[0-9a-f]{40}$/.test(baseSha))throw Error("Committed SHA1 Git baseline required");
    const script=fileURLToPath(new URL("../../../scripts/negi_task_authoring.py",import.meta.url));
    // Dist builds live one level deeper than TS sources.
    let inspector=script;try{await lstat(inspector)}catch{inspector=fileURLToPath(new URL("../../../../scripts/negi_task_authoring.py",import.meta.url))}
    const refs=JSON.parse((await exec("python",[inspector,"--vault",vault,"inspect","--project",String(p.project)],
      {windowsHide:true,timeout:20000,maxBuffer:200000,env:{...process.env,PYTHONIOENCODING:"utf-8"}})).stdout) as {sources:ProjectSetupPreview["sources"]};
    const settings:Settings={id:String(p.id),title:p.title.trim(),project:String(p.project),repository,vault,executable,allowedPaths:p.allowedPaths as string[],
      astra:config.astra,sol:config.sol,verification:config.verification,maxAttempts:Number(p.maxAttempts),timeLimitMinutes:Number(p.timeLimitMinutes)};
    const core={schema:"negi-project-setup/1" as const,settings,baseSha,sources:refs.sources},preview={...core,hash:hash(core)};
    if(Buffer.byteLength(JSON.stringify(preview))>20000)throw Error("Setup preview too large");return preview;
  }
  private async cleanRepository(repository:string) {
    if((await exec("git",["status","--porcelain"],{cwd:repository,windowsHide:true,timeout:10000})).stdout.trim())
      throw Error("Project setup requires a clean committed baseline; existing changes are retained");
  }
  private async unusedRuntime() {
    for(const name of ["profile","authoring","task-state","reviews","worktrees","scheduler.jsonl"]){
      try{await lstat(join(this.root,name))}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e}
      throw Error("Existing runtime evidence requires reconciliation before first setup");
    }
  }
  async save(raw:unknown,expectedHash:string,requestId:string):Promise<ProjectSetupPreview> {
    if(!isReviewRequestId(requestId)||!/^([0-9a-f]{64})$/.test(expectedHash))throw Error("Setup approval identity invalid");
    const path=join(this.root,"setup-writer.lock"),lock=await open(path,"wx",0o600);
    try{
      const previous=await this.current();if(previous){const publication=await boundedJson(join(this.root,"setup.json")) as Publication;
        if(publication.requestId!==requestId||previous.hash!==expectedHash||!isDeepStrictEqual(previous.settings,raw))throw Error("Startup configuration already saved");return previous}
      await this.unusedRuntime();
      const preview=await this.preview(raw);if(preview.hash!==expectedHash)throw Error("Setup paths, Git baseline or references changed before approval");
      await this.proofs.create({id:requestId,action:"operation",caseId:"project-setup",runId:preview.settings.id,artifactSha256:preview.hash,verificationRef:null,
        data:{domain:"project-setup",preview:JSON.stringify(preview)}});
      const out=await open(join(this.root,"setup.json"),"wx",0o600);try{await out.writeFile(JSON.stringify({requestId,preview})+"\n");await out.sync()}finally{await out.close()}
      return preview;
    }finally{await lock.close();await unlink(path)}
  }
  /** Trusted startup composition. Configuration is never accepted from a model tool. */
  async startup(preview:ProjectSetupPreview) {
    if(!isDeepStrictEqual(await this.current(),preview))throw Error("Setup publication changed");
    const p=preview.settings;
    for(const source of [p.repository,p.vault]){const actual=await existing(source,"directory");if(actual!==source||inside(source,this.root)||inside(this.root,source))throw Error("Setup root identity changed")}
    const executable=await existing(p.executable,"file");if(executable!==p.executable)throw Error("Codex executable changed location");
    await this.cleanRepository(p.repository);
    for(const c of p.verification)if(await existing(c.program,"file")!==c.program)throw Error("Verification program changed location");
    for(const d of ["profile","authoring","task-state","reviews","worktrees"])await mkdir(join(this.root,d),{recursive:true});
    const config:VaultRunConfig={executable,checkout:p.repository,vault:p.vault,snapshot:join(this.root,"profile","not-a-task.json"),outputDir:join(this.root,"profile"),
      schedulerPath:join(this.root,"scheduler.jsonl"),runId:p.id,astra:p.astra,sol:p.sol,verification:p.verification,resources:[]};
    return {tasks:{stateRoot:join(this.root,"task-state"),schedulerPath:config.schedulerPath,runs:[]},
      reviews:{storageRoot:join(this.root,"reviews"),writableRoots:[p.repository,p.vault,join(this.root,"worktrees")],cases:[]},
      authoring:{storageRoot:join(this.root,"authoring"),profiles:[{id:p.id,title:p.title,project:p.project,config,repository:p.repository,
        worktreeRoot:join(this.root,"worktrees"),allowedPaths:p.allowedPaths,maxAttempts:p.maxAttempts,timeLimitMinutes:p.timeLimitMinutes}]},config};
  }
}
