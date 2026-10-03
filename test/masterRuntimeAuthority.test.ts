import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MasterConversationAuthority, MasterConversationHeldError } from "../src/server/orchestration/masterConversations.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { signedMasterOwner, type MasterOwner, type MasterOwnerPayload } from "../src/server/orchestration/masterConversationOwner.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { scheduledMasterTurns } from "../src/server/orchestration/masterTurnAdmission.ts";
import { observeWriter, recoverWriter } from "../src/server/orchestration/writerRecovery.ts";

const windows = { skip: process.platform !== "win32" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const observation = { turnId: "turn", status: "completed", finalText: "Confirmed response", contextInputTokens: 1,
  contextWindow: 100, lastUsage: { inputTokens: 1, outputTokens: 1 } };
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-master-runtime-"));
  try { await run(await setup(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function setup(dir: string) {
  const cwd = join(dir, "checkout"), root = join(dir, "authority"), turnRoot = join(dir, "turns"), schedulerPath = join(dir, "scheduler.jsonl");
  await mkdir(cwd); await mkdir(turnRoot);
  const defaults = { root, turnRoot, masterId: "master", scheduler: new FileScheduler(schedulerPath) };
  const legacy = new MasterConversationAuthority(defaults); await legacy.assertIdle(cwd);
  await defaults.scheduler.ensureSubscriptionConfiguration();
  const stage = new MasterConversationInventory({ root, masterId: "master", recoveryContext: { turnRoot, schedulerPath } }); await stage.initialize();
  const runtime = new RuntimeJournalInventory({ root, turnRoot, schedulerPath }), preview = await runtime.previewBaseline();
  await runtime.adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
  const authority = () => new MasterConversationAuthority({ ...defaults, stageStorage: "indexed", runtimeStorage: "indexed" });
  const scheduler = new FileScheduler(schedulerPath, { journal: runtime.schedulerJournal() }), master = join(root, "masters", "master"), ownerFile = join(master, "owner.lock");
  const request = { requestId: randomUUID(), cwd, model: "fixture", effort: "low", threadId: "old", text: "Read a bounded request" };
  const key = Buffer.from(JSON.parse(await readFile(join(root, "signing-key.json"), "utf8")).key, "hex");
  return { dir, cwd, root, turnRoot, schedulerPath, master, ownerFile, key, stage, runtime, scheduler, authority, defaults, legacy, request };
}
async function captureOwner(run: () => Promise<void>): Promise<MasterOwner> {
  const original = MasterConversationInventory.prototype.ownerBaseline; let owner: MasterOwner | null = null;
  MasterConversationInventory.prototype.ownerBaseline = async function (digest) {
    // Intercept a genuine Authority-created owner, after normal helper validation.
    const result = await original.call(this, digest);
    const root = (this as unknown as { root: string }).root;
    owner = JSON.parse(await readFile(join(root, "masters", "master", "owner.lock"), "utf8"));
    return result;
  };
  try { await run();assert.ok(owner);return owner; } finally { MasterConversationInventory.prototype.ownerBaseline = original; }
}
async function retainedInspection(f: Awaited<ReturnType<typeof setup>>) {
  const original = MasterConversationInventory.prototype.ownerBaseline;
  MasterConversationInventory.prototype.ownerBaseline = async function (digest) { await original.call(this, digest);throw Error("fixture interruption after owner admission"); };
  try { await assert.rejects(f.authority().assertIdle(f.cwd)); } finally { MasterConversationInventory.prototype.ownerBaseline = original; }
  const owner = JSON.parse(await readFile(f.ownerFile, "utf8")) as MasterOwner;
  assert.equal(owner.schema, "negi-master-conversation-owner/5");return owner;
}
async function replaceOwner(f: Awaited<ReturnType<typeof setup>>, owner: MasterOwner, alter: (payload: MasterOwnerPayload) => void) {
  const { signature: _signature, ...payload } = structuredClone(owner);alter(payload);
  const bytes = signedMasterOwner(payload, f.key); await writeFile(f.ownerFile, bytes);return bytes;
}

test("paired indexed Authority admits a normal turn, pins owner/5 runtime head and audits startup without replay", windows, async () => fixture(async f => {
  const before = await f.runtime.audit(); await f.authority().assertStorageCompatible(); await f.authority().assertStartupSafe(f.cwd);
  let lease!: Awaited<ReturnType<MasterConversationAuthority["admitTurn"]>>;
  const owner = await captureOwner(async () => { lease = await f.authority().admitTurn(f.request); });
  assert.equal(owner.schema, "negi-master-conversation-owner/5");if (owner.schema !== "negi-master-conversation-owner/5") throw Error("owner version");
  assert.deepEqual(owner.runtime.head, before.head); assert.deepEqual(owner.runtime.context, { turnRoot: f.turnRoot, schedulerPath: f.schedulerPath });
  assert.equal(owner.operation.requestId, f.request.requestId);
  assert.equal(owner.operation.hash, hash(await readFile(join(f.turnRoot, lease.workId, "request.json"), "utf8")));
  await assert.rejects(lstat(f.ownerFile), { code: "ENOENT" }); await assert.rejects(f.authority().assertStartupSafe(f.cwd), MasterConversationHeldError);
  await lease.dispatching(); await lease.bind("turn"); await lease.complete(observation);
  assert.equal((await f.scheduler.read()).state?.entries[0]?.status, "verified"); assert.equal((await f.runtime.audit()).state, "clean");
  const head = (await f.runtime.audit()).head; await lease.complete(observation); assert.deepEqual((await f.runtime.audit()).head, head);
  await f.authority().assertStartupSafe(f.cwd); await assert.rejects(f.legacy.assertStorageCompatible());
}));

test("thread owner/5 accepts signed shared Task progress without attributing its global tail to the Master", windows, async () => fixture(async f => {
  const request = { requestId: randomUUID(), masterId: "master", mode: "rotate" as const, oldThreadId: "old", cwd: f.cwd,
    model: "fixture", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
  const identity = { threadId: "new", requestedModel: "fixture", resolvedModel: "fixture", modelProvider: "fixture", rerouted: false };
  let calls = 0;
  const result = await f.authority().start(request, async mark => {
    calls++; const owner = JSON.parse(await readFile(f.ownerFile, "utf8"));assert.equal(owner.schema, "negi-master-conversation-owner/5");
    await f.scheduler.append({ key: "other-task", at: new Date().toISOString(), action: { type: "submit", work: { id: "task", parentId: null,
      dependencies: [], role: "sol", checkout: join(f.dir, "other-checkout"), checkoutMode: "write", resources: [], reserveUsd: 0 } } });
    await f.stage.ownerBaseline(hash(await readFile(f.ownerFile, "utf8"))); await mark();return identity;
  });
  assert.equal(result.stage, "completed");assert.equal((await f.stage.audit()).head.seq, 5);assert.equal((await f.runtime.audit()).head.seq, 2);
  assert.equal((await f.authority().status(request.requestId))?.stage, "completed");
  await f.authority().start(request, async () => { calls++;return identity; });assert.equal(calls, 1);
  await assert.rejects(lstat(f.ownerFile), { code: "ENOENT" });
  const stageBytes = await readFile(f.stage.databasePath);await rm(f.runtime.databasePath);
  await assert.rejects(f.authority().status(request.requestId), MasterConversationHeldError);
  assert.deepEqual(await readFile(f.stage.databasePath), stageBytes);assert.equal(calls, 1);
}));

test("runtime owner future head, changed prefix and foreign context are held with their exact records intact", windows, async () => fixture(async f => {
  const owner = await retainedInspection(f);
  for (const kind of ["future", "prefix", "context"]) {
    const bytes = await replaceOwner(f, owner, payload => {
      if (payload.schema !== "negi-master-conversation-owner/5") throw Error("version");
      if (kind === "future") payload.runtime.head.seq++;
      else if (kind === "prefix") payload.runtime.head.sha256 = "a".repeat(64);
      else { payload.runtime.context.turnRoot = join(f.dir, "foreign");payload.indexed.contextSha256 = hash(JSON.stringify(payload.runtime.context)); }
    });
    await assert.rejects(f.stage.ownerBaseline(hash(bytes)), /runtime|Runtime|registered|directory|file|WinError/);
    assert.equal(await readFile(f.ownerFile, "utf8"), bytes);
  }
}));

test("a pending signed request retains owner/5 and never creates or resends its turn after lost acknowledgement", windows, async () => fixture(async f => {
  const original = RuntimeJournalInventory.prototype.turnJournal;
  RuntimeJournalInventory.prototype.turnJournal = function () { const journal = original.call(this);return { ...journal,
    appendIntent: async input => { await journal.appendIntent(input);throw Error("fixture lost request intent ACK"); } }; };
  try { await assert.rejects(f.authority().admitTurn(f.request)); } finally { RuntimeJournalInventory.prototype.turnJournal = original; }
  const before = await f.runtime.audit(), owner = await readFile(f.ownerFile);
  assert.equal(before.state, "pending");assert.deepEqual(before.missing, ["master-" + f.request.requestId + "/request.json"]);
  await assert.rejects(f.authority().admitTurn(f.request));await assert.rejects(f.authority().assertStartupSafe(f.cwd));
  assert.deepEqual((await f.runtime.audit()).head, before.head);assert.deepEqual(await readFile(f.ownerFile), owner);
  assert.deepEqual(await readdir(f.turnRoot), []);assert.equal((await readFile(f.schedulerPath, "utf8")).split("\n").filter(Boolean).length, 1);
}));

test("an active inspection owner refuses a different signed local admission while preserving its global evidence", windows, async () => fixture(async f => {
  const owner = await retainedInspection(f);
  const admission = scheduledMasterTurns({ root: f.turnRoot, masterId: "master", scheduler: f.scheduler, journal: f.runtime.turnJournal() });
  const lease = await admission.reserve(f.request);
  const bytes = await readFile(f.ownerFile, "utf8");assert.equal(JSON.parse(bytes).owner, owner.owner);
  await assert.rejects(f.stage.ownerBaseline(hash(bytes)), /another local admission/);assert.equal((await f.runtime.audit()).state, "clean");
  assert.equal((await f.scheduler.read()).state?.entries[0]?.work.id, lease.workId);assert.equal(await readFile(f.ownerFile, "utf8"), bytes);
}));

test("owner/5 supports exact dead-owner receipt release and reconnect without a provider or legacy downgrade", windows, async () => fixture(async f => {
  const owner = await retainedInspection(f);
  await replaceOwner(f, owner, payload => { payload.pid = 2147480000;if (payload.schema === "negi-master-conversation-owner/5") payload.processIdentity = { platform: "windows", pid: payload.pid, startToken: "1" }; });
  assert.equal((await observeWriter(f.master, "master")).state, "dead");
  const preview = await f.authority().ownerRecovery(f.cwd);assert.equal(preview?.canRelease, true);assert.ok(preview);
  const decisionId = randomUUID(), result = await f.authority().releaseOwner(f.cwd, decisionId, preview.proofSha256);
  assert.equal(result.ownerReleased, true);assert.equal(result.operationComplete, false);
  assert.equal((await f.authority().ownerRecoveryStatus(f.cwd, decisionId))?.state, "owner_released");
  await f.authority().releaseOwner(f.cwd, decisionId, preview.proofSha256);await assert.rejects(lstat(f.ownerFile), { code: "ENOENT" });
  assert.equal((await f.stage.audit()).head.seq, 1);assert.equal((await f.runtime.audit()).head.seq, 1);
  await f.authority().assertStartupSafe(f.cwd);
}));

test("missing runtime DB cannot downgrade an owner/5 or recreate an authority key through a default writer", windows, async () => fixture(async f => {
  const owner = await retainedInspection(f), before = await readFile(f.ownerFile), marker = await readFile(f.runtime.registrationPath);
  await rm(f.runtime.databasePath);await rm(f.stage.databasePath);
  const payload = { schemaVersion: "negi-master-owner-recovery/1", masterId: "master", decisionId: randomUUID(), cwdSha256: owner.cwdSha256,
    owner, proofSha256: "a".repeat(64), action: "release-owner-only", at: new Date().toISOString() };
  const receipt = JSON.stringify({ payload, signature: createHmac("sha256", f.key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
  const masterFiles = await readdir(f.master);
  await assert.rejects(recoverWriter(f.master, "master", owner.operation, hash(before.toString()), receipt));
  assert.deepEqual(await readdir(f.master), masterFiles);assert.deepEqual(await readFile(f.ownerFile), before);
  await rm(join(f.root, "signing-key.json"));
  await assert.rejects(f.legacy.assertIdle(f.cwd));await assert.rejects(f.authority().assertStorageCompatible());
  await assert.rejects(f.authority().releaseOwner(f.cwd, randomUUID(), "a".repeat(64)));
  assert.equal(owner.schema, "negi-master-conversation-owner/5");assert.deepEqual(await readFile(f.ownerFile), before);
  assert.deepEqual(await readFile(f.runtime.registrationPath), marker);await assert.rejects(lstat(join(f.root, "signing-key.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.master, "recoveries")), { code: "ENOENT" });
}));
