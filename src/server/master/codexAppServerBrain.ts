// Read-only MasterBrain bridge for a deliberately supplied App Server process.
// No executable is selected here. Task tools are supplied by the local server only.
import { AppServerProcess, type AppServerProcessOptions } from "./appServerProcess.ts";
import { unsupportedOf, type MasterBrain, type MasterBrainCapabilities,
  type MasterBrainInput, type MasterBrainStartOptions, type MasterEvent,
  type MasterUsage } from "./brain.ts";
import type { CodexTurnObservation } from "./appServerClient.ts";
import type { RegisteredTaskTools } from "../orchestration/taskDispatchTools.ts";
import { subscriptionChildEnv } from "./boundedAppServer.ts";
import { MasterInputNotSentError, type MasterTurnAdmission,
  type MasterTurnLease } from "../orchestration/masterTurnAdmission.ts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue : null;
}
function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface CodexAppServerBrainOptions {
  /** Explicit executable and arguments; no default Codex command is inferred. */
  executable: string;
  args: string[];
  effort: string;
  turnTimeoutMs: number;
  launch?: (options: AppServerProcessOptions) => AppServerProcess;
  taskTools?: RegisteredTaskTools;
  subscriptionOnly?: boolean;
  admission?: MasterTurnAdmission;
}

const taskInstructions = "\n登録済みTaskの委任はnegi_list_tasks、negi_read_task、negi_dispatch_taskを使う。" +
  "委任前に固定契約と現在の状態を読み、カタログのconfigSha256を使う。" +
  "自由文のPTY起動やshellによる委任は行わない。未登録の依頼はTask Contractの確定が必要と伝える。" +
  "操作結果が不明な場合は再委任せずnegi_read_taskで照合する。検証済みと人間受入済みを区別する。" +
  "実行許可、成果受入、契約変更はこのツールの権限外。";

export const CODEX_READ_ONLY_BRAIN_CAPABILITIES: MasterBrainCapabilities = {
  partialText: true, thinking: false, permissionPrompt: false,
  askUserQuestion: false, interrupt: true, resume: false,
  cost: false, contextPct: true, images: false,
};

function usageOf(observation: CodexTurnObservation): MasterUsage | null {
  const last = observation.lastUsage;
  if (!last) return null;
  const input = token(last.inputTokens);
  const output = token(last.outputTokens);
  const cacheRead = token(last.cachedInputTokens);
  const cacheCreation = token(last.cacheWriteInputTokens);
  const contextTokens = observation.contextInputTokens;
  const contextSize = observation.contextWindow;
  return { input, output, cacheRead, cacheCreation, contextTokens, contextSize,
    contextUsedPct: contextTokens !== null && contextSize !== null
      ? contextTokens / contextSize * 100 : null };
}

export class CodexAppServerBrain implements MasterBrain {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_READ_ONLY_BRAIN_CAPABILITIES;
  readonly unsupported = unsupportedOf(this.capabilities);
  private process: AppServerProcess | null = null;
  private readonly queue: MasterEvent[] = [];
  private waiter: ((value: IteratorResult<MasterEvent>) => void) | null = null;
  private closed = false;
  private stopping = false;
  private startOptions: { cwd: string; model: string } | null = null;
  private pendingSend: Promise<{ acked: boolean }> | null = null;
  private settlement: Promise<void> | null = null;

  constructor(private readonly options: CodexAppServerBrainOptions) {}

  get pid(): number | null { return this.process?.pid ?? null; }
  sessionId(): string | null { return this.process?.client.currentThread?.threadId ?? null; }

  async start(options: MasterBrainStartOptions): Promise<void> {
    if (this.process || !this.options.executable || !this.options.effort ||
        !Number.isSafeInteger(this.options.turnTimeoutMs) || this.options.turnTimeoutMs < 1) {
      throw new Error("Codex App Server brain process options invalid or already started");
    }
    if (!options.model || options.resumeSessionId || options.controlMcp || options.mcpConfigPath ||
        options.extraArgs.length > 0 || ![null, "default", "plan"].includes(options.permissionMode)) {
      throw new Error("read-only Codex brain does not support these start options");
    }
    this.closed = false;
    this.stopping = false;
    this.startOptions = { cwd: options.cwd, model: options.model };
    const process = (this.options.launch ?? AppServerProcess.launch)({
      executable: this.options.executable, args: this.options.args, cwd: options.cwd,
      ...(this.options.subscriptionOnly ? { env: subscriptionChildEnv() } : {}),
      client: {
        onNotice: (method, params) => this.onNotice(method, params),
        ...(this.options.taskTools ? { onDynamicToolCall: async (call) => {
          this.emit({ kind: "toolCall", id: call.callId, name: call.tool, input: call.arguments });
          const result = await this.options.taskTools!.invoke(call);
          this.emit({ kind: "toolResult", id: call.callId, ok: result.success, content: result.text });
          return result;
        } } : {}),
        onClose: (reason) => {
          if (!this.stopping) this.emit({ kind: "notice", level: "error",
            text: `App Server 接続終了。turn結果の照合が必要です: ${reason.message}` });
        },
      },
    });
    this.process = process;
    void process.exited.then((exit) => {
      this.emit({ kind: "exit", code: exit.code, signal: exit.signal });
      this.finish();
    });
    try {
      await process.client.initialize();
      if (this.options.subscriptionOnly && (await process.client.readAccountMode()).type !== "chatgpt")
        throw new Error("Codex master requires ChatGPT subscription authentication");
      const catalog = await process.client.discoverModels();
      if (!catalog.some((model) => model.model === options.model &&
          model.efforts.includes(this.options.effort) && model.inputModalities.includes("text"))) {
        throw new Error("requested model, effort or text input unavailable in account catalog");
      }
      const identity = await process.client.startThread({ cwd: options.cwd, model: options.model,
        sandbox: "read-only",
        ...((options.systemPrompt || this.options.taskTools) ? {
          instructions: (options.systemPrompt ?? "") + (this.options.taskTools ? taskInstructions : "") } : {}),
        ...(this.options.taskTools ? { dynamicTools: this.options.taskTools.definitions } : {}) });
      if (identity.rerouted) throw new Error("App Server rerouted the requested model");
      this.emit({ kind: "session", sessionId: identity.threadId, model: identity.resolvedModel,
        apiKeySource: null, mcpServers: [], capabilities: ["read-only",
          ...(this.options.taskTools ? ["registered-task-tools"] : [])] });
    } catch (error) {
      this.stopping = true;
      await process.stop();
      throw error;
    }
  }

