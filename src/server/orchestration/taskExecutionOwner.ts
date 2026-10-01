// Durable ownership for the normal Task runner, outside model writable roots.
// A terminal provider turn alone does not prove the host's verification has ended.
import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

interface Owner { schema:"negi-task-execution-owner/1"; id:string; runId:string; configSha256:string;
  claimKey:string; pid:number; at:string }
type ChildEvent={kind:"launch";role:"astra"|"sol"}|{kind:"started";role:"astra"|"sol";pid:number}|{kind:"exited";role:"astra"|"sol";pid:number};
export interface TaskExecutionOwnerView {
  status:"missing"|"live"|"finished"|"dead"|"unknown";
  ownerId:string|null; pid:number|null; childPids:number[]; sha256:string;
  guardPresent:boolean;
}
const digest=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
async function bytes(path:string,limit=32000){
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw Error("Task owner record unsafe");
    const b=await readFile(path);if(b.length>limit)throw Error("Task owner record grew");return b}
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e}
}
const dead=(pid:number)=>{try{process.kill(pid,0);return false}catch(e){return (e as NodeJS.ErrnoException).code==="ESRCH"}};
async function writeNew(path:string,value:unknown){const f=await open(path,"wx",0o600);try{await f.writeFile(JSON.stringify(value)+"\n");await f.sync()}finally{await f.close()}}

export class TaskExecutionOwner {
  private queue:Promise<void>=Promise.resolve();
  private closed=false;
  private readonly children=new Map<string,{pid:number|null;exited:boolean}>();
  private constructor(readonly root:string,private readonly owner:Owner,private readonly guard:Awaited<ReturnType<typeof open>>){}
  static async acquire(directory:string,runId:string,configSha256:string,claimKey:string){
    if(!runId||!claimKey||! /^[0-9a-f]{64}$/.test(configSha256))throw Error("Task execution identity invalid");
    await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw Error("Task execution root cannot be a link");
    const root=await realpath(directory),owner:Owner={schema:"negi-task-execution-owner/1",id:randomUUID(),runId,configSha256,claimKey,pid:process.pid,at:new Date().toISOString()};
    const guard=await open(join(root,"execution-guard.lock"),"wx",0o600);
    try{await guard.writeFile(JSON.stringify(owner)+"\n");await guard.sync();await writeNew(join(root,"execution-owner.json"),owner)}
    catch(e){await guard.close();await unlink(join(root,"execution-guard.lock"));throw e}
    return new TaskExecutionOwner(root,owner,guard);
  }
  private record(event:ChildEvent){
    if(this.closed)throw Error("Task execution owner is closed");
    const operation=this.queue.then(async()=>{const f=await open(join(this.root,"execution-children.jsonl"),"a",0o600);
      try{await f.writeFile(JSON.stringify({...event,ownerId:this.owner.id})+"\n");await f.sync()}finally{await f.close()}});
    this.queue=operation;return operation;
  }
  async launching(role:"astra"|"sol"){
    if(this.children.has(role))throw Error("Task provider already launched");
    await this.record({kind:"launch",role});this.children.set(role,{pid:null,exited:false});
  }
  async started(role:"astra"|"sol",pid:number|null){
    const child=this.children.get(role);if(!child||child.pid!==null||!Number.isSafeInteger(pid)||pid!<=0)throw Error("Task provider ownership incomplete");
    await this.record({kind:"started",role,pid:pid!});child.pid=pid;
  }
  async exited(role:"astra"|"sol",pid:number|null){
    const child=this.children.get(role);if(!child||child.pid!==pid||pid===null||child.exited)throw Error("Task provider exit identity differs");
    await this.record({kind:"exited",role,pid});child.exited=true;
  }
  async finish(){
    if(this.closed)throw Error("Task execution owner is closed");
    try {
      await this.queue;
      if([...this.children.values()].some(c=>c.pid===null||!c.exited))throw Error("Task providers have not all exited; preserve owner guard");
      await writeNew(join(this.root,"execution-finished.json"),{ownerId:this.owner.id,at:new Date().toISOString()});
      await this.guard.close();this.closed=true;await unlink(join(this.root,"execution-guard.lock"));
    } catch(error) { await this.hold();throw error; }
  }
  /** Close the handle without releasing an uncertain execution's durable guard. */
  async hold(){
    if(!this.closed){this.closed=true;await this.guard.close()}
  }
}

