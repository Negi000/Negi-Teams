import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { MasterConversationAuthority, MasterConversationHeldError } from "../src/server/orchestration/masterConversations.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const hash = (raw: Buffer | string) => createHash("sha256").update(raw).digest("hex");
const scripts = resolve("scripts");
const imported = "import sys,json,os\nsys.path.insert(0,sys.argv[1])\nimport negi_master_conversation_inventory as m\nfrom negi_master_inventory_recovery import DatabaseRecovery\nr=json.load(sys.stdin);i=m.Inventory(r['root'],'master');recovery=DatabaseRecovery(i)\n";
async function python(code: string, input: unknown) {
  const child = spawn("python", ["-B", "-c", code, scripts], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  let stdout = "", stderr = "", error: Error | null = null;
  child.stdout.on("data", chunk => { stdout += chunk; });child.stderr.on("data", chunk => { stderr += chunk; });child.on("error", value => { error = value; });child.stdin.on("error", value => { error ??= value; });
  const closed = new Promise<number | null>(accept => child.once("close", accept));
  const timer = setTimeout(() => child.kill(), 45000);child.stdin.end(JSON.stringify(input));
  try { const code = await closed;if (error) throw error;return { code, stdout, stderr }; }
  finally { clearTimeout(timer);child.kill();await closed; }
}
interface Fixture { dir: string; root: string; inventory: MasterConversationInventory; baseline: Buffer; journal: string; ledger: string }
async function fixture(run: (f: Fixture) => Promise<void>, options: { extraMasters?: number; crashSql?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "negi-inventory-recovery-")), root = join(dir, "authority");
  await mkdir(join(root, "masters", "master"), { recursive: true });await mkdir(join(root, "masters", "other"));await mkdir(join(dir, "checkout"));
  for (let index = 0; index < (options.extraMasters ?? 0); index++) await mkdir(join(root, "masters", "extra-" + String(index).padStart(3, "0")));
  await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: randomBytes(32).toString("hex") }) + "\n");
  const inventory = new MasterConversationInventory({ root, masterId: "master" });
  try {
    await inventory.initialize();
    for (const masterId of ["master", "other"]) {
      const built = await python("import sys,json,runpy\nr=json.load(sys.stdin);sys.stdin=__import__('io').StringIO(json.dumps(r));runpy.run_path(r['builder'],run_name='__main__')", {
        root, masterId, count: 1, builder: resolve("test/helpers/masterConversationInventoryFixture.py"),
      });
      assert.equal(built.code, 0, built.stderr);
    }
    const baseline = await readFile(inventory.databasePath);
    const crashSql = options.crashSql ?? "c.execute('UPDATE masters SET seq=seq+100');c.execute('UPDATE meta SET body=randomblob(65536)');c.execute('UPDATE events SET artifact=randomblob(32768)')";
    const crash = await python(imported + "import sqlite3\nc=sqlite3.connect(i.db,isolation_level=None);c.execute('PRAGMA synchronous=FULL');c.execute('PRAGMA cache_size=1');c.execute('BEGIN IMMEDIATE');" + crashSql + ";os._exit(23)\n", { root });
    assert.equal(crash.code, 23, crash.stderr);
    const journal = inventory.databasePath + "-journal", bytes = await readFile(journal);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "d9d505f920a163d7", "fixture must spill an actual hot journal");
    await run({ dir, root, inventory, baseline, journal, ledger: inventory.databasePath + ".recoveries" });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function originals(f: Fixture) {
  return { db: await readFile(f.inventory.databasePath), journal: await readFile(f.journal) };
}
function request(f: Fixture, decisionId: string, expectedProofSha256: string) {
  return { action: "recoverDatabase", root: f.root, masterId: "master", decisionId, expectedProofSha256 };
}
async function injected(f: Fixture, decisionId: string, proof: string, hook: string) {
  return python(imported + hook + "\nprint(json.dumps(recovery.recover(r['request'])))\n", { root: f.root, request: request(f, decisionId, proof) });
}
const stopAfterIntent = "original=DatabaseRecovery.publish\ndef publish(self,decision,kind,payload):\n original(self,decision,kind,payload)\n if kind=='intent':os._exit(71)\nDatabaseRecovery.publish=publish\n";

