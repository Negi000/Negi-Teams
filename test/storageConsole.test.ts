import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { LocalStorageConsole, checkedStorageDecision, type StorageDecision } from "../src/server/orchestration/storageConsole.ts";
import { createStorageHttp } from "../src/server/orchestration/storageHttp.ts";
import { storagePageHtml } from "../src/server/orchestration/storagePage.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { withMasterStorageGuard } from "../src/server/orchestration/masterStorageGuard.ts";
import { setup } from "./helpers/taskAuthoringFixture.ts";

const host = (maintenance = true) => ({ maintenance, executionHeld: true, startupError: null });
const decision = (): StorageDecision => ({ operation: "stage-adopt", decisionId: randomUUID(),
  proofSha256: "a".repeat(64), registrationSha256: "b".repeat(64) });
async function http(service: LocalStorageConsole | null, run: (base: string, send: (path: string, value: unknown, headers?: Record<string, string>) => Promise<Response>) => Promise<void>, maintenance = true) {
  const handler = createStorageHttp(service, { token: "fixture-token" }, () => host(maintenance));
  const server = createServer((req, res) => { void handler(req, res, new URL(req.url!, "http://localhost")).then(done => { if (!done) { res.writeHead(404);res.end(); } }); });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (path: string, value: unknown, headers = {}) => fetch(base + path, { method: "POST", headers: {
    cookie: "ebi_auth=fixture-token", origin: base, "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  try { await run(base, send); } finally { server.closeAllConnections();await new Promise<void>(accept => server.close(() => accept())); }
}

test("storage HTTP requires the authenticated cookie even on loopback, keeps login destination and never mutates on reads", async () => {
  let calls = 0;
  const fake = { status: async () => { calls++;return host(); }, preview: async () => { throw Error(); }, apply: async () => { throw Error(); } } as unknown as LocalStorageConsole;
  await http(fake, async (base, send) => {
    const unauth = await fetch(base + "/storage", { redirect: "manual" });assert.equal(unauth.status, 302);assert.equal(unauth.headers.get("location"), "/login?returnTo=/storage");
    assert.equal((await fetch(base + "/api/storage", { headers: { authorization: "Bearer fixture-token" } })).status, 401);
    assert.equal((await send("/api/storage/apply", { decision: decision(), confirmed: true }, { cookie: "ebi_auth=%GG" })).status, 401);
    assert.equal(calls, 0);
    const page = await fetch(base + "/storage", { headers: { cookie: "ebi_auth=fixture-token" } });assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>保存状態<\/h1>/);assert.equal(page.headers.get("x-frame-options"), "DENY");assert.equal(calls, 0);
    const status = await fetch(base + "/api/storage", { headers: { cookie: "ebi_auth=fixture-token" } });assert.equal(status.headers.get("cache-control"), "no-store");assert.equal(calls, 1);
    assert.equal((await send("/api/storage/apply", { decision: decision(), confirmed: true }, { origin: "https://outside.example" })).status, 403);
    assert.equal((await send("/api/storage/apply", { decision: decision(), confirmed: true }, { origin: "null" })).status, 403);
    assert.equal((await send("/api/storage/apply", { decision: decision(), confirmed: true }, { origin: "ftp://" + new URL(base).host })).status, 403);
    assert.equal((await fetch(base + "/api/storage/other", { headers: { cookie: "ebi_auth=fixture-token" } })).status, 405);
  });
  await http(null, async base => {
    const status = await fetch(base + "/api/storage", { headers: { cookie: "ebi_auth=fixture-token" } });assert.equal((await status.json()).available, false);
  });
});

test("storage HTTP accepts exact fixed decisions only in confirmed maintenance and never accepts paths or mode from the browser", async () => {
  const values: StorageDecision[] = [], target = decision();let previews = 0;
  const fake = { preview: async () => { previews++;return { decision: target }; }, apply: async (value: StorageDecision) => { values.push(value);return { decision: value, executionStarted: false }; } } as unknown as LocalStorageConsole;
  await http(fake, async (_base, send) => {
    for (const input of [null, [], { operation: "initialize" }, { operation: "stage-adopt", root: "C:/other" }]) assert.equal((await send("/api/storage/preview", input)).status, 409);
    for (const input of [{ decision: target }, { decision: target, confirmed: false }, { decision: { ...target, root: "C:/other" }, confirmed: true },
      { decision: { ...target, decisionId: "invalid" }, confirmed: true }, { decision: { ...target, proofSha256: "invalid" }, confirmed: true },
      { decision: target, confirmed: true, storage: "indexed" }]) assert.equal((await send("/api/storage/apply", input)).status, 409);
    assert.equal((await send("/api/storage/preview", { operation: "stage-adopt" }, { "content-type": "text/plain" })).status, 409);
    assert.equal((await send("/api/storage/apply", { decision: target, confirmed: true, extra: "x".repeat(5000) })).status, 409);
    assert.equal(values.length, 0);assert.equal(previews, 0);
    assert.equal((await send("/api/storage/preview", { operation: "stage-adopt" })).status, 200);
    assert.equal((await send("/api/storage/apply", { decision: target, confirmed: true })).status, 200);assert.deepEqual(values, [target]);
  });
  await http(fake, async (_base, send) => {
    assert.equal((await send("/api/storage/apply", { decision: target, confirmed: true })).status, 409);assert.equal(values.length, 1);
    assert.equal((await send("/api/storage/preview", { operation: "stage-adopt" })).status, 200);
  }, false);
});

test("maintenance page scripts parse and storage decisions snapshot inputs", () => {
  const html = storagePageHtml();for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  const source = decision(), frozen = checkedStorageDecision(source);source.decisionId = randomUUID();assert.notEqual(frozen.decisionId, source.decisionId);
  for (const operation of ["initialize", "__proto__", "constructor"]) assert.throws(() => checkedStorageDecision({ ...source, operation }));
});

test("trusted catalog inspection reads canonical registration without creating Task stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-storage-catalog-"));
  try {
    const stateRoot = join(dir, "state"), schedulerPath = join(dir, "scheduler.jsonl"), before = await readdir(dir);
    const result = await LocalTaskService.inspectStorageRegistration({ stateRoot, schedulerPath, runs: [] });
    assert.deepEqual(result, { root: join(stateRoot, "master-conversations"), turnRoot: join(stateRoot, "master-turns"), schedulerPath });
    assert.deepEqual(await readdir(dir), before);
    for (const raw of [{ stateRoot: "relative", schedulerPath, runs: [] }, { stateRoot, runs: [] }, { stateRoot, schedulerPath, runs: "invalid" }])
      await assert.rejects(LocalTaskService.inspectStorageRegistration(raw));
    assert.deepEqual(await readdir(dir), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const windows = { skip: process.platform !== "win32" };
test("Windows catalog inspection preserves legacy case-only scheduler aliases before the file exists", windows, async () => {
  const f = await setup();let tasks: LocalTaskService | null = null;
  try {
    await f.tasks.close();await unlink(f.config.schedulerPath);
    const catalog = { ...f.catalog, schedulerPath: join(dirname(f.config.schedulerPath), basename(f.config.schedulerPath).toUpperCase()),
      runs: [{ title: "Legacy case alias", config: f.config }] };
    assert.notEqual(catalog.schedulerPath, f.config.schedulerPath);
    const registered = await LocalTaskService.inspectStorageRegistration(catalog);
    assert.equal(registered.schedulerPath, f.config.schedulerPath);
    await assert.rejects(lstat(f.config.schedulerPath), { code: "ENOENT" });
    tasks = await LocalTaskService.open(catalog, f.runtime);
    assert.equal(tasks.registeredScheduler(f.config.schedulerPath).path, registered.schedulerPath);
    assert.deepEqual(f.calls(), { astra: 0, sol: 0 });
  } finally { await tasks?.close();await f.close(); }
});
async function nativeFixture(run: (registration: { root: string; turnRoot: string; schedulerPath: string; masterId: string }, dir: string) => Promise<void>, missing = false) {
  const dir = await mkdtemp(join(tmpdir(), "negi-storage-console-")), root = join(dir, "authority"), turnRoot = join(dir, "turns"), schedulerPath = join(dir, "scheduler.jsonl");
  try {
    if (!missing) {
      await mkdir(join(root, "masters", "master"), { recursive: true });await mkdir(turnRoot);
      await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: randomBytes(32).toString("hex") }) + "\n");
      await withMasterStorageGuard(root, async () => {});
    }
    await run({ root, turnRoot, schedulerPath, masterId: "master" }, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("missing-root status, preview and refused decision never bootstrap authority, guard or databases", windows, async () => nativeFixture(async (registration, dir) => {
  const service = new LocalStorageConsole(registration, () => host()), before = await readdir(dir);
  const state = await service.status();assert.equal(state.stage.state, "held");assert.equal(state.runtime.state, "held");
  for (const operation of ["stage-adopt", "runtime-adopt", "database-recover"] as const) {
    await assert.rejects(service.preview(operation));
    await assert.rejects(service.apply({ ...decision(), operation, registrationSha256: service.registrationSha256 }));
    assert.deepEqual(await readdir(dir), before);
  }
}, true));

test("authenticated maintenance adopts actual stage/runtime stores, rechecks the same decision after progress and keeps default execution held", windows, async () => nativeFixture(async registration => {
  let maintenance = true;
  const service = new LocalStorageConsole(registration, () => host(maintenance));
  const keyBefore = await readFile(join(registration.root, "signing-key.json"));
  await service.assertLegacyExecutionAllowed();
  const stage = await service.preview("stage-adopt");
  await assert.rejects(service.apply({ ...stage.decision, registrationSha256: "0".repeat(64) }));
  maintenance = false;await assert.rejects(service.apply(stage.decision));maintenance = true;
  await http(service, async (_base, send) => {
    const applied = await send("/api/storage/apply", { decision: stage.decision, confirmed: true });assert.equal(applied.status, 200);
    assert.equal((await applied.json()).executionStarted, false);
  });
  await assert.rejects(service.assertLegacyExecutionAllowed());
  const stageDb = registration.root + ".inventory.sqlite3", stageBytes = await readFile(stageDb);
  const reopened = new LocalStorageConsole(registration, () => host());assert.deepEqual((await reopened.apply(stage.decision)).decision, stage.decision);
  assert.deepEqual(await readFile(stageDb), stageBytes);await assert.rejects(reopened.apply({ ...stage.decision, decisionId: randomUUID() }));
  const runtime = await reopened.preview("runtime-adopt"), result = await reopened.apply(runtime.decision);assert.equal(result.activation, "held");
  const inventory = new RuntimeJournalInventory(registration), scheduler = new FileScheduler(registration.schedulerPath, { journal: inventory.schedulerJournal() });
  await scheduler.ensureSubscriptionConfiguration();const head = (await inventory.audit()).head, bytes = await readFile(inventory.databasePath);
  await reopened.apply(runtime.decision);assert.deepEqual((await inventory.audit()).head, head);assert.deepEqual(await readFile(inventory.databasePath), bytes);
  await assert.rejects(reopened.apply({ ...runtime.decision, decisionId: randomUUID() }));
  assert.deepEqual(await readFile(join(registration.root, "signing-key.json")), keyBefore);
  const status = await reopened.status();assert.equal(status.stage.state, "clean");assert.equal(status.runtime.state, "clean");
  await assert.rejects(reopened.assertLegacyExecutionAllowed());await assert.rejects(new FileScheduler(registration.schedulerPath).read());
}));

test("storage console recovers an actual hot journal using the approved proof and same ID without dispatch", windows, async () => nativeFixture(async registration => {
  const inventory = new MasterConversationInventory({ root: registration.root, masterId: registration.masterId });await inventory.initialize();
  const baseline = await readFile(inventory.databasePath), script = "import sqlite3,sys,os\nc=sqlite3.connect(sys.argv[1],isolation_level=None);c.execute('PRAGMA synchronous=FULL');c.execute('PRAGMA cache_size=1');c.execute('BEGIN IMMEDIATE');c.execute('UPDATE meta SET body=randomblob(65536)');os._exit(23)";
  const child = spawn("python", ["-B", "-c", script, inventory.databasePath], { windowsHide: true, stdio: "ignore" });
  const exit = await new Promise<number | null>((accept, reject) => { child.once("error", reject);child.once("close", accept); });assert.equal(exit, 23);
  const journal = await readFile(inventory.databasePath + "-journal");assert.equal(journal.subarray(0, 8).toString("hex"), "d9d505f920a163d7");
  const service = new LocalStorageConsole(registration, () => host()), preview = await service.preview("database-recover");
  assert.deepEqual(await readFile(inventory.databasePath + "-journal"), journal);
  const result = await service.apply(preview.decision);assert.equal(result.executionStarted, false);assert.equal(result.activation, "held");
  assert.deepEqual(await readFile(inventory.databasePath), baseline);await assert.rejects(lstat(inventory.databasePath + "-journal"), { code: "ENOENT" });
  const reopened = new LocalStorageConsole(registration, () => host());assert.deepEqual(await reopened.apply(preview.decision), result);
}));

test("startup with registered stage storage preserves files and serves authenticated diagnostics while fixed, control and WS spawn stay held", windows, async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-storage-startup-"));let child: ReturnType<typeof spawn> | null = null;
  try {
    const stateRoot = join(dir, "state");await mkdir(stateRoot);const catalog = join(dir, "tasks.json"), config = join(dir, "config.json"),
      stageDb = join(stateRoot, "master-conversations.inventory.sqlite3");
    const original = Buffer.from("preserve this database without SQLite reads");await writeFile(stageDb, original);
    await writeFile(catalog, JSON.stringify({ stateRoot, schedulerPath: join(dir, "scheduler.jsonl"), runs: [] }));
    await writeFile(config, JSON.stringify({ fixedEbi: [] }));
    const probe = createServer();await new Promise<void>(accept => probe.listen(0, "127.0.0.1", accept));const port = (probe.address() as { port: number }).port;
    await new Promise<void>(accept => probe.close(() => accept()));
    const env = { ...process.env, EBI_PORT: String(port), EBI_HOST: "127.0.0.1", EBI_AUTH_TOKEN: "fixture-token", EBI_CONFIG_PATH: config,
      NEGI_TASK_CONFIG: catalog, NEGI_SETUP_ROOT: "", NEGI_REVIEW_CONFIG: "", NEGI_TASK_AUTHORING_CONFIG: "", NEGI_INTEGRATION_CONFIG: "", NEGI_KNOWLEDGE_CONFIG: "", NEGI_STORAGE_MAINTENANCE: "0", EBI_IDLE_NOTIFY: "off" };
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/server/index.ts")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";child.stdout!.on("data", bytes => { output += bytes; });child.stderr!.on("data", bytes => { output += bytes; });
    const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 30_000;
    for (;;) {
      try { const response = await fetch(base + "/api/storage", { headers: { cookie: "ebi_auth=fixture-token" } });if (response.ok) break; } catch {}
      assert.equal(child.exitCode, null, output);assert.ok(Date.now() < deadline, "Diagnostic HTTP startup timed out");await new Promise(accept => setTimeout(accept, 100));
    }
    const status = await fetch(base + "/api/storage", { headers: { cookie: "ebi_auth=fixture-token" } });const value = await status.json();
    assert.equal(value.available, true);assert.equal(value.executionHeld, true);assert.equal(value.maintenance, false);
    assert.equal((await fetch(base + "/storage", { headers: { cookie: "ebi_auth=fixture-token" } })).status, 200);
    assert.equal((await fetch(base + "/storage", { redirect: "manual" })).status, 302);
    assert.equal((await fetch(base + "/control/spawn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: process.execPath }) })).status, 503);
    assert.equal((await fetch(base + "/api/tasks/fixture/start", { method: "POST", body: "{}" })).status, 503);
    const { WebSocket } = await import("ws");const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    try {
      await new Promise<void>((accept, reject) => { ws.once("open", accept);ws.once("error", reject); });
      const messages: unknown[] = [];ws.on("message", bytes => { messages.push(JSON.parse(String(bytes))); });
      ws.send(JSON.stringify({ type: "spawn", command: process.execPath }));
      const deadline = Date.now() + 5000;
      while (!messages.some(row => (row as { type: string }).type === "error")) { assert.ok(Date.now() < deadline, JSON.stringify(messages));await new Promise(accept => setTimeout(accept, 50)); }
      assert.ok(!messages.some(row => (row as { type: string }).type === "spawned"));
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) { const closed = new Promise<void>(accept => ws.once("close", () => accept()));ws.close();await closed; }
    }
    assert.deepEqual(await readFile(stageDb), original);await assert.rejects(lstat(join(stateRoot, "operation-proofs")), { code: "ENOENT" });
    assert.doesNotMatch(output, /固定エビを自動起動/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(accept => child!.once("close", () => accept()));child.kill();await closed; }
    await rm(dir, { recursive: true, force: true });
  }
});
