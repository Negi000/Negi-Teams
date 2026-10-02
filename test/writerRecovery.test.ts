import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { recoverWriter, type WriterOperation } from "../src/server/orchestration/writerRecovery.ts";

test("native operation recovery preserves wrong domains, unknown ownership, duplicate fields, live PIDs and legacy guards",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"negi-writer-")));
  try{
    const dead=spawnSync(process.execPath,["-e",""],{windowsHide:true});assert.equal(dead.status,0);
    for(const kind of ["vault","configuration"] as const){
      const operation:WriterOperation={domain:kind==="vault"?"vault-initialization":"project-configuration",requestId:randomUUID(),hash:"a".repeat(64)};
      const writer=join(root,kind==="vault"?".writer.lock":"configuration-writer.lock");
      const value={schema:kind==="vault"?"negi-vault-writer/1":"negi-configuration-writer/1",pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString(),
        ...(kind==="vault"?{requestId:operation.requestId,hash:operation.hash}:{operation})};
      for(const bytes of ["{",JSON.stringify({...value,pid:process.pid}),JSON.stringify({...value,owner:"unknown"}),
        JSON.stringify(value).replace('{','{"pid":1,'),JSON.stringify({...value,extra:true})]){
        await writeFile(writer,bytes);await assert.rejects(recoverWriter(root,kind,operation));assert.equal(await readFile(writer,"utf8"),bytes);
      }
      const exact=JSON.stringify(value);await writeFile(writer,exact);
      await assert.rejects(recoverWriter(root,kind,{...operation,requestId:randomUUID()}));assert.equal(await readFile(writer,"utf8"),exact);
      await assert.rejects(recoverWriter(root,kind,{...operation,domain:kind==="vault"?"project-configuration":"vault-initialization"}));
      assert.equal(await readFile(writer,"utf8"),exact);
      const alias=join(root,"writer-alias");await link(writer,alias);await assert.rejects(recoverWriter(root,kind,operation));await unlink(alias);
      const legacy=join(root,kind==="vault"?".recovery.lock":"configuration-recovery.lock");await writeFile(legacy,"");
      await assert.rejects(recoverWriter(root,kind,operation));assert.equal(await readFile(writer,"utf8"),exact);await unlink(legacy);
      await recoverWriter(root,kind,operation);await assert.rejects(readFile(writer));
      await recoverWriter(root,kind,operation); // already absent; no writer created
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

test("killing a child inside the native recovery guard releases exclusion for the exact dead writer",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"negi-guard-cut-")));let child:ReturnType<typeof spawn>|undefined;
  try{
    const dead=spawnSync(process.execPath,["-e",""],{windowsHide:true});assert.equal(dead.status,0);
    for(const kind of ["vault","configuration"] as const){
      const operation:WriterOperation={domain:kind==="vault"?"vault-initialization":"project-configuration",requestId:randomUUID(),hash:"b".repeat(64)};
      const writer=join(root,kind==="vault"?".writer.lock":"configuration-writer.lock"),bytes=JSON.stringify({schema:kind==="vault"?"negi-vault-writer/1":"negi-configuration-writer/1",
        pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString(),...(kind==="vault"?{requestId:operation.requestId,hash:operation.hash}:{operation})});
      await writeFile(writer,bytes);
      child=spawn("python",[fileURLToPath(new URL("./helpers/holdWriterRecovery.py",import.meta.url)),root,kind],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let errors="";child.stderr!.on("data",data=>errors+=data);
      await new Promise<void>((resolve,reject)=>{child!.stdout!.once("data",data=>String(data).trim()==="held"?resolve():reject(Error("guard did not settle")));
        child!.once("error",reject);child!.once("exit",()=>reject(Error("guard child exited: "+errors)))});
      await assert.rejects(recoverWriter(root,kind,operation));assert.equal(await readFile(writer,"utf8"),bytes);
      const ended=new Promise<void>(resolve=>child!.once("exit",()=>resolve()));child.kill("SIGKILL");await ended;
      await recoverWriter(root,kind,operation);await assert.rejects(readFile(writer));
    }
    assert.ok(!(await readdir(root)).some(name=>[".recovery.lock","configuration-recovery.lock"].includes(name)));
  }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await rm(root,{recursive:true,force:true})}
});

test("Windows namespace conversion preserves UNC and native recovery accepts a long canonical root",{skip:process.platform!=="win32"},async()=>{
  const script=fileURLToPath(new URL("../scripts/negi_recover_writer.py",import.meta.url));
  const code="import importlib.util,sys; s=importlib.util.spec_from_file_location('w',sys.argv[1]); w=importlib.util.module_from_spec(s); s.loader.exec_module(w); print(w.windows_extended(sys.argv[2])); print(w.windows_normal(sys.argv[3]))";
  const normal="\\\\server\\share\\setup",extended="\\\\?\\UNC\\server\\share\\setup";
  const conversion=spawnSync("python",["-c",code,script,normal,extended],{encoding:"utf8",windowsHide:true});assert.equal(conversion.status,0);
  assert.deepEqual(conversion.stdout.trim().split(/\r?\n/),[extended,normal]); // actual UNC filesystem remains unexercised
  const temp=await realpath(await mkdtemp(join(tmpdir(),"negi-long-root-")));
  try{
    const root=join(temp,"a".repeat(180),"b".repeat(180));await mkdir(root,{recursive:true});
    const canonical=await realpath(root),dead=spawnSync(process.execPath,["-e",""],{windowsHide:true});assert.equal(dead.status,0);
    const operation:WriterOperation={domain:"project-configuration",requestId:randomUUID(),hash:"c".repeat(64)},writer=join(canonical,"configuration-writer.lock");
    await writeFile(writer,JSON.stringify({schema:"negi-configuration-writer/1",pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString(),operation}));
    await recoverWriter(canonical,"configuration",operation);await assert.rejects(readFile(writer));
  }finally{await rm(temp,{recursive:true,force:true})}
});
