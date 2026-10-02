import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { MasterConversationInventory, type MasterInventoryHead } from "../src/server/orchestration/masterConversationInventory.ts";
import type { MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";

const exec = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const zero = () => ({ seq: 0, sha256: "0".repeat(64) });
const script = resolve("scripts/negi_master_conversation_inventory.py");
interface Fixture {
  dir: string; root: string; master: string; cwd: string; key: Buffer;
  inventory: MasterConversationInventory; request: MasterConversationRequest;
  owner: (request?: MasterConversationRequest, pid?: number) => Promise<string>;
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-inventory-"));
  const root = join(dir, "authority"), master = join(root, "masters", "master"), cwd = join(dir, "checkout"), key = randomBytes(32);
  await mkdir(master, { recursive: true }); await mkdir(cwd);
  await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: key.toString("hex") }) + "\n");
  const request: MasterConversationRequest = { requestId: randomUUID(), masterId: "master", mode: "rotate", oldThreadId: "old",
    cwd, model: "fixture-astra", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
  const f: Fixture = { dir, root, master, cwd, key, request, inventory: new MasterConversationInventory({ root, masterId: "master" }),
    owner: async (r = request, pid = process.pid) => {
      const payload = { schema: "negi-master-conversation-owner/3", pid, owner: randomUUID(), createdAt: new Date().toISOString(),
        masterId: "master", kind: "thread-start", cwdSha256: hash(r.cwd), operation: { domain: "master-conversation", requestId: r.requestId,
          hash: hash(JSON.stringify(r) + "\n") }, evidenceSha256: "b".repeat(64), processIdentity: await f.inventory.currentProcessIdentity() };
      const bytes = JSON.stringify({ ...payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
      await writeFile(join(master, "owner.lock"), bytes); return hash(bytes);
    } };
  try { await run(f); } finally { await rm(dir, { recursive: true, force: true }); }
}
const thread = { threadId: "new", requestedModel: "fixture-astra", resolvedModel: "fixture-astra", modelProvider: "fixture", rerouted: false };
function stage(f: Fixture, index: number, name: string, previous: string | null, request = f.request, identity: typeof thread | null = null, reason: string | null = null) {
  const payload = { schemaVersion: "negi-master-conversation/1", request, stage: name, previousSha256: previous ? hash(previous) : null,
    identity, reason, at: new Date().toISOString() };
  const bytes = JSON.stringify({ payload, signature: createHmac("sha256", f.key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
  return { bytes, relativePath: `${request.requestId}/0${index}-${name}.json` };
}
async function materialize(f: Fixture, record: { relativePath: string; bytes: string }) {
  const path = join(f.master, record.relativePath); await mkdir(dirname(path), { recursive: true }); await writeFile(path, record.bytes, { flag: "wx" });
}
async function completed(f: Fixture) {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(); let head: MasterInventoryHead = zero(), previous: string | null = null;
  const records = [];
  for (const [index, name] of ["requested", "old_idle", "start_dispatched", "bound", "completed"].entries()) {
    const record = stage(f, index, name, previous, f.request, index >= 3 ? thread : null);
    head = (await f.inventory.appendStageIntent({ ...record, ownerSha256, expectedHead: head })).head;
    await materialize(f, record); records.push(record); previous = record.bytes;
  }
  await unlink(join(f.master, "owner.lock")); return { head, records };
}
async function sql(f: Fixture, mutation: string) {
  // Fixed test SQL through stdin; no shell, HMAC key or journal text in argv.
  await new Promise<void>((accept, reject) => {
    const child = spawn("python", ["-B", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.stdin.read()); c.close()", f.inventory.databasePath], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", bytes => { error += bytes; }); child.on("error", reject);
    child.on("close", code => code === 0 ? accept() : reject(Error(error))); child.stdin.end(mutation);
  });
}
async function pythonInput(args: string[], value: unknown): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn("python", ["-B", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", reject); child.on("close", code => code === 0 ? accept(stdout) : reject(Error(stderr)));
    child.stdin.end(JSON.stringify(value));
  });
}

test("read-only missing inventory creates nothing; explicit bootstrap is create-only", async () => fixture(async f => {
  const before = await readdir(f.dir); await assert.rejects(f.inventory.audit());
  assert.deepEqual(await readdir(f.dir), before); assert.deepEqual(await readdir(f.master), []);
  await f.inventory.initialize(); assert.deepEqual(await f.inventory.audit(), { head: zero(), state: "clean", artifactCount: 0, missing: [] });
  const bytes = await readFile(f.inventory.databasePath); await assert.rejects(f.inventory.initialize(), /never be replaced/);
  assert.deepEqual(await readFile(f.inventory.databasePath), bytes);
}));

test("populated historical authority cannot be silently initialized or adopted", async () => fixture(async f => {
  const record = stage(f, 0, "requested", null); await materialize(f, record);
  await assert.rejects(f.inventory.initialize(), /empty master/);
  assert.equal(await readFile(join(f.master, record.relativePath), "utf8"), record.bytes);
  assert.equal((await readdir(f.dir)).includes("authority.inventory.sqlite3"), false);
}));

test("surviving sibling inventory cannot recreate a deleted authority or key", async () => fixture(async f => {
  await f.inventory.initialize(); const db = await readFile(f.inventory.databasePath);
  await rename(f.root, join(f.dir, "saved-authority")); await assert.rejects(f.inventory.audit()); await assert.rejects(f.inventory.initialize());
  assert.deepEqual(await readFile(f.inventory.databasePath), db); assert.equal((await readdir(f.dir)).includes("authority"), false);
}));

test("replacement key and whole master directory deletion/recreation are detected", async () => fixture(async f => {
  await f.inventory.initialize(); const keyPath = join(f.root, "signing-key.json"), old = await readFile(keyPath);
  await writeFile(keyPath, JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: "c".repeat(64) }) + "\n");
  await assert.rejects(f.inventory.audit(), /metadata mismatch/); await writeFile(keyPath, old);
  await rename(f.master, join(f.dir, "saved-master")); await assert.rejects(f.inventory.audit(), /registry differs/);
  await mkdir(f.master); await assert.rejects(f.inventory.audit(), /identity\/checkpoint/);
}));

test("intent and signed head commit before mkdir; gap is inspectable and blocks the next append", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), first = stage(f, 0, "requested", null);
  const intent = await f.inventory.appendStageIntent({ ...first, ownerSha256, expectedHead: zero() });
  assert.deepEqual(await readdir(f.master), ["owner.lock"]);
  const before = await readFile(f.inventory.databasePath), audit = await f.inventory.audit();
  assert.equal(audit.state, "pending"); assert.deepEqual(audit.missing, [first.relativePath]); assert.deepEqual(audit.head, intent.head);
  const known = await f.inventory.lookup(first.relativePath); assert.equal(known.bytes, first.bytes);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 1, "cancelled", first.bytes), ownerSha256, expectedHead: intent.head }), /not materialized/);
  assert.deepEqual(await readFile(f.inventory.databasePath), before); assert.deepEqual(await readdir(f.master), ["owner.lock"]);
  await materialize(f, first); assert.equal((await f.inventory.audit()).state, "clean");
}));

