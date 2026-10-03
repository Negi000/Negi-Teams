// Read-only MasterBrain bridge for a deliberately supplied App Server process.
// No executable is selected here. Task tools are supplied by the local server only.
import { AppServerProcess, type AppServerProcessOptions } from "./appServerProcess.ts";
import { unsupportedOf, type MasterBrain, type MasterBrainCapabilities,
  type MasterBrainInput, type MasterBrainStartOptions, type MasterEvent,
  type MasterUsage } from "./brain.ts";
import type { CodexTurnObservation } from "./appServerClient.ts";
import type { CodexThreadOptions } from "./appServerClient.ts";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { MasterConversationAuthority, MasterConversationResult } from "../orchestration/masterConversations.ts";
import type { RegisteredTaskTools } from "../orchestration/taskDispatchTools.ts";
import type { TaskResultContext } from "../orchestration/taskResults.ts";
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
  /** Trusted startup requirements; metadata is never forwarded to the provider. */
  requiredModels?: ReadonlyArray<{model:string;effort:string}>;
  admission?: MasterTurnAdmission;
  /** Host registration only; never chosen by browser/model input. */
  conversations?: MasterConversationAuthority;
  masterId?: string;
}

const taskInstructions = "\n登録済みTaskの委任はnegi_list_tasks、negi_read_task、negi_dispatch_taskを使う。" +
  "委任前に固定契約と現在の状態を読み、カタログのconfigSha256を使う。" +
  "自由文のPTY起動やshellによる委任は行わない。未登録の依頼はTask Contractの確定が必要と伝える。" +
  "操作結果が不明な場合は再委任せずnegi_read_taskで照合する。検証済みと人間受入済みを区別する。" +
  "Taskの固定結果通知と伝達状態はnegi_list_task_resultsで確認できる。" +
  "実行許可、成果受入、契約変更はこのツールの権限外。";
