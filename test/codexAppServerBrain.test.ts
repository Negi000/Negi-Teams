import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexAppServerBrain } from "../src/server/master/codexAppServerBrain.ts";
import type { MasterBrainStartOptions, MasterEvent } from "../src/server/master/brain.ts";
import { MasterSession, type MasterSessionHandlers,
  type MasterUsageSnapshot } from "../src/server/master/session.ts";
import type { MasterChatEnvelope } from "../src/shared/protocol.ts";
import type { RegisteredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { scheduledMasterTurns, MasterInputNotSentError, type MasterTurnAdmission } from
  "../src/server/orchestration/masterTurnAdmission.ts";
import { TaskResultStore } from "../src/server/orchestration/taskResults.ts";
import { createHash } from "node:crypto";

// Only Node speaks this synthetic protocol. No Codex binary or model is used.
const fixture = String.raw`
const fail = process.argv[1] === "fail";
const hold = process.argv[1] === "hold";
let data = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
process.stdin.on("data", (chunk) => {
  data += chunk.toString("utf8");
  let end;
  while ((end = data.indexOf("\n")) >= 0) {
    const message = JSON.parse(data.slice(0, end));
    data = data.slice(end + 1);
    if (message.method === "turn/start" && process.argv[2]) require("node:fs").appendFileSync(process.argv[2], JSON.stringify(message) + "\n");
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
    if (message.method === "turn/interrupt") send({ jsonrpc: "2.0", method: "turn/completed", params: {
      threadId: "synthetic-thread", turn: { id: "synthetic-turn", status: "interrupted" } } });
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
      if (hold) continue;
      send({ jsonrpc: "2.0", method: "item/completed", params: {
        threadId: "synthetic-thread", turnId: "synthetic-turn",
        item: { type: "agentMessage", phase: "final_answer", text: "final plan" } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: {
        threadId: "synthetic-thread", turn: { id: "synthetic-turn", status: "completed" } } });
    }
  }
});
`;

const notice = { id: "a".repeat(64), createdAt: "2026-10-01T00:00:00Z", runId: "result-run",
  title: "Completed delegated task", project: "synthetic", taskId: "TASK", version: 1,
  configSha256: "b".repeat(64), sourceSha256: "c".repeat(64), status: "ready_for_review",
  verificationOutcome: "passed", acceptedBy: null, reviewId: null, reason: null,
  origin: { kind: "master" as const, masterId: "master", threadId: "synthetic-thread", turnId: "delegation", callId: "call" } };

test("next user turn sends pinned Task results once and binds the same provider input to scheduler and terminal receipts", async () => {
  await scheduledBrainFixture(async ({ root, scheduler, options, admission }) => {
    const results = await TaskResultStore.open(join(root, "results")); await results.publish(notice);
    const wire = join(root, "provider-input.jsonl"); let preparedText = "";
    const tools: RegisteredTaskTools = { definitions: [], invoke: async () => { throw Error("unexpected tool"); },
      prepareResultContext: async (thread, input) => {
        const context = await results.prepareContext("master", thread, input, async () => true);
        preparedText = context?.text ?? input; return context;
      } };
    const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", fixture, "ok", wire],
      effort: "medium", turnTimeoutMs: 5000, admission, taskTools: tools });
    try {
      await brain.start(options);
      assert.equal((await results.list())[0].delivery.state, "pending");
      await brain.send({ text: "Review my delegated result" });
      const events = await collectUntil(brain, "turnEnd");
      assert.equal(events.at(-1)?.kind, "turnEnd");
      const requests = (await readFile(wire, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(requests.length, 1); assert.equal(requests[0].params.input[0].text, preparedText);
      assert.match(preparedText, /Completed delegated task/);
      const entry = (await scheduler.read()).state!.entries[0];
      assert.equal(entry.status, "verified");
      const intent = JSON.parse(await readFile(join(root, entry.work.id, "request.json"), "utf8"));
      assert.equal(intent.inputSha256, createHash("sha256").update(preparedText).digest("hex"));
      const result = (await results.list())[0]; assert.equal(result.delivery.state, "completed");
      assert.equal(result.delivery.turnId, "synthetic-turn"); assert.equal(result.acceptedBy, null);
      assert.equal(await (await TaskResultStore.open(results.root)).prepareContext("master", "synthetic-thread", "later", async () => true), null);
    } finally { await brain.stop(); }
  });
});

test("capacity rejection keeps result known unsent until a later authorized send", async () => {
  await scheduledBrainFixture(async ({ root, scheduler, options, admission }) => {
    const results = await TaskResultStore.open(join(root, "results")); await results.publish(notice);
    const held = await admission.reserve({ cwd: options.cwd, model: options.model!, effort: "medium", threadId: "held", text: "occupied" });
    const wire = join(root, "provider-input.jsonl");
    const tools: RegisteredTaskTools = { definitions: [], invoke: async () => { throw Error("unexpected tool"); },
      prepareResultContext: (thread, input) => results.prepareContext("master", thread, input, async () => true) };
    const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", fixture, "ok", wire],
      effort: "medium", turnTimeoutMs: 5000, admission, taskTools: tools });
    try {
      await brain.start(options);
      await assert.rejects(brain.send({ text: "read result" }), MasterInputNotSentError);
      assert.equal((await results.list())[0].delivery.state, "not_sent");
      await assert.rejects(readFile(wire), /ENOENT/);
      await held.cancelBeforeDispatch(); await brain.send({ text: "read result now" });
      await collectUntil(brain, "turnEnd");
      assert.equal((await results.list())[0].delivery.state, "completed");
      assert.equal((await readFile(wire, "utf8")).trim().split("\n").length, 1);
      assert.equal((await scheduler.read()).state!.entries.at(-1)?.status, "verified");
    } finally { await brain.stop(); }
  });
});