test("explicit SQLite recovery authenticates all Masters from a clone, preserves preview originals, and restores only the database", async () => fixture(async f => {
  const before = await originals(f), names = await readdir(f.dir);
  await assert.rejects(f.inventory.audit(), /explicit reconciliation/);
  const preview = await f.inventory.previewDatabaseRecovery();assert.deepEqual(preview, await f.inventory.previewDatabaseRecovery());
  assert.equal(preview.databaseSha256, hash(before.db));assert.equal(preview.journalSha256, hash(before.journal));assert.equal(preview.recoveredSha256, hash(f.baseline));
  assert.deepEqual({ ...preview, proofSha256: "p", databaseSha256: "d", journalSha256: "j", recoveredSha256: "r" }, {
    proofSha256: "p", databaseSha256: "d", journalSha256: "j", recoveredSha256: "r", masterCount: 2, artifactCount: 10, missingCount: 0,
  });
  assert.deepEqual(await originals(f), before);assert.deepEqual(await readdir(f.dir), names);await assert.rejects(lstat(f.ledger), { code: "ENOENT" });
  const decisionId = randomUUID(), result = await f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 });
  assert.deepEqual(result, { ...preview, decisionId, recovered: true });assert.deepEqual(await readFile(f.inventory.databasePath), f.baseline);await assert.rejects(lstat(f.journal), { code: "ENOENT" });
  assert.deepEqual((await readdir(f.ledger)).sort(), [decisionId + ".done.json", decisionId + ".intent.json"]);
  for (const masterId of ["master", "other"]) assert.equal((await new MasterConversationInventory({ root: f.root, masterId }).audit()).artifactCount, 5);
  assert.deepEqual(await f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 }), result);
}));

test("staged namespace crash preserves its signed intent and fences bootstrap and legacy writers", async () => fixture(async f => {
  const before = await originals(f), preview = await f.inventory.previewDatabaseRecovery(), decision = randomUUID();
  const hook = "original=DatabaseRecovery.move\ndef move(self,kernel,source,destination):\n original(self,kernel,source,destination)\n if destination.suffix=='.json':os._exit(74)\nDatabaseRecovery.move=move\n";
  const exit = await injected(f, decision, preview.proofSha256, hook);assert.equal(exit.code, 74, exit.stderr);
  const pending = f.ledger + ".pending", bytes = await readFile(join(pending, decision + ".intent.json"));
  assert.equal(JSON.parse(bytes.toString()).payload.decisionId, decision);assert.deepEqual(await originals(f), before);
  await assert.rejects(f.inventory.previewDatabaseRecovery(), /pending recovery namespace/);
  await assert.rejects(f.inventory.recoverDatabase({ decisionId: decision, expectedProofSha256: preview.proofSha256 }), /pending recovery namespace/);
  await assert.rejects(f.inventory.initialize(), /recovery ledger survives/);
  await assert.rejects(new MasterConversationAuthority({ root: f.root, turnRoot: join(f.dir, "turns"), masterId: "master", scheduler: new FileScheduler(join(f.dir, "scheduler.jsonl")) }).assertStorageCompatible(), MasterConversationHeldError);
  const native = await python(imported + "from negi_recover_writer import master_inventory_absent\ntry:master_inventory_absent(i.master);raise AssertionError('legacy native admitted')\nexcept ValueError:pass\n", { root: f.root });assert.equal(native.code, 0, native.stderr);
  assert.deepEqual(await readFile(join(pending, decision + ".intent.json")), bytes);
}));

