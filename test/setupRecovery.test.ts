import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LocalProjectSetup } from "../src/server/orchestration/projectSetup.ts";
import { LocalProjectConfiguration } from "../src/server/orchestration/projectConfiguration.ts";
import { createProjectSetupHttp } from "../src/server/orchestration/projectSetupHttp.ts";
import { HumanReviewProofStore } from "../src/server/orchestration/humanReviewProof.ts";
import { setup, git } from "./helpers/taskAuthoringFixture.ts";

async function fixture(){
  const f=await setup();await f.tasks.close();
  const service=await LocalProjectSetup.open(join(f.root,"settings"),[f.repo]),configuration=await LocalProjectConfiguration.open(service);
  const settings={id:"docs-project",title:"署名したプロジェクト",project:"fixture",repository:f.repo,vault:f.vault,executable:process.execPath,
    allowedPaths:["docs"],astra:f.config.astra,sol:f.config.sol,verification:f.config.verification,maxAttempts:1,timeLimitMinutes:5};
  const preview=await service.preview(settings),requestId=randomUUID();
  await configuration.saveSetup(preview.settings,preview.hash,requestId);
  const initialBytes=await readFile(join(service.root,"setup.json"));
  const dead=spawnSync(process.execPath,["-e",""],{windowsHide:true});assert.equal(dead.status,0);
  const inner=(pid=dead.pid)=>JSON.stringify({schema:"negi-setup-writer/1",pid,owner:randomUUID(),createdAt:new Date().toISOString(),requestId,hash:preview.hash});
  const outer=(domain="project-setup",id=requestId,hash=preview.hash)=>JSON.stringify({schema:"negi-configuration-writer/1",pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString(),operation:{domain,requestId:id,hash}});
  const initialPath=join(service.root,"setup-writer.lock"),sharedPath=join(service.root,"configuration-writer.lock");
  const handler=createProjectSetupHttp(service,{token:"owned-recovery-test"},()=>({legacyConfigured:false,active:false}),configuration);
  const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,"http://127.0.0.1")).then(done=>{if(!done){res.statusCode=404;res.end()}})});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const headers={cookie:"ebi_auth=owned-recovery-test",Origin:base,"Content-Type":"application/json"};
  const get=async()=>{const response=await fetch(base+"/api/setup",{headers});assert.equal(response.status,200);return response.json()};
  const post=(path:string,value:unknown)=>fetch(base+"/api/setup/"+path,{method:"POST",headers,body:JSON.stringify(value)});
  return {...f,service,configuration,settings,preview,requestId,initialBytes,inner,outer,initialPath,sharedPath,get,post,
    close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await f.close()}};
}
async function inventory(root:string):Promise<Record<string,string>>{
  const result:Record<string,string>={};async function visit(path:string,prefix=""){
    for(const f of await readdir(path,{withFileTypes:true})){const name=prefix+f.name;if(f.isDirectory())await visit(join(path,f.name),name+"/");else result[name]=(await readFile(join(path,f.name))).toString("base64")}
  }await visit(root);return result;
}

test("signed initial receipt is discoverable without writers; GET is read only and explicit completion publishes once",async()=>{
  const f=await fixture();try{
    await unlink(join(f.service.root,"setup.json"));
    const before=await inventory(f.service.root),state=await f.get(),row=state.recoveries.find((r:any)=>r.operation.domain==="project-setup");
    assert.equal(row.published,false);assert.equal(row.canComplete,true);assert.deepEqual(row.preview,f.preview);assert.equal(state.canSave,false);
    assert.deepEqual(await inventory(f.service.root),before);assert.deepEqual(f.calls(),{astra:0,sol:0});
    const vp=await f.service.vaults.preview({target:join(f.root,"blocked-vault"),repository:f.repo,project:"blocked",title:"保留中の別操作",specification:"Preserve the initial approval"},randomUUID());
    assert.equal((await f.post("vault-save",{input:vp.input,requestId:vp.requestId,expectedHash:vp.hash,updated:vp.updated})).status,409);
    assert.deepEqual(await inventory(f.service.root),before);await assert.rejects(readFile(join(vp.input.target,"10_Projects","spec.md")));
    const input={requestId:f.requestId,expectedHash:f.preview.hash};
    assert.equal((await f.post("setup-complete",{...input,extra:true})).status,409);
    assert.equal((await f.post("setup-complete",{...input,requestId:randomUUID()})).status,409);assert.deepEqual(await inventory(f.service.root),before);
    const response=await f.post("setup-complete",input);assert.equal(response.status,200);assert.equal((await response.json()).executionStarted,false);
    assert.deepEqual(await readFile(join(f.service.root,"setup.json")),f.initialBytes);assert.deepEqual((await f.get()).recoveries,[]);
    assert.equal((await f.post("setup-complete",input)).status,200);assert.deepEqual(await readFile(join(f.service.root,"setup.json")),f.initialBytes);
  }finally{await f.close()}
});

