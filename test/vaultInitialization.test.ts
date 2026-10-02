import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalProjectSetup } from "../src/server/orchestration/projectSetup.ts";
import { LocalProjectConfiguration } from "../src/server/orchestration/projectConfiguration.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { setup,origin,requestOrigin,git } from "./helpers/taskAuthoringFixture.ts";
import { createProjectSetupHttp } from "../src/server/orchestration/projectSetupHttp.ts";
import { HumanReviewProofStore } from "../src/server/orchestration/humanReviewProof.ts";
import type { VaultInitializationPreview } from "../src/server/orchestration/vaultInitialization.ts";

const native=fileURLToPath(new URL("../scripts/negi_publish_vault.py",import.meta.url));
const identity=(path:string)=>JSON.parse(execFileSync("python",[native,"--identity",path],{encoding:"utf8",windowsHide:true}));
async function claimStage(f:Awaited<ReturnType<typeof fixture>>,p:VaultInitializationPreview,stage:string){
  await writeFile(join(f.service.vaults.root,p.requestId+".stage-intent.json"),JSON.stringify({schema:"negi-vault-stage-intent/1",
    requestId:p.requestId,hash:p.hash,parent:p.parent,seed:".negi-vault-seed-"+p.requestId+"-"+randomUUID(),
    stage:".negi-vault-stage-"+p.requestId,source:identity(stage)})+"\n");
}
async function signPreview(f:Awaited<ReturnType<typeof fixture>>,p:VaultInitializationPreview){
  const proofs=await HumanReviewProofStore.open(join(f.service.root,"vault-initialization-approvals"),160000);
  await proofs.create({id:p.requestId,action:"operation",caseId:"vault-initialization",runId:p.input.project,artifactSha256:p.hash,
    verificationRef:null,data:{domain:"vault-initialization",preview:JSON.stringify(p)}});
}

async function fixture(){
  const f=await setup();await f.tasks.close();
  const service=await LocalProjectSetup.open(join(f.root,"new-setup"),[f.repo]);
  const configuration=await LocalProjectConfiguration.open(service);
  const raw={target:join(f.root,"新しいVault"),repository:await realpath(f.repo),project:"fixture",title:"新しいプロジェクト",
    specification:"既存文書を維持し、承認された文書を1件作る。\n公開と外部送信は別の操作で確認する。"};
  return {...f,service,configuration,raw};
}

test("a new human-approved Vault enters ordinary setup, direct Sol, review and restart without a fake Task",async()=>{
  const f=await fixture();let tasks:LocalTaskService|undefined;
  try{
    const oldSpec=await readFile(f.spec),head=git(f.repo,["rev-parse","HEAD"]),id=randomUUID();
    const p=await f.service.vaults.preview(f.raw,id);
    await assert.rejects(readFile(join(f.raw.target,"10_Projects","spec.md")));
    assert.deepEqual(f.calls(),{astra:0,sol:0});assert.equal(p.files.length,2);
    const created=await f.service.vaults.save(p.input,p.hash,id,p.updated);
    assert.equal(created.state,"created");assert.deepEqual(await f.service.vaults.complete(id,p.hash),created);
    const settings={id:"new-project",title:f.raw.title,project:f.raw.project,repository:f.repo,vault:p.input.target,executable:process.execPath,
      allowedPaths:["docs"],astra:f.config.astra,sol:f.config.sol,verification:f.config.verification,maxAttempts:1,timeLimitMinutes:5};
    const preview=await f.service.preview(settings);assert.equal(preview.sources.length,2);
    const saved=await f.service.save(preview.settings,preview.hash,randomUUID()),bundle=await f.service.startup(saved);
    tasks=await LocalTaskService.open(bundle.tasks,f.runtime);await tasks.connectReviews(await LocalReviewService.open(bundle.reviews));
    const authoring=await LocalTaskAuthoringService.open(bundle.authoring,tasks),refs=await authoring.readProject(settings.id);
    const draft=await authoring.propose(settings.id,{...f.fields,references:refs.sources.map(({id,version,sha256})=>({id,version,sha256}))},origin);
    const ready=await authoring.finalize(draft.id,draft.hash,randomUUID());let view=await tasks.snapshot(ready.runId!);
    await tasks.start(view.id,view.configSha256,randomUUID(),requestOrigin);
    const end=Date.now()+60000;
    do{view=await tasks.snapshot(view.id);if(!view.live&&view.status!=="queued")break;assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,30))}while(true);
    assert.equal(view.status,"ready_for_review");assert.equal(view.acceptedBy,null);assert.deepEqual(f.calls(),{astra:0,sol:1});
    await tasks.close();tasks=await LocalTaskService.open(bundle.tasks,f.runtime);
    const reopened=await LocalProjectSetup.open(f.service.root,[f.repo]);
    assert.equal((await reopened.vaults.history())[0].state,"created");
    assert.equal((await LocalTaskAuthoringService.open(bundle.authoring,tasks).then(a=>a.list()))[0].status,"registered");
    assert.deepEqual(await readFile(f.spec),oldSpec);assert.equal(git(f.repo,["rev-parse","HEAD"]),head);assert.equal(git(f.repo,["status","--porcelain"]),"");
    assert.equal((await readdir(join(f.raw.target,"80_Tasks"))).length,1);
    // Completed initialization is historical: later authorized Task notes must remain.
    assert.equal((await reopened.vaults.complete(id,p.hash)).state,"created");
  }finally{await tasks?.close();await f.close()}
});

