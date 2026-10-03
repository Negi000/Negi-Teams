import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WindowsProcessTree } from "../src/server/master/windowsProcessTree.ts";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";

const exec=promisify(execFile),windows=process.platform==="win32",dead=(pid:number)=>{try{process.kill(pid,0);return false}catch(e){return (e as NodeJS.ErrnoException).code==="ESRCH"}};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function eventually(check:()=>boolean){const until=Date.now()+6000;while(!check()){if(Date.now()>until)throw Error("Owned process did not exit");await pause(20)}}
async function fixture(operation:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),"negi-job-test-"));try{await operation(root)}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}}
const descendant=String.raw`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;

test("Windows Job Object stops root and detached descendants, retaining an unrelated process",{skip:!windows},async()=>fixture(async root=>{
  const foreign=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});
  const childPath=join(root,"child.txt");
  let tree:WindowsProcessTree|null=null;
  try{tree=await WindowsProcessTree.launch({executable:process.execPath,args:["-e",descendant,childPath],cwd:root,env:process.env,trustedRoot:join(root,"trusted")});let childPid=0;const until=Date.now()+5000;
    while(!childPid){try{childPid=Number(await readFile(childPath,"utf8"))}catch{}if(Date.now()>until)throw Error("Descendant not launched");await pause(20)}
    assert.equal(dead(childPid),false);const receipt=await tree.stop();
    assert.equal(receipt.activeProcesses,0);assert.equal(receipt.rootPid,tree.identity.rootPid);
    await eventually(()=>dead(childPid)&&dead(tree!.identity.rootPid));assert.equal(dead(foreign.pid!),false);
  }finally{try{await tree?.stop()}finally{foreign.kill();await new Promise(r=>foreign.once("close",r))}}
}));

test("normal root exit cleans surviving descendants before emitting the empty-job receipt",{skip:!windows},async()=>fixture(async root=>{
  const childPath=join(root,"child.txt"),code=descendant.replace("setInterval(()=>{},1000);","process.exit(7);");
  const tree=await WindowsProcessTree.launch({executable:process.execPath,args:["-e",code,childPath],cwd:root,env:process.env,trustedRoot:join(root,"trusted")});
  const result=await tree.exited;assert.equal(result.receipt?.rootCode,7);assert.equal(result.receipt?.activeProcesses,0);
  const childPid=requireNumber(await readFile(childPath,"utf8"));await eventually(()=>dead(childPid));
}));
function requireNumber(value:string){assert.match(value,/^\d+$/);return Number(value)}

test("supervisor kill cannot leave contained descendants and supplies no false termination receipt",{skip:!windows},async()=>fixture(async root=>{
  const childPath=join(root,"child.txt");const tree=await WindowsProcessTree.launch({executable:process.execPath,args:["-e",descendant,childPath],cwd:root,env:process.env,trustedRoot:join(root,"trusted")});
  let pid=0;const until=Date.now()+5000;while(!pid){try{pid=Number(await readFile(childPath,"utf8"))}catch{}if(Date.now()>until)throw Error("Child not ready");await pause(20)}
  tree.child.kill();const result=await tree.exited;assert.equal(result.receipt,null);await eventually(()=>dead(pid)&&dead(tree.identity.rootPid));
}));

test("contained App Server preserves JSON RPC pipes and sanitized child environment",{skip:!windows},async()=>fixture(async root=>{
  const code=String.raw`const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({auth:process.env.EBI_AUTH_TOKEN??null,job:process.env.NEGI_JOB_TOKEN??null,policy:process.env.NEGI_POLICY_SIGNING_SECRET??null}));let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture'}})+'\n')}});`;
  const resultPath=join(root,"env.json");
  const host=await AppServerProcess.launchContained({executable:process.execPath,args:["-e",code,resultPath],cwd:root,env:{...process.env,EBI_AUTH_TOKEN:"fixture-secret",ebi_auth_token:"fixture-lower",NEGI_POLICY_SIGNING_SECRET:"fixture-policy",negi_policy_signing_secret:"fixture-alias",NEGI_JOB_TOKEN:"fixture-token"}},join(root,"trusted"));
  try{await host.client.initialize();assert.equal(host.treeIdentity?.rootPid,host.pid);assert.deepEqual(JSON.parse(await readFile(resultPath,"utf8")),{auth:null,job:null,policy:null})}finally{const exit=await host.stop();assert.equal(exit.treeReceipt?.activeProcesses,0)}
}));

