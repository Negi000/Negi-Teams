// MasterSession（PR-M2）のテスト。**実プロセスは起動しない**（FakeBrain を差し替える）。
// 実 claude を立てる結合確認は scripts/e2e-master-chat.mjs（既定では走らせない）。
//
// 実行: node --import tsx --test test/masterChatSession.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskResultSummary } from "../src/shared/taskResults.ts";
import {
  MasterSession,
  replyQuoteLine,
  sanitizeReplyRef,
  toChatEvent,
  unsettledRequestIds,
  type MasterSessionHandlers,
  type MasterUsageSnapshot,
} from "../src/server/master/session.ts";
import type { MasterBrain, MasterBrainCapabilities, MasterBrainId, MasterBrainInput,
  MasterEvent } from "../src/server/master/brain.ts";
import type {
  MasterChatEnvelope,
  MasterChatState,
  UsageRateLimits,
} from "../src/shared/protocol.ts";

/** 手で MasterEvent を流し込めるブレイン。プロセスも時計も持たない。 */
class FakeBrain implements MasterBrain {
  constructor(readonly id: MasterBrainId = "claude") {
    this.capabilities = { ...this.capabilities, cost: id === "claude" };
  }
  readonly capabilities: MasterBrainCapabilities = {
    partialText: true,
    thinking: true,
    permissionPrompt: true,
    askUserQuestion: true,
    interrupt: true,
    resume: true,
    cost: true,
    contextPct: true,
    images: true,
  };
  readonly unsupported = [];
  pid: number | null = 4242;
  /** createBrain に渡ってきたオプション（PR-M3 の partial 有効化の検証用）。 */
  createOpts: { includePartialMessages: boolean } | null = null;
  started: { resumeSessionId: string | null } | null = null;
  failStart = false;
  readonly sent: string[] = [];
  /** send() に渡った入力そのもの（PR-M4 の画像添付検証用）。 */
  readonly inputs: MasterBrainInput[] = [];
  ackResult = true;
  interrupted = 0;
  stopped = 0;

  private readonly queue: MasterEvent[] = [];
  private waiter: ((r: IteratorResult<MasterEvent>) => void) | null = null;
  private closed = false;

  start(opts: { resumeSessionId: string | null }): Promise<void> {
    this.started = { resumeSessionId: opts.resumeSessionId };
    if (this.failStart) return Promise.reject(new Error("synthetic startup failure"));
    this.closed = false;
    return Promise.resolve();
  }
  send(input: MasterBrainInput): Promise<{ acked: boolean }> {
    this.sent.push(input.text);
    this.inputs.push(input);
    return Promise.resolve({ acked: this.ackResult });
  }
  events(): AsyncIterable<MasterEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<MasterEvent> {
        return {
          next(): Promise<IteratorResult<MasterEvent>> {
            const buffered = self.queue.shift();
            if (buffered) return Promise.resolve({ value: buffered, done: false });
            if (self.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              self.waiter = resolve;
            });
          },
        };
      },
    };
  }
  /** answer() に渡ってきた引数（PR-M5 の応答経路の検証用）。 */
  readonly answered: { id: string; decision: unknown }[] = [];
  answer(id: string, decision: unknown): Promise<void> {
    this.answered.push({ id, decision });
    return Promise.resolve();
  }
  interrupt(): Promise<void> {
    this.interrupted += 1;
    return Promise.resolve();
  }
  sessionId(): string | null {
    return null;
  }
  stop(): Promise<void> {
    this.stopped += 1;
    this.close();
    return Promise.resolve();
  }

  /** テストからイベントを流す。 */
  emit(ev: MasterEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: ev, done: false });
      return;
    }
    this.queue.push(ev);
  }
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }
}

interface Harness {
  session: MasterSession;
  brains: FakeBrain[];
  events: MasterChatEnvelope[];
  states: { state: MasterChatState; pending: number }[];
  notices: string[];
  usages: MasterUsageSnapshot[];
  /** onUsage が呼ばれた瞬間のセッション状態（contextGuard のキリ判定はこれを読む）。 */
  usageStates: MasterChatState[];
  rateLimits: Partial<UsageRateLimits>[];
}

