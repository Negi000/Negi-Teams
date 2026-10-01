import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CodexAppServerClient, type CodexApprovalRequest, type CodexDynamicToolCall, type CodexDynamicToolResult, type CodexDynamicToolLimits } from "../src/server/master/appServerClient.ts";

function fakeServer(handle: (request: Record<string, unknown>) => unknown,
                    options: ConstructorParameters<typeof CodexAppServerClient>[2] = {}) {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  let buffer = "";
  fromClient.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      messages.push(message);
      if (message.id !== undefined && message.method) {
        const result = handle(message);
        if (result !== undefined) toClient.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      }
    }
  });
  const client = new CodexAppServerClient(toClient, fromClient, options);
  const notify = (method: string, params: unknown) =>
    toClient.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { client, messages, notify, toClient };
}

function basic(request: Record<string, unknown>): unknown {
  switch (request.method) {
    case "initialize": return { userAgent: "codex-test", codexHome: "C:/test", platformFamily: "windows", platformOs: "windows" };
    case "model/list": return { data: [{ model: "gpt-6-astra", supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "" }], inputModalities: ["text"] }], nextCursor: null };
    case "thread/start": return { thread: { id: "thread-a" }, model: "gpt-6-astra", modelProvider: "openai" };
    case "thread/resume": return { thread: { id: "thread-a" }, model: "gpt-6-astra", modelProvider: "openai" };
    case "turn/start": return { turn: { id: "turn-a", status: "inProgress" } };
    case "turn/interrupt": return {};
    default: throw new Error(`unexpected request: ${request.method}`);
  }
}

const taskTool = { type: "function" as const, name: "negi_dispatch_task", description: "Fixed Task dispatch",
  inputSchema: { type: "object", additionalProperties: false } };
async function dynamicFixture(handler: (call: CodexDynamicToolCall) => Promise<CodexDynamicToolResult>,
                              limits?: Record<string, CodexDynamicToolLimits>) {
  const f = fakeServer(basic, { onDynamicToolCall: handler });
  await f.client.initialize(); await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only", dynamicTools: [taskTool], dynamicToolLimits: limits });
  await f.client.startTurn("delegate fixed Task", "medium");
  const call = (id: string, overrides: Record<string, unknown> = {}) => f.toClient.write(JSON.stringify({
    jsonrpc: "2.0", id, method: "item/tool/call", params: { threadId: "thread-a", turnId: "turn-a",
      callId: "call-a", namespace: null, tool: taskTool.name, arguments: { run_id: "task-a" }, ...overrides } }) + "\n");
  return { ...f, call };
}
const microtasks = () => new Promise<void>(resolve => setImmediate(resolve));

test("host-owned native limits admit bounded Japanese plans and project context without exposing limits to the provider", async () => {
  let calls = 0;
  let resultText = "仕様".repeat(7000);
  const limits = { [taskTool.name]: { argumentBytes: 50_000, resultBytes: 64_000 } };
  const f = await dynamicFixture(async () => { calls++; return { success: true, text: resultText }; }, limits);
  try {
    limits[taskTool.name].argumentBytes = 64_000; // Host input is copied at registration.
    const start = f.messages.find(m => m.method === "thread/start")!.params as Record<string, unknown>;
    assert.deepEqual(start.dynamicTools, [taskTool]); assert.equal(start.dynamicToolLimits, undefined);
    f.call("japanese-plan", { arguments: { plan: "仕様".repeat(4000) } });
    f.call("duplicate-plan", { arguments: { plan: "仕様".repeat(4000) } });
    await microtasks(); assert.equal(calls, 1);
    const result = f.messages.find(m => m.id === "japanese-plan")!.result as { success: boolean; contentItems: Array<{text: string}> };
    assert.equal(result.success, true); assert.equal(Buffer.byteLength(result.contentItems[0].text), 42_000);
    f.call("over-host-limit", { callId: "too-large", arguments: { plan: "仕様".repeat(9000) } });
    assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602); assert.equal(calls, 1);
    f.call("foreign-large", { tool: "unregistered", arguments: { plan: "仕様".repeat(4000) } });
    assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602);
    resultText = "x".repeat(64_001);
    f.call("over-result-limit", { callId: "large-result", arguments: {} }); await microtasks();
    assert.equal((f.messages.find(m => m.id === "over-result-limit")!.result as Record<string, unknown>).success, false);
    assert.equal(calls, 2);
  } finally { f.client.close(); }
});

