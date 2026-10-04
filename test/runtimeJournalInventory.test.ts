import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { scheduledMasterTurns } from "../src/server/orchestration/masterTurnAdmission.ts";
import { withMasterStorageGuard } from "../src/server/orchestration/masterStorageGuard.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const observation = { turnId: "turn", status: "completed", finalText: "Known response", contextInputTokens: 1,
  contextWindow: 100, lastUsage: { inputTokens: 1, outputTokens: 1 } };
const windows = { skip: process.platform !== "win32" };
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-runtime-index-"));
  try { await run(await setup(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function setup(dir: string) {
  const root = join(dir, "authority"), turnRoot = join(dir, "turns"), cwd = join(dir, "checkout"), schedulerPath = join(dir, "scheduler.jsonl");
  await mkdir(join(root, "masters", "master"), { recursive: true }); await mkdir(turnRoot); await mkdir(cwd);
  await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: randomBytes(32).toString("hex") }) + "\n");
  await withMasterStorageGuard(root, async () => {});
  const inventory = new RuntimeJournalInventory({ root, turnRoot, schedulerPath });
  const request = { cwd, model: "fixture", effort: "low", threadId: "thread", text: "Read the request" };
  const activate = async () => {
    const preview = await inventory.previewBaseline(), decision = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
    assert.equal((await inventory.adoptBaseline(decision)).state, "clean");
    const scheduler = new FileScheduler(schedulerPath, { journal: inventory.schedulerJournal() });
    return { preview, decision, scheduler, admission: scheduledMasterTurns({ root: turnRoot, masterId: "master", scheduler, journal: inventory.turnJournal() }) };
  };
  return { dir, root, turnRoot, cwd, schedulerPath, inventory, request, activate };
}
async function sql(path: string, command: string) {
  await new Promise<void>((accept, reject) => {
    const child = spawn("python", ["-B", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.stdin.read()); c.close()", path], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", bytes => { error += bytes; }); child.on("error", reject); child.on("close", code => code === 0 ? accept() : reject(Error(error))); child.stdin.end(command);
  });
}
async function rawRequest(f: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown>, patch?: string) {
  return withMasterStorageGuard(f.root, async () => {
    const { masterStorageTicket } = await import("../src/server/orchestration/masterStorageGuard.ts");
    return new Promise<string>((accept, reject) => {
      const args = patch ? ["-B", "-c", "import sys; sys.path.insert(0,sys.argv[1]); import negi_runtime_inventory as m\n" + patch + "\nm.main()", resolve("scripts")]
        : ["-B", resolve("scripts/negi_runtime_inventory.py")];
      const child = spawn("python", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", error = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { error += bytes; });
      child.on("error", reject); child.on("close", code => code === 0 ? accept(output) : reject(Error(error)));
      child.stdin.end(JSON.stringify({ root: f.root, context: { turnRoot: f.turnRoot, schedulerPath: f.schedulerPath }, storageTicket: masterStorageTicket(f.root), ...extra }));
    });
  }, { createIfMissing: false });
}

test("real signed runtime index stores normal turn and every shared scheduler fact", windows, async () => fixture(async f => {
  const { scheduler, admission, decision } = await f.activate();
  const lease = await admission.reserve(f.request); await lease.dispatching(); await lease.bind("turn"); await lease.complete(observation);
  const audit = await f.inventory.audit(); assert.equal(audit.state, "clean"); assert.equal(audit.artifactCount, 4);
  assert.equal((await scheduler.read()).state?.entries[0]?.status, "verified");
  const head = audit.head; await lease.complete(observation); assert.deepEqual((await f.inventory.audit()).head, head);
  assert.deepEqual((await f.inventory.adoptBaseline(decision)).head, head); // Same decision is a readonly ACK after later progress.
  await assert.rejects(new FileScheduler(f.schedulerPath).read(), /requires its journal writer/);
}));

test("explicit baseline preserves legacy bytes and refuses changed proof or a different decision", windows, async () => fixture(async f => {
  const legacy = new FileScheduler(f.schedulerPath); await legacy.ensureSubscriptionConfiguration();
  const lease = await scheduledMasterTurns({ root: f.turnRoot, masterId: "master", scheduler: legacy }).reserve(f.request); await lease.cancelBeforeDispatch();
  const original = await readFile(f.schedulerPath), requestFile = join(f.turnRoot, lease.workId, "request.json"), request = await readFile(requestFile);
  const preview = await f.inventory.previewBaseline(); await writeFile(requestFile, request.toString().replace("Read the request", "Changed request"));
  await assert.rejects(f.inventory.adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /proof changed/);
  await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" }); await assert.rejects(lstat(f.inventory.registrationPath), { code: "ENOENT" });
  await writeFile(requestFile, request); const active = await f.activate();
  assert.ok((await f.inventory.audit()).artifactCount >= 2); assert.deepEqual(await readFile(f.schedulerPath), original); assert.deepEqual(await readFile(requestFile), request);
  await assert.rejects(f.inventory.adoptBaseline({ ...active.decision, decisionId: randomUUID() }), /decision differs/);
  assert.deepEqual((await active.scheduler.read()).state?.entries.map(entry => entry.status), ["failed"]);
}));

test("missing indexed artifact or scheduler tail holds without recreate, duplicate claim or replay", windows, async () => fixture(async f => {
  const { admission, scheduler } = await f.activate(); const lease = await admission.reserve(f.request); await lease.dispatching();
  const dispatch = join(f.turnRoot, lease.workId, "dispatch.json"), original = await readFile(dispatch), log = await readFile(f.schedulerPath);
  await rm(dispatch); assert.equal((await f.inventory.audit()).state, "pending");
  await assert.rejects(lease.cancelBeforeDispatch(), /pending/); await assert.rejects(admission.reserve(f.request), /pending/);
  await assert.rejects(lstat(dispatch), { code: "ENOENT" }); assert.deepEqual(await readFile(f.schedulerPath), log);
  await writeFile(dispatch, original); const lines = log.toString().split("\n"); lines.splice(-2, 1); await writeFile(f.schedulerPath, lines.join("\n"));
  assert.deepEqual((await f.inventory.audit()).missing, ["scheduler"]); await assert.rejects(scheduler.ensureSubscriptionConfiguration(), /differs|pending/);
  assert.equal(await readFile(f.schedulerPath, "utf8"), lines.join("\n"));
}));

test("committed scheduler and turn intents remain pending after caller acknowledgement loss", windows, async () => fixture(async f => {
  const { scheduler } = await f.activate(); await scheduler.ensureSubscriptionConfiguration();
  const saved = await readFile(f.schedulerPath, "utf8"), journal = f.inventory.schedulerJournal();
  const bytes = JSON.stringify({ key: "capacity", at: "2026-10-03T00:00:00.000Z", action: { type: "set_capacity", capacity: { maxConcurrent: 2, planners: 1, workers: 1 }, sourceRef: "fixture" } }) + "\n";
  await journal.appendIntent({ path: f.schedulerPath, previousBytes: saved, bytes, event: JSON.parse(bytes) });
  const head = (await f.inventory.audit()).head; assert.equal((await f.inventory.audit()).state, "pending");
  await assert.rejects(scheduler.ensureSubscriptionConfiguration(), /differs|pending/); assert.deepEqual((await f.inventory.audit()).head, head);
  assert.equal(await readFile(f.schedulerPath, "utf8"), saved);
  // Materialization below is a deliberate fixture action, not product repair.
  await writeFile(f.schedulerPath, saved + bytes); assert.equal((await f.inventory.audit()).state, "clean");
  const workId = "master-" + randomUUID(), requestBytes = JSON.stringify({ workId }) + "\n";
  await f.inventory.turnJournal().appendIntent({ workId, relativePath: "request.json", bytes: requestBytes });
  assert.deepEqual((await f.inventory.audit()).missing, [workId + "/request.json"]);
  await assert.rejects(f.inventory.turnJournal().appendIntent({ workId, relativePath: "request.json", bytes: requestBytes }), /pending/);
  await assert.rejects(lstat(join(f.turnRoot, workId)), { code: "ENOENT" });
}));

test("persistent fence survives missing DB and partial bootstrap and never creates replacement authority", windows, async () => fixture(async f => {
  const { admission } = await f.activate(); const marker = await readFile(f.inventory.registrationPath); await rm(f.inventory.databasePath);
  await assert.rejects(f.inventory.audit(), /No such|cannot|not found|WinError/); await assert.rejects(new FileScheduler(f.schedulerPath).ensureSubscriptionConfiguration(), /requires its journal writer/);
  await assert.rejects(f.inventory.previewBaseline(), /already\/partially registered/);
  await assert.rejects(f.inventory.adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: "a".repeat(64) }), /partial bootstrap/);
  await assert.rejects(admission.reserve(f.request)); assert.deepEqual(await readFile(f.inventory.registrationPath), marker); await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
}));

