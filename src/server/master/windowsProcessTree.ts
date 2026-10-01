// Windows 10+ local Job Object supervisor. Unsupported/failed containment never
// falls back to an ordinary spawn. These receipts prove job membership, not an OS sandbox.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, lstat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, isAbsolute, resolve, delimiter, extname } from "node:path";
import { promisify } from "node:util";
import { windowsJobSource } from "./windowsJobSource.ts";

const exec=promisify(execFile),hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
export interface ProcessTreeIdentity { schema:"negi-windows-job/1"; id:string; rootPid:number; supervisorPid:number; helperSha256:string }
export interface ProcessTreeReceipt extends ProcessTreeIdentity { activeProcesses:0; rootCode:number; at:string }
export function isProcessTreeIdentity(value:unknown):value is ProcessTreeIdentity{
  const v=value as ProcessTreeIdentity|null;
  return Boolean(v&&typeof v==="object"&&Object.keys(v).length===5&&v.schema==="negi-windows-job/1"&&
    typeof v.id==="string"&&/^[0-9a-f-]{36}$/.test(v.id)&&Number.isSafeInteger(v.rootPid)&&v.rootPid>0&&
    Number.isSafeInteger(v.supervisorPid)&&v.supervisorPid>0&&v.rootPid!==v.supervisorPid&&
    typeof v.helperSha256==="string"&&/^[0-9a-f]{64}$/.test(v.helperSha256));
}
export function matchesProcessTreeReceipt(identity:ProcessTreeIdentity,value:unknown):value is ProcessTreeReceipt{
  const v=value as ProcessTreeReceipt|null;if(!v||typeof v!=="object"||Object.keys(v).length!==8)return false;
  const {activeProcesses,rootCode,at,...registered}=v;
  return isProcessTreeIdentity(registered)&&JSON.stringify(registered)===JSON.stringify(identity)&&activeProcesses===0&&
    Number.isSafeInteger(rootCode)&&rootCode>=0&&rootCode<=0xffffffff&&typeof at==="string"&&Number.isFinite(Date.parse(at));
}
export interface ContainedProcessOptions {executable:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;trustedRoot:string}
export async function resolveWindowsCommand(program:string,cwd:string,env:NodeJS.ProcessEnv):Promise<string>{
  const candidates=isAbsolute(program)||/[\\/]/.test(program)?[resolve(cwd,program)]:
    (env.PATH??env.Path??"").split(delimiter).filter(Boolean).map(dir=>join(dir,program));
  for(const path of candidates)for(const candidate of extname(path)?[path]:[path+".exe",path]){
    try{if((await lstat(candidate)).isFile())return await realpath(candidate)}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e}
  }
  throw Error("Configured Windows verification executable not found");
}
const compiled=new Map<string,Promise<{path:string;sha256:string}>>();
async function helper(directory:string){
  if(process.platform!=="win32")throw Error("Windows Job Object containment is unavailable on this platform");
  if(!isAbsolute(directory))throw Error("Process containment requires an absolute trusted root");
  await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw Error("Process tree root cannot be a link");
  const root=await realpath(directory);
  let pending=compiled.get(root);
  if(!pending){pending=(async()=>{
    const output=await mkdtemp(join(root,"job-supervisor-")),source=join(output,"Supervisor.cs"),path=join(output,"Supervisor.exe");
    const f=await open(source,"wx",0o600);try{await f.writeFile(windowsJobSource);await f.sync()}finally{await f.close()}
    const compiler=join(process.env.WINDIR??"C:/Windows","Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    await exec(compiler,["/nologo","/target:exe","/platform:x64","/reference:System.Web.Extensions.dll","/out:"+path,source],
      {windowsHide:true,timeout:30_000,maxBuffer:1_000_000});
    if(!(await lstat(path)).isFile())throw Error("Job supervisor output invalid");
    return {path,sha256:hash(await readFile(path))};
  })();compiled.set(root,pending)}
  const value=await pending;
  const s=await lstat(value.path);if(!s.isFile()||s.isSymbolicLink()||hash(await readFile(value.path))!==value.sha256)
    throw Error("Compiled Job supervisor changed");
  return value;
}

