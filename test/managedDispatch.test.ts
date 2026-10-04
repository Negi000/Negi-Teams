import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { WebSocket } from "ws";
import { indexedStartupFixture } from "./helpers/indexedStartupFixture.ts";

const windows={skip:process.platform!=="win32"};
const paths=["spawn","inject","reverse-inject","send","summarize","setMode","chat-permission"];
const messages=[{type:"spawn",useWorktree:true,branch:"must-not-exist"},
  {type:"input",id:"master",data:"start\r"},{type:"setMode",id:"master",mode:"connected"},
  {type:"summarize",id:"master"}];
function probe(marker:string,stopMaster=false){
  const url=(path:string)=>JSON.stringify(pathToFileURL(resolve(path)).href);
  return `import {appendFileSync} from 'node:fs';
import {Registry} from ${url("src/server/registry.ts")};
import {FixedEbiManager} from ${url("src/server/fixedEbi.ts")};
import {Supervisor} from ${url("src/server/supervisor.ts")};
const record=kind=>{appendFileSync(${JSON.stringify(marker)},kind+'\\n');throw Error('owned sentinel blocked actual process')};
Registry.prototype.spawn=function(){record('spawn')};
FixedEbiManager.prototype.start=function(){record('fixed')};
Supervisor.prototype.summarize=async function(){record('summary')};
${stopMaster?`import {MasterSession} from ${url("src/server/master/session.ts")};MasterSession.prototype.start=async function(){record('master')};`:""}`;
}
async function socket(base:string){
  const ws=new WebSocket(base.replace("http","ws")+"/ws"),events:Record<string,unknown>[]=[];
  ws.on("message",bytes=>events.push(JSON.parse(String(bytes))));
  await new Promise<void>((accept,reject)=>{ws.once("open",accept);ws.once("error",reject)});
  const until=async(check:()=>boolean)=>{const deadline=Date.now()+60_000;
    while(!check()){assert.ok(Date.now()<deadline,JSON.stringify(events));await new Promise(accept=>setTimeout(accept,25))}};
  await until(()=>events.some(q=>q.type==="capabilities"));
  return {ws,events,until,close:async()=>{ws.close();await new Promise<void>(accept=>ws.once("close",()=>accept()))}};
}
async function blocked(base:string){
  // Invalid JSON proves refusal happens before request decoding or dispatch.
  for(const path of paths){const r=await fetch(base+"/control/"+path,{method:"POST",headers:{"content-type":"application/json"},body:"{"});
    assert.equal(r.status,409,path);assert.match((await r.json()).error,/契約/);assert.equal(r.headers.get("cache-control"),"no-store")}
  const s=await socket(base);try{
    const capabilities=s.events.find(q=>q.type==="capabilities")!;assert.equal(capabilities.managedTasksOnly,true);assert.equal(capabilities.supervisor,false);
    for(const message of messages){const before=s.events.filter(q=>q.type==="error").length;s.ws.send(JSON.stringify(message));
      await s.until(()=>s.events.filter(q=>q.type==="error").length>before);assert.match(String(s.events.filter(q=>q.type==="error").at(-1)!.text),/契約/)}
    assert.equal(s.events.some(q=>q.type==="spawned"||q.type==="summary"),false);
  }finally{await s.close()}
}
async function explicit(f:Awaited<ReturnType<typeof indexedStartupFixture>>){
  const path=join(f.root,"explicit-tasks.json");await writeFile(path,JSON.stringify(f.catalog));
  return {NEGI_SETUP_ROOT:"",NEGI_TASK_CONFIG:path,EBI_SUMMARY_CMD:"echo"};
}