const authoringInstructions = "\n新しい依頼は、negi_list_projectsで設定済みプロジェクトを選び、negi_read_projectで必須仕様と参照の版を読む。" +
  "Astraとして目的・対象内外・許可パス・不変条件・受入・差戻し・制限・短い実行計画を作りnegi_propose_taskへ渡す。" +
  "大きい依頼で分解が有益なときだけnegi_propose_task_decompositionで2〜8件に分け、依存・共有条件・引継ぎ成果を明記する。" +
  "独立Taskの変更可能パスを分離する。先行Taskのある後続は計画だけで、先行成果の統合後に実際の基準SHAを読んで新しい案を作る。" +
  "統合成果から続ける場合はnegi_read_projectのintegrationBasesにある保存済み基準を確認し、baseline_idを指定して再読と契約案を作る。未保存・未受入の基準や古いHEADで後続を代用しない。" +
  "未確認の仕様、未知のコマンド、未設定の権限や先行成果を捏造しない。案の保存で実装を開始しない。" +
  "返された契約画面URLを利用者に案内する。案の保存と実行開始を区別する。確定済み計画はSolに直接渡される。";

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
  private starting = false;
  private startOptions: { cwd: string; model: string } | null = null;
  private pendingSend: Promise<{ acked: boolean }> | null = null;
  private settlement: Promise<void> | null = null;
  private rotating = false;
  private threadOptions: CodexThreadOptions | null = null;
  private settingsSha256: string | null = null;
  private binding: MasterConversationResult | null = null;

  constructor(private readonly options: CodexAppServerBrainOptions) {}

  get pid(): number | null { return this.process?.pid ?? null; }
  sessionId(): string | null { return this.process?.client.currentThread?.threadId ?? null; }
  get conversationBoundary() {
    const b = this.binding;
    return b?.request.mode === "rotate" && b.identity
      ? { requestId: b.request.requestId, oldThreadId: b.request.oldThreadId!, newThreadId: b.identity.threadId } : null;
  }

  async start(options: MasterBrainStartOptions): Promise<void> {
    if (this.starting || this.process || !this.options.executable || !this.options.effort ||
        !Number.isSafeInteger(this.options.turnTimeoutMs) || this.options.turnTimeoutMs < 1) {
      throw new Error("Codex App Server brain process options invalid or already started");
    }
    if (!options.model || (options.resumeSessionId && !this.options.conversations) || options.controlMcp || options.mcpConfigPath ||
        options.extraArgs.length > 0 || ![null, "default", "plan"].includes(options.permissionMode)) {
      throw new Error("read-only Codex brain does not support these start options");
    }
    this.starting = true;
    this.closed = false;
    this.stopping = false;
    try {
      const session = this.options.conversations ? await this.startHeld(options) : await this.withStorage(() => this.startHeld(options));
      if (this.closed || this.stopping) throw new Error("Codex brain stopped before readiness");
      this.emit(session);
    } catch (error) {
      this.stopping = true;
      await this.stopOwnedProcess();
      throw error;
    } finally { this.starting = false; }
  }

  private withStorage<T>(run: () => Promise<T>): Promise<T> {
    return this.options.admission?.withStorage ? this.options.admission.withStorage(run) : run();
  }

  private async stopOwnedProcess(): Promise<void> { await this.process?.stop(); }

  private async startHeld(options: MasterBrainStartOptions): Promise<Extract<MasterEvent, { kind: "session" }>> {
    if (this.closed || this.stopping || this.process || !options.model) throw new Error("Codex brain stopped or already started before storage admission");
    await this.options.admission?.assertIdle?.(options.cwd);
    await this.options.admission?.assertStorageCompatible?.();
    const cwd = this.options.conversations ? await realpath(options.cwd) : options.cwd;
    this.threadOptions = { cwd, model: options.model, sandbox: "read-only",
      ...((options.systemPrompt || this.options.taskTools) ? {
        instructions: (options.systemPrompt ?? "") + (this.options.taskTools ? taskInstructions : "") +
          (this.options.taskTools?.authoring ? authoringInstructions : "") } : {}),
      ...(this.options.taskTools ? { dynamicTools: this.options.taskTools.definitions, dynamicToolLimits: this.options.taskTools.limits } : {}),
      ...(this.options.conversations ? { resident: { effort: this.options.effort } } : {}) };
    this.settingsSha256 = createHash("sha256").update(JSON.stringify({ ...this.threadOptions,
      executable: this.options.executable, args: this.options.args, subscriptionOnly: this.options.subscriptionOnly === true })).digest("hex");
    const saved = await this.options.conversations?.resident(cwd);
    if (saved?.current && (saved.current.request.settingsSha256 !== this.settingsSha256 ||
        saved.current.request.model !== options.model || saved.current.request.effort !== this.options.effort ||
        (options.resumeSessionId && options.resumeSessionId !== saved.current.identity!.threadId)))
      throw new Error("保存済みの会話と担当設定が異なります。設定と会話の記録を確認してください。");
    if (this.closed || this.stopping) throw new Error("Codex brain stopped before App Server launch");
    this.startOptions = { cwd, model: options.model };
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
      await this.options.admission?.assertStorageCompatible?.();
      await process.client.initialize();
      if (this.options.subscriptionOnly) {
        const account=await process.client.readAccountMode();
        if(account.type!=="chatgpt"||account.requiresOpenaiAuth!==true)throw new Error("Codex master requires ChatGPT subscription authentication");
      }
      const catalog = await process.client.discoverModels();
      if (![{model:options.model,effort:this.options.effort},...(this.options.requiredModels??[])].every(role=>catalog.some((model) => model.model === role.model &&
          model.efforts.includes(role.effort) && model.inputModalities.includes("text")))) {
        throw new Error("requested model, effort or text input unavailable in account catalog");
      }
      await this.options.admission?.assertStorageCompatible?.();
      if (this.closed || this.stopping) throw new Error("Codex brain stopped before thread/start");
      let identity;
      if (this.options.conversations) {
        if (!this.options.masterId) throw new Error("resident Master registration missing");
        const fresh = await this.options.conversations.resident(cwd);
        if (!isDeepStrictEqual(saved, fresh)) throw new Error("resident conversation changed during startup");
        if (fresh.current) {
          const expected = { ...this.threadOptions, resident: { effort: this.options.effort,
            modelProvider: fresh.current.identity!.modelProvider } };
          await process.client.verifyResidentTurns(fresh.current.identity!.threadId, expected, fresh.turns);
          identity = await process.client.resumeThread(fresh.current.identity!.threadId, options.model, expected);
          await process.client.verifyResidentTurns(identity.threadId, expected, fresh.turns);
          if (!isDeepStrictEqual(fresh, await this.options.conversations.resident(cwd))) throw new Error("local conversation changed during provider resume");
          process.client.markReconciled(identity.threadId, null, "signed-resident-" + fresh.current.request.requestId);
          this.binding = fresh.current;
        } else {
          this.binding = await this.options.conversations.start({ requestId: randomUUID(), masterId: this.options.masterId,
            mode: "start", oldThreadId: null, cwd, model: options.model, effort: this.options.effort,
            provider: null, settingsSha256: this.settingsSha256! }, async mark => {
            if (this.closed || this.stopping) throw new Error("resident stopped before initial conversation");
            await mark(); return process.client.startThread(this.threadOptions!);
          }, { resident: true });
          identity = this.binding.identity!;
        }
      } else identity = await process.client.startThread(this.threadOptions);
      await this.options.admission?.assertStorageCompatible?.();
      if (this.closed || this.stopping) throw new Error("Codex brain stopped during thread/start");
      if (identity.rerouted) throw new Error("App Server rerouted the requested model");
      return { kind: "session", sessionId: identity.threadId, model: identity.resolvedModel,
        apiKeySource: null, mcpServers: [], capabilities: ["read-only",
          ...(this.options.taskTools ? ["registered-task-tools"] : [])] };
    } catch (error) {
      this.stopping = true;
      await process.stop();
      throw error;
    }
  }

  async send(input: MasterBrainInput): Promise<{ acked: boolean }> {
    if (this.rotating || this.starting || this.pendingSend || this.settlement || this.process?.client.activeTurn || this.process?.client.pendingDynamicTools)
      throw new MasterInputNotSentError("統括は実行中です。今回の入力は未送信です。");
    let entered = false;
    const pending = this.withStorage(() => { entered = true; return this.sendTurn(input); }).catch(async error => {
      if (!entered) throw new MasterInputNotSentError("保存処理の実行枠を取得できませんでした。今回の入力は未送信です。");
      if (!(error instanceof MasterInputNotSentError)) await this.process?.stop();
      throw error;
    });
    this.pendingSend = pending;
    try { return await pending; }
    finally { if (this.pendingSend === pending) this.pendingSend = null; }
  }

  async newConversation(request: { requestId: string; oldThreadId: string }) {
    const authority = this.options.conversations, process = this.process, options = this.threadOptions;
    if (!authority || !process || !options || !this.options.masterId || !this.settingsSha256)
      throw new Error("Codex master の新しい会話は結果照合とrun台帳の接続後に利用できます");
    if (this.rotating || this.starting || this.pendingSend || this.settlement || this.closed || this.stopping)
      throw new Error("統括の実行または会話切替が進行中です。");
    this.rotating = true;
    try {
      process.client.assertQuiescent();
      const existing = await authority.status(request.requestId);
      if (existing) {
        if (existing.request.mode !== "rotate" || existing.request.oldThreadId !== request.oldThreadId ||
            existing.request.settingsSha256 !== this.settingsSha256 || existing.stage !== "completed" ||
            existing.identity?.threadId !== this.sessionId() || existing.exclusionHeld)
          throw new Error("会話の作成結果を照合してください。同じ要求を再実行していません。");
        return { requestId: request.requestId, oldThreadId: request.oldThreadId, newThreadId: existing.identity.threadId };
      }
      if (this.sessionId() !== request.oldThreadId) throw new Error("確認した会話が切り替わっています。現在の会話を確認してください。");
      const pinned = await authority.resident(options.cwd);
      if (pinned.current?.identity?.threadId !== request.oldThreadId || pinned.current.request.settingsSha256 !== this.settingsSha256)
        throw new Error("保存済みの会話を照合できません。");
      const expected = { ...options, resident: { effort: this.options.effort, modelProvider: pinned.current.identity.modelProvider } };
      await process.client.verifyResidentTurns(request.oldThreadId, expected, pinned.turns);
      this.binding = await authority.start({ requestId: request.requestId, masterId: this.options.masterId, mode: "rotate",
        oldThreadId: request.oldThreadId, cwd: options.cwd, model: options.model, effort: this.options.effort,
        provider: pinned.current.identity.modelProvider, settingsSha256: this.settingsSha256 }, async mark => {
        process.client.assertQuiescent();
        if (this.closed || this.stopping) throw new Error("resident stopped before rotation");
        await mark(); return process.client.rotateThread(expected, request.oldThreadId);
      }, { resident: true });
      return { requestId: request.requestId, oldThreadId: request.oldThreadId, newThreadId: this.binding.identity!.threadId };
    } catch (error) {
      // The Session holds after an unsuccessful rotation. Stop this owned
      // connection even when the provider succeeded but durable binding failed.
      await process.stop();
      throw error;
    } finally { this.rotating = false; }
  }

  private async sendTurn(input: MasterBrainInput): Promise<{ acked: boolean }> {
    const process = this.process;
    if (!process || this.closed || this.stopping || !this.startOptions || (input.images?.length ?? 0) > 0) {
      throw new Error("Codex read-only brain is stopped or image input is unsupported");
    }
    let resultContext: TaskResultContext | null = null;
    try { resultContext = await this.options.taskTools?.prepareResultContext?.(this.sessionId()!, input.text) ?? null; }
    catch { throw new MasterInputNotSentError("Taskの結果通知を照合できません。今回の入力は未送信です。"); }
    const text = resultContext?.text ?? input.text;
    let lease: MasterTurnLease | undefined;
    try {
      lease = await this.options.admission?.reserve({ ...this.startOptions, text,
        effort: this.options.effort, threadId: this.sessionId()! });
    } catch (error) {
      await resultContext?.notSent();
      if (error instanceof MasterInputNotSentError) throw error;
      throw new MasterInputNotSentError(`実行枠の確認に失敗しました。今回の入力は未送信です: ${(error as Error).message}`);
    }
    if (this.closed || this.stopping) {
      await lease?.cancelBeforeDispatch();
      await resultContext?.notSent();
      throw new MasterInputNotSentError("送信前に統括が停止しました。今回の入力は未送信です。");
    }
    try { await lease?.dispatching(); await resultContext?.dispatching(); await this.options.admission?.assertStorageCompatible?.(); }
    catch (error) {
      try { await lease?.cancelBeforeDispatch(); }
      catch { await this.holdUnknown(lease, "Master dispatch record failed before provider call; inspect scheduler evidence"); }
      try { await resultContext?.notSent(); } catch { /* prepared receipt remains blocked for inspection */ }
      throw new MasterInputNotSentError(`送信記録を保存できませんでした。今回の入力は未送信です: ${(error as Error).message}`);
    }
    let turnId: string;
    try {
      turnId = await process.client.startTurn(text, this.options.effort);
      await lease?.bind(turnId);
      await resultContext?.bind(turnId);
    }
    catch (error) {
      await this.holdUnknown(lease, "Master turn/start or durable provider binding was not confirmed");
      try { await resultContext?.unknown(); } catch { /* incomplete receipt must not replay */ }
      await process.stop();
      throw error;
    }
    const settlement = this.settleTurn(process, turnId, lease, resultContext);
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

  private async settleTurn(process: AppServerProcess, turnId: string, lease?: MasterTurnLease,
    resultContext?: TaskResultContext | null): Promise<void> {
    try {
      await process.client.waitForTurn(turnId, this.options.turnTimeoutMs);
      const observation = await process.client.waitForTurnOperations(turnId, this.options.turnTimeoutMs);
      if (observation.status === "unknown" ||
          (observation.status === "completed" && observation.finalText === null)) {
        throw new Error("turn outcome or final answer is unknown");
      }
      await this.withStorage(async () => {
        await resultContext?.terminal(observation);
        await lease?.complete(observation);
      });
      if (observation.status === "completed") {
        this.emit({ kind: "text", text: observation.finalText!, partial: false });
      }
      // The next input may be sent synchronously by a turnEnd listener.
      this.settlement = null;
      this.emit({ kind: "turnEnd", ok: observation.status === "completed",
        aborted: observation.status === "interrupted", usage: usageOf(observation),
        costUsd: null, errorText: observation.status === "failed" ? "Codex turn failed" : null });
    } catch (error) {
      try {
        await this.withStorage(async () => {
          await this.holdUnknown(lease, "Master provider result or durable terminal evidence unknown; inspect before release");
          await resultContext?.unknown();
        });
      } catch {
        // No storage admission proves no release; preserve the original claim.
        this.emit({ kind: "notice", level: "error", text: "照合記録を保存できませんでした。台帳の確認が必要です。" });
      }
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
