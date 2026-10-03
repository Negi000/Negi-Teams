import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setup,git } from "./helpers/taskAuthoringFixture.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService,ReviewDecisionBusyError } from "../src/server/orchestration/reviewService.ts";
import { LocalIntegrationReviewService } from "../src/server/orchestration/integrationReviewService.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { masterStorageTicket } from "../src/server/orchestration/masterStorageGuard.ts";

function gate(){let resolve!:()=>void;const promise=new Promise<void>(accept=>resolve=accept);return{promise,resolve};}
const windows={skip:process.platform!=="win32"};
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>,tasks:LocalTaskService,reviews:LocalReviewService,inventory:RuntimeJournalInventory,
  registration:{root:string;turnRoot:string;schedulerPath:string})=>Promise<void>){
  const f=await setup();let tasks:LocalTaskService|undefined;
  try{
    await f.tasks.close();
    const registration={root:join(f.catalog.stateRoot,"master-conversations"),turnRoot:join(f.catalog.stateRoot,"master-turns"),schedulerPath:f.config.schedulerPath};
    await mkdir(registration.turnRoot);
    await f.tasks.masterConversationAuthority("native-master").assertIdle(f.repo);
    const stage=new MasterConversationInventory({root:registration.root,masterId:"native-master",recoveryContext:registration});
    await stage.initialize();
    const inventory=new RuntimeJournalInventory(registration),preview=await inventory.previewBaseline();
    await inventory.adoptBaseline({decisionId:randomUUID(),expectedProofSha256:preview.proofSha256});
    tasks=await LocalTaskService.open(f.catalog,f.runtime,{storage:"indexed"});
    const reviews=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[f.repo],cases:[]});
    await tasks.connectReviews(reviews);
    await run(f,tasks,reviews,inventory,registration);
    assert.deepEqual(f.calls(),{astra:0,sol:0});
    assert.equal((await inventory.audit()).state,"clean");
  }finally{await tasks?.close();await f.close();}
}

test("indexed background publication takes native storage before source; a concurrent Master waits and then succeeds",windows,async()=>fixture(async(f,tasks,reviews,inventory,registration)=>{
  const entered=gate(),release=gate();let foregroundEntered=false;
  const observer=tasks as unknown as {resultSource:(id:string)=>Promise<unknown>;publishResult:(id:string)=>Promise<void>};
  const original=observer.resultSource.bind(tasks);let first=true;
  observer.resultSource=async id=>{if(first){first=false;assert.ok(masterStorageTicket(registration.root));entered.resolve();await release.promise;}return original(id);};
  const background=tasks.resultNotifications();await entered.promise;
  const foreground=tasks.masterTurnAdmission("native-master",{resident:true}).withStorage!(async()=>{
    foregroundEntered=true;await observer.publishResult(f.config.runId);
    return tasks.prepareResultContext("native-master","same-thread","explicit new input");
  });
  const completed=Promise.all([background,foreground]);
  try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(foregroundEntered,false);}
  finally{release.resolve();}
  assert.deepEqual(await completed,[[],null]);assert.equal(foregroundEntered,true);
  assert.equal(masterStorageTicket(registration.root),undefined);
  await reviews.withResultSource(()=>reviews.withResultSource(async()=>assert.ok(masterStorageTicket(registration.root))));
}));

test("indexed foreground preparation leaves background publication outside the source gate until native storage releases",windows,async()=>fixture(async(f,tasks,reviews,inventory,registration)=>{
  const entered=gate(),release=gate();let backgroundEntered=false;
  const observer=tasks as unknown as {resultSource:(id:string)=>Promise<unknown>;publishResult:(id:string)=>Promise<void>};
  const original=observer.resultSource.bind(tasks);
  observer.resultSource=async id=>{assert.ok(masterStorageTicket(registration.root));backgroundEntered=true;return original(id);};
  const foreground=tasks.masterTurnAdmission("native-master",{resident:true}).withStorage!(async()=>{
    assert.ok(masterStorageTicket(registration.root));entered.resolve();await release.promise;
    // Nested source/current-check calls retain both owning scopes.
    return reviews.withResultSource(()=>reviews.withResultSource(async()=>{
      await tasks.registeredScheduler(f.config.schedulerPath).read();return "foreground completed";
    }));
  });
  await entered.promise;const background=observer.publishResult(f.config.runId),completed=Promise.all([foreground,background]);
  try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(backgroundEntered,false);}
  finally{release.resolve();}
  assert.equal((await completed)[0],"foreground completed");assert.equal(backgroundEntered,true);
}));

test("native source binding rejects a different registration and an orphan source owner still fails closed and releases storage",windows,async()=>fixture(async(f,tasks,reviews,inventory,registration)=>{
  // Same registration must preserve the first guard, even after use.
  await reviews.withResultSource(async()=>{});
  reviews.bindResultSourceStorage(registration,async()=>{throw Error("Replacement must not run");});
  await reviews.withResultSource(async()=>assert.ok(masterStorageTicket(registration.root)));
  for(const field of ["root","turnRoot","schedulerPath"] as const)
    assert.throws(()=>reviews.bindResultSourceStorage({...registration,[field]:registration[field]+"-other"},operation=>operation()),/cannot change/);
  for(const field of ["root","turnRoot","schedulerPath"] as const)
    assert.throws(()=>reviews.assertResultSourceStorage({...registration,[field]:registration[field].toUpperCase()}),/must share/);
  const path=join(f.root,"reviews","result-source.lock"),owner=JSON.stringify({schema:"negi-result-source-owner/1",id:randomUUID(),pid:0,acquiredAt:new Date().toISOString()})+"\n";
  await writeFile(path,owner,{flag:"wx"});
  try{
    await assert.rejects(reviews.withResultSource(async()=>{throw Error("Orphan owner must exclude the action");}),ReviewDecisionBusyError);
    assert.equal(await readFile(path,"utf8"),owner);
    await inventory.withStorage(async()=>assert.ok(masterStorageTicket(registration.root)));
  }finally{await rm(path);}
}));