test("native directory publication refuses an existing empty or occupied destination",async()=>{
  const f=await fixture();
  try{
    const script=fileURLToPath(new URL("../scripts/negi_publish_vault.py",import.meta.url)),parent=await realpath(f.root);
    const identity=JSON.parse(execFileSync("python",[script,"--identity",parent],{encoding:"utf8",windowsHide:true}));
    for(const occupied of [false,true]){
      const source=join(parent,"stage-"+occupied),target=join(parent,"collision-"+occupied);await mkdir(source);await writeFile(join(source,"ready.txt"),"owned");
      await mkdir(target);if(occupied)await writeFile(join(target,"existing.txt"),"retain");
      const sourceId=JSON.parse(execFileSync("python",[script,"--identity",source],{encoding:"utf8",windowsHide:true}));
      assert.throws(()=>execFileSync("python",[script,"--source",source,"--target",target,"--device",identity.device,"--inode",identity.inode,"--source-device",sourceId.device,"--source-inode",sourceId.inode],{windowsHide:true,stdio:"pipe"}));
      assert.deepEqual(await readdir(target),occupied?["existing.txt"]:[]);assert.equal(await readFile(join(source,"ready.txt"),"utf8"),"owned");
    }
  }finally{await f.close()}
});

test("new Vault creation rejects existing sources, dirty baseline, changed previews and invalid exact text",async()=>{
  const f=await fixture();
  try{
    for(const raw of [{...f.raw,target:f.vault},{...f.raw,target:join(f.repo,"new-vault")},{...f.raw,target:join(f.service.root,"new-vault")},
      {...f.raw,target:join(f.root,"CON")},{...f.raw,target:join(f.root,"bad.")},{...f.raw,specification:"\ud800"},
      {...f.raw,specification:"\0unsafe"},{...f.raw,project:"global"},{...f.raw,specification:""}])
      await assert.rejects(f.service.vaults.preview(raw,randomUUID()));
    const id=randomUUID(),p=await f.service.vaults.preview(f.raw,id);
    await assert.rejects(f.service.vaults.save({...p.input,specification:"changed"},p.hash,id,p.updated));
    await writeFile(join(f.repo,"unsaved.txt"),"keep");
    await assert.rejects(f.service.vaults.save(p.input,p.hash,id,p.updated));assert.equal(await readFile(join(f.repo,"unsaved.txt"),"utf8"),"keep");
    await unlink(join(f.repo,"unsaved.txt"));await mkdir(f.raw.target);
    await assert.rejects(f.service.vaults.save(p.input,p.hash,id,p.updated));assert.deepEqual(await readdir(f.raw.target),[]);
    assert.deepEqual(await f.service.vaults.history(),[]);
  }finally{await f.close()}
});

