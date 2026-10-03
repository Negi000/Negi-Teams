import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { withMasterStorageGuard } from "../src/server/orchestration/masterStorageGuard.ts";
import { signedMasterOwner, type MasterOwnerPayload } from "../src/server/orchestration/masterConversationOwner.ts";
import type { MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";
import { MasterConversationAuthority, MasterConversationHeldError } from "../src/server/orchestration/masterConversations.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const scripts = resolve("scripts");
const thread = { threadId: "fixture-new", requestedModel: "fixture", resolvedModel: "fixture", modelProvider: "fixture", rerouted: false };
const completed = ["requested", "old_idle", "start_dispatched", "bound", "completed"];
interface Artifact { relativePath: string; bytes: string }
interface Fixture {
  dir: string; root: string; key: Buffer; cwd: string; inventory: MasterConversationInventory;
  operation: (masterId: string, stages: string[]) => Promise<{ request: MasterConversationRequest; records: Artifact[] }>;
  receipt: (masterId: string, version: 2 | 3, decisionId?: string) => Promise<Artifact>;
}
function signed(payload: unknown, key: Buffer) {
  return JSON.stringify({ payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-migration-")), root = join(dir, "authority"), cwd = join(dir, "checkout"), key = randomBytes(32);
  await mkdir(join(root, "masters", "master"), { recursive: true });await mkdir(cwd);
  await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: key.toString("hex") }) + "\n");
  // Explicit guard installation precedes the read-only preview.
  await withMasterStorageGuard(root, async () => {});
  const f: Fixture = { dir, root, cwd, key, inventory: new MasterConversationInventory({ root, masterId: "master" }),
    operation: async (masterId, stages) => {
      const request: MasterConversationRequest = { requestId: randomUUID(), masterId, mode: "rotate", oldThreadId: "fixture-old", cwd,
        model: "fixture", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
      const records: Artifact[] = [];let previous: string | null = null;
      for (const [index, stage] of stages.entries()) {
        const payload = { schemaVersion: "negi-master-conversation/1", request, stage, previousSha256: previous ? hash(previous) : null,
          identity: ["bound", "completed"].includes(stage) ? thread : null, reason: stage === "needs_reconciliation" ? "fixture unknown" : null,
          at: "2026-10-02T00:00:00.000Z" };
        const record = { relativePath: request.requestId + "/0" + index + "-" + stage + ".json", bytes: signed(payload, key) };
        const path = join(root, "masters", masterId, record.relativePath);await mkdir(dirname(path), { recursive: true });await writeFile(path, record.bytes, { flag: "wx" });
        records.push(record);previous = record.bytes;
      }
      return { request, records };
    },
    receipt: async (masterId, version, decisionId = randomUUID()) => {
      const common = { pid: process.pid, owner: randomUUID(), createdAt: "2026-10-02T00:00:00.000Z", masterId,
        kind: "inspection" as const, cwdSha256: hash(cwd), operation: { domain: "master-conversation" as const, requestId: randomUUID(), hash: "c".repeat(64) }, evidenceSha256: "d".repeat(64) };
      const ownerPayload: MasterOwnerPayload = version === 2 ? { schema: "negi-master-conversation-owner/2", ...common } :
        { schema: "negi-master-conversation-owner/3", ...common, processIdentity: await f.inventory.currentProcessIdentity() };
      const owner = JSON.parse(signedMasterOwner(ownerPayload, key));
      const payload = { schemaVersion: "negi-master-owner-recovery/1", masterId, decisionId, cwdSha256: hash(cwd), owner,
        proofSha256: "e".repeat(64), action: "release-owner-only", at: "2026-10-02T00:00:00.000Z" };
      const record = { relativePath: "recoveries/" + common.owner + ".json", bytes: signed(payload, key) };
      const path = join(root, "masters", masterId, record.relativePath);await mkdir(dirname(path), { recursive: true });await writeFile(path, record.bytes, { flag: "wx" });return record;
    } };
  try { await run(f); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function source(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string, relative: string) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), key = relative + name, info = await lstat(child);
      if (info.isDirectory()) { result[key + "/"] = "directory";await walk(child, key + "/"); }
      else result[key] = hash(await readFile(child));
    }
  }
  await walk(root, "");return result;
}
async function python(code: string, value: unknown) {
  const child = spawn("python", ["-B", "-c", code, scripts], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  let stdout = "", stderr = "", error: Error | null = null;
  child.stdout.on("data", bytes => { stdout += bytes; });child.stderr.on("data", bytes => { stderr += bytes; });child.on("error", value => { error = value; });
  child.stdin.on("error", value => { error ??= value; });
  const closed = new Promise<number | null>(accept => child.once("close", accept));
  const timer = setTimeout(() => child.kill(), 30000);child.stdin.end(JSON.stringify(value));
  try { const code = await closed;if (error) throw error;return { code, stdout, stderr }; }
  finally { clearTimeout(timer);child.kill();await closed; }
}
const imported = "import sys,json,os\nsys.path.insert(0,sys.argv[1])\nimport negi_master_conversation_inventory as m\nr=json.load(sys.stdin);i=m.Inventory(r['root'],'master')\n";

test("legacy adoption preserves all Masters, original stages/receipts and incomplete provider facts", async () => fixture(async f => {
  const complete = await f.operation("master", completed), cancelled = await f.operation("master", ["requested", "cancelled"]);
  const unknown = await f.operation("other", ["requested", "old_idle", "start_dispatched", "needs_reconciliation"]);
  await mkdir(join(f.root, "masters", "empty"));
  const old = await f.receipt("master", 2), modern = await f.receipt("other", 3), before = await source(f.root);
  const preview = await f.inventory.previewLegacyMigration();assert.deepEqual(preview, await f.inventory.previewLegacyMigration());
  assert.deepEqual({ ...preview, proofSha256: "proof" }, { proofSha256: "proof", masterCount: 3, stageCount: 11, receiptCount: 2 });
  await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });assert.deepEqual(await source(f.root), before);
  const decisionId = randomUUID(), accepted = await f.inventory.migrateLegacy({ decisionId, expectedProofSha256: preview.proofSha256 });
  assert.deepEqual(accepted, { ...preview, decisionId });assert.deepEqual(await source(f.root), before);
  for (const [id, records] of [["master", [...complete.records, ...cancelled.records, old]], ["other", [...unknown.records, modern]]] as const) {
    const index = new MasterConversationInventory({ root: f.root, masterId: id });assert.equal((await index.audit()).artifactCount, records.length);
    for (const record of records) assert.equal((await index.lookup(record.relativePath)).bytes, record.bytes);
  }
  const db = await readFile(f.inventory.databasePath);
  assert.deepEqual(await f.inventory.migrateLegacy({ decisionId, expectedProofSha256: preview.proofSha256 }), accepted);
  assert.deepEqual(await readFile(f.inventory.databasePath), db);
  await assert.rejects(f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /different migration decision/);
  await assert.rejects(f.inventory.previewLegacyMigration(), /existing database/);
  assert.equal(JSON.parse((await new MasterConversationInventory({ root: f.root, masterId: "other" }).lookup(unknown.records.at(-1)!.relativePath)).bytes).payload.stage, "needs_reconciliation");
}));

