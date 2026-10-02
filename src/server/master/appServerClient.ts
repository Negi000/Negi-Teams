// Version-sensitive Codex App Server client, checked against locally generated
// 0.158.0-alpha.2.1 types and 0.159.2 experimental dynamic tools. It owns streams, never spawns a process.
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { AppServerTransport } from "./appServerTransport.ts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue : null;
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function requiredString(value: unknown, field: string): string {
  const result = string(value);
  if (!result) throw new Error(`App Server response missing ${field}; outcome needs reconciliation`);
  return result;
}

export interface CodexModelCapability {
  model: string;
  efforts: string[];
  inputModalities: string[];
}
export interface CodexThreadIdentity {
  threadId: string;
  requestedModel: string;
  resolvedModel: string;
  modelProvider: string;
  rerouted: boolean;
}
export interface CodexTurnObservation {
  turnId: string;
  status: "inProgress" | "completed" | "failed" | "interrupted" | "unknown";
  finalText: string | null;
  contextInputTokens: number | null;
  contextWindow: number | null;
  lastUsage: RecordValue | null;
}
export interface CodexProviderTurnInspection {
  threadId: string;
  turnId: string;
  found: boolean;
  status: "inProgress" | "completed" | "failed" | "interrupted" | null;
  pagesRead: number;
  completeSearch: boolean;
  observedAtMs: number;
  source: "thread/turns/list";
}
export interface CodexApprovalRequest {
  id: string | number;
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  threadId: string;
  turnId: string;
  itemId: string;
  target: string;
  targetKnown: boolean;
  cwd: string | null;
  expiresAtMs: number;
}
export interface AppServerClientOptions {
  now?: () => number;
  approvalTtlMs?: number;
  transportTimeoutMs?: number;
  onNotice?: (method: string, params: unknown) => void;
  onApproval?: (request: CodexApprovalRequest) => void;
  onClose?: (reason: Error) => void;
  /** Only server-owned function tools; never forwarded from browser/model input. */
  onDynamicToolCall?: (request: CodexDynamicToolCall) => Promise<CodexDynamicToolResult>;
}
export interface CodexDynamicToolDefinition {
  type: "function"; name: string; description: string; inputSchema: Record<string, unknown>;
}
/** Host-owned limits. These are never sent to the provider or read from tool arguments. */
export interface CodexDynamicToolLimits { argumentBytes: number; resultBytes: number }
export interface CodexDynamicToolCall {
  threadId: string; turnId: string; callId: string; tool: string; arguments: unknown;
}
export interface CodexDynamicToolResult { success: boolean; text: string }

export class CodexAppServerClient {
  private readonly transport: AppServerTransport;
  private readonly now: () => number;
  private readonly approvalTtlMs: number;
  private initialized = false;
  private catalog: CodexModelCapability[] | null = null;
  private identity: CodexThreadIdentity | null = null;
  private threadRequestPending = false;
  private activeTurnId: string | null = null;
  private turnRequestPending = false;
  private needsReconciliation = false;
  private closedReason: Error | null = null;
  private readonly observations = new Map<string, CodexTurnObservation>();
  private readonly turnWaiters = new Map<string, {
    resolve: (value: CodexTurnObservation) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly approvals = new Map<string, CodexApprovalRequest>();
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();
  private dynamicToolNames = new Set<string>();
  private dynamicToolLimits = new Map<string, CodexDynamicToolLimits>();
  private readonly dynamicCalls = new Map<string, { fingerprint: string; result: Promise<CodexDynamicToolResult> }>();
  /** Provider completion does not imply that host tool side effects have settled. */
  private readonly activeDynamicCalls = new Set<Promise<CodexDynamicToolResult>>();

  constructor(readable: Readable, writable: Writable, private readonly options: AppServerClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? 300_000;
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs < 1) {
      throw new Error("approval TTL invalid");
    }
    this.transport = new AppServerTransport(readable, writable, {
      timeoutMs: options.transportTimeoutMs,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
      onUnknownMessage: (message) => options.onNotice?.("unknown/message", message),
      onClose: (reason) => {
        this.closedReason = reason;
        this.needsReconciliation = this.activeTurnId !== null || this.needsReconciliation;
        this.approvals.clear();
        for (const timer of this.approvalTimers.values()) clearTimeout(timer);
        this.approvalTimers.clear();
        for (const waiter of this.turnWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(reason);
        }
        this.turnWaiters.clear();
        options.onClose?.(reason);
      },
    });
  }