test("permission and invalid-stat ambiguity never count as absence at recovery authorization boundaries", async () => fixture(async f => {
  const before = await originals(f), names = await readdir(f.dir);
  for (const suffix of [".recoveries", ".recoveries.pending", "-wal", "-shm", "-journal", "/owner.lock", "/owner-recovery.lock"]) {
    const target = suffix.startsWith("/") ? join(f.root, "masters", "other", suffix.slice(1)) : f.inventory.databasePath + suffix;
    const held = await python(imported + "original=os.lstat;original_stat=os.stat\ndef denied(path,*args,**kwargs):\n if str(path)==r['target']:raise PermissionError('fixture attribute access denied')\n return original(path,*args,**kwargs)\ndef denied_stat(path,*args,**kwargs):\n if str(path)==r['target']:raise PermissionError('fixture attribute access denied')\n return original_stat(path,*args,**kwargs)\nos.lstat=denied;os.stat=denied_stat\ntry:recovery.preview();raise AssertionError('ambiguous path admitted')\nexcept PermissionError:pass\n", { root: f.root, target });
    assert.equal(held.code, 0, suffix + ": " + held.stderr);assert.deepEqual(await originals(f), before);
  }
  const invalid = await python(imported + "original=os.lstat\ndef invalid(path,*args,**kwargs):\n if str(path)==str(recovery.records_path):raise OSError(22,'fixture invalid stat')\n return original(path,*args,**kwargs)\nos.lstat=invalid\ntry:i.initialize();raise AssertionError('ambiguous bootstrap admitted')\nexcept OSError as error:assert error.errno==22\n", { root: f.root });assert.equal(invalid.code, 0, invalid.stderr);
  assert.deepEqual(await readdir(f.dir), names);
}));

test("recovery authenticates all registered Masters with two global validations per clone", async () => {
  for (const extraMasters of [0, 64]) await fixture(async f => {
    const inspected = await python(imported + "import time\noriginal=m.Inventory.validated;calls=[]\ndef counted(self,*args,**kwargs):\n calls.append(self.master_id);return original(self,*args,**kwargs)\nm.Inventory.validated=counted\nstart=time.monotonic();result=recovery.preview();assert len(calls)==4\nprint(json.dumps({'masters':result['masterCount'],'validations':len(calls),'elapsedMs':(time.monotonic()-start)*1000}))\n", { root: f.root });
    assert.equal(inspected.code, 0, inspected.stderr);const result = JSON.parse(inspected.stdout);
    assert.equal(result.masters, extraMasters + 2);assert.equal(result.validations, 4);assert.ok(result.elapsedMs > 0);
  }, { extraMasters });
});

test("a valid journal may exceed the scaled physical database limit without truncating either source", async () => fixture(async f => {
  const before = await originals(f);
  assert.ok(before.journal.length > before.db.length, "fixture must journal more bytes than its database");
  const recovered = await python(imported + "m.MAX_DATABASE_BYTES=r['limit']\npreview=recovery.preview();result=recovery.recover({'action':'recoverDatabase','root':r['root'],'masterId':'master','decisionId':r['decision'],'expectedProofSha256':preview['proofSha256']});assert recovery.record(r['decision'],'done',i.authority());print(json.dumps(result))\n", { root: f.root, limit: before.db.length, decision: randomUUID() });
  assert.equal(recovered.code, 0, recovered.stderr);assert.equal(JSON.parse(recovered.stdout).recoveredSha256, hash(f.baseline));
  assert.deepEqual(await readFile(f.inventory.databasePath), f.baseline);
}, { crashSql: "c.execute('PRAGMA user_version=999');c.execute('UPDATE meta SET body=randomblob(length(body))');c.execute('UPDATE masters SET seq=seq+100,last_sha=hex(randomblob(32))');c.execute(\"UPDATE events SET path=path||'x',body=randomblob(length(body)),artifact=randomblob(length(artifact))\");c.execute(\"INSERT INTO adoptions VALUES(1,x'01','invalid')\")" }));