test("signed incomplete staging can finish only matching inventory and survives publication before catalog",async()=>{
  const f=await fixture();
  try{
    const id=randomUUID(),p=await f.service.vaults.preview(f.raw,id);
    // Fail after signing by reserving the stage with unknown ownership.
    const stage=join(f.root,".negi-vault-stage-"+id);await mkdir(stage);
    await assert.rejects(f.service.vaults.save(p.input,p.hash,id,p.updated));
    assert.equal((await f.service.vaults.history())[0].state,"approved");
    await assert.rejects(f.service.vaults.complete(id,p.hash));assert.deepEqual(await readdir(stage),[]);
    // New protocol requires the server's exact directory claim as well as the marker.
    await writeFile(join(stage,".negi-vault-initialization.json"),p.marker);
    await assert.rejects(f.service.vaults.complete(id,p.hash),/no ownership claim/);
    await claimStage(f,p,stage);
    await mkdir(join(stage,"10_Projects"));await writeFile(join(stage,p.files[0].path),p.files[0].content);
    await assert.rejects(f.service.vaults.save(p.input,p.hash,id,p.updated));
    assert.equal((await readdir(stage)).length,2); // repeated save must not fill pending content
    await writeFile(join(stage,"unrelated.txt"),"retain");
    await assert.rejects(f.service.vaults.complete(id,p.hash));assert.equal(await readFile(join(stage,"unrelated.txt"),"utf8"),"retain");
    await unlink(join(stage,"unrelated.txt"));assert.equal((await f.service.vaults.complete(id,p.hash)).state,"created");
    await unlink(join(f.service.vaults.root,id+".json"));
    assert.equal((await f.service.vaults.history())[0].state,"approved");
    assert.equal((await f.service.vaults.complete(id,p.hash)).state,"created");
    await writeFile(join(f.raw.target,"10_Projects","spec.md"),"human later edit");
    assert.equal((await f.service.vaults.complete(id,p.hash)).state,"created");
    await assert.rejects(f.service.vaults.preview({...f.raw,target:join(f.raw.target,"nested")},randomUUID()));
  }finally{await f.close()}
});

test("concurrent creators reserve one target without reusing authority or removing stale locks",async()=>{
  const f=await fixture();
  try{
    const p=await f.service.vaults.preview(f.raw,randomUUID()),q=await f.service.vaults.preview(f.raw,randomUUID());
    const outcomes=await Promise.allSettled([f.service.vaults.save(p.input,p.hash,p.requestId,p.updated),f.service.vaults.save(q.input,q.hash,q.requestId,q.updated)]);
    assert.equal(outcomes.filter(o=>o.status==="fulfilled").length,1);
    const rows=await f.service.vaults.history();assert.equal(rows.length,1);assert.equal(rows[0].state,"created");
    await assert.rejects(f.service.vaults.complete(randomUUID(),p.hash));
    const lock=join(f.service.vaults.root,".writer.lock");await writeFile(lock,"unknown owner");
    await assert.rejects(f.service.vaults.complete(rows[0].preview.requestId,rows[0].preview.hash));
    assert.equal(await readFile(lock,"utf8"),"unknown owner");
  }finally{await f.close()}
});

test("exact copied destination and changed publication inode cannot be adopted",async()=>{
  const f=await fixture();
  try{
    const p=await f.service.vaults.preview(f.raw,randomUUID()),stage=join(f.root,".negi-vault-stage-"+p.requestId);
    await mkdir(stage);await assert.rejects(f.service.vaults.save(p.input,p.hash,p.requestId,p.updated));
    await mkdir(p.input.target);for(const dir of p.directories)await mkdir(join(p.input.target,dir));
    for(const note of p.files)await writeFile(join(p.input.target,note.path),note.content);
    await writeFile(join(p.input.target,".negi-vault-initialization.json"),p.marker);await writeFile(join(p.input.target,".negi-vault-ready.json"),p.ready);
    await assert.rejects(f.service.vaults.complete(p.requestId,p.hash));
    await assert.rejects(readFile(join(f.service.vaults.root,p.requestId+".json")));
    assert.equal(await readFile(join(p.input.target,p.files[1].path),"utf8"),p.files[1].content);
    const q=await f.service.vaults.preview({...f.raw,target:join(f.root,"published-vault")},randomUUID());
    await f.service.vaults.save(q.input,q.hash,q.requestId,q.updated);
    await unlink(join(f.service.vaults.root,q.requestId+".json"));
    const stageClaimPath=join(f.service.vaults.root,q.requestId+".stage-intent.json"),stageClaim=await readFile(stageClaimPath,"utf8");
    await unlink(stageClaimPath);await assert.rejects(f.service.vaults.complete(q.requestId,q.hash));
    await writeFile(stageClaimPath,"{");await assert.rejects(f.service.vaults.complete(q.requestId,q.hash));
    const changedClaim=JSON.parse(stageClaim);changedClaim.source.inode="0";await writeFile(stageClaimPath,JSON.stringify(changedClaim));
    await assert.rejects(f.service.vaults.complete(q.requestId,q.hash));
    await writeFile(stageClaimPath,stageClaim);
    const ghostSeed=join(f.root,JSON.parse(stageClaim).seed);await mkdir(ghostSeed);
    await assert.rejects(f.service.vaults.complete(q.requestId,q.hash));await rename(ghostSeed,join(f.root,"ghost-seed-retained"));
    const original=join(f.root,"moved-original");await rename(q.input.target,original);await cp(original,q.input.target,{recursive:true});
    await assert.rejects(f.service.vaults.complete(q.requestId,q.hash));assert.equal(await readFile(join(q.input.target,q.files[1].path),"utf8"),q.files[1].content);
  }finally{await f.close()}
});