  get currentThread(): CodexThreadIdentity | null { return this.identity && { ...this.identity }; }
  get activeTurn(): string | null { return this.activeTurnId; }
  get pendingDynamicTools(): number { return this.activeDynamicCalls.size; }
  get dispatchBlocked(): boolean {
    return this.closedReason !== null || this.needsReconciliation || this.identity?.rerouted === true;
  }
  get pendingApprovals(): CodexApprovalRequest[] { return [...this.approvals.values()].map((p) => ({ ...p })); }
  getObservation(turnId: string): CodexTurnObservation | null {
    const value = this.observations.get(turnId);
    return value ? { ...value, lastUsage: value.lastUsage && { ...value.lastUsage } } : null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = record(await this.transport.request("initialize", {
      clientInfo: { name: "negi-teams", title: "Negi-Teams", version: "0.1.0" },
      capabilities: this.options.onDynamicToolCall ? { experimentalApi: true } : null,
    }));
    requiredString(result?.userAgent, "userAgent");
    this.transport.notify("initialized", {});
    this.initialized = true;
  }

  async discoverModels(): Promise<CodexModelCapability[]> {
    this.requireInitialized();
    const models: CodexModelCapability[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = record(await this.transport.request("model/list", { cursor, includeHidden: false }));
      if (!Array.isArray(result?.data)) throw new Error("App Server model/list schema mismatch");
      for (const item of result.data) {
        const data = record(item);
        const model = string(data?.model);
        if (!model || seen.has(model)) continue;
        seen.add(model);
        const effortRows = Array.isArray(data?.supportedReasoningEfforts) ? data.supportedReasoningEfforts : [];
        models.push({ model,
          efforts: effortRows.map((x) => string(record(x)?.reasoningEffort)).filter((x): x is string => x !== null),
          inputModalities: Array.isArray(data?.inputModalities)
            ? data.inputModalities.filter((x): x is string => typeof x === "string") : [] });
      }
      cursor = result.nextCursor === null ? null : string(result.nextCursor);
      if (!cursor) { this.catalog = models; return models.map((m) => ({ ...m })); }
    }
    throw new Error("App Server model/list exceeded page limit");
  }
  /** Keep account email and other identity data out of the orchestration ledger. */
  async readAccountMode(): Promise<{ type: "chatgpt" | "apiKey" | "amazonBedrock" | null; requiresOpenaiAuth: boolean }> {
    this.requireInitialized();
    const result = record(await this.transport.request("account/read", { refreshToken: false }));
    const account = result?.account === null ? null : record(result?.account);
    if (typeof result?.requiresOpenaiAuth !== "boolean" ||
        (result?.account !== null && (!account || !["chatgpt", "apiKey", "amazonBedrock"].includes(account.type as string))))
      throw new Error("App Server account/read schema mismatch");
    return { type: account?.type as "chatgpt" | "apiKey" | "amazonBedrock" ?? null,
      requiresOpenaiAuth: result.requiresOpenaiAuth };
  }

