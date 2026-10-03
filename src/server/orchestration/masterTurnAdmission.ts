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
  /** Lightweight compatibility check; this is not a cross-process storage lock. */
  assertStorageCompatible?(): Promise<void>;
  withStorage?<T>(run: () => Promise<T>): Promise<T>;
}
/** Registered storage uses the same reentrant scope as the shared scheduler.
 * An intent must be durable before any turn directory/artifact is published.
 * Audit and reconciliation belong to the registered storage implementation. */
export interface MasterTurnJournal {
  withStorage<T>(run: () => Promise<T>): Promise<T>;
  audit(): Promise<void>;
  appendIntent(input: { workId: string; relativePath: string; bytes: string }): Promise<void>;
}

/** Keep an admitted lease subject to the same compatibility check until its
 * terminal record. Snapshot caller objects before awaiting the check. This
 * detects known incompatible storage. The supplied storage wrapper also excludes
 * participating writers; older binaries and independent writes remain outside it. */
export function guardMasterAdmission(admission: MasterTurnAdmission, checkStorage: () => Promise<void>, withStorage?: <T>(run: () => Promise<T>) => Promise<T>): MasterTurnAdmission {
  const operation = async <T>(run: () => Promise<T>): Promise<T> => {
    await checkStorage();
    try { return await run(); } finally { await checkStorage(); }
  };
  const checked = <T>(run: () => Promise<T>): Promise<T> => withStorage ? withStorage(() => operation(run)) : operation(run);
  return {
    withStorage,
    assertIdle: admission.assertIdle ? cwd => admission.assertIdle!(cwd) : undefined,
    assertStorageCompatible: checkStorage,
    reserve: raw => {
      const request = structuredClone(raw);
      return checked(async () => {
        const lease = await admission.reserve(request);
        // A failed check leaves durable admission evidence for reconciliation.
        // Never cancel/release an outcome automatically because the DB changed.
        return { workId: lease.workId,
          dispatching: () => checked(() => lease.dispatching()),
          bind: id => checked(() => lease.bind(id)),
          complete: rawObservation => { const observation = structuredClone(rawObservation); return checked(() => lease.complete(observation)); },
          unknown: reason => checked(() => lease.unknown(reason)),
          cancelBeforeDispatch: () => checked(() => lease.cancelBeforeDispatch()),
        };
      });
    },
  };
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function inside(root: string, path: string): boolean {
  const rel = relative(root.toLowerCase(), path.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function writeNew(path: string, bytes: string): Promise<string> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes, "utf8"); await file.sync(); }
  finally { await file.close(); }
  return `${path}#sha256=${sha256(bytes)}`;
}