test("foreign scheduler lock holds adoption before marker creation", windows, async () => fixture(async f => {
  const preview = await f.inventory.previewBaseline(); await writeFile(f.schedulerPath + ".lock", "foreign");
  await assert.rejects(f.inventory.adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /exclusion unavailable/);
  assert.equal(await readFile(f.schedulerPath + ".lock", "utf8"), "foreign"); await assert.rejects(lstat(f.inventory.registrationPath), { code: "ENOENT" });
}));

test("signed event corruption, unexpected schema and registration mutation hold", windows, async () => fixture(async f => {
  const { scheduler } = await f.activate(); await scheduler.ensureSubscriptionConfiguration();
  const original = await readFile(f.inventory.databasePath), marker = await readFile(f.inventory.registrationPath);
  await sql(f.inventory.databasePath, "UPDATE events SET signature='" + "a".repeat(64) + "' WHERE seq=1;"); await assert.rejects(f.inventory.audit(), /authentication/);
  await writeFile(f.inventory.databasePath, original); await sql(f.inventory.databasePath, "CREATE TABLE extra (x TEXT);"); await assert.rejects(f.inventory.audit(), /schema/);
  await writeFile(f.inventory.databasePath, original); await writeFile(f.inventory.registrationPath, marker.toString().replace("proofSha256", "wrongHash")); await assert.rejects(f.inventory.audit(), /marker changed/);
  await writeFile(f.inventory.registrationPath, marker); assert.equal((await f.inventory.audit()).state, "clean");
}));

