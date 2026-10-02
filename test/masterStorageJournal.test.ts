import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler, type SchedulerEvent, type SchedulerJournal } from "../src/server/orchestration/scheduler.ts";
import { scheduledMasterTurns, type MasterTurnJournal } from "../src/server/orchestration/masterTurnAdmission.ts";
import { masterStorageTicket, withMasterStorageGuard } from "../src/server/orchestration/masterStorageGuard.ts";

async function bytes(path: string) {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
const event = (key: string, action: SchedulerEvent["action"]): SchedulerEvent => ({ key, at: "2026-10-03T00:00:00.000Z", action });
const observation = { turnId: "turn", status: "completed", finalText: "Known result", contextInputTokens: 1,
  contextWindow: 100, lastUsage: { inputTokens: 1, outputTokens: 1 } };
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, native = false) {
  const dir = await mkdtemp(join(tmpdir(), "negi-storage-journal-"));
  try { await run(await setup(dir, native)); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function setup(dir: string, native: boolean) {
  const root = join(dir, "turns"), cwd = join(dir, "checkout"), storageRoot = join(dir, "authority"), path = join(dir, "scheduler.jsonl");
  await Promise.all([root, cwd, storageRoot].map(path => mkdir(path)));
  const expected = { scheduler: "", artifacts: new Map<string,string>() };
  const seen: string[] = [];
  const faults: { intent?: "before" | "after"; schedulerAudit?: string; turnIntent?: string; dispatchAudit?: boolean;
    replace?: boolean; mutate?: boolean } = {};
  const storage = <T>(fn: () => Promise<T>) => native ? withMasterStorageGuard(storageRoot, fn, {createIfMissing:false}) : fn();
  const checkScope = () => { if (native) assert.equal(masterStorageTicket(storageRoot)?.pid, process.pid); };
  const audit = async () => {
    checkScope();
    assert.equal(await bytes(path), expected.scheduler, "scheduler storage pending");
    for (const [relative, text] of expected.artifacts) assert.equal(await bytes(join(root,relative)),text,"turn storage pending");
  };
  const schedulerJournal: SchedulerJournal = { withStorage: storage,
    audit: async snapshot => {
      checkScope(); assert.equal(snapshot.path,path); assert.equal(snapshot.bytes, expected.scheduler,"scheduler storage pending");
      await audit();
      if (faults.schedulerAudit && snapshot.events.at(-1)?.key === faults.schedulerAudit) { faults.schedulerAudit=undefined; throw Error("lost scheduler publication ACK"); }
    },
    appendIntent: async input => {
      checkScope(); assert.equal(input.path,path); assert.equal(await bytes(path),input.previousBytes);
      seen.push("scheduler:"+input.event.key);
      if(faults.intent==="before")throw Error("intent rejected");
      expected.scheduler=input.previousBytes+input.bytes;
      if(faults.replace) { faults.replace=false; await rename(path,path+".original");await writeFile(path,input.previousBytes); }
      if(faults.intent==="after")throw Error("lost intent ACK");
      if(faults.mutate) { input.bytes="mutated";input.event.key="mutated"; }
    } };
  const scheduler = new FileScheduler(path,{journal:schedulerJournal});
  const turnJournal: MasterTurnJournal = { withStorage:storage,
    audit:async()=>{await audit();if(faults.dispatchAudit&&[...expected.artifacts.keys()].some(key=>key.endsWith("/dispatch.json"))){faults.dispatchAudit=false;throw Error("lost dispatch publication ACK");}},
    appendIntent:async input=>{
      checkScope();assert.ok(["request.json","dispatch.json","provider.json","outcome.json","not-sent.json"].includes(input.relativePath));
      const relative=input.workId+"/"+input.relativePath;
      assert.equal(await bytes(join(root,relative)),"");
      if(input.relativePath==="request.json")await assert.rejects(lstat(join(root,input.workId)),{code:"ENOENT"});
      seen.push("turn:"+input.relativePath);expected.artifacts.set(relative,input.bytes);
      if(faults.turnIntent===input.relativePath)throw Error("lost turn intent ACK");
      if(faults.mutate) input.bytes="mutated";
    } };
  const request={cwd,model:"fixture",effort:"low",threadId:"thread",text:"Read the request"};
  return {dir,root,cwd,storageRoot,path,expected,seen,faults,schedulerJournal,scheduler,turnJournal,request,audit};
}

test("all scheduler publication paths commit intent under the lock before writing exact bytes",async()=>fixture(async f=>{
  await f.scheduler.ensureSubscriptionConfiguration();
  await f.scheduler.ensureSubscriptionConfiguration({maxConcurrent:3,planners:2,workers:2});
  await f.scheduler.append(event("submit-pipeline",{type:"submit",work:{id:"pipeline",parentId:null,dependencies:[],role:"sol",checkout:f.cwd,checkoutMode:"write",resources:[],reserveUsd:0,execution:"astra_to_sol"}}));
  await f.scheduler.claim("pipeline","claim-pipeline");
  await f.scheduler.append(event("plan",{type:"finish_planning",workId:"pipeline",planRef:"plan#sha256="+"a".repeat(64),threadId:"thread",turnId:"turn"}));
  assert.ok(await f.scheduler.tryStartWorker("pipeline","worker"));
  await f.scheduler.append(event("done",{type:"settle",workId:"pipeline",outcome:"verified",evidenceRef:"result",actualCostUsd:null}));
  await f.scheduler.append(event("submit-next",{type:"submit",work:{id:"next",parentId:null,dependencies:[],role:"sol",checkout:f.cwd,checkoutMode:"write",resources:[],reserveUsd:0,execution:"direct"}}));
  assert.equal((await f.scheduler.startNext("start-next"))?.work.id,"next");
  const count=f.seen.length, saved=await bytes(f.path);
  await f.scheduler.append(event("done",{type:"settle",workId:"pipeline",outcome:"verified",evidenceRef:"result",actualCostUsd:null}));
  assert.equal(f.seen.length,count);assert.equal(await bytes(f.path),saved);
  assert.deepEqual(f.seen,(await f.scheduler.read()).events.map(e=>"scheduler:"+e.key));
}));

test("rejected or uncertain scheduler intent never writes or retries its pending event",async()=>fixture(async f=>{
  f.faults.intent="before";await assert.rejects(f.scheduler.ensureSubscriptionConfiguration(),/intent rejected/);
  await assert.rejects(lstat(f.path),{code:"ENOENT"});
  f.faults.intent="after";await assert.rejects(f.scheduler.ensureSubscriptionConfiguration(),/lost intent ACK/);
  await assert.rejects(lstat(f.path),{code:"ENOENT"});
  f.faults.intent=undefined;const count=f.seen.length;
  await assert.rejects(f.scheduler.read(),/pending/);await assert.rejects(f.scheduler.ensureSubscriptionConfiguration(),/pending/);
  assert.equal(f.seen.length,count);await assert.rejects(lstat(f.path+".lock"),{code:"ENOENT"});
}));

test("scheduler publication ACK loss preserves saved events and same-key acknowledgement does not append again",async()=>fixture(async f=>{
  await f.scheduler.ensureSubscriptionConfiguration();
  const submitted=event("submit",{type:"submit",work:{id:"work",parentId:null,dependencies:[],role:"sol",checkout:f.cwd,checkoutMode:"write",resources:[],reserveUsd:0}});
  const audit=f.schedulerJournal.audit;
  // Captured registration cannot be replaced. Use the registered hook's fault state.
  f.schedulerJournal.audit=async()=>{throw Error("replacement must not run");};
  // Trigger after append by setting the fault inside the already captured intent callback's state.
  f.faults.mutate=true;
  f.faults.schedulerAudit="submit";await assert.rejects(f.scheduler.append(submitted),/lost scheduler publication ACK/);
  f.schedulerJournal.audit=audit;
  const saved=await bytes(f.path),count=f.seen.length;
  assert.equal((await f.scheduler.read()).events.at(-1)?.key,"submit");
  assert.equal(await bytes(f.path),saved);await f.scheduler.append(submitted);
  assert.equal(await bytes(f.path),saved);assert.equal(f.seen.length,count);
}));

test("a replaced scheduler after committed intent is preserved and never receives the new event",async()=>fixture(async f=>{
  await f.scheduler.ensureSubscriptionConfiguration();const original=await bytes(f.path);
  f.faults.replace=true;
  await assert.rejects(f.scheduler.append(event("capacity",{type:"set_capacity",capacity:{maxConcurrent:2,planners:1,workers:1},sourceRef:"fixture"})),/changed after journal intent/);
  assert.equal(await bytes(f.path),original);assert.equal(await bytes(f.path+".original"),original);
  await assert.rejects(f.scheduler.read(),/pending/);
}));

test("journal mode rejects linked scheduler files, directory aliases and changed registered paths before writing",async()=>fixture(async f=>{
  await f.scheduler.ensureSubscriptionConfiguration();const saved=await bytes(f.path);
  await link(f.path,join(f.dir,"hardlink"));await assert.rejects(f.scheduler.read(),/unsafe/);
  await rm(join(f.dir,"hardlink"));
  const alias=join(f.dir,"alias");await symlink(f.dir,alias,"junction");
  const aliased=new FileScheduler(join(alias,"scheduler.jsonl"),{journal:f.schedulerJournal});
  await assert.rejects(aliased.ensureSubscriptionConfiguration(),/linked directory/);
  await assert.rejects(lstat(f.path+".lock"),{code:"ENOENT"});assert.equal(await bytes(f.path),saved);
  (f.scheduler as unknown as {path:string}).path=join(f.dir,"other.jsonl");
  await assert.rejects(f.scheduler.ensureSubscriptionConfiguration(),/registered scheduler path/);
  await assert.rejects(lstat(join(f.dir,"other.jsonl")),{code:"ENOENT"});
}));

test("turn intent precedes directory creation and normal lease publications use the registered snapshots",async()=>fixture(async f=>{
  f.faults.mutate=true;let releases=0;
  const registration={root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal,onReleased:async()=>{releases++;}};
  const admission=scheduledMasterTurns(registration);
  registration.root=join(f.dir,"other");registration.masterId="other";registration.onReleased=async()=>{throw Error("replacement");};
  const lease=await admission.reserve(f.request);await lease.dispatching();await lease.bind("turn");await lease.complete(observation);
  assert.deepEqual(f.seen.filter(x=>x.startsWith("turn:")),["turn:request.json","turn:dispatch.json","turn:provider.json","turn:outcome.json"]);
  assert.equal(JSON.parse(await bytes(join(f.root,lease.workId,"request.json"))).masterId,"master");
  assert.equal((await f.scheduler.read()).state?.entries[0]?.status,"verified");assert.equal(releases,1);
  await lease.complete(observation);assert.equal(releases,1);await f.audit();
}));

test("unknown and not-sent leases retain their different scheduler facts in journal mode",async()=>fixture(async f=>{
  const admission=scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal});
  const unsent=await admission.reserve(f.request);await unsent.cancelBeforeDispatch();
  const unknown=await admission.reserve(f.request);await unknown.dispatching();await unknown.unknown("transport lost");
  await unknown.cancelBeforeDispatch();await assert.rejects(unknown.complete(observation),/reconciliation/);
  assert.deepEqual((await f.scheduler.read()).state?.entries.map(e=>e.status),["failed","needs_reconciliation"]);
  assert.equal((await f.scheduler.read()).state?.entries.at(-1)?.claimKey,unknown.workId+":dispatch");
}));