test("initial completion preflights both writers and preserves partial publication, legacy/live/mismatched ownership and stale content",async()=>{
  const f=await fixture();try{
    await unlink(join(f.service.root,"setup.json"));
    const shared=f.outer();await writeFile(f.sharedPath,shared);
    for(const bytes of ["", "{",f.inner(process.pid),JSON.stringify({...JSON.parse(f.inner()),requestId:randomUUID()})]){
      await writeFile(f.initialPath,bytes);const state=await f.get();assert.equal(state.recoveries[0].canComplete,false);
      await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.equal(await readFile(f.sharedPath,"utf8"),shared);assert.equal(await readFile(f.initialPath,"utf8"),bytes);
    }
    const inner=f.inner();await writeFile(f.initialPath,inner);await writeFile(join(f.service.root,"setup-recovery.lock"),"legacy");
    await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.equal(await readFile(f.sharedPath,"utf8"),shared);await unlink(join(f.service.root,"setup-recovery.lock"));
    await writeFile(join(f.service.root,"setup.json"),"{}");await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.equal(await readFile(f.sharedPath,"utf8"),shared);assert.equal((await f.get()).canSave,false);await unlink(join(f.service.root,"setup.json"));
    const spec=await readFile(f.spec);await writeFile(f.spec,Buffer.concat([spec,Buffer.from("changed after approval\n")]));
    await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.equal((await f.get()).recoveries[0].canComplete,false);assert.equal(await readFile(f.sharedPath,"utf8"),shared);await writeFile(f.spec,spec);
    await writeFile(join(f.service.root,"scheduler.jsonl"),"retain runtime");await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.equal(await readFile(f.sharedPath,"utf8"),shared);await unlink(join(f.service.root,"scheduler.jsonl"));
    const proofs=await HumanReviewProofStore.open(join(f.service.root,"profile-approvals")),extra=randomUUID();await proofs.create({id:extra,action:"operation",caseId:"project-setup",runId:f.settings.id,artifactSha256:f.preview.hash,verificationRef:null,data:{domain:"project-setup",preview:JSON.stringify(f.preview)}});
    await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.equal(await readFile(f.sharedPath,"utf8"),shared);await unlink(join(proofs.root,extra+".json"));
    const before=await inventory(f.service.root);await f.get();assert.deepEqual(await inventory(f.service.root),before);
    assert.equal((await f.post("setup-complete",{requestId:f.requestId,expectedHash:f.preview.hash})).status,200);
    await assert.rejects(readFile(f.sharedPath));await assert.rejects(readFile(f.initialPath));assert.deepEqual(await readFile(join(f.service.root,"setup.json")),f.initialBytes);
  }finally{await f.close()}
});

test("completed initial cleanup preserves later code/runtime/history and blocks other mutations until explicit reconciliation",async()=>{
  const f=await fixture();try{
    const current=(await f.configuration.current())!,change={kind:"upsert",settings:{...f.settings,title:"後から変更した表示名"}};
    const next=await f.configuration.preview(change,current.hash);await f.configuration.save(next.change,current.hash,next.configuration.hash,randomUUID());
    await mkdir(join(f.service.root,"task-state"));await writeFile(join(f.service.root,"task-state","retain.txt"),"existing task");await writeFile(join(f.repo,"docs","unsaved.txt"),"unsaved user code");
    await writeFile(f.initialPath,f.inner());const bytes=await readFile(f.initialPath);
    await assert.rejects(f.configuration.startup(next.configuration));await assert.rejects(f.configuration.admit(next.configuration.hash,async()=>"unexpected"));
    assert.equal((await f.post("configuration-save",{change:next.change,expectedCurrentHash:current.hash,expectedHash:next.configuration.hash,requestId:randomUUID()})).status,409);
    const vaultInput={target:join(f.root,"new-vault"),repository:f.repo,project:"new",title:"新しいVault",specification:"Preserve everything"};
    assert.equal((await f.post("vault-save",{input:vaultInput,expectedHash:"a".repeat(64),requestId:randomUUID(),updated:new Date().toISOString().slice(0,10)})).status,409);
    assert.deepEqual(await readFile(f.initialPath),bytes);assert.deepEqual(f.calls(),{astra:0,sol:0});
    const row=(await f.get()).recoveries.find((r:any)=>r.operation.domain==="project-setup");assert.equal(row.published,true);assert.equal(row.canComplete,true);
    await writeFile(f.sharedPath,f.outer());const shared=await readFile(f.sharedPath);await assert.rejects(f.configuration.completeSetup(f.requestId,f.preview.hash));assert.deepEqual(await readFile(f.sharedPath),shared);await unlink(f.sharedPath);
    const response=await f.post("setup-complete",{requestId:f.requestId,expectedHash:f.preview.hash});assert.equal(response.status,200);
    assert.deepEqual(await readFile(join(f.service.root,"setup.json")),f.initialBytes);assert.equal(await readFile(join(f.service.root,"task-state","retain.txt"),"utf8"),"existing task");
    assert.equal(await readFile(join(f.repo,"docs","unsaved.txt"),"utf8"),"unsaved user code");assert.equal((await f.configuration.current())!.hash,next.configuration.hash);
    assert.match(git(f.repo,["status","--porcelain"]),/unsaved/);assert.deepEqual((await f.get()).recoveries,[]);
    await unlink(join(f.repo,"docs","unsaved.txt"));
    const c=(await f.configuration.current())!,p=await f.configuration.preview({kind:"upsert",settings:{...f.settings,title:"別の改訂"}},c.hash);
    const proofs=await HumanReviewProofStore.open(join(f.service.root,"profile-approvals")),extra=randomUUID();
    await proofs.create({id:extra,action:"operation",caseId:"project-setup",runId:f.settings.id,artifactSha256:f.preview.hash,verificationRef:null,data:{domain:"project-setup",preview:JSON.stringify(f.preview)}});
    const before=await inventory(f.service.root);assert.equal((await f.get()).canManage,false);await assert.rejects(f.configuration.startup(c));
    assert.equal((await f.post("configuration-save",{change:p.change,expectedCurrentHash:c.hash,expectedHash:p.configuration.hash,requestId:randomUUID()})).status,409);
    assert.deepEqual(await inventory(f.service.root),before);assert.equal((await f.configuration.current())!.hash,c.hash);
  }finally{await f.close()}
});