test("unregistered or unbounded native limit overrides fail before starting a provider thread", async () => {
  const inherited = Object.assign(Object.create({ argumentBytes: 64_000, resultBytes: 64_000 }), { a: 1, b: 2 });
  for (const limits of [{ unregistered: { argumentBytes: 50_000, resultBytes: 64_000 } },
    { [taskTool.name]: { argumentBytes: 64_001, resultBytes: 24_000 } },
    { [taskTool.name]: { argumentBytes: 8000, resultBytes: 0 } }, { [taskTool.name]: inherited }]) {
    const f = fakeServer(basic, {onDynamicToolCall: async () => ({ success: true, text: "ok" })});
    try {
      await f.client.initialize(); await f.client.discoverModels();
      await assert.rejects(f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only",
        dynamicTools: [taskTool], dynamicToolLimits: limits }), /limits invalid/);
      assert.equal(f.messages.some(m => m.method === "thread/start"), false);
    } finally { f.client.close(); }
  }
});

test("prototype names and inherited limit entries retain default native bounds", async () => {
  for (const name of ["__proto__", taskTool.name]) {
    let calls = 0;
    const f = fakeServer(basic, { onDynamicToolCall: async () => { calls++; return { success: true, text: "x".repeat(24_001) }; } });
    try {
      await f.client.initialize(); await f.client.discoverModels();
      await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only",
        dynamicTools: [{ ...taskTool, name }],
        dynamicToolLimits: Object.create({ [name]: { argumentBytes: 64_000, resultBytes: 64_000 } }) });
      await f.client.startTurn("test bounds", "medium");
      const call = (id: string, args: unknown) => f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id,
        method: "item/tool/call", params: { threadId: "thread-a", turnId: "turn-a", callId: id, tool: name, arguments: args } }) + "\n");
      call("oversized", "x".repeat(8001));
      assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602); assert.equal(calls, 0);
      call("default-result", {}); await microtasks(); assert.equal(calls, 1);
      assert.equal((f.messages.find(m => m.id === "default-result")!.result as Record<string, unknown>).success, false);
    } finally { f.client.close(); }
  }
});

test("registered native tool opts into the protocol and coalesces duplicate calls without repeating dispatch", async () => {
  let calls = 0, release!: (result: CodexDynamicToolResult) => void;
  const result = new Promise<CodexDynamicToolResult>(resolve => { release = resolve; });
  const f = await dynamicFixture(async call => { calls++; assert.equal(call.callId, "call-a"); return result; });
  try {
    assert.deepEqual((f.messages[0].params as Record<string, unknown>).capabilities, { experimentalApi: true });
    assert.deepEqual((f.messages.find(m => m.method === "thread/start")!.params as Record<string, unknown>).dynamicTools, [taskTool]);
    f.call("tool-1"); f.call("tool-2");
    await microtasks(); assert.equal(calls, 1);
    f.call("tool-changed", { arguments: { run_id: "task-b" } });
    assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602);
    release({ success: true, text: "queued" }); await microtasks();
    for (const id of ["tool-1", "tool-2"]) assert.deepEqual(f.messages.find(m => m.id === id)?.result,
      { contentItems: [{ type: "inputText", text: "queued" }], success: true });
    f.call("tool-3"); await microtasks(); assert.equal(calls, 1);
  } finally { f.client.close(); }
});

test("foreign, stale, unregistered and oversized native calls cannot reach the Task service", async () => {
  let calls = 0;
  const f = await dynamicFixture(async () => { calls++; return { success: true, text: "ok" }; });
  try {
    for (const [index, overrides] of [{ threadId: "other" }, { turnId: "other" }, { namespace: "other" },
      { tool: "negi_accept_task" }, { callId: "" }, { arguments: "x".repeat(8001) }].entries()) {
      f.call(`invalid-${index}`, overrides);
      assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602);
    }
    f.call("before-completion");
    // Turn completion in the same input batch prevents the deferred mutation.
    f.notify("turn/completed", { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } });
    await microtasks(); assert.equal(calls, 0);
    assert.equal((f.messages.find(m => m.id === "before-completion")!.result as Record<string, unknown>).success, false);
    f.call("after-completion"); assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602);
  } finally { f.client.close(); }
});

