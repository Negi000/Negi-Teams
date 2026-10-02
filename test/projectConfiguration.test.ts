import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LocalProjectSetup } from "../src/server/orchestration/projectSetup.ts";
import { LocalProjectConfiguration } from "../src/server/orchestration/projectConfiguration.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { startConfirmedSetupMaster } from "../src/server/orchestration/projectSetupStartup.ts";
import type { MasterSession } from "../src/server/master/session.ts";
import { setup, origin, requestOrigin, git } from "./helpers/taskAuthoringFixture.ts";

async function fixture(verification?:Parameters<typeof setup>[0]){const f=await setup(verification);await f.tasks.close();
  const first=await LocalProjectSetup.open(join(f.root,"settings"),[f.repo]);
  const settings={id:"docs-project",title:"プロジェクトA",project:"fixture",repository:f.repo,vault:f.vault,executable:process.execPath,
    allowedPaths:["docs"],astra:f.config.astra,sol:f.config.sol,verification:f.config.verification,maxAttempts:1,timeLimitMinutes:5};
  const p=await first.preview(settings);await first.save(p.settings,p.hash,randomUUID());
  return {...f,settings,manager:await LocalProjectConfiguration.open(first)};
}
async function publish(f:Awaited<ReturnType<typeof fixture>>,change:unknown){const current=(await f.manager.current())!;
  const p=await f.manager.preview(change,current.hash);return f.manager.save(p.change,current.hash,p.configuration.hash,randomUUID());}

test("settings revisions preserve approved Task configuration; retire old drafts and never replay on restart",async()=>{
  const f=await fixture();let tasks:LocalTaskService|undefined;try{
    const first=(await f.manager.current())!,b=await f.manager.startup(first);tasks=await LocalTaskService.open(b.tasks,f.runtime);
    const authoring=await LocalTaskAuthoringService.open(b.authoring,tasks),admit=<T>(op:()=>Promise<T>)=>f.manager.admit(first.hash,op);
    tasks.bindConfigurationAdmission(admit);authoring.bindConfigurationAdmission(admit);
    const approved=await authoring.propose(f.settings.id,f.fields,origin),registered=await authoring.finalize(approved.id,approved.hash,randomUUID());
    const stale=await authoring.propose(f.settings.id,{...f.fields,title:"旧設定の未承認案"},{...origin,callId:"second"});
    const pinned=await tasks.snapshot(registered.runId!),configBytes=await readFile(join(f.manager.setup.root,"authoring","approvals",JSON.parse(await readFile(join(f.manager.setup.root,"authoring","runs",registered.runId!,"approval.json"),"utf8")).requestId+".json"));
    const saved=await publish(f,{kind:"upsert",settings:{...f.settings,title:"新しい表示名",sol:{...f.settings.sol,effort:"high"}}});
    assert.equal(saved.configuration.version,2);assert.notEqual(saved.configuration.projects[0].executionId,f.settings.id);
    await assert.rejects(authoring.finalize(stale.id,stale.hash,randomUUID()),/再起動/);
    await assert.rejects(tasks.start(pinned.id,pinned.configSha256,randomUUID(),requestOrigin),/再起動/);
    await assert.rejects(tasks.masterTurnAdmission("master").reserve({cwd:f.repo,model:f.config.astra.model,effort:f.config.astra.effort,threadId:"master",text:"new request"}),/再起動/);
    assert.equal((await tasks.snapshot(pinned.id)).status,pinned.status);assert.equal((await authoring.list()).length,2);
    await tasks.close();const next=await f.manager.startup(saved.configuration);tasks=await LocalTaskService.open(next.tasks,f.runtime);
    const restored=await LocalTaskAuthoringService.open(next.authoring,tasks);
    assert.equal(restored.listProfiles().length,1);assert.equal((await tasks.snapshot(pinned.id)).configSha256,pinned.configSha256);
    assert.equal((await restored.list()).find(d=>d.id===approved.id)!.status,"registered");
    const retired=(await restored.list()).find(d=>d.id===stale.id)!;assert.equal(retired.status,"attention");assert.equal(retired.canFinalize,false);
    await assert.rejects(restored.finalize(stale.id,stale.hash,randomUUID()),/retired/);
    await assert.rejects(restored.propose(f.settings.id,f.fields,{...origin,callId:"retired"}),/retired/);
    await tasks.close();tasks=await LocalTaskService.open(next.tasks,f.runtime);
    const missing=structuredClone(next.authoring);missing.profiles=missing.profiles.filter(p=>p.id!==f.settings.id);
    await assert.rejects(LocalTaskAuthoringService.open(missing,tasks),/missing/);
    assert.deepEqual(await readFile(join(f.manager.setup.root,"authoring","approvals",JSON.parse(await readFile(join(f.manager.setup.root,"authoring","runs",registered.runId!,"approval.json"),"utf8")).requestId+".json")),configBytes);
    assert.deepEqual(f.calls(),{astra:0,sol:0});assert.equal(git(f.repo,["status","--porcelain"]),"");
  }finally{await tasks?.close();await f.close()}
});

