// Durable result notifications and their provider delivery receipts. No model is launched here.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { CodexTurnObservation } from "../master/appServerClient.ts";
import { taskResultRecipient, type TaskResultNotice, type TaskResultSummary, type TaskResultDeliveryState } from "../../shared/taskResults.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
interface Delivery {
  id: string; masterId: string; threadId: string; noticeIds: string[]; textSha256: string;
  state: Exclude<TaskResultDeliveryState, "pending">; turnId: string | null;
  terminalSha256: string | null;
}
type Action = { type: "notice"; notice: TaskResultNotice } | { type: "prepare"; delivery: Delivery } |
  { type: "delivery"; id: string; state: Delivery["state"]; turnId?: string; terminalSha256?: string };
interface Event { key: string; at: string; action: Action }
interface State { notices: TaskResultNotice[]; deliveries: Delivery[] }
const latestForRun = (state: State, runId: string) => [...state.notices].reverse().find(n => n.runId === runId);
function sameOrigin(a: TaskResultNotice, b: TaskResultNotice) {
  // A legacy browser notice may gain verified creation provenance in a new
  // immutable update. Once bound, it cannot move to another conversation.
  return JSON.stringify(a.origin) === JSON.stringify(b.origin) &&
    (!a.createdBy || JSON.stringify(a.createdBy) === JSON.stringify(b.createdBy));
}
function updateKind(previous: TaskResultNotice, next: TaskResultNotice,
                    facts: {resultRevision:number;artifactSha256:string|null}): NonNullable<TaskResultNotice["update"]>["kind"] {
  if (next.status === "review_revoked") return "revoked";
  if (next.status === "accepted" && next.acceptedBy !== previous.acceptedBy) return "accepted";
  if (facts.resultRevision > (previous.update?.resultRevision ?? 0)) return "revision";
  return "state";
}
export interface TaskResultContext {
  text: string;
  dispatching(): Promise<void>;
  bind(turnId: string): Promise<void>;
  notSent(): Promise<void>;
  unknown(): Promise<void>;
  terminal(observation: CodexTurnObservation): Promise<void>;
}
export class TaskResultSourceChangedError extends Error {}
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Task results rejected: " + reason); }
function reduce(state: State, event: Event): State {
  check(label(event.key) && Number.isFinite(Date.parse(event.at)), "event identity");
  const next = structuredClone(state), a = event.action;
  if (a.type === "notice") {
    const n = a.notice;
    check(sha(n.id) && sha(n.sourceSha256) && sha(n.configSha256) && label(n.runId) && label(n.title) &&
      label(n.project) && label(n.taskId) && Number.isSafeInteger(n.version) && n.version > 0 &&
      Number.isFinite(Date.parse(n.createdAt)) && label(n.status) &&
      [n.verificationOutcome, n.acceptedBy, n.reviewId].every(value => value === null || label(value)) &&
      (n.reason === null || (typeof n.reason === "string" && n.reason.length <= 1000)) &&
      ["browser", "master"].includes(n.origin?.kind), "notice shape");
    if (n.origin.kind === "master") check([n.origin.masterId, n.origin.threadId, n.origin.turnId, n.origin.callId].every(label), "notice origin");
    if (n.createdBy !== undefined) check(n.createdBy && n.origin.kind === "browser" && n.createdBy.kind === "master" && Object.keys(n.createdBy).length === 5 &&
      [n.createdBy.masterId, n.createdBy.threadId, n.createdBy.turnId, n.createdBy.callId].every(label), "notice creation origin");
    const previous = latestForRun(next, n.runId), u = n.update;
    check(!next.notices.some(old => old.id === n.id), "duplicate notice");
    if (u) {
      check(Object.keys(u).length === 5 && Number.isSafeInteger(u.sequence) && u.sequence >= 0 && u.sequence <= 4096 &&
        Number.isSafeInteger(u.resultRevision) && u.resultRevision >= 0 && u.resultRevision <= 99 &&
        (u.artifactSha256 === null || sha(u.artifactSha256)) &&
        ["initial", "revision", "accepted", "revoked", "state"].includes(u.kind), "notice update shape");
      check(previous ? u.previousId === previous.id && u.sequence === (previous.update?.sequence ?? 0) + 1 &&
        n.configSha256 === previous.configSha256 && n.project === previous.project && n.taskId === previous.taskId &&
        n.version === previous.version && sameOrigin(previous,n) && u.resultRevision >= (previous.update?.resultRevision ?? 0) &&
        u.kind === updateKind(previous,n,u) : u.previousId === null && u.sequence === 0 && u.kind === "initial", "notice chain");
    } else check(!previous, "one historical initial result per run");
    next.notices.push(n); return next;
  }
  if (a.type === "prepare") {
    const d = a.delivery;
    check(uuid(d.id) && label(d.masterId) && label(d.threadId) && sha(d.textSha256) &&
      d.state === "prepared" && d.turnId === null && d.terminalSha256 === null && d.noticeIds.length > 0 &&
      d.noticeIds.length <= 8 && new Set(d.noticeIds).size === d.noticeIds.length &&
      !next.deliveries.some(old => old.id === d.id), "delivery identity");
    for (const id of d.noticeIds) {
      const n = next.notices.find(n => n.id === id), old = [...next.deliveries].reverse().find(d => d.noticeIds.includes(id));
      const recipient = n && taskResultRecipient(n);
      check(n && recipient?.masterId === d.masterId && recipient.threadId === d.threadId &&
        latestForRun(next,n.runId)?.id === n.id &&
        (!old || old.state === "not_sent"), "delivery must match the originating conversation without replay");
    }
    next.deliveries.push(d); return next;
  }
  check(a.type === "delivery", "action type");
  const d = next.deliveries.find(d => d.id === a.id); check(d, "delivery missing");
  const allowed: Record<Delivery["state"], Delivery["state"][]> = {
    prepared: ["dispatching", "not_sent", "unknown"], dispatching: ["bound", "not_sent", "unknown"],
    bound: ["completed", "failed", "interrupted", "unknown"], completed: [], failed: [], interrupted: [], not_sent: [], unknown: [],
  };
  check(allowed[d.state].includes(a.state), "delivery transition cannot replay or erase uncertainty");
  if(a.state === "dispatching") check(d.noticeIds.every(id => {
    const notice=next.notices.find(n=>n.id===id);return notice && latestForRun(next,notice.runId)?.id===id;
  }), "prepared result was superseded before dispatch");
  if (a.state === "bound") { check(label(a.turnId), "provider turn required"); d.turnId = a.turnId; }
  if (["completed", "failed", "interrupted"].includes(a.state)) {
    check(d.turnId && sha(a.terminalSha256), "terminal evidence required"); d.terminalSha256 = a.terminalSha256!;
  }
  d.state = a.state; return next;
}
export class TaskResultStore {
  private readonly path: string;
  private listener: ((summaries: TaskResultSummary[]) => void) | null = null;
  private constructor(readonly root: string) { this.path = join(root, "results.jsonl"); }
  static async open(root: string): Promise<TaskResultStore> {
    await mkdir(root, { recursive: true });
    check(!(await lstat(root)).isSymbolicLink(), "linked result directory");
    return new TaskResultStore(await realpath(root));
  }
  subscribe(listener: (summaries: TaskResultSummary[]) => void): void { this.listener = listener; }
  private async read(): Promise<{ state: State; events: Event[] }> {
    let text: string;
    try {
      const file = await lstat(this.path);
      check(file.isFile() && !file.isSymbolicLink() && file.size <= 16_000_000, "unsafe or oversized result log");
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { notices: [], deliveries: [] }, events: [] };
      throw error;
    }
    check(!text || text.endsWith("\n"), "incomplete log tail");
    let state: State = { notices: [], deliveries: [] }; const events: Event[] = [], keys = new Set<string>();
    for (const line of text.split("\n")) if (line) {
      check(line.length <= 32_000, "oversized event");
      const event = JSON.parse(line) as Event; check(!keys.has(event.key), "duplicate event"); keys.add(event.key);
      state = reduce(state, event); events.push(event);
    }
    for (const delivery of state.deliveries) {
      const input = await this.artifact(`input-${delivery.id}.txt`, 100_000);
      check(hash(input) === delivery.textSha256, "delivery input changed");
      if (delivery.terminalSha256) {
        const body = await this.artifact(`terminal-${delivery.id}.json`, 1_000_000);
        check(hash(body) === delivery.terminalSha256, "terminal artifact changed");
        const observation = JSON.parse(body) as CodexTurnObservation;
        check(observation.turnId === delivery.turnId && observation.status === delivery.state &&
          (observation.status !== "completed" || typeof observation.finalText === "string"), "terminal artifact identity");
      }
    }
    return { state, events };
  }
  private async artifact(name: string, maxBytes: number): Promise<string> {
    const path = join(this.root, name), file = await lstat(path);
    check(file.isFile() && !file.isSymbolicLink() && file.size <= maxBytes, "unsafe result artifact");
    return readFile(path, "utf8");
  }
  private async saveArtifact(name: string, body: string): Promise<void> {
    const file = await open(join(this.root, name), "wx", 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
  }
  private async preservePreUpgradeLog(): Promise<void> {
    const name="pre-v2-log.json";
    try {
      const saved=JSON.parse(await this.artifact(name,32_100_000));
      check(saved.schema==="negi-task-results-upgrade/2" && typeof saved.legacyLog==="string" &&
        hash(saved.legacyLog)===saved.sha256,"result upgrade archive changed");
      return;
    } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; }
    const legacyLog=await readFile(this.path,"utf8").catch(error=>{
      if((error as NodeJS.ErrnoException).code==="ENOENT")return "";throw error;
    });
    await this.saveArtifact(name,JSON.stringify({schema:"negi-task-results-upgrade/2",at:new Date().toISOString(),
      sha256:hash(legacyLog),legacyLog})+"\n");
  }
  private summaries(state: State): TaskResultSummary[] {
    return state.notices.map(n => {
      const d = [...state.deliveries].reverse().find(d => d.noticeIds.includes(n.id));
      const successor=state.notices.find(next=>next.update?.previousId===n.id);
      return { ...n, supersededBy:successor?.id??null,
        delivery: { state: d?.state ?? "pending", threadId: d?.threadId ?? null, turnId: d?.turnId ?? null } };
    });
  }
  async list(): Promise<TaskResultSummary[]> { return this.summaries((await this.read()).state); }
  private async locked<T>(action: (state: State, append: (action: Action) => Promise<void>) => Promise<T>): Promise<T> {
    const path = this.path + ".lock", deadline = Date.now() + 2000;
    let lock: Awaited<ReturnType<typeof open>>;
    for (;;) {
      try { lock = await open(path, "wx"); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows can report EPERM while the previous owner's closed lock is
        // being unlinked. Retrying never grants ownership: only a successful
        // exclusive create enters the action, and permanent denial still fails.
        const contention = code === "EEXIST" || (process.platform === "win32" && code === "EPERM");
        if (!contention || Date.now() >= deadline) throw error;
        await wait(10);
      }
    }
    let updates: TaskResultSummary[] | undefined;
    try {
      let state = (await this.read()).state;
      const value = await action(state, async action => {
        const event = { key: randomUUID(), at: new Date().toISOString(), action };
        const next = reduce(state, event);
        if(action.type==="notice"&&action.notice.update)await this.preservePreUpgradeLog();
        const file = await open(this.path, "a", 0o600);
        try { await file.writeFile(JSON.stringify(event) + "\n"); await file.sync(); } finally { await file.close(); }
        state = next; updates = this.summaries(state);
      });
      return value;
    } finally {
      await lock.close(); await unlink(path);
      if (updates) try { this.listener?.(updates); } catch { /* notification display does not undo evidence */ }
    }
  }
  async publish(notice: TaskResultNotice, facts?:{resultRevision:number;artifactSha256:string|null},
    stillCurrent?:()=>Promise<boolean>): Promise<void> {
    const pinned = structuredClone(notice);
    await this.locked(async (state, append) => {
      // Initial completion stays immutable when review/acceptance changes later.
      const existing = latestForRun(state,pinned.runId);
      if (existing) {
        check(existing.configSha256 === pinned.configSha256, "run configuration changed");
        check(sameOrigin(existing,pinned), "run origin changed");
        if (!facts || (existing.sourceSha256===pinned.sourceSha256 &&
          (existing.update?.resultRevision??0)===facts.resultRevision &&
          (!existing.update || existing.update.artifactSha256===facts.artifactSha256))) return;
      }
      if(facts) {
        const sequence=existing?(existing.update?.sequence??0)+1:0;
        pinned.update={sequence,previousId:existing?.id??null,kind:existing?updateKind(existing,pinned,facts):"initial",...facts};
        pinned.id=hash(JSON.stringify({schema:"negi-task-result/2",runId:pinned.runId,configSha256:pinned.configSha256,
          sourceSha256:pinned.sourceSha256,update:pinned.update}));
      }
      if(stillCurrent && !await stillCurrent())throw new TaskResultSourceChangedError("Task result source changed during publication");
      await append({ type: "notice", notice: pinned });
    });
  }
  async prepareContext(masterId: string, threadId: string, input: string,
    stillCurrent: (notice: TaskResultNotice) => Promise<boolean>,
    withSource: <T>(operation:()=>Promise<T>)=>Promise<T> = operation=>operation()): Promise<TaskResultContext | null> {
    check(label(masterId) && label(threadId), "context conversation");
    // Source checks can read Git/Task/review facts. They do not protect those
    // separate stores by holding this lock, and must not block other result publication.
    const current = new Map<string, string>(), snapshot = (await this.read()).state;
    for (const n of snapshot.notices) {
      if(latestForRun(snapshot,n.runId)?.id!==n.id)continue;
      const recipient = taskResultRecipient(n);
      if (recipient?.masterId !== masterId || recipient.threadId !== threadId) continue;
      const latest = [...snapshot.deliveries].reverse().find(d => d.noticeIds.includes(n.id));
      if (latest && latest.state !== "not_sent") continue;
      if (await stillCurrent(n)) current.set(n.id, hash(JSON.stringify(n)));
      if (current.size === 16) break;
    }
    let delivery: Delivery | undefined, text = input;
    await this.locked(async (state, append) => {
      const notices: TaskResultNotice[] = [];
      for (const n of state.notices) {
        if(latestForRun(state,n.runId)?.id!==n.id)continue;
        const recipient = taskResultRecipient(n);
        if (recipient?.masterId !== masterId || recipient.threadId !== threadId) continue;
        const latest = [...state.deliveries].reverse().find(d => d.noticeIds.includes(n.id));
        if (latest && latest.state !== "not_sent") continue;
        if (current.get(n.id) === hash(JSON.stringify(n))) notices.push(n);
        if (notices.length === 8) break;
      }
      if (!notices.length) return;
      text = input + "\n\n[Negi-Teams: この会話から委任または契約化したTaskの固定結果]\n" +
        "以下はserverが保存した結果通知です。通知時点の機械検証と人間受入を区別し、必要ならnegi_read_taskで現在を確認してください。結果不明の作業を再委任しないでください。\n" +
        JSON.stringify(notices);
      check(Buffer.byteLength(text) <= 100_000 && Buffer.byteLength(JSON.stringify(notices)) <= 16_000, "result context bound");
      delivery = { id: randomUUID(), masterId, threadId, noticeIds: notices.map(n => n.id), textSha256: hash(text),
        state: "prepared", turnId: null, terminalSha256: null };
      await this.saveArtifact(`input-${delivery.id}.txt`, text);
      await append({ type: "prepare", delivery });
    });
    if (!delivery) return null;
    const id = delivery.id;
    const update = (state: Delivery["state"], extra: Partial<Extract<Action, { type: "delivery" }>> = {}) =>
      this.locked(async (_state, append) => append({ type: "delivery", id, state, ...extra }));
    return { text, dispatching: () => withSource(async () => {
      // Recheck external Task/review facts at the final pre-send boundary. A
      // later change remains a distinct notification, never an overwritten input.
      for(const notice of snapshot.notices.filter(n=>delivery!.noticeIds.includes(n.id)))
        check(await stillCurrent(notice),"result source changed before dispatch");
      await update("dispatching");
    }), bind: turnId => update("bound", { turnId }),
      notSent: () => update("not_sent"), unknown: () => update("unknown"),
      terminal: observation => {
        check(["completed", "failed", "interrupted"].includes(observation.status) &&
          (observation.status !== "completed" || typeof observation.finalText === "string") &&
          label(observation.turnId), "known provider terminal required");
        return this.locked(async (state, append) => {
          check(state.deliveries.find(d => d.id === id)?.turnId === observation.turnId, "terminal provider differs");
          const body = JSON.stringify(observation);
          check(Buffer.byteLength(body) <= 1_000_000, "terminal artifact bound");
          await this.saveArtifact(`terminal-${id}.json`, body);
          await append({ type: "delivery", id, state: observation.status as Delivery["state"], terminalSha256: hash(body) });
        });
      } };
  }
}
