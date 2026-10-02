import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { MasterConversationAuthority, type MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { recoverWriter } from "../src/server/orchestration/writerRecovery.ts";

const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const bytes = (row: unknown) => JSON.stringify(row) + "\n";
async function child(binary: string, args: string[], input: unknown, expected: number) {
  const process = spawn(binary, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";process.stderr.on("data", value => { stderr += value; });
  const closed = new Promise<number | null>((accept, reject) => { process.once("close", accept);process.once("error", reject); });
  const timer = setTimeout(() => process.kill(), 120000);process.stdin.end(JSON.stringify(input));
  try { assert.equal(await closed, expected, stderr); } finally { clearTimeout(timer);process.kill();await closed; }
}
async function fixture(run: (f: { dir: string; root: string; master: string; cwd: string; request: MasterConversationRequest;
  inventory: MasterConversationInventory; authority: MasterConversationAuthority; owner: string; decisionId: string; proof: string; receipt: string }) => Promise<void>, migrated = false) {
  const dir = await mkdtemp(join(tmpdir(), "negi-indexed-receipt-")), cwd = join(dir, "checkout"), root = join(dir, "authority"), master = join(root, "masters", "master");
  await mkdir(cwd);const scheduler = new FileScheduler(join(dir, "scheduler.jsonl")), turnRoot = join(dir, "turns");
  const legacy = new MasterConversationAuthority({ root, turnRoot, masterId: "master", scheduler });
  const inventory = new MasterConversationInventory({ root, masterId: "master", recoveryContext: { turnRoot, schedulerPath: scheduler.path } });
  const request: MasterConversationRequest = { requestId: randomUUID(), masterId: "master", mode: "rotate", oldThreadId: "old-fixture",
    cwd, model: "fixture", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
  const identity = { threadId: "fixture-new", requestedModel: "fixture", resolvedModel: "fixture", modelProvider: "fixture", rerouted: false };
  try {
    await legacy.assertIdle(cwd);
    if (migrated) {
      await legacy.start({ ...request, requestId: randomUUID() }, async mark => { await mark();return identity; });
      const preview = await inventory.previewLegacyMigration();await inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
    } else await inventory.initialize();
    const script = "import {MasterConversationAuthority} from " + JSON.stringify(pathToFileURL(resolve("src/server/orchestration/masterConversations.ts")).href) +
      ";import {FileScheduler} from " + JSON.stringify(pathToFileURL(resolve("src/server/orchestration/scheduler.ts")).href) +
      ";let text='';for await(const part of process.stdin)text+=part;const r=JSON.parse(text);await new MasterConversationAuthority({root:r.root,turnRoot:r.turnRoot,masterId:'master',scheduler:new FileScheduler(r.scheduler),stageStorage:'indexed'}).start(r.request,async mark=>{await mark();process.exit(23);});";
    await child(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { root, turnRoot, scheduler: scheduler.path, request }, 23);
    const authority = new MasterConversationAuthority({ root, turnRoot, masterId: "master", scheduler, stageStorage: "indexed" });
    const owner = await readFile(join(master, "owner.lock"), "utf8"), preview = await authority.ownerRecovery(cwd), decisionId = randomUUID();
    assert.equal(preview?.ownerState, "dead");assert.equal(preview?.canRelease, false);
    const proof = preview!.proofSha256, key = Buffer.from(JSON.parse(await readFile(join(root, "signing-key.json"), "utf8")).key, "hex");
    const payload = { schemaVersion: "negi-master-owner-recovery/1", masterId: "master", decisionId, cwdSha256: hash(cwd),
      owner: JSON.parse(owner), proofSha256: proof, action: "release-owner-only", at: new Date().toISOString() };
    const receipt = bytes({ payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") });
    await run({ dir, root, master, cwd, request, inventory, authority, owner, decisionId, proof, receipt });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
type F = Parameters<Parameters<typeof fixture>[0]>[0];
async function append(f: F) {
  return f.inventory.appendRecoveryIntent({ expectedHead: (await f.inventory.audit()).head, ownerSha256: hash(f.owner), bytes: f.receipt });
}
const release = (f: F) => f.inventory.releaseRecoveryIntent({ decisionId: f.decisionId, expectedProofSha256: f.proof });

test("indexed recovery commits its exact receipt before native publication and preserves unresolved provider facts", async () => fixture(async f => {
  const before = await f.inventory.audit(), original = await Promise.all((await readdir(join(f.master, f.request.requestId))).map(name => readFile(join(f.master, f.request.requestId, name))));
  await assert.rejects(lstat(join(f.master, "recoveries")), { code: "ENOENT" });
  const intent = await append(f);assert.equal(intent.head.seq, before.head.seq + 1);
  await assert.rejects(lstat(join(f.master, "recoveries")), { code: "ENOENT" });
  const lookup = await f.inventory.recoveryIntent(f.decisionId);assert.equal(lookup.state, "pending");assert.equal(lookup.receipt?.bytes, f.receipt);assert.deepEqual(lookup.missing, [intent.relativePath]);
  await assert.rejects(recoverWriter(f.master, "master", JSON.parse(f.owner).operation, hash(f.owner), f.receipt));
  const result = await release(f);assert.equal(result.ownerReleased, true);assert.equal(result.operationComplete, false);assert.equal(result.state, "clean");assert.equal(result.head.seq, intent.head.seq);
  assert.equal(await readFile(join(f.master, intent.relativePath), "utf8"), f.receipt);await assert.rejects(lstat(join(f.master, "owner.lock")), { code: "ENOENT" });
  const database = await readFile(f.inventory.databasePath);assert.deepEqual(await release(f), result);assert.deepEqual(await readFile(f.inventory.databasePath), database);
  assert.deepEqual(await Promise.all((await readdir(join(f.master, f.request.requestId))).map(name => readFile(join(f.master, f.request.requestId, name)))), original);
  let callbacks = 0;assert.equal((await f.authority.start(f.request, async () => { callbacks++;throw Error("must not replay"); })).stage, "needs_reconciliation");
  assert.equal(callbacks, 0);assert.equal((await f.inventory.audit()).head.seq, intent.head.seq);
  await new FileScheduler(join(f.dir, "scheduler.jsonl")).ensureSubscriptionConfiguration();
  assert.deepEqual(await release(f), result); // A historical ACK does not operate on later runtime facts.
}));

for (const phase of ["intent", "partial", "published", "removed"] as const) test("actual indexed recovery child exit at " + phase + " reuses only the same fixed decision", async () => fixture(async f => {
  const request = { action: phase === "intent" ? "appendRecoveryIntent" : "releaseRecovery", root: f.root, masterId: "master", recoveryContext: { turnRoot: join(f.dir, "turns"), schedulerPath: join(f.dir, "scheduler.jsonl") },
    ...(phase === "intent" ? { expectedHead: (await f.inventory.audit()).head, ownerSha256: hash(f.owner), bytes: f.receipt } :
      { decisionId: f.decisionId, expectedProofSha256: f.proof }) };
  if (phase !== "intent") await append(f);
  const hook = phase === "partial" ? "original=n.windows_kernel\nclass Proxy:\n def __init__(self,k):self.k=k\n def __getattr__(self,key):return getattr(self.k,key)\n def WriteFile(self,h,p,size,count,o):\n  result=self.k.WriteFile(h,p,size//2,count,o)\n  os._exit(29)\nn.windows_kernel=lambda:Proxy(original())\n" :
    phase === "published" ? "original=n._publish_receipt_windows\ndef stopped(*args,**kwargs):\n original(*args,**kwargs)\n os._exit(29)\nn._publish_receipt_windows=stopped\n" :
      phase === "removed" ? "original=r.release_windows\ndef stopped(*args):\n original(*args)\n os._exit(29)\nr.release_windows=stopped\n" : "";
  const script = "import sys,json,os\nsys.path.insert(0," + JSON.stringify(resolve("scripts")) + ")\nimport negi_master_conversation_inventory as m\nimport negi_recover_writer as n\nimport negi_master_inventory_owner_recovery as r\n" +
    hook + "q=json.load(sys.stdin);i=m.Inventory(q['root'],q['masterId'])\n" + (phase === "intent" ? "i.append_receipt(q)\nos._exit(29)\n" : "i.release_recovery(q)\nos._exit(29)\n");
  await child("python", ["-B", "-c", script], request, 29);
  await assert.rejects(lstat(join(f.dir, "scheduler.jsonl.lock")), { code: "ENOENT" });
  const lookup = await f.inventory.recoveryIntent(f.decisionId);assert.equal(lookup.receipt?.bytes, f.receipt);
  assert.equal(lookup.state, phase === "published" || phase === "removed" ? "clean" : "pending");
  await assert.rejects(f.inventory.releaseRecoveryIntent({ decisionId: randomUUID(), expectedProofSha256: f.proof }));
  await assert.rejects(f.inventory.releaseRecoveryIntent({ decisionId: f.decisionId, expectedProofSha256: "b".repeat(64) }));
  if (phase === "partial") {
    const filename = ".pending-" + JSON.parse(f.owner).owner + "-" + f.decisionId + ".json";
    assert.equal((await readFile(join(f.master, "recoveries", filename))).length, Math.floor(Buffer.byteLength(f.receipt) / 2));
  }
  await release(f);await release(f);assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes, f.receipt);
  assert.deepEqual(await readdir(join(f.master, "recoveries")), [JSON.parse(f.owner).owner + ".json"]);
}));

test("indexed recovery appends a live receipt after adopted stages while preserving the accepted baseline", async () => fixture(async f => {
  const before = await f.inventory.audit();assert.equal(before.head.seq, 8);
  await append(f);await release(f);assert.equal((await f.inventory.audit()).head.seq, 9);
  assert.equal((await f.inventory.recoveryIntent(f.decisionId)).receipt?.bytes, f.receipt);
}, true));

test("changed pending prefix, changed final receipt and missing final after removal stay held", async () => {
  for (const state of ["pending", "changed", "missing"]) await fixture(async f => {
    const intent = await append(f), root = join(f.master, "recoveries"), database = await readFile(f.inventory.databasePath);
    if (state === "pending") {
      await mkdir(root);await writeFile(join(root, ".pending-" + JSON.parse(f.owner).owner + "-" + f.decisionId + ".json"), "not the fixed prefix");
    } else {
      await release(f);if (state === "changed") await writeFile(join(f.master, intent.relativePath), "changed");else await unlink(join(f.master, intent.relativePath));
    }
    await assert.rejects(release(f));assert.deepEqual(await readFile(f.inventory.databasePath), database);
    if (state === "missing") assert.equal((await f.inventory.recoveryIntent(f.decisionId)).state, "pending");
    else await assert.rejects(f.inventory.recoveryIntent(f.decisionId));
  });
});

test("receipt HMAC, exact owner and native live identity must pass before a recovery intent commit", async () => fixture(async f => {
  const initial = await f.inventory.audit(), database = await readFile(f.inventory.databasePath), key = Buffer.from(JSON.parse(await readFile(join(f.root, "signing-key.json"), "utf8")).key, "hex");
  await assert.rejects(f.inventory.appendRecoveryIntent({ expectedHead: initial.head, ownerSha256: "b".repeat(64), bytes: f.receipt }));
  const bad = JSON.parse(f.receipt);bad.signature = "a".repeat(64);
  await assert.rejects(f.inventory.appendRecoveryIntent({ expectedHead: initial.head, ownerSha256: hash(f.owner), bytes: bytes(bad) }));
  const owner = JSON.parse(f.owner), { signature: _signature, ...payload } = owner;payload.pid = process.pid;payload.processIdentity = await f.inventory.currentProcessIdentity();
  const live = bytes({ ...payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") });
  await writeFile(join(f.master, "owner.lock"), live);
  const receipt = JSON.parse(f.receipt);receipt.payload.owner = JSON.parse(live);receipt.signature = createHmac("sha256", key).update(JSON.stringify(receipt.payload)).digest("hex");
  await assert.rejects(f.inventory.appendRecoveryIntent({ expectedHead: initial.head, ownerSha256: hash(live), bytes: bytes(receipt) }));
  assert.deepEqual(await readFile(f.inventory.databasePath), database);await assert.rejects(lstat(join(f.master, "recoveries")), { code: "ENOENT" });
}));


test("adopted historical receipt lookup returns the original decision without enabling a new native release", async () => fixture(async f => {
  await unlink(f.inventory.databasePath);
  const legacy = new MasterConversationAuthority({ root: f.root, turnRoot: join(f.dir, "turns"), masterId: "master", scheduler: new FileScheduler(join(f.dir, "scheduler.jsonl")) });
  const preview = await legacy.ownerRecovery(f.cwd);assert.equal(preview?.canRelease, true);
  await legacy.releaseOwner(f.cwd, f.decisionId, preview!.proofSha256);
  const saved = await readFile(join(f.master, "recoveries", JSON.parse(f.owner).owner + ".json"), "utf8");
  const migration = await f.inventory.previewLegacyMigration();await f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: migration.proofSha256 });
  const lookup = await f.inventory.recoveryIntent(f.decisionId);assert.equal(lookup.state, "clean");assert.equal(lookup.receipt?.bytes, saved);
  const database = await readFile(f.inventory.databasePath);await assert.rejects(release(f));assert.deepEqual(await readFile(f.inventory.databasePath), database);
}));

test("unsigned SQL paths cannot subtract stages from the live receipt capacity of another Master", async () => fixture(async f => {
  await append(f);await release(f);
  await mkdir(join(f.root, "masters", "other"));await new MasterConversationInventory({ root: f.root, masterId: "other" }).registerEmptyMaster();
  const script = "import sys,json,sqlite3\nsys.path.insert(0," + JSON.stringify(resolve("scripts")) + ")\nimport negi_master_conversation_inventory as m\nq=json.load(sys.stdin)\nc=sqlite3.connect(q['root']+'.inventory.sqlite3')\nc.execute(\"UPDATE events SET path=? WHERE master_id='master' AND seq=1\",('recoveries/'+q['fake']+'.json',));c.commit();c.close()\nm.MAX_TOTAL_STAGE_EVENTS=2\ntry:m.Inventory(q['root'],'other').audit()\nexcept ValueError as e:\n assert 'global event capacity' in str(e),str(e)\nelse:raise AssertionError('unsigned stage path consumed receipt capacity')\n";
  await child("python", ["-B", "-c", script], { root: f.root, fake: randomUUID() }, 0);
}));

test("opened pending bytes changed after preflight are preserved before native truncation", async () => fixture(async f => {
  await append(f);
  const pending = ".pending-" + JSON.parse(f.owner).owner + "-" + f.decisionId + ".json";
  const script = "import sys,json,ctypes\nfrom ctypes import wintypes\nsys.path.insert(0," + JSON.stringify(resolve("scripts")) + ")\nimport negi_master_conversation_inventory as m\nimport negi_recover_writer as n\noriginal=n.windows_kernel\nclass Proxy:\n def __init__(self,k):self.k=k\n def __getattr__(self,key):return getattr(self.k,key)\n def CreateFileW(self,path,*args):\n  h=self.k.CreateFileW(path,*args)\n  if str(path).endswith(" + JSON.stringify(pending) + ") and args[3]==4:\n   count=wintypes.DWORD();data=ctypes.create_string_buffer(b'bad');assert self.k.WriteFile(h,data,3,ctypes.byref(count),None)\n  return h\nn.windows_kernel=lambda:Proxy(original())\nq=json.load(sys.stdin)\ntry:m.Inventory(q['root'],'master').release_recovery(q)\nexcept ValueError as e:assert 'indexed prefix' in str(e),str(e)\nelse:raise AssertionError('changed prefix overwritten')\n";
  await child("python", ["-B", "-c", script], { action: "releaseRecovery", root: f.root, masterId: "master", decisionId: f.decisionId, expectedProofSha256: f.proof, recoveryContext: { turnRoot: join(f.dir, "turns"), schedulerPath: join(f.dir, "scheduler.jsonl") } }, 0);
  assert.equal(await readFile(join(f.master, "recoveries", pending), "utf8"), "bad");assert.equal(await readFile(join(f.master, "owner.lock"), "utf8"), f.owner);
}));

test("indexed native release waits beyond 30 seconds for the actual fixed helper exit", async () => fixture(async f => {
  await append(f);
  const slow = "import sys,time\nsys.path.insert(0,sys.argv[1])\nimport negi_master_conversation_inventory as m\nimport negi_recover_writer as n\noriginal=n._publish_receipt_windows\ndef delayed(*args,**kwargs):\n original(*args,**kwargs)\n time.sleep(35)\nn._publish_receipt_windows=delayed\nm.main()\n";
  const script = "import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {dirname} from 'node:path';import {pathToFileURL} from 'node:url';const original=child.spawn;let started=0,closed=0;const owned=[];\n" +
    "child.spawn=(binary,args,options)=>{if(binary==='python'&&args[1]?.endsWith('negi_master_conversation_inventory.py')){const p=original(binary,['-B','-c'," + JSON.stringify(slow) + ",dirname(args[1])],options);started++;owned.push(p);p.once('close',()=>closed++);return p;}return original(binary,args,options);};syncBuiltinESMExports();let text='';for await(const part of process.stdin)text+=part;const input=JSON.parse(text);const {MasterConversationInventory}=await import(pathToFileURL(input.module).href);const timer=setTimeout(()=>{for(const p of owned)p.kill();},90000);try{const at=Date.now();const result=await new MasterConversationInventory({root:input.root,masterId:'master',recoveryContext:input.recoveryContext}).releaseRecoveryIntent(input.request);if(Date.now()-at<35000||started!==1||closed!==1||!result.ownerReleased||result.operationComplete!==false)throw Error('native helper was not awaited');}finally{clearTimeout(timer);child.spawn=original;syncBuiltinESMExports();}";
  await child(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { root: f.root, module: resolve("src/server/orchestration/masterConversationInventory.ts"), recoveryContext: { turnRoot: join(f.dir, "turns"), schedulerPath: join(f.dir, "scheduler.jsonl") }, request: { decisionId: f.decisionId, expectedProofSha256: f.proof } }, 0);
  assert.equal((await f.inventory.audit()).state, "clean");await assert.rejects(lstat(join(f.master, "owner.lock")), { code: "ENOENT" });
}));


test("current scheduler and turn baseline drift hold before intent commit and before native publication", async () => {
  for (const at of ["append", "release"]) for (const changed of ["scheduler", "turn-root"]) await fixture(async f => {
    if (at === "release") await append(f);
    const database = await readFile(f.inventory.databasePath);
    if (changed === "scheduler") await new FileScheduler(join(f.dir, "scheduler.jsonl")).ensureSubscriptionConfiguration();
    else await mkdir(join(f.dir, "turns"));
    await assert.rejects(at === "append" ? append(f) : release(f), /Current Master recovery evidence held/);
    assert.deepEqual(await readFile(f.inventory.databasePath), database);assert.equal(await readFile(join(f.master, "owner.lock"), "utf8"), f.owner);
    await assert.rejects(lstat(join(f.master, "recoveries")), { code: "ENOENT" });
  });
});

test("nonparticipant turn baseline changes after native publication preserve the exact owner", async () => fixture(async f => {
  await append(f);const database = await readFile(f.inventory.databasePath);
  const nodeCode = "import {mkdir} from 'node:fs/promises';await mkdir(" + JSON.stringify(join(f.dir, "turns")) + ");";
  const script = "import sys,json,subprocess\nsys.path.insert(0," + JSON.stringify(resolve("scripts")) + ")\nimport negi_master_conversation_inventory as m\nimport negi_recover_writer as n\noriginal=n._publish_receipt_windows\ndef changed(*args,**kwargs):\n original(*args,**kwargs)\n subprocess.run(['node','--import','tsx','--input-type=module','-e'," + JSON.stringify(nodeCode) + "],check=True,creationflags=subprocess.CREATE_NO_WINDOW)\nn._publish_receipt_windows=changed\nq=json.load(sys.stdin)\ntry:m.Inventory(q['root'],'master').release_recovery(q)\nexcept ValueError as e:assert 'Current Master recovery evidence held' in str(e),str(e)\nelse:raise AssertionError('stale evidence removed owner')\n";
  await child("python", ["-B", "-c", script], { action: "releaseRecovery", root: f.root, masterId: "master", decisionId: f.decisionId, expectedProofSha256: f.proof,
    recoveryContext: { turnRoot: join(f.dir, "turns"), schedulerPath: join(f.dir, "scheduler.jsonl") } }, 0);
  assert.equal(await readFile(join(f.master, "owner.lock"), "utf8"), f.owner);assert.deepEqual(await readFile(f.inventory.databasePath), database);
  assert.equal((await f.inventory.recoveryIntent(f.decisionId)).state, "clean");await assert.rejects(release(f));
}));

for (const at of ["append", "release"] as const) test("scheduler writers stay excluded after verifier return through " + at, async () => fixture(async f => {
  if (at === "release") await append(f);
  const schedulerPath = join(f.dir, "scheduler.jsonl"), finalPath = join(f.master, "recoveries", JSON.parse(f.owner).owner + ".json");
  const nodeCode = "import assert from 'node:assert/strict';import {FileScheduler} from " + JSON.stringify(pathToFileURL(resolve("src/server/orchestration/scheduler.ts")).href) +
    ";let held=false;try{await new FileScheduler(" + JSON.stringify(schedulerPath) + ").ensureSubscriptionConfiguration();}catch(error){assert.ok(['EEXIST','EPERM'].includes(error.code),String(error));held=true;}assert.ok(held,'scheduler changed after verifier returned');";
  const script = "import sys,json,subprocess\nfrom pathlib import Path\nsys.path.insert(0," + JSON.stringify(resolve("scripts")) + ")\nimport negi_master_conversation_inventory as m\noriginal=m.Inventory.verify_recovery\ncalls=0;attempts=0\ndef checked(self,*args):\n global calls,attempts\n original(self,*args);calls+=1\n if " + (at === "append" ? "calls==2" : "Path(" + JSON.stringify(finalPath) + ").exists()") + ":\n  subprocess.run(['node','--import','tsx','--input-type=module','-e'," + JSON.stringify(nodeCode) + "],check=True,creationflags=subprocess.CREATE_NO_WINDOW);attempts+=1\nm.Inventory.verify_recovery=checked\nq=json.load(sys.stdin);i=m.Inventory(q['root'],'master')\n" +
    (at === "append" ? "i.append_receipt(q)\nassert attempts==1,attempts\n" : "i.release_recovery(q)\nassert attempts==2,attempts\n") +
    "assert not Path(" + JSON.stringify(schedulerPath + ".lock") + ").exists()\n";
  const request = { action: at === "append" ? "appendRecoveryIntent" : "releaseRecovery", root: f.root, masterId: "master",
    recoveryContext: { turnRoot: join(f.dir, "turns"), schedulerPath },
    ...(at === "append" ? { expectedHead: (await f.inventory.audit()).head, ownerSha256: hash(f.owner), bytes: f.receipt } :
      { decisionId: f.decisionId, expectedProofSha256: f.proof }) };
  await child("python", ["-B", "-c", script], request, 0);
  await assert.rejects(lstat(schedulerPath), { code: "ENOENT" });
  if (at === "append") { assert.equal((await f.inventory.recoveryIntent(f.decisionId)).state, "pending");await release(f); }
  else assert.equal((await f.inventory.recoveryIntent(f.decisionId)).state, "clean");
  await new FileScheduler(schedulerPath).ensureSubscriptionConfiguration(); // The same writer can proceed after actual helper close.
  await release(f);
}));

test("an existing scheduler writer leaf is never stolen during append or native release", async () => {
  for (const at of ["append", "release"]) await fixture(async f => {
    if (at === "release") await append(f);
    const database = await readFile(f.inventory.databasePath), lock = join(f.dir, "scheduler.jsonl.lock"), foreign = "existing scheduler writer";
    await writeFile(lock, foreign, { flag: "wx" });
    await assert.rejects(at === "append" ? append(f) : release(f), /Scheduler writer exclusion unavailable/);
    assert.equal(await readFile(lock, "utf8"), foreign);assert.equal(await readFile(join(f.master, "owner.lock"), "utf8"), f.owner);
    assert.deepEqual(await readFile(f.inventory.databasePath), database);await assert.rejects(lstat(join(f.master, "recoveries")), { code: "ENOENT" });
    await unlink(lock);if (at === "append") await append(f);await release(f);
  });
});

test("registration is fixed in the signed intent and unsupported inspection/admission recovery stays held", async () => fixture(async f => {
  const database = await readFile(f.inventory.databasePath), head = (await f.inventory.audit()).head;
  await assert.rejects(new MasterConversationInventory({ root: f.root, masterId: "master" }).appendRecoveryIntent({ expectedHead: head, ownerSha256: hash(f.owner), bytes: f.receipt }), /registration required/);
  const key = Buffer.from(JSON.parse(await readFile(join(f.root, "signing-key.json"), "utf8")).key, "hex");
  for (const kind of ["inspection", "turn-admission"]) {
    const { signature: _signature, ...payload } = JSON.parse(f.owner);payload.kind = kind;
    const changed = bytes({ ...payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") });await writeFile(join(f.master, "owner.lock"), changed);
    const receipt = JSON.parse(f.receipt);receipt.payload.owner = JSON.parse(changed);receipt.signature = createHmac("sha256", key).update(JSON.stringify(receipt.payload)).digest("hex");
    await assert.rejects(f.inventory.appendRecoveryIntent({ expectedHead: head, ownerSha256: hash(changed), bytes: bytes(receipt) }), /not connected/);
    assert.deepEqual(await readFile(f.inventory.databasePath), database);
  }
  await writeFile(join(f.master, "owner.lock"), f.owner);await append(f);
  const alternate = new MasterConversationInventory({ root: f.root, masterId: "master", recoveryContext: { turnRoot: join(f.dir, "other-turns"), schedulerPath: join(f.dir, "scheduler.jsonl") } });
  await assert.rejects(alternate.releaseRecoveryIntent({ decisionId: f.decisionId, expectedProofSha256: f.proof }), /context changed/);
  assert.equal(await readFile(join(f.master, "owner.lock"), "utf8"), f.owner);
}));
