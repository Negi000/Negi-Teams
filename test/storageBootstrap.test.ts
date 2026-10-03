import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StorageBootstrap } from "../src/server/orchestration/storageBootstrap.ts";
import { LocalStorageConsole } from "../src/server/orchestration/storageConsole.ts";
import { createStorageHttp } from "../src/server/orchestration/storageHttp.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { MasterConversationAuthority } from "../src/server/orchestration/masterConversations.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const windows = { skip: process.platform !== "win32" };
type Registration = { root: string; turnRoot: string; schedulerPath: string; masterId: string };
async function fixture(run: (f: { dir: string; registration: Registration; console: LocalStorageConsole; bootstrap: StorageBootstrap; intent: string; fence: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-first-storage-")), state = join(dir, "state"), shared = join(dir, "shared");
  await mkdir(state);await mkdir(shared);
  const registration = { root: join(state, "master-conversations"), turnRoot: join(state, "master-turns"), schedulerPath: join(shared, "scheduler.jsonl"), masterId: "negi-master" };
  try { await run({ dir, registration, console: new LocalStorageConsole(registration, () => ({ maintenance: true, executionHeld: true, startupError: null })),
    bootstrap: new StorageBootstrap(registration), intent: registration.root + ".bootstrap-v1.json", fence: registration.schedulerPath + ".negi-storage-bootstrap.json" }); }
  finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));assert.match(basename(dir), /^negi-first-storage-/);
    await rm(dir, { recursive: true, force: true });
  }
}
async function snapshot(dir: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name), key = prefix + name, info = await lstat(path);
    if (info.isDirectory()) { result[key + "/"] = "directory";Object.assign(result, await snapshot(path, key + "/")); }
    else result[key] = (await readFile(path)).toString("hex");
  }
  return result;
}
async function crash(registration: Registration, decisionId: string, expectedProofSha256: string, point: string) {
  const script = `import sys,json,os
sys.path.insert(0,sys.argv[1])
import negi_storage_bootstrap as b
r=json.loads(sys.stdin.buffer.read());x=b.Bootstrap(r['registration']);point=sys.argv[2]
original_write=b.write_new;original_move=b.move
def write(path,data):
 original_write(path,data)
 if point=='pending' and path==x.pending:os._exit(23)
def move(source,target):
 original_move(source,target)
 if (point=='intent' and target==x.intent) or (point=='fence' and target==x.fence) or (point=='authority' and target==x.root) or (point=='turns' and target==x.turns):os._exit(23)
b.write_new=write;b.move=move
x.apply(r['decisionId'],r['expectedProofSha256'])
`;
  const child = spawn("python", ["-B", "-c", script, resolve("scripts"), point], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  let error = "";child.stderr!.on("data", bytes => { error += bytes; });
  child.stdin!.end(JSON.stringify({ registration, decisionId, expectedProofSha256 }));
  const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject);child.once("close", accept); });
  assert.equal(code, 23, error);
  await assert.rejects(lstat(registration.schedulerPath + ".lock"), { code: "ENOENT" });
}

test("initial status/preview are read-only and wrong proof, registration and normal-mode apply create nothing", windows, async () => fixture(async f => {
  const before = await snapshot(f.dir);
  assert.equal((await f.console.status()).bootstrap.state, "available");
  const preview = await f.console.preview("authority-initialize");assert.equal(preview.summary.masterCount, 1);
  assert.deepEqual(await snapshot(f.dir), before);
  await assert.rejects(f.console.apply({ ...preview.decision, proofSha256: "0".repeat(64) }));
  await assert.rejects(f.console.apply({ ...preview.decision, registrationSha256: "0".repeat(64) }));
  const normal = new LocalStorageConsole(f.registration, () => ({ maintenance: false, executionHeld: true, startupError: null }));
  await assert.rejects(normal.apply(preview.decision));assert.deepEqual(await snapshot(f.dir), before);
}));