test("adopted history admits exact owner intents and empty registration without rewriting its baseline", async () => fixture(async f => {
  const history = await f.operation("master", completed);await f.receipt("master", 2);
  const preview = await f.inventory.previewLegacyMigration(), input = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
  await f.inventory.migrateLegacy(input);const before = await source(f.root);
  const request = { ...history.request, requestId: randomUUID() }, payload = { schemaVersion: "negi-master-conversation/1", request, stage: "requested", previousSha256: null, identity: null, reason: null, at: "2026-10-02T00:00:00.000Z" };
  const raw = signedMasterOwner({ schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(), masterId: "master", kind: "thread-start",
    cwdSha256: hash(f.cwd), operation: { domain: "master-conversation", requestId: request.requestId, hash: hash(JSON.stringify(request) + "\n") }, evidenceSha256: "b".repeat(64), processIdentity: await f.inventory.currentProcessIdentity() }, f.key);
  await writeFile(join(f.root, "masters", "master", "owner.lock"), raw);
  const record = { relativePath: request.requestId + "/00-requested.json", bytes: signed(payload, f.key) };
  const intent = await f.inventory.appendStageIntent({ ...record, ownerSha256: hash(raw), expectedHead: (await f.inventory.audit()).head });assert.equal(intent.head.seq, 7);
  await mkdir(join(f.root, "masters", "master", request.requestId));await writeFile(join(f.root, "masters", "master", record.relativePath), record.bytes);await unlink(join(f.root, "masters", "master", "owner.lock"));
  await mkdir(join(f.root, "masters", "later"));await new MasterConversationInventory({ root: f.root, masterId: "later" }).registerEmptyMaster();
  assert.equal((await f.inventory.audit()).state, "clean");assert.equal((await f.inventory.migrateLegacy(input)).stageCount, 5);
  const after = await source(f.root);for (const [path, bytes] of Object.entries(before)) assert.equal(after[path], bytes);
}));