  async send(input: MasterBrainInput): Promise<{ acked: boolean }> {
    if (this.pendingSend || this.settlement || this.process?.client.activeTurn)
      throw new MasterInputNotSentError("統括は実行中です。今回の入力は未送信です。");
    const pending = this.sendTurn(input);
    this.pendingSend = pending;
    try { return await pending; }
    finally { if (this.pendingSend === pending) this.pendingSend = null; }
  }

  private async sendTurn(input: MasterBrainInput): Promise<{ acked: boolean }> {
    const process = this.process;
    if (!process || this.closed || this.stopping || !this.startOptions || (input.images?.length ?? 0) > 0) {
      throw new Error("Codex read-only brain is stopped or image input is unsupported");
    }
    let lease: MasterTurnLease | undefined;
    try {
      lease = await this.options.admission?.reserve({ ...this.startOptions, text: input.text,
        effort: this.options.effort, threadId: this.sessionId()! });
    } catch (error) {
      if (error instanceof MasterInputNotSentError) throw error;
      throw new MasterInputNotSentError(`実行枠の確認に失敗しました。今回の入力は未送信です: ${(error as Error).message}`);
    }
    if (this.closed || this.stopping) {
      await lease?.cancelBeforeDispatch();
      throw new MasterInputNotSentError("送信前に統括が停止しました。今回の入力は未送信です。");
    }
    try { await lease?.dispatching(); }
    catch (error) {
      try { await lease?.cancelBeforeDispatch(); }
      catch { await this.holdUnknown(lease, "Master dispatch record failed before provider call; inspect scheduler evidence"); }
      throw new MasterInputNotSentError(`送信記録を保存できませんでした。今回の入力は未送信です: ${(error as Error).message}`);
    }
    let turnId: string;
    try {
      turnId = await process.client.startTurn(input.text, this.options.effort);
      await lease?.bind(turnId);
    }
    catch (error) {
      await this.holdUnknown(lease, "Master turn/start or durable provider binding was not confirmed");
      await process.stop();
      throw error;
    }
    const settlement = this.settleTurn(process, turnId, lease);
    this.settlement = settlement;
    void settlement.finally(() => { if (this.settlement === settlement) this.settlement = null; }).catch(() => {});
    return { acked: true };
  }

  private async holdUnknown(lease: MasterTurnLease | undefined, reason: string): Promise<void> {
    try { await lease?.unknown(reason); }
    catch {
      // A failed ledger append cannot prove release. The original running claim remains reserved.
      this.emit({ kind: "notice", level: "error", text: "実行枠の照合記録を保存できませんでした。台帳の確認が必要です。" });
    }
  }

  private async settleTurn(process: AppServerProcess, turnId: string, lease?: MasterTurnLease): Promise<void> {
    try {
      const observation = await process.client.waitForTurn(turnId, this.options.turnTimeoutMs);
      if (observation.status === "unknown" ||
          (observation.status === "completed" && observation.finalText === null)) {
        throw new Error("turn outcome or final answer is unknown");
      }
      await lease?.complete(observation);
      if (observation.status === "completed") {
        this.emit({ kind: "text", text: observation.finalText!, partial: false });
      }
      this.emit({ kind: "turnEnd", ok: observation.status === "completed",
        aborted: observation.status === "interrupted", usage: usageOf(observation),
        costUsd: null, errorText: observation.status === "failed" ? "Codex turn failed" : null });
    } catch (error) {
      await this.holdUnknown(lease, "Master provider result or durable terminal evidence unknown; inspect before release");
      this.emit({ kind: "notice", level: "error",
        text: `Codex turn ${turnId} の結果は未確定です。再送前に照合してください: ${(error as Error).message}` });
      await process.stop();
    }
  }

  events(): AsyncIterable<MasterEvent> {
    const self = this;
    return { [Symbol.asyncIterator](): AsyncIterator<MasterEvent> {
      return { next(): Promise<IteratorResult<MasterEvent>> {
        const buffered = self.queue.shift();
        if (buffered) return Promise.resolve({ value: buffered, done: false });
        if (self.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { self.waiter = resolve; });
      } };
    } };
  }

  async answer(): Promise<void> { throw new Error("Codex read-only brain has no approval UI bridge"); }
  async interrupt(): Promise<void> {
    if (this.process?.client.activeTurn) await this.process.client.interrupt();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.process) await this.process.stop();
    await this.pendingSend?.catch(() => {});
    await this.settlement;
    this.finish();
  }

  private onNotice(method: string, params: unknown): void {
    if (method !== "item/agentMessage/delta") return;
    const p = record(params);
    if (p?.threadId !== this.sessionId() || p?.turnId !== this.process?.client.activeTurn ||
        typeof p.delta !== "string") return;
    this.emit({ kind: "text", text: p.delta, partial: true });
  }
  private emit(event: MasterEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: event, done: false });
    } else this.queue.push(event);
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }
}