test("partial existing stage is held without overwriting it or appending a cancellation", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), first = stage(f, 0, "requested", null);
  const { head } = await f.inventory.appendStageIntent({ ...first, ownerSha256, expectedHead: zero() });
  await materialize(f, { ...first, bytes: first.bytes.slice(0, 100) }); const db = await readFile(f.inventory.databasePath);
  await assert.rejects(f.inventory.audit(), /changed or partial/); await assert.rejects(f.inventory.lookup(first.relativePath), /changed or partial/);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 1, "cancelled", first.bytes), ownerSha256, expectedHead: head }));
  assert.equal(await readFile(join(f.master, first.relativePath), "utf8"), first.bytes.slice(0, 100)); assert.deepEqual(await readFile(f.inventory.databasePath), db);
}));

test("stage suffix rollback and whole operation deletion remain visible at the retained head", async () => fixture(async f => {
  const { head, records } = await completed(f), final = records[4]!;
  await unlink(join(f.master, final.relativePath)); let audit = await f.inventory.audit();
  assert.deepEqual(audit.head, head); assert.deepEqual(audit.missing, [final.relativePath]);
  assert.equal((await f.inventory.lookup(final.relativePath)).bytes, final.bytes);
  await rm(join(f.master, f.request.requestId), { recursive: true }); audit = await f.inventory.audit();
  assert.deepEqual(audit.head, head); assert.equal(audit.missing.length, 5); assert.deepEqual(await readdir(f.master), []);
}));

