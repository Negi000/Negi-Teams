// Phase 3 single-task ledger. No model or shell is launched here.
// Events are append-only; provider uncertainty requires explicit reconciliation.
import { open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export type TaskStatus = "queued" | "planning" | "ready_for_worker" | "working" |
  "verifying" | "ready_for_review" | "accepted" | "blocked" | "stopped" | "needs_reconciliation";
export type TaskRole = "astra" | "sol";
export interface AttemptUsage {
  scope: "turn" | "thread" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  billing: "api_actual" | "estimate" | "subscription_limit" | "unknown";
  costUsd: number | null;
  sourceRef: string;
}
export interface ContractRef {
  vaultId: string;
  version: number;
  sha256: string;
  project: string;
  objective: string;
  acceptance: string[];
  baseSha: string;
  scope?: { in: string[]; out: string[]; allowedPaths: string[] };
  invariants?: string[];
  verification?: string[];
  escalation?: string[];
  limits?: { maxAttempts: number; timeLimitMinutes: number };
  sourceNotes?: Array<{ id: string; kind: string; version: number; sha256: string; path: string }>;
  contextPacks?: { astra: { sha256: string; path: string }; sol: { sha256: string; path: string } };
  approvedPlan?: { approvalRef: string; threadId: string; turnId: string; callId: string };
}
export interface Attempt {
  id: string;
  role: TaskRole;
  requestedModel: string;
  resolvedModel: string | null;
  threadId: string | null;
  turnId: string | null;
  state: "running" | "completed" | "failed" | "unknown" | "abandoned";
  outputRef: string | null;
  usage: AttemptUsage | null;
}
export interface Approval {
  id: string;
  attemptId: string;
  threadId: string;
  turnId: string;
  operation: string;
  target: string;
  targetKnown?: boolean;
  expiresAt: string;
  decision: "pending" | "allow" | "deny" | "discarded";
}
export interface ProviderTurnEvidence {
  threadId: string;
  turnId: string;
  found: boolean;
  status: "inProgress" | "completed" | "failed" | "interrupted" | null;
  pagesRead: number;
  completeSearch: boolean;
  observedAtMs: number;
  source: "thread/turns/list";
  processSafety?: {source:"thread/items/list";complete:boolean;pagesRead:number;itemCount:number;
    itemTypes:string[];sha256:string;noExecutableItems:boolean};
}
export interface TaskSnapshot {
  runId: string;
  contract: ContractRef;
  status: TaskStatus;
  attempts: Attempt[];
  approvals: Approval[];
  providerObservations: Array<{ attemptId: string; inspection: ProviderTurnEvidence }>;
  verification: { outcome: "passed" | "failed" | "unknown"; evidenceRef: string } | null;
  stopReason: string | null;
  stoppedFrom: TaskStatus | null;
  acceptedBy: string | null;
  resultRevisions?: Array<{ fromEvidenceRef: string; evidenceRef: string; revisionRef: string }>;
}

export type TaskAction =
  | { type: "create"; runId: string; contract: ContractRef }
  | { type: "adopt_approved_plan"; approvalRef: string; outputRef: string }
  | { type: "start_attempt"; attemptId: string; role: TaskRole; requestedModel: string }
  | { type: "bind_thread"; attemptId: string; threadId: string }
  | { type: "bind_provider"; attemptId: string; threadId: string; turnId: string }
  | { type: "complete_attempt"; attemptId: string; resolvedModel: string | null;
      threadId: string | null; turnId: string | null; outputRef: string; usage?: AttemptUsage | null }
  | { type: "provider_unknown"; attemptId: string; reason: string }
  | { type: "observe_provider"; attemptId: string; inspection: ProviderTurnEvidence }
  | { type: "fail_attempt"; attemptId: string; reason: string }
  | { type: "reconcile"; attemptId: string; outcome: "completed" | "abandoned";
      evidenceRef: string; outputRef?: string }
  | { type: "close_uncertain_attempt"; attemptId: string; evidenceRef: string }
  | { type: "request_approval"; approval: Omit<Approval, "decision"> }
  | { type: "decide_approval"; approvalId: string; attemptId: string; threadId: string;
      turnId: string; operation: string; target: string; decision: "allow" | "deny"; approvalRef?: string }
  | { type: "discard_approval"; approvalId: string; reason: "expired" | "provider_turn_ended" }
  | { type: "stop"; reason: string }
  | { type: "resume" }
  | { type: "verify"; outcome: "passed" | "failed" | "unknown"; evidenceRef: string }
  | { type: "reverify_result"; fromEvidenceRef: string; evidenceRef: string; revisionRef: string }
  | { type: "accept"; reviewer: string }
  | { type: "revoke_acceptance"; reasonRef: string };

export interface TaskEvent { key: string; at: string; action: TaskAction }
export type ReconciliationVerifier = (review: {
  event: TaskEvent;
  state: TaskSnapshot;
  events?: TaskEvent[];
}) => Promise<boolean>;
export type AcceptanceVerifier = ReconciliationVerifier;

function requireState(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Task transition rejected: ${message}`);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function hex(value: string): boolean { return /^[0-9a-f]{64}$/i.test(value); }
function gitObjectId(value: string): boolean { return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value); }
function copy(state: TaskSnapshot): TaskSnapshot { return structuredClone(state); }
function validUsage(usage: AttemptUsage): boolean {
  const count = (value: number | null) => value === null ||
    (Number.isSafeInteger(value) && value >= 0);
  return ["turn", "thread", "unknown"].includes(usage.scope) &&
    ["api_actual", "estimate", "subscription_limit", "unknown"].includes(usage.billing) &&
    Boolean(usage.sourceRef) && count(usage.inputTokens) && count(usage.outputTokens) &&
    count(usage.cachedInputTokens) && count(usage.reasoningOutputTokens) &&
    (usage.inputTokens === null || usage.cachedInputTokens === null ||
      usage.cachedInputTokens <= usage.inputTokens) &&
    (usage.outputTokens === null || usage.reasoningOutputTokens === null ||
      usage.reasoningOutputTokens <= usage.outputTokens) &&
    (usage.costUsd === null ||
      (Number.isFinite(usage.costUsd) && usage.costUsd >= 0 &&
       (usage.billing === "api_actual" || usage.billing === "estimate"))) &&
    (usage.billing !== "subscription_limit" || usage.costUsd === null);
}

export function reduceTask(state: TaskSnapshot | null, event: TaskEvent): TaskSnapshot {
  const a = event.action;
  requireState(Boolean(event.key) && !Number.isNaN(Date.parse(event.at)), "event key/time missing");
  if (a.type === "create") {
    requireState(state === null, "run already exists");
    requireState(Boolean(a.runId) && Boolean(a.contract.vaultId) && a.contract.version > 0 &&
      hex(a.contract.sha256) && gitObjectId(a.contract.baseSha) && Boolean(a.contract.project) &&
      Boolean(a.contract.objective) && a.contract.acceptance.length > 0, "invalid contract snapshot");
    return { runId: a.runId, contract: structuredClone(a.contract), status: "queued",
      attempts: [], approvals: [], providerObservations: [], verification: null,
      stopReason: null, stoppedFrom: null,
      acceptedBy: null };
  }
  requireState(state !== null, "create must be first");
  const next = copy(state);
  const active = next.attempts.find((x) => x.state === "running");
  switch (a.type) {
    case "adopt_approved_plan": {
      requireState(next.status === "queued" && next.attempts.length === 0 &&
        Boolean(next.contract.approvedPlan) && next.contract.approvedPlan!.approvalRef === a.approvalRef &&
        a.approvalRef.startsWith("user:http-task-plan:") && /^.{1,4096}#sha256=[a-f0-9]{64}$/.test(a.outputRef),
        "approved plan must match the pinned contract before any provider attempt");
      next.status = "ready_for_worker";
      return next;
    }
    case "start_attempt": {
      requireState(!active, "another attempt is running");
      requireState(Boolean(a.attemptId) && Boolean(a.requestedModel) &&
        !next.attempts.some((x) => x.id === a.attemptId), "attempt ID/model invalid");
      const expectedRole = next.status === "queued" ? "astra" :
        next.status === "ready_for_worker" ? "sol" : null;
      requireState(a.role === expectedRole, "role or status invalid");
      next.attempts.push({ id: a.attemptId, role: a.role, requestedModel: a.requestedModel,
        resolvedModel: null, threadId: null, turnId: null, state: "running", outputRef: null,
        usage: null });
      next.status = a.role === "astra" ? "planning" : "working";
      return next;
    }
    case "complete_attempt": {
      requireState(active?.id === a.attemptId && Boolean(a.outputRef), "attempt is not running");
      requireState(active.threadId === a.threadId && active.turnId === a.turnId &&
        Boolean(a.threadId) && Boolean(a.turnId), "provider IDs must be bound before completion");
      requireState(!next.approvals.some((x) => x.decision === "pending"), "approval is pending");
      requireState(a.usage == null || validUsage(a.usage), "usage fields invalid");
      active.resolvedModel = a.resolvedModel;
      active.threadId = a.threadId;
      active.turnId = a.turnId;
      active.outputRef = a.outputRef;
      active.usage = a.usage ?? null;
      active.state = "completed";
      next.status = active.role === "astra" ? "ready_for_worker" : "verifying";
      return next;
    }
    case "bind_provider":
      requireState(active?.id === a.attemptId && Boolean(a.threadId) && Boolean(a.turnId) &&
        (active.threadId === null || active.threadId === a.threadId) &&
        (active.turnId === null || active.turnId === a.turnId), "provider identity mismatch");
      active.threadId = a.threadId;
      active.turnId = a.turnId;
      return next;
    case "bind_thread":
      requireState(active?.id === a.attemptId && Boolean(a.threadId) &&
        (active.threadId === null || active.threadId === a.threadId) &&
        active.turnId === null, "provider thread identity mismatch");
      active.threadId = a.threadId;
      return next;
    case "provider_unknown":
      requireState(active?.id === a.attemptId && Boolean(a.reason), "unknown attempt invalid");
      active.state = "unknown";
      for (const p of next.approvals) if (p.decision === "pending") p.decision = "discarded";
      next.status = "needs_reconciliation";
      next.stopReason = a.reason;
      return next;
    case "observe_provider": {
      const attempt = next.attempts.find((x) => x.id === a.attemptId);
      const inspection = a.inspection;
      requireState(next.status === "needs_reconciliation" && attempt?.state === "unknown" &&
        Boolean(attempt.threadId) && Boolean(attempt.turnId) &&
        attempt.threadId === inspection.threadId && attempt.turnId === inspection.turnId &&
        inspection.source === "thread/turns/list" &&
        Number.isSafeInteger(inspection.pagesRead) && inspection.pagesRead > 0 &&
        Number.isSafeInteger(inspection.observedAtMs) && inspection.observedAtMs > 0 &&
        typeof inspection.completeSearch === "boolean" &&
        typeof inspection.found === "boolean" &&
        (inspection.found
          ? inspection.completeSearch && ["inProgress", "completed", "failed", "interrupted"].includes(inspection.status ?? "")
          : inspection.status === null), "provider observation identity or status invalid");
      next.providerObservations.push({ attemptId: a.attemptId,
        inspection: structuredClone(inspection) });
      return next;
    }
    case "fail_attempt":
      requireState(active?.id === a.attemptId && Boolean(a.reason), "failed attempt invalid");
      active.state = "failed";
      for (const p of next.approvals) if (p.decision === "pending") p.decision = "discarded";
      next.status = "blocked";
      next.stopReason = a.reason;
      return next;
    case "reconcile": {
      const attempt = next.attempts.find((x) => x.id === a.attemptId);
      requireState(next.status === "needs_reconciliation" && attempt?.state === "unknown" &&
        Boolean(a.evidenceRef), "reconciliation evidence required");
      if (a.outcome === "completed") {
        requireState(Boolean(a.outputRef), "completed output reference required");
        attempt.state = "completed";
        attempt.outputRef = a.outputRef!;
        next.status = attempt.role === "astra" ? "ready_for_worker" : "verifying";
      } else {
        attempt.state = "abandoned";
        next.status = attempt.role === "astra" ? "queued" : "ready_for_worker";
      }
      next.stopReason = `reconciled: ${a.evidenceRef}`;
      return next;
    }
    case "close_uncertain_attempt": {
      const attempt = next.attempts.find((x) => x.id === a.attemptId);
      requireState(Boolean(attempt) && ["unknown", "running"].includes(attempt!.state) &&
        ["needs_reconciliation", "planning", "working"].includes(next.status) && Boolean(a.evidenceRef),
        "uncertain attempt and signed close evidence required");
      attempt!.state = "abandoned";
      for (const approval of next.approvals) if (approval.decision === "pending") approval.decision = "discarded";
      next.stoppedFrom = next.status;next.status = "stopped";
      next.stopReason = `Closed after reconciliation: ${a.evidenceRef}`;
      return next;
    }
    case "request_approval": {
      const p = a.approval;
      requireState(active !== undefined && active.id === p.attemptId &&
        active.threadId === p.threadId && active.turnId === p.turnId &&
        Boolean(p.threadId) && Boolean(p.turnId) && Boolean(p.operation) &&
        Boolean(p.target) && !next.approvals.some((x) => x.id === p.id) &&
        Date.parse(p.expiresAt) > Date.parse(event.at), "approval scope or expiry invalid");
      next.approvals.push({ ...p, decision: "pending" });
      return next;
    }
    case "decide_approval": {
      const p = next.approvals.find((x) => x.id === a.approvalId);
      requireState(Boolean(p) && p!.decision === "pending" && active?.id === a.attemptId &&
        ["allow", "deny"].includes(a.decision) && (a.decision !== "allow" || p!.targetKnown !== false) &&
        p!.attemptId === a.attemptId && p!.threadId === a.threadId && p!.turnId === a.turnId &&
        p!.operation === a.operation && p!.target === a.target &&
        Date.parse(event.at) <= Date.parse(p!.expiresAt), "approval is stale or mismatched");
      p!.decision = a.decision;
      return next;
    }
    case "discard_approval": {
      const p = next.approvals.find((x) => x.id === a.approvalId);
      requireState(Boolean(p) && p!.decision === "pending" &&
        (a.reason === "provider_turn_ended" || (a.reason === "expired" && Date.parse(event.at) >= Date.parse(p!.expiresAt))),
        "approval discard target or expiry invalid");
      p!.decision = "discarded";
      return next;
    }
    case "stop":
      requireState(next.status !== "accepted" && next.status !== "stopped" &&
        next.status !== "needs_reconciliation" && Boolean(a.reason), "cannot stop");
      for (const p of next.approvals) if (p.decision === "pending") p.decision = "discarded";
      if (active) { active.state = "unknown"; next.status = "needs_reconciliation"; }
      else { next.stoppedFrom = next.status; next.status = "stopped"; }
      next.stopReason = a.reason;
      return next;
    case "resume":
      requireState(next.status === "stopped" && !active, "unknown attempt requires reconciliation");
      requireState(next.stoppedFrom !== null, "no safe checkpoint");
      next.status = next.stoppedFrom;
      next.stoppedFrom = null;
      next.stopReason = null;
      return next;
    case "verify":
      requireState(next.status === "verifying" && Boolean(a.evidenceRef), "verification evidence required");
      next.verification = { outcome: a.outcome, evidenceRef: a.evidenceRef };
      next.status = a.outcome === "passed" ? "ready_for_review" : "blocked";
      return next;
    case "accept":
      requireState(next.status === "ready_for_review" && next.verification?.outcome === "passed" &&
        Boolean(a.reviewer), "explicit reviewer and passing verification required");
      next.status = "accepted";
      next.acceptedBy = a.reviewer;
      return next;
    case "reverify_result":
      requireState(next.status === "ready_for_review" && next.acceptedBy === null &&
        next.verification?.outcome === "passed" && next.verification.evidenceRef === a.fromEvidenceRef &&
        Boolean(a.evidenceRef && a.revisionRef) && a.evidenceRef !== a.fromEvidenceRef &&
        !(next.resultRevisions ?? []).some((revision) => revision.revisionRef === a.revisionRef),
        "revision requires an unaccepted result, its previous evidence, and new verified evidence");
      next.resultRevisions = [...(next.resultRevisions ?? []), { fromEvidenceRef: a.fromEvidenceRef,
        evidenceRef: a.evidenceRef, revisionRef: a.revisionRef }];
      next.verification = { outcome: "passed", evidenceRef: a.evidenceRef };
      next.stopReason = null;
      return next;
    case "revoke_acceptance":
      requireState(next.status === "accepted" && Boolean(a.reasonRef), "acceptance revocation requires an accepted result and reason");
      next.status = "ready_for_review";
      next.acceptedBy = null;
      next.stopReason = `Human acceptance revoked: ${a.reasonRef}`;
      return next;
    default:
      throw new Error("Task transition rejected: unknown action");
  }
}

/** One local JSONL run. This class never reads task output or Vault contents. */
export class FileTaskLedger {
  private readonly path: string;
  constructor(path: string, private readonly now: () => number = Date.now,
              private readonly verifyReconciliation?: ReconciliationVerifier,
              private readonly verifyAcceptance?: AcceptanceVerifier,
              private readonly verifyOperationApproval?: ReconciliationVerifier,
              private readonly verifyResultRevision?: ReconciliationVerifier,
              private readonly verifyReconciliationOnRead = false) {
    this.path = resolve(path);
  }

  async read(): Promise<{ state: TaskSnapshot | null; events: TaskEvent[] }> {
    let data: string;
    try { data = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: null, events: [] };
      throw error;
    }
    if (data && !data.endsWith("\n")) throw new Error("Incomplete ledger tail; no automatic repair");
    let state: TaskSnapshot | null = null;
    const events: TaskEvent[] = [];
    const keys = new Set<string>();
    for (const line of data.split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as TaskEvent;
      requireState(!keys.has(event.key), "duplicate event key in ledger");
      keys.add(event.key);
      const next = reduceTask(state, event);
      if (event.action.type === "close_uncertain_attempt" ||
          (event.action.type === "reconcile" && this.verifyReconciliationOnRead)) {
        requireState(Boolean(this.verifyReconciliation) && state !== null, "trusted reconciliation review unavailable");
        requireState(await this.verifyReconciliation!({event, state:structuredClone(state!),events:structuredClone(events)}),
          "trusted reconciliation review rejected");
      }
      if (event.action.type === "accept" || event.action.type === "revoke_acceptance") {
        requireState(Boolean(this.verifyAcceptance) && state !== null,
          "trusted human acceptance unavailable");
        requireState(await this.verifyAcceptance!({ event,
          state: structuredClone(state!) }), "trusted human acceptance rejected");
      }
      if (event.action.type === "decide_approval") {
        requireState(Boolean(this.verifyOperationApproval) && state !== null,
          "trusted operation approval unavailable");
        requireState(await this.verifyOperationApproval!({ event, state: structuredClone(state!) }),
          "trusted operation approval rejected");
      }
      if (event.action.type === "reverify_result") {
        requireState(Boolean(this.verifyResultRevision) && state !== null, "trusted result revision unavailable");
        requireState(await this.verifyResultRevision!({ event, state: structuredClone(state!) }), "trusted result revision rejected");
      }
      state = next;
      events.push(event);
    }
    return { state, events };
  }

  async append(event: TaskEvent): Promise<TaskSnapshot> {
    // A verifier is asynchronous. Pin the caller's data before any await so a
    // later mutation cannot make the persisted event differ from what passed review.
    const entry = structuredClone(event);
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = this.path + ".lock";
    const lock = await open(lockPath, "wx");
    try {
      const current = await this.read();
      const duplicate = current.events.find((x) => x.key === entry.key);
      if (duplicate) {
        requireState(same(duplicate.action, entry.action), "idempotency key reused for different action");
        return current.state!;
      }
      if (entry.action.type === "request_approval") {
        requireState(Date.parse(entry.action.approval.expiresAt) > this.now(), "approval already expired");
      }
      if (entry.action.type === "decide_approval") {
        const approvalId = entry.action.approvalId;
        const approval = current.state?.approvals.find((x) => x.id === approvalId);
        requireState(Boolean(approval) && this.now() <= Date.parse(approval!.expiresAt), "approval expired");
      }
      const next = reduceTask(current.state, entry);
      if (entry.action.type === "reconcile" || entry.action.type === "close_uncertain_attempt") {
        requireState(Boolean(this.verifyReconciliation), "trusted reconciliation review unavailable");
        const approved = await this.verifyReconciliation!({ event: structuredClone(entry),
          state: structuredClone(current.state!),events:structuredClone(current.events) });
        requireState(approved === true, "trusted reconciliation review rejected");
      }
      if (entry.action.type === "accept" || entry.action.type === "revoke_acceptance") {
        requireState(Boolean(this.verifyAcceptance), "trusted human acceptance unavailable");
        requireState(await this.verifyAcceptance!({ event: structuredClone(entry),
          state: structuredClone(current.state!) }), "trusted human acceptance rejected");
      }
      if (entry.action.type === "decide_approval") {
        requireState(Boolean(this.verifyOperationApproval), "trusted operation approval unavailable");
        requireState(await this.verifyOperationApproval!({ event: structuredClone(entry),
          state: structuredClone(current.state!) }), "trusted operation approval rejected");
      }
      if (entry.action.type === "reverify_result") {
        requireState(Boolean(this.verifyResultRevision), "trusted result revision unavailable");
        requireState(await this.verifyResultRevision!({ event: structuredClone(entry),
          state: structuredClone(current.state!) }), "trusted result revision rejected");
      }
      const file = await open(this.path, "a");
      try { await file.writeFile(JSON.stringify(entry) + "\n", "utf8"); await file.sync(); }
      finally { await file.close(); }
      return next;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