  async startThread(options: { cwd: string; model: string; sandbox: "read-only" | "workspace-write";
    instructions?: string; dynamicTools?: CodexDynamicToolDefinition[];
    dynamicToolLimits?: Record<string, CodexDynamicToolLimits> }): Promise<CodexThreadIdentity> {
    this.requireInitialized();
    if (this.identity || this.threadRequestPending || this.needsReconciliation || !options.cwd || !options.model) {
      throw new Error("thread already started, uncertain, or options missing");
    }
    if (!this.catalog?.some((x) => x.model === options.model)) {
      throw new Error(`requested model not in discovered account catalog: ${options.model}`);
    }
    const tools = options.dynamicTools ?? [];
    if (tools.length > 20 || (tools.length && !this.options.onDynamicToolCall) ||
        tools.some(tool => tool.type !== "function" || !/^[a-zA-Z0-9_]{1,80}$/.test(tool.name) ||
          !tool.description.trim() || tool.description.length > 2000 || !record(tool.inputSchema)) ||
        new Set(tools.map(tool => tool.name)).size !== tools.length || JSON.stringify(tools).length > 32_000)
      throw new Error("Dynamic tool registry invalid");
    const limits = options.dynamicToolLimits ?? {};
    if (!record(limits) || Object.entries(limits).some(([name, limit]) => !tools.some(tool => tool.name === name) ||
        !record(limit) || Object.keys(limit).length !== 2 || !Object.hasOwn(limit, "argumentBytes") || !Object.hasOwn(limit, "resultBytes") ||
        !Number.isSafeInteger(limit.argumentBytes) || limit.argumentBytes < 1 || limit.argumentBytes > 64_000 ||
        !Number.isSafeInteger(limit.resultBytes) || limit.resultBytes < 1 || limit.resultBytes > 64_000))
      throw new Error("Dynamic tool limits invalid");
    this.dynamicToolNames = new Set(tools.map(tool => tool.name));
    const ownLimits = new Map(Object.entries(limits).map(([name, limit]) => [name,
      { argumentBytes: limit.argumentBytes, resultBytes: limit.resultBytes }]));
    this.dynamicToolLimits = new Map(tools.map(tool => [tool.name,
      ownLimits.get(tool.name) ?? { argumentBytes: 8000, resultBytes: 24_000 }]));
    this.threadRequestPending = true;
    try {
      const result = record(await this.transport.request("thread/start", {
        cwd: options.cwd, model: options.model, sandbox: options.sandbox,
        approvalPolicy: "on-request", approvalsReviewer: "user",
        ...(options.instructions ? { baseInstructions: options.instructions } : {}),
        ...(tools.length ? { dynamicTools: structuredClone(tools) } : {}),
      }));
      const threadId = requiredString(record(result?.thread)?.id, "thread.id");
      const resolvedModel = requiredString(result?.model, "model");
      this.identity = { threadId, requestedModel: options.model, resolvedModel,
        modelProvider: requiredString(result?.modelProvider, "modelProvider"),
        rerouted: resolvedModel !== options.model };
      return { ...this.identity };
    } catch (error) { this.needsReconciliation = true; throw error; }
    finally { this.threadRequestPending = false; }
  }

  async resumeThread(threadId: string, expectedModel: string): Promise<CodexThreadIdentity> {
    this.requireInitialized();
    if (this.activeTurnId || this.threadRequestPending || this.turnRequestPending || this.needsReconciliation ||
        (this.identity && this.identity.threadId !== threadId)) {
      throw new Error("active, uncertain, or mismatched thread needs reconciliation");
    }
    if (!threadId || !expectedModel || !this.catalog?.some((x) => x.model === expectedModel)) {
      throw new Error("resume ID/model missing from catalog");
    }
    this.threadRequestPending = true;
    try {
      const result = record(await this.transport.request("thread/resume", {
        threadId, model: expectedModel, approvalPolicy: "on-request", approvalsReviewer: "user",
        excludeTurns: true,
      }));
      const returnedId = requiredString(record(result?.thread)?.id, "thread.id");
      if (returnedId !== threadId) throw new Error("resumed thread ID mismatch");
      const resolvedModel = requiredString(result?.model, "model");
      this.identity = { threadId, requestedModel: expectedModel, resolvedModel,
        modelProvider: requiredString(result?.modelProvider, "modelProvider"),
        rerouted: resolvedModel !== expectedModel };
      // A resumed thread may still have an active turn or unobserved writes.
      this.needsReconciliation = true;
      return { ...this.identity };
    } catch (error) { this.needsReconciliation = true; throw error; }
    finally { this.threadRequestPending = false; }
  }