test("lost acknowledgement, provider loss and result persistence failure hold the claim and never replay the result", async () => {
  for (const fault of ["before_ack", "after_ack", "binding", "terminal"] as const) {
    await scheduledBrainFixture(async ({ root, scheduler, options, admission }) => {
      const results = await TaskResultStore.open(join(root, "results")); await results.publish(notice);
      const wire = join(root, "provider-input.jsonl");
      const tools: RegisteredTaskTools = { definitions: [], invoke: async () => { throw Error("unexpected tool"); },
        prepareResultContext: async (thread, input) => {
          const context = (await results.prepareContext("master", thread, input, async () => true))!;
          return { ...context,
            bind: async turn => { if (fault === "binding") throw Error("injected bind failure"); await context.bind(turn); },
            terminal: async observation => { if (fault === "terminal") throw Error("injected artifact failure"); await context.terminal(observation); } };
        } };
      const script = fault === "before_ack" ? fixture.replace('else if (message.method === "turn/start") result = { turn: { id: "synthetic-turn" } };',
        'else if (message.method === "turn/start") { process.exit(8); }') : fixture;
      const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", script, fault === "after_ack" ? "fail" : "ok", wire],
        effort: "medium", turnTimeoutMs: 5000, admission, taskTools: tools });
      try {
        await brain.start(options);
        if (fault === "before_ack" || fault === "binding") await assert.rejects(brain.send({ text: "read result" }));
        else await brain.send({ text: "read result" });
        const events = await collectUntil(brain, "exit"); await brain.stop();
        assert.equal(events.some(e => e.kind === "turnEnd"), false, fault);
        assert.equal((await scheduler.read()).state!.entries[0].status, "needs_reconciliation", fault);
        const restored = await TaskResultStore.open(results.root);
        assert.equal((await restored.list())[0].delivery.state, "unknown", fault);
        assert.equal(await restored.prepareContext("master", "synthetic-thread", "later", async () => true), null, fault);
        assert.equal((await readFile(wire, "utf8")).trim().split("\n").length, 1, fault);
      } finally { await brain.stop(); }
    });
  }
});

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

