import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, realpath, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { LocalProjectSetup } from "../src/server/orchestration/projectSetup.ts";
import { createProjectSetupHttp } from "../src/server/orchestration/projectSetupHttp.ts";
import { projectSetupPageHtml } from "../src/server/orchestration/projectSetupPage.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { setup, origin, requestOrigin, git } from "./helpers/taskAuthoringFixture.ts";

async function fixture(){const f=await setup();await f.tasks.close();await unlink(join(f.vault,"80_Tasks","template.md"));
  const service=await LocalProjectSetup.open(join(f.root,"setup"),[f.repo]);
  const settings={id:"docs-project",title:"最初のプロジェクト",project:"fixture",repository:f.repo,vault:f.vault,executable:process.execPath,
    allowedPaths:["docs"],astra:f.config.astra,sol:f.config.sol,verification:f.config.verification,maxAttempts:1,timeLimitMinutes:5};
  return{...f,service,settings};}

test("first profile without a fake Task persists exact approval, restores and executes one approved direct Sol",async()=>{
  const f=await fixture();let tasks:LocalTaskService|undefined;try{
    assert.equal(await f.service.current(),null);const originalSpec=await readFile(f.spec),base=git(f.repo,["rev-parse","HEAD"]);
    const preview=await f.service.preview(f.settings);assert.equal(preview.baseSha,base);assert.equal(preview.sources.length,1);
    assert.deepEqual(await readdir(join(f.vault,"80_Tasks")),[]);assert.deepEqual(f.calls(),{astra:0,sol:0});
    const requestId=randomUUID(),saved=await f.service.save(preview.settings,preview.hash,requestId);
    assert.deepEqual(await f.service.save(preview.settings,preview.hash,requestId),saved);
    await assert.rejects(f.service.save(preview.settings,preview.hash,randomUUID()));
    const reopened=await LocalProjectSetup.open(f.service.root,[f.repo]);assert.deepEqual(await reopened.current(),preview);
    const bundle=await reopened.startup(preview);tasks=await LocalTaskService.open(bundle.tasks,f.runtime);
    assert.deepEqual(tasks.list(),[]);const reviews=await LocalReviewService.open(bundle.reviews);await tasks.connectReviews(reviews);
    const authoring=await LocalTaskAuthoringService.open(bundle.authoring,tasks);assert.equal(authoring.listProfiles().length,1);
    const refs=await authoring.readProject(f.settings.id),fields={...f.fields,references:refs.sources.map(({id,version,sha256})=>({id,version,sha256}))};
    const draft=await authoring.propose(f.settings.id,fields,origin);assert.deepEqual(tasks.list(),[]);
    const ready=await authoring.finalize(draft.id,draft.hash,randomUUID());assert.equal(tasks.list().length,1);
    let state=await tasks.snapshot(ready.runId!);await tasks.start(state.id,state.configSha256,randomUUID(),requestOrigin);
    const deadline=Date.now()+60000;do{state=await tasks.snapshot(state.id);if(!state.live&&state.status!=="queued")break;assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,30))}while(true);
    assert.equal(state.status,"ready_for_review");assert.equal(state.acceptedBy,null);assert.deepEqual(f.calls(),{astra:0,sol:1});
    await tasks.close();tasks=await LocalTaskService.open(bundle.tasks,f.runtime);const restored=await LocalTaskAuthoringService.open(bundle.authoring,tasks);
    assert.equal((await restored.list())[0].status,"registered");assert.equal(tasks.list().length,1);assert.deepEqual(f.calls(),{astra:0,sol:1});
    assert.deepEqual(await readFile(f.spec),originalSpec);assert.equal(git(f.repo,["rev-parse","HEAD"]),base);assert.equal(git(f.repo,["status","--porcelain"]),"");
  }finally{await tasks?.close();await f.close()}
});