function makeSession(opts: { snapshotLimit?: number; brainId?: MasterBrainId; registeredConversations?: boolean;
  failStart?: boolean; configureBrain?: (brain: FakeBrain, index: number) => void;
  configureHandlers?: (handlers: MasterSessionHandlers) => void } = {}): Harness {
  const brains: FakeBrain[] = [];
  const h: Omit<Harness, "session" | "brains"> = {
    events: [],
    states: [],
    notices: [],
    usages: [],
    usageStates: [],
    rateLimits: [],
  };
  // handlers から参照するため、session を後入れできる箱にしておく。
  let sessionRef: MasterSession | null = null;
  const handlers: MasterSessionHandlers = {
    onEvent: (_id, envelope) => h.events.push(envelope),
    onState: (_id, state, pending) => h.states.push({ state, pending }),
    onNotice: (_id, text) => h.notices.push(text),
    onUsage: (_id, usage) => {
      h.usages.push(usage);
      h.usageStates.push(sessionRef?.state ?? "stopped");
    },
    onRateLimits: (_id, limits) => h.rateLimits.push(limits),
    onRegistryChange: () => {},
  };
  opts.configureHandlers?.(handlers);
  const session = new MasterSession({
    id: "master",
    brainId: opts.brainId ?? "claude",
    cwd: "/tmp",
    model: "opus",
    permissionMode: "auto",
    systemPrompt: "master の役割",
    mcpConfigPath: "/tmp/master.mcp.json",
    extraArgs: [],
    logPath: null,
    handlers,
    ...(opts.snapshotLimit === undefined ? {} : { snapshotLimit: opts.snapshotLimit }),
    ...(opts.registeredConversations ? { registeredConversations: true } : {}),
    restartPolicy: { baseDelayMs: 5, maxDelayMs: 10, maxConsecutiveFailures: 3, minHealthyMs: 10_000 },
    createBrain: (id, o) => {
      const b = new FakeBrain(id);
      b.failStart = opts.failStart ?? false;
      b.createOpts = { includePartialMessages: o.includePartialMessages };
      opts.configureBrain?.(b, brains.length);
      brains.push(b);
      return b;
    },
  });
  sessionRef = session;
  return { session, brains, ...h };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
test("registered conversation only displays results addressed to its current thread, including browser-started authored Tasks", async () => {
  const h = makeSession({ registeredConversations: true, configureBrain: brain => { brain.sessionId = () => "current-thread"; } });
  try {
    await h.session.start(); const before = h.events.length;
    const result: TaskResultSummary = { id: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", runId: "run",
      title: "Authored result", project: "fixture", taskId: "TASK", version: 1, configSha256: "b".repeat(64),
      sourceSha256: "c".repeat(64), status: "ready_for_review", verificationOutcome: "passed", acceptedBy: null,
      reviewId: null, reason: null, origin: { kind: "browser" },
      createdBy: { kind: "master", masterId: "master", threadId: "old-thread", turnId: "plan-turn", callId: "plan-call" },
      delivery: { state: "pending", threadId: null, turnId: null } };
    h.session.notifyTaskResult(result); assert.equal(h.events.length, before);
    h.session.notifyTaskResult({ ...result, createdBy: { ...result.createdBy!, threadId: "current-thread" } });
    assert.equal(h.events.length, before + 1); assert.equal(h.events.at(-1)!.threadId, "current-thread");
    assert.deepEqual(h.brains[0].sent, []);
    h.session.notifyTaskResult({ ...result, origin: { ...result.createdBy!, kind: "master" }, createdBy: undefined });
    assert.equal(h.events.length, before + 1);
  } finally { await h.session.stop(); }
});
test("Task notification belongs to its Master, updates its card, and never sends a user or provider turn", async () => {
  const h = makeSession({ configureBrain: brain => { brain.sessionId = () => "origin-thread"; } });
  try {
    await h.session.start();
    const result: TaskResultSummary = { id: "a".repeat(64), createdAt: "2026-10-01T00:00:00Z", runId: "run",
      title: "Task result", project: "synthetic", taskId: "TASK", version: 1, configSha256: "b".repeat(64),
      sourceSha256: "c".repeat(64), status: "ready_for_review", verificationOutcome: "passed", acceptedBy: null,
      reviewId: null, reason: null, origin: { kind: "master", masterId: "master", threadId: "origin-thread", turnId: "turn", callId: "call" },
      delivery: { state: "pending", threadId: null, turnId: null } };
    h.session.notifyTaskResult({ ...result, origin: { kind: "browser" } });
    h.session.notifyTaskResult({ ...result, origin: { ...result.origin, kind: "master", masterId: "other", threadId: "other", turnId: "turn", callId: "call" } });
    assert.equal(h.events.length, 0);
    h.session.notifyTaskResult(result); h.session.notifyTaskResult(result);
    assert.equal(h.events.length, 1); assert.equal(h.events[0].event.kind, "taskResult");
    assert.equal(h.session.state, "idle"); assert.deepEqual(h.brains[0].sent, []);
    h.session.notifyTaskResult({ ...result, delivery: { state: "completed", threadId: "origin-thread", turnId: "response" } });
    assert.equal(h.events.length, 2); assert.equal(h.events.some(e => e.event.kind === "user"), false);
    assert.equal(h.session.snapshot().events.length, 2); assert.deepEqual(h.brains[0].sent, []);
    h.brains[0].sessionId = () => "new-thread";
    h.session.notifyTaskResult({ ...result, id: "d".repeat(64) });
    assert.equal(h.events.length, 2); assert.deepEqual(h.brains[0].sent, []);
  } finally { await h.session.stop(); }
});
/** イベントが n 件たまるまで待つ（タイムアウトしたらそのまま返す）。 */
async function waitEvents(h: Harness, n: number, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (h.events.length < n && Date.now() < until) await sleep(5);
}

test("toChatEvent: ack は UI へ流さず、その他の kind はワイヤ表現へ写る", () => {
  assert.equal(toChatEvent({ kind: "ack", text: "x" }, null), null);
  const text = toChatEvent({ kind: "text", text: "こんにちは", partial: false }, null);
  assert.deepEqual(text, { kind: "text", text: "こんにちは", partial: false });
  const end = toChatEvent(
    { kind: "turnEnd", ok: true, aborted: false, usage: null, costUsd: 0.5, errorText: null },
    1.25,
  );
  assert.deepEqual(end, {
    kind: "turnEnd",
    ok: true,
    aborted: false,
    usage: null,
    costUsd: 0.5,
    totalCostUsd: 1.25,
    errorText: null,
  });
});

test("chatSend → user イベント＋busy、turnEnd で idle へ戻る", async () => {
  const h = makeSession();
  await h.session.start();
  assert.equal(h.session.state, "idle");

  await h.session.sendUserText("こんにちは");
  assert.equal(h.brains[0]!.sent[0], "こんにちは");
  assert.equal(h.events[0]!.event.kind, "user");
  assert.equal(h.session.state, "busy");

  h.brains[0]!.emit({ kind: "text", text: "やあ", partial: false });
  h.brains[0]!.emit({
    kind: "turnEnd",
    ok: true,
    aborted: false,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 90,
      cacheCreation: 0,
      contextTokens: 100,
      contextSize: 1_000_000,
      contextUsedPct: 0.01,
    },
    costUsd: 0.02,
    errorText: null,
  });
  await waitEvents(h, 3);
  assert.equal(h.events[1]!.event.kind, "text");
  assert.equal(h.events[2]!.event.kind, "turnEnd");
  assert.equal(h.session.state, "idle");
  // seq は 1 から単調増加する（再接続時の欠落検出に使う）。
  assert.deepEqual(h.events.map((e) => e.seq), [1, 2, 3]);
});