test("signed latest configuration and completed Vault are surfaced for final-only writer cleanup; reads never recreate files",async()=>{
  const f=await fixture();try{
    const current=(await f.configuration.current())!,next=await f.configuration.preview({kind:"upsert",settings:{...f.settings,title:"設定改訂"}},current.hash),id=randomUUID();
    await f.configuration.save(next.change,current.hash,next.configuration.hash,id);await writeFile(f.sharedPath,f.outer("project-configuration",id,next.configuration.hash));
    let before=await inventory(f.service.root),state=await f.get(),row=state.recoveries.find((r:any)=>r.operation.domain==="project-configuration");
    assert.equal(row.published,true);assert.equal(row.canComplete,true);assert.deepEqual(await inventory(f.service.root),before);
    const initial=f.inner();await writeFile(f.initialPath,initial);const shared=await readFile(f.sharedPath);
    assert.equal((await f.get()).recoveries.find((r:any)=>r.operation.domain==="project-configuration").canComplete,false);
    assert.equal((await f.post("configuration-recover",{requestId:id,expectedHash:next.configuration.hash})).status,409);assert.deepEqual(await readFile(f.sharedPath),shared);await unlink(f.initialPath);
    assert.equal((await f.post("configuration-recover",{requestId:id,expectedHash:next.configuration.hash})).status,200);
    const input={target:join(f.root,"created-vault"),repository:f.repo,project:"created",title:"作成済みのVault",specification:"Human approved specification"},vaultId=randomUUID();
    const p=await f.service.vaults.preview(input,vaultId);await f.configuration.withStableHistory(()=>f.service.vaults.save(p.input,p.hash,p.requestId,p.updated),{requestId:p.requestId,hash:p.hash});
    const spec=join(input.target,"10_Projects","spec.md"),updated=(await readFile(spec,"utf8"))+"Later human change\n";await writeFile(spec,updated);
    await writeFile(f.sharedPath,f.outer("vault-initialization",p.requestId,p.hash));
    const dead=spawnSync(process.execPath,["-e",""],{windowsHide:true});await writeFile(join(f.service.vaults.root,".writer.lock"),JSON.stringify({schema:"negi-vault-writer/1",pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString(),requestId:p.requestId,hash:p.hash}));
    before=await inventory(f.service.root);state=await f.get();row=state.recoveries.find((r:any)=>r.operation.domain==="vault-initialization");assert.equal(row.published,true);assert.equal(row.canComplete,true);assert.deepEqual(await inventory(f.service.root),before);
    await writeFile(f.initialPath,initial);const vaultShared=await readFile(f.sharedPath);
    assert.equal((await f.get()).recoveries.find((r:any)=>r.operation.domain==="vault-initialization").canComplete,false);
    assert.equal((await f.post("vault-complete",{requestId:p.requestId,expectedHash:p.hash})).status,409);assert.deepEqual(await readFile(f.sharedPath),vaultShared);await unlink(f.initialPath);
    assert.equal((await f.post("vault-complete",{requestId:p.requestId,expectedHash:p.hash})).status,200);assert.equal(await readFile(spec,"utf8"),updated);assert.deepEqual((await f.get()).recoveries,[]);
  }finally{await f.close()}
});
