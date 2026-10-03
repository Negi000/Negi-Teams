import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { WebSocket } from "ws";
import { CodexAppServerClient, type CodexThreadOptions } from "../src/server/master/appServerClient.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { indexedStartupFixture } from "./helpers/indexedStartupFixture.ts";
import { masterStorageTicket } from "../src/server/orchestration/masterStorageGuard.ts";
import { MasterSession } from "../src/server/master/session.ts";
import { CODEX_READ_ONLY_BRAIN_CAPABILITIES } from "../src/server/master/codexAppServerBrain.ts";
import type { MasterBrain, MasterEvent } from "../src/server/master/brain.ts";

const options: CodexThreadOptions = { cwd: process.cwd(), model: "fixture-astra", sandbox: "read-only", resident: { effort: "medium", modelProvider: "openai" } };
function clientFixture(patch: (method: string, result: Record<string, unknown>) => Record<string, unknown> = (_method, result) => result) {
  const input = new PassThrough(), output = new PassThrough(), messages: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  let buffer = "", count = 0, current = "";
  const metadata = () => ({ id: current, cwd: options.cwd, model: options.model, modelProvider: "openai", reasoningEffort: "medium", status: { type: "idle" }, ephemeral: false, turns: [] });
  const response = () => ({ thread: metadata(), cwd: options.cwd, model: options.model, modelProvider: "openai", reasoningEffort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } });
  output.on("data", bytes => {
    buffer += String(bytes); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const q = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(q);
      if (q.id === undefined) continue;
      let result: Record<string, unknown> = {};
      if (q.method === "initialize") result = { userAgent: "resident-test" };
      if (q.method === "model/list") result = { data: [{ model: options.model, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], inputModalities: ["text"] }], nextCursor: null };
      if (q.method === "thread/start") { current = "thread-" + (++count); result = response(); }
      if (q.method === "thread/resume") { current = q.params.threadId; result = response(); }
      if (q.method === "thread/read") { current = q.params.threadId; result = { thread: metadata() }; }
      if (q.method === "thread/turns/list") result = { data: [], nextCursor: null };
      if (q.method === "turn/start") result = { turn: { id: "active-turn" } };
      input.write(JSON.stringify({ id: q.id, result: patch(q.method, result) }) + "\n");
    }
  });
  const client = new CodexAppServerClient(input, output);
  return { client, messages, init: async () => { await client.initialize(); await client.discoverModels(); } };
}

test("resident rotation pins the old identity and cannot rotate while a turn is active", async () => {
  const f = clientFixture(); try {
    await f.init(); const first = await f.client.startThread(options);
    await assert.rejects(f.client.rotateThread(options, "foreign-thread"));
    assert.equal(f.messages.filter(q => q.method === "thread/start").length, 1);
    const second = await f.client.rotateThread(options, first.threadId); assert.notEqual(second.threadId, first.threadId);
    await f.client.startTurn("explicit input", "medium"); await assert.rejects(f.client.rotateThread(options, second.threadId));
    assert.equal(f.messages.filter(q => q.method === "thread/start").length, 2);
  } finally { f.client.close(); }
});

for (const field of ["cwd", "policy", "effort", "network", "state", "long-id", "control-id"] as const) test("resident rejects returned " + field + " mismatch before admitting input", async () => {
  const f = clientFixture((method, result) => {
    if (method !== "thread/start") return result;
    if (field === "cwd") return { ...result, cwd: "E:/foreign" };
    if (field === "policy") return { ...result, approvalPolicy: "never" };
    if (field === "effort") return { ...result, reasoningEffort: "low" };
    if (field === "network") return { ...result, sandbox: { type: "readOnly", networkAccess: true } };
    if (field === "long-id" || field === "control-id") return { ...result, thread: { ...(result.thread as object), id: field === "long-id" ? "a".repeat(201) : "bad\nid" } };
    return { ...result, thread: { ...(result.thread as object), status: { type: "active" } } };
  }); try { await f.init(); await assert.rejects(f.client.startThread(options)); assert.equal(f.client.dispatchBlocked, true); await assert.rejects(f.client.startTurn("do not replay", "medium")); }
  finally { f.client.close(); }
});