  async startTurn(text: string, effort: string): Promise<string> {
    this.requireInitialized();
    const identity = this.identity;
    if (!identity || this.dispatchBlocked || this.activeTurnId || this.threadRequestPending ||
        this.turnRequestPending || this.activeDynamicCalls.size > 0 || !text || !effort) {
      throw new Error("turn cannot start: missing identity, capability, or reconciliation");
    }
    const capability = this.catalog?.find((x) => x.model === identity.requestedModel);
    if (!capability?.efforts.includes(effort)) throw new Error(`effort not supported: ${effort}`);
    if (!capability.inputModalities.includes("text")) throw new Error("model does not support text input");
    this.turnRequestPending = true;
    this.dynamicCalls.clear();
    try {
      const result = record(await this.transport.request("turn/start", {
        threadId: identity.threadId, input: [{ type: "text", text, text_elements: [] }], effort,
      }));
      const turnId = requiredString(record(result?.turn)?.id, "turn.id");
      if (this.needsReconciliation || (this.activeTurnId && this.activeTurnId !== turnId)) {
        throw new Error("turn/start response conflicts with observed provider state");
      }
      const existing = this.observations.get(turnId);
      if (!existing) this.observations.set(turnId, { turnId, status: "inProgress", finalText: null,
        contextInputTokens: null, contextWindow: null, lastUsage: null });
      if (!existing || existing.status === "inProgress") this.activeTurnId = turnId;
      return turnId;
    } catch (error) { this.needsReconciliation = true; throw error; }
    finally { this.turnRequestPending = false; }
  }

