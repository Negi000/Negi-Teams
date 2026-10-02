// Human-approved creation of an absent Vault. Existing notes are never adopted.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";

const exec=promisify(execFile),sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const digest=(value:unknown)=>sha(JSON.stringify(value));
const inside=(a:string,b:string)=>{const r=relative(a.toLowerCase(),b.toLowerCase());return !r||(!r.startsWith("..")&&!isAbsolute(r))};
const DIRECTORIES=["00_System","10_Projects","20_Decisions","30_Patterns","40_Lessons","50_Policies","60_Evaluations","70_Feedback","80_Tasks","85_Derived","90_Archive"];
const MARKER=".negi-vault-initialization.json";
const READY=".negi-vault-ready.json";
interface Identity { device:string;inode:string }
export interface VaultInitializationInput { target:string;repository:string;project:string;title:string;specification:string }
export interface VaultInitializationPreview {
  schema:"negi-vault-initialization/1";requestId:string;updated:string;input:VaultInitializationInput;
  parent:Identity;repository:Identity;baseSha:string;directories:string[];
  files:Array<{path:string;content:string;sha256:string}>;payloadHash:string;marker:string;ready:string;hash:string;
}
export interface VaultInitializationStatus { preview:VaultInitializationPreview;state:"approved"|"created";error:string|null }