test("deleting SQLite suffix without changing its signed checkpoint is detected", async () => fixture(async f => {
  await completed(f); await sql(f, "DELETE FROM events WHERE seq=5;"); await assert.rejects(f.inventory.audit(), /rows differ|tail differs/);
}));

test("rewriting head sequence and hash without its HMAC cannot hide rollback", async () => fixture(async f => {
  await completed(f); await sql(f, "DELETE FROM events WHERE seq=5; UPDATE masters SET seq=4,last_sha=(SELECT entry_sha FROM events WHERE seq=4);");
  await assert.rejects(f.inventory.audit(), /checkpoint signature/);
}));

test("changed indexed artifact bytes and changed event bytes fail verification", async () => fixture(async f => {
  await completed(f); await sql(f, "UPDATE events SET artifact=CAST('changed' AS BLOB) WHERE seq=1;");
  await assert.rejects(f.inventory.audit());
}));

test("unexpected SQLite schema and application version require explicit migration", async () => fixture(async f => {
  await f.inventory.initialize(); await sql(f, "CREATE TABLE surprise (value TEXT);"); await assert.rejects(f.inventory.audit(), /unexpected database schema/);
  await sql(f, "DROP TABLE surprise; PRAGMA user_version=2;"); await assert.rejects(f.inventory.audit(), /version\/application/);
}));

test("read-only audit refuses every journal sidecar without recovery or mutation", async () => fixture(async f => {
  await f.inventory.initialize(); const before = await readFile(f.inventory.databasePath);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const path = f.inventory.databasePath + suffix; await writeFile(path, "uncertain");
    await assert.rejects(f.inventory.audit(), /explicit reconciliation/); assert.equal(await readFile(path, "utf8"), "uncertain");
    assert.deepEqual(await readFile(f.inventory.databasePath), before); await unlink(path);
  }
}));

test("unindexed files and empty operation directories are held", async () => fixture(async f => {
  await f.inventory.initialize(); const path = join(f.master, f.request.requestId); await mkdir(path);
  await assert.rejects(f.inventory.audit(), /unindexed operation/); await rm(path, { recursive: true });
  await writeFile(join(f.master, "extra.json"), "{}\n"); await assert.rejects(f.inventory.audit(), /unindexed operation/);
}));

test("receipts remain an explicit unintegrated gate and are never deleted by inventory", async () => fixture(async f => {
  await f.inventory.initialize(); const receipts = join(f.master, "recoveries"); await mkdir(receipts);
  assert.equal((await f.inventory.audit()).state, "clean"); await writeFile(join(receipts, randomUUID() + ".json"), "saved\n");
  await assert.rejects(f.inventory.audit(), /receipt indexing is not integrated/); assert.equal((await readdir(receipts)).length, 1);
}));

test("wrong owner SHA, changed signed owner and wrong operation bind no intent", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), first = stage(f, 0, "requested", null);
  await assert.rejects(f.inventory.appendStageIntent({ ...first, ownerSha256: "d".repeat(64), expectedHead: zero() }), /owner bytes changed/);
  await f.owner({ ...f.request, requestId: randomUUID() }); await assert.rejects(f.inventory.appendStageIntent({ ...first, ownerSha256, expectedHead: zero() }), /owner bytes changed/);
  const wrongOperation = hash(await readFile(join(f.master, "owner.lock")));
  await assert.rejects(f.inventory.appendStageIntent({ ...first, ownerSha256: wrongOperation, expectedHead: zero() }), /owner\/request binding/);
  assert.equal((await f.inventory.audit()).artifactCount, 0);
}));