test("read-only migration preview does not create a missing authority, key, guard or DB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-migration-missing-")), root = join(dir, "missing");
  try { await assert.rejects(new MasterConversationInventory({ root, masterId: "master" }).previewLegacyMigration());assert.deepEqual(await readdir(dir), []); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy adoption does not bypass normal provider/startup authority integration gates", async () => fixture(async f => {
  const history = await f.operation("master", completed), preview = await f.inventory.previewLegacyMigration();
  await f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
  const before = await source(f.root), db = await readFile(f.inventory.databasePath), turnRoot = join(f.dir, "turns"), scheduler = new FileScheduler(join(f.dir, "scheduler.json"));
  const authority = new MasterConversationAuthority({ root: f.root, turnRoot, masterId: "master", scheduler });let dispatched = 0;
  await assert.rejects(authority.assertStartupSafe(f.cwd), MasterConversationHeldError);
  await assert.rejects(authority.start({ ...history.request, requestId: randomUUID() }, async () => { dispatched++;return thread; }), MasterConversationHeldError);
  assert.equal(dispatched, 0);assert.deepEqual(await source(f.root), before);assert.deepEqual(await readFile(f.inventory.databasePath), db);
  await assert.rejects(lstat(turnRoot), { code: "ENOENT" });
}));

test("changed preview proof and any Master owner/recovery lock hold without creating a DB", async () => fixture(async f => {
  const records = (await f.operation("master", completed)).records, preview = await f.inventory.previewLegacyMigration();
  const original = records[4]!, parsed = JSON.parse(original.bytes);parsed.payload.reason = "changed valid history";
  await writeFile(join(f.root, "masters", "master", original.relativePath), signed(parsed.payload, f.key));
  await assert.rejects(f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /preview changed/);
  await writeFile(join(f.root, "masters", "master", original.relativePath), original.bytes);await mkdir(join(f.root, "masters", "other"));
  for (const filename of ["owner.lock", "owner-recovery.lock"]) {
    const path = join(f.root, "masters", "other", filename);await writeFile(path, "preserve unknown writer");const before = await source(f.root);
    await assert.rejects(f.inventory.previewLegacyMigration(), /owners\/recovery writers/);assert.deepEqual(await source(f.root), before);await unlink(path);
  }
  await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
}));

test("malformed, duplicated, pending or hardlinked legacy receipts remain unchanged and unadopted", async () => {
  for (const kind of ["signature", "owner", "duplicate", "pending", "hardlink"]) await fixture(async f => {
    const receipt = await f.receipt("master", 2), path = join(f.root, "masters", "master", receipt.relativePath), parsed = JSON.parse(receipt.bytes);
    if (kind === "signature") { parsed.signature = "f".repeat(64);await writeFile(path, JSON.stringify(parsed) + "\n"); }
    if (kind === "owner") { parsed.payload.owner.pid++;await writeFile(path, signed(parsed.payload, f.key)); }
    if (kind === "duplicate") await f.receipt("master", 3, parsed.payload.decisionId);
    if (kind === "pending") await writeFile(join(dirname(path), ".pending-" + parsed.payload.owner.owner + "-" + randomUUID() + ".json"), "partial");
    if (kind === "hardlink") await link(path, join(f.dir, "linked-receipt"));
    const before = await source(f.root);await assert.rejects(f.inventory.previewLegacyMigration());assert.deepEqual(await source(f.root), before);
    await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
  });
});

test("invalid or incomplete legacy stage trees are preserved for reconciliation", async () => {
  for (const kind of ["missing-first", "partial", "signature", "empty"]) await fixture(async f => {
    const records = (await f.operation("master", completed)).records, path = join(f.root, "masters", "master", records[0]!.relativePath);
    if (kind === "missing-first") await unlink(path);
    if (kind === "partial") await writeFile(path, records[0]!.bytes.slice(0, 20));
    if (kind === "signature") { const value = JSON.parse(records[0]!.bytes);value.payload.reason = "unsigned change";await writeFile(path, JSON.stringify(value) + "\n"); }
    if (kind === "empty") await mkdir(join(f.root, "masters", "master", randomUUID()));
    const before = await source(f.root);await assert.rejects(f.inventory.previewLegacyMigration());assert.deepEqual(await source(f.root), before);
    await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
  });
});