test("lost turn intent ACK leaves no target directory or claim and blocks automatic retry",async()=>fixture(async f=>{
  const admission=scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal});
  f.faults.turnIntent="request.json";await assert.rejects(admission.reserve(f.request),/turn storage pending/);
  assert.deepEqual(await readdir(f.root),[]);assert.equal((await new FileScheduler(f.path).read()).state?.entries.length,0);
  const count=f.seen.length;await assert.rejects(admission.reserve(f.request),/turn storage pending/);assert.equal(f.seen.length,count);
}));

test("dispatch publication ACK loss cannot be reclassified as not sent",async()=>fixture(async f=>{
  const lease=await scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal}).reserve(f.request);
  f.faults.dispatchAudit=true;await assert.rejects(lease.dispatching(),/lost dispatch publication ACK/);
  await assert.rejects(lease.cancelBeforeDispatch(),/dispatched Master/);
  await assert.rejects(lstat(join(f.root,lease.workId,"not-sent.json")),{code:"ENOENT"});
  assert.equal((await f.scheduler.read()).state?.entries[0]?.status,"running");
}));

test("pre-existing partial dispatch evidence also prevents legacy not-sent settlement",async()=>fixture(async f=>{
  const scheduler=new FileScheduler(f.path),lease=await scheduledMasterTurns({root:f.root,masterId:"master",scheduler}).reserve(f.request);
  await writeFile(join(f.root,lease.workId,"dispatch.json"),"partial");
  await assert.rejects(lease.cancelBeforeDispatch(),/requires reconciliation/);
  assert.equal((await scheduler.read()).state?.entries[0]?.status,"running");
  await assert.rejects(lstat(join(f.root,lease.workId,"not-sent.json")),{code:"ENOENT"});
}));

