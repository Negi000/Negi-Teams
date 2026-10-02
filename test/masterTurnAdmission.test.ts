import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { guardMasterAdmission, scheduledMasterTurns, MasterInputNotSentError } from "../src/server/orchestration/masterTurnAdmission.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import type { CodexTurnObservation } from "../src/server/master/appServerClient.ts";
import { MasterConversationAuthority, MasterConversationHeldError } from "../src/server/orchestration/masterConversations.ts";

const observation: CodexTurnObservation = { turnId: "turn-a", status: "completed", finalText: "A plan",
  contextInputTokens: 10, contextWindow: 100, lastUsage: { inputTokens: 10, outputTokens: 2 } };
async function fixture(run: (data: { dir: string; cwd: string; root: string; scheduler: FileScheduler;
  request: Parameters<ReturnType<typeof scheduledMasterTurns>["reserve"]>[0] }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-master-slot-"));
  const cwd = join(dir, "checkout"), root = join(dir, "state");
  await mkdir(cwd);
  try { await run({ dir, cwd, root, scheduler: new FileScheduler(join(dir, "scheduler.jsonl")),
    request: { cwd, model: "synthetic-astra", effort: "medium", threadId: "thread-a", text: "Plan the next Task" } }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("a Master occupies the shared slot, pins intent and settles only with bound terminal evidence", async () => {
  await fixture(async ({ root, scheduler, request }) => {
    let released = 0;
    const admission = scheduledMasterTurns({ root, masterId: "master", scheduler,
      onReleased: async () => { released++; } });
    const lease = await admission.reserve(request);
    const pinned = JSON.parse(await readFile(join(root, lease.workId, "request.json"), "utf8"));
    assert.equal(pinned.text, request.text); assert.equal(pinned.model, request.model);
    assert.match(pinned.inputSha256, /^[0-9a-f]{64}$/);
    assert.equal((await scheduler.read()).state?.entries[0].status, "running");
    await assert.rejects(admission.reserve(request), MasterInputNotSentError);
    assert.deepEqual((await scheduler.read()).state?.entries.map(e => e.status), ["running", "cancelled"]);
    await lease.dispatching(); await lease.bind("turn-a");
    await assert.rejects(lease.complete({ ...observation, turnId: "wrong" }), /evidence incomplete/);
    assert.equal(released, 0);
    await lease.complete(observation); await lease.complete(observation);
    assert.equal(released, 1);
    const state = (await scheduler.read()).state!;
    assert.equal(state.entries[0].status, "verified"); assert.equal(state.entries[0].actualCostUsd, null);
    const evidence = JSON.parse(await readFile(join(root, lease.workId, "outcome.json"), "utf8"));
    assert.equal(evidence.humanAcceptance, null); assert.equal(evidence.finalText, "A plan");
    const next = await admission.reserve(request); await next.cancelBeforeDispatch();
    assert.equal(released, 2);
  });
});

test("compatibility checks cannot change reserved input or terminal evidence through caller mutation",async()=>fixture(async f=>{
 let release!:()=>void,entered!:()=>void,pause=new Promise<void>(accept=>{release=accept;}),ready=new Promise<void>(accept=>{entered=accept;});
 const guarded=guardMasterAdmission(scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler}),async()=>{entered();await pause;});
 const original={...f.request},pending=guarded.reserve(f.request);await ready;f.request.text="changed while checking";f.request.model="wrong model";
 release();const lease=await pending;
 const stored=JSON.parse(await readFile(join(f.root,lease.workId,"request.json"),"utf8"));assert.equal(stored.text,original.text);assert.equal(stored.model,original.model);
 await lease.dispatching();await lease.bind(observation.turnId);
 pause=new Promise<void>(accept=>{release=accept;});ready=new Promise<void>(accept=>{entered=accept;});
 const mutable=structuredClone(observation),completing=lease.complete(mutable);await ready;mutable.finalText="changed while checking";mutable.turnId="wrong";
 release();await completing;
 const terminal=JSON.parse(await readFile(join(f.root,lease.workId,"outcome.json"),"utf8"));assert.equal(terminal.finalText,observation.finalText);assert.equal(terminal.turnId,observation.turnId);
}));

test("partial reservation failure still checks storage and preserves the admitted claim",async()=>fixture(async f=>{
 const authorityRoot=join(f.dir,"conversations"),database=authorityRoot+".inventory.sqlite3";
 const authority=new MasterConversationAuthority({root:authorityRoot,turnRoot:f.root,masterId:"master",scheduler:f.scheduler});
 const base=scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler});let workId="";
 const guarded=guardMasterAdmission({reserve:async request=>{
  const lease=await base.reserve(request);workId=lease.workId;await writeFile(database,"new index");throw Error("partial reservation failure");
 }},()=>authority.assertStorageCompatible());
 await assert.rejects(guarded.reserve(f.request),MasterConversationHeldError);
 assert.deepEqual(await readdir(join(f.root,workId)),["request.json"]);assert.equal((await f.scheduler.read()).state?.entries[0].status,"running");
 assert.equal(await readFile(database,"utf8"),"new index");
}));