test("a late owner before migration COMMIT preserves that owner and retains the partial DB", async () => fixture(async f => {
  await f.operation("master", completed);const preview = await f.inventory.previewLegacyMigration();
  const code = imported + ["original=i.legacy_snapshot", "def changed(check_database=True):", " if not check_database:(i.master/'owner.lock').write_bytes(b'new unresolved owner')",
    " return original(check_database)", "i.legacy_snapshot=changed", "try:i.migrate(r['request']);raise AssertionError('late owner admitted')",
    "except ValueError as error:assert 'owners/recovery writers' in str(error)", "assert (i.master/'owner.lock').read_bytes()==b'new unresolved owner' and i.db.exists()", "print('held late owner; partial DB retained')"].join("\n");
  const result = await python(code, { root: f.root, request: { action: "migrate", root: f.root, masterId: "master", decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 } });
  assert.equal(result.code, 0, result.stderr);assert.equal(result.stdout.trim(), "held late owner; partial DB retained");
  await assert.rejects(f.inventory.previewLegacyMigration(), /existing database/);
}));

test("migration exits before COMMIT preserve journal/DB and never trigger automatic rollback", async () => fixture(async f => {
  await f.operation("master", completed);const preview = await f.inventory.previewLegacyMigration(), before = await source(f.root);
  const code = imported + ["original=i.legacy_snapshot", "def stopped(check_database=True):", " if not check_database:os._exit(77)", " return original(check_database)", "i.legacy_snapshot=stopped", "i.migrate(r['request'])"].join("\n");
  const request = { action: "migrate", root: f.root, masterId: "master", decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
  assert.equal((await python(code, { root: f.root, request })).code, 77);
  const db = await readFile(f.inventory.databasePath), journal = await readFile(f.inventory.databasePath + "-journal");assert.ok(journal.length);
  await assert.rejects(f.inventory.migrateLegacy({ decisionId: request.decisionId, expectedProofSha256: request.expectedProofSha256 }), /journal\/WAL\/SHM/);
  assert.deepEqual(await readFile(f.inventory.databasePath), db);assert.deepEqual(await readFile(f.inventory.databasePath + "-journal"), journal);assert.deepEqual(await source(f.root), before);
}));

test("COMMIT before lost acknowledgement is inspected by the same decision without replay", async () => fixture(async f => {
  await f.operation("master", completed);await f.receipt("master", 2);const preview = await f.inventory.previewLegacyMigration(), before = await source(f.root);
  const code = imported + ["from contextlib import contextmanager", "original=i.connection", "@contextmanager", "def lost(writable=False,initialize=False):",
    " with original(writable,initialize) as result:yield result", " if initialize:os._exit(79)", "i.connection=lost", "i.migrate(r['request'])"].join("\n");
  const request = { action: "migrate", root: f.root, masterId: "master", decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
  assert.equal((await python(code, { root: f.root, request })).code, 79);const db = await readFile(f.inventory.databasePath);
  assert.deepEqual(await f.inventory.migrateLegacy({ decisionId: request.decisionId, expectedProofSha256: request.expectedProofSha256 }), { ...preview, decisionId: request.decisionId });
  assert.deepEqual(await readFile(f.inventory.databasePath), db);assert.deepEqual(await source(f.root), before);
}));

test("accepted decision retries audit every Master and receipt, holding missing or modified originals", async () => {
  for (const kind of ["missing-stage", "changed-receipt"]) await fixture(async f => {
    await f.operation("master", completed);const other = await f.operation("other", completed), receipt = await f.receipt("other", 2);
    const preview = await f.inventory.previewLegacyMigration(), input = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };await f.inventory.migrateLegacy(input);
    const db = await readFile(f.inventory.databasePath);
    if (kind === "missing-stage") await unlink(join(f.root, "masters", "other", other.records[4]!.relativePath));
    else await writeFile(join(f.root, "masters", "other", receipt.relativePath), receipt.bytes + " ");
    await assert.rejects(f.inventory.migrateLegacy(input));assert.deepEqual(await readFile(f.inventory.databasePath), db);
  });
});

test("explicit migration waits for actual helper exit beyond the ordinary 30-second deadline", async () => fixture(async f => {
  await f.operation("master", completed);const preview = await f.inventory.previewLegacyMigration();
  const slow = ["import sys,time", "sys.path.insert(0,sys.argv[1])", "import negi_master_conversation_inventory as m",
    "original=m.Inventory.legacy_snapshot;pause=True", "def delayed(self,check_database=True):", " global pause",
    " if pause:pause=False;time.sleep(35)", " return original(self,check_database)", "m.Inventory.legacy_snapshot=delayed", "m.main()"].join("\n");
  const code = ["import child from 'node:child_process';", "import {syncBuiltinESMExports} from 'node:module';", "import {dirname} from 'node:path';",
    "import {pathToFileURL} from 'node:url';", "const original=child.spawn;let started=0,closed=0;const owned=[];",
    "child.spawn=(binary,args,options)=>{if(binary==='python'&&args[1]?.endsWith('negi_master_conversation_inventory.py')){",
    "const helper=original(binary,['-B','-c'," + JSON.stringify(slow) + ",dirname(args[1])],options);started++;owned.push(helper);helper.once('close',()=>closed++);return helper;}return original(binary,args,options);};",
    "syncBuiltinESMExports();let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);",
    "const {MasterConversationInventory}=await import(pathToFileURL(input.module).href);",
    "const timer=setTimeout(()=>{for(const helper of owned)helper.kill();},75000);",
    "try{const at=Date.now();const result=await new MasterConversationInventory({root:input.root,masterId:'master'}).migrateLegacy(input.request);",
    "if(Date.now()-at<35000||started!==1||closed!==1)throw Error('helper did not complete its delayed execution');console.log(JSON.stringify(result));}",
    "finally{clearTimeout(timer);child.spawn=original;syncBuiltinESMExports();}"].join("\n");
  const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";processChild.stdout.on("data", bytes => { stdout += bytes; });processChild.stderr.on("data", bytes => { stderr += bytes; });
  const closed = new Promise<number | null>((accept, reject) => { processChild.once("close", accept);processChild.once("error", reject); });
  const input = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
  processChild.stdin.end(JSON.stringify({ root: f.root, module: resolve("src/server/orchestration/masterConversationInventory.ts"), request: input }));
  try { assert.equal(await closed, 0, stderr);assert.deepEqual(JSON.parse(stdout), { ...preview, decisionId: input.decisionId }); }
  finally { processChild.kill();await closed; }
  assert.equal((await f.inventory.audit()).state, "clean");
}));

test("v1 databases remain readable/appendable without silent upgrade and cannot be overwritten by adoption", async () => fixture(async f => {
  await f.inventory.initialize();
  const converted = await python(imported + "import sqlite3\nc=sqlite3.connect(i.db);c.executescript('DROP TABLE adoptions; PRAGMA user_version=1;');c.close()\nprint('v1 fixture')", { root: f.root });
  assert.equal(converted.code, 0, converted.stderr);
  const db = await readFile(f.inventory.databasePath);assert.equal((await f.inventory.audit()).artifactCount, 0);
  await assert.rejects(f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: "a".repeat(64) }), /no accepted legacy adoption/);
  assert.deepEqual(await readFile(f.inventory.databasePath), db);
  const request: MasterConversationRequest = { requestId: randomUUID(), masterId: "master", mode: "start", oldThreadId: null, cwd: f.cwd, model: "fixture", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
  const raw = signedMasterOwner({ schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(), masterId: "master", kind: "thread-start", cwdSha256: hash(f.cwd),
    operation: { domain: "master-conversation", requestId: request.requestId, hash: hash(JSON.stringify(request) + "\n") }, evidenceSha256: "b".repeat(64), processIdentity: await f.inventory.currentProcessIdentity() }, f.key);
  await writeFile(join(f.root, "masters", "master", "owner.lock"), raw);
  const bytes = signed({ schemaVersion: "negi-master-conversation/1", request, stage: "requested", previousSha256: null, identity: null, reason: null, at: "2026-10-02T00:00:00.000Z" }, f.key), relativePath = request.requestId + "/00-requested.json";
  await f.inventory.appendStageIntent({ expectedHead: (await f.inventory.audit()).head, ownerSha256: hash(raw), relativePath, bytes });
  await mkdir(join(f.root, "masters", "master", request.requestId));await writeFile(join(f.root, "masters", "master", relativePath), bytes);await unlink(join(f.root, "masters", "master", "owner.lock"));
  assert.equal((await f.inventory.audit()).artifactCount, 1);
  const checked = await python(imported + "import sqlite3\nc=sqlite3.connect(i.db.as_uri()+'?mode=ro',uri=True)\nassert c.execute('PRAGMA user_version').fetchone()==(1,)\nassert m.schema_objects(c)==m.expected_schema(1)\nc.close()\nprint('v1 preserved after append')", { root: f.root });
  assert.equal(checked.code, 0, checked.stderr);assert.equal(checked.stdout.trim(), "v1 preserved after append");
}));