test("multiple projects share one scheduler, planner changes are explicit, archive and restore publish new versions",async()=>{
  const f=await fixture(),second=await setup();await second.tasks.close();let tasks:LocalTaskService|undefined;
  try{
    const s={...f.settings,id:"project-b",title:"プロジェクトB",repository:second.repo,vault:second.vault};
    const added=await publish(f,{kind:"upsert",settings:s});assert.equal(added.configuration.projects.length,2);
    const changed=await publish(f,{kind:"upsert",settings:{...s,astra:{...s.astra,effort:"high"}}});
    assert.deepEqual(changed.affected,["docs-project","project-b"]);
    assert.ok(changed.configuration.projects.every(p=>p.preview.settings.astra.effort==="high"));
    const b=await f.manager.startup(changed.configuration);tasks=await LocalTaskService.open(b.tasks,f.runtime);
    const authoring=await LocalTaskAuthoringService.open(b.authoring,tasks);assert.equal(authoring.listProfiles().length,2);
    assert.equal(new Set(b.authoring.profiles.map(p=>p.config.schedulerPath)).size,1);
    const archived=await publish(f,{kind:"archive",id:s.id});assert.equal(archived.configuration.projects.length,1);
    await assert.rejects(publish(f,{kind:"upsert",settings:{...s,id:"project-b-alias"}}),/reserved/);
    await assert.rejects(publish(f,{kind:"archive",id:f.settings.id}));
    const restored=await publish(f,{kind:"restore",version:2});assert.equal(restored.configuration.version,5);assert.equal(restored.configuration.projects.length,2);
    assert.ok(restored.configuration.projects.every(p=>p.preview.settings.astra.effort==="medium"));
    assert.ok(restored.configuration.projects.every(p=>!added.configuration.projects.some(old=>old.executionId===p.executionId)));
    assert.equal((await f.manager.history()).length,5);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await tasks?.close();await second.close();await f.close()}
});