test("resume verifies terminal turn inventory and does not resend inputs", async () => {
  const f = clientFixture(); try {
    await f.init(); await f.client.verifyResidentTurns("saved", options, []);
    await f.client.resumeThread("saved", options.model, options); assert.equal(f.client.dispatchBlocked, true);
    await f.client.verifyResidentTurns("saved", options, []); f.client.markReconciled("saved", null, "signed-fixture");
    assert.equal(f.client.dispatchBlocked, false); assert.equal(f.messages.filter(q => q.method === "thread/start" || q.method === "turn/start").length, 0);
  } finally { f.client.close(); }
  for (const status of ["completed", "inProgress"]) {
    const changed = clientFixture((method, result) => method === "thread/turns/list" ? { data: [{ id: "foreign-turn", status }], nextCursor: null } : result);
    try { await changed.init(); await assert.rejects(changed.client.verifyResidentTurns("saved", options, [])); assert.equal(changed.messages.some(q => q.method === "thread/resume"), false); }
    finally { changed.client.close(); }
  }
});

const windows = { skip: process.platform !== "win32" };
test("display restoration neither repeats a recorded boundary nor mixes old tail with a newly bound conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-resident-display-"));
  try {
    for (const evidence of ["recorded", "truncated", "gap", "duplicate"]) {
      const recorded = evidence === "recorded", requestId = randomUUID(), log = join(dir, evidence + ".jsonl"), oldThreadId = "old", newThreadId = "new";
      const rows = recorded ? [
        { seq: 1, ts: 1, threadId: oldThreadId, event: { kind: "text", text: "old history", partial: false } },
        { seq: 2, ts: 2, threadId: newThreadId, event: { kind: "cleared", requestId, oldThreadId, newThreadId } },
        ...[3, 4, 5].map(seq => ({ seq, ts: seq, threadId: newThreadId, event: { kind: "text", text: "current history " + seq, partial: false } }))
      ] : (evidence === "truncated" ? [7, 8] : evidence === "gap" ? [1, 3] : [1, 1]).map(seq => ({ seq, ts: seq,
        threadId: evidence === "truncated" ? oldThreadId : newThreadId, event: { kind: "text", text: "retained history", partial: false } }));
      await writeFile(log, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      let finish!: () => void; const stopped = new Promise<void>(accept => { finish = accept; });
      const brain: MasterBrain = { id: "codex", capabilities: CODEX_READ_ONLY_BRAIN_CAPABILITIES, unsupported: [], pid: 123,
        conversationBoundary: { requestId, oldThreadId, newThreadId }, sessionId: () => newThreadId, start: async () => {},
        send: async () => ({ acked: true }), answer: async () => {}, interrupt: async () => {}, stop: async () => { finish(); },
        events: () => ({ async *[Symbol.asyncIterator]() { await stopped; } }) };
      const events: MasterEvent[] = [], session = new MasterSession({ id: "master", brainId: "codex", cwd: dir, model: options.model,
        permissionMode: "plan", systemPrompt: null, mcpConfigPath: null, extraArgs: [], logPath: log, snapshotLimit: 2, registeredConversations: true,
        createBrain: () => brain, handlers: { onEvent: (_id, item) => { events.push(item.event as MasterEvent); }, onState: () => {}, onNotice: () => {}, onUsage: () => {}, onRateLimits: () => {}, onRegistryChange: () => {} } });
      try {
        await session.start(); const snapshot = session.snapshot();
        assert.equal(events.some(event => (event as { kind: string }).kind === "cleared"), false);
        assert.equal(snapshot.events.length, evidence === "truncated" ? 0 : 2);
        assert.ok(snapshot.events.every(item => item.threadId === newThreadId));
      } finally { await session.stop(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("resident provider wait releases the shared storage guard while retaining the exact Master owner", windows, async () => {
  const f = await indexedStartupFixture(); let tasks: LocalTaskService | undefined;
  try {
    await f.prepare(); tasks = await LocalTaskService.open(f.bundle.tasks, undefined, { storage: "indexed" });
    const authority = tasks.masterConversationAuthority("negi-master"), inventory = new RuntimeJournalInventory(f.registration), scheduler = new FileScheduler(f.registration.schedulerPath, { journal: inventory.schedulerJournal() });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(accept => { release = accept; }), ready = new Promise<void>(accept => { entered = accept; });
    const request = { requestId: randomUUID(), masterId: "negi-master", mode: "start" as const, oldThreadId: null, cwd: f.repo, model: "fixture-astra", effort: "medium", provider: "openai", settingsSha256: "a".repeat(64) };
    const pending = authority.start(request, async mark => { await mark(); entered(); await gate; return { threadId: "detached-thread", requestedModel: request.model, resolvedModel: request.model, modelProvider: "openai", rerouted: false }; }, { resident: true });
    try {
      await ready; assert.equal((await authority.status(request.requestId))!.exclusionHeld, true);
      const state = await scheduler.read(); assert.ok(state);
      await scheduler.append({ key: "independent-capacity-observation", at: new Date().toISOString(), action: { type: "set_capacity",
        capacity: { maxConcurrent: 3, planners: 1, workers: 2 }, sourceRef: "user:independent-fixture" } });
      await assert.rejects(authority.admitTurn({ requestId: randomUUID(), cwd: f.repo, model: request.model, effort: request.effort, threadId: "detached-thread", text: "not admitted" }));
    } finally { release(); await pending; }
    assert.equal((await pending).stage, "completed"); assert.equal((await authority.resident(f.repo)).current!.identity!.threadId, "detached-thread");
    await assert.rejects(authority.admitTurn({ requestId: randomUUID(), cwd: f.repo, model: request.model,
      effort: request.effort, threadId: "stale-thread", text: "not admitted" }, { resident: true }));
    assert.equal((await inventory.audit()).state, "clean");
  } finally { await tasks?.close(); await f.close(); }
});

test("an unconfirmed provider rotation preserves the confirmed display identity and history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-resident-unconfirmed-display-")), log = join(dir, "chat.jsonl");
  let providerThread = "confirmed-old", finish!: () => void; const stopped = new Promise<void>(accept => { finish = accept; });
  const brain: MasterBrain = { id: "codex", capabilities: CODEX_READ_ONLY_BRAIN_CAPABILITIES, unsupported: [], pid: 123,
    sessionId: () => providerThread, start: async () => {}, newConversation: async () => { providerThread = "unconfirmed-new"; throw Error("durable binding failed"); },
    send: async () => ({ acked: true }), answer: async () => {}, interrupt: async () => {}, stop: async () => { finish(); },
    events: () => ({ async *[Symbol.asyncIterator]() { await stopped; } }) };
  const session = new MasterSession({ id: "master", brainId: "codex", cwd: dir, model: options.model, permissionMode: "plan",
    systemPrompt: null, mcpConfigPath: null, extraArgs: [], logPath: log, registeredConversations: true, createBrain: () => brain,
    handlers: { onEvent: () => {}, onState: () => {}, onNotice: () => {}, onUsage: () => {}, onRateLimits: () => {}, onRegistryChange: () => {} } });
  try {
    await writeFile(log, JSON.stringify({ seq: 1, ts: 1, threadId: providerThread, event: { kind: "text", text: "confirmed history", partial: false } }) + "\n");
    await session.start(); await assert.rejects(session.newConversation({ requestId: randomUUID(), oldThreadId: "confirmed-old" }));
    assert.equal(session.currentThreadId, "confirmed-old"); assert.equal(session.snapshot().events[0]!.threadId, "confirmed-old");
    assert.equal(session.snapshot().events.some(item => item.event.kind === "cleared"), false);
  } finally { await session.stop(); await rm(dir, { recursive: true, force: true }); }
});

async function connect(base: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws"), messages: Record<string, any>[] = [];
  ws.on("message", bytes => messages.push(JSON.parse(String(bytes))));
  await new Promise<void>((accept, reject) => { ws.once("open", accept); ws.once("error", reject); });
  const until = async (check: () => boolean) => { const end = Date.now() + 90_000; while (!check()) { assert.ok(Date.now() < end, JSON.stringify(messages)); await new Promise(accept => setTimeout(accept, 50)); } };
  const close = async () => { const done = new Promise<void>(accept => ws.once("close", () => accept())); ws.close(); await done; };
  return { ws, messages, until, close };
}

test("normal server rotates once, queries after disconnect, rejects stale confirmation and restores the rotated thread", windows, async () => {
  const f = await indexedStartupFixture(); let server: Awaited<ReturnType<typeof f.launch>> | undefined;
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await f.prepare(); server = await f.launch({ mode: "indexed" }); await server.until(v => !v.executionHeld);
    socket = await connect(server.base); await socket.until(() => socket!.messages.some(q => q.type === "chatSnapshot" && q.threadId));
    const oldThreadId = socket.messages.find(q => q.type === "chatSnapshot")!.threadId;
    const requestId = randomUUID(); socket.ws.send(JSON.stringify({ type: "chatNew", id: "negi-master", requestId, oldThreadId }));
    await socket.close(); socket = await connect(server.base);
    socket.ws.send(JSON.stringify({ type: "chatConversationStatus", id: "negi-master", requestId }));
    await socket.until(() => socket!.messages.some(q => q.type === "chatEvent" && q.event.kind === "cleared") || socket!.messages.some(q => q.type === "chatSnapshot" && q.threadId !== oldThreadId));
    socket.ws.send(JSON.stringify({ type: "chatNew", id: "negi-master", requestId, oldThreadId }));
    await socket.until(() => socket!.messages.some(q => q.type === "chatConversationResult" && q.requestId === requestId && q.state === "completed"));
    const result = socket.messages.find(q => q.type === "chatConversationResult" && q.state === "completed")!;
    assert.notEqual(result.newThreadId, oldThreadId); assert.equal((await server.messages()).filter(q => q.method === "thread/start").length, 2);
    const stale = randomUUID(); socket.ws.send(JSON.stringify({ type: "chatNew", id: "negi-master", requestId: stale, oldThreadId }));
    await socket.until(() => socket!.messages.some(q => q.type === "chatConversationResult" && q.requestId === stale));
    assert.equal(socket.messages.filter(q => q.type === "chatState").at(-1)?.state, "idle");
    socket.ws.send(JSON.stringify({ type: "chatSend", id: "negi-master", text: "新しい会話で続けてください。", requestId: randomUUID() }));
    await socket.until(() => socket!.messages.some(q => q.type === "chatEvent" && q.event.kind === "turnEnd"));
    await socket.close(); socket = undefined; await server.stop();
    server = await f.launch({ mode: "indexed" }); await server.until(v => !v.executionHeld);
    const requests = await server.messages(); assert.equal(requests.filter(q => q.method === "thread/start" || q.method === "turn/start").length, 0);
    assert.equal(requests.find(q => q.method === "thread/resume")!.params.threadId, result.newThreadId);
    assert.equal((await new RuntimeJournalInventory(f.registration).audit()).state, "clean");
    const state = JSON.parse(await readFile(f.providerState, "utf8")); state.fault = "response-cwd"; await writeFile(f.providerState, JSON.stringify(state));
    socket = await connect(server.base); const unknown = randomUUID(); socket.ws.send(JSON.stringify({ type: "chatNew", id: "negi-master", requestId: unknown, oldThreadId: result.newThreadId }));
    await socket.until(() => socket!.messages.some(q => q.type === "chatConversationResult" && q.requestId === unknown && q.state === "attention"));
    assert.equal((await server.messages()).filter(q => q.method === "thread/start").length, 1);
    socket.ws.send(JSON.stringify({ type: "chatNew", id: "negi-master", requestId: unknown, oldThreadId: result.newThreadId }));
    await socket.until(() => socket!.messages.filter(q => q.type === "chatConversationResult" && q.requestId === unknown).length >= 2);
    assert.equal((await server.messages()).filter(q => q.method === "thread/start").length, 1);
    await socket.close(); socket = undefined; await server.stop(); server = undefined;
    server = await f.launch({ mode: "indexed" }); await server.until(v => v.executionHeld);
    const held = await server.messages(); assert.equal(held.filter(q => ["thread/start", "thread/resume", "turn/start"].includes(q.method)).length, 0);
    socket = await connect(server.base); socket.ws.send(JSON.stringify({ type: "chatConversationStatus", id: "negi-master", requestId: unknown }));
    await socket.until(() => socket!.messages.some(q => q.type === "chatConversationResult" && q.requestId === unknown && q.state === "attention"));
    const statusResponse = await fetch(server.base + "/api/storage/conversation?request=" + unknown, { headers: server.headers });
    assert.equal(statusResponse.status, 200); assert.equal((await statusResponse.json()).state, "attention");
    assert.equal((await fetch(server.base + "/api/storage/conversation?request=" + unknown)).status, 401);
    assert.equal((await fetch(server.base + "/api/storage/conversation?request=invalid", { headers: server.headers })).status, 400);
    assert.equal((await fetch(server.base + "/api/storage/conversation?request=" + unknown, { method: "POST", headers: server.headers })).status, 405);
    assert.equal((await server.messages()).filter(q => ["thread/start", "thread/resume", "turn/start"].includes(q.method)).length, 0);
  } finally { await socket?.close(); await server?.stop(); await f.close(); }
});

test("a signed owner without its first stage remains attention and queryable before normal startup", windows, async () => {
  const f = await indexedStartupFixture(); let tasks: LocalTaskService | undefined, server: Awaited<ReturnType<typeof f.launch>> | undefined;
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await f.prepare(); tasks = await LocalTaskService.open(f.bundle.tasks, undefined, { storage: "indexed" });
    const authority = tasks.masterConversationAuthority("negi-master"), original = authority.withStorage.bind(authority);
    const requestId = randomUUID(), ownerPath = join(f.registration.root, "masters", "negi-master", "owner.lock");
    let pause = false, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(accept => { release = accept; }), ready = new Promise<void>(accept => { entered = accept; });
    authority.withStorage = async run => {
      if (!pause && !masterStorageTicket(f.registration.root)) {
        const owner = await readFile(ownerPath, "utf8").catch(() => null);
        if (owner) { pause = true; entered(); await gate; }
      }
      return original(run);
    };
    const pending = authority.start({ requestId, masterId: "negi-master", mode: "start", oldThreadId: null, cwd: f.repo, model: "fixture-astra", effort: "medium", provider: "openai", settingsSha256: "a".repeat(64) },
      async mark => { await mark(); return { threadId: "owner-first", requestedModel: "fixture-astra", resolvedModel: "fixture-astra", modelProvider: "openai", rerouted: false }; }, { resident: true });
    try {
      await ready; assert.equal(await authority.status(requestId), null); assert.equal(await authority.pendingResidentRequest(requestId), true);
      assert.equal((await f.console.conversationStatus(requestId)).ownerPending, true);
      server = await f.launch({ mode: "indexed" }); await server.until(v => v.executionHeld); assert.equal((await server.messages()).length, 0);
      socket = await connect(server.base); socket.ws.send(JSON.stringify({ type: "chatConversationStatus", id: "negi-master", requestId }));
      await socket.until(() => socket!.messages.some(q => q.type === "chatConversationResult" && q.requestId === requestId && q.state === "attention"));
    } finally { release(); await pending; }
  } finally { await socket?.close(); await server?.stop(); await tasks?.close(); await f.close(); }
});