/** The server supplies the root, identity and scheduler; provider input cannot select them. */
export function scheduledMasterTurns(options: { root: string; masterId: string;
  scheduler: FileScheduler; onReleased?: () => Promise<void>; workId?: string; requestedAt?: string;
  journal?: MasterTurnJournal }): MasterTurnAdmission {
  if (!isAbsolute(options.root) || !/^[a-zA-Z0-9_-]{1,100}$/.test(options.masterId))
    throw new Error("Master scheduler registration invalid");
  if ((options.workId !== undefined && !/^master-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.workId)) ||
      (options.requestedAt !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(options.requestedAt) || !Number.isFinite(Date.parse(options.requestedAt)))))
    throw new Error("Master admission identity invalid");
  // Copy server registration once; later mutation cannot retarget a reserved turn.
  const registered = Object.freeze({ ...options, root: resolve(options.root), schedulerPath: resolve(options.scheduler.path) });
  const source = options.journal;
  if (source && ![source.withStorage, source.audit, source.appendIntent].every(fn => typeof fn === "function"))
    throw new Error("Master journal registration invalid");
  const journal = source ? Object.freeze({ withStorage: source.withStorage.bind(source),
    audit: source.audit.bind(source), appendIntent: source.appendIntent.bind(source) }) : undefined;
  const checkRegistration = () => {
    if (resolve(registered.scheduler.path) !== registered.schedulerPath) throw new Error("Master registered scheduler path changed");
  };
  const operation = async <T>(run: () => Promise<T>): Promise<T> => {
    checkRegistration();
    await registered.scheduler.assertStorageCompatible();
    await journal?.audit();
    checkRegistration();
    try { return await run(); } finally {
      checkRegistration();
      await journal?.audit();
      checkRegistration();
    }
  };
  const protectedOperation = <T>(run: () => Promise<T>): Promise<T> => journal
    ? journal.withStorage(() => operation(run)) : operation(run);
  const reserve = async (raw: MasterTurnRequest): Promise<MasterTurnLease> => {
    const request = structuredClone(raw);
    if (!request.model || !request.effort || !request.threadId || !request.text.trim() ||
        request.text.length > 200_000) throw new MasterInputNotSentError("入力が空か、送信上限を超えています。未送信です。");
    const cwd = await realpath(resolve(request.cwd));
    // Resolve the existing parent before creating a directory through a checkout alias.
    const rootPath = join(await realpath(dirname(registered.root)), basename(registered.root));
    const schedulerPath = join(await realpath(dirname(registered.schedulerPath)), basename(registered.schedulerPath));
    if (inside(cwd, rootPath) || inside(cwd, schedulerPath))
      throw new MasterInputNotSentError("統括の実行記録は作業場所の外に設定してください。未送信です。");
    try {
      const entry = await lstat(rootPath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Master evidence root has an unsafe type");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (journal) throw new Error("Master registered evidence root missing; preserve its journal");
    }
    if (journal && rootPath !== registered.root) throw new Error("Master registered evidence root alias");
    if (!journal) await registered.scheduler.withUnindexedArtifacts(() => mkdir(rootPath, { recursive: true }));
    const root = await realpath(rootPath);
    if (inside(cwd, root)) throw new MasterInputNotSentError("統括の実行記録は作業場所の外に設定してください。未送信です。");
    checkRegistration();
    await registered.scheduler.ensureSubscriptionConfiguration();
    checkRegistration();
    const workId = registered.workId ?? `master-${randomUUID()}`;
    const out = join(root, workId);
    const publish = async (relativePath: string, value: unknown, initial = false) => {
      const bytes = JSON.stringify(value) + "\n";
      const limit = relativePath === "request.json" ? 1_000_000 : relativePath === "outcome.json" ? 2_000_000 : 8000;
      if (Buffer.byteLength(bytes) > limit) throw new Error("Master turn artifact exceeds its read bound");
      const write = async () => {
        checkRegistration();
        if (journal) await journal.appendIntent(structuredClone({ workId, relativePath, bytes }));
        checkRegistration();
        if (initial) await mkdir(out);
        checkRegistration();
        const reference = await writeNew(join(out, relativePath), bytes);
        checkRegistration();
        return reference;
      };
      return journal ? write() : registered.scheduler.withUnindexedArtifacts(write);
    };
    const requestRef = await publish("request.json", { schemaVersion: "negi-master-turn/1", workId,
      masterId: registered.masterId, ...request, cwd, inputSha256: sha256(request.text), at: registered.requestedAt ?? new Date().toISOString() }, true);
    const record = async (suffix: string, action: SchedulerAction) => {
      checkRegistration();
      const result = await registered.scheduler.append({ key: `${workId}:${suffix}`, at: new Date().toISOString(), action });
      checkRegistration();
      return result;
    };
    await record("submit", { type: "submit", work: { id: workId, parentId: null, dependencies: [],
      role: "astra", checkout: cwd, checkoutMode: "read", resources: [], reserveUsd: 0,
      masterOwner: { masterId: registered.masterId, requestSha256: requestRef.slice(-64) } } });
    checkRegistration();
    const claimed = await registered.scheduler.tryClaim(workId, `${workId}:dispatch`);
    checkRegistration();
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
      const operation = serial.then(() => protectedOperation(fn));
      serial = operation.catch(() => {});
      return operation;
    };
    const release = async () => {
      try { await registered.onReleased?.(); } catch { /* durable outcome remains valid */ }
    };
    return { workId,
      dispatching: () => ordered(async () => {
        if (settled || dispatched) throw new Error("Master dispatch already recorded or settled");
        await publish("dispatch.json", { workId, threadId: request.threadId,
          at: new Date().toISOString() });
        dispatched = true;
      }),
      bind: (id) => ordered(async () => {
        if (!dispatched || settled || turnId || !id) throw new Error("Master provider binding invalid");
        await publish("provider.json", { workId, threadId: request.threadId, turnId: id });
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
          const evidenceRef = await publish("outcome.json", { workId,
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
        // A failed fsync/ACK can leave dispatch evidence before the in-memory
        // flag changes. Never reinterpret an existing or partial artifact as
        // proof that no provider operation was sent.
        for (const name of ["dispatch.json", "provider.json", "outcome.json"]) {
          try { await lstat(join(out, name)); throw new Error("Master dispatch evidence requires reconciliation"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const evidenceRef = await publish("not-sent.json", { workId,
          reason: "Master stopped before turn/start", at: new Date().toISOString() });
        await record("not-sent", { type: "settle", workId, outcome: "failed", evidenceRef, actualCostUsd: null });
        settled = true;
        await release();
      }),
    };
  };
  return { reserve: raw => {
    const request = structuredClone(raw);
    return protectedOperation(() => reserve(request));
  } };
}