test("completed recovery queries authenticate the past decision without touching a later owner or journal", async () => fixture(async f => {
  const preview = await f.inventory.previewDatabaseRecovery(), decisionId = randomUUID(), input = { decisionId, expectedProofSha256: preview.proofSha256 };
  const done = await f.inventory.recoverDatabase(input), db = await readFile(f.inventory.databasePath);
  const owner = join(f.root, "masters", "other", "owner.lock");await writeFile(owner, "later unknown owner");await writeFile(f.journal, "later unknown journal");
  const journal = await readFile(f.journal), receipt = await readFile(join(f.ledger, decisionId + ".done.json"));
  assert.deepEqual(await f.inventory.recoverDatabase(input), done);
  assert.deepEqual(await readFile(f.inventory.databasePath), db);assert.deepEqual(await readFile(f.journal), journal);assert.equal(await readFile(owner, "utf8"), "later unknown owner");
  assert.deepEqual(await readFile(join(f.ledger, decisionId + ".done.json")), receipt);
  await assert.rejects(f.inventory.recoverDatabase({ ...input, expectedProofSha256: "f".repeat(64) }), /completed recovery decision differs/);
}));

test("actual exits after intent, SQLite rollback and completion resume only the same persisted decision", async () => {
  for (const phase of ["intent", "rollback", "done"]) await fixture(async f => {
    const preview = await f.inventory.previewDatabaseRecovery(), before = await originals(f), decisionId = randomUUID();
    const hook = phase === "intent" ? stopAfterIntent : phase === "rollback" ?
      "import negi_master_inventory_recovery as recovery_module\noriginal=recovery_module.sqlite_rollback\ndef rollback(path):\n original(path)\n if path==i.db:os._exit(72)\nrecovery_module.sqlite_rollback=rollback\n" :
      "original=DatabaseRecovery.publish\ndef publish(self,decision,kind,payload):\n original(self,decision,kind,payload)\n if kind=='done':os._exit(73)\nDatabaseRecovery.publish=publish\n";
    const stopped = await injected(f, decisionId, preview.proofSha256, hook);assert.equal(stopped.code, phase === "intent" ? 71 : phase === "rollback" ? 72 : 73, stopped.stderr);
    if (phase === "intent") assert.deepEqual(await originals(f), before);
    else { assert.deepEqual(await readFile(f.inventory.databasePath), f.baseline);await assert.rejects(lstat(f.journal), { code: "ENOENT" }); }
    if (phase !== "done") {
      await assert.rejects(f.inventory.audit(), /unfinished SQLite recovery/);
      await assert.rejects(f.inventory.recoverDatabase({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /another SQLite recovery decision/);
    }
    const result = await f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 });
    assert.deepEqual(result, { ...preview, decisionId, recovered: true });assert.equal((await f.inventory.audit()).state, "clean");
  });
});

test("a partially restored database can resume its unchanged hot journal only toward the same authenticated target", async () => fixture(async f => {
  const preview = await f.inventory.previewDatabaseRecovery(), before = await originals(f), decisionId = randomUUID();
  const stopped = await injected(f, decisionId, preview.proofSha256, stopAfterIntent);assert.equal(stopped.code, 71, stopped.stderr);
  const pageSize = before.journal.readUInt32BE(24), different: number[] = [];
  for (let offset = 0; offset < f.baseline.length; offset += pageSize) if (!f.baseline.subarray(offset, offset + pageSize).equals(before.db.subarray(offset, offset + pageSize))) different.push(offset);
  assert.ok(different.length > 1, "fixture must have multiple spilled changed pages");
  // Construct the bytes of an interrupted rollback, without claiming an actual
  // power loss or injecting a fault inside SQLite's native pager.
  const intermediate = Buffer.from(before.db), first = different[0]!;f.baseline.copy(intermediate, first, first, first + pageSize);
  await writeFile(f.inventory.databasePath, intermediate);assert.notEqual(hash(intermediate), hash(before.db));assert.notEqual(hash(intermediate), hash(f.baseline));
  assert.deepEqual(await readFile(f.journal), before.journal);
  await assert.rejects(f.inventory.previewDatabaseRecovery(), /unfinished SQLite recovery/);
  const result = await f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 });
  assert.deepEqual(result, { ...preview, decisionId, recovered: true });assert.deepEqual(await readFile(f.inventory.databasePath), f.baseline);
}));