test("concurrent different migration decisions accept once and a waiting caller freezes its approved input", async () => fixture(async f => {
  await f.operation("master", completed);const preview = await f.inventory.previewLegacyMigration();
  const first = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }, second = { ...first, decisionId: randomUUID() };
  const results = await Promise.allSettled([f.inventory.migrateLegacy(first), f.inventory.migrateLegacy(second)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const accepted = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<MasterConversationInventory["migrateLegacy"]>>>).value;
  const input = { decisionId: accepted.decisionId, expectedProofSha256: accepted.proofSha256 };
  let pending: ReturnType<MasterConversationInventory["migrateLegacy"]>;
  await withMasterStorageGuard(f.root, async () => { pending = f.inventory.migrateLegacy(input);input.decisionId = randomUUID();input.expectedProofSha256 = "f".repeat(64);await pending; });
  assert.deepEqual(await pending!, accepted);
}));


test("receipt adoption preserves the full independent stage budget through the next exact-owner append", async () => fixture(async f => {
  const history = await f.operation("master", completed.slice(0, 4));await f.receipt("master", 2);await f.receipt("master", 2);
  const preview = await f.inventory.previewLegacyMigration(), before = await source(f.root);
  const budgets = "m.MAX_STAGE_EVENTS=5;m.MAX_TOTAL_STAGE_EVENTS=5;m.MAX_RECEIPTS=2;m.MAX_TOTAL_RECEIPTS=2;m.MAX_EVENTS=7;m.MAX_TOTAL_EVENTS=7\n";
  const result = await python(imported + budgets + "i.migrate(r['request']);assert i.audit()['artifactCount']==6\n", {
    root: f.root, request: { action: "migrate", root: f.root, masterId: "master", decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 },
  });
  assert.equal(result.code, 0, result.stderr);assert.deepEqual(await source(f.root), before);
  const raw = signedMasterOwner({ schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(), masterId: "master", kind: "thread-start",
    cwdSha256: hash(f.cwd), operation: { domain: "master-conversation", requestId: history.request.requestId, hash: hash(JSON.stringify(history.request) + "\n") },
    evidenceSha256: "b".repeat(64), processIdentity: await f.inventory.currentProcessIdentity() }, f.key);
  await writeFile(join(f.root, "masters", "master", "owner.lock"), raw);
  const record = { relativePath: history.request.requestId + "/04-completed.json", bytes: signed({ schemaVersion: "negi-master-conversation/1", request: history.request, stage: "completed",
    previousSha256: hash(history.records.at(-1)!.bytes), identity: thread, reason: null, at: "2026-10-02T00:00:00.000Z" }, f.key) };
  const request = { action: "append", root: f.root, masterId: "master", expectedHead: (await f.inventory.audit()).head, ownerSha256: hash(raw), ...record };
  const appended = await python(imported + budgets + "assert i.append(r['request'])['head']['seq']==7\n", { root: f.root, request });
  assert.equal(appended.code, 0, appended.stderr);await writeFile(join(f.root, "masters", "master", record.relativePath), record.bytes);
  const audited = await python(imported + budgets + "assert i.audit()['artifactCount']==7;print('all stages and receipts retained')\n", { root: f.root });
  assert.equal(audited.code, 0, audited.stderr);
  const { signature: _signature, ...previousOwner } = JSON.parse(raw);
  const next = { ...history.request, requestId: randomUUID() }, nextRaw = signedMasterOwner({ ...previousOwner, operation: { domain: "master-conversation", requestId: next.requestId, hash: hash(JSON.stringify(next) + "\n") } }, f.key);
  await writeFile(join(f.root, "masters", "master", "owner.lock"), nextRaw);
  const full = await f.inventory.audit(), db = await readFile(f.inventory.databasePath);
  const held = await python(imported + budgets + "m.MAX_EVENTS=10;m.MAX_TOTAL_EVENTS=10\ntry:i.append(r['request']);raise AssertionError('extra stage accepted')\nexcept ValueError as error:assert 'stage capacity' in str(error)\n", {
    root: f.root, request: { action: "append", root: f.root, masterId: "master", expectedHead: full.head, ownerSha256: hash(nextRaw), relativePath: next.requestId + "/00-requested.json",
      bytes: signed({ schemaVersion: "negi-master-conversation/1", request: next, stage: "requested", previousSha256: null, identity: null, reason: null, at: "2026-10-02T00:00:00.000Z" }, f.key) },
  });
  assert.equal(held.code, 0, held.stderr);assert.deepEqual(await readFile(f.inventory.databasePath), db);
}));