test("authenticated first setup publishes the original native identity/key, holds default writers and acknowledges after indexed progress", windows, async () => fixture(async f => {
  await new FileScheduler(f.registration.schedulerPath).ensureSubscriptionConfiguration();
  const scheduler = await readFile(f.registration.schedulerPath), preview = await f.console.preview("authority-initialize");
  const handler = createStorageHttp(f.console, { token: "fixture-token" }, () => ({ maintenance: true, executionHeld: true, startupError: null }));
  const server = createServer((req, res) => { void handler(req, res, new URL(req.url!, "http://localhost")); });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await fetch(base + "/api/storage/apply", { method: "POST", headers: { cookie: "ebi_auth=fixture-token", origin: base, "content-type": "application/json" }, body: JSON.stringify({ decision: preview.decision, confirmed: true }) });
    assert.equal(result.status, 200);const row = await result.json();assert.equal(row.executionStarted, false);assert.equal(row.activation, "held");
  } finally { server.closeAllConnections();await new Promise<void>(accept => server.close(() => accept())); }
  const key = await readFile(join(f.registration.root, "signing-key.json"));
  assert.deepEqual(await readFile(f.intent), await readFile(f.fence));assert.deepEqual(await readdir(f.registration.turnRoot), []);
  assert.deepEqual(await readFile(f.registration.schedulerPath), scheduler);assert.equal((await f.bootstrap.status()).state, "ready");
  assert.deepEqual((await f.console.preview("authority-initialize")).decision, preview.decision);
  await assert.rejects(new FileScheduler(f.registration.schedulerPath).read());await assert.rejects(f.console.assertLegacyExecutionAllowed());
  await assert.rejects(f.console.apply({ ...preview.decision, decisionId: randomUUID() }));
  const stage = await f.console.preview("stage-adopt");await f.console.apply(stage.decision);
  const other = new RuntimeJournalInventory({ ...f.registration, schedulerPath: join(f.dir, "other-scheduler.jsonl") });
  await assert.rejects(other.previewBaseline());await assert.rejects(lstat(other.databasePath), { code: "ENOENT" });
  const runtime = await f.console.preview("runtime-adopt");await f.console.apply(runtime.decision);
  const inventory = new RuntimeJournalInventory(f.registration);
  await new FileScheduler(f.registration.schedulerPath, { journal: inventory.schedulerJournal() }).ensureSubscriptionConfiguration();
  const before = await snapshot(f.dir);await f.console.apply(preview.decision);assert.deepEqual(await snapshot(f.dir), before);
  assert.deepEqual(await readFile(join(f.registration.root, "signing-key.json")), key);assert.equal((await f.console.status()).stage.state, "clean");
  // Signed DB metadata remembers this bootstrap even if its receipt disappears.
  await rename(f.intent, f.intent + ".saved");
  await assert.rejects(new MasterConversationInventory({ root: f.registration.root, masterId: f.registration.masterId }).audit());
  await assert.rejects(inventory.audit());await assert.rejects(f.bootstrap.apply({ decisionId: randomUUID(), expectedProofSha256: preview.decision.proofSha256 }));
}));

for (const point of ["pending", "intent", "fence", "authority", "turns"]) {
  test(`actual process exit after ${point} retains the original ID and completes only its exact publication`, windows, async () => fixture(async f => {
    const preview = await f.bootstrap.preview();await crash(f.registration, preview.decisionId, preview.proofSha256, point);
    const retained = await f.bootstrap.preview();assert.deepEqual(retained, preview);
    const before = await snapshot(f.dir);
    await assert.rejects(f.bootstrap.apply({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }));assert.deepEqual(await snapshot(f.dir), before);
    await assert.rejects(new MasterConversationAuthority({ ...f.registration, scheduler: new FileScheduler(f.registration.schedulerPath) }).assertStorageCompatible());
    if (point === "authority") {
      await assert.rejects(f.console.preview("stage-adopt"));await assert.rejects(lstat(f.registration.root + ".inventory.sqlite3"), { code: "ENOENT" });
      await assert.rejects(f.console.preview("runtime-adopt"));await assert.rejects(lstat(f.registration.schedulerPath + ".negi-runtime.sqlite3"), { code: "ENOENT" });
    }
    const result = await f.bootstrap.apply({ decisionId: retained.decisionId, expectedProofSha256: retained.proofSha256 });assert.equal(result.initialized, true);
    assert.equal((await f.bootstrap.status()).state, "ready");const complete = await snapshot(f.dir);
    await f.bootstrap.apply({ decisionId: retained.decisionId, expectedProofSha256: retained.proofSha256 });assert.deepEqual(await snapshot(f.dir), complete);
  }));
}