test("native handler failure or oversized result is returned once without provider details or automatic rerun", async () => {
  for (const failure of ["throw", "oversized"]) {
    let calls = 0;
    const f = await dynamicFixture(async () => {
      calls++; if (failure === "throw") throw new Error("private provider detail");
      return { success: true, text: "x".repeat(24001) };
    });
    try {
      f.call("failure"); await microtasks(); f.call("failure-repeat"); await microtasks();
      assert.equal(calls, 1);
      const result = f.messages.find(m => m.id === "failure")!.result as { success: boolean; contentItems: Array<{ text: string }> };
      assert.equal(result.success, false); assert.match(result.contentItems[0].text, /再委任せず/);
      assert.equal(JSON.stringify(result).includes("private provider detail"), false);
    } finally { f.client.close(); }
  }
});

test("worker clients cannot register planner tools and unsupported native calls are rejected", async () => {
  const f = fakeServer(basic);
  try {
    await f.client.initialize(); await f.client.discoverModels();
    await assert.rejects(f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only",
      dynamicTools: [taskTool] }), /registry invalid/);
    assert.equal(f.messages.some(m => m.method === "thread/start"), false);
    f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: "worker-tool", method: "item/tool/call",
      params: { threadId: "thread-a", turnId: "turn-a", callId: "call-a", tool: taskTool.name, arguments: {} } }) + "\n");
    assert.equal((f.messages.at(-1)!.error as Record<string, unknown>).code, -32602);
  } finally { f.client.close(); }
});

test("provider disconnect after Task dispatch does not replay the operation", async () => {
  let calls = 0, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await dynamicFixture(async () => { calls++; await waiting; return { success: true, text: "queued" }; });
  f.call("disconnect"); await microtasks(); assert.equal(calls, 1);
  f.client.close(); release(); await microtasks(); assert.equal(calls, 1);
});

test("initialize, discover capability, start exact model and observe one turn", async () => {
  const f = fakeServer(basic);
  await f.client.initialize();
  assert.equal(f.messages[0].method, "initialize");
  assert.equal(f.messages[1].method, "initialized");
  const models = await f.client.discoverModels();
  assert.deepEqual(models[0].efforts, ["medium"]);
  const identity = await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "workspace-write" });
  assert.equal(identity.rerouted, false);
  const started = f.messages.find((x) => x.method === "thread/start")!;
  assert.equal((started.params as Record<string, unknown>).approvalPolicy, "on-request");
  await assert.rejects(f.client.startTurn("work", "ultra"), /effort not supported/);
  const turnId = await f.client.startTurn("work", "medium");
  assert.equal(turnId, "turn-a");
  const start = f.messages.find((x) => x.method === "turn/start")!;
  assert.deepEqual((start.params as Record<string, unknown>).input,
    [{ type: "text", text: "work", text_elements: [] }]);
  f.notify("thread/tokenUsage/updated", { threadId: "thread-a", turnId,
    tokenUsage: { total: { inputTokens: 900 }, last: { inputTokens: 120, outputTokens: 15,
      cachedInputTokens: 80, reasoningOutputTokens: 5 }, modelContextWindow: 200000 } });
  f.notify("item/completed", { threadId: "thread-a", turnId,
    item: { type: "agentMessage", phase: "final_answer", text: "planned" } });
  f.notify("turn/completed", { threadId: "thread-a", turn: { id: turnId, status: "completed" } });
  assert.equal(f.client.activeTurn, null);
  assert.equal((await f.client.waitForTurn(turnId, 100)).status, "completed");
  assert.deepEqual(f.client.getObservation(turnId), { turnId, status: "completed",
    finalText: "planned", contextInputTokens: 120, contextWindow: 200000,
    lastUsage: { inputTokens: 120, outputTokens: 15, cachedInputTokens: 80,
      reasoningOutputTokens: 5 } });
  f.client.close();
});