test("changed proof and any Master owner/recovery lock preserve the original pair before intent publication", async () => fixture(async f => {
  const preview = await f.inventory.previewDatabaseRecovery(), before = await originals(f);
  await assert.rejects(f.inventory.recoverDatabase({ decisionId: randomUUID(), expectedProofSha256: "f".repeat(64) }), /stale recovery preview/);
  for (const name of ["owner.lock", "owner-recovery.lock"]) {
    const path = join(f.root, "masters", "other", name);await writeFile(path, "unknown owner, preserve");
    await assert.rejects(f.inventory.previewDatabaseRecovery(), /owners\/recovery writers/);
    await assert.rejects(f.inventory.recoverDatabase({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /owners\/recovery writers/);
    assert.equal(await readFile(path, "utf8"), "unknown owner, preserve");await unlink(path);
  }
  assert.deepEqual(await originals(f), before);await assert.rejects(lstat(f.ledger), { code: "ENOENT" });
}));

test("missing or changed artifacts under another Master are fully audited before any original rollback", async () => {
  for (const kind of ["missing", "changed"]) await fixture(async f => {
    const other = join(f.root, "masters", "other"), operation = (await readdir(other))[0]!, path = join(other, operation, "04-completed.json");
    const before = await originals(f), raw = await readFile(path);
    if (kind === "changed") {
      await writeFile(path, "partial changed stage\n");await assert.rejects(f.inventory.previewDatabaseRecovery(), /indexed stage changed/);
      assert.deepEqual(await originals(f), before);await assert.rejects(lstat(f.ledger), { code: "ENOENT" });
    } else {
      await unlink(path);const preview = await f.inventory.previewDatabaseRecovery();assert.equal(preview.missingCount, 1);
      await f.inventory.recoverDatabase({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
      await assert.rejects(lstat(path), { code: "ENOENT" });assert.equal((await new MasterConversationInventory({ root: f.root, masterId: "other" }).audit()).state, "pending");
      assert.equal((await new MasterConversationInventory({ root: f.root, masterId: "other" }).lookup(operation + "/04-completed.json")).bytes, raw.toString("utf8"));
    }
  });
});

test("WAL, SHM, non-hot journals, super-journal tails and hardlinks are held without touching originals", async () => {
  for (const kind of ["wal", "shm", "cold", "super", "database-link", "journal-link"]) await fixture(async f => {
    if (kind === "wal" || kind === "shm") await writeFile(f.inventory.databasePath + "-" + kind, "preserve sidecar");
    if (kind === "cold") { const journal = await readFile(f.journal);journal.fill(0, 0, 8);await writeFile(f.journal, journal); }
    if (kind === "super") await writeFile(f.journal, Buffer.concat([await readFile(f.journal), Buffer.from("d9d505f920a163d7", "hex")]));
    if (kind.endsWith("link")) await link(kind === "database-link" ? f.inventory.databasePath : f.journal, join(f.dir, "linked-original"));
    const before = await originals(f);await assert.rejects(f.inventory.previewDatabaseRecovery());assert.deepEqual(await originals(f), before);await assert.rejects(lstat(f.ledger), { code: "ENOENT" });
  });
});

test("partial or unauthenticated recovery records remain held, and a surviving ledger prevents DB rebootstrap and legacy admission", async () => fixture(async f => {
  const preview = await f.inventory.previewDatabaseRecovery(), decisionId = randomUUID();
  const stopped = await injected(f, decisionId, preview.proofSha256, stopAfterIntent);assert.equal(stopped.code, 71, stopped.stderr);
  const intent = join(f.ledger, decisionId + ".intent.json"), original = await readFile(intent), before = await originals(f);
  await writeFile(intent, "partial intent");await assert.rejects(f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 }));assert.deepEqual(await originals(f), before);
  await writeFile(intent, original);const parsed = JSON.parse(original.toString("utf8"));parsed.signature = "f".repeat(64);await writeFile(intent, JSON.stringify(parsed) + "\n");
  await assert.rejects(f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 }), /recovery record authentication/);assert.deepEqual(await originals(f), before);
  await writeFile(intent, original);await f.inventory.recoverDatabase({ decisionId, expectedProofSha256: preview.proofSha256 });await unlink(f.inventory.databasePath);
  await assert.rejects(f.inventory.initialize(), /recovery ledger survives/);await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
  const authority = new MasterConversationAuthority({ root: f.root, masterId: "master", turnRoot: join(f.dir, "turns"), scheduler: new FileScheduler(join(f.dir, "scheduler.json")) });
  await assert.rejects(authority.assertStorageCompatible(), MasterConversationHeldError);
  const native = await python(imported + "from negi_recover_writer import master_inventory_absent\ntry:master_inventory_absent(i.master);raise AssertionError('legacy native admitted')\nexcept ValueError as error:assert 'Independent Master inventory' in str(error)\n", { root: f.root });assert.equal(native.code, 0, native.stderr);
}));