test("legacy storage with Tasks refuses every old dispatch before any side effect and keeps Task reads",windows,async()=>{
  const f=await indexedStartupFixture();let server;try{
    const marker=join(f.root,"probe.jsonl"),env=await explicit(f);server=await f.launch({mode:"legacy",env,preload:probe(marker)});
    await server.until(v=>!v.executionHeld);const before=await readFile(f.config.schedulerPath);
    await blocked(server.base);assert.equal((await fetch(server.base+"/api/tasks",{headers:server.headers})).status,200);
    assert.equal((await fetch(server.base+"/control/agents")).status,200);
    assert.deepEqual(await readFile(f.config.schedulerPath),before);
    await assert.rejects(readFile(marker),{code:"ENOENT"});assert.deepEqual(await server.messages(),[]);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await server?.stop();await f.close()}
});

test("a setup host stays managed before saving settings; a held Task catalog cannot fall back to legacy",windows,async()=>{
  const f=await indexedStartupFixture();try{
    const marker=join(f.root,"probe.jsonl"),empty=join(f.root,"empty-setup");await mkdir(empty);
    const pending=await f.launch({env:{NEGI_SETUP_ROOT:empty,EBI_SUMMARY_CMD:"echo"},preload:probe(marker)});
    try{await pending.until(v=>!v.executionHeld);await blocked(pending.base);assert.deepEqual(await pending.messages(),[])}finally{await pending.stop()}
    const held=await f.launch({env:{NEGI_SETUP_ROOT:"",NEGI_TASK_CONFIG:join(f.root,"missing.json"),EBI_SUMMARY_CMD:"echo"},preload:probe(marker)});
    try{await held.until(v=>v.executionHeld);const s=await socket(held.base);try{
      assert.equal(s.events.find(q=>q.type==="capabilities")!.managedTasksOnly,true);
      s.ws.send(JSON.stringify({type:"spawn"}));await s.until(()=>s.events.some(q=>q.type==="error"));assert.match(String(s.events.find(q=>q.type==="error")!.text),/契約/);
      assert.equal((await fetch(held.base+"/control/spawn",{method:"POST"})).status,503);assert.deepEqual(await held.messages(),[]);
    }finally{await s.close()}}finally{await held.stop()}
    await assert.rejects(readFile(marker),{code:"ENOENT"});
  }finally{await f.close()}
});

test("incompatible single and mixed fixed configurations are rejected before any process starts",windows,async()=>{
  const f=await indexedStartupFixture();let server;try{
    const marker=join(f.root,"probe.jsonl"),env={...await explicit(f),EBI_CODEX_READ_ONLY_MASTER:"1",
      EBI_CODEX_APP_SERVER_EXE:process.execPath,EBI_CODEX_MASTER_EFFORT:"medium",EBI_MASTER_UI:""};
    const planner={id:"safe-master",kind:"master",ui:"chat",brain:"codex",cwd:f.repo,model:f.config.astra.model},worker={id:"legacy-worker",kind:"dynamic",cwd:f.repo};
    for(const fixedEbi of [[worker],[{...planner,brain:"claude"}],[{...planner,ui:"terminal"}],[planner,worker]]){
      await writeFile(f.serverConfig,JSON.stringify({fixedEbi}));
      server=await f.launch({env,preload:probe(marker,true)});await server.until(v=>!v.executionHeld);
      const s=await socket(server.base);try{await s.until(()=>s.events.some(q=>q.type==="notice"&&q.id==="fixed-startup"))}finally{await s.close()}
      await assert.rejects(readFile(marker),{code:"ENOENT"});assert.deepEqual(await server.messages(),[]);
      await server.stop();server=undefined;
    }
  }finally{await server?.stop();await f.close()}
});