async function scheduledBrainFixture(run: (data: { scheduler: FileScheduler; root: string;
  admission: MasterTurnAdmission; options: MasterBrainStartOptions }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-scheduled-brain-"));
  const cwd = join(dir, "checkout"), root = join(dir, "state");
  await mkdir(cwd);
  const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
  try { await run({ scheduler, root, options: { ...start, cwd },
    admission: scheduledMasterTurns({ root, masterId: "master", scheduler }) }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("Master capacity miss is known unsent and leaves the provider/session ready for a later send", async () => {
  await scheduledBrainFixture(async ({ admission, options, scheduler }) => {
    const held = await admission.reserve({ cwd: options.cwd, model: options.model!, effort: "medium",
      threadId: "held-thread", text: "held plan" });
    const events: MasterChatEnvelope[] = [];
    const session = new MasterSession({ id: "scheduled-master", brainId: "codex", cwd: options.cwd,
      model: options.model, permissionMode: "plan", systemPrompt: null, mcpConfigPath: null,
      extraArgs: [], logPath: null, handlers: { onEvent: (_id, e) => events.push(e), onState: () => {},
        onNotice: () => {}, onUsage: () => {}, onRateLimits: () => {}, onRegistryChange: () => {} },
      createBrain: () => new CodexAppServerBrain({ executable: process.execPath,
        args: ["-e", fixture, "ok"], effort: "medium", turnTimeoutMs: 5000, admission }) });
    try {
      await session.start();
      const denied = await session.sendUserText("waiting plan");
      assert.equal(denied.accepted, false); assert.match(denied.reason!, /未送信/);
      assert.equal(session.state, "idle"); assert.equal(events.some(e => e.event.kind === "user"), false);
      await held.cancelBeforeDispatch();
      const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      assert.equal((await session.sendUserText("waiting plan", { requestId })).accepted, true);
      const deadline = Date.now() + 10000;
      while (!events.some(e => e.event.kind === "turnEnd") && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(session.state, "idle");
      assert.equal(events.filter(e => e.event.kind === "user").length, 1);
      const user = events.find(e => e.event.kind === "user")!.event;
      assert.equal(user.kind === "user" && user.requestId, requestId);
      assert.deepEqual((await scheduler.read()).state?.entries.map(e => e.status), ["failed", "cancelled", "verified"]);
    } finally { await session.stop(); }
  });
});

test("provider loss holds the Master's shared claim durably and cannot look completed", async () => {
  await scheduledBrainFixture(async ({ admission, options, scheduler, root }) => {
    const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", fixture, "fail"],
      effort: "medium", turnTimeoutMs: 5000, admission });
    try {
      await brain.start(options); await brain.send({ text: "plan" });
      const events = await collectUntil(brain, "exit"); await brain.stop();
      assert.equal(events.some(e => e.kind === "turnEnd"), false);
      const entry = (await scheduler.read()).state!.entries[0];
      assert.equal(entry.status, "needs_reconciliation");
      const provider = JSON.parse(await readFile(join(root, entry.work.id, "provider.json"), "utf8"));
      assert.equal(provider.turnId, "synthetic-turn");
      await assert.rejects(admission.reserve({ cwd: options.cwd, model: options.model!, effort: "medium",
        threadId: "later", text: "another plan" }), MasterInputNotSentError);
    } finally { await brain.stop(); }
  });
});

test("concurrent send is rejected before another lease, and a confirmed interrupt releases capacity", async () => {
  await scheduledBrainFixture(async ({ admission, options, scheduler }) => {
    const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", fixture, "hold"],
      effort: "medium", turnTimeoutMs: 10000, admission });
    try {
      await brain.start(options);
      const sent = brain.send({ text: "first" });
      await assert.rejects(brain.send({ text: "second" }), MasterInputNotSentError);
      await sent;
      assert.equal((await scheduler.read()).state?.entries.length, 1);
      await brain.interrupt();
      const events = await collectUntil(brain, "turnEnd");
      const terminal = events.at(-1);
      assert.equal(terminal?.kind === "turnEnd" && terminal.aborted, true);
      assert.equal((await scheduler.read()).state?.entries[0].status, "failed");
    } finally { await brain.stop(); }
  });
});

test("stop while awaiting admission cancels the proven unsent lease without starting a turn", async () => {
  await scheduledBrainFixture(async ({ admission, options, scheduler }) => {
    let release!: () => void;
    let obtained!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { obtained = resolve; });
    const delayed: MasterTurnAdmission = { reserve: async request => {
      const lease = await admission.reserve(request); obtained(); await gate; return lease; } };
    const brain = new CodexAppServerBrain({ executable: process.execPath, args: ["-e", fixture, "ok"],
      effort: "medium", turnTimeoutMs: 5000, admission: delayed });
    try {
      await brain.start(options);
      const sent = brain.send({ text: "unsent" });
      const rejected = assert.rejects(sent, MasterInputNotSentError);
      await ready; const stopped = brain.stop(); release(); await stopped; await rejected;
      const entries = (await scheduler.read()).state!.entries;
      assert.equal(entries.length, 1); assert.equal(entries[0].status, "failed");
      assert.match(entries[0].evidenceRef!, /not-sent.json/);
    } finally { release?.(); await brain.stop(); }
  });
});