test("hardlinks, unindexed files and partial published turn artifacts are never adopted on read", windows, async () => fixture(async f => {
  const { admission } = await f.activate(); const lease = await admission.reserve(f.request), request = join(f.turnRoot, lease.workId, "request.json");
  await link(request, join(f.dir, "linked")); await assert.rejects(f.inventory.audit(), /hardlink|linked|file type/); await rm(join(f.dir, "linked"));
  await writeFile(join(f.turnRoot, lease.workId, "dispatch.json"), "partial"); await assert.rejects(f.inventory.audit(), /unindexed/);
  await rm(join(f.turnRoot, lease.workId, "dispatch.json")); await lease.dispatching(); await writeFile(join(f.turnRoot, lease.workId, "dispatch.json"), "partial");
  await assert.rejects(f.inventory.audit(), /changed\/partial/); await assert.rejects(lease.cancelBeforeDispatch());
}));

test("direct helper rejects stale head and duplicate scheduler keys without a second signed intent", windows, async () => fixture(async f => {
  const { scheduler } = await f.activate(); await scheduler.ensureSubscriptionConfiguration(); const before = await f.inventory.audit(), bytes = await readFile(f.schedulerPath, "utf8");
  const event = JSON.stringify({ key: "subscription:configure", at: "2026-10-03T00:00:00.000Z", action: { type: "configure" } }) + "\n";
  const input = { action: "appendScheduler", expectedHead: before.head, bytes: event, previousSha256: hash(bytes), previousBytes: Buffer.byteLength(bytes) };
  await assert.rejects(rawRequest(f, { ...input, expectedHead: { ...before.head, seq: before.head.seq - 1 } }), /stale/);
  await assert.rejects(rawRequest(f, input), /key/); assert.deepEqual((await f.inventory.audit()).head, before.head); assert.equal(await readFile(f.schedulerPath, "utf8"), bytes);
}));

test("real signed scheduler supports planning release, worker start, same-key ACK and the last shared slot", windows, async () => fixture(async f => {
  const { scheduler } = await f.activate(); await scheduler.ensureSubscriptionConfiguration({ maxConcurrent: 1, planners: 1, workers: 1 });
  const event = (key: string, action: Parameters<FileScheduler["append"]>[0]["action"]) => ({ key, at: "2026-10-03T00:00:00.000Z", action });
  await scheduler.append(event("pipeline", { type: "submit", work: { id: "pipeline", parentId: null, dependencies: [], role: "sol", checkout: f.cwd,
    checkoutMode: "write", resources: [], reserveUsd: 0, execution: "astra_to_sol" } }));
  await scheduler.startNext("plan-start");
  await scheduler.append(event("plan-done", { type: "finish_planning", workId: "pipeline", planRef: "plan#sha256=" + "a".repeat(64), threadId: "thread", turnId: "turn" }));
  await scheduler.tryStartWorker("pipeline", "worker");
  const settled = event("done", { type: "settle", workId: "pipeline", outcome: "verified", evidenceRef: "result", actualCostUsd: null });
  await scheduler.append(settled); const head = (await f.inventory.audit()).head; await scheduler.append(settled); assert.deepEqual((await f.inventory.audit()).head, head);
  for (const id of ["one", "two"]) await scheduler.append(event("submit-" + id, { type: "submit", work: { id, parentId: null, dependencies: [], role: "sol",
    checkout: join(f.cwd, id), checkoutMode: "write", resources: [], reserveUsd: 0, execution: "direct" } }));
  const peer = new FileScheduler(f.schedulerPath, { journal: f.inventory.schedulerJournal() });
  const claims = await Promise.all([scheduler.tryClaim("one", "claim-one"), peer.tryClaim("two", "claim-two")]);
  assert.equal(claims.filter(Boolean).length, 1); assert.equal((await peer.read()).state?.entries.filter(entry => entry.status === "running").length, 1);
  assert.equal((await f.inventory.audit()).state, "clean");
}));