test("turnEnd の usage が UsageStore 供給用に流れ、コストはプロセスを跨いで合算される", async () => {
  const h = makeSession();
  await h.session.start();
  h.brains[0]!.emit({ kind: "session", sessionId: "s1", model: "claude-opus-5", apiKeySource: "none", mcpServers: [{ name: "ebi-control", status: "connected" }], capabilities: [] });
  h.brains[0]!.emit({
    kind: "turnEnd",
    ok: true,
    aborted: false,
    usage: {
      input: 1000,
      output: 20,
      cacheRead: 5000,
      cacheCreation: 100,
      contextTokens: 6100,
      contextSize: 1_000_000,
      contextUsedPct: 0.61,
    },
    costUsd: 0.25,
    errorText: null,
  });
  await waitEvents(h, 2);
  assert.equal(h.usages.length, 1);
  assert.equal(h.usages[0]!.contextUsedPct, 0.61);
  assert.equal(h.usages[0]!.contextSize, 1_000_000);
  assert.equal(h.usages[0]!.tokens.cacheRead, 5000);
  assert.equal(h.usages[0]!.model, "claude-opus-5");
  assert.equal(h.session.totalCostUsd, 0.25);
});

test("PR-M6: usage を出す時点で既に idle（contextGuard の /clear 促しが発火できる）", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("やあ");
  h.brains[0]!.emit({
    kind: "turnEnd",
    ok: true,
    aborted: false,
    usage: {
      input: 1000, output: 20, cacheRead: 5000, cacheCreation: 100,
      contextTokens: 6100, contextSize: 1_000_000, contextUsedPct: 66,
    },
    costUsd: 0.1,
    errorText: null,
  });
  await waitEvents(h, 2);
  assert.equal(h.usages.length, 1);
  // busy のまま usage を渡すと registry 上 master が busy に見え、quiescent 通知が永久に出ない。
  assert.deepEqual(h.usageStates, ["idle"]);
  assert.equal(h.session.record().status, "idle");
});

test("ebi-control が connected でなければ notice で知らせる（静かな故障の構造的検出）", async () => {
  const h = makeSession();
  await h.session.start();
  h.brains[0]!.emit({
    kind: "session",
    sessionId: "s1",
    model: "opus",
    apiKeySource: "none",
    mcpServers: [{ name: "ebi-control", status: "failed" }],
    capabilities: [],
  });
  await waitEvents(h, 1);
  assert.ok(h.notices.some((n) => n.includes("ebi-control")), h.notices.join("/"));
});

test("エビ返信は inbound イベントになり、タグ付き本文が stdin へ載る（PTY 注入を使わない）", async () => {
  const h = makeSession();
  await h.session.start();
  const r = await h.session.deliverFromEbi({
    from: "ebi-1",
    message: "実装できました",
    body: "[reply] 実装できました",
    kind: "reply",
  });
  assert.deepEqual(r, { ok: true, confirmed: true });
  assert.equal(h.brains[0]!.sent[0], "[reply] 実装できました");
  const ev = h.events[0]!.event;
  assert.equal(ev.kind, "inbound");
  if (ev.kind === "inbound") {
    // UI には生タグを出さず構造化フィールドへ移す。
    assert.equal(ev.from, "ebi-1");
    assert.equal(ev.tag, "reply");
    assert.equal(ev.text, "実装できました");
  }
});

test("ACK が取れなければ confirmed:false を正直に返す（再送はしない）", async () => {
  const h = makeSession();
  await h.session.start();
  h.brains[0]!.ackResult = false;
  const r = await h.session.deliverFromEbi({
    from: "ebi-1",
    message: "報告",
    body: "[reply] 報告",
    kind: "reply",
  });
  assert.deepEqual(r, { ok: true, confirmed: false });
  assert.equal(h.brains[0]!.sent.length, 1, "再送していないこと");
});

test("プロセス死亡 → --resume <sessionId> で自動復帰する（R1）", async () => {
  const h = makeSession();
  await h.session.start();
  h.brains[0]!.emit({
    kind: "session",
    sessionId: "sess-abc",
    model: "opus",
    apiKeySource: "none",
    mcpServers: [{ name: "ebi-control", status: "connected" }],
    capabilities: [],
  });
  await waitEvents(h, 1);
  h.brains[0]!.emit({ kind: "exit", code: 1, signal: null });
  h.brains[0]!.close();

  const until = Date.now() + 1000;
  while (h.brains.length < 2 && Date.now() < until) await sleep(5);
  assert.equal(h.brains.length, 2, "2 本目のプロセスが起動する");
  assert.equal(h.brains[1]!.started?.resumeSessionId, "sess-abc");
  assert.equal(h.session.state, "idle");
  await h.session.stop();
});