test("account mode inspection retains the billing path without returning personal account fields", async () => {
  const f = fakeServer((request) => request.method === "account/read" ? {
    account: { type: "chatgpt", email: "private@example.invalid", planType: "pro" }, requiresOpenaiAuth: true,
  } : basic(request));
  await f.client.initialize();
  assert.deepEqual(await f.client.readAccountMode(), { type: "chatgpt", requiresOpenaiAuth: true });
  assert.deepEqual(f.messages.find((message) => message.method === "account/read")?.params, { refreshToken: false });
  f.client.close();
  const malformed = fakeServer((request) => request.method === "account/read" ? { requiresOpenaiAuth: true } : basic(request));
  await malformed.client.initialize();
  await assert.rejects(malformed.client.readAccountMode(), /schema mismatch/);
  malformed.client.close();
});

test("a foreign or unscoped notification cannot complete the active turn", async () => {
  const f = fakeServer(basic);
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const turnId = await f.client.startTurn("plan", "medium");
  f.notify("turn/completed", { threadId: "thread-other", turn: { id: turnId, status: "completed" } });
  f.notify("turn/completed", { turn: { id: turnId, status: "completed" } });
  assert.equal(f.client.activeTurn, turnId);
  assert.equal(f.client.getObservation(turnId)?.status, "inProgress");
  f.notify("turn/completed", { threadId: "thread-a", turn: { id: turnId, status: "completed" } });
  assert.equal((await f.client.waitForTurn(turnId, 100)).status, "completed");
  f.client.close();
});

test("text turn is rejected when the account catalog lacks text input", async () => {
  const f = fakeServer((request) => request.method === "model/list"
    ? { data: [{ model: "gpt-6-astra", supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "" }], inputModalities: ["image"] }], nextCursor: null }
    : basic(request));
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  await assert.rejects(f.client.startTurn("plan", "medium"), /text input/);
  assert.equal(f.messages.filter((x) => x.method === "turn/start").length, 0);
  f.client.close();
});

test("concurrent turn/start calls cannot dispatch a second turn before the first is acknowledged", async () => {
  const f = fakeServer((request) => request.method === "turn/start" ? undefined : basic(request));
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const pending = f.client.startTurn("first", "medium");
  await assert.rejects(f.client.startTurn("second", "medium"), /turn cannot start/);
  const dispatched = f.messages.filter((message) => message.method === "turn/start");
  assert.equal(dispatched.length, 1);
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: dispatched[0]!.id,
    result: { turn: { id: "turn-a", status: "inProgress" } } }) + "\n");
  assert.equal(await pending, "turn-a");
  f.client.close();
});

test("concurrent thread/start calls cannot create an untracked second thread", async () => {
  const f = fakeServer((request) => request.method === "thread/start" ? undefined : basic(request));
  await f.client.initialize();
  await f.client.discoverModels();
  const options = { cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" as const };
  const pending = f.client.startThread(options);
  await assert.rejects(f.client.startThread(options), /thread already started, uncertain/);
  const dispatched = f.messages.filter((message) => message.method === "thread/start");
  assert.equal(dispatched.length, 1);
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: dispatched[0]!.id,
    result: { thread: { id: "thread-a" }, model: "gpt-6-astra", modelProvider: "openai" } }) + "\n");
  assert.equal((await pending).threadId, "thread-a");
  f.client.close();
});