test("explicit signed completion recovers both known dead writers but preserves live and partial ownership",async()=>{
  const f=await fixture();
  try{
    const p=await f.service.vaults.preview(f.raw,randomUUID()),stage=join(f.root,".negi-vault-stage-"+p.requestId);await mkdir(stage);
    await assert.rejects(f.service.vaults.save(p.input,p.hash,p.requestId,p.updated));await writeFile(join(stage,".negi-vault-initialization.json"),p.marker);
    await claimStage(f,p,stage);
    const dead=spawnSync(process.execPath,["-e",""],{windowsHide:true});assert.equal(dead.status,0);assert.ok(dead.pid);
    const outer=join(f.service.root,"configuration-writer.lock"),inner=join(f.service.vaults.root,".writer.lock");
    const value=(schema:string,pid:number)=>JSON.stringify({schema,pid,owner:randomUUID(),createdAt:new Date().toISOString(),
      ...(schema==="negi-vault-writer/1"?{requestId:p.requestId,hash:p.hash}:{operation:{domain:"vault-initialization",requestId:p.requestId,hash:p.hash}})})+"\n";
    const live=value("negi-vault-writer/1",process.pid);await writeFile(inner,live);
    await assert.rejects(f.service.vaults.complete(p.requestId,p.hash));assert.equal(await readFile(inner,"utf8"),live);
    await writeFile(inner,"partial");await assert.rejects(f.service.vaults.complete(p.requestId,p.hash));assert.equal(await readFile(inner,"utf8"),"partial");
    await writeFile(inner,value("negi-vault-writer/1",dead.pid));await writeFile(outer,value("negi-configuration-writer/1",dead.pid));
    await assert.rejects(f.configuration.withStableHistory(()=>f.service.vaults.complete(p.requestId,p.hash)));
    const completion=()=>f.configuration.withStableHistory(rows=>f.service.vaults.complete(p.requestId,p.hash,rows.flatMap(c=>c.projects.flatMap(r=>[r.preview.settings.repository,r.preview.settings.vault]))),{requestId:p.requestId,hash:p.hash,complete:true});
    const generic=JSON.stringify({schema:"negi-configuration-writer/1",pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString()});
    await writeFile(outer,generic);await assert.rejects(completion());assert.equal(await readFile(outer,"utf8"),generic);
    const other=JSON.parse(value("negi-configuration-writer/1",dead.pid));other.operation.requestId=randomUUID();await writeFile(outer,JSON.stringify(other));
    await assert.rejects(completion());assert.deepEqual(JSON.parse(await readFile(outer,"utf8")),other);
    await writeFile(outer,value("negi-configuration-writer/1",dead.pid));
    const guard=join(f.service.vaults.root,".recovery.lock");await writeFile(guard,"unknown recovery owner");
    await assert.rejects(completion());assert.equal(await readFile(guard,"utf8"),"unknown recovery owner");await unlink(guard);
    const complete=await completion();
    assert.equal(complete.state,"created");await assert.rejects(readFile(inner));await assert.rejects(readFile(outer));
    await unlink(join(f.service.vaults.root,p.requestId+".json"));await unlink(join(p.input.target,p.files[1].path));
    await assert.rejects(f.service.vaults.complete(p.requestId,p.hash)); // ready marker never permits filling missing final bytes
  }finally{await f.close()}
});