test("actual bootstrap process exit keeps its marker and SQLite files for inspection", windows, async () => fixture(async f => {
  const preview = await f.inventory.previewBaseline(), decision = { decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 };
  await withMasterStorageGuard(f.root, async () => {
    const { masterStorageTicket } = await import("../src/server/orchestration/masterStorageGuard.ts");
    const code = "import sys,os; sys.path.insert(0,sys.argv[1]); import negi_runtime_inventory as m; original=m.RuntimeInventory.add\ndef crash(self,*args,**kwargs):\n result=original(self,*args,**kwargs); os._exit(83)\nm.RuntimeInventory.add=crash; m.main()";
    const exit = await new Promise<number | null>((accept, reject) => {
      const child = spawn("python", ["-B", "-c", code, resolve("scripts")], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      child.stderr.resume(); child.on("error", reject); child.on("close", accept);
      child.stdin.end(JSON.stringify({ action: "adopt", root: f.root, context: { turnRoot: f.turnRoot, schedulerPath: f.schedulerPath }, storageTicket: masterStorageTicket(f.root), ...decision }));
    });
    assert.equal(exit, 83);
  });
  const marker = await readFile(f.inventory.registrationPath), database = await readFile(f.inventory.databasePath);
  await assert.rejects(f.inventory.audit()); await assert.rejects(f.inventory.adoptBaseline(decision));
  await assert.rejects(new FileScheduler(f.schedulerPath).ensureSubscriptionConfiguration(), /requires its journal writer/);
  assert.deepEqual(await readFile(f.inventory.registrationPath), marker); assert.deepEqual(await readFile(f.inventory.databasePath), database);
  await assert.rejects(lstat(f.schedulerPath), { code: "ENOENT" }); await assert.rejects(lstat(f.schedulerPath + ".lock"), { code: "ENOENT" });
}));

test("runtime namespaces cannot overlap the signing authority or turn evidence", windows, async () => fixture(async f => {
  for (const context of [{ turnRoot: f.root, schedulerPath: f.schedulerPath },
    { turnRoot: f.turnRoot, schedulerPath: join(f.root, "masters", "master", "scheduler.jsonl") },
    { turnRoot: f.turnRoot, schedulerPath: join(f.turnRoot, "nested.jsonl") }]) {
    const inventory = new RuntimeJournalInventory({ root: f.root, ...context });
    await assert.rejects(inventory.previewBaseline(), /namespaces overlap/);
    await assert.rejects(lstat(inventory.databasePath), { code: "ENOENT" }); await assert.rejects(lstat(inventory.registrationPath), { code: "ENOENT" });
  }
}));

test("default Master refuses a runtime fence before creating its missing turn root", windows, async () => fixture(async f => {
  await f.activate(); const missing = join(f.dir, "must-not-create"), legacy = new FileScheduler(f.schedulerPath);
  await assert.rejects(scheduledMasterTurns({ root: missing, masterId: "master", scheduler: legacy }).reserve(f.request), /requires its journal writer/);
  await assert.rejects(lstat(missing), { code: "ENOENT" }); await assert.rejects(lstat(f.schedulerPath + ".lock"), { code: "ENOENT" });
}));

test("mismatched baseline work identity is refused before irreversible marker or DB publication", windows, async () => fixture(async f => {
  const workId = "master-" + randomUUID(), directory = join(f.turnRoot, workId), file = join(directory, "request.json");
  await mkdir(directory); const valid = JSON.stringify({ workId }) + "\n"; await writeFile(file, valid);
  const preview = await f.inventory.previewBaseline(); await writeFile(file, JSON.stringify({ workId: "master-" + randomUUID() }) + "\n");
  await assert.rejects(f.inventory.previewBaseline(), /work identity/);
  await assert.rejects(f.inventory.adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 }), /work identity/);
  await assert.rejects(lstat(f.inventory.registrationPath), { code: "ENOENT" }); await assert.rejects(lstat(f.inventory.databasePath), { code: "ENOENT" });
  await writeFile(file, valid); assert.equal((await f.activate()).preview.artifactCount, 1);
}));