test("Codex master の終了後は結果照合まで自動 resume しない", async () => {
  const h = makeSession({ brainId: "codex" });
  await h.session.start();
  h.brains[0]!.emit({ kind: "session", sessionId: "codex-thread-a",
    model: "gpt-6-astra", apiKeySource: null, mcpServers: [], capabilities: [] });
  await waitEvents(h, 1);
  h.brains[0]!.emit({ kind: "exit", code: 1, signal: null });
  h.brains[0]!.close();
  await sleep(50);
  assert.equal(h.brains.length, 1);
  assert.equal(h.session.state, "stopped");
  assert.equal(h.notices.some((text) => text.includes("Codex master は自動復帰しません")), true);
  await h.session.stop();
});

test("Codex master の起動失敗は自動再試行しない", async () => {
  const h = makeSession({ brainId: "codex", failStart: true });
  await h.session.start();
  await sleep(50);
  assert.equal(h.brains.length, 1);
  assert.equal(h.session.state, "stopped");
  assert.equal(h.notices.some((text) => text.includes("Codex master は自動復帰しません")), true);
  await h.session.stop();
});

test("Codex master の手動新規会話は結果照合経路ができるまで拒否する", async () => {
  const h = makeSession({ brainId: "codex" });
  await h.session.start();
  await assert.rejects(h.session.newConversation(), /結果照合とrun台帳/);
  assert.equal(h.brains.length, 1);
  assert.equal(h.session.state, "idle");
  await h.session.stop();
});

test("Codex master は実行中の二重送信を拒否し、turn終了後に受け付ける", async () => {
  const h = makeSession({ brainId: "codex" });
  await h.session.start();
  assert.equal((await h.session.sendUserText("first")).accepted, true);
  const second = await h.session.sendUserText("second");
  assert.equal(second.accepted, false);
  assert.equal(h.brains[0]!.sent.length, 1);
  assert.equal(h.events.filter((e) => e.event.kind === "user").length, 1);
  h.brains[0]!.emit({ kind: "turnEnd", ok: true, aborted: false,
    usage: null, costUsd: null, errorText: null });
  await waitEvents(h, 2);
  assert.equal((await h.session.sendUserText("third")).accepted, true);
  assert.deepEqual(h.brains[0]!.sent, ["first", "third"]);
  await h.session.stop();
});

test("Codex master の投入ACKが無いと発話を受入済みにせず停止する", async () => {
  const h = makeSession({ brainId: "codex" });
  await h.session.start();
  h.brains[0]!.ackResult = false;
  const result = await h.session.sendUserText("uncertain");
  assert.equal(result.accepted, false);
  assert.equal(h.session.state, "stopped");
  assert.equal(h.events.some((e) => e.event.kind === "user"), false);
  assert.equal((await h.session.sendUserText("retry")).accepted, false);
  await h.session.stop();
});

test("Codex のusageは費用未取得を0 USDへ変換しない", async () => {
  const h = makeSession({ brainId: "codex" });
  await h.session.start();
  h.brains[0]!.emit({ kind: "turnEnd", ok: true, aborted: false,
    usage: { input: 10, output: 2, cacheRead: 3, cacheCreation: 0,
      contextTokens: 10, contextSize: 100, contextUsedPct: 10 },
    costUsd: null, errorText: null });
  await waitEvents(h, 1);
  assert.equal(h.usages.at(-1)?.costUsd, null);
  const event = h.events.at(-1)?.event;
  assert.equal(event?.kind, "turnEnd");
  if (event?.kind === "turnEnd") assert.equal(event.totalCostUsd, null);
  await h.session.stop();
});

test("停止（stop）後は自動復帰しない", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.stop();
  h.brains[0]!.emit({ kind: "exit", code: 0, signal: null });
  h.brains[0]!.close();
  await sleep(50);
  assert.equal(h.brains.length, 1);
  assert.equal(h.session.state, "stopped");
});

test("承認/質問が来ると waiting になり pending が立つ", async () => {
  const h = makeSession();
  await h.session.start();
  h.brains[0]!.emit({
    kind: "question",
    id: "q1#0",
    header: "確認",
    question: "進めてよいですか",
    options: [{ label: "はい" }],
    multi: false,
  });
  await waitEvents(h, 1);
  assert.equal(h.session.state, "waiting");
  assert.equal(h.session.pendingCount, 1);
  // 未応答の間はボスの発話でも busy へ落とさない（スティッキーバーの前提）。
  await h.session.sendUserText("まって");
  assert.equal(h.session.state, "waiting");
});

test("snapshot は seq 昇順で返し、リングから溢れたら hasMore が立つ", async () => {
  const h = makeSession({ snapshotLimit: 3 });
  await h.session.start();
  for (let i = 0; i < 5; i++) await h.session.sendUserText(`m${i}`);
  const snap = h.session.snapshot();
  assert.equal(snap.events.length, 3);
  assert.deepEqual(snap.events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(snap.hasMore, true);
  // before 指定でその seq より前だけを返す。
  const older = h.session.snapshot({ before: 4 });
  assert.deepEqual(older.events.map((e) => e.seq), [3]);
});

test("registry 用の合成レコードは master/pinned で、状態を idle/busy に写す", async () => {
  const h = makeSession();
  await h.session.start();
  const rec = h.session.record();
  assert.equal(rec.kind, "master");
  assert.equal(rec.pinned, true);
  assert.equal(rec.status, "idle");
  assert.equal(rec.pid, 4242);
  assert.equal(rec.backend, "claude");
  await h.session.sendUserText("やあ");
  assert.equal(h.session.record().status, "busy");
});

test("chatStop は brain.interrupt() を呼ぶ（SIGINT ではない）", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.interrupt();
  assert.equal(h.brains[0]!.interrupted, 1);
});