test("Vault HTTP authenticates exact explicit operations and exposes read-only pending state with a residual shared writer",async()=>{
  const f=await fixture(),auth={token:"owned-vault-test"};let legacy=false;
  const handler=createProjectSetupHttp(f.service,auth,()=>({legacyConfigured:legacy,active:false}),f.configuration);
  const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,"http://127.0.0.1")).then(done=>{if(!done){res.statusCode=404;res.end()}})});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
  const headers={cookie:"ebi_auth="+auth.token,Origin:base,"Content-Type":"application/json"},post=(path:string,body:unknown,h=headers)=>fetch(base+"/api/setup/"+path,{method:"POST",headers:h,body:JSON.stringify(body)});
  try{
    const id=randomUUID(),body={input:f.raw,requestId:id};
    assert.equal((await post("vault-preview",body,{Origin:base,"Content-Type":"application/json",cookie:""})).status,401);
    assert.equal((await post("vault-preview",body,{...headers,Origin:"https://other.invalid"})).status,403);
    assert.equal((await post("vault-preview",{...body,extra:true})).status,409);
    const response=await post("vault-preview",body);assert.equal(response.status,200);const p=await response.json();
    const stage=join(f.root,".negi-vault-stage-"+id);await mkdir(stage);
    assert.equal((await post("vault-save",{input:p.input,requestId:id,expectedHash:p.hash,updated:p.updated})).status,409);
    await writeFile(join(stage,".negi-vault-initialization.json"),p.marker);
    await claimStage(f,p,stage);
    const dead=spawnSync(process.execPath,["-e",""],{windowsHide:true}),outer=join(f.service.root,"configuration-writer.lock");
    const lock=JSON.stringify({schema:"negi-configuration-writer/1",pid:dead.pid,owner:randomUUID(),createdAt:new Date().toISOString(),operation:{domain:"vault-initialization",requestId:id,hash:p.hash}})+"\n";await writeFile(outer,lock);
    const state=await(await fetch(base+"/api/setup",{headers})).json();assert.equal(state.vaultInitializations.length,1);assert.equal(state.canSave,false);
    assert.equal(await readFile(outer,"utf8"),lock);assert.deepEqual(await readdir(stage),[".negi-vault-initialization.json"]);
    assert.equal((await post("vault-complete",{requestId:id,expectedHash:p.hash,extra:true})).status,409);assert.equal(await readFile(outer,"utf8"),lock);
    assert.equal((await post("vault-complete",{requestId:id,expectedHash:p.hash})).status,200);
    const catalogPath=join(f.service.vaults.root,id+".json"),catalog=await readFile(catalogPath);await writeFile(catalogPath,"torn catalog");
    const corrupted=await(await fetch(base+"/api/setup",{headers})).json();assert.equal(corrupted.canSave,true);assert.equal(corrupted.canCreateVault,false);assert.match(corrupted.vaultInitializationError,/保存記録/);
    await writeFile(catalogPath,catalog);
    legacy=true;assert.equal((await post("vault-preview",{input:{...f.raw,target:join(f.root,"other")},requestId:randomUUID()})).status,409);
    assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await new Promise<void>(r=>server.close(()=>r()));await f.close()}
});