test("existing/partial authority, surviving index and changed scheduler are never re-keyed or bootstrapped", windows, async () => fixture(async f => {
  const preview = await f.bootstrap.preview();await writeFile(f.registration.schedulerPath, '{"key":"changed"}\n');const before = await snapshot(f.dir);
  await assert.rejects(f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 }));assert.deepEqual(await snapshot(f.dir), before);
  await unlink(f.registration.schedulerPath);await writeFile(f.registration.root + ".inventory.sqlite3", "preserve missing authority index");
  const indexed = await snapshot(f.dir);await assert.rejects(f.bootstrap.preview());assert.deepEqual(await snapshot(f.dir), indexed);
  await unlink(f.registration.root + ".inventory.sqlite3");await mkdir(f.registration.root);await writeFile(join(f.registration.root, "existing"), "preserve old bytes");
  const partial = await snapshot(f.dir);await assert.rejects(f.bootstrap.preview());assert.equal((await f.bootstrap.status()).state, "held");assert.deepEqual(await snapshot(f.dir), partial);
}));

test("missing key after actual partial exit holds without recreating or moving records", windows, async () => fixture(async f => {
  const preview = await f.bootstrap.preview();await crash(f.registration, preview.decisionId, preview.proofSha256, "authority");
  await unlink(join(f.registration.root, "signing-key.json"));const before = await snapshot(f.dir);
  assert.equal((await f.bootstrap.status()).state, "held");await assert.rejects(f.bootstrap.preview());
  await assert.rejects(f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 }));assert.deepEqual(await snapshot(f.dir), before);
}));

test("changed signed intent and a replaced native source are preserved instead of adopted", windows, async () => {
  await fixture(async f => {
    const preview = await f.bootstrap.preview();await crash(f.registration, preview.decisionId, preview.proofSha256, "pending");
    const pending = f.intent + ".pending", envelope = JSON.parse((await readFile(pending)).toString("utf8"));
    envelope.signature = "0".repeat(64);await writeFile(pending, JSON.stringify(envelope) + "\n");const before = await snapshot(f.dir);
    await assert.rejects(f.bootstrap.preview());await assert.rejects(f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 }));
    assert.equal((await f.bootstrap.status()).state, "held");assert.deepEqual(await snapshot(f.dir), before);
  });
  await fixture(async f => {
    const preview = await f.bootstrap.preview();await crash(f.registration, preview.decisionId, preview.proofSha256, "intent");
    const value = JSON.parse((await readFile(f.intent)).toString("utf8")).payload;
    const source = join(resolve(f.registration.root, ".."), value.seed + ".authority"), preserved = source + ".preserved";
    const key = await readFile(join(source, "signing-key.json"));await rename(source, preserved);
    await mkdir(join(source, "masters", f.registration.masterId), { recursive: true });await writeFile(join(source, "signing-key.json"), key);
    const before = await snapshot(f.dir);await assert.rejects(f.bootstrap.preview());
    await assert.rejects(f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 }));assert.deepEqual(await snapshot(f.dir), before);
  });
});

test("foreign scheduler lock is retained and only explicit retry can create the initial targets", windows, async () => fixture(async f => {
  const preview = await f.bootstrap.preview(), lock = f.registration.schedulerPath + ".lock";
  await writeFile(lock, "foreign lock owner\n");
  await assert.rejects(f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 }));
  assert.equal((await readFile(lock)).toString("utf8"), "foreign lock owner\n");
  for (const path of [f.intent, f.fence, f.registration.root, f.registration.turnRoot]) await assert.rejects(lstat(path), { code: "ENOENT" });
  await unlink(lock);await f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 });
  assert.equal((await f.bootstrap.status()).state, "ready");
}));

