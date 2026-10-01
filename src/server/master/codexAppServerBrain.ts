// Read-only MasterBrain bridge for a deliberately supplied App Server process.
// No executable is selected here, and the normal master factory does not use it.
import { AppServerProcess, type AppServerProcessOptions } from "./appServerProcess.ts";
import { unsupportedOf, type MasterBrain, type MasterBrainCapabilities,
  type MasterBrainInput, type MasterBrainStartOptions, type MasterEvent,
  type MasterUsage } from "./brain.ts";
import type { CodexTurnObservation } from "./appServerClient.ts";

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
}

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
    const process = (this.options.launch ?? AppServerProcess.launch)({
      executable: this.options.executable, args: this.options.args, cwd: options.cwd,
      client: {
        onNotice: (method, params) => this.onNotice(method, params),
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
      const catalog = await process.client.discoverModels();
      if (!catalog.some((model) => model.model === options.model &&
          model.efforts.includes(this.options.effort) && model.inputModalities.includes("text"))) {
        throw new Error("requested model, effort or text input unavailable in account catalog");
      }
      const identity = await process.client.startThread({ cwd: options.cwd, model: options.model,
        sandbox: "read-only", ...(options.systemPrompt ? { instructions: options.systemPrompt } : {}) });
      if (identity.rerouted) throw new Error("App Server rerouted the requested model");
      this.emit({ kind: "session", sessionId: identity.threadId, model: identity.resolvedModel,
        apiKeySource: null, mcpServers: [], capabilities: ["read-only"] });
    } catch (error) {
      this.stopping = true;
      await process.stop();
      throw error;
    }
  }

  async send(input: MasterBrainInput): Promise<{ acked: boolean }> {
    const process = this.process;
    if (!process || this.closed || (input.images?.length ?? 0) > 0) {
      throw new Error("Codex read-only brain is stopped or image input is unsupported");
    }
    let turnId: string;
    try { turnId = await process.client.startTurn(input.text, this.options.effort); }
    catch (error) {
      void process.stop();
      throw error;
    }
    void this.settleTurn(process, turnId);
    return { acked: true };
  }

  private async settleTurn(process: AppServerProcess, turnId: string): Promise<void> {
    try {
      const observation = await process.client.waitForTurn(turnId, this.options.turnTimeoutMs);
      if (observation.status === "unknown" ||
          (observation.status === "completed" && observation.finalText === null)) {
        throw new Error("turn outcome or final answer is unknown");
      }
      if (observation.status === "completed") {
        this.emit({ kind: "text", text: observation.finalText!, partial: false });
      }
      this.emit({ kind: "turnEnd", ok: observation.status === "completed",
        aborted: observation.status === "interrupted", usage: usageOf(observation),
        costUsd: null, errorText: observation.status === "failed" ? "Codex turn failed" : null });
    } catch (error) {
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