test("partial or missing publication holds admission; only exact signed complete pending bytes can be recovered",async()=>{
  const f=await fixture();try{
    const first=(await f.manager.current())!,saved=await publish(f,{kind:"upsert",settings:{...f.settings,title:"保存途中の版"}});
    const final=join(f.manager.setup.root,"configuration-revisions","00002.json"),pending=join(f.manager.setup.root,"configuration-revisions","00002.pending.json"),bytes=await readFile(final,"utf8");
    const request=JSON.parse(bytes).requestId;
    await rename(final,pending);await assert.rejects(f.manager.current());await assert.rejects(f.manager.admit(first.hash,async()=>true));
    assert.equal((await f.manager.recovery())!.preview.configuration.hash,saved.configuration.hash);
    await assert.rejects(f.manager.recover(request,"f".repeat(64)));
    const writerPath=join(f.manager.setup.root,"configuration-writer.lock"),writer={schema:"negi-configuration-writer/1",pid:process.pid,owner:randomUUID(),createdAt:new Date().toISOString(),
      operation:{domain:"project-configuration",requestId:request,hash:saved.configuration.hash}};
    await writeFile(writerPath,JSON.stringify(writer));await assert.rejects(f.manager.recover(request,saved.configuration.hash),/still live/);
    assert.deepEqual(JSON.parse(await readFile(writerPath,"utf8")),writer);
    const child=spawn(process.execPath,["-e","process.exit(0)"],{windowsHide:true,stdio:"ignore"});await new Promise<void>((resolve,reject)=>{child.once("exit",()=>resolve());child.once("error",reject)});
    assert.throws(()=>process.kill(child.pid!,0));
    for(const held of [{...writer,pid:child.pid,operation:{...writer.operation,domain:"vault-initialization"}},
      {...writer,pid:child.pid,operation:{...writer.operation,requestId:randomUUID()}},
      {schema:writer.schema,pid:child.pid,owner:writer.owner,createdAt:writer.createdAt}]){
      const bytes=JSON.stringify(held);await writeFile(writerPath,bytes);await assert.rejects(f.manager.recover(request,saved.configuration.hash));
      assert.equal(await readFile(writerPath,"utf8"),bytes);
    }
    await writeFile(writerPath,JSON.stringify({...writer,pid:child.pid}));
    assert.equal((await f.manager.recover(request,saved.configuration.hash)).hash,saved.configuration.hash);
    assert.equal((await f.manager.recover(request,saved.configuration.hash)).hash,saved.configuration.hash);
    // Crash after removing pending, before final writer cleanup: signed final
    // still authorizes only its own exact dead operation writer.
    const finalizedWriter=JSON.stringify({...writer,pid:child.pid});await writeFile(writerPath,finalizedWriter);
    await assert.rejects(f.manager.recover(randomUUID(),saved.configuration.hash));assert.equal(await readFile(writerPath,"utf8"),finalizedWriter);
    assert.equal((await f.manager.recover(request,saved.configuration.hash)).hash,saved.configuration.hash);await assert.rejects(readFile(writerPath));
    // Crash after the final hardlink, before removing the pending name.
    await copyFile(final,pending);assert.equal((await f.manager.recovery())!.published,true);
    await f.manager.recover(request,saved.configuration.hash);
    // A lost tail cannot silently reactivate the previous settings or reuse version 2.
    await unlink(final);await assert.rejects(f.manager.current());await assert.rejects(f.manager.admit(first.hash,async()=>true));
    await assert.rejects(f.manager.preview({kind:"upsert",settings:{...f.settings,title:"別の版"}},first.hash));await writeFile(final,bytes);
    await rename(final,pending);await writeFile(pending,"{");await assert.rejects(f.manager.recovery());await assert.rejects(f.manager.recover(request,saved.configuration.hash));
    await writeFile(pending,bytes);await f.manager.recover(request,saved.configuration.hash);
    await writeFile(writerPath,"unknown owner\n");assert.equal(await f.manager.writerHeld(),true);
    await assert.rejects(f.manager.startup(saved.configuration),/writer requires reconciliation/);
    assert.equal(await readFile(writerPath,"utf8"),"unknown owner\n");await unlink(writerPath);
  }finally{await f.close()}
});

test("historical execution versions do not count against the twenty active project limit",async()=>{
  const f=await fixture();let tasks:LocalTaskService|undefined;try{
    const c=(await f.manager.current())!,old=c.projects[0].preview;
    const entries=Array.from({length:22},(_,i)=>({id:i===0?f.settings.id:'historical-'+i,preview:old,active:i===21}));
    const bundle=await f.manager.setup.runtimeProfiles(entries);tasks=await LocalTaskService.open(bundle.tasks,f.runtime);
    const service=await LocalTaskAuthoringService.open(bundle.authoring,tasks);
    assert.equal(service.integrationConfiguration().profiles.length,22);assert.deepEqual(service.listProfiles().map(p=>p.id),['historical-21']);
    await assert.rejects(LocalTaskAuthoringService.open({...bundle.authoring,profiles:bundle.authoring.profiles.map(p=>({...p,active:true}))},tasks),/Active project limit/);
  }finally{await tasks?.close();await f.close()}
});