test("legacy review keeps its source guard and refuses late native binding; native guard errors retain their identity",async()=>{
  const f=await setup();
  try{
    const registration={root:join(f.root,"native"),turnRoot:join(f.root,"turns"),schedulerPath:f.config.schedulerPath};
    const legacy=await LocalReviewService.open({storageRoot:join(f.root,"legacy-review"),writableRoots:[f.repo],cases:[]});
    assert.equal(await legacy.withResultSource(async()=>"legacy source"),"legacy source");
    legacy.assertResultSourceStorage(null);
    assert.throws(()=>legacy.assertResultSourceStorage(undefined as never),/requires explicit/);
    assert.throws(()=>legacy.bindResultSourceStorage(registration,operation=>operation()),/cannot change/);
    const guarded=await LocalReviewService.open({storageRoot:join(f.root,"guarded-review"),writableRoots:[f.repo],cases:[]}),error=Error("native guard unavailable");
    guarded.bindResultSourceStorage(registration,async()=>{throw error});
    await assert.rejects(guarded.withResultSource(async()=>{throw Error("Must not enter source");}),value=>value===error);
  }finally{await f.close();}
});

test("indexed integration rejects a foreign native root sharing the review store before reading or registering sources",windows,async()=>fixture(async(f,tasks,reviews,inventory,registration)=>{
  await fixture(async(other,otherTasks,otherReviews,otherInventory,otherRegistration)=>{
    assert.notEqual(registration.root,otherRegistration.root);
    const sharedReview=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[other.repo],cases:[]});
    await otherTasks.connectReviews(sharedReview);
    assert.deepEqual(otherTasks.resultSourceStorageRegistration(),otherRegistration);
    const foreign=await otherTasks.integrationSource(other.config.runId,false),local=await tasks.integrationSource(f.config.runId,false);
    assert.ok(Object.isFrozen(foreign.resultStorage));
    const foreignHead=(await otherInventory.audit()).head,localHead=(await inventory.audit()).head;
    let reads=0;
    const guarded={...foreign,readState:async()=>{reads++;throw Error("Foreign source must not be read")},
      readManifest:async()=>{reads++;throw Error("Foreign manifest must not be read")}};
    const scheduler=otherTasks.registeredScheduler(other.config.schedulerPath);
    const options={id:"mixed-registration",title:"Rejected integration",checkout:other.repo,baseSha:git(other.repo,["rev-parse","HEAD"]),
      outputDir:other.config.outputDir,evidenceSha256:"0".repeat(64),limits:"Synthetic only",sources:[guarded,guarded],scheduler};
    await assert.rejects(LocalIntegrationReviewService.register([options],reviews),/must share the review result storage registration/);
    for(const field of ["root","turnRoot","schedulerPath"] as const){
      const changed={...local,resultStorage:{...registration,[field]:registration[field]+"-different"}};
      await assert.rejects(LocalIntegrationReviewService.register([{...options,sources:[changed,changed]}],reviews),/must share the review result storage registration/);
    }
    await assert.rejects(LocalIntegrationReviewService.register([{...options,sources:[local,local],scheduler}],reviews),/Integration scheduler must share/);
    await assert.rejects(LocalIntegrationReviewService.register([{...options,sources:[{...local,resultStorage:null},local]}],reviews),/must share the review result storage registration/);
    await assert.rejects(LocalIntegrationReviewService.register([{...options,sources:[{...local,resultStorage:undefined as never},local]}],reviews),/requires explicit/);
    const taskCatalog=join(other.root,"mixed-task-catalog.json"),reviewCatalog=join(other.root,"shared-review-catalog.json");
    await writeFile(taskCatalog,JSON.stringify(other.catalog));
    await writeFile(reviewCatalog,JSON.stringify({storageRoot:join(f.root,"reviews"),writableRoots:[other.repo],cases:[]}));
    await assert.rejects(LocalIntegrationReviewService.open({integrations:[{...options,taskCatalog,reviewCatalog,
      sourceRunIds:["synthetic-one","synthetic-two"]}]},reviews,undefined,{storage:"indexed"}),/must share the review result storage registration/);
    assert.equal(reads,0);assert.deepEqual(reviews.list(),[]);assert.deepEqual(sharedReview.list(),[]);
    assert.deepEqual((await inventory.audit()).head,localHead);assert.deepEqual((await otherInventory.audit()).head,foreignHead);
    await inventory.withStorage(async()=>assert.ok(masterStorageTicket(registration.root)));
    await otherInventory.withStorage(async()=>assert.ok(masterStorageTicket(otherRegistration.root)));
  });
}));