test("a legacy-storage Task planner still sends one explicit turn through shared scheduler admission",windows,async()=>{
  const f=await indexedStartupFixture();let server;try{
    const marker=join(f.root,"probe.jsonl");server=await f.launch({env:{EBI_SUMMARY_CMD:"echo"},preload:probe(marker)});
    await server.until(v=>!v.executionHeld);const s=await socket(server.base);try{
      await s.until(()=>s.events.some(q=>q.type==="chatState"&&q.state==="idle"));
      s.ws.send(JSON.stringify({type:"chatSend",id:"negi-master",text:"共有実行枠を確認してください。",requestId:randomUUID()}));
      await s.until(()=>s.events.some(q=>q.type==="chatEvent"&&JSON.stringify(q).includes("通常起動の合成応答")||q.type==="chatSendResult"&&q.accepted===false));
      assert.equal(s.events.some(q=>q.type==="chatSendResult"&&q.accepted===false),false,JSON.stringify(s.events));
      await s.until(()=>s.events.filter(q=>q.type==="chatState"&&q.state==="idle").length>=2);
    }finally{await s.close()}
    const wire=await server.messages();assert.equal(wire.filter(q=>q.method==="turn/start").length,1);
    const scheduler=await readFile(f.registration.schedulerPath,"utf8");
    assert.match(scheduler,/masterOwner/);assert.match(scheduler,/"type":"claim"/);assert.match(scheduler,/"type":"settle"/);
    await assert.rejects(readFile(marker),{code:"ENOENT"});assert.deepEqual(f.calls(),{astra:0,sol:0});await blocked(server.base);
  }finally{await server?.stop();await f.close()}
});

test("multiple otherwise-valid Task planners are refused before either process starts",windows,async()=>{
  const f=await indexedStartupFixture();let server;try{
    const marker=join(f.root,"probe.jsonl"),env={...await explicit(f),EBI_CODEX_READ_ONLY_MASTER:"1",
      EBI_CODEX_APP_SERVER_EXE:process.execPath,EBI_CODEX_MASTER_EFFORT:"medium",EBI_MASTER_UI:""};
    await writeFile(f.serverConfig,JSON.stringify({fixedEbi:["one","two"].map(id=>({id,kind:"master",ui:"chat",brain:"codex",cwd:f.repo,model:f.config.astra.model}))}));
    server=await f.launch({env,preload:probe(marker,true)});await server.until(v=>!v.executionHeld);
    const s=await socket(server.base);try{await s.until(()=>s.events.some(q=>q.type==="notice"&&q.id==="fixed-startup"))}finally{await s.close()}
    await assert.rejects(readFile(marker),{code:"ENOENT"});assert.deepEqual(await server.messages(),[]);
  }finally{await server?.stop();await f.close()}
});

test("plain compatibility host retains old dynamic and fixed paths without a Task catalog or setup host",windows,async()=>{
  const f=await indexedStartupFixture();let server;try{
    const marker=join(f.root,"probe.jsonl"),env={NEGI_SETUP_ROOT:"",NEGI_TASK_CONFIG:"",EBI_SUMMARY_CMD:"echo"};
    server=await f.launch({env,preload:probe(marker)});await server.until(v=>!v.executionHeld);const s=await socket(server.base);try{
      const c=s.events.find(q=>q.type==="capabilities")!;assert.equal(c.managedTasksOnly,false);assert.equal(c.tasks,false);assert.equal(c.supervisor,true);
      s.ws.send(JSON.stringify({type:"spawn"}));await s.until(()=>s.events.some(q=>q.type==="error"));
      assert.match(await readFile(marker,"utf8"),/spawn/);
    }finally{await s.close()}
    await server.stop();server=undefined;
    await writeFile(f.serverConfig,JSON.stringify({fixedEbi:[{id:"legacy-fixed",kind:"dynamic",cwd:f.repo}]}));
    server=await f.launch({env,preload:probe(marker)});await server.until(v=>!v.executionHeld);
    const deadline=Date.now()+60_000;while(!(await readFile(marker,"utf8")).includes("fixed")){assert.ok(Date.now()<deadline);await new Promise(accept=>setTimeout(accept,25))}
    assert.deepEqual(await server.messages(),[]);
  }finally{await server?.stop();await f.close()}
});