test("unknown or unsolicited same-thread turns block further dispatch for reconciliation", async () => {
  const unknown = fakeServer(basic);
  await unknown.client.initialize();
  await unknown.client.discoverModels();
  await unknown.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const turnId = await unknown.client.startTurn("plan", "medium");
  unknown.notify("turn/completed", { threadId: "thread-a",
    turn: { id: turnId, status: "futureStatus" } });
  assert.equal(unknown.client.dispatchBlocked, true);
  assert.equal((await unknown.client.waitForTurn(turnId, 100)).status, "unknown");
  await assert.rejects(unknown.client.startTurn("next", "medium"), /turn cannot start/);
  unknown.client.close();

  const unsolicited = fakeServer(basic);
  await unsolicited.client.initialize();
  await unsolicited.client.discoverModels();
  await unsolicited.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  unsolicited.notify("turn/started", { threadId: "thread-a",
    turn: { id: "external-turn", status: "inProgress" } });
  assert.equal(unsolicited.client.dispatchBlocked, true);
  assert.equal(unsolicited.client.activeTurn, "external-turn");
  await assert.rejects(unsolicited.client.startTurn("next", "medium"), /turn cannot start/);
  unsolicited.client.close();

  const unsolicitedItem = fakeServer(basic);
  await unsolicitedItem.client.initialize();
  await unsolicitedItem.client.discoverModels();
  await unsolicitedItem.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  unsolicitedItem.notify("item/completed", { threadId: "thread-a", turnId: "external-turn",
    item: { type: "agentMessage", phase: "final_answer", text: "external work" } });
  unsolicitedItem.notify("turn/completed", { threadId: "thread-a",
    turn: { id: "external-turn", status: "completed" } });
  assert.equal(unsolicitedItem.client.dispatchBlocked, true);
  await assert.rejects(unsolicitedItem.client.startTurn("next", "medium"), /turn cannot start/);
  unsolicitedItem.client.close();
});

test("rerouted model and uncertain start are never silently dispatched", async () => {
  const reroute = fakeServer((request) => request.method === "thread/start"
    ? { thread: { id: "thread-a" }, model: "gpt-6-sol", modelProvider: "openai" } : basic(request));
  await reroute.client.initialize();
  await reroute.client.discoverModels();
  const identity = await reroute.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  assert.equal(identity.rerouted, true);
  await assert.rejects(reroute.client.startTurn("plan", "medium"), /cannot start/);
  reroute.client.close();

  const timeout = fakeServer((request) => request.method === "thread/start" ? undefined : basic(request),
    { transportTimeoutMs: 10 });
  await timeout.client.initialize();
  await timeout.client.discoverModels();
  await assert.rejects(timeout.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra",
    sandbox: "read-only" }), /outcome unknown/);
  assert.equal(timeout.client.dispatchBlocked, true);
  await assert.rejects(timeout.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra",
    sandbox: "read-only" }), /uncertain/);
  assert.equal(timeout.messages.filter((x) => x.method === "thread/start").length, 1);
  timeout.client.close();
});

test("approval binds the live thread, turn, item and target; resume needs reconciliation", async () => {
  let approval: CodexApprovalRequest | undefined;
  let now = 1000;
  const f = fakeServer(basic, { now: () => now, approvalTtlMs: 1000,
    onApproval: (value) => { approval = value; } });
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "workspace-write" });
  await f.client.startTurn("work", "medium");
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: "approve-1",
    method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "item-1", command: "echo hello",
    startedAtMs: now, kind: "command", environmentId: null,
    } }) + "\n");
  assert.equal(approval?.target, "echo hello");
  assert.throws(() => f.client.answerApproval({ ...approval!, target: "echo other" }, true), /mismatched/);
  const firstApproval = approval!;
  f.client.answerApproval(firstApproval, false);
  assert.deepEqual(f.messages.at(-1), { jsonrpc: "2.0", id: "approve-1", result: { decision: "decline" } });
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: "approve-2",
    method: "item/fileChange/requestApproval", params: { threadId: "thread-a", turnId: "turn-a",
      itemId: "item-2", grantRoot: "E:/repo", startedAtMs: now } }) + "\n");
  now = 3000;
  assert.throws(() => f.client.answerApproval(firstApproval, true), /stale|mismatched/);
  assert.throws(() => f.client.answerApproval(f.client.pendingApprovals[0], true), /expired/);
  f.client.close();

  const resumed = fakeServer(basic);
  await resumed.client.initialize();
  await resumed.client.discoverModels();
  await resumed.client.resumeThread("thread-a", "gpt-6-astra");
  assert.equal(resumed.client.dispatchBlocked, true);
  await assert.rejects(resumed.client.startTurn("continue", "medium"), /cannot start/);
  resumed.client.markReconciled("thread-a", null, "local:provider-read-and-diff-reviewed");
  assert.equal(resumed.client.dispatchBlocked, false);
  resumed.client.close();
});