test("a process stopped after seed mkdir leaves an unclaimed directory and explicit completion uses a fresh seed",async()=>{
  const f=await fixture();let child:ReturnType<typeof spawn>|undefined;
  try{
    const p=await f.service.vaults.preview(f.raw,randomUUID());assert.equal(p.stageProtocol,"owned-seed/1");await signPreview(f,p);
    const seed=join(f.root,".negi-vault-seed-"+p.requestId+"-"+randomUUID());
    // Real process cut at the pre-claim filesystem state; no production fault switch.
    child=spawn(process.execPath,["-e","require('fs').mkdirSync(process.argv[1]);console.log('mkdir');setInterval(()=>{},1000)",seed],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    await new Promise<void>((resolve,reject)=>{child!.stdout!.once("data",()=>resolve());child!.once("error",reject);child!.once("exit",()=>reject(Error("fixture exited before cut")))});
    const ended=new Promise<void>(resolve=>child!.once("exit",()=>resolve()));child.kill("SIGKILL");await ended;
    assert.deepEqual(await readdir(seed),[]);
    const reopened=await LocalProjectSetup.open(f.service.root,[f.repo]);
    assert.equal((await reopened.vaults.complete(p.requestId,p.hash)).state,"created");
    assert.deepEqual(await readdir(seed),[]); // preserved; never adopted or cleaned up
    const claim=JSON.parse(await readFile(join(reopened.vaults.root,p.requestId+".stage-intent.json"),"utf8"));
    assert.notEqual(join(f.root,claim.seed),seed);assert.deepEqual(identity(p.input.target),claim.source);
    assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await f.close()}
});

test("stage claims bind one owned source; copied, ambiguous, absent and malformed sources are preserved",async()=>{
  const f=await fixture();
  try{
    const p=await f.service.vaults.preview(f.raw,randomUUID());await signPreview(f,p);
    const seedName=".negi-vault-seed-"+p.requestId+"-"+randomUUID(),seed=join(f.root,seedName),stage=join(f.root,".negi-vault-stage-"+p.requestId);
    await mkdir(seed);await writeFile(join(seed,".negi-vault-initialization.json"),p.marker);
    const path=join(f.service.vaults.root,p.requestId+".stage-intent.json"),claim={schema:"negi-vault-stage-intent/1",requestId:p.requestId,hash:p.hash,
      parent:p.parent,seed:seedName,stage:".negi-vault-stage-"+p.requestId,source:identity(seed)};
    for(const wrong of [{...claim,hash:"f".repeat(64)},{...claim,parent:{...claim.parent,inode:"0"}},
      {...claim,seed:"../outside"},{...claim,stage:"other"},{...claim,extra:true}]){
      await writeFile(path,JSON.stringify(wrong));await assert.rejects(f.service.vaults.complete(p.requestId,p.hash));
      assert.deepEqual(await readdir(seed),[".negi-vault-initialization.json"]);
    }
    await writeFile(path,JSON.stringify(claim));await mkdir(stage);await assert.rejects(f.service.vaults.complete(p.requestId,p.hash),/one source/);
    await rename(stage,join(f.root,"held-stage"));
    await rename(seed,join(f.root,"original-seed"));await assert.rejects(f.service.vaults.complete(p.requestId,p.hash),/one source/);
    await cp(join(f.root,"original-seed"),seed,{recursive:true});await assert.rejects(f.service.vaults.complete(p.requestId,p.hash),/identity changed/);
    await rename(seed,join(f.root,"copied-seed"));await rename(join(f.root,"original-seed"),seed);
    await writeFile(join(seed,"unexpected.txt"),"preserve");await assert.rejects(f.service.vaults.complete(p.requestId,p.hash));
    assert.equal(await readFile(join(seed,"unexpected.txt"),"utf8"),"preserve");await unlink(join(seed,"unexpected.txt"));
    assert.equal((await f.service.vaults.complete(p.requestId,p.hash)).state,"created");
    assert.deepEqual(identity(p.input.target),claim.source);
    assert.deepEqual(await readdir(join(f.root,"copied-seed")),[".negi-vault-initialization.json"]);
  }finally{await f.close()}
});

test("original signed preview bytes keep their hashes and legacy staging contract",async()=>{
  const f=await fixture();
  try{
    const current=await f.service.vaults.preview(f.raw,randomUUID());
    const {stageProtocol,hash:unusedHash,payloadHash:unusedPayload,marker:unusedMarker,ready:unusedReady,...payload}=current;
    const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex"),payloadHash=digest(payload);
    const core={...payload,payloadHash,marker:JSON.stringify({schema:"negi-vault-initialization-marker/1",requestId:current.requestId,payloadHash})+"\n",
      ready:JSON.stringify({schema:"negi-vault-ready/1",requestId:current.requestId,payloadHash,
        inventoryHash:digest({directories:current.directories,files:current.files.map(({path,sha256})=>({path,sha256}))})})+"\n"};
    const legacy={...core,hash:digest(core)};await signPreview(f,legacy);
    const stage=join(f.root,".negi-vault-stage-"+legacy.requestId);await mkdir(stage);await writeFile(join(stage,".negi-vault-initialization.json"),legacy.marker);
    const reopened=await LocalProjectSetup.open(f.service.root,[f.repo]);
    assert.deepEqual((await reopened.vaults.history())[0].preview,legacy);
    assert.equal((await reopened.vaults.complete(legacy.requestId,legacy.hash)).state,"created");
    await assert.rejects(readFile(join(reopened.vaults.root,legacy.requestId+".stage-intent.json")));
  }finally{await f.close()}
});