test("missing registered turn root is not bootstrapped and oversized output cannot settle or release a claim",async()=>fixture(async f=>{
  const missing=join(f.dir,"missing");
  await assert.rejects(scheduledMasterTurns({root:missing,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal}).reserve(f.request),/root missing/);
  await assert.rejects(lstat(missing),{code:"ENOENT"});assert.equal(f.expected.scheduler,"");
  let releases=0;
  const lease=await scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal,onReleased:async()=>{releases++;}}).reserve(f.request);
  await lease.dispatching();await lease.bind("turn");
  await assert.rejects(lease.complete({...observation,finalText:"a".repeat(2_000_001)}),/read bound/);
  assert.equal(releases,0);assert.equal((await f.scheduler.read()).state?.entries[0]?.status,"running");
  await assert.rejects(lstat(join(f.root,lease.workId,"outcome.json")),{code:"ENOENT"});
}));

test("registered scheduler and turn publications use the same native storage scope", {skip:process.platform!=="win32"},async()=>fixture(async f=>{
  await withMasterStorageGuard(f.storageRoot,async()=>{});
  const admission=scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal});
  const lease=await admission.reserve(f.request);await lease.dispatching();await lease.bind("turn");await lease.complete(observation);
  await withMasterStorageGuard(f.storageRoot,f.audit,{createIfMissing:false});
  assert.equal((await f.scheduler.read()).state?.entries[0]?.status,"verified");
},true));

