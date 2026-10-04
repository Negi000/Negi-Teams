import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { MasterConversationAuthority, MasterConversationHeldError, type MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const identity = { threadId: "new-fixture-thread", requestedModel: "fixture-astra", resolvedModel: "fixture-astra", modelProvider: "fixture", rerouted: false };
interface F { dir: string; cwd: string; root: string; master: string; scheduler: FileScheduler; inventory: MasterConversationInventory;
  authority: MasterConversationAuthority; legacy: MasterConversationAuthority; request: MasterConversationRequest; reopen: () => MasterConversationAuthority }
async function fixture(run: (f: F) => Promise<void>, migrate = false) {
  const dir = await mkdtemp(join(tmpdir(), "negi-conversation-indexed-")), cwd = join(dir, "checkout"), root = join(dir, "authority");
  await mkdir(cwd);
  const scheduler = new FileScheduler(join(dir, "scheduler.jsonl")), turnRoot = join(dir, "turns");
  const legacy = new MasterConversationAuthority({ root, turnRoot, masterId: "master", scheduler });
  const request: MasterConversationRequest = { requestId: randomUUID(), masterId: "master", mode: "rotate", oldThreadId: "old-fixture-thread", cwd,
    model: "fixture-astra", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
  const inventory = new MasterConversationInventory({ root, masterId: "master" });
  const reopen = () => new MasterConversationAuthority({ root, turnRoot, masterId: "master", scheduler, stageStorage: "indexed" });
  try {
    await legacy.assertIdle(cwd);
    if (migrate) {
      const prior = { ...request, requestId: randomUUID() };
      await legacy.start(prior, async mark => { await mark();return identity; });
      const preview = await inventory.previewLegacyMigration();
      await inventory.migrateLegacy({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
    } else await inventory.initialize();
    await run({ dir, cwd, root, master: join(root, "masters", "master"), scheduler, inventory, authority: reopen(), legacy, request, reopen });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
type Append = MasterConversationInventory["appendStageIntent"];
async function intercept(hook: (inventory: MasterConversationInventory, input: Parameters<Append>[0], original: Append) => ReturnType<Append>, run: () => Promise<void>) {
  const original = MasterConversationInventory.prototype.appendStageIntent;
  MasterConversationInventory.prototype.appendStageIntent = function (input) { return hook(this, input, original.bind(this)); };
  try { await run(); } finally { MasterConversationInventory.prototype.appendStageIntent = original; }
}

test("indexed conversation writes five signed stage intents before create-only files and never dispatches early", async () => fixture(async f => {
  const observations: string[] = [];
  await intercept(async (inventory, input, original) => {
    await assert.rejects(lstat(join(f.master, input.relativePath)), { code: "ENOENT" });
    if (input.relativePath.endsWith("00-requested.json")) await assert.rejects(lstat(join(f.master, f.request.requestId)), { code: "ENOENT" });
    const result = await original(input), latest = await inventory.latestStage(f.request.requestId);
    assert.equal(latest.state, "pending");assert.equal(latest.latest?.bytes, input.bytes);assert.deepEqual(latest.missing, [input.relativePath]);
    assert.equal(latest.head.seq, result.head.seq);observations.push(input.relativePath);
    return result;
  }, async () => {
    const result = await f.authority.start(f.request, async mark => {
      assert.equal((await f.inventory.latestStage(f.request.requestId)).head.seq, 2);
      await mark();assert.equal((await f.inventory.audit()).head.seq, 3);return identity;
    });
    assert.equal(result.stage, "completed");
  });
  assert.equal(observations.length, 5);assert.equal((await f.inventory.audit()).head.seq, 5);
  assert.deepEqual(await readdir(join(f.master, f.request.requestId)), ["00-requested.json", "01-old_idle.json", "02-start_dispatched.json", "03-bound.json", "04-completed.json"]);
  await assert.rejects(lstat(join(f.master, "owner.lock")), { code: "ENOENT" });
  assert.deepEqual(await f.reopen().status(f.request.requestId), { request: f.request, stage: "completed", identity, reason: null, exclusionHeld: false });
  let repeated = 0;
  assert.equal((await f.reopen().start(f.request, async () => { repeated++;return identity; })).stage, "completed");assert.equal(repeated, 0);
  assert.equal((await f.inventory.audit()).head.seq, 5);
}));

test("lost intent ACK preserves the indexed request without creating an operation or dispatching/replaying", async () => fixture(async f => {
  let callbacks = 0;
  await intercept(async (_inventory, input, original) => { await original(input);throw Error("fixture lost ACK after commit"); }, async () => {
    await assert.rejects(f.authority.start(f.request, async () => { callbacks++;return identity; }), MasterConversationHeldError);
  });
  assert.equal(callbacks, 0);assert.deepEqual(await readdir(f.master), ["owner.lock"]);
  const latest = await f.inventory.latestStage(f.request.requestId);assert.equal(latest.head.seq, 1);assert.equal(latest.state, "pending");
  assert.ok(latest.latest?.relativePath.endsWith("00-requested.json"));
  const before = await readFile(f.inventory.databasePath), owner = await readFile(join(f.master, "owner.lock"));
  const status = await f.reopen().status(f.request.requestId);assert.equal(status?.stage, "needs_reconciliation");assert.equal(status?.exclusionHeld, true);assert.deepEqual(status?.request, f.request);
  await assert.rejects(f.reopen().start(f.request, async () => { callbacks++;return identity; }), MasterConversationHeldError);
  assert.equal(callbacks, 0);assert.deepEqual(await readFile(f.inventory.databasePath), before);assert.deepEqual(await readFile(join(f.master, "owner.lock")), owner);
}));

test("a lost completion ACK cannot clear or replay the known provider result", async () => fixture(async f => {
  let callbacks = 0;
  await intercept(async (_inventory, input, original) => { const result = await original(input);if (input.relativePath.endsWith("04-completed.json")) throw Error("fixture completed ACK lost");return result; }, async () => {
    await assert.rejects(f.authority.start(f.request, async mark => { callbacks++;await mark();return identity; }), MasterConversationHeldError);
  });
  const before = await readFile(f.inventory.databasePath), status = await f.reopen().status(f.request.requestId);
  assert.equal(callbacks, 1);assert.equal((await f.inventory.audit()).head.seq, 5);assert.equal(status?.stage, "needs_reconciliation");assert.deepEqual(status?.identity, identity);assert.equal(status?.exclusionHeld, true);
  await assert.rejects(f.reopen().start(f.request, async () => { callbacks++;return identity; }), MasterConversationHeldError);
  assert.equal(callbacks, 1);assert.deepEqual(await readFile(f.inventory.databasePath), before);
}));

test("missing completed file and whole operation deletion remain indexed reconciliation facts", async () => {
  for (const lost of ["last", "operation"]) await fixture(async f => {
    await f.authority.start(f.request, async mark => { await mark();return identity; });
    const operation = join(f.master, f.request.requestId), before = await readFile(f.inventory.databasePath);
    if (lost === "last") await unlink(join(operation, "04-completed.json"));else await rm(operation, { recursive: true });
    const status = await f.reopen().status(f.request.requestId);assert.equal(status?.stage, "needs_reconciliation");assert.deepEqual(status?.request, f.request);assert.deepEqual(status?.identity, identity);assert.equal(status?.exclusionHeld, true);
    let calls = 0;await assert.rejects(f.reopen().start({ ...f.request, requestId: randomUUID() }, async () => { calls++;return identity; }), MasterConversationHeldError);
    assert.equal(calls, 0);assert.deepEqual(await readFile(f.inventory.databasePath), before);
  });
});

test("changed materialized bytes are held without overwriting or interpreting them as an absent request", async () => fixture(async f => {
  await f.authority.start(f.request, async mark => { await mark();return identity; });
  const target = join(f.master, f.request.requestId, "04-completed.json"), before = await readFile(f.inventory.databasePath);
  await writeFile(target, "fixture altered bytes");await assert.rejects(f.reopen().status(f.request.requestId), MasterConversationHeldError);
  await assert.rejects(f.reopen().start(f.request, async () => identity), MasterConversationHeldError);
  assert.equal(await readFile(target, "utf8"), "fixture altered bytes");assert.deepEqual(await readFile(f.inventory.databasePath), before);
}));

test("indexed stage writes append to an adopted baseline without changing original stages", async () => fixture(async f => {
  const prior = (await readdir(f.master)).find(name => name !== "owner.lock")!, files = await readdir(join(f.master, prior));
  const original = await Promise.all(files.map(name => readFile(join(f.master, prior, name))));
  await f.authority.start(f.request, async mark => { await mark();return identity; });
  assert.equal((await f.inventory.audit()).head.seq, 10);assert.deepEqual(await Promise.all(files.map(name => readFile(join(f.master, prior, name)))), original);
  assert.equal((await f.inventory.latestStage(prior)).head.seq, 10);assert.equal((await f.reopen().status(prior))?.stage, "completed");
}, true));

test("pre-dispatch and dispatched provider failures keep their different indexed terminal facts", async () => {
  for (const dispatched of [false, true]) await fixture(async f => {
    await assert.rejects(f.authority.start(f.request, async mark => { if (dispatched) await mark();throw Error("synthetic callback failure"); }), MasterConversationHeldError);
    const status = await f.reopen().status(f.request.requestId);assert.equal(status?.stage, dispatched ? "needs_reconciliation" : "cancelled");assert.equal(status?.exclusionHeld, false);
    assert.equal((await f.inventory.audit()).head.seq, dispatched ? 4 : 3);assert.equal((await f.inventory.audit()).state, "clean");
  });
});

test("indexed stage registration does not enable unindexed turn reservations, native owner release or provider startup", async () => fixture(async f => {
  const before = await readFile(f.inventory.databasePath), key = await readFile(join(f.root, "signing-key.json"));
  await assert.rejects(f.authority.admitTurn({ requestId: randomUUID(), cwd: f.cwd, model: "fixture-astra", effort: "low", threadId: "old", text: "do not submit" }), MasterConversationHeldError);
  await assert.rejects(f.authority.assertStorageCompatible(), MasterConversationHeldError);await assert.rejects(f.authority.assertStartupSafe(f.cwd), MasterConversationHeldError);
  assert.deepEqual(await readdir(f.master), []);await assert.rejects(lstat(join(f.dir, "turns")), { code: "ENOENT" });assert.equal((await f.scheduler.read()).state, null);
  assert.deepEqual(await readFile(f.inventory.databasePath), before);assert.deepEqual(await readFile(join(f.root, "signing-key.json")), key);
  await assert.rejects(f.legacy.start(f.request, async () => identity), MasterConversationHeldError);
}));

test("missing indexed authority/key/database never bootstraps storage from start or status", async () => {
  for (const lost of ["root", "key", "database"]) await fixture(async f => {
    if (lost === "root") await rm(f.root, { recursive: true });else await unlink(lost === "key" ? join(f.root, "signing-key.json") : f.inventory.databasePath);
    const names = await readdir(f.dir);await assert.rejects(f.reopen().start(f.request, async () => identity), MasterConversationHeldError);
    await assert.rejects(f.reopen().status(f.request.requestId), MasterConversationHeldError);assert.deepEqual(await readdir(f.dir), names);
    if (lost === "root") await assert.rejects(lstat(f.root), { code: "ENOENT" });
    if (lost === "key") await assert.rejects(lstat(join(f.root, "signing-key.json")), { code: "ENOENT" });
    if (lost === "database") await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
  });
});

test("exact owner changes after the TS preview hold before any stage intent or dispatch", async () => fixture(async f => {
  await intercept(async (_inventory, input, original) => {
    const key = Buffer.from(JSON.parse(await readFile(join(f.root, "signing-key.json"), "utf8")).key, "hex");
    const owner = JSON.parse(await readFile(join(f.master, "owner.lock"), "utf8")), { signature: _signature, ...payload } = owner;
    payload.owner = randomUUID();await writeFile(join(f.master, "owner.lock"), JSON.stringify({ ...payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") }) + "\n");
    return original(input);
  }, async () => { await assert.rejects(f.authority.start(f.request, async () => identity)); });
  assert.equal((await f.inventory.audit()).head.seq, 0);assert.deepEqual(await readdir(f.master), ["owner.lock"]);
}));

test("actual child exit after dispatch intent leaves the owner and same indexed request for read-only reconnect", async () => fixture(async f => {
  const code = `import {MasterConversationAuthority} from ${JSON.stringify(pathToFileURL(resolve("src/server/orchestration/masterConversations.ts")).href)};
import {MasterConversationInventory} from ${JSON.stringify(pathToFileURL(resolve("src/server/orchestration/masterConversationInventory.ts")).href)};
import {FileScheduler} from ${JSON.stringify(pathToFileURL(resolve("src/server/orchestration/scheduler.ts")).href)};
let text='';for await(const part of process.stdin)text+=part;const input=JSON.parse(text);
const original=MasterConversationInventory.prototype.appendStageIntent;
MasterConversationInventory.prototype.appendStageIntent=async function(request){const result=await original.call(this,request);if(request.relativePath.endsWith('02-start_dispatched.json'))process.exit(27);return result;};
await new MasterConversationAuthority({root:input.root,turnRoot:input.turnRoot,masterId:'master',scheduler:new FileScheduler(input.scheduler),stageStorage:'indexed'}).start(input.request,async mark=>{await mark();throw Error('must exit before mock RPC');});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept);child.once("error", reject); });
  const timer = setTimeout(() => child.kill(), 60000);child.stdin.end(JSON.stringify({ root: f.root, turnRoot: join(f.dir, "turns"), scheduler: f.scheduler.path, request: f.request }));
  try { assert.equal(await closed, 27, stderr); } finally { clearTimeout(timer);child.kill();await closed; }
  assert.equal((await f.inventory.audit()).head.seq, 3);assert.deepEqual(await readdir(join(f.master, f.request.requestId)), ["00-requested.json", "01-old_idle.json"]);
  const before = await readFile(f.inventory.databasePath), owner = await readFile(join(f.master, "owner.lock")), status = await f.reopen().status(f.request.requestId);
  assert.equal(status?.stage, "needs_reconciliation");assert.equal(status?.exclusionHeld, true);
  await assert.rejects(f.reopen().start(f.request, async () => identity), MasterConversationHeldError);
  const recovery = await f.reopen().ownerRecovery(f.cwd);assert.equal(recovery?.canRelease, false);
  assert.deepEqual(await readFile(f.inventory.databasePath), before);assert.deepEqual(await readFile(join(f.master, "owner.lock")), owner);
}));
