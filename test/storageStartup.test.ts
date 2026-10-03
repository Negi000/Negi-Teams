import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { parseStorageMode, taskStorageForStartup } from "../src/server/orchestration/storageStartup.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { indexedStartupFixture } from "./helpers/indexedStartupFixture.ts";

const windows={skip:process.platform!=="win32"};
test("only a trusted exact storage mode selects indexed saved setup; unknown and legacy configurations cannot fall back",()=>{
  assert.equal(parseStorageMode(undefined),"legacy");assert.equal(parseStorageMode("legacy"),"legacy");assert.equal(parseStorageMode("indexed"),"indexed");
  for(const raw of ["","INDEXED","indexed ","true"])assert.throws(()=>parseStorageMode(raw));
  assert.deepEqual(taskStorageForStartup("legacy",{saved:false,legacyConfigured:true}),{});
  for(const setup of [{saved:false,legacyConfigured:false},{saved:true,legacyConfigured:true}])assert.throws(()=>taskStorageForStartup("indexed",setup));
  assert.deepEqual(taskStorageForStartup("indexed",{saved:true,legacyConfigured:false}),{storage:"indexed"});
});

test("indexed startup never prepares missing storage, adopts partial registrations, or overwrites an unknown owner",windows,async()=>{
  const f=await indexedStartupFixture();try{
    const before=await readdir(f.bundle.tasks.stateRoot);
    await assert.rejects(f.console.assertIndexedExecutionAllowed(f.repo));assert.deepEqual(await readdir(f.bundle.tasks.stateRoot),before);
    const init=await f.console.preview("authority-initialize");await f.console.apply(init.decision);
    await assert.rejects(f.console.assertIndexedExecutionAllowed(f.repo));
    const stage=await f.console.preview("stage-adopt");await f.console.apply(stage.decision);
    await assert.rejects(f.console.assertIndexedExecutionAllowed(f.repo));
    const runtime=await f.console.preview("runtime-adopt");await f.console.apply(runtime.decision);
    await f.console.assertIndexedExecutionAllowed(f.repo);
    const owner=join(f.registration.root,"masters","negi-master","owner.lock"),bytes="unknown owner\n";await writeFile(owner,bytes);
    await assert.rejects(f.console.assertIndexedExecutionAllowed(f.repo));assert.equal(await readFile(owner,"utf8"),bytes);
    await assert.rejects(lstat(join(f.bundle.tasks.stateRoot,"operation-proofs")),{code:"ENOENT"});
    assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});

test("normal indexed server starts its registered planner, rejects unmanaged spawn and preserves one explicit turn across restart",windows,async()=>{
  const f=await indexedStartupFixture();let server:Awaited<ReturnType<typeof f.launch>>|undefined;
  try{
    await f.prepare();server=await f.launch({mode:"indexed"});
    const state=await server.until(v=>!v.executionHeld);assert.equal(state.storageMode,"indexed");assert.equal(state.registrationReady,true);assert.equal(state.canApply,false);
    const first=await server.messages();assert.equal(first.filter(q=>q.method==="thread/start").length,1);assert.equal(first.filter(q=>q.method==="turn/start").length,0);
    const response=await fetch(server.base+"/control/spawn",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command:process.execPath,useWorktree:true,repo:f.repo,branch:"must-not-exist"})});assert.ok(!response.ok);
    const ws=new WebSocket(server.base.replace("http","ws")+"/ws");const messages:Record<string,unknown>[]=[];ws.on("message",bytes=>messages.push(JSON.parse(String(bytes))));
    await new Promise<void>((accept,reject)=>{ws.once("open",accept);ws.once("error",reject)});
    const until=async(check:()=>boolean)=>{const deadline=Date.now()+60_000;while(!check()){assert.ok(Date.now()<deadline,JSON.stringify(messages)+" wire="+JSON.stringify(await server!.messages()));await new Promise(accept=>setTimeout(accept,50))}};
    try{
      await until(()=>messages.some(q=>q.type==="capabilities"));const capabilities=messages.find(q=>q.type==="capabilities")!;assert.equal(capabilities.managedTasksOnly,true);assert.equal(capabilities.supervisor,false);
      ws.send(JSON.stringify({type:"spawn",command:process.execPath}));await until(()=>messages.some(q=>q.type==="error"));assert.ok(!messages.some(q=>q.type==="spawned"));
      ws.send(JSON.stringify({type:"chatSend",id:"negi-master",text:"通常起動を確認してください。",requestId:randomUUID()}));
      await until(()=>messages.some(q=>q.type==="chatEvent"&&JSON.stringify(q).includes("通常起動の合成応答")));
      await until(()=>messages.filter(q=>q.type==="chatState"&&q.state==="idle").length>=2);
    }finally{ws.close();await new Promise<void>(accept=>ws.once("close",()=>accept()))}
    const sent=await server.messages();assert.equal(sent.filter(q=>q.method==="turn/start").length,1);
    const inventory=new RuntimeJournalInventory(f.registration);assert.equal((await inventory.audit()).state,"clean");
    await server.stop();server=await f.launch({mode:"indexed"});await server.until(v=>!v.executionHeld);
    const restarted=await server.messages();assert.equal(restarted.filter(q=>q.method==="thread/start").length,0);assert.equal(restarted.filter(q=>q.method==="thread/resume").length,1);assert.equal(restarted.filter(q=>q.method==="turn/start").length,0);
    assert.equal((await inventory.audit()).state,"clean");assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await server?.stop();await f.close()}
});

test("registered storage stays held under default, invalid and maintenance startups without provider replay",windows,async()=>{
  const f=await indexedStartupFixture();try{
    await f.prepare();const key=await readFile(join(f.registration.root,"signing-key.json"));
    for(const options of [{},{mode:"invalid"},{mode:"indexed",maintenance:true}]){
      const server=await f.launch(options);try{const state=await server.until(v=>v.executionHeld);assert.equal(state.canApply,Boolean(options.maintenance));assert.equal((await server.messages()).length,0)}finally{await server.stop()}
    }
    assert.deepEqual(await readFile(join(f.registration.root,"signing-key.json")),key);await assert.rejects(lstat(join(f.bundle.tasks.stateRoot,"operation-proofs")),{code:"ENOENT"});
  }finally{await f.close()}
});