test("PR-M3: 頭脳は --include-partial-messages 相当（逐次描画）で起動する", async () => {
  const h = makeSession();
  await h.session.start();
  assert.deepEqual(h.brains[0]!.createOpts, { includePartialMessages: true });
});

test("新しい会話: resume 無しで起動し直し、コスト累計と pending をリセットする", async () => {
  const h = makeSession();
  await h.session.start();
  h.brains[0]!.emit({
    kind: "session",
    sessionId: "sess-1",
    model: "opus",
    apiKeySource: "none",
    mcpServers: [{ name: "ebi-control", status: "connected" }],
    capabilities: [],
  });
  h.brains[0]!.emit({
    kind: "turnEnd",
    ok: true,
    aborted: false,
    usage: null,
    costUsd: 1.5,
    errorText: null,
  });
  await waitEvents(h, 2);
  assert.equal(h.session.totalCostUsd, 1.5);

  await h.session.newConversation();
  // 新しいプロセスが立ち、resume は付かない（＝文脈がリセットされる）。
  assert.equal(h.brains.length, 2);
  assert.equal(h.brains[1]!.started?.resumeSessionId, null);
  assert.equal(h.brains[0]!.stopped, 1);
  // 会話単位の累計コストは 0 に戻り、発話を受け付けられる状態に戻る。
  assert.equal(h.session.totalCostUsd, 0);
  assert.equal(h.session.state, "idle");
  // 区切りが cleared イベントとしてトランスクリプト（ring）に残る＝
  // 再接続・サーバ再起動後の snapshot 復元でも同じ「区切り済み」状態が再現する。
  assert.equal(h.events.filter((e) => e.event.kind === "cleared").length, 1);
  const snap = h.session.snapshot();
  assert.ok(snap.events.some((e) => e.event.kind === "cleared"));
});

test("新しい会話の直後も送信できる（新プロセスの stdin へ載る）", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.newConversation();
  const r = await h.session.sendUserText("最初の一言");
  assert.equal(r.accepted, true);
  assert.deepEqual(h.brains[1]!.sent, ["最初の一言"]);
});

test("会話切替中の二重要求と入力を拒否し、サーバ終了を取り消さない", async () => {
  let entered!: () => void, release!: () => void;
  const stopEntered = new Promise<void>(resolve => { entered = resolve; });
  const stopHeld = new Promise<void>(resolve => { release = resolve; });
  const h = makeSession({ configureBrain: (brain, index) => {
    if (index !== 0) return;
    brain.stop = async () => { brain.stopped++; entered(); await stopHeld; brain.close(); };
  } });
  await h.session.start();
  const reset = h.session.newConversation();
  const resetRejected = assert.rejects(reset, /サーバ終了/);
  await stopEntered;
  assert.equal(h.session.state, "starting");
  await assert.rejects(h.session.newConversation(), /新しい要求は開始していません/);
  assert.equal((await h.session.sendUserText("keep unsent")).accepted, false);
  assert.deepEqual(await h.session.deliverFromEbi({ from: "worker", kind: "reply", message: "late", body: "late" }),
    { ok: false, confirmed: false });
  await assert.rejects(h.session.answer("old-question", { allow: true }), /起動していません/);
  let stopped = false;
  const shutdown = h.session.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.equal(h.brains[0].stopped, 1);
  release(); await resetRejected; await shutdown;
  assert.equal(h.session.state, "stopped"); assert.equal(h.brains.length, 1);
  assert.equal(h.events.some(event => ["cleared", "user", "inbound"].includes(event.event.kind)), false);
  await assert.rejects(h.session.newConversation(), /新しい要求は開始していません/);
  await assert.rejects(h.session.start(), /すでに要求/);
});

test("初回ログ読取前から起動を保護し、会話切替と終了がbrain所有権を奪わない", async () => {
  const h = makeSession();
  const start = h.session.start();
  assert.equal(h.session.state, "starting");
  await assert.rejects(h.session.newConversation(), /新しい要求は開始していません/);
  await start;
  assert.equal(h.brains.length, 1); assert.equal(h.session.state, "idle");
  assert.equal((await h.session.sendUserText("owned input")).accepted, true);
  await h.session.stop(); assert.equal(h.brains[0].stopped, 1);

  const stoppedBeforeLaunch = makeSession();
  const prelaunch = stoppedBeforeLaunch.session.start();
  const shutdown = stoppedBeforeLaunch.session.stop();
  await Promise.all([prelaunch, shutdown]);
  assert.equal(stoppedBeforeLaunch.brains.length, 0);
  assert.equal(stoppedBeforeLaunch.session.state, "stopped");
  assert.equal(stoppedBeforeLaunch.events.length, 0);
});