test("late storage detection reports a hold without undoing already saved terminal facts",async()=>fixture(async f=>{
 const authorityRoot=join(f.dir,"conversations"),database=authorityRoot+".inventory.sqlite3";
 const authority=new MasterConversationAuthority({root:authorityRoot,turnRoot:f.root,masterId:"master",scheduler:f.scheduler});
 const base=scheduledMasterTurns({root:f.root,masterId:"master",scheduler:f.scheduler});
 const guarded=guardMasterAdmission({reserve:async request=>{
  const lease=await base.reserve(request);return {...lease,complete:async result=>{
   await lease.complete(result);await writeFile(database,"new index");throw Error("error after terminal persistence");
  }};
 }},()=>authority.assertStorageCompatible());
 const lease=await guarded.reserve(f.request);await lease.dispatching();await lease.bind(observation.turnId);
 await assert.rejects(lease.complete(observation),MasterConversationHeldError);
 const terminal=await readFile(join(f.root,lease.workId,"outcome.json")),scheduler=await readFile(f.scheduler.path);
 assert.equal(JSON.parse(terminal.toString()).finalText,observation.finalText);assert.equal((await f.scheduler.read()).state?.entries[0].status,"verified");
 await assert.rejects(lease.complete(observation),MasterConversationHeldError);
 assert.deepEqual(await readFile(f.scheduler.path),scheduler);assert.deepEqual(await readFile(join(f.root,lease.workId,"outcome.json")),terminal);
}));

test("unknown Master results retain capacity across reload without restarting the provider", async () => {
  await fixture(async ({ root, scheduler, request }) => {
    const lease = await scheduledMasterTurns({ root, masterId: "first", scheduler }).reserve(request);
    await lease.dispatching(); await lease.unknown("Disconnected after turn/start");
    const reopened = new FileScheduler(scheduler.path);
    await assert.rejects(scheduledMasterTurns({ root, masterId: "second", scheduler: reopened }).reserve(request),
      MasterInputNotSentError);
    assert.equal((await reopened.read()).state?.entries[0].status, "needs_reconciliation");
    await lease.cancelBeforeDispatch();
    await assert.rejects(lease.complete(observation), /separate provider reconciliation/);
    assert.equal((await reopened.read()).state?.entries[0].status, "needs_reconciliation");
  });
});

test("concurrent Masters cannot exceed the shared configured capacity", async () => {
  await fixture(async ({ root, scheduler, request }) => {
    const results = await Promise.allSettled(["first", "second"].map(masterId =>
      scheduledMasterTurns({ root, masterId, scheduler }).reserve(request)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await scheduler.read()).events.filter(e => e.action.type === "configure").length, 1);
    for (const result of results) if (result.status === "fulfilled") await result.value.cancelBeforeDispatch();
  });
});