/** No process is started, killed or restarted by this inspection. PID reuse is held. */
export async function inspectTaskExecutionOwner(root:string,runId:string,configSha256:string,claimKey:string):Promise<TaskExecutionOwnerView>{
  const ownerBytes=await bytes(join(root,"execution-owner.json")),childBytes=await bytes(join(root,"execution-children.jsonl")),finishedBytes=await bytes(join(root,"execution-finished.json")),guardBytes=await bytes(join(root,"execution-guard.lock"));
  const sha256=digest(JSON.stringify([ownerBytes?.toString("base64")??null,childBytes?.toString("base64")??null,finishedBytes?.toString("base64")??null,guardBytes?.toString("base64")??null]));
  const view:TaskExecutionOwnerView={status:ownerBytes?"unknown":"missing",ownerId:null,pid:null,childPids:[],sha256,guardPresent:guardBytes!==null};
  if(!ownerBytes)return view;
  try{
    const owner=JSON.parse(ownerBytes.toString("utf8")) as Owner;
    if(owner.schema!=="negi-task-execution-owner/1"||! /^[0-9a-f-]{36}$/.test(owner.id)||owner.runId!==runId||owner.configSha256!==configSha256||owner.claimKey!==claimKey||
      !Number.isSafeInteger(owner.pid)||owner.pid<=0||!Number.isFinite(Date.parse(owner.at))||Object.keys(owner).length!==7||
      (guardBytes&&guardBytes.toString("utf8")!==ownerBytes.toString("utf8")))return view;
    view.ownerId=owner.id;view.pid=owner.pid;
    const children=new Map<string,{pid:number|null;exited:boolean}>();
    const text=childBytes?.toString("utf8")??"";if(text&&!text.endsWith("\n"))return view;
    for(const line of text.split("\n").filter(Boolean)){
      const e=JSON.parse(line) as ChildEvent&{ownerId:string};if(e.ownerId!==owner.id||!["astra","sol"].includes(e.role))return view;
      const c=children.get(e.role);
      if(e.kind==="launch"){if(c||Object.keys(e).length!==3)return view;children.set(e.role,{pid:null,exited:false})}
      else if(e.kind==="started"){if(!c||c.pid!==null||!Number.isSafeInteger(e.pid)||e.pid<=0||Object.keys(e).length!==4)return view;c.pid=e.pid;view.childPids.push(e.pid)}
      else if(e.kind==="exited"){if(!c||c.pid!==e.pid||c.exited||Object.keys(e).length!==4)return view;c.exited=true}
      else return view;
    }
    if([...children.values()].some(c=>c.pid===null))return view;
    if(finishedBytes){const finished=JSON.parse(finishedBytes.toString("utf8"));
      if(finished.ownerId!==owner.id||!Number.isFinite(Date.parse(finished.at))||Object.keys(finished).length!==2||[...children.values()].some(c=>!c.exited))return view;
      view.status=guardBytes?(dead(owner.pid)?"dead":"live"):"finished";return view;
    }
    view.status=dead(owner.pid)&&[...children.values()].every(c=>c.exited||dead(c.pid!))?"dead":"live";return view;
  }catch{return view}
}

/** Explicit reconciliation only. Never releases a live, unknown or reused owner. */
export async function releaseDeadTaskExecutionGuard(root:string,runId:string,configSha256:string,claimKey:string,expectedHash:string){
  const guard=await open(join(root,"execution-recovery.lock"),"wx",0o600);
  try{const current=await inspectTaskExecutionOwner(root,runId,configSha256,claimKey);
    if(current.sha256!==expectedHash||current.status!=="dead")throw Error("Task execution owner changed or is not proven dead");
    if(current.guardPresent)await unlink(join(root,"execution-guard.lock"));
  }finally{await guard.close();await unlink(join(root,"execution-recovery.lock"))}
}