test("different concurrent decisions share native exclusion and exactly one immutable signing key", windows, async () => fixture(async f => {
  const a = await f.bootstrap.preview(), b = await f.bootstrap.preview();assert.notEqual(a.decisionId, b.decisionId);assert.equal(a.proofSha256, b.proofSha256);
  const results = await Promise.allSettled([f.bootstrap.apply({ decisionId: a.decisionId, expectedProofSha256: a.proofSha256 }),
    new StorageBootstrap(f.registration).apply({ decisionId: b.decisionId, expectedProofSha256: b.proofSha256 })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const original = await f.bootstrap.preview(), before = await snapshot(f.dir);
  await f.bootstrap.apply({ decisionId: original.decisionId, expectedProofSha256: original.proofSha256 });assert.deepEqual(await snapshot(f.dir), before);
}));

test("reserved guard, bootstrap intent, stage database and sidecar scheduler collisions reject before any creation", windows, async () => fixture(async f => {
  const before = await snapshot(f.dir);
  for (const suffix of [".bootstrap-v1.json", ".bootstrap-v1.json.pending", ".storage-guard-v1.lock", ".inventory.sqlite3", ".inventory.sqlite3-wal", ".inventory.sqlite3.recoveries"]) {
    const bad = new StorageBootstrap({ ...f.registration, schedulerPath: f.registration.root + suffix });
    assert.equal((await bad.status()).state, "held");await assert.rejects(bad.preview());
    await assert.rejects(bad.apply({ decisionId: randomUUID(), expectedProofSha256: "0".repeat(64) }));
    assert.deepEqual(await snapshot(f.dir), before);
  }
}));

test("a missing root receipt before adoption and a foreign scheduler receipt hold both registered inventories", windows, async () => fixture(async f => {
  const first = await f.console.preview("authority-initialize");await f.console.apply(first.decision);
  const stage = await f.console.preview("stage-adopt"), runtime = await f.console.preview("runtime-adopt");
  await rename(f.intent, f.intent + ".saved");const missing = await snapshot(f.dir);
  await assert.rejects(f.console.preview("stage-adopt"));await assert.rejects(f.console.apply(stage.decision));
  await assert.rejects(f.console.preview("runtime-adopt"));await assert.rejects(f.console.apply(runtime.decision));
  assert.deepEqual(await snapshot(f.dir), missing);
  await rename(f.intent + ".saved", f.intent);
  // An older authority has no bootstrap receipt, but cannot borrow A's scheduler.
  const other = { ...f.registration, root: join(f.dir, "state", "legacy-master"), turnRoot: join(f.dir, "state", "legacy-turns") };
  await mkdir(join(other.root, "masters", other.masterId), { recursive: true });await mkdir(other.turnRoot);
  await writeFile(join(other.root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: "a".repeat(64) }) + "\n");
  await writeFile(other.root + ".storage-guard-v1.lock", "");
  const registered = new LocalStorageConsole(other, () => ({ maintenance: true, executionHeld: true, startupError: null }));
  const before = await snapshot(f.dir);await assert.rejects(registered.preview("stage-adopt"));await assert.rejects(registered.preview("runtime-adopt"));
  await assert.rejects(new RuntimeJournalInventory(other).adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: runtime.decision.proofSha256 }));
  assert.deepEqual(await snapshot(f.dir), before);
}));