test("two registered scheduler instances cannot both claim the last native storage slot", {skip:process.platform!=="win32"},async()=>fixture(async f=>{
  await withMasterStorageGuard(f.storageRoot,async()=>{});
  await f.scheduler.ensureSubscriptionConfiguration({maxConcurrent:1,planners:1,workers:1});
  for(const id of ["one","two"])await f.scheduler.append(event("submit-"+id,{type:"submit",work:{id,parentId:null,dependencies:[],role:"sol",checkout:join(f.cwd,id),checkoutMode:"write",resources:[],reserveUsd:0,execution:"direct"}}));
  const peer=new FileScheduler(f.path,{journal:f.schedulerJournal});
  const claims=await Promise.all([f.scheduler.tryClaim("one","claim-one"),peer.tryClaim("two","claim-two")]);
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal((await peer.read()).state?.entries.filter(e=>e.status==="running").length,1);
  await withMasterStorageGuard(f.storageRoot,f.audit,{createIfMissing:false});
},true));

test("a scheduler path changed during the turn audit is held before configuration or turn creation",async()=>fixture(async f=>{
  const scheduler=new FileScheduler(f.path),other=join(f.dir,"wrong.jsonl");let first=true;
  const journal:MasterTurnJournal={...f.turnJournal,audit:async()=>{if(first){first=false;(scheduler as unknown as {path:string}).path=other;}},appendIntent:async()=>{throw Error("must not prepare");}};
  await assert.rejects(scheduledMasterTurns({root:f.root,masterId:"master",scheduler,journal}).reserve(f.request),/registered scheduler path/);
  assert.deepEqual(await readdir(f.root),[]);await assert.rejects(lstat(f.path),{code:"ENOENT"});await assert.rejects(lstat(other),{code:"ENOENT"});
}));

test("lost dispatch intent ACK retains the running claim and cannot produce a not-sent receipt",async()=>fixture(async f=>{
  const lease=await scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal:f.turnJournal}).reserve(f.request);
  f.faults.turnIntent="dispatch.json";await assert.rejects(lease.dispatching(),/turn storage pending/);
  await assert.rejects(lease.cancelBeforeDispatch(),/turn storage pending/);
  await assert.rejects(lstat(join(f.root,lease.workId,"dispatch.json")),{code:"ENOENT"});
  await assert.rejects(lstat(join(f.root,lease.workId,"not-sent.json")),{code:"ENOENT"});
  assert.equal((await new FileScheduler(f.path).read()).state?.entries[0]?.status,"running");
}));