test("migration checks per-Master and global stage/receipt budgets independently before database creation", async () => {
  for (const kind of ["master-stage", "global-stage", "master-receipt", "global-receipt"]) await fixture(async f => {
    await f.operation("master", completed);await f.receipt("master", 2);
    if (kind === "global-stage") await f.operation("other", ["requested"]);
    if (kind === "master-receipt") await f.receipt("master", 2);
    if (kind === "global-receipt") await f.receipt("other", 2);
    const limits = { "master-stage": "m.MAX_STAGE_EVENTS=4", "global-stage": "m.MAX_TOTAL_STAGE_EVENTS=5",
      "master-receipt": "m.MAX_RECEIPTS=1", "global-receipt": "m.MAX_TOTAL_RECEIPTS=1" };
    const preview = await f.inventory.previewLegacyMigration(), before = await source(f.root);
    const result = await python(imported + limits[kind as keyof typeof limits] + "\ntry:i.migrate(r['request']);raise AssertionError('capacity accepted')\nexcept ValueError as error:assert 'capacity' in str(error)\n", {
      root: f.root, request: { action: "migrate", root: f.root, masterId: "master", decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 },
    });
    assert.equal(result.code, 0, result.stderr);assert.deepEqual(await source(f.root), before);await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
  });
});