test("表示通知の例外で既知の会話切替を取り消したり、新brainを孤立させない", async () => {
  const h = makeSession({ configureHandlers: handlers => {
    const event = handlers.onEvent;
    handlers.onEvent = (id, envelope) => {
      if (envelope.event.kind === "cleared") throw Error("synthetic display observer failed");
      event(id, envelope);
    };
    handlers.onState = () => { throw Error("synthetic state observer failed"); };
    handlers.onRegistryChange = () => { throw Error("synthetic registry observer failed"); };
  } });
  await h.session.start(); await h.session.newConversation();
  assert.equal(h.session.state, "idle"); assert.equal(h.brains.length, 2);
  assert.equal(h.session.snapshot().events.filter(event => event.event.kind === "cleared").length, 1);
  assert.equal(h.notices.some(notice => notice.includes("会話表示への通知に失敗")), true);
  assert.equal((await h.session.sendUserText("replacement stays owned")).accepted, true);
  await h.session.stop(); assert.equal(h.brains[1].stopped, 1);
  assert.equal(h.session.record().pid, null);
});

test("会話境界で過去の未回答を除外し、同じIDの新しい質問だけを復元する", () => {
  const question = { kind: "question" as const, id: "reused", header: "確認", question: "合成",
    options: [{ label: "続ける", description: "合成" }], multi: false };
  const events: MasterChatEnvelope[] = [{ seq: 1, ts: 1, event: question }, { seq: 2, ts: 2, event: { kind: "cleared" } }];
  assert.deepEqual(unsettledRequestIds(events), []);
  events.push({ seq: 3, ts: 3, event: question });
  assert.deepEqual(unsettledRequestIds(events), ["reused"]);
  events.push({ seq: 4, ts: 4, event: { kind: "permissionSettled", id: "reused", outcome: "discarded", answer: null } });
  assert.deepEqual(unsettledRequestIds(events), []);
});

test("新しい統括の起動失敗では区切りと使用量消去を出さず、自動再実行しない", async () => {
  const h = makeSession({ configureBrain: (brain, index) => { if (index === 1) brain.failStart = true; } });
  await h.session.start();
  h.brains[0].emit({ kind: "turnEnd", ok: true, aborted: false, usage: null, costUsd: 1.5, errorText: null });
  h.brains[0].emit({ kind: "question", id: "old-question", header: "確認", question: "終了する確認",
    options: [{ label: "続ける", description: "合成" }], multi: false });
  await waitEvents(h, 2);
  await assert.rejects(h.session.newConversation(), /表示と使用量は保持/);
  assert.equal(h.session.totalCostUsd, 1.5); assert.equal(h.session.state, "stopped");
  assert.equal(h.events.some(event => event.event.kind === "cleared"), false);
  assert.equal(h.brains[0].stopped, 1); assert.equal(h.brains[1].stopped, 1);
  assert.equal(h.events.filter(event => event.event.kind === "permissionSettled" && event.event.id === "old-question" &&
    event.event.outcome === "discarded").length, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.brains.length, 2);
  await h.session.stop();
});

test("起動待ち中の終了は起動完了まで待ち、会話を待機中へ戻さない", async () => {
  for (const replacement of [false, true]) {
    let entered!: () => void, release!: () => void;
    const startEntered = new Promise<void>(resolve => { entered = resolve; });
    const startHeld = new Promise<void>(resolve => { release = resolve; });
    const h = makeSession({ configureBrain: (brain, index) => {
      if (index !== (replacement ? 1 : 0)) return;
      brain.start = async options => { brain.started = options; entered(); await startHeld; };
    } });
    if (replacement) await h.session.start();
    const start = replacement ? h.session.newConversation() : h.session.start();
    const observedStart = replacement ? assert.rejects(start, /起動を確認できません/) : start;
    await startEntered;
    let stopped = false;
    const shutdown = h.session.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, String(replacement));
    release(); await observedStart; await shutdown;
    assert.equal(h.session.state, "stopped");
    assert.equal(h.events.some(event => event.event.kind === "cleared"), false);
    assert.equal((await h.session.sendUserText("must stay unsent")).accepted, false);
    assert.equal(h.brains.at(-1)!.stopped >= 1, true);
  }
});

test("区切りは新しい起動を確認した後、そのsessionイベントより先に記録する", async () => {
  const h = makeSession({ configureBrain: (brain, index) => {
    if (index !== 1) return;
    const start = brain.start.bind(brain);
    brain.start = async options => { await start(options); brain.emit({ kind: "session", sessionId: "new-session",
      model: "opus", apiKeySource: null, mcpServers: [{ name: "ebi-control", status: "connected" }], capabilities: [] }); };
  } });
  await h.session.start(); await h.session.newConversation(); await waitEvents(h, 2);
  assert.deepEqual(h.events.map(event => event.event.kind), ["cleared", "session"]);
  await h.session.stop();
});

test("旧プロセスの終了が不明なら、新規起動も会話の消去も行わない", async () => {
  const h = makeSession({ configureBrain: (brain, index) => {
    if (index === 0) brain.stop = async () => { throw new Error("synthetic stop not confirmed"); };
  } });
  await h.session.start();
  await assert.rejects(h.session.newConversation(), /stop not confirmed/);
  assert.equal(h.brains.length, 1); assert.equal(h.session.state, "stopped");
  assert.equal(h.events.some(event => event.event.kind === "cleared"), false);
  assert.equal((await h.session.sendUserText("blocked")).accepted, false);
  h.brains[0].stop = async () => { h.brains[0].close(); };
  await h.session.stop();
});

// ===== PR-M4（入力系）=====