test("database recovery preview cannot create a missing root, guard, key, ledger or database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-inventory-recovery-missing-")), root = join(dir, "absent");
  try {
    await assert.rejects(new MasterConversationInventory({ root, masterId: "master" }).previewDatabaseRecovery());assert.deepEqual(await readdir(dir), []);
    const direct = await python(imported + "recovery.preview()\n", { root });assert.notEqual(direct.code, 0);assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recovery freezes its decision before guard waiting and admits only one pending decision", async () => fixture(async f => {
  const preview = await f.inventory.previewDatabaseRecovery(), first = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }, second = { ...first, decisionId: randomUUID() };
  const results = await Promise.allSettled([f.inventory.recoverDatabase(first), f.inventory.recoverDatabase(second)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);assert.equal(results.filter(row => row.status === "rejected").length, 1);
  const { withMasterStorageGuard } = await import("../src/server/orchestration/masterStorageGuard.ts");
  const input = { ...first };let pending: ReturnType<MasterConversationInventory["recoverDatabase"]>;
  await withMasterStorageGuard(f.root, async () => { pending = f.inventory.recoverDatabase(input);input.decisionId = randomUUID();input.expectedProofSha256 = "f".repeat(64);await pending; });
  assert.equal((await pending!).decisionId, first.decisionId);
}));