test("another Master's unsigned path column cannot disguise stages as receipts for global capacity", async () => fixture(async f => {
  const history = await f.operation("master", ["requested", "cancelled"]), other = await f.operation("other", ["requested"]);
  const preview = await f.inventory.previewLegacyMigration();
  await f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
  // Add one ordinary stage after the three-stage adoption. Its capacity cannot
  // be checked just by the immutable adoption's original stageCount summary.
  const otherIndex = new MasterConversationInventory({ root: f.root, masterId: "other" });
  const otherOwner = signedMasterOwner({ schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(), masterId: "other", kind: "thread-start",
    cwdSha256: hash(f.cwd), operation: { domain: "master-conversation", requestId: other.request.requestId, hash: hash(JSON.stringify(other.request) + "\n") },
    evidenceSha256: "b".repeat(64), processIdentity: await f.inventory.currentProcessIdentity() }, f.key);
  await writeFile(join(f.root, "masters", "other", "owner.lock"), otherOwner);
  const cancelled = { relativePath: other.request.requestId + "/01-cancelled.json", bytes: signed({ schemaVersion: "negi-master-conversation/1", request: other.request, stage: "cancelled",
    previousSha256: hash(other.records[0]!.bytes), identity: null, reason: null, at: "2026-10-02T00:00:00.000Z" }, f.key) };
  await otherIndex.appendStageIntent({ ...cancelled, expectedHead: (await otherIndex.audit()).head, ownerSha256: hash(otherOwner) });
  await writeFile(join(f.root, "masters", "other", cancelled.relativePath), cancelled.bytes);await unlink(join(f.root, "masters", "other", "owner.lock"));
  const changed = await python(imported + "import sqlite3\nc=sqlite3.connect(i.db);c.execute('UPDATE events SET path=? WHERE master_id=? AND path=?',(r['changed'],'other',r['original']));c.commit();c.close()\n", {
    root: f.root, changed: "recoveries/" + randomUUID() + ".json", original: other.records[0]!.relativePath,
  });
  assert.equal(changed.code, 0, changed.stderr);
  const audit = await python(imported + "m.MAX_TOTAL_STAGE_EVENTS=3\ntry:i.audit();raise AssertionError('unsigned path reduced stage usage')\nexcept ValueError as error:assert 'global event capacity' in str(error)\n", { root: f.root });
  assert.equal(audit.code, 0, audit.stderr);
  const request = { ...history.request, requestId: randomUUID() }, raw = signedMasterOwner({ schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(), masterId: "master", kind: "thread-start",
    cwdSha256: hash(f.cwd), operation: { domain: "master-conversation", requestId: request.requestId, hash: hash(JSON.stringify(request) + "\n") },
    evidenceSha256: "b".repeat(64), processIdentity: await f.inventory.currentProcessIdentity() }, f.key);
  await writeFile(join(f.root, "masters", "master", "owner.lock"), raw);
  const before = await source(f.root), db = await readFile(f.inventory.databasePath);
  const held = await python(imported + "m.MAX_TOTAL_STAGE_EVENTS=4\ntry:i.append(r['request']);raise AssertionError('extra stage accepted')\nexcept ValueError as error:assert 'stage capacity' in str(error)\n", {
    root: f.root, request: { action: "append", root: f.root, masterId: "master", expectedHead: (await f.inventory.audit()).head, ownerSha256: hash(raw), relativePath: request.requestId + "/00-requested.json",
      bytes: signed({ schemaVersion: "negi-master-conversation/1", request, stage: "requested", previousSha256: null, identity: null, reason: null, at: "2026-10-02T00:00:00.000Z" }, f.key) },
  });
  assert.equal(held.code, 0, held.stderr);assert.deepEqual(await source(f.root), before);assert.deepEqual(await readFile(f.inventory.databasePath), db);
  await assert.rejects(new MasterConversationInventory({ root: f.root, masterId: "other" }).audit(), /event identity\/predecessor/);
}));