export class WindowsProcessTree {
  private constructor(readonly child:ChildProcessWithoutNullStreams,readonly identity:ProcessTreeIdentity,
    readonly exited:Promise<{receipt:ProcessTreeReceipt|null;code:number|null;error:string|null}>,private readonly control:Socket){}
  static async launch(options:ContainedProcessOptions):Promise<WindowsProcessTree>{
    if(!isAbsolute(options.executable)||!isAbsolute(options.cwd)||options.args.some(v=>typeof v!=="string"||v.includes("\0")))
      throw Error("Contained process options invalid");
    const binary=await helper(options.trustedRoot),id=randomUUID(),token=randomBytes(32).toString("hex"),pipeName="negi-job-"+id;
    const server=createServer(),endpoint="\\\\.\\pipe\\"+pipeName;
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(endpoint,resolve)});
    let child:ChildProcessWithoutNullStreams|null=null,socket:Socket|null=null,rootPid:number|null=null,receipt:ProcessTreeReceipt|null=null;
    let completed:Promise<{receipt:ProcessTreeReceipt|null;code:number|null;error:string|null}>|null=null;
    let error:string|null=null,readyResolve:(value:Socket)=>void=()=>{},readyReject:(error:Error)=>void=()=>{};
    const ready=new Promise<Socket>((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
    // Observe the promise immediately, even if a spawn error precedes awaiting it.
    void ready.catch(()=>{});
    const timeout=setTimeout(()=>{readyReject(Error("Job supervisor startup timed out"));socket?.destroy();child?.kill()},15_000);
    server.on("connection",connection=>{
      if(socket){connection.destroy();return}socket=connection;server.close();let buffer="",authenticated=false;
      connection.setEncoding("utf8");
      connection.on("error",e=>{error=e.message;readyReject(e)});
      connection.on("data",chunk=>{
        buffer+=chunk;if(buffer.length>16_000){connection.destroy();error="Job supervisor message too large";readyReject(Error(error));return}
        let end:number;
        while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          try{const value=JSON.parse(line);
            if(!authenticated){
              const provided=typeof value.token==="string"?Buffer.from(value.token):Buffer.alloc(0),expected=Buffer.from(token);
              if(value.kind!=="hello"||provided.length!==expected.length||!timingSafeEqual(provided,expected))throw Error("Job supervisor identity mismatch");
              authenticated=true;
              const env=Object.fromEntries(Object.entries(options.env).filter(([key,value])=>key.toUpperCase()!=="NEGI_JOB_TOKEN"&&typeof value==="string"));
              const config=JSON.stringify({executable:options.executable,args:options.args,cwd:options.cwd,env});
              if(Buffer.byteLength(config)>500_000)throw Error("Contained process configuration too large");connection.write(config+"\n");
            }else if(value.kind==="started"&&rootPid===null&&Number.isSafeInteger(value.rootPid)&&value.rootPid>0){rootPid=value.rootPid;clearTimeout(timeout);readyResolve(connection)}
            else if(value.kind==="empty"&&rootPid!==null&&value.rootPid===rootPid&&value.active===0&&Number.isSafeInteger(value.rootCode)&&value.rootCode>=0&&value.rootCode<=0xffffffff&&!receipt){
              receipt={schema:"negi-windows-job/1",id,rootPid,supervisorPid:child!.pid!,helperSha256:binary.sha256,activeProcesses:0,rootCode:value.rootCode,at:new Date().toISOString()};
              connection.write("ack\n");
            }else if(value.kind==="error"){error=typeof value.error==="string"?value.error.slice(0,1000):"Job supervisor failed";readyReject(Error(error??"Job supervisor failed"))}
            else throw Error("Job supervisor event invalid");
          }catch(e){error=(e as Error).message;readyReject(e as Error);connection.destroy()}
        }
      });
      connection.on("end",()=>{if(rootPid===null)readyReject(Error("Job supervisor channel closed before containment"))});
    });
    try{
      const helperEnv=Object.fromEntries(Object.entries(options.env).filter(([key])=>key.toUpperCase()!=="NEGI_JOB_TOKEN"));
      child=spawn(binary.path,[pipeName],{cwd:options.cwd,env:{...helperEnv,NEGI_JOB_TOKEN:token},stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true});
      const exited=new Promise<{receipt:ProcessTreeReceipt|null;code:number|null;error:string|null}>(resolve=>{
        child!.on("error",e=>{error=e.message;readyReject(e)});
        child!.on("close",code=>{clearTimeout(timeout);server.close();socket?.destroy();if(rootPid===null)readyReject(Error(error??"Job supervisor exited before containment"));
          resolve({receipt:error||code!==0?null:receipt,code,error:error??(receipt?null:"Job exit confirmation unavailable")})});
      });
      completed=exited;
      const control=await ready;
      return new WindowsProcessTree(child,{schema:"negi-windows-job/1",id,rootPid:rootPid!,supervisorPid:child.pid!,helperSha256:binary.sha256},exited,control);
    }catch(e){clearTimeout(timeout);server.close();(socket as Socket|null)?.destroy();child?.kill();if(completed)await completed;throw e}
  }
  async stop(graceMs=3000){
    if(!Number.isSafeInteger(graceMs)||graceMs<1||graceMs>120_000)throw Error("Contained stop grace invalid");
    if(!this.control.destroyed)this.control.write("stop\n");
    const timer=setTimeout(()=>this.child.kill(),graceMs);
    try{const result=await this.exited;if(!result.receipt)throw Error(result.error??"Contained process termination was not confirmed");return result.receipt}
    finally{clearTimeout(timer)}
  }
}