test("read-only provider inspection pages to an exact turn without unblocking dispatch", async () => {
  const f = fakeServer((request) => {
    if (request.method === "thread/read") return { thread: { id: "thread-a" } };
    if (request.method === "thread/turns/list") {
      const cursor = (request.params as Record<string, unknown>).cursor;
      return cursor === null
        ? { data: [{ id: "newer", status: "completed" }], nextCursor: "page-2" }
        : { data: [{ id: "target", status: "failed" }], nextCursor: null };
    }
    return basic(request);
  }, { now: () => 1234 });
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.resumeThread("thread-a", "gpt-6-astra");
  const inspection = await f.client.inspectProviderTurn("thread-a", "target");
  assert.deepEqual(inspection, { threadId: "thread-a", turnId: "target", found: true,
    status: "failed", pagesRead: 2, completeSearch: true, observedAtMs: 1234,
    source: "thread/turns/list" });
  assert.equal(f.client.dispatchBlocked, true);
  await assert.rejects(f.client.startTurn("retry", "medium"), /cannot start/);
  assert.deepEqual((f.messages.find((x) => x.method === "thread/read")?.params as Record<string, unknown>),
    { threadId: "thread-a", includeTurns: false });
  const pages = f.messages.filter((x) => x.method === "thread/turns/list");
  assert.equal(pages.length, 2);
  assert.equal((pages[0].params as Record<string, unknown>).itemsView, "notLoaded");
  assert.equal(f.messages.filter((x) => x.method === "turn/start").length, 0);
  f.client.close();
});

test("managed provider inspection pins the registered checkout and provider before reading turns",async()=>{
  for(const thread of [{id:"thread-a",cwd:"E:/other",modelProvider:"openai"},
    {id:"thread-a",cwd:"E:/repo",modelProvider:"other"},{id:"thread-a",cwd:"E:\\repo",modelProvider:"openai"}]){
    const f=fakeServer(request=>request.method==="thread/read"?{thread}:request.method==="thread/turns/list"?
      {data:[{id:"target",status:"interrupted"}],nextCursor:null}:basic(request));
    try{await f.client.initialize();if(thread.modelProvider==="openai"&&thread.cwd==="E:\\repo"){
      assert.equal((await f.client.inspectProviderTurn("thread-a","target",20,{cwd:process.platform==="win32"?"E:/repo":"E:\\repo",modelProvider:"openai"})).status,"interrupted");
    }else{await assert.rejects(f.client.inspectProviderTurn("thread-a","target",20,{cwd:"E:/repo",modelProvider:"openai"}),/checkout or provider/);
      assert.equal(f.messages.some(m=>m.method==="thread/turns/list"),false)}
      assert.equal(f.messages.some(m=>["thread/start","thread/resume","turn/start"].includes(String(m.method))),false);
    }finally{f.client.close()}
  }
});

test("provider inspection bounds unknown outcomes and rejects mismatched metadata", async () => {
  const endless = fakeServer((request) => {
    if (request.method === "thread/read") return { thread: { id: "thread-a" } };
    if (request.method === "thread/turns/list") return { data: [], nextCursor: "more" };
    return basic(request);
  }, { now: () => 5678 });
  await endless.client.initialize();
  await endless.client.discoverModels();
  await endless.client.resumeThread("thread-a", "gpt-6-astra");
  assert.deepEqual(await endless.client.inspectProviderTurn("thread-a", "target", 1), {
    threadId: "thread-a", turnId: "target", found: false, status: null,
    pagesRead: 1, completeSearch: false, observedAtMs: 5678,
    source: "thread/turns/list",
  });
  assert.equal(endless.client.dispatchBlocked, true);
  await assert.rejects(endless.client.inspectProviderTurn("thread-a", "target", 3), /cursor repeated/);
  assert.equal(endless.client.dispatchBlocked, true);
  endless.client.close();

  const mismatch = fakeServer((request) => request.method === "thread/read"
    ? { thread: { id: "other-thread" } } : basic(request));
  await mismatch.client.initialize();
  await mismatch.client.discoverModels();
  await mismatch.client.resumeThread("thread-a", "gpt-6-astra");
  await assert.rejects(mismatch.client.inspectProviderTurn("thread-a", "target"), /identity mismatch/);
  assert.equal(mismatch.messages.filter((x) => x.method === "thread/turns/list").length, 0);
  assert.equal(mismatch.client.dispatchBlocked, true);
  mismatch.client.close();

  const absent = fakeServer((request) => {
    if (request.method === "thread/read") return { thread: { id: "thread-a" } };
    if (request.method === "thread/turns/list") return { data: [], nextCursor: null };
    return basic(request);
  }, { now: () => 9876 });
  await absent.client.initialize();
  await absent.client.discoverModels();
  await absent.client.resumeThread("thread-a", "gpt-6-astra");
  assert.deepEqual(await absent.client.inspectProviderTurn("thread-a", "missing"), {
    threadId: "thread-a", turnId: "missing", found: false, status: null,
    pagesRead: 1, completeSearch: true, observedAtMs: 9876,
    source: "thread/turns/list",
  });
  assert.equal(absent.client.dispatchBlocked, true);
  absent.client.close();
});