test("settings save holds future starts while an existing Task remains visible and stoppable",async()=>{
  const f=await fixture(()=>[{requirement:"runtime available",program:process.execPath,args:["-e","setTimeout(()=>{},5000)"],timeoutMs:10000}]);
  let tasks:LocalTaskService|undefined;try{
    const c=(await f.manager.current())!,b=await f.manager.startup(c);tasks=await LocalTaskService.open(b.tasks,f.runtime);
    const authoring=await LocalTaskAuthoringService.open(b.authoring,tasks),admit=<T>(op:()=>Promise<T>)=>f.manager.admit(c.hash,op);
    tasks.bindConfigurationAdmission(admit);authoring.bindConfigurationAdmission(admit);
    const draft=await authoring.propose(f.settings.id,f.fields,origin),ready=await authoring.finalize(draft.id,draft.hash,randomUUID());
    const first=await tasks.snapshot(ready.runId!);await tasks.start(first.id,first.configSha256,randomUUID(),requestOrigin);
    const deadline=Date.now()+30000;while((await tasks.snapshot(first.id)).status==="queued"){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
    await publish(f,{kind:"upsert",settings:{...f.settings,title:"次の条件"}});
    const running=await tasks.snapshot(first.id);assert.equal(running.live,true);assert.equal(running.canStop,true);
    const stopped=await tasks.stop(first.id,first.configSha256);assert.equal(stopped.stopRequested,true);
    assert.equal((await authoring.list()).find(d=>d.id===draft.id)!.status,"registered");assert.deepEqual(f.calls(),{astra:0,sol:1});
  }finally{await tasks?.close();await f.close()}
});

test("CAS, changed references, identity retargeting, reused approvals and tampering cannot publish settings",async()=>{
  const f=await fixture();try{
    const current=(await f.manager.current())!,change={kind:"upsert" as const,settings:{...f.settings,title:"改訂"}},p=await f.manager.preview(change,current.hash),request=randomUUID();
    const spec=await readFile(f.spec,"utf8");await writeFile(f.spec,spec+"Changed\n");await assert.rejects(f.manager.save(p.change,current.hash,p.configuration.hash,request));await writeFile(f.spec,spec);
    const saved=await f.manager.save(p.change,current.hash,p.configuration.hash,request);
    assert.deepEqual(await f.manager.save(p.change,current.hash,p.configuration.hash,request),saved);
    await assert.rejects(f.manager.save({...p.change,settings:f.settings},current.hash,p.configuration.hash,request));
    await assert.rejects(f.manager.preview({kind:"upsert",settings:{...f.settings,title:"stale"}},current.hash));
    await assert.rejects(publish(f,{kind:"upsert",settings:{...f.settings,project:"retarget"}}));
    await assert.rejects(publish(f,{kind:"upsert",settings:{...f.settings,id:"duplicate"}}));
    const path=join(f.manager.setup.root,"configuration-revisions","00002.json"),bytes=await readFile(path,"utf8"),raw=JSON.parse(bytes);raw.preview.configuration.projects[0].preview.settings.title="forged";
    await writeFile(path,JSON.stringify(raw));await assert.rejects(f.manager.current());await assert.rejects(f.manager.startup(saved.configuration));await writeFile(path,bytes);
    assert.equal((await f.manager.current())!.hash,saved.configuration.hash);
  }finally{await f.close()}
});

test("settings publication cannot race confirmed Master startup or new-intent admission",async()=>{
  const f=await fixture();try{
    const current=(await f.manager.current())!,p=await f.manager.preview({kind:"upsert",settings:{...f.settings,title:"次版"}},current.hash);
    let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
    let state="stopped",launches=0;
    const session={get state(){return state},async start(){launches++;state="starting";entered();await waiting;state="idle"},async stop(){state="stopped"}} as unknown as MasterSession;
    const startup=f.manager.admit(current.hash,()=>startConfirmedSetupMaster(session));await inside;
    await assert.rejects(f.manager.save(p.change,current.hash,p.configuration.hash,randomUUID()),/EEXIST/);
    assert.equal((await f.manager.current())!.hash,current.hash);assert.equal(state,"starting");release();await startup;assert.equal(state,"idle");
    await f.manager.save(p.change,current.hash,p.configuration.hash,randomUUID());let dispatched=false;
    await assert.rejects(f.manager.admit(current.hash,()=>startConfirmedSetupMaster(session)));assert.equal(launches,1);
    await assert.rejects(f.manager.admit(current.hash,async()=>{dispatched=true}));assert.equal(dispatched,false);
  }finally{await f.close()}
});