test("dead owner markers cannot append even when the HMAC and request match", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(undefined, 0x7fffffff);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 0, "requested", null), ownerSha256, expectedHead: zero() }), /process creation token/);
  assert.equal((await f.inventory.audit()).artifactCount, 0);
}));

test("reused live PID with a different signed creation token cannot append", async () => fixture(async f => {
  await f.inventory.initialize(); await f.owner();
  const ownerPath = join(f.master, "owner.lock"), owner = JSON.parse(await readFile(ownerPath, "utf8"));
  const { signature: _old, ...payload } = owner;
  payload.processIdentity.startToken = payload.processIdentity.platform === "windows" ? "1" : "00000000-0000-0000-0000-000000000000:1";
  const bytes = JSON.stringify({ ...payload, signature: createHmac("sha256", f.key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
  await writeFile(ownerPath, bytes); const before = await readFile(f.inventory.databasePath);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 0, "requested", null), ownerSha256: hash(bytes), expectedHead: zero() }), /process creation token/);
  assert.deepEqual(await readFile(f.inventory.databasePath), before); assert.equal(await readFile(ownerPath, "utf8"), bytes);
}));

test("caller mutation during helper execution cannot change the committed frozen intent", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), first = stage(f, 0, "requested", null);
  const input = { ...first, ownerSha256, expectedHead: zero() }, pending = f.inventory.appendStageIntent(input);
  input.bytes = "changed"; input.relativePath = "../changed"; input.expectedHead.seq = 99; input.ownerSha256 = "f".repeat(64);
  const result = await pending; assert.equal(result.head.seq, 1); assert.equal(result.relativePath, first.relativePath);
  assert.equal((await f.inventory.lookup(first.relativePath)).bytes, first.bytes);
}));

test("foreign-key-disabled orphan event is detected before another master is registered", async () => fixture(async f => {
  await f.inventory.initialize();
  await sql(f, "PRAGMA foreign_keys=OFF; INSERT INTO events VALUES ('orphan',1,'x',CAST('{}' AS BLOB),CAST('{}' AS BLOB),'bad','bad');");
  await assert.rejects(f.inventory.audit(), /orphan inventory event/);
  await mkdir(join(f.root, "masters", "other")); const other = new MasterConversationInventory({ root: f.root, masterId: "other" });
  await assert.rejects(other.registerEmptyMaster(), /orphan inventory event/);
}));

test("separate global capacity is enforced across two Masters before an extra stage commits", async () => fixture(async f => {
  await mkdir(join(f.root, "masters", "other")); await f.inventory.initialize();
  const builder = resolve("test/helpers/masterConversationInventoryFixture.py");
  for (const masterId of ["master", "other"]) await pythonInput([builder], { root: f.root, masterId, count: 1 });
  const limit = "import sys,json; sys.path.insert(0,sys.argv[1]); import negi_master_conversation_inventory as m; m.MAX_TOTAL_EVENTS=10; r=json.load(sys.stdin); i=m.Inventory(r['root'],r['masterId']); print(json.dumps(i.audit() if r['action']=='audit' else i.append(r)))";
  for (const masterId of ["master", "other"]) {
    const result = JSON.parse(await pythonInput(["-c", limit, dirname(script)], { action: "audit", root: f.root, masterId }));
    assert.equal(result.state, "clean"); assert.equal(result.artifactCount, 5);
  }
  const ownerSha256 = await f.owner(), record = stage(f, 0, "requested", null), before = await readFile(f.inventory.databasePath), expectedHead = (await f.inventory.audit()).head;
  await assert.rejects(pythonInput(["-c", limit, dirname(script)], { action: "append", root: f.root, masterId: "master", expectedHead, ownerSha256, ...record }), /global event capacity/);
  assert.deepEqual(await readFile(f.inventory.databasePath), before); assert.equal((await f.inventory.audit()).artifactCount, 5);
}));