async function exists(path:string){try{await lstat(path);return true}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e}}
async function directory(path:string):Promise<Identity>{
  const s=await lstat(path,{bigint:true});
  if(!s.isDirectory()||s.isSymbolicLink()||await realpath(path)!==path)throw Error("Vault directory identity invalid");
  // Windows Node and Python expose different device namespaces. Use the same
  // stat implementation for the preview and the native publication boundary.
  const identity=JSON.parse((await exec("python",[await script("negi_publish_vault.py"),"--identity",path],
    {windowsHide:true,timeout:10000,maxBuffer:20000,env:{...process.env,PYTHONIOENCODING:"utf-8"}})).stdout) as Identity;
  if(!/^\d+$/.test(identity.device)||!/^\d+$/.test(identity.inode))throw Error("Vault native identity invalid");
  return identity;
}
async function boundedFile(path:string,maximum=160000):Promise<Buffer>{
  const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>maximum)throw Error("Vault record type or size invalid");
  const bytes=await readFile(path);if(bytes.length>maximum)throw Error("Vault record grew");return bytes;
}
async function writeNew(path:string,bytes:string){
  const file=await open(path,"wx",0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}
}
async function script(name:string){
  let path=fileURLToPath(new URL("../../../scripts/"+name,import.meta.url));
  if(!await exists(path))path=fileURLToPath(new URL("../../../../scripts/"+name,import.meta.url));
  if(!(await lstat(path)).isFile())throw Error("Vault helper missing");return path;
}
function input(raw:unknown):VaultInitializationInput{
  const p=raw as Record<string,unknown>,keys=["target","repository","project","title","specification"];
  if(!p||Array.isArray(p)||Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||
    keys.some(k=>typeof p[k]!=="string"||Buffer.from(String(p[k]),"utf8").toString("utf8")!==p[k])||!(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/).test(String(p.project))||p.project==="global"||
    !String(p.title).trim()||String(p.title).length>160||/[\0\r\n]/.test(String(p.title))||
    !String(p.specification).trim()||String(p.specification).length>8000||
    Buffer.byteLength(String(p.specification))>18000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(String(p.specification)))throw Error("Vault initialization fields invalid");
  for(const key of ["target","repository"])if(!isAbsolute(String(p[key]))||String(p[key]).length>2048||/[\0\r\n]/.test(String(p[key])))throw Error("Absolute Vault path required");
  const target=resolve(String(p.target)),name=basename(target);
  if(!name||name==="."||name===".."||/[\\:*?"<>|]/.test(name)||/[. ]$/.test(name)||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)||/^\.negi-/i.test(name)||
    process.platform==="win32"&&!/^[a-zA-Z]:[\\/]/.test(target))throw Error("Vault target name invalid");
  return {target,repository:resolve(String(p.repository)),project:String(p.project),title:String(p.title).trim(),
    specification:String(p.specification).replace(/\r\n?/g,"\n").trim()};
}
function preview(input:VaultInitializationInput,requestId:string,updated:string,parent:Identity,repository:Identity,baseSha:string):VaultInitializationPreview{
  const projectId="NT-PROJECT-"+requestId.replace(/-/g,""),specId="NT-SPEC-"+requestId.replace(/-/g,"");
  const approval="user:http-vault-initialization:"+requestId;
  const metadata=(id:string,kind:string)=>["---","id: "+id,"kind: "+kind,"project: "+JSON.stringify(input.project),
    "scope: project","status: active","version: 1","updated: "+updated,"sensitivity: local","verification_status: untested",
    "title: "+JSON.stringify(input.title+(kind==="Spec"?"の必須仕様":"")),"source_refs:","  - "+approval,"approval_ref: "+approval];
  const files=[
    {path:"10_Projects/project.md",content:[...metadata(projectId,"Project"),"---","","# "+input.title,"",
      "コードの正本: "+input.repository,"","仕様と知識はこのVault、実行の事実と承認証拠はサーバーの保存領域で管理します。",""].join("\n")},
    {path:"10_Projects/spec.md",content:[...metadata(specId,"Spec"),"required: true","depends_on:","  - "+projectId,"---","",
      "# "+input.title+"の必須仕様","",input.specification,""].join("\n")}
  ].map(f=>({...f,sha256:sha(f.content)}));
  const payload={schema:"negi-vault-initialization/1" as const,requestId,updated,input,parent,repository,baseSha,directories:DIRECTORIES,files};
  const payloadHash=digest(payload),marker=JSON.stringify({schema:"negi-vault-initialization-marker/1",requestId,payloadHash})+"\n";
  const ready=JSON.stringify({schema:"negi-vault-ready/1",requestId,payloadHash,inventoryHash:digest({directories:DIRECTORIES,files:files.map(({path,sha256})=>({path,sha256}))})})+"\n";
  const core={...payload,payloadHash,marker,ready};return {...core,hash:digest(core)};
}

export class LocalVaultInitialization {
  private constructor(readonly root:string,private readonly proofs:HumanReviewProofStore,private readonly protectedRoots:string[]){}
  static async open(setupRoot:string,protectedRoots:string[]){
    const root=join(setupRoot,"vault-initializations");await mkdir(root,{recursive:true});await directory(root);
    const proofs=await HumanReviewProofStore.open(join(setupRoot,"vault-initialization-approvals"),160000);
    return new LocalVaultInitialization(root,proofs,[...protectedRoots,setupRoot]);
  }
  private async approved(requestId:string):Promise<VaultInitializationPreview|null>{
    const receipt=await this.proofs.read(requestId);if(!receipt)return null;
    const p=JSON.parse(receipt.data.preview??"") as VaultInitializationPreview;
    if(receipt.action!=="operation"||receipt.caseId!=="vault-initialization"||receipt.runId!==p.input?.project||
      receipt.artifactSha256!==p.hash||receipt.verificationRef!==null||
      !isDeepStrictEqual(receipt.data,{domain:"vault-initialization",preview:JSON.stringify(p)})||
      p.requestId!==requestId.toLowerCase()||!isDeepStrictEqual(p,preview(input(p.input),p.requestId,p.updated,p.parent,p.repository,p.baseSha)))
      throw Error("Vault initialization approval differs");
    return p;
  }
  private async approvals(){
    const names=await readdir(this.proofs.root);
    if(names.length>65||names.some(n=>n!=="server-signing-key"&&!/^[0-9a-f-]{36}\.json$/.test(n)))throw Error("Vault approval inventory invalid");
    const rows:VaultInitializationPreview[]=[];
    for(const name of names.filter(n=>n.endsWith(".json")).sort())rows.push((await this.approved(name.slice(0,-5)))!);
    const catalogs=await readdir(this.root);
    if(catalogs.some(n=>![".writer.lock",".recovery.lock"].includes(n)&&!rows.some(p=>[".json",".pending.json",".intent.json"].some(s=>n===p.requestId+s))))throw Error("Vault publication has no approval");
    return rows;
  }
  private async catalog(p:VaultInitializationPreview){
    const path=join(this.root,p.requestId+".json");if(!await exists(path))return false;
    if(!isDeepStrictEqual(JSON.parse((await boundedFile(path)).toString("utf8")),{schema:"negi-vault-publication/1",requestId:p.requestId,
      hash:p.hash,target:p.input.target}))throw Error("Vault publication catalog differs");
    return true;
  }
  async history():Promise<VaultInitializationStatus[]>{
    const rows=await this.approvals();return Promise.all(rows.map(async p=>({preview:p,state:await this.catalog(p)?"created" as const:"approved" as const,error:null})));
  }
  private async protect(p:VaultInitializationPreview,historicalRoots:string[]){
    const rows=await this.approvals(),roots=[...this.protectedRoots,...historicalRoots,p.input.repository,
      ...rows.filter(r=>r.requestId!==p.requestId).map(r=>r.input.target)];
    const stage=join(dirname(p.input.target),".negi-vault-stage-"+p.requestId);
    for(const root of roots)for(const candidate of [p.input.target,stage])
      if(inside(root,candidate)||inside(candidate,root))throw Error("Vault initialization overlaps protected source");
    if(!isDeepStrictEqual(await directory(dirname(p.input.target)),p.parent)||
      !isDeepStrictEqual(await directory(p.input.repository),p.repository))throw Error("Vault initialization roots changed");
    const git=await exec("git",["rev-parse","--show-toplevel","HEAD"],{cwd:p.input.repository,windowsHide:true,timeout:10000});
    const [top,head]=git.stdout.trim().split(/\r?\n/);
    if(await realpath(top)!==p.input.repository||head!==p.baseSha||
      (await exec("git",["status","--porcelain"],{cwd:p.input.repository,windowsHide:true,timeout:10000})).stdout.trim())
      throw Error("Vault initialization baseline changed");
  }
  async preview(raw:unknown,requestId:string,historicalRoots:string[]=[],updated=new Date().toISOString().slice(0,10)){
    if(!isReviewRequestId(requestId)||!/^\d{4}-\d{2}-\d{2}$/.test(updated)||
      !Number.isFinite(Date.parse(updated))||Math.abs(Date.now()-Date.parse(updated))>172800000)throw Error("Vault preview identity or date invalid");
    const normalized=input(raw),parent=await realpath(dirname(normalized.target)),repository=await realpath(normalized.repository);
    normalized.target=join(parent,basename(normalized.target));normalized.repository=repository;
    const baseSha=(await exec("git",["rev-parse","HEAD"],{cwd:repository,windowsHide:true,timeout:10000})).stdout.trim();
    if(!/^[0-9a-f]{40}$/.test(baseSha))throw Error("Vault initialization requires committed SHA1 baseline");
    const p=preview(normalized,requestId.toLowerCase(),updated,await directory(parent),await directory(repository),baseSha);
    if(Buffer.byteLength(JSON.stringify(p))>70000)throw Error("Vault preview too large");
    await this.protect(p,historicalRoots);
    if(await exists(p.input.target))throw Error("New Vault target already exists");
    return p;
  }
  private async locked<T>(requestId:string,hash:string,operation:()=>Promise<T>){
    if(!isReviewRequestId(requestId)||! /^[0-9a-f]{64}$/.test(hash))throw Error("Vault writer identity invalid");
    const path=join(this.root,".writer.lock"),file=await open(path,"wx",0o600);
    try{await file.writeFile(JSON.stringify({schema:"negi-vault-writer/1",pid:process.pid,owner:randomUUID(),createdAt:new Date().toISOString(),requestId:requestId.toLowerCase(),hash})+"\n");await file.sync();return await operation()}finally{await file.close();await unlink(path)}
  }
  async authorizeCompletion(requestId:string,expectedHash:string){
    const p=await this.approved(requestId);if(!p||p.hash!==expectedHash)throw Error("Vault completion has no exact approval");return p;
  }
  private async releaseDeadWriter(requestId:string,hash:string){
    const path=join(this.root,".writer.lock");if(!await exists(path))return;
    const guardPath=join(this.root,".recovery.lock"),guard=await open(guardPath,"wx",0o600);
    try{
      if(!await exists(path))return;
      const bytes=await boundedFile(path,2000),v=JSON.parse(bytes.toString("utf8"));
      if(v.schema!=="negi-vault-writer/1"||!Number.isSafeInteger(v.pid)||v.pid<=0||!isReviewRequestId(v.owner)||
        !Number.isFinite(Date.parse(v.createdAt))||Object.keys(v).length!==6||v.requestId!==requestId.toLowerCase()||v.hash!==hash)throw Error("Vault writer ownership unknown or belongs to another request");
      try{process.kill(v.pid,0);throw Error("Vault writer is still live")}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e}
      if(!(await boundedFile(path,2000)).equals(bytes))throw Error("Vault writer changed during recovery");
      await unlink(path);
    }finally{await guard.close();await unlink(guardPath)}
  }
  async save(raw:unknown,expectedHash:string,requestId:string,updated:string,historicalRoots:string[]=[]){
    return this.locked(requestId,expectedHash,async()=>{
      const existing=await this.approved(requestId);
      if(existing){
        if(existing.hash!==expectedHash||!isDeepStrictEqual(existing.input,input(raw))||existing.updated!==updated)throw Error("Vault approval was reused");
        if(await this.catalog(existing))return {preview:existing,state:"created" as const,error:null};
        throw Error("Approved Vault creation requires explicit completion");
      }
      const rows=await this.approvals();if(rows.length>=64)throw Error("Vault approval limit reached");
      const p=await this.preview(raw,requestId,historicalRoots,updated);
      if(p.hash!==expectedHash)throw Error("Vault preview changed before approval");
      await this.proofs.create({id:p.requestId,action:"operation",caseId:"vault-initialization",runId:p.input.project,artifactSha256:p.hash,
        verificationRef:null,data:{domain:"vault-initialization",preview:JSON.stringify(p)}});
      return this.completeOnce(p,historicalRoots);
    });
  }
  async complete(requestId:string,expectedHash:string,historicalRoots:string[]=[]){
    await this.authorizeCompletion(requestId,expectedHash);
    await this.releaseDeadWriter(requestId,expectedHash);
    return this.locked(requestId,expectedHash,async()=>{
      const p=await this.approved(requestId);if(!p||p.hash!==expectedHash)throw Error("Vault completion has no exact approval");
      return this.completeOnce(p,historicalRoots);
    });
  }
  private async inspect(path:string,p:VaultInitializationPreview,partial=false,requireReady=false){
    await directory(path);
    if((await boundedFile(join(path,MARKER))).toString("utf8")!==p.marker)throw Error("Vault owner marker differs");
    const allowedDirs=new Set(p.directories),allowedFiles=new Map(p.files.map(f=>[f.path,f]));
    const found=new Set<string>();
    const visit=async(dir:string,prefix:string)=>{
      for(const name of await readdir(dir)){
        const rel=prefix+name,full=join(dir,name),s=await lstat(full);
        if(s.isSymbolicLink())throw Error("Vault staged entry is a link");
        if(s.isDirectory()){
          if(!allowedDirs.has(rel))throw Error("Unexpected Vault directory");
          found.add(rel);await visit(full,rel+"/");
        }else if(rel===MARKER){found.add(rel)}
        else if(rel===READY){if((await boundedFile(full)).toString("utf8")!==p.ready)throw Error("Vault ready marker differs");found.add(rel)}
        else{
          const expected=allowedFiles.get(rel);
          if(!expected||sha(await boundedFile(full,30000))!==expected.sha256)throw Error("Vault staged bytes differ");
          found.add(rel);
        }
      }
    };
    await visit(path,"");
    if((!partial||found.has(READY))&&[...p.directories,...p.files.map(f=>f.path),MARKER].some(n=>!found.has(n)))throw Error("Vault publication incomplete");
    if(requireReady&&!found.has(READY))throw Error("Vault readiness not recorded");
  }
  private async completeOnce(p:VaultInitializationPreview,historicalRoots:string[]){
    if(await this.catalog(p))return {preview:p,state:"created" as const,error:null};
    await this.protect(p,historicalRoots);
    const stage=join(dirname(p.input.target),".negi-vault-stage-"+p.requestId),intentPath=join(this.root,p.requestId+".intent.json");
    const intent=await exists(intentPath)?JSON.parse((await boundedFile(intentPath,4000)).toString("utf8")):null;
    const publication=(source:Identity)=>({schema:"negi-vault-publication-intent/1",requestId:p.requestId,hash:p.hash,parent:p.parent,source});
    if(intent&&!isDeepStrictEqual(intent,publication(intent.source)))throw Error("Vault publication intent differs");
    if(await exists(p.input.target)){
      if(!intent||await exists(stage)||!isDeepStrictEqual(await directory(p.input.target),intent.source))throw Error("Existing Vault was not this publication");
      await this.inspect(p.input.target,p,false,true);
    }
    else{
      if(intent&&(!await exists(stage)||!isDeepStrictEqual(await directory(stage),intent.source)))throw Error("Vault publication source changed");
      if(await exists(stage))await this.inspect(stage,p,true);
      else{await mkdir(stage);await writeNew(join(stage,MARKER),p.marker)}
      for(const dir of p.directories)if(!await exists(join(stage,dir)))await mkdir(join(stage,dir));
      for(const f of p.files)if(!await exists(join(stage,f.path)))await writeNew(join(stage,f.path),f.content);
      await this.inspect(stage,p);
      // Validate the actual Vault parser and mandatory closure before publication.
      const inspector=await script("negi_task_authoring.py"),refs=JSON.parse((await exec("python",[inspector,"--vault",stage,"inspect","--project",p.input.project],
        {windowsHide:true,timeout:20000,maxBuffer:200000,env:{...process.env,PYTHONIOENCODING:"utf-8"}})).stdout) as {sources:Array<{path:string;sha256:string}>};
      if(refs.sources.length!==2||refs.sources.some(r=>!p.files.some(f=>f.path===r.path&&f.sha256===r.sha256)))throw Error("Initial Vault references differ");
      await this.protect(p,historicalRoots);await this.inspect(stage,p);
      if(!await exists(join(stage,READY)))await writeNew(join(stage,READY),p.ready);
      await this.inspect(stage,p,false,true);
      const source=await directory(stage),record=publication(source);
      if(intent){if(!isDeepStrictEqual(intent,record))throw Error("Vault publication source changed")}
      else await writeNew(intentPath,JSON.stringify(record)+"\n");
      await exec("python",[await script("negi_publish_vault.py"),"--source",stage,"--target",p.input.target,"--device",p.parent.device,"--inode",p.parent.inode,"--source-device",source.device,"--source-inode",source.inode],
        {windowsHide:true,timeout:20000,maxBuffer:20000,env:{...process.env,PYTHONIOENCODING:"utf-8"}});
      if(!isDeepStrictEqual(await directory(p.input.target),source))throw Error("Published Vault identity changed");
      await this.inspect(p.input.target,p,false,true);
    }
    const bytes=JSON.stringify({schema:"negi-vault-publication/1",requestId:p.requestId,hash:p.hash,target:p.input.target})+"\n";
    const pending=join(this.root,p.requestId+".pending.json"),final=join(this.root,p.requestId+".json");
    if(await exists(pending)){
      if((await boundedFile(pending)).toString("utf8")!==bytes)throw Error("Vault publication candidate differs");
    }else await writeNew(pending,bytes);
    await link(pending,final);await unlink(pending);
    return {preview:p,state:"created" as const,error:null};
  }
}
