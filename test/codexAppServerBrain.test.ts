import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexAppServerBrain } from "../src/server/master/codexAppServerBrain.ts";
import type { MasterBrainStartOptions, MasterEvent } from "../src/server/master/brain.ts";
import { MasterSession, type MasterSessionHandlers,
  type MasterUsageSnapshot } from "../src/server/master/session.ts";
import type { MasterChatEnvelope } from "../src/shared/protocol.ts";
import type { RegisteredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";

// Only Node speaks this synthetic protocol. No Codex binary or model is used.
const fixture = String.raw`
const fail = process.argv[1] === "fail";
let data = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
process.stdin.on("data", (chunk) => {
  data += chunk.toString("utf8");
  let end;
  while ((end = data.indexOf("\n")) >= 0) {
    const message = JSON.parse(data.slice(0, end));
    data = data.slice(end + 1);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") result = { userAgent: "synthetic-brain-fixture" };
    else if (message.method === "model/list") result = { data: [{ model: "synthetic-astra",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      inputModalities: ["text"] }], nextCursor: null };
    else if (message.method === "thread/start") result = {
      thread: { id: "synthetic-thread" }, model: "synthetic-astra", modelProvider: "fixture" };
    else if (message.method === "turn/start") result = { turn: { id: "synthetic-turn" } };
    else result = {};
    send({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "turn/start") {
      if (fail) { setTimeout(() => process.exit(9), 5); continue; }
      send({ jsonrpc: "2.0", method: "turn/started", params: {
        threadId: "synthetic-thread", turn: { id: "synthetic-turn", status: "inProgress" } } });
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: {
        threadId: "synthetic-thread", turnId: "synthetic-turn", itemId: "message-1", delta: "draft" } });
      send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "synthetic-thread", turnId: "synthetic-turn",
        tokenUsage: { last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4,
          cacheWriteInputTokens: 0 }, modelContextWindow: 120 } } });
      send({ jsonrpc: "2.0", method: "item/completed", params: {
        threadId: "synthetic-thread", turnId: "synthetic-turn",
        item: { type: "agentMessage", phase: "final_answer", text: "final plan" } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: {
        threadId: "synthetic-thread", turn: { id: "synthetic-turn", status: "completed" } } });
    }
  }
});
`;

const start: MasterBrainStartOptions = {
  cwd: process.cwd(), model: "synthetic-astra", permissionMode: "plan",
  systemPrompt: "synthetic planning only", controlMcp: null, mcpConfigPath: null,
  resumeSessionId: null, extraArgs: [],
};

async function collectUntil(brain: CodexAppServerBrain, kind: MasterEvent["kind"]): Promise<MasterEvent[]> {
  const events: MasterEvent[] = [];
  for await (const event of brain.events()) {
    events.push(event);
    if (event.kind === kind) return events;
  }
  return events;
}

test("explicit synthetic App Server process maps a read-only turn into master events", async () => {
  const brain = new CodexAppServerBrain({ executable: process.execPath,
    args: ["-e", fixture, "ok"], effort: "medium", turnTimeoutMs: 1000 });
  try {
    await brain.start(start);
    assert.equal(brain.sessionId(), "synthetic-thread");
    assert.equal(brain.pid !== null, true);
    assert.deepEqual(await brain.send({ text: "plan" }), { acked: true });
    const events = await collectUntil(brain, "turnEnd");
    assert.equal(events[0]?.kind, "session");
    assert.equal(events.some((event) => event.kind === "text" && event.partial && event.text === "draft"), true);
    assert.equal(events.some((event) => event.kind === "text" && !event.partial && event.text === "final plan"), true);
    const ended = events.at(-1);
    assert.equal(ended?.kind, "turnEnd");
    if (ended?.kind === "turnEnd") {
      assert.equal(ended.ok, true);
      assert.equal(ended.costUsd, null);
      assert.equal(ended.usage?.input, 12);
      assert.equal(ended.usage?.cacheRead, 4);
      assert.equal(ended.usage?.contextUsedPct, 10);
    }
  } finally { await brain.stop(); }
});

test("synthetic process loss emits exit without treating the turn as complete", async () => {
  const brain = new CodexAppServerBrain({ executable: process.execPath,
    args: ["-e", fixture, "fail"], effort: "medium", turnTimeoutMs: 1000 });
  try {
    await brain.start(start);
    await brain.send({ text: "plan" });
    const events = await collectUntil(brain, "exit");
    assert.equal(events.some((event) => event.kind === "turnEnd"), false);
    assert.equal(events.some((event) => event.kind === "notice" && event.level === "error"), true);
    assert.equal(events.at(-1)?.kind, "exit");
  } finally { await brain.stop(); }
});

test("resume, write mode and image input stay unavailable in the read-only bridge", async () => {
  const brain = new CodexAppServerBrain({ executable: process.execPath,
    args: ["-e", fixture, "ok"], effort: "medium", turnTimeoutMs: 1000 });
  await assert.rejects(brain.start({ ...start, resumeSessionId: "old-thread" }), /does not support/);
  await assert.rejects(brain.start({ ...start, permissionMode: "auto" }), /does not support/);
  assert.equal(brain.pid, null);
  try {
    await brain.start(start);
    await assert.rejects(brain.send({ text: "plan", images: [{ mediaType: "image/png", base64: "AAAA" }] }),
      /image input is unsupported/);
  } finally { await brain.stop(); }
});

test("synthetic read-only brain feeds the existing MasterSession without a cost estimate", async () => {
  const events: MasterChatEnvelope[] = [];
  const usages: MasterUsageSnapshot[] = [];
  const handlers: MasterSessionHandlers = {
    onEvent: (_id, envelope) => { events.push(envelope); },
    onUsage: (_id, usage) => { usages.push(usage); },
    onState: () => {}, onNotice: () => {}, onRateLimits: () => {}, onRegistryChange: () => {},
  };
  const session = new MasterSession({ id: "synthetic-master", brainId: "codex",
    cwd: process.cwd(), model: "synthetic-astra", permissionMode: "plan",
    systemPrompt: "synthetic planning only",
    mcpConfigPath: null, extraArgs: [], logPath: null, handlers,
    createBrain: () => new CodexAppServerBrain({ executable: process.execPath,
      args: ["-e", fixture, "ok"], effort: "medium", turnTimeoutMs: 1000 }),
  });
  try {
    await session.start();
    assert.equal((await session.sendUserText("plan")).accepted, true);
    const deadline = Date.now() + 2000;
    while (!events.some((envelope) => envelope.event.kind === "turnEnd") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.some((envelope) => envelope.event.kind === "turnEnd"), true);
    assert.equal(session.state, "idle");
    assert.equal(usages.at(-1)?.tokens.input, 12);
    assert.equal(usages.at(-1)?.costUsd, null);
    const ended = events.findLast((envelope) => envelope.event.kind === "turnEnd")?.event;
    assert.equal(ended?.kind, "turnEnd");
    if (ended?.kind === "turnEnd") assert.equal(ended.totalCostUsd, null);
  } finally { await session.stop(); }
});

const nativeFixture = String.raw`
const api = process.argv[1] === "api";
let data = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function finish() {
  send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "synthetic-thread", turnId: "synthetic-turn",
    item: { type: "agentMessage", phase: "final_answer", text: "fixed Task inspected" } } });
  send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "synthetic-thread",
    turn: { id: "synthetic-turn", status: "completed" } } });
}
process.stdin.on("data", chunk => {
  data += chunk.toString("utf8"); let end;
  while ((end = data.indexOf("\n")) >= 0) {
    const message = JSON.parse(data.slice(0,end)); data = data.slice(end+1);
    if (message.id === undefined) continue;
    if (!message.method) {
      if (message.id !== "native-rpc" || !message.result?.success || message.result.contentItems[0].text !== "fixed contract") process.exit(10);
      finish(); continue;
    }
    let result;
    if (message.method === "initialize") {
      if (!message.params.capabilities?.experimentalApi) process.exit(11);
      result = { userAgent: "native-fixture" };
    } else if (message.method === "account/read") result = { account: { type: api ? "apiKey" : "chatgpt" }, requiresOpenaiAuth: true };
    else if (message.method === "model/list") result = { data: [{ model: "synthetic-astra", supportedReasoningEfforts: [{ reasoningEffort:"medium" }], inputModalities:["text"] }], nextCursor:null };
    else if (message.method === "thread/start") {
      if (message.params.dynamicTools.length !== 1 || message.params.dynamicTools[0].name !== "negi_read_task" ||
        message.params.sandbox !== "read-only" || !message.params.baseInstructions.includes("固定契約")) process.exit(12);
      result = { thread: { id:"synthetic-thread" }, model:"synthetic-astra", modelProvider:"fixture" };
    } else if (message.method === "turn/start") result = { turn: { id:"synthetic-turn" } };
    else result = {};
    send({jsonrpc:"2.0", id:message.id, result});
    if (message.method === "turn/start") {
      send({jsonrpc:"2.0",method:"turn/started",params:{threadId:"synthetic-thread",turn:{id:"synthetic-turn",status:"inProgress"}}});
      send({jsonrpc:"2.0",id:"native-rpc",method:"item/tool/call",params:{threadId:"synthetic-thread",turnId:"synthetic-turn",callId:"native-call",namespace:null,tool:"negi_read_task",arguments:{run_id:"fixed"}}});
    }
  }
});
`;
test("native Task tools flow through MasterSession without a false missing-MCP notice", async () => {
  const events: MasterChatEnvelope[] = [], notices: string[] = [];
  const calls: unknown[] = [];
  const tools: RegisteredTaskTools = { definitions: [{ type: "function", name: "negi_read_task",
    description: "Fixed Task read", inputSchema: { type: "object" } }], invoke: async call => {
    calls.push(call); return { success: true, text: "fixed contract" }; } };
  const session = new MasterSession({ id: "synthetic-native", brainId: "codex", cwd: process.cwd(),
    model: "synthetic-astra", permissionMode: "plan", systemPrompt: "synthetic planning only",
    mcpConfigPath: null, extraArgs: [], logPath: null, handlers: {
      onEvent: (_id, envelope) => { events.push(envelope); }, onUsage: () => {}, onState: () => {},
      onNotice: (_id, message) => { notices.push(message); }, onRateLimits: () => {}, onRegistryChange: () => {},
    }, createBrain: () => new CodexAppServerBrain({ executable: process.execPath, args: ["-e", nativeFixture, "ok"],
      effort: "medium", turnTimeoutMs: 1000, taskTools: tools, subscriptionOnly: true }),
  });
  try {
    await session.start(); assert.equal((await session.sendUserText("read fixed Task")).accepted, true);
    const deadline = Date.now() + 3000;
    while (!events.some(e => e.event.kind === "turnEnd") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(events.some(e => e.event.kind === "turnEnd"), true);
    assert.deepEqual(calls, [{ threadId: "synthetic-thread", turnId: "synthetic-turn", callId: "native-call",
      tool: "negi_read_task", arguments: { run_id: "fixed" } }]);
    assert.equal(events.some(e => e.event.kind === "toolCall" && e.event.name === "negi_read_task"), true);
    assert.equal(events.some(e => e.event.kind === "toolResult" && e.event.ok), true);
    const event = events.find(e => e.event.kind === "session")!.event;
    if (event.kind === "session") {
      assert.deepEqual(event.mcpServers, []); assert.deepEqual(event.capabilities, ["read-only", "registered-task-tools"]);
    }
    assert.equal(notices.some(message => message.includes("MCP")), false);
    assert.equal(session.state, "idle");
  } finally { await session.stop(); }
});

test("subscription-only Master rejects API authentication before opening a model thread", async () => {
  let calls = 0;
  const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", nativeFixture, "api"],
    effort: "medium", turnTimeoutMs: 1000, subscriptionOnly: true,
    taskTools: { definitions: [{ type: "function", name: "negi_read_task", description: "Read", inputSchema: {} }],
      invoke: async () => { calls++; return { success: true, text: "fixed contract" }; } } });
  await assert.rejects(brain.start(start), /subscription authentication/);
  assert.equal(brain.sessionId(), null); assert.equal(calls, 0); await brain.stop();
});