test("constructor registration is frozen against caller mutation", async () => fixture(async f => {
  const options = { root: f.root, masterId: "master" }, inventory = new MasterConversationInventory(options);
  options.root = join(f.dir, "different"); options.masterId = "other";
  await inventory.initialize(); assert.equal((await inventory.audit()).state, "clean"); assert.equal(inventory.databasePath, f.root + ".inventory.sqlite3");
}));

test("extra event under another registered Master holds audit, append and new registration", async () => fixture(async f => {
  await mkdir(join(f.root, "masters", "other")); await f.inventory.initialize();
  await sql(f, "INSERT INTO events VALUES ('other',1,'x',CAST('{}' AS BLOB),CAST('{}' AS BLOB),'bad','bad');");
  await assert.rejects(f.inventory.audit(), /global event rows/);
  const ownerSha256 = await f.owner(); await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 0, "requested", null), ownerSha256, expectedHead: zero() }), /global event rows/);
  await mkdir(join(f.root, "masters", "third")); const third = new MasterConversationInventory({ root: f.root, masterId: "third" });
  await assert.rejects(third.registerEmptyMaster(), /global event rows/); assert.equal((await readdir(f.master)).includes(f.request.requestId), false);
}));

test("legacy owner version is held for explicit migration, never promoted to append authority", async () => fixture(async f => {
  await f.inventory.initialize(); await f.owner(); const ownerPath = join(f.master, "owner.lock");
  const owner = JSON.parse(await readFile(ownerPath, "utf8")), { signature: _old, processIdentity: _token, ...payload } = owner;
  payload.schema = "negi-master-conversation-owner/2";
  const bytes = JSON.stringify({ ...payload, signature: createHmac("sha256", f.key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
  await writeFile(ownerPath, bytes); await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 0, "requested", null), ownerSha256: hash(bytes), expectedHead: zero() }), /owner shape/);
  assert.equal(await readFile(ownerPath, "utf8"), bytes); assert.equal((await f.inventory.audit()).artifactCount, 0);
}));

test("concurrent same-head appends produce at most one intent without replay", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), record = stage(f, 0, "requested", null);
  const outcomes = await Promise.allSettled([0, 1].map(() => f.inventory.appendStageIntent({ ...record, ownerSha256, expectedHead: zero() })));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await f.inventory.audit()).artifactCount, 1); assert.deepEqual(await readdir(f.master), ["owner.lock"]);
}));

test("stale checkpoint, invalid predecessor and changed pinned request leave the DB unchanged", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), first = stage(f, 0, "requested", null);
  const { head } = await f.inventory.appendStageIntent({ ...first, ownerSha256, expectedHead: zero() }); await materialize(f, first);
  const before = await readFile(f.inventory.databasePath);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 1, "old_idle", first.bytes), ownerSha256, expectedHead: zero() }), /stale checkpoint/);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 1, "bound", first.bytes, f.request, thread), ownerSha256, expectedHead: head }), /transition/);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 1, "old_idle", first.bytes, { ...f.request, model: "changed" }), ownerSha256, expectedHead: head }), /owner\/request binding/);
  assert.deepEqual(await readFile(f.inventory.databasePath), before);
}));

test("unknown operation prevents a different owner's operation; its known bytes stay inspectable", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), first = stage(f, 0, "requested", null);
  const { head } = await f.inventory.appendStageIntent({ ...first, ownerSha256, expectedHead: zero() }); await materialize(f, first);
  const next = { ...f.request, requestId: randomUUID() }, nextOwner = await f.owner(next);
  await assert.rejects(f.inventory.appendStageIntent({ ...stage(f, 0, "requested", null, next), ownerSha256: nextOwner, expectedHead: head }), /another operation/);
  assert.equal((await f.inventory.lookup(first.relativePath)).bytes, first.bytes);
}));

test("Unicode stage payload beyond Windows argv size uses bounded stdin", async () => fixture(async f => {
  await f.inventory.initialize(); const request = { ...f.request, cwd: f.cwd + "/" + "日".repeat(6500) };
  const ownerSha256 = await f.owner(request), record = stage(f, 0, "requested", null, request);
  assert.ok(Buffer.byteLength(record.bytes) > 19000 && Buffer.byteLength(record.bytes) < 24000);
  await f.inventory.appendStageIntent({ ...record, ownerSha256, expectedHead: zero() });
  assert.equal((await f.inventory.lookup(record.relativePath)).bytes, record.bytes);
}));

