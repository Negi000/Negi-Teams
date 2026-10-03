// Codex App Server stdio transport. The caller owns the process and all decisions
// about model selection, approvals, and retries. A timeout never resends a request.
import type { Readable, Writable } from "node:stream";

export interface AppServerMessage {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AppServerTransportOptions {
  timeoutMs?: number;
  maxLineBytes?: number;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (id: string | number, method: string, params: unknown) => void;
  onUnknownMessage?: (message: unknown) => void;
  onClose?: (reason: Error) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export class AppServerTransport {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed: Error | null = null;
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    private readonly options: AppServerTransportOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 ||
        !Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 128) {
      throw new Error("App Server transport limits are invalid");
    }
    readable.on("data", this.onData);
    readable.on("end", this.onEnd);
    readable.on("error", this.onError);
    writable.on("error", this.onError);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    if (!method || typeof method !== "string") return Promise.reject(new Error("method is required"));
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      return Promise.reject(new Error("App Server request exceeds transport limit"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server request timed out: ${method} id=${id}; outcome unknown`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writable.write(line);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  respond(id: string | number, result: unknown): void {
    this.writeResponse({ jsonrpc: "2.0", id, result });
  }

  rejectServerRequest(id: string | number, code: number, message: string): void {
    this.writeResponse({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method: string, params: unknown): void {
    if (!method) throw new Error("method is required");
    this.writeResponse({ jsonrpc: "2.0", method, params });
  }

  /** Does not end the streams; the process owner decides when to stop it. */
  close(reason = new Error("App Server transport closed")): void {
    if (this.closed) return;
    this.closed = reason;
    this.readable.off("data", this.onData);
    this.readable.off("end", this.onEnd);
    // Keep the error listeners until the stream owner disposes of the streams.
    // A late EPIPE/error after disconnect must not become an uncaught exception.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.options.onClose?.(reason);
  }

  get pendingCount(): number { return this.pending.size; }

  private writeResponse(message: AppServerMessage): void {
    if (this.closed) throw this.closed;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error("App Server response exceeds transport limit");
    this.writable.write(line);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const fragment = bytes.subarray(start, end);
      if (this.buffer.length + fragment.length > this.maxLineBytes) {
        this.close(new Error("App Server line exceeds transport limit"));
        return;
      }
      if (newline === -1) {
        // Copy an incomplete fragment so a short tail does not retain an entire
        // large chunk containing many earlier messages.
        this.buffer = this.buffer.length
          ? Buffer.concat([this.buffer, fragment]) : Buffer.from(fragment);
        return;
      }
      const lineBytes = this.buffer.length
        ? Buffer.concat([this.buffer, fragment]) : fragment;
      this.buffer = Buffer.alloc(0);
      let line: string;
      try { line = this.decoder.decode(lineBytes).trim(); }
      catch { this.close(new Error("App Server sent invalid UTF-8")); return; }
      if (line) this.handleLine(line);
      if (this.closed) return;
      start = newline + 1;
    }
  };

  private handleLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { this.reportUnknown({ malformed: true }); return; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.reportUnknown(value);
      return;
    }
    const message = value as AppServerMessage;
    if (typeof message.method === "string") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        try {
          if (this.options.onServerRequest) this.options.onServerRequest(message.id, message.method, message.params);
          else this.rejectServerRequest(message.id, -32601, "No server request handler");
        } catch {
          try { this.rejectServerRequest(message.id, -32603, "Server request handler failed"); }
          catch (error) { this.close(error as Error); }
        }
      } else {
        try { this.options.onNotification?.(message.method, message.params); }
        catch { this.reportUnknown({ notificationHandlerFailed: message.method }); }
      }
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`App Server error ${message.error.code}: ${message.error.message}`));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new Error(`App Server response id=${message.id} has no result or error`));
      return;
    }
    this.reportUnknown(value);
  }

  private reportUnknown(value: unknown): void {
    try { this.options.onUnknownMessage?.(value); }
    catch { /* A diagnostic hook must not break protocol dispatch. */ }
  }

  private readonly onEnd = (): void => this.close(new Error("App Server stream ended; in-flight outcome unknown"));
  private readonly onError = (error: Error): void => this.close(error);
}