test("中断（chatStop）で turnEnd{aborted} が出た後も会話を続けられる", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("長い作業をして");
  assert.equal(h.session.state, "busy");

  await h.session.interrupt();
  assert.equal(h.brains[0]!.interrupted, 1);
  // 中断後の result は is_error:true で来るが、aborted:true として正規化されている
  //（claudeEvents.ts）。UI がエラーに化けさせないための分岐。
  h.brains[0]!.emit({
    kind: "turnEnd",
    ok: false,
    aborted: true,
    usage: null,
    costUsd: 0.01,
    errorText: null,
  });
  await waitEvents(h, 2);
  const end = h.events[h.events.length - 1]!.event;
  assert.equal(end.kind === "turnEnd" && end.aborted, true);
  assert.equal(end.kind === "turnEnd" && end.errorText, null);
  // 会話は生きたまま idle に戻り、次の発話がそのまま同じプロセスへ載る。
  assert.equal(h.session.state, "idle");
  assert.equal(h.brains.length, 1);

  const r = await h.session.sendUserText("では次のお願い");
  assert.equal(r.accepted, true);
  assert.equal(h.brains[0]!.sent[1], "では次のお願い");
  assert.equal(h.session.state, "busy");
});

test("画像添付: image ブロックとして投入され、本文には絶対パスが添えられる", async () => {
  const h = makeSession();
  await h.session.start();
  const attachment = {
    name: "chat-20260905-101112-0a1b2c3d.png",
    path: "/tmp/ebi/chat-attachments/chat-20260905-101112-0a1b2c3d.png",
    mediaType: "image/png",
    url: "/control/chat-attachment?name=chat-20260905-101112-0a1b2c3d.png",
    bytes: 1234,
  };
  await h.session.sendUserText("これ見て", {
    images: [{ mediaType: "image/png", base64: "AAAA" }],
    attachments: [attachment],
  });

  const input = h.brains[0]!.inputs[0]!;
  assert.deepEqual(input.images, [{ mediaType: "image/png", base64: "AAAA" }]);
  assert.match(input.text, /^これ見て\n\n\[添付ファイル\]\n\/tmp\/ebi/);
  // UI 側（トランスクリプト）には本文と添付メタが構造化されて載る。
  const ev = h.events[0]!.event;
  assert.equal(ev.kind, "user");
  assert.equal(ev.kind === "user" && ev.text, "これ見て");
  assert.deepEqual(ev.kind === "user" ? ev.attachments : null, [attachment]);
});

test("添付なしの発話は本文をそのまま送る（既存経路をいじらない）", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("ふつうの発話");
  const input = h.brains[0]!.inputs[0]!;
  assert.equal(input.text, "ふつうの発話");
  assert.equal(input.images, undefined);
  const ev = h.events[0]!.event;
  assert.equal(ev.kind === "user" && ev.attachments, undefined);
});

// ===== 承認 / 質問（PR-M5）=====

test("permission が来ると waiting になり、settled で busy へ戻る（pending の増減）", async () => {
  const h = makeSession();
  await h.session.start();
  const brain = h.brains[0]!;
  await h.session.sendUserText("やって");
  assert.equal(h.session.state, "busy");

  brain.emit({ kind: "permission", id: "t1", toolName: "Bash", input: { command: "rm -f x" } });
  await waitEvents(h, h.events.length + 1);
  assert.equal(h.session.state, "waiting");
  assert.equal(h.session.pendingCount, 1);

  brain.emit({ kind: "permissionSettled", id: "t1", outcome: "allowed", answer: "許可" });
  await waitEvents(h, h.events.length + 1);
  assert.equal(h.session.pendingCount, 0);
  assert.equal(h.session.state, "busy", "承認が済んだらターンの実行へ戻る");
  await h.session.stop();
});

test("answer() は brain へそのまま委譲し、pending は settled イベント側でだけ減る", async () => {
  const h = makeSession();
  await h.session.start();
  const brain = h.brains[0]!;
  brain.emit({ kind: "question", id: "q#0", header: "H", question: "Q", options: [], multi: true });
  await waitEvents(h, h.events.length + 1);
  assert.equal(h.session.pendingCount, 1);

  await h.session.answer("q#0", { choice: ["A"], text: "補足" });
  assert.deepEqual(brain.answered, [{ id: "q#0", decision: { choice: ["A"], note: "補足" } }]);
  // brain（＝ブローカ）が settled を出すまで pending は減らない。
  assert.equal(h.session.pendingCount, 1);
  brain.emit({ kind: "permissionSettled", id: "q#0", outcome: "allowed", answer: "A, 補足" });
  await waitEvents(h, h.events.length + 1);
  assert.equal(h.session.pendingCount, 0);
  await h.session.stop();
});

test("exit のあとに破棄が来ても stopped を busy へ上書きしない", async () => {
  const h = makeSession();
  await h.session.start();
  const brain = h.brains[0]!;
  brain.emit({ kind: "permission", id: "t1", toolName: "Bash", input: null });
  await waitEvents(h, h.events.length + 1);
  brain.emit({ kind: "exit", code: 1, signal: null });
  brain.emit({ kind: "permissionSettled", id: "t1", outcome: "discarded", answer: null });
  await waitEvents(h, h.events.length + 2);
  assert.equal(h.session.pendingCount, 0);
  assert.equal(h.session.state, "stopped");
  // 自動復帰（scheduleRestart）が走り切ってから止める（既存テストと同じ手順）。
  await sleep(30);
  await h.session.stop();
});

