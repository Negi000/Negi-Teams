// Human-confirmed settings revisions. Old execution profiles are never rewritten;
// saving a revision holds new intents until a verified server restart.
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import { LocalProjectSetup, type ProjectSettings, type ProjectSetupPreview } from "./projectSetup.ts";

const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export type ConfigurationChange={kind:"upsert";settings:ProjectSettings}|{kind:"archive";id:string}|{kind:"restore";version:number};
interface ProjectVersion { id:string; executionId:string; preview:ProjectSetupPreview }
export interface ProjectConfiguration { schema:"negi-project-configuration/1";version:number;previousHash:string;
  projects:ProjectVersion[];hash:string }
export interface ConfigurationPreview { configuration:ProjectConfiguration; change:ConfigurationChange; affected:string[] }
interface Publication { requestId:string; preview:ConfigurationPreview }
async function json<T>(path:string):Promise<T>{
  const f=await lstat(path);if(!f.isFile()||f.isSymbolicLink()||f.size>500_000)throw Error("Configuration record invalid");
  const bytes=await readFile(path);if(bytes.length>500_000)throw Error("Configuration record grew");return JSON.parse(bytes.toString("utf8"));
}
function revision(version:number,previousHash:string,projects:ProjectVersion[]):ProjectConfiguration{
  const core={schema:"negi-project-configuration/1" as const,version,previousHash,projects};return {...core,hash:hash(core)};
}
function identity(p:ProjectSettings){return JSON.stringify([p.repository,p.vault,p.project]);}
export class ConfigurationPendingError extends Error {
  constructor(){super("設定を保存済みです。プロジェクト設定で版を確認し、サーバーを再起動してください。新しい作業は開始していません。");this.name="ConfigurationPendingError";}
}
export type ConfigurationAdmission=<T>(operation:()=>Promise<T>)=>Promise<T>;
interface VaultWriter { requestId:string;hash:string;complete?:boolean }
export class LocalProjectConfiguration {
  private constructor(readonly setup:LocalProjectSetup,private readonly proofs:HumanReviewProofStore,private readonly root:string){}
  static async open(setup:LocalProjectSetup){
    const root=join(setup.root,"configuration-revisions");await mkdir(root,{recursive:true});
    if((await lstat(root)).isSymbolicLink())throw Error("Configuration history cannot be a link");
    return new LocalProjectConfiguration(setup,await HumanReviewProofStore.open(join(setup.root,"configuration-approvals")),root);
  }
  private path(version:number){return join(this.root,String(version).padStart(5,"0")+".json");}
  private pendingPath(version:number){return join(this.root,String(version).padStart(5,"0")+".pending.json");}
  async history():Promise<ProjectConfiguration[]>{return this.readHistory();}
  /** Trusted file creation shares the writer and every historical source root. */
  async withStableHistory<T>(operation:(history:ProjectConfiguration[])=>Promise<T>,writer?:VaultWriter):Promise<T>{
    if(writer&&(!isReviewRequestId(writer.requestId)||! /^[0-9a-f]{64}$/.test(writer.hash)))throw Error("Vault writer identity invalid");
    if(writer?.complete){
      // Explicit completion requires a signed Vault request and intact settings
      // history before releasing a known dead shared writer. Partial/live/unknown
      // ownership is retained by releaseDeadWriter; reads never repair it.
      await this.setup.vaults.authorizeCompletion(writer.requestId,writer.hash);
      await this.history();await this.releaseDeadWriter(writer);
    }
    return this.locked(async()=>operation(await this.history()),writer);
  }
  private async readHistory(pendingRequestId?:string):Promise<ProjectConfiguration[]>{
    const first=await this.setup.current(),names=(await readdir(this.root)).sort();
    if(!first){if(names.length||(await readdir(this.proofs.root)).length>1)throw Error("Configuration anchor missing");return []}
    const pending=names.filter(n=>/^[0-9]{5}\.pending\.json$/.test(n));
    if(pending.length&&(!pendingRequestId||pending.length!==1))throw Error("Configuration publication requires reconciliation");
    const finals=names.filter(n=>/^[0-9]{5}\.json$/.test(n));
    if(finals.length+pending.length!==names.length||finals.length>63)throw Error("Configuration history limit or file identity invalid");
    const rows=[revision(1,first.hash,[{id:first.settings.id,executionId:first.settings.id,preview:first}])],published=new Set<string>();
    for(const name of finals){
      const previous=rows.at(-1)!,version=previous.version+1;
      if(name!==String(version).padStart(5,"0")+".json")throw Error("Configuration history has a gap or partial publication");
      const saved=await json<Publication>(this.path(version)),c=saved.preview?.configuration,receipt=await this.proofs.read(saved.requestId);
      if(!c||c.schema!=="negi-project-configuration/1"||c.version!==version||c.previousHash!==previous.hash||
        !Array.isArray(c.projects)||!c.projects.length||c.projects.length>20||
        c.hash!==revision(c.version,c.previousHash,c.projects).hash||!isReviewRequestId(saved.requestId)||
        !receipt||receipt.action!=="operation"||receipt.caseId!=="project-configuration"||receipt.runId!==String(version)||
        receipt.artifactSha256!==c.hash||receipt.verificationRef!==null||
        !isDeepStrictEqual(receipt.data,{domain:"project-configuration",previewSha256:hash(saved.preview)}))throw Error("Signed configuration differs");
      rows.push(c);
      published.add(saved.requestId.toLowerCase());
    }
    const proofs=await readdir(this.proofs.root);if(proofs.length>64)throw Error("Configuration approvals require reconciliation");
    if(pendingRequestId)published.add(pendingRequestId.toLowerCase());
    for(const name of proofs)if(name!=="server-signing-key"){
      if(!/^[0-9a-f-]{36}\.json$/.test(name)||!published.has(name.slice(0,-5)))throw Error("Signed configuration was not completely published; preserve and reconcile it");
    }
    const all=new Map<string,ProjectVersion>();
    for(const c of rows){
      if(new Set(c.projects.map(p=>p.id)).size!==c.projects.length||new Set(c.projects.map(p=>identity(p.preview.settings))).size!==c.projects.length)
        throw Error("Project identity repeated");
      const planner=c.projects[0].preview.settings.astra;
      for(const p of c.projects){
        const {hash:expected,...core}=p.preview;
        if(p.id!==p.preview.settings.id||!/^[-a-zA-Z0-9._]{1,100}$/.test(p.executionId)||expected!==hash(core)||
          !isDeepStrictEqual(p.preview.settings.astra,planner)||p.preview.settings.executable!==c.projects[0].preview.settings.executable)throw Error("Project profile identity or shared planner differs");
        const prior=all.get(p.executionId);if(prior&&!isDeepStrictEqual(prior,p))throw Error("Execution version was rewritten");all.set(p.executionId,p);
      }
    }
    return rows;
  }
  async current(){return (await this.history()).at(-1)??null;}
  async writerHeld(){
    try{await lstat(join(this.setup.root,"configuration-writer.lock"));return true}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e}
  }
  async preview(raw:unknown,expectedCurrentHash:string):Promise<ConfigurationPreview>{
    const rows=await this.history(),current=rows.at(-1);
    if(!current||current.hash!==expectedCurrentHash||current.version>=64)throw Error("Configuration changed or history is full");
    const input=raw as Record<string,unknown>;if(!input||Array.isArray(input)||Object.keys(input).length!==2)throw Error("Configuration change invalid");
    let settings:ProjectSettings[],change:ConfigurationChange;
    if(input.kind==="upsert"&&"settings" in input){
      const p=await this.setup.preview(input.settings),s=p.settings;
      const prior=rows.flatMap(r=>r.projects).find(p=>p.id===s.id);
      if(prior&&identity(prior.preview.settings)!==identity(s))throw Error("Project location is immutable; add a separate project");
      if(rows.flatMap(r=>r.projects).some(p=>p.id!==s.id&&identity(p.preview.settings)===identity(s)))throw Error("Project namespace is reserved by its original identity");
      // One resident Astra plans for every project. The preview names all affected projects.
      settings=current.projects.filter(p=>p.id!==s.id).map(p=>({...p.preview.settings,astra:s.astra,executable:s.executable}));settings.push(s);
      change={kind:"upsert",settings:s};
    }else if(input.kind==="archive"&&typeof input.id==="string"){
      if(!current.projects.some(p=>p.id===input.id))throw Error("Project missing");
      settings=current.projects.filter(p=>p.id!==input.id).map(p=>p.preview.settings);change={kind:"archive",id:input.id};
    }else if(input.kind==="restore"&&Number.isSafeInteger(input.version)){
      const old=rows.find(r=>r.version===input.version);if(!old)throw Error("Configuration version missing");
      settings=old.projects.map(p=>p.preview.settings);change={kind:"restore",version:Number(input.version)};
    }else throw Error("Configuration operation invalid");
    if(!settings.length||settings.length>20||new Set(settings.map(identity)).size!==settings.length||new Set(settings.map(p=>p.id.toLowerCase())).size!==settings.length)throw Error("Keep one to twenty distinct projects");
    const overlaps=(a:string,b:string)=>{const r=relative(process.platform==="win32"?a.toLowerCase():a,process.platform==="win32"?b.toLowerCase():b);return !r||(!r.startsWith("..")&&!isAbsolute(r));};
    for(const a of settings)for(const b of settings)if(overlaps(a.repository,b.vault)||overlaps(b.vault,a.repository))throw Error("Project code and specification roots overlap");
    settings.sort((a,b)=>a.id.localeCompare(b.id));const projects:ProjectVersion[]=[],affected:string[]=[];
    for(const s of settings){
      const old=current.projects.find(p=>p.id===s.id);
      if(old&&isDeepStrictEqual(old.preview.settings,s)){projects.push(old);continue}
      const preview=await this.setup.preview(s),executionId="cfg-"+String(current.version+1)+"-"+hash([s.id,preview.hash]).slice(0,24);
      projects.push({id:s.id,executionId,preview});affected.push(s.id);
    }
    for(const old of current.projects)if(!projects.some(p=>p.id===old.id))affected.push(old.id);
    if(!affected.length)throw Error("Configuration has no changes");
    return {configuration:revision(current.version+1,current.hash,projects),change,affected:affected.sort()};
  }
  private async locked<T>(operation:()=>Promise<T>,vault?:VaultWriter):Promise<T>{
    const path=join(this.setup.root,"configuration-writer.lock"),lock=await open(path,"wx",0o600);
    try{
      await lock.writeFile(JSON.stringify({schema:"negi-configuration-writer/1",pid:process.pid,owner:randomUUID(),createdAt:new Date().toISOString(),
        ...(vault?{operation:{domain:"vault-initialization",requestId:vault.requestId.toLowerCase(),hash:vault.hash}}:{})})+"\n");await lock.sync();
      return await operation();
    }finally{await lock.close();await unlink(path)}
  }
  async save(change:unknown,expectedCurrentHash:string,expectedHash:string,requestId:string){
    if(!isReviewRequestId(requestId)||! /^[0-9a-f]{64}$/.test(expectedHash))throw Error("Configuration approval identity invalid");
    requestId=requestId.toLowerCase();
    return this.locked(async()=>{
      const history=await this.history();
      for(const c of history.slice(1)){
        const saved=await json<Publication>(this.path(c.version));
        if(saved.requestId===requestId){if(c.hash!==expectedHash||c.previousHash!==expectedCurrentHash||!isDeepStrictEqual(saved.preview.change,change))throw Error("Request reused");return saved.preview}
      }
      if(await this.proofs.read(requestId))throw Error("Signed configuration publication requires reconciliation");
      const preview=await this.preview(change,expectedCurrentHash);
      if(preview.configuration.hash!==expectedHash)throw Error("Project settings or references changed before approval");
      // Preserve complete bytes before authorization/publication. A crash retains a
      // pending record; only an exact signed one can be completed by the human.
      const pending=this.pendingPath(preview.configuration.version),file=await open(pending,"wx",0o600);
      try{await file.writeFile(JSON.stringify({requestId,preview})+"\n");await file.sync()}finally{await file.close()}
      await this.proofs.create({id:requestId,action:"operation",caseId:"project-configuration",runId:String(preview.configuration.version),
        artifactSha256:expectedHash,verificationRef:null,data:{domain:"project-configuration",previewSha256:hash(preview)}});
      await link(pending,this.path(preview.configuration.version));await this.syncDirectory();
      await unlink(pending);await this.syncDirectory();
      return preview;
    });
  }
  private async syncDirectory(){
    // Windows does not expose directory fsync through Node. Missing final entries
    // are still detected by their independent signed approval; never roll back.
    if(process.platform==="win32")return;
    const directory=await open(this.root,"r");try{await directory.sync()}finally{await directory.close()}
  }
  async recovery(){
    const names=(await readdir(this.root)).filter(n=>/^[0-9]{5}\.pending\.json$/.test(n));if(!names.length)return null;
    if(names.length!==1)throw Error("Multiple partial configuration publications");
    const saved=await json<Publication>(join(this.root,names[0])),rows=await this.readHistory(saved.requestId),c=saved.preview.configuration;
    const last=rows.at(-1)!,published=c.version===last.version,previous=published?rows.at(-2):last,receipt=await this.proofs.read(saved.requestId);
    if(!previous||names[0]!==String(c.version).padStart(5,"0")+".pending.json"||c.version!==previous.version+1||c.previousHash!==previous.hash||
      c.hash!==revision(c.version,c.previousHash,c.projects).hash||!receipt||receipt.action!=="operation"||receipt.caseId!=="project-configuration"||
      receipt.runId!==String(c.version)||receipt.artifactSha256!==c.hash||receipt.verificationRef!==null||
      !isDeepStrictEqual(receipt.data,{domain:"project-configuration",previewSha256:hash(saved.preview)})||
      (published&&!isDeepStrictEqual(await json(this.path(c.version)),saved)))throw Error("Partial configuration cannot be safely completed");
    return {requestId:saved.requestId,preview:saved.preview,published};
  }
  async recover(requestId:string,expectedHash:string){
    if(!isReviewRequestId(requestId)||! /^[0-9a-f]{64}$/.test(expectedHash))throw Error("Recovery target invalid");
    // This explicit human action may release only the exact dead writer for an
    // already signed pending publication. Never guess, steal a live lock or kill.
    const candidate=await this.recovery();
    if(candidate&&(candidate.requestId!==requestId.toLowerCase()||candidate.preview.configuration.hash!==expectedHash))throw Error("Recovery target differs");
    if(candidate)await this.releaseDeadWriter();
    return this.locked(async()=>{
      const pending=await this.recovery();if(!pending){const c=await this.current();if(!c||c.hash!==expectedHash||
        (await json<Publication>(this.path(c.version))).requestId!==requestId.toLowerCase())throw Error("Recovery already changed");return c;}
      const c=pending.preview.configuration;if(pending.requestId!==requestId.toLowerCase()||c.hash!==expectedHash)throw Error("Recovery target differs");
      if(!pending.published){await link(this.pendingPath(c.version),this.path(c.version));await this.syncDirectory();}
      await unlink(this.pendingPath(c.version));await this.syncDirectory();return (await this.current())!;
    });
  }
  private async releaseDeadWriter(vault?:VaultWriter){
    const path=join(this.setup.root,"configuration-writer.lock");
    try{await lstat(path)}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e}
    const guardPath=join(this.setup.root,"configuration-recovery.lock"),guard=await open(guardPath,"wx",0o600);
    try{
      let value:{schema:string;pid:number;owner:string;createdAt:string;operation?:unknown};
      try{value=await json(path)}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e}
      if(value.schema!=="negi-configuration-writer/1"||!Number.isSafeInteger(value.pid)||value.pid<=0||!isReviewRequestId(value.owner)||
        !Number.isFinite(Date.parse(value.createdAt))||Object.keys(value).length!==(vault?5:4)||
        vault&&!isDeepStrictEqual(value.operation,{domain:"vault-initialization",requestId:vault.requestId.toLowerCase(),hash:vault.hash}))throw Error("Writer ownership is unknown or belongs to another operation; preserve it");
      try{process.kill(value.pid,0);throw Error("Configuration writer is still live");}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e;}
      if(!isDeepStrictEqual(await json(path),value))throw Error("Configuration writer changed during reconciliation");
      await unlink(path);
    }finally{await guard.close();await unlink(guardPath)}
  }
  /** Shares the settings writer with every new durable intent; existing work and stop/read stay available. */
  async admit<T>(bootHash:string,operation:()=>Promise<T>):Promise<T>{
    return this.locked(async()=>{if((await this.current())?.hash!==bootHash)throw new ConfigurationPendingError();return operation()});
  }
  async startup(configuration:ProjectConfiguration){
    if(await this.writerHeld())throw Error("Configuration writer requires reconciliation before startup");
    const rows=await this.history();if(!isDeepStrictEqual(rows.at(-1),configuration))throw Error("Configuration changed before startup");
    const all=new Map<string,ProjectVersion>();for(const r of rows)for(const p of r.projects)all.set(p.executionId,p);
    const active=new Set(configuration.projects.map(p=>p.executionId));
    return this.setup.runtimeProfiles([...configuration.projects,...[...all.values()].filter(p=>!active.has(p.executionId))]
      .map(p=>({id:p.executionId,preview:p.preview,active:active.has(p.executionId)})));
  }
}