test("checkout ownership blocks a reader even with an available global slot", async () => {
  await fixture(async ({ cwd, root, scheduler, request }) => {
    await scheduler.append({ key: "config", at: new Date().toISOString(), action: { type: "configure", maxConcurrent: 2, budgetUsd: 0 } });
    await scheduler.append({ key: "worker", at: new Date().toISOString(), action: { type: "submit", work: {
      id: "worker", parentId: null, dependencies: [], role: "sol", checkout: cwd, checkoutMode: "write", resources: [], reserveUsd: 0 } } });
    await scheduler.claim("worker", "worker:dispatch");
    await assert.rejects(scheduledMasterTurns({ root, masterId: "master", scheduler }).reserve(request), MasterInputNotSentError);
    assert.equal((await scheduler.read()).state?.maxConcurrent, 2);
    assert.equal((await scheduler.read()).state?.entries[0].status, "running");
  });
});

test("known failed and interrupted turns release capacity; unfinished or missing-final turns do not", async () => {
  await fixture(async ({ root, scheduler, request }) => {
    const admission = scheduledMasterTurns({ root, masterId: "master", scheduler });
    for (const status of ["failed", "interrupted"] as const) {
      const lease = await admission.reserve(request); await lease.dispatching(); await lease.bind("turn-a");
      await lease.complete({ ...observation, status, finalText: null });
      assert.equal((await scheduler.read()).state?.entries.at(-1)?.status, "failed");
    }
    const lease = await admission.reserve(request); await lease.dispatching(); await lease.bind("turn-a");
    await assert.rejects(lease.complete({ ...observation, finalText: null }), /evidence incomplete/);
    await assert.rejects(lease.complete({ ...observation, status: "inProgress" }), /evidence incomplete/);
    assert.equal((await scheduler.read()).state?.entries.at(-1)?.status, "running");
    await lease.unknown("Missing final evidence");
  });
});

test("a durable output failure cannot free a claimed slot", async () => {
  await fixture(async ({ root, scheduler, request }) => {
    const admission = scheduledMasterTurns({ root, masterId: "master", scheduler });
    const lease = await admission.reserve(request); await lease.dispatching(); await lease.bind("turn-a");
    await writeFile(join(root, lease.workId, "outcome.json"), "Existing outcome must not be replaced");
    await assert.rejects(lease.complete(observation), /EEXIST/);
    await lease.unknown("Outcome persistence failed");
    assert.equal((await scheduler.read()).state?.entries[0].status, "needs_reconciliation");
    assert.equal(await readFile(join(root, lease.workId, "outcome.json"), "utf8"), "Existing outcome must not be replaced");
  });
});

test("read-only checkout and API budget guards reject before dispatch", async () => {
  await fixture(async ({ cwd, root, scheduler, request }) => {
    await assert.rejects(scheduledMasterTurns({ root: join(cwd, "state"), masterId: "master", scheduler }).reserve(request), MasterInputNotSentError);
    assert.deepEqual(await readdir(cwd), []);
    await scheduler.append({ key: "api", at: new Date().toISOString(), action: { type: "configure", maxConcurrent: 3, budgetUsd: 5 } });
    await assert.rejects(scheduledMasterTurns({ root, masterId: "master", scheduler }).reserve(request), /API budget/);
    assert.equal((await scheduler.read()).state?.entries.length, 0);
  });
});

test("a checkout alias cannot create evidence directories or scheduler files inside the read-only checkout", async () => {
  await fixture(async ({ dir, cwd, root, scheduler, request }) => {
    const alias = join(dir, "checkout-alias");
    await symlink(cwd, alias, "junction");
    await assert.rejects(scheduledMasterTurns({ root: join(alias, "state"), masterId: "master", scheduler }).reserve(request), MasterInputNotSentError);
    assert.deepEqual(await readdir(cwd), []);
    const unsafe = new FileScheduler(join(alias, "scheduler.jsonl"));
    await assert.rejects(scheduledMasterTurns({ root, masterId: "master", scheduler: unsafe }).reserve(request), MasterInputNotSentError);
    assert.deepEqual(await readdir(cwd), []);
    assert.equal((await scheduler.read()).state, null);
  });
});