test("an input edited while its registered storage audit waits does not replace the reserved message",async()=>fixture(async f=>{
  let enter!:()=>void,resume!:()=>void,first=true;
  const ready=new Promise<void>(accept=>{enter=accept;}),pause=new Promise<void>(accept=>{resume=accept;});
  const journal:MasterTurnJournal={...f.turnJournal,audit:async()=>{if(first){first=false;enter();await pause;}await f.audit();}};
  const original={...f.request},pending=scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler,journal}).reserve(f.request);
  await ready;f.request.text="A different draft";f.request.model="A different model";resume();
  const lease=await pending,record=JSON.parse(await bytes(join(f.root,lease.workId,"request.json")));
  assert.equal(record.text,original.text);assert.equal(record.model,original.model);await lease.cancelBeforeDispatch();
}));

test("request intent cannot retarget a plain scheduler to another configured ledger",async()=>fixture(async f=>{
  const scheduler=new FileScheduler(f.path),other=join(f.dir,"other.jsonl"),peer=new FileScheduler(other);
  await scheduler.ensureSubscriptionConfiguration();await peer.ensureSubscriptionConfiguration();
  const original=await bytes(f.path),otherOriginal=await bytes(other);let workId="";
  const journal:MasterTurnJournal={withStorage:async run=>run(),audit:async()=>{},appendIntent:async input=>{
    assert.equal(input.relativePath,"request.json");workId=input.workId;(scheduler as unknown as {path:string}).path=other;
  }};
  await assert.rejects(scheduledMasterTurns({root:f.root,masterId:"master",scheduler,journal}).reserve(f.request),/registered scheduler path/);
  assert.ok(workId);assert.deepEqual(await readdir(f.root),[]);
  assert.equal(await bytes(f.path),original);assert.equal(await bytes(other),otherOriginal);
  assert.equal((await new FileScheduler(f.path).read()).state?.entries.length,0);assert.equal((await peer.read()).state?.entries.length,0);
  await assert.rejects(lstat(join(f.root,workId)),{code:"ENOENT"});
}));

test("final turn audit path drift holds the already recorded claim instead of returning a lease",async()=>fixture(async f=>{
  const scheduler=new FileScheduler(f.path),other=join(f.dir,"other.jsonl"),peer=new FileScheduler(other);
  await scheduler.ensureSubscriptionConfiguration();await peer.ensureSubscriptionConfiguration();
  const otherOriginal=await bytes(other);let audits=0;
  const journal:MasterTurnJournal={withStorage:async run=>run(),appendIntent:async()=>{},audit:async()=>{
    if(++audits===2)(scheduler as unknown as {path:string}).path=other;
  }};
  await assert.rejects(scheduledMasterTurns({root:f.root,masterId:"master",scheduler,journal}).reserve(f.request),/registered scheduler path/);
  assert.equal(audits,2);assert.equal(await bytes(other),otherOriginal);
  const state=(await new FileScheduler(f.path).read()).state!;
  assert.equal(state.entries.length,1);assert.equal(state.entries[0].status,"running");
  assert.equal(await bytes(join(f.root,state.entries[0].work.id,"dispatch.json")),"");
}));

test("plain scheduler validation cannot move a publication to another registered path",async()=>fixture(async f=>{
  const scheduler=new FileScheduler(f.path),other=join(f.dir,"other.jsonl"),peer=new FileScheduler(other);
  await scheduler.ensureSubscriptionConfiguration();await peer.ensureSubscriptionConfiguration();
  const original=await bytes(f.path),otherOriginal=await bytes(other);
  await assert.rejects(scheduler.append(event("capacity",{type:"set_capacity",capacity:{maxConcurrent:2,planners:1,workers:1},sourceRef:"fixture"}),async()=>{
    (scheduler as unknown as {path:string}).path=other;return true;
  }),/registered scheduler path/);
  await assert.rejects(scheduler.read(),/registered scheduler path/);
  assert.equal(await bytes(f.path),original);assert.equal(await bytes(other),otherOriginal);
  await assert.rejects(lstat(f.path+".lock"),{code:"ENOENT"});await assert.rejects(lstat(other+".lock"),{code:"ENOENT"});
}));