test("missing executable never falls back to an uncontained launch",{skip:!windows},async()=>fixture(async root=>{
  await assert.rejects(WindowsProcessTree.launch({executable:join(root,"missing.exe"),args:[],cwd:root,env:process.env,trustedRoot:join(root,"trusted")}),/CreateContainedProcess/);
  const result=await exec("powershell.exe",["-NoProfile","-NonInteractive","-Command",`@(Get-CimInstance Win32_Process -Filter "Name='Supervisor.exe'" | Where-Object { $_.ExecutablePath -like '${root.replaceAll("'","''")}*' }).Count`],{windowsHide:true});
  assert.equal(Number(result.stdout.trim()),0);
}));

test("parent death closes the control channel and stops supervisor, root and detached descendants",{skip:!windows},async()=>fixture(async root=>{
  const parentPath=join(root,"parent.mts"),identityPath=join(root,"identity.json"),childPath=join(root,"child.txt");
  const config={executable:process.execPath,args:["-e",descendant,childPath],cwd:root,trustedRoot:join(root,"trusted")};
  await writeFile(parentPath,`import {WindowsProcessTree} from ${JSON.stringify(pathToFileURL(join(process.cwd(),"src/server/master/windowsProcessTree.ts")).href)};import {writeFile} from 'node:fs/promises';const config=${JSON.stringify(config)};const t=await WindowsProcessTree.launch({...config,env:process.env});await writeFile(${JSON.stringify(identityPath)},JSON.stringify(t.identity));setInterval(()=>{},1000);`);
  const parent=spawn(process.execPath,["--import",pathToFileURL(join(process.cwd(),"node_modules/tsx/dist/loader.mjs")).href,parentPath],{stdio:"ignore",windowsHide:true});
  const closed=new Promise<void>(resolve=>parent.once("close",()=>resolve()));
  try{let identity:{rootPid:number;supervisorPid:number}|null=null,childPid=0;const until=Date.now()+10_000;
    while(!identity||!childPid){try{identity=JSON.parse(await readFile(identityPath,"utf8"));childPid=Number(await readFile(childPath,"utf8"))}catch{}if(Date.now()>until)throw Error("Disposable parent failed to launch tree");await pause(20)}
    parent.kill();await closed;await eventually(()=>dead(identity!.rootPid)&&dead(identity!.supervisorPid)&&dead(childPid));
  }finally{parent.kill();await closed}
}));

const nativeLaunch=String.raw`
using System;using System.IO;using System.Text;using System.Management;using System.Runtime.InteropServices;
class Fixture {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct S { public uint size;public string r,d,t;public uint a,b,c,e,f,g,h,flags;public ushort show,r2;public IntPtr p,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct P { public IntPtr process,thread;public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref S start,out P process);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static void Main(string[] args) {
   string command="\""+args[0]+"\" -e \"setInterval(()=>{},1000)\" \""+args[3]+"\"";
   bool success=false;uint pid=0;int error;
   if(args[2]=="breakaway") {var start=new S();start.size=(uint)Marshal.SizeOf(typeof(S));P p;
     success=CreateProcess(args[0],new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000,IntPtr.Zero,null,ref start,out p);
     error=success?0:Marshal.GetLastWin32Error();if(success){pid=p.pid;CloseHandle(p.process);CloseHandle(p.thread);}
   } else {var process=new ManagementClass("Win32_Process");object[] parameters={command,null,null,(uint)0};
     error=Convert.ToInt32(process.InvokeMethod("Create",parameters));success=error==0;if(success)pid=Convert.ToUInt32(parameters[3]);}
   File.WriteAllText(args[1],"{\"success\":"+(success?"true":"false")+",\"pid\":"+pid+",\"error\":"+error+"}");
 }
}`;
for(const mode of ["breakaway","broker"] as const)test(mode==="breakaway"?
  "explicit native breakaway is refused by the job":"WMI broker can escape job membership, so an empty receipt is insufficient for Task close",
  {skip:!windows},async()=>fixture(async root=>{
    const source=join(root,"Native.cs"),executable=join(root,"Native.exe"),resultPath=join(root,"result.json");
    await writeFile(source,nativeLaunch);await exec(join(process.env.WINDIR??"C:/Windows","Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
      ["/nologo","/target:exe","/platform:x64","/reference:System.Management.dll","/out:"+executable,source],{windowsHide:true});
    const tree=await WindowsProcessTree.launch({executable,args:[process.execPath,resultPath,mode,"negi-escape-"+root.split(/[\\/]/).at(-1)],cwd:root,env:process.env,trustedRoot:join(root,"trusted")});
    let pid=0;
    try{const result=await tree.exited;assert.equal(result.receipt?.activeProcesses,0);
      const data=JSON.parse(await readFile(resultPath,"utf8"));pid=data.pid;
      if(mode==="breakaway"){assert.equal(data.success,false);assert.equal(data.error,5);assert.equal(pid,0)}
      else{assert.equal(data.success,true);assert.equal(dead(pid),false)}
    }finally{await tree.stop();if(pid>0){process.kill(pid);await eventually(()=>dead(pid))}}
  }));