test("adoption while default reservation is paused cannot publish an unindexed request", windows, async () => fixture(async f => {
  const scheduler = new FileScheduler(f.schedulerPath); await scheduler.ensureSubscriptionConfiguration();
  const configure = scheduler.ensureSubscriptionConfiguration.bind(scheduler); let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(accept => { entered = accept; }), pause = new Promise<void>(accept => { resume = accept; });
  scheduler.ensureSubscriptionConfiguration = async (...args) => { const state = await configure(...args); entered(); await pause; return state; };
  const pending = scheduledMasterTurns({ root: f.turnRoot, masterId: "master", scheduler }).reserve(f.request);
  const result = assert.rejects(pending, /requires its journal writer/); await ready;
  await f.activate(); const before = await f.inventory.audit(); resume(); await result;
  assert.equal((await f.inventory.audit()).state, "clean"); assert.deepEqual((await f.inventory.audit()).head, before.head);
  assert.equal(before.artifactCount, 0); await assert.rejects(lstat(f.schedulerPath + ".lock"), { code: "ENOENT" });
}));

test("adoption while a default lease publication waits cannot write an unindexed dispatch", windows, async () => fixture(async f => {
  const scheduler = new FileScheduler(f.schedulerPath), lease = await scheduledMasterTurns({ root: f.turnRoot, masterId: "master", scheduler }).reserve(f.request);
  const publish = scheduler.withUnindexedArtifacts.bind(scheduler); let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(accept => { entered = accept; }), pause = new Promise<void>(accept => { resume = accept; });
  scheduler.withUnindexedArtifacts = async run => { entered(); await pause; return publish(run); };
  const result = assert.rejects(lease.dispatching(), /requires its journal writer/); await ready;
  await f.activate(); const before = await f.inventory.audit(); resume(); await result;
  await assert.rejects(lstat(join(f.turnRoot, lease.workId, "dispatch.json")), { code: "ENOENT" });
  assert.deepEqual((await f.inventory.audit()).head, before.head); assert.equal((await f.inventory.audit()).state, "clean");
}));

test("an empty baseline scheduler retains its signed presence and a missing one stays pending", windows, async () => fixture(async f => {
  await writeFile(f.schedulerPath, ""); const { scheduler } = await f.activate(); await rm(f.schedulerPath);
  assert.equal((await f.inventory.audit()).schedulerPresent, true); assert.deepEqual((await f.inventory.audit()).missing, ["scheduler"]);
  await assert.rejects(scheduler.ensureSubscriptionConfiguration(), /pending/); await assert.rejects(lstat(f.schedulerPath), { code: "ENOENT" });
}));

test("SQLite page capacity rejects a large intent before signed commit or scheduler publication", windows, async () => fixture(async f => {
  const { scheduler } = await f.activate(); await scheduler.ensureSubscriptionConfiguration(); const before = await f.inventory.audit(), bytes = await readFile(f.schedulerPath, "utf8");
  const event = JSON.stringify({ key: "large", at: "2026-10-03T00:00:00.000Z", action: { type: "set_capacity", capacity: { maxConcurrent: 2, planners: 1, workers: 1 }, sourceRef: "x".repeat(100000) } }) + "\n";
  const patch = "original=m.RuntimeInventory.__init__\ndef limited(self,r):\n original(self,r); m.MAX_DATABASE_BYTES=self.db.stat().st_size\nm.RuntimeInventory.__init__=limited";
  await assert.rejects(rawRequest(f, { action: "appendScheduler", expectedHead: before.head, bytes: event, previousSha256: hash(bytes), previousBytes: Buffer.byteLength(bytes) }, patch), /full|capacity/);
  assert.deepEqual((await f.inventory.audit()).head, before.head); assert.equal((await f.inventory.audit()).state, "clean"); assert.equal(await readFile(f.schedulerPath, "utf8"), bytes);
}));

test("turn directory capacity is enforced before saving its new request intent", windows, async () => fixture(async f => {
  const { admission } = await f.activate(); await admission.reserve(f.request); const before = await f.inventory.audit(), workId = "master-" + randomUUID();
  await assert.rejects(rawRequest(f, { action: "appendTurn", expectedHead: before.head, relativePath: workId + "/request.json", bytes: JSON.stringify({ workId }) + "\n" }, "m.MAX_TURNS=1"), /directory capacity before intent/);
  assert.deepEqual((await f.inventory.audit()).head, before.head); assert.equal((await f.inventory.audit()).state, "clean");
  await assert.rejects(lstat(join(f.turnRoot, workId)), { code: "ENOENT" });
}));