test("exact-turn process inspection holds executable, unknown, incomplete and changing histories",async()=>{
  for(const mode of ["passive","passive-pages","command","unknown","foreign","changing","endless","duplicate","cursor-repeat"]){
    let lists=0;
    const f=fakeServer(request=>{
      if(request.method==="thread/read")return{thread:{id:"thread-a",cwd:"E:/repo",modelProvider:"openai"}};
      if(request.method==="thread/turns/list")return{data:[{id:"target",status:mode==="changing"&&lists++>0?"inProgress":"interrupted"}],nextCursor:null};
      if(request.method==="thread/items/list"){const params=request.params as {cursor:string|null};
        return{data:[{turnId:mode==="foreign"?"other":"target",item:{id:mode==="duplicate"?"same":mode==="cursor-repeat"?String(Math.random()):params.cursor??"item",type:mode==="command"?"commandExecution":mode==="unknown"?"newTool":"agentMessage"}}],
          nextCursor:mode==="endless"?String(Number(params.cursor??0)+1):["duplicate","cursor-repeat"].includes(mode)?"repeat":mode==="passive-pages"&&!params.cursor?"second":null};}
      return basic(request);
    });
    try{await f.client.initialize();if(["foreign","duplicate","cursor-repeat"].includes(mode)){
      await assert.rejects(f.client.inspectProviderTurnProcessSafety("thread-a","target",{cwd:"E:/repo",modelProvider:"openai"}),/another turn|duplicated an item|cursor repeated/);
    }else{const result=await f.client.inspectProviderTurnProcessSafety("thread-a","target",{cwd:"E:/repo",modelProvider:"openai"});
      assert.equal(result.processSafety.noExecutableItems,["passive","passive-pages"].includes(mode));if(mode==="passive-pages")assert.equal(result.processSafety.pagesRead,2);if(["changing","endless"].includes(mode))assert.equal(result.processSafety.complete,false);
      assert.ok(result.processSafety.pagesRead<=20);}
      assert.equal(f.messages.some(m=>["thread/start","thread/resume","turn/start","turn/interrupt"].includes(String(m.method))),false);
    }finally{f.client.close()}
  }
});
test("provider checkout case identity follows the host filesystem",async()=>{
  const f=fakeServer(request=>request.method==="thread/read"?{thread:{id:"thread-a",cwd:"/srv/Repo",modelProvider:"openai"}}:
    request.method==="thread/turns/list"?{data:[{id:"target",status:"interrupted"}],nextCursor:null}:basic(request));
  try{await f.client.initialize();const operation=f.client.inspectProviderTurn("thread-a","target",20,{cwd:"/srv/repo",modelProvider:"openai"});
    if(process.platform==="win32")assert.equal((await operation).status,"interrupted");else await assert.rejects(operation,/checkout or provider/);
  }finally{f.client.close()}
});

test("missing approval handler and foreign turn requests fail closed", async () => {
  const f = fakeServer(basic);
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  await f.client.startTurn("plan", "medium");
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: 91,
    method: "item/fileChange/requestApproval", params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "item-1", startedAtMs: 1000,
    } }) + "\n");
  assert.deepEqual(f.messages.at(-1), { jsonrpc: "2.0", id: 91,
    result: { decision: "decline" } });
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: 92,
    method: "item/commandExecution/requestApproval", params: {
      threadId: "foreign", turnId: "turn-a", itemId: "item-2", command: "echo hi",
    } }) + "\n");
  assert.deepEqual(f.messages.at(-1), { jsonrpc: "2.0", id: 92,
    error: { code: -32602, message: "Approval identity mismatch" } });
  assert.equal(f.client.pendingApprovals.length, 0);
  f.client.close();
});