test("explicit recovery waits beyond 30 seconds after intent publication for the actual fixed helper exit", async () => fixture(async f => {
  const preview = await f.inventory.previewDatabaseRecovery();
  const slow = ["import sys,time", "sys.path.insert(0,sys.argv[1])", "import negi_master_conversation_inventory as m",
    "from negi_master_inventory_recovery import DatabaseRecovery", "original=DatabaseRecovery.publish", "def delayed(self,decision,kind,payload):",
    " original(self,decision,kind,payload)", " if kind=='intent':time.sleep(35)", "DatabaseRecovery.publish=delayed", "m.main()"].join("\n");
  const code = ["import child from 'node:child_process';", "import {syncBuiltinESMExports} from 'node:module';", "import {dirname} from 'node:path';",
    "import {pathToFileURL} from 'node:url';", "const original=child.spawn;let started=0,closed=0;const owned=[];",
    "child.spawn=(binary,args,options)=>{if(binary==='python'&&args[1]?.endsWith('negi_master_conversation_inventory.py')){",
    "const helper=original(binary,['-B','-c'," + JSON.stringify(slow) + ",dirname(args[1])],options);started++;owned.push(helper);helper.once('close',()=>closed++);return helper;}return original(binary,args,options);};",
    "syncBuiltinESMExports();let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);",
    "const {MasterConversationInventory}=await import(pathToFileURL(input.module).href);",
    "const timer=setTimeout(()=>{for(const helper of owned)helper.kill();},75000);",
    "try{const at=Date.now();const result=await new MasterConversationInventory({root:input.root,masterId:'master'}).recoverDatabase(input.request);",
    "if(Date.now()-at<35000||started!==1||closed!==1)throw Error('helper did not complete its delayed execution');console.log(JSON.stringify(result));}",
    "finally{clearTimeout(timer);child.spawn=original;syncBuiltinESMExports();}"].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";child.stdout.on("data", bytes => { stdout += bytes; });child.stderr.on("data", bytes => { stderr += bytes; });
  const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept);child.once("error", reject); });
  const request = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
  child.stdin.end(JSON.stringify({ root: f.root, module: resolve("src/server/orchestration/masterConversationInventory.ts"), request }));
  try { assert.equal(await closed, 0, stderr);assert.deepEqual(JSON.parse(stdout), { ...preview, decisionId: request.decisionId, recovered: true }); }
  finally { child.kill();await closed; }
}));

test("preview waits for a delayed clone helper and cleanup without arming an elapsed-time kill", async () => fixture(async f => {
  const names = await readdir(f.dir), before = await originals(f);
  const slow = ["import sys,time", "sys.path.insert(0,sys.argv[1])", "import negi_master_conversation_inventory as m",
    "import negi_master_inventory_recovery as recovery", "original=recovery.sqlite_rollback", "def delayed(path):",
    " original(path)", " time.sleep(1)", "recovery.sqlite_rollback=delayed", "m.main()"].join("\n");
  const code = ["import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {dirname} from 'node:path';import {pathToFileURL} from 'node:url';",
    "const original=child.spawn,timeout=globalThis.setTimeout;let closed=0,deadline=false;const owned=[];",
    "globalThis.setTimeout=(fn,ms,...args)=>{if(ms===900000||ms===30000){deadline=true;return timeout(fn,5,...args);}return timeout(fn,ms,...args);};",
    "child.spawn=(binary,args,options)=>{if(binary==='python'&&args[1]?.endsWith('negi_master_conversation_inventory.py')){const helper=original(binary,['-B','-c'," + JSON.stringify(slow) + ",dirname(args[1])],options);owned.push(helper);helper.once('close',()=>closed++);return helper;}return original(binary,args,options);};",
    "syncBuiltinESMExports();let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);const {MasterConversationInventory}=await import(pathToFileURL(input.module).href);",
    "const timer=timeout(()=>{for(const helper of owned)helper.kill();},45000);try{const result=await new MasterConversationInventory({root:input.root,masterId:'master'}).previewDatabaseRecovery();",
    "if(deadline||closed!==1||owned.length!==1)throw Error('preview elapsed deadline or helper not closed');console.log(JSON.stringify(result));}finally{clearTimeout(timer);child.spawn=original;globalThis.setTimeout=timeout;syncBuiltinESMExports();}"].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";child.stdout.on("data", bytes => { stdout += bytes; });child.stderr.on("data", bytes => { stderr += bytes; });
  const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept);child.once("error", reject); });
  child.stdin.end(JSON.stringify({ root: f.root, module: resolve("src/server/orchestration/masterConversationInventory.ts") }));
  try { assert.equal(await closed, 0, stderr);assert.equal(JSON.parse(stdout).recoveredSha256, hash(f.baseline)); }
  finally { child.kill();await closed; }
  assert.deepEqual(await originals(f), before);assert.deepEqual(await readdir(f.dir), names);
}));