test("handlePermissionRequest は brain へ委譲し、未起動なら deny を返す", async () => {
  const h = makeSession();
  const before = await h.session.handlePermissionRequest({
    toolName: "Bash",
    input: null,
    toolUseId: null,
  });
  assert.equal(before.behavior, "deny");
  await h.session.start();
  // FakeBrain は requestPermission を持たない＝承認 UI 非対応 backend の扱いになる。
  const unsupported = await h.session.handlePermissionRequest({
    toolName: "Bash",
    input: null,
    toolUseId: null,
  });
  assert.equal(unsupported.behavior, "deny");
  assert.match(
    (unsupported as { behavior: "deny"; message: string }).message,
    /承認 UI に対応していません/,
  );
  await h.session.stop();
});

// ===== チャットへの画像共有（PR-M10）=====

test("shareImage: seq を進めてイベントを流し、snapshot に含まれる", async () => {
  const h = makeSession();
  await h.session.start();
  const before = h.events.length;
  h.session.shareImage([
    {
      name: "chat-20260905-101010-abcdef12.png",
      url: "/control/chat-attachment?name=chat-20260905-101010-abcdef12.png",
      mediaType: "image/png",
      bytes: 4242,
      sourcePath: "/home/boss/workspace/tmp/images/a.png",
      title: "エビ",
      caption: "生成サンプル",
    },
  ]);
  const envelope = h.events[before];
  assert.ok(envelope, "chatEvent が 1 件流れる");
  assert.equal(envelope!.event.kind, "image");
  assert.equal(
    envelope!.event.kind === "image" ? envelope!.event.images[0]!.name : null,
    "chat-20260905-101010-abcdef12.png",
  );
  // base64 は載せない（JSONL 肥大の防止）＝ name / url / メタだけ。
  assert.equal(JSON.stringify(envelope!.event).includes("base64"), false);
  // seq は既存イベントの続き（単調増加）。
  assert.equal(envelope!.seq, (h.events[before - 1]?.seq ?? 0) + 1);

  const snap = h.session.snapshot();
  assert.ok(
    snap.events.some((e) => e.event.kind === "image"),
    "snapshot（再接続・再起動後の復元）に image イベントが含まれる",
  );
  await h.session.stop();
});

test("shareImage: 空配列では何も流さない", async () => {
  const h = makeSession();
  await h.session.start();
  const before = h.events.length;
  h.session.shareImage([]);
  assert.equal(h.events.length, before);
  await h.session.stop();
});

// ===== PR-M11（返信 / 引用）=====

test("返信つき送信: CLI へは `> [reply to master#<seq>] <抜粋>` を前置した本文が渡る", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("その方針で進めて", {
    replyTo: { seq: 42, excerpt: "PR-A から着手します" },
  });
  assert.equal(h.brains[0]!.sent[0], "> [reply to master#42] PR-A から着手します\nその方針で進めて");
});

test("返信つき送信: 引用ヘッダ → 本文 → 添付フッタ の順に並ぶ", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("この画像を見て", {
    replyTo: { seq: 7, excerpt: "共有します" },
    attachments: [
      {
        name: "chat-1.png",
        path: "/tmp/chat-1.png",
        mediaType: "image/png",
        url: "/control/chat-attachment?name=chat-1.png",
        bytes: 10,
      },
    ],
  });
  assert.equal(
    h.brains[0]!.sent[0],
    "> [reply to master#7] 共有します\nこの画像を見て\n\n[添付ファイル]\n/tmp/chat-1.png",
  );
});

test("返信なしの送信は本文そのまま（既存の形を変えない）", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("ふつうの発話");
  assert.equal(h.brains[0]!.sent[0], "ふつうの発話");
});

test("返信つき送信: user イベントに replyTo が載り、会話ログから復元できる", async () => {
  const h = makeSession();
  await h.session.start();
  await h.session.sendUserText("了解", { replyTo: { seq: 3, excerpt: "確認をお願いします" } });
  const user = h.events.find((e) => e.event.kind === "user");
  assert.ok(user);
  assert.deepEqual(
    user.event.kind === "user" ? user.event.replyTo : null,
    { seq: 3, excerpt: "確認をお願いします" },
  );
});

test("sanitizeReplyRef: 抜粋は 1 行に潰して 200 文字で切る（制御文字も落とす）", () => {
  const ref = sanitizeReplyRef({ seq: 5, excerpt: `改行\nと\tタブ\u0007ベル ${"あ".repeat(300)}` });
  assert.equal(ref?.seq, 5);
  assert.equal(ref?.excerpt.length, 200);
  assert.match(ref!.excerpt, /^改行 と タブ ベル あ+$/);
});

test("sanitizeReplyRef: seq が正整数でなければ引用を落とす（送信自体は通す）", () => {
  assert.equal(sanitizeReplyRef(undefined), undefined);
  assert.equal(sanitizeReplyRef({ seq: 0, excerpt: "x" }), undefined);
  assert.equal(sanitizeReplyRef({ seq: -1, excerpt: "x" }), undefined);
  assert.equal(sanitizeReplyRef({ seq: 1.5, excerpt: "x" }), undefined);
  assert.equal(sanitizeReplyRef({ seq: "3", excerpt: "x" }), undefined);
  // excerpt が無い / 文字列でないときは空の抜粋で通す（seq だけでも参照は成立する）。
  assert.deepEqual(sanitizeReplyRef({ seq: 3 }), { seq: 3, excerpt: "" });
});

test("replyQuoteLine: CLI に届く 1 行の形", () => {
  assert.equal(replyQuoteLine({ seq: 12, excerpt: "抜粋" }), "> [reply to master#12] 抜粋");
});