test("migration global event and physical DB capacities preserve sources and never silently truncate", async () => {
  for (const kind of ["events", "database"]) await fixture(async f => {
    await f.operation("master", completed);const preview = await f.inventory.previewLegacyMigration(), before = await source(f.root);
    const code = imported + (kind === "events" ? "m.MAX_TOTAL_EVENTS=4\n" : "m.MAX_DATABASE_BYTES=8192\n") +
      "try:i.migrate(r['request']);raise AssertionError('capacity accepted')\nexcept ValueError as error:assert 'capacity' in str(error)\nprint('capacity held')";
    const result = await python(code, { root: f.root, request: { action: "migrate", root: f.root, masterId: "master", decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 } });
    assert.equal(result.code, 0, result.stderr);assert.deepEqual(await source(f.root), before);
    if (kind === "events") await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
    else { assert.ok((await lstat(f.inventory.databasePath)).isFile());await assert.rejects(f.inventory.previewLegacyMigration(), /existing database/); }
  });
});

test("modified adoption authentication and a missing original receipt are held without DB repair", async () => {
  for (const kind of ["adoption-HMAC", "missing-receipt"]) await fixture(async f => {
    await f.operation("master", completed);const receipt = await f.receipt("master", 2), preview = await f.inventory.previewLegacyMigration();
    await f.inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
    if (kind === "adoption-HMAC") {
      const result = await python(imported + "import sqlite3\nc=sqlite3.connect(i.db);c.execute(\"UPDATE adoptions SET signature=?\",('f'*64,));c.commit();c.close()", { root: f.root });assert.equal(result.code, 0, result.stderr);
      const db = await readFile(f.inventory.databasePath);await assert.rejects(f.inventory.audit(), /adoption HMAC/);assert.deepEqual(await readFile(f.inventory.databasePath), db);
    } else {
      await unlink(join(f.root, "masters", "master", receipt.relativePath));const audit = await f.inventory.audit();
      assert.equal(audit.state, "pending");assert.deepEqual(audit.missing, [receipt.relativePath]);assert.equal((await f.inventory.lookup(receipt.relativePath)).bytes, receipt.bytes);
      await assert.rejects(f.inventory.appendStageIntent({ expectedHead: audit.head, ownerSha256: "a".repeat(64), relativePath: receipt.relativePath, bytes: receipt.bytes }), /stage intent input/);
      await assert.rejects(lstat(join(f.root, "masters", "master", receipt.relativePath)), { code: "ENOENT" });
    }
  });
});
