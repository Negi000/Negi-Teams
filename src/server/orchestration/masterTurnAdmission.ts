// A resident Master's active turn shares the durable Task scheduler.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CodexTurnObservation } from "../master/appServerClient.ts";
import { FileScheduler, type SchedulerAction } from "./scheduler.ts";

export class MasterInputNotSentError extends Error {
  constructor(message: string) { super(message); this.name = "MasterInputNotSentError"; }
}
export interface MasterTurnRequest {
  cwd: string; model: string; effort: string; threadId: string; text: string;
}
export interface MasterTurnLease {
  readonly workId: string;
  dispatching(): Promise<void>;
  bind(turnId: string): Promise<void>;
  complete(observation: CodexTurnObservation): Promise<void>;
  unknown(reason: string): Promise<void>;
  cancelBeforeDispatch(): Promise<void>;
}
export interface MasterTurnAdmission {
  reserve(request: MasterTurnRequest): Promise<MasterTurnLease>;
  /** Before App Server process launch; callers already own configuration admission. */
  assertIdle?(cwd: string): Promise<void>;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function inside(root: string, path: string): boolean {
  const rel = relative(root.toLowerCase(), path.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function writeNew(path: string, value: unknown): Promise<string> {
  const bytes = JSON.stringify(value) + "\n";
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes, "utf8"); await file.sync(); }
  finally { await file.close(); }
  return `${path}#sha256=${sha256(bytes)}`;
}

/** The server supplies the root, identity and scheduler; provider input cannot select them. */
export function scheduledMasterTurns(options: { root: string; masterId: string;
  scheduler: FileScheduler; onReleased?: () => Promise<void> }): MasterTurnAdmission {
  if (!isAbsolute(options.root) || !/^[a-zA-Z0-9_-]{1,100}$/.test(options.masterId))
    throw new Error("Master scheduler registration invalid");
  return { async reserve(raw) {
    const request = structuredClone(raw);
    if (!request.model || !request.effort || !request.threadId || !request.text.trim() ||
        request.text.length > 200_000) throw new MasterInputNotSentError("入力が空か、送信上限を超えています。未送信です。");
    const cwd = await realpath(resolve(request.cwd));
    // Resolve the existing parent before creating a directory through a checkout alias.
    const rootPath = join(await realpath(dirname(options.root)), basename(options.root));
    const schedulerPath = join(await realpath(dirname(options.scheduler.path)), basename(options.scheduler.path));
    if (inside(cwd, rootPath) || inside(cwd, schedulerPath))
      throw new MasterInputNotSentError("統括の実行記録は作業場所の外に設定してください。未送信です。");
    try {
      const entry = await lstat(rootPath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Master evidence root has an unsafe type");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(rootPath, { recursive: true });
    const root = await realpath(rootPath);
    if (inside(cwd, root)) throw new MasterInputNotSentError("統括の実行記録は作業場所の外に設定してください。未送信です。");
    await options.scheduler.ensureSubscriptionConfiguration();
    const workId = `master-${randomUUID()}`;
    const out = join(root, workId);
    await mkdir(out);
    const requestRef = await writeNew(join(out, "request.json"), { schemaVersion: "negi-master-turn/1", workId,
      masterId: options.masterId, ...request, cwd, inputSha256: sha256(request.text), at: new Date().toISOString() });
    const record = (suffix: string, action: SchedulerAction) => options.scheduler.append({
      key: `${workId}:${suffix}`, at: new Date().toISOString(), action });
    await record("submit", { type: "submit", work: { id: workId, parentId: null, dependencies: [],
      role: "astra", checkout: cwd, checkoutMode: "read", resources: [], reserveUsd: 0,
      masterOwner: { masterId: options.masterId, requestSha256: requestRef.slice(-64) } } });
    const claimed = await options.scheduler.tryClaim(workId, `${workId}:dispatch`);
    if (!claimed) {
      await record("capacity-miss", { type: "cancel_queued", workId,
        reason: "Master input was not sent: shared capacity or checkout was unavailable" });
      throw new MasterInputNotSentError("実行枠または作業場所が使用中です。未送信なので、空きができたら再送してください。");
    }
    let dispatched = false;
    let turnId: string | null = null;
    let settled = false;
    let heldUnknown = false;
    let serial = Promise.resolve();
    const ordered = (fn: () => Promise<void>) => {
      const operation = serial.then(fn);
      serial = operation.catch(() => {});
      return operation;
    };
    const release = async () => {
      try { await options.onReleased?.(); } catch { /* durable outcome remains valid */ }
    };
    return { workId,
      dispatching: () => ordered(async () => {
        if (settled || dispatched) throw new Error("Master dispatch already recorded or settled");
        await writeNew(join(out, "dispatch.json"), { workId, threadId: request.threadId,
          at: new Date().toISOString() });
        dispatched = true;
      }),
      bind: (id) => ordered(async () => {
        if (!dispatched || settled || turnId || !id) throw new Error("Master provider binding invalid");
        await writeNew(join(out, "provider.json"), { workId, threadId: request.threadId, turnId: id });
        turnId = id;
      }),
      complete: (rawObservation) => {
        const observation = structuredClone(rawObservation);
        return ordered(async () => {
          if (heldUnknown) throw new Error("Unknown Master outcome requires separate provider reconciliation");
          if (settled) return;
          if (!dispatched || !turnId || observation.turnId !== turnId ||
              !["completed", "failed", "interrupted"].includes(observation.status) ||
              (observation.status === "completed" && observation.finalText === null))
            throw new Error("Master provider terminal evidence incomplete");
          const evidenceRef = await writeNew(join(out, "outcome.json"), { workId,
            threadId: request.threadId, ...observation, humanAcceptance: null,
            verification: "provider terminal response only; not Task quality or human acceptance" });
          await record("settle", { type: "settle", workId,
            outcome: observation.status === "completed" ? "verified" : "failed", evidenceRef, actualCostUsd: null });
          settled = true;
          await release();
        });
      },
      unknown: (reason) => ordered(async () => {
        if (settled) return;
        await record("unknown", { type: "unknown", workId,
          reason: reason || "Master provider outcome unknown; inspect before release" });
        heldUnknown = true;
        settled = true; // The scheduler keeps its slot and checkout claim.
      }),
      cancelBeforeDispatch: () => ordered(async () => {
        if (settled) return;
        if (dispatched) throw new Error("A dispatched Master cannot be cancelled as unsent");
        const evidenceRef = await writeNew(join(out, "not-sent.json"), { workId,
          reason: "Master stopped before turn/start", at: new Date().toISOString() });
        await record("not-sent", { type: "settle", workId, outcome: "failed", evidenceRef, actualCostUsd: null });
        settled = true;
        await release();
      }),
    };
  } };
}