test("hardlinked database and stage files are rejected", async () => fixture(async f => {
  await f.inventory.initialize(); const dbCopy = join(f.dir, "db-link"); await link(f.inventory.databasePath, dbCopy);
  await assert.rejects(f.inventory.audit(), /hardlinked/); await unlink(dbCopy);
  const ownerSha256 = await f.owner(), record = stage(f, 0, "requested", null);
  await f.inventory.appendStageIntent({ ...record, ownerSha256, expectedHead: zero() }); await materialize(f, record);
  await link(join(f.master, record.relativePath), join(f.dir, "artifact-link")); await assert.rejects(f.inventory.audit(), /hardlinked/);
}));

test("new master registration is explicit, empty and pins its directory", async () => fixture(async f => {
  await f.inventory.initialize(); const otherPath = join(f.root, "masters", "other"); await mkdir(otherPath);
  await assert.rejects(f.inventory.audit(), /registry differs/);
  const other = new MasterConversationInventory({ root: f.root, masterId: "other" });
  await writeFile(join(otherPath, "legacy"), "keep"); await assert.rejects(other.registerEmptyMaster(), /empty master/);
  await unlink(join(otherPath, "legacy")); await other.registerEmptyMaster(); assert.equal((await other.audit()).state, "clean");
  assert.equal((await f.inventory.audit()).state, "clean"); await assert.rejects(other.registerEmptyMaster(), /registry differs/);
}));

test("path traversal and oversized input never reach the helper writer", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner();
  await assert.rejects(f.inventory.lookup("../outside"), /path invalid/);
  await assert.rejects(f.inventory.appendStageIntent({ expectedHead: zero(), ownerSha256, relativePath: `${f.request.requestId}/00-requested.json`, bytes: "x".repeat(24001) }), /input invalid/);
  assert.equal((await f.inventory.audit()).artifactCount, 0);
}));

test("actual child exit after committed intent leaves recoverable known bytes without creating a journal directory", async () => fixture(async f => {
  await f.inventory.initialize(); const ownerSha256 = await f.owner(), record = stage(f, 0, "requested", null);
  const request = { action: "append", root: f.root, masterId: "master", expectedHead: zero(), ownerSha256, ...record };
  const code = await new Promise<number | null>((accept, reject) => {
    const child = spawn("python", ["-B", "-c", "import sys,json,os; sys.path.insert(0,sys.argv[1]); from negi_master_conversation_inventory import Inventory; r=json.load(sys.stdin); Inventory(r['root'],r['masterId']).append(r); os._exit(23)", dirname(script)], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", data => { error += data; }); child.on("error", reject);
    child.on("close", result => error ? reject(Error(error)) : accept(result)); child.stdin.end(JSON.stringify(request));
  });
  assert.equal(code, 23); assert.equal((await f.inventory.audit()).state, "pending");
  assert.equal((await f.inventory.lookup(record.relativePath)).bytes, record.bytes); assert.deepEqual(await readdir(f.master), ["owner.lock"]);
}));

test("actual child exit inside a SQLite transaction leaves a hold; read-only audit does not recover its journal", async () => fixture(async f => {
  await f.inventory.initialize();
  await assert.rejects(exec("python", ["-B", "-c", "import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA synchronous=FULL'); c.execute('BEGIN IMMEDIATE'); c.execute('UPDATE masters SET seq=1'); os._exit(23)", f.inventory.databasePath], { windowsHide: true }));
  const journal = f.inventory.databasePath + "-journal", before = await readFile(journal), db = await readFile(f.inventory.databasePath);
  await assert.rejects(f.inventory.audit(), /explicit reconciliation/); assert.deepEqual(await readFile(journal), before);
  assert.deepEqual(await readFile(f.inventory.databasePath), db);
}));