test("signed-envelope capacity refusal is read-only before any guard, key or source exists", windows, async () => fixture(async f => {
  const before = await snapshot(f.dir);
  const code = `import sys,json
sys.path.insert(0,sys.argv[1])
import negi_storage_bootstrap as b
b.LIMIT=500
try:b.Bootstrap(json.loads(sys.stdin.buffer.read())).preview()
except ValueError as error:
 assert 'capacity' in str(error)
 sys.exit(17)
sys.exit(99)
`;
  const child = spawn("python", ["-B", "-c", code, resolve("scripts")], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  let error = "";child.stderr!.on("data", bytes => { error += bytes; });child.stdin!.end(JSON.stringify(f.registration));
  assert.equal(await new Promise<number | null>((accept, reject) => { child.once("error", reject);child.once("close", accept); }), 17, error);
  assert.deepEqual(await snapshot(f.dir), before);
}));

test("unsupported Windows SQLite path length refuses long Japanese registration before any preparation", windows, async () => fixture(async f => {
  let parent = join(f.dir, "state");
  for (let n = 0; n < 18; n++) { parent = join(parent, "日".repeat(80) + n);await mkdir(parent); }
  const registration = { root: join(parent, "統括"), turnRoot: join(parent, "会話受付"), schedulerPath: join(parent, "受付.jsonl"), masterId: f.registration.masterId };
  const console = new LocalStorageConsole(registration, () => ({ maintenance: true, executionHeld: true, startupError: null }));
  const before = await snapshot(f.dir);assert.ok(Buffer.byteLength(JSON.stringify(registration)) > 12000);
  await assert.rejects(console.preview("authority-initialize"));await assert.rejects(console.apply({ operation: "authority-initialize", decisionId: randomUUID(), proofSha256: "0".repeat(64), registrationSha256: "0".repeat(64) }));
  assert.deepEqual(await snapshot(f.dir), before);
}));

test("malformed, duplicate and reducer-invalid scheduler histories cannot prepare an authority", windows, async () => fixture(async f => {
  const event = { key: "config", at: "2026-10-03T00:00:00Z", action: { type: "configure", maxConcurrent: 1, budgetUsd: 0 } };
  const line = JSON.stringify(event) + "\n";
  for (const invalid of [line.trimEnd(), "invalid JSON\n", line + line,
    line + JSON.stringify({ key: "finish", at: event.at, action: { type: "settle", workId: "absent", outcome: "verified", evidenceRef: "test:invalid", actualCostUsd: null } }) + "\n"]) {
    const preview = await f.bootstrap.preview();await writeFile(f.registration.schedulerPath, invalid);const before = await snapshot(f.dir);
    await assert.rejects(f.bootstrap.preview());await assert.rejects(f.bootstrap.apply({ decisionId: preview.decisionId, expectedProofSha256: preview.proofSha256 }));
    assert.deepEqual(await snapshot(f.dir), before);await unlink(f.registration.schedulerPath);
  }
}));

test("supported Japanese paths complete all three explicit registrations", windows, async () => fixture(async f => {
  const parent = join(f.dir, "作業記録".repeat(8));await mkdir(parent);
  const registration = { root: join(parent, "統括"), turnRoot: join(parent, "会話受付"), schedulerPath: join(parent, "受付.jsonl"), masterId: f.registration.masterId };
  const console = new LocalStorageConsole(registration, () => ({ maintenance: true, executionHeld: true, startupError: null }));
  for (const operation of ["authority-initialize", "stage-adopt", "runtime-adopt"] as const) {
    const preview = await console.preview(operation);await console.apply(preview.decision);
  }
  assert.equal((await console.status()).bootstrap.state, "ready");assert.equal((await new RuntimeJournalInventory(registration).audit()).state, "clean");
}));

test("original bootstrap acknowledgement remains read-only when later runtime history is damaged", windows, async () => fixture(async f => {
  const first = await f.console.preview("authority-initialize");await f.console.apply(first.decision);
  for (const operation of ["stage-adopt", "runtime-adopt"] as const) { const preview = await f.console.preview(operation);await f.console.apply(preview.decision); }
  await writeFile(f.registration.schedulerPath, "damaged runtime history\n");
  for (const fault of ["bytes", "hardlink", "directory"]) {
    if (fault === "hardlink") {
      await unlink(f.registration.schedulerPath);const other = join(f.dir, "replacement-scheduler");await writeFile(other, "preserve both native links\n");await link(other, f.registration.schedulerPath);
    } else if (fault === "directory") { await unlink(f.registration.schedulerPath);await mkdir(f.registration.schedulerPath); }
    const before = await snapshot(f.dir);await assert.rejects(new RuntimeJournalInventory(f.registration).audit());
    assert.deepEqual((await f.console.preview("authority-initialize")).decision, first.decision);
    await f.console.apply(first.decision);assert.deepEqual(await snapshot(f.dir), before);
  }
}));