test("preview/save do not execute configured checks; stale specification, baseline, roots and signatures fail closed",async()=>{
  const f=await fixture();try{
    const marker=join(f.root,"command-ran.txt"),settings={...f.settings,verification:[{requirement:"side effect sentinel",program:process.execPath,args:["-e",`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],timeoutMs:1000}]};
    const p=await f.service.preview(settings);await assert.rejects(readFile(marker));
    const spec=await readFile(f.spec,"utf8");await writeFile(f.spec,spec+"updated specification\n");await assert.rejects(f.service.save(p.settings,p.hash,randomUUID()));await writeFile(f.spec,spec);
    await writeFile(join(f.repo,"docs","next.txt"),"later");git(f.repo,["add","."]);git(f.repo,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","later"]);
    await assert.rejects(f.service.save(p.settings,p.hash,randomUUID()));const fresh=await f.service.preview(settings);await f.service.save(fresh.settings,fresh.hash,randomUUID());await assert.rejects(readFile(marker));
    const path=join(f.service.root,"setup.json"),raw=JSON.parse(await readFile(path,"utf8"));raw.preview.settings.sol.model="other-model";await writeFile(path,JSON.stringify(raw));
    await assert.rejects(f.service.current());await assert.rejects(f.service.startup(fresh));assert.deepEqual(await readdir(join(f.vault,"80_Tasks")),[]);
    await assert.rejects(LocalProjectSetup.open(join(f.repo,"unsafe"),[f.repo]));
  }finally{await f.close()}
});

test("invalid setup authority, mixed legacy/direct sources and different schedulers are rejected",async()=>{
  const f=await fixture();let tasks:LocalTaskService|undefined;try{
    for(const extra of [{allowedPaths:["../outside"]},{allowedPaths:[".git/config"]},{vault:f.repo},{repository:f.service.root},{maxAttempts:4},
      {verification:[]},{verification:[{requirement:"shell",program:"node",args:[],timeoutMs:1000}]},{astra:{model:"example",effort:"unknown"}},{approvedPlan:{requestId:randomUUID()}}])
      await assert.rejects(f.service.preview({...f.settings,...extra}));
    const p=await f.service.preview(f.settings);await f.service.save(p.settings,p.hash,randomUUID());const b=await f.service.startup(p);
    tasks=await LocalTaskService.open(b.tasks,f.runtime);const wrong=structuredClone(b.authoring);wrong.profiles[0].config.schedulerPath=join(f.root,"another-scheduler.jsonl");
    await assert.rejects(LocalTaskAuthoringService.open(wrong,tasks));const mixed={...b.authoring,profiles:[{...b.authoring.profiles[0],templateRunId:"invented-template"}]};
    await assert.rejects(LocalTaskAuthoringService.open(mixed,tasks));await assert.rejects(LocalTaskService.open({stateRoot:b.tasks.stateRoot,runs:[]}));
    assert.deepEqual(tasks.list(),[]);
  }finally{await tasks?.close();await f.close()}
});

test("authenticated setup HTTP requires same origin, exact preview and bounded input; legacy catalogs cannot be replaced",async()=>{
  const f=await fixture();let legacy=false;const auth={token:"owned-setup-test"},handler=createProjectSetupHttp(f.service,auth,()=>({legacyConfigured:legacy,active:false}));
  const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,"http://127.0.0.1")).then(done=>{if(!done){res.statusCode=404;res.end()}})});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  const headers={cookie:"ebi_auth="+auth.token,Origin:base,"Content-Type":"application/json"},post=(path:string,value:unknown,h=headers)=>fetch(base+path,{method:"POST",headers:h,body:JSON.stringify(value)});
  try{
    assert.equal((await fetch(base+"/api/setup")).status,401);assert.equal((await fetch(base+"/setup",{redirect:"manual"})).headers.get("location"),"/login?returnTo=/setup");
    assert.equal((await post("/api/setup/preview",{settings:f.settings},{...headers,Origin:"https://other.invalid"})).status,403);
    assert.equal((await post("/api/setup/preview",{settings:f.settings,command:"added"})).status,409);
    assert.equal((await post("/api/setup/preview",{settings:{...f.settings,title:"x".repeat(20000)}})).status,409);
    const preview=await(await post("/api/setup/preview",{settings:f.settings})).json();assert.equal(preview.settings.id,f.settings.id);
    legacy=true;assert.equal((await post("/api/setup/save",{settings:preview.settings,expectedHash:preview.hash,requestId:randomUUID()})).status,409);assert.equal(await f.service.current(),null);
    legacy=false;const result=await(await post("/api/setup/save",{settings:preview.settings,expectedHash:preview.hash,requestId:randomUUID()})).json();assert.equal(result.activation,"restart_required");assert.equal(result.executionStarted,false);
    assert.match(await(await fetch(base+"/setup",{headers})).text(),/この設定を保存/);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await new Promise<void>(r=>server.close(()=>r()));await f.close()}
});

test("Material 3 setup script parses and retains separate confirmation, source versions and startup activation",()=>{
  const html=projectSetupPageHtml();for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(script[1]);
  for(const pattern of html.matchAll(/pattern="([^"]+)"/g))new RegExp(pattern[1],"v");
  assert.match(html,/viewport-fit=cover/);assert.match(html,/保存する条件を確認/);assert.match(html,/再起動/);
  assert.match(html,/textContent=JSON.stringify|JSON.stringify\(p.verification/);assert.ok(!html.includes("eval("));
});

test("dirty code and reused runtime roots are held; canonical verification programs survive parent aliases",async()=>{
  const f=await fixture();try{
    await writeFile(join(f.repo,"docs","unsaved.txt"),"retain my work");await assert.rejects(f.service.preview(f.settings));assert.equal(await readFile(join(f.repo,"docs","unsaved.txt"),"utf8"),"retain my work");await unlink(join(f.repo,"docs","unsaved.txt"));
    const p=await f.service.preview(f.settings);await writeFile(join(f.service.root,"scheduler.jsonl"),"existing runtime evidence\n");await assert.rejects(f.service.save(p.settings,p.hash,randomUUID()));assert.equal(await f.service.current(),null);assert.equal(await readFile(join(f.service.root,"scheduler.jsonl"),"utf8"),"existing runtime evidence\n");await unlink(join(f.service.root,"scheduler.jsonl"));
    await mkdir(join(f.service.root,"authoring"));await assert.rejects(f.service.save(p.settings,p.hash,randomUUID()));await rmdir(join(f.service.root,"authoring"));
    const alias=join(f.root,"program-alias");await symlink(dirname(process.execPath),alias,process.platform==="win32"?"junction":"dir");
    const viaAlias=await f.service.preview({...f.settings,verification:[{...f.settings.verification[0],program:join(alias,basename(process.execPath))}]});
    assert.equal(viaAlias.settings.verification[0].program,await realpath(process.execPath));await f.service.save(viaAlias.settings,viaAlias.hash,randomUUID());
    await unlink(alias);await symlink(f.root,alias,process.platform==="win32"?"junction":"dir");
    const b=await f.service.startup(viaAlias);assert.equal(b.config.verification[0].program,await realpath(process.execPath));
    await writeFile(join(f.repo,"docs","later-unsaved.txt"),"preserve after setup");await assert.rejects(f.service.startup(viaAlias));assert.equal(await readFile(join(f.repo,"docs","later-unsaved.txt"),"utf8"),"preserve after setup");
  }finally{await f.close()}
});

test("setup confirmation generates valid request identity without secure-context randomUUID",()=>{
  const html=projectSetupPageHtml(),code=html.match(/function uuid\(\)[^\n]+/)![0];
  const id=new Script(code+";uuid()").runInNewContext({crypto:{getRandomValues:(v:Uint8Array)=>webcrypto.getRandomValues(v)}});
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(html,/checking\(true\);try\{requestId=requestId\|\|uuid\(\)/);
});