test("turn wait handles notification race, timeout and disconnect without retry", async () => {
  const done = fakeServer(basic);
  await done.client.initialize();
  await done.client.discoverModels();
  await done.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const turnId = await done.client.startTurn("plan", "medium");
  const waiting = done.client.waitForTurn(turnId, 100);
  done.notify("turn/completed", { threadId: "thread-a", turn: { id: turnId, status: "completed" } });
  assert.equal((await waiting).status, "completed");
  done.client.close();

  const timeout = fakeServer(basic);
  await timeout.client.initialize();
  await timeout.client.discoverModels();
  await timeout.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const timedTurn = await timeout.client.startTurn("plan", "medium");
  await assert.rejects(timeout.client.waitForTurn(timedTurn, 10), /outcome unknown/);
  assert.equal(timeout.client.dispatchBlocked, true);
  await assert.rejects(timeout.client.startTurn("retry", "medium"), /cannot start/);
  timeout.client.close();

  const disconnected = fakeServer(basic);
  await disconnected.client.initialize();
  await disconnected.client.discoverModels();
  await disconnected.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const lostTurn = await disconnected.client.startTurn("plan", "medium");
  const lost = disconnected.client.waitForTurn(lostTurn, 100);
  disconnected.toClient.end();
  await assert.rejects(lost, /stream ended/);
  assert.equal(disconnected.client.dispatchBlocked, true);
});

test("unanswered approval expires as a decline", async () => {
  const f = fakeServer(basic, { approvalTtlMs: 10, onApproval: () => {} });
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  await f.client.startTurn("plan", "medium");
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: "p-timeout",
    method: "item/fileChange/requestApproval", params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "item-3", startedAtMs: 1000,
    } }) + "\n");
  assert.equal(f.client.pendingApprovals.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.client.pendingApprovals.length, 0);
  assert.deepEqual(f.messages.at(-1), { jsonrpc: "2.0", id: "p-timeout",
    result: { decision: "decline" } });
  f.client.close();
});

test("a completed turn invalidates its unanswered approval", async () => {
  let approval: CodexApprovalRequest | undefined;
  const f = fakeServer(basic, { onApproval: (value) => { approval = value; } });
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  await f.client.startTurn("plan", "medium");
  f.toClient.write(JSON.stringify({ jsonrpc: "2.0", id: "p-turn",
    method: "item/fileChange/requestApproval", params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "item-4", startedAtMs: 1000,
    } }) + "\n");
  assert.equal(f.client.pendingApprovals.length, 1);
  f.notify("turn/completed", { threadId: "thread-a", turn: { id: "turn-a", status: "interrupted" } });
  assert.equal(f.client.pendingApprovals.length, 0);
  assert.deepEqual(f.messages.at(-1), { jsonrpc: "2.0", id: "p-turn",
    result: { decision: "decline" } });
  assert.throws(() => f.client.answerApproval(approval!, true), /stale or mismatched/);
  f.client.close();
});

test("a mid-turn model reroute blocks acceptance and further dispatch", async () => {
  const f = fakeServer(basic);
  await f.client.initialize();
  await f.client.discoverModels();
  await f.client.startThread({ cwd: "E:/repo", model: "gpt-6-astra", sandbox: "read-only" });
  const turnId = await f.client.startTurn("plan", "medium");
  const completed = f.client.waitForTurn(turnId, 100);
  f.notify("model/rerouted", { threadId: "thread-a", turnId,
    fromModel: "gpt-6-astra", toModel: "gpt-6-sol", reason: "unavailable" });
  await assert.rejects(completed, /rerouted/);
  f.notify("turn/completed", { threadId: "thread-a", turn: { id: turnId, status: "completed" } });
  assert.equal(f.client.currentThread?.resolvedModel, "gpt-6-sol");
  assert.equal(f.client.dispatchBlocked, true);
  await assert.rejects(f.client.startTurn("continue", "medium"), /cannot start/);
  f.client.close();
});