  async interrupt(): Promise<void> {
    const threadId = this.identity?.threadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) throw new Error("no active turn to interrupt");
    try { await this.transport.request("turn/interrupt", { threadId, turnId }); }
    catch (error) { this.needsReconciliation = true; throw error; }
  }

  waitForTurn(turnId: string, timeoutMs: number): Promise<CodexTurnObservation> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error("turn wait timeout invalid"));
    }
    const observation = this.observations.get(turnId);
    if (this.identity?.rerouted) return Promise.reject(new Error("model rerouted during turn"));
    if (!observation || (turnId !== this.activeTurnId && observation.status === "inProgress")) {
      return Promise.reject(new Error("turn ID is not active or known"));
    }
    if (observation.status !== "inProgress") return Promise.resolve({ ...observation });
    if (this.closedReason) return Promise.reject(this.closedReason);
    if (this.turnWaiters.has(turnId)) return Promise.reject(new Error("turn already has a waiter"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        this.needsReconciliation = true;
        reject(new Error(`turn completion timeout: ${turnId}; outcome unknown`));
      }, timeoutMs);
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  /** Keep the Master's claim until every accepted host tool finishes. Never cancels a tool. */
  async waitForTurnOperations(turnId: string, timeoutMs: number): Promise<CodexTurnObservation> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("tool drain timeout invalid");
    const threadId = this.identity?.threadId;
    const terminal = this.getObservation(turnId);
    if (!threadId || !terminal || !["completed", "failed", "interrupted"].includes(terminal.status) ||
        this.activeTurnId || this.turnRequestPending || this.threadRequestPending || this.dispatchBlocked)
      throw new Error("turn tool settlement requires a known terminal identity");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...this.activeDynamicCalls]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.needsReconciliation = true;
            reject(new Error(`host tool settlement timeout: ${turnId}; side effects need reconciliation`));
          }, timeoutMs);
        }),
      ]);
      const current = this.getObservation(turnId);
      if (this.identity?.threadId !== threadId || this.dispatchBlocked || this.activeTurnId ||
          this.activeDynamicCalls.size > 0 || !current || current.status !== terminal.status ||
          current.finalText !== terminal.finalText)
        throw new Error("turn identity, result or host operations changed during settlement");
      return current;
    } catch (error) {
      this.needsReconciliation = true;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Read provider metadata only. This never clears reconciliation or accepts artifacts. */
  async inspectProviderTurn(threadId: string, turnId: string,
                            maxPages = 20, expected?: {cwd:string;modelProvider:string}): Promise<CodexProviderTurnInspection> {
    this.requireInitialized();
    if (!threadId || !turnId || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
        this.closedReason || this.threadRequestPending || this.turnRequestPending ||
        (this.identity && this.identity.threadId !== threadId)) {
      throw new Error("provider turn inspection unavailable or identity mismatch");
    }
    const read = record(await this.transport.request("thread/read", {
      threadId, includeTurns: false,
    }));
    if (requiredString(record(read?.thread)?.id, "thread.id") !== threadId) {
      throw new Error("provider thread/read identity mismatch");
    }
    const thread=record(read?.thread);
    const normalized=(value:string)=>{const path=(process.platform==="win32"?value.replace(/\\/g,"/"):value).replace(/\/$/,"");return process.platform==="win32"?path.toLowerCase():path};
    if(expected && (thread?.modelProvider!==expected.modelProvider ||
      typeof thread.cwd!=="string" || normalized(thread.cwd)!==normalized(expected.cwd)))
      throw new Error("provider thread checkout or provider differs from registered Task");
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const result = record(await this.transport.request("thread/turns/list", {
        threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "notLoaded",
      }));
      if (!Array.isArray(result?.data) ||
          !(result.nextCursor === null || string(result.nextCursor))) {
        throw new Error("App Server thread/turns/list schema mismatch");
      }
      for (const item of result.data) {
        const turn = record(item);
        const id = requiredString(turn?.id, "turn.id");
        const status = turn?.status;
        if (status !== "inProgress" && status !== "completed" &&
            status !== "failed" && status !== "interrupted") {
          throw new Error("App Server turn status unknown; reconciliation remains required");
        }
        if (id === turnId) {
          return { threadId, turnId, found: true, status, pagesRead: page,
            completeSearch: true, observedAtMs: this.now(), source: "thread/turns/list" };
        }
      }
      if (result.nextCursor === null) {
        return { threadId, turnId, found: false, status: null, pagesRead: page,
          completeSearch: true, observedAtMs: this.now(), source: "thread/turns/list" };
      }
      cursor = result.nextCursor as string;
      if (seenCursors.has(cursor)) throw new Error("App Server turn cursor repeated");
      seenCursors.add(cursor);
    }
    return { threadId, turnId, found: false, status: null, pagesRead: maxPages,
      completeSearch: false, observedAtMs: this.now(), source: "thread/turns/list" };
  }

  /** Reconciliation is external and must compare provider state and local artifacts first. */
  async inspectProviderTurnProcessSafety(threadId:string,turnId:string,expected:{cwd:string;modelProvider:string}):Promise<CodexProviderTurnInspection & {
    processSafety:{source:"thread/items/list";complete:boolean;pagesRead:number;itemCount:number;itemTypes:string[];sha256:string;noExecutableItems:boolean}
  }>{
    const before=await this.inspectProviderTurn(threadId,turnId,20,expected);
    const types=new Set<string>(),ids=new Set<string>(),cursors=new Set<string>(),metadata:unknown[]=[];
    let cursor:string|null=null,complete=false,pagesRead=0,noExecutableItems=true;
    const passive=new Set(["agentMessage","userMessage","reasoning","plan","contextCompaction"]);
    if(before.found&&before.completeSearch){
      for(let page=1;page<=20;page++){
        const result=record(await this.transport.request("thread/items/list",{threadId,turnId,cursor,limit:100,sortDirection:"asc"}));
        if(!Array.isArray(result?.data)||result.data.length>100||!(result.nextCursor===null||string(result.nextCursor)))throw Error("Provider item inspection schema mismatch");
        pagesRead=page;
        for(const raw of result.data){const entry=record(raw),item=record(entry?.item);
          if(entry?.turnId!==turnId)throw Error("Provider item belongs to another turn");
          const id=requiredString(item?.id,"item.id"),type=requiredString(item?.type,"item.type");
          if(ids.has(id))throw Error("Provider item inspection duplicated an item");
          ids.add(id);types.add(type);metadata.push([id,type]);if(!passive.has(type))noExecutableItems=false;
        }
        if(result.nextCursor===null){complete=true;break}
        cursor=result.nextCursor as string;if(cursors.has(cursor))throw Error("Provider item cursor repeated");cursors.add(cursor);
      }
    }
    const after=await this.inspectProviderTurn(threadId,turnId,20,expected);
    if(after.found!==before.found||after.status!==before.status||!after.completeSearch)complete=false;
    // This is an absence check, not a claim that a tool's descendants exited.
    return {...after,processSafety:{source:"thread/items/list",complete,pagesRead,itemCount:ids.size,itemTypes:[...types].sort(),
      sha256:createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),noExecutableItems:complete&&noExecutableItems}};
  }

  /** Reconciliation is external and must compare provider state and local artifacts first. */
  markReconciled(threadId: string, turnId: string | null, evidenceRef: string): void {
    if (!this.needsReconciliation || this.threadRequestPending || this.turnRequestPending ||
        this.identity?.threadId !== threadId ||
        (turnId !== null && this.activeTurnId !== turnId) || !evidenceRef) {
      throw new Error("reconciliation identity mismatch");
    }
    this.needsReconciliation = false;
    this.activeTurnId = null;
  }

  answerApproval(expected: CodexApprovalRequest, allow: boolean): void {
    const key = `${typeof expected.id}:${expected.id}`;
    const stored = this.approvals.get(key);
    if (stored && this.now() > stored.expiresAtMs) {
      this.transport.respond(stored.id, { decision: "decline" });
      this.approvals.delete(key);
      const timer = this.approvalTimers.get(key);
      if (timer) clearTimeout(timer);
      this.approvalTimers.delete(key);
      throw new Error("approval expired");
    }
    if (!stored ||
        this.activeTurnId !== stored.turnId || this.identity?.threadId !== stored.threadId ||
        stored.method !== expected.method || stored.threadId !== expected.threadId ||
        stored.turnId !== expected.turnId || stored.itemId !== expected.itemId ||
        stored.target !== expected.target || stored.expiresAtMs !== expected.expiresAtMs ||
        stored.targetKnown !== expected.targetKnown || stored.cwd !== expected.cwd) {
      throw new Error("approval is stale or mismatched");
    }
    if (allow && !stored.targetKnown) throw new Error("approval operation target is unavailable");
    this.transport.respond(stored.id, { decision: allow ? "accept" : "decline" });
    this.approvals.delete(key);
    const timer = this.approvalTimers.get(key);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(key);
  }

  close(reason?: Error): void { this.transport.close(reason); }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("App Server initialize required");
  }

  private onNotification(method: string, params: unknown): void {
    const p = record(params);
    const threadId = string(p?.threadId);
    const turnId = string(p?.turnId) ?? string(record(p?.turn)?.id);
    // Turn-scoped events must name the exact thread. A malformed or foreign
    // notification may still be reported, but it cannot complete this run.
    if (method === "model/rerouted" || method === "turn/started" ||
        method === "turn/completed" || method === "item/completed" ||
        method === "thread/tokenUsage/updated") {
      if (!this.identity || threadId !== this.identity.threadId) {
        this.options.onNotice?.(method, params);
        return;
      }
    }
    if ((method === "item/completed" || method === "thread/tokenUsage/updated") && turnId &&
        ((this.activeTurnId && this.activeTurnId !== turnId) ||
         (!this.activeTurnId && !this.turnRequestPending && !this.observations.has(turnId)))) {
      this.needsReconciliation = true;
    }
    if (method === "model/rerouted" && turnId && this.identity) {
      const toModel = string(p?.toModel);
      if (toModel) this.identity.resolvedModel = toModel;
      this.identity.rerouted = true;
      this.needsReconciliation = true;
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("model rerouted during turn"));
      }
    } else if (method === "turn/started" && turnId) {
      if (!this.turnRequestPending && this.activeTurnId !== turnId) this.needsReconciliation = true;
      if (this.activeTurnId && this.activeTurnId !== turnId) this.needsReconciliation = true;
      if (!this.activeTurnId) this.activeTurnId = turnId;
      if (!this.observations.has(turnId)) this.observations.set(turnId, { turnId,
        status: "inProgress", finalText: null, contextInputTokens: null,
        contextWindow: null, lastUsage: null });
    } else if (method === "turn/completed" && turnId) {
      if ((this.activeTurnId && this.activeTurnId !== turnId) ||
          (!this.activeTurnId && !this.turnRequestPending && !this.observations.has(turnId))) {
        this.needsReconciliation = true;
      }
      const status = string(record(p?.turn)?.status);
      const observation = this.observations.get(turnId) ?? { turnId, status: "unknown" as const,
        finalText: null, contextInputTokens: null, contextWindow: null, lastUsage: null };
      observation.status = status === "completed" || status === "failed" || status === "interrupted"
        ? status : "unknown";
      if (observation.status === "unknown") this.needsReconciliation = true;
      this.observations.set(turnId, observation);
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      for (const [key, approval] of this.approvals) {
        if (approval.turnId !== turnId) continue;
        this.approvals.delete(key);
        const timer = this.approvalTimers.get(key);
        if (timer) clearTimeout(timer);
        this.approvalTimers.delete(key);
        try { this.transport.respond(approval.id, { decision: "decline" }); }
        catch { /* Stream closure will invalidate the pending request. */ }
      }
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        clearTimeout(waiter.timer);
        if (this.identity?.rerouted) waiter.reject(new Error("model rerouted during turn"));
        else waiter.resolve({ ...observation });
      }
    } else if (method === "item/completed" && turnId) {
      const item = record(p?.item);
      if (item?.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
        // A final item can arrive in the same chunk as the turn/start response,
        // before startTurn has created its observation.
        const observation = this.observations.get(turnId) ?? { turnId,
          status: "inProgress" as const, finalText: null, contextInputTokens: null,
          contextWindow: null, lastUsage: null };
        observation.finalText = item.text;
        this.observations.set(turnId, observation);
      }
    } else if (method === "thread/tokenUsage/updated" && turnId) {
      const usage = record(p?.tokenUsage);
      const last = record(usage?.last);
      const observation = this.observations.get(turnId);
      if (observation && last) {
        const window = usage?.modelContextWindow;
        observation.contextInputTokens = Number.isSafeInteger(last.inputTokens) &&
          (last.inputTokens as number) >= 0 ? last.inputTokens as number : null;
        observation.contextWindow = typeof window === "number" &&
          Number.isSafeInteger(window) && window > 0 ? window : null;
        observation.lastUsage = { ...last };
      }
    }
    this.options.onNotice?.(method, params);
  }

  private onServerRequest(id: string | number, method: string, params: unknown): void {
    if (method === "item/tool/call") { this.onDynamicToolRequest(id, params); return; }
    if (method !== "item/commandExecution/requestApproval" &&
        method !== "item/fileChange/requestApproval") {
      this.transport.rejectServerRequest(id, -32601, "Unsupported server request");
      return;
    }
    const p = record(params);
    const threadId = string(p?.threadId);
    const turnId = string(p?.turnId);
    const itemId = string(p?.itemId);
    if (!threadId || !turnId || !itemId || threadId !== this.identity?.threadId ||
        turnId !== this.activeTurnId) {
      this.transport.rejectServerRequest(id, -32602, "Approval identity mismatch");
      return;
    }
    const concreteTarget = method === "item/commandExecution/requestApproval"
      ? string(p?.command) : string(p?.grantRoot);
    const target = concreteTarget ?? itemId;
    const approval: CodexApprovalRequest = { id, method, threadId, turnId, itemId,
      target, targetKnown: concreteTarget !== null, cwd: string(p?.cwd),
      expiresAtMs: this.now() + this.approvalTtlMs };
    const key = `${typeof id}:${id}`;
    if (!this.options.onApproval) {
      this.transport.respond(id, { decision: "decline" });
      return;
    }
    if (this.approvals.has(key)) {
      this.transport.rejectServerRequest(id, -32602, "Duplicate approval ID");
      return;
    }
    this.approvals.set(key, approval);
    const timer = setTimeout(() => {
      if (!this.approvals.has(key)) return;
      this.approvals.delete(key);
      this.approvalTimers.delete(key);
      try { this.transport.respond(id, { decision: "decline" }); }
      catch { /* The transport may have closed while the timer fired. */ }
    }, this.approvalTtlMs);
    this.approvalTimers.set(key, timer);
    try { this.options.onApproval?.({ ...approval }); }
    catch {
      this.approvals.delete(key);
      clearTimeout(timer);
      this.approvalTimers.delete(key);
      this.transport.rejectServerRequest(id, -32603, "Approval handler failed");
    }
  }
  private onDynamicToolRequest(id: string | number, params: unknown): void {
    const value = record(params), threadId = string(value?.threadId), turnId = string(value?.turnId);
    const callId = string(value?.callId), tool = string(value?.tool);
    const limits = tool ? this.dynamicToolLimits.get(tool) : undefined;
    if (!this.options.onDynamicToolCall || !threadId || !turnId || !callId || callId.length > 200 ||
        !tool || !this.dynamicToolNames.has(tool) || (value?.namespace !== null && value?.namespace !== undefined) ||
        threadId !== this.identity?.threadId || turnId !== this.activeTurnId || this.dispatchBlocked ||
        !limits || value?.arguments === undefined || Buffer.byteLength(JSON.stringify(value.arguments)) > limits.argumentBytes) {
      this.transport.rejectServerRequest(id, -32602, "Dynamic tool identity, registry or arguments mismatch");
      return;
    }
    const key = `${turnId}:${callId}`, fingerprint = JSON.stringify({ tool, arguments: value.arguments });
    const previous = this.dynamicCalls.get(key);
    if ((previous && previous.fingerprint !== fingerprint) || (!previous && this.dynamicCalls.size >= 128)) {
      this.transport.rejectServerRequest(id, -32602, "Dynamic call ID reused or turn call limit reached");
      return;
    }
    const result = previous?.result ?? Promise.resolve().then(() => {
      if (this.dispatchBlocked || this.activeTurnId !== turnId || this.identity?.threadId !== threadId)
        throw new Error("Dynamic tool call is no longer active");
      return this.options.onDynamicToolCall!({ threadId, turnId, callId, tool, arguments: structuredClone(value.arguments) });
    }).then(result => {
        if (!result || typeof result.success !== "boolean" || typeof result.text !== "string" ||
            Buffer.byteLength(result.text) > limits.resultBytes) throw new Error("Dynamic result invalid or exceeds limit");
        return result;
      }).catch(() => ({ success: false,
        text: "Task操作の結果を確認できません。再委任せず、Task画面で現在の状態を確認してください。" }));
    if (!previous) {
      this.dynamicCalls.set(key, { fingerprint, result });
      this.activeDynamicCalls.add(result);
      void result.then(() => this.activeDynamicCalls.delete(result));
    }
    void result.then(result => {
      try { this.transport.respond(id, { contentItems: [{ type: "inputText", text: result.text }], success: result.success }); }
      catch { /* A disconnected provider must inspect durable Task state before another dispatch. */ }
    });
  }
}
