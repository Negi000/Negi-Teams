// Versioned, narrowly scoped policy for optional read-only profile selection.
// Agent text and Jev scores cannot approve or activate a policy.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { comparePair, type PairedComparison } from "./comparison.ts";
import type { ScheduledRole } from "./scheduler.ts";

export type PolicyMetric = "elapsed_ms" | "input_tokens" | "api_cost_usd";
export interface ReadOnlyPolicy {
  id: string;
  parentId: string | null;
  taskClass: "read_only_research";
  role: ScheduledRole;
  model: string;
  effort: string;
  metric: PolicyMetric;
  sourceRefs: string[];
}
export type PolicyStage = "candidate" | "shadow" | "compared" |
  "approved" | "active" | "retired";
export interface PolicyEntry {
  policy: ReadOnlyPolicy;
  hash: string;
  stage: PolicyStage;
  comparisonHashes: string[];
  approvalRef: string | null;
  rollbackRef: string | null;
}
export interface PolicyState { activeId: string | null; entries: PolicyEntry[] }
export type PolicyAction =
  | { type: "propose"; policy: ReadOnlyPolicy }
  | { type: "shadow"; id: string; evidenceRef: string }
  | { type: "compare"; id: string; pairs: PairedComparison[] }
  | { type: "approve"; id: string; approvalRef: string }
  | { type: "activate"; id: string }
  | { type: "rollback"; id: string; reasonRef: string };
export interface PolicyEvent { key: string; at: string; action: PolicyAction }
export type PolicyEvidenceVerifier = (event: PolicyEvent) => Promise<boolean>;
export type PolicyApprovalVerifier = (event: PolicyEvent) => Promise<boolean>;

function requirePolicy(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new Error(`Policy transition rejected: ${reason}`);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function validPolicy(policy: ReadOnlyPolicy): boolean {
  const label = (value: unknown) => typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
  return Boolean(policy && label(policy.id) && label(policy.model) && label(policy.effort) &&
    (policy.parentId === null || label(policy.parentId)) &&
    policy.taskClass === "read_only_research" &&
    ["astra", "sol", "luna"].includes(policy.role) &&
    ["elapsed_ms", "input_tokens", "api_cost_usd"].includes(policy.metric) &&
    Array.isArray(policy.sourceRefs) && policy.sourceRefs.length > 0 && policy.sourceRefs.length <= 20 &&
    policy.sourceRefs.every((ref) => typeof ref === "string" && ref.trim().length > 0 && ref.length <= 2048));
}
function metricDelta(pair: PairedComparison, metric: PolicyMetric): number | null {
  if (metric === "elapsed_ms") return pair.delta.elapsedMs;
  if (metric === "input_tokens") return pair.delta.inputTokens;
  return pair.delta.apiCostUsd;
}

export function reducePolicy(state: PolicyState | null, event: PolicyEvent): PolicyState {
  requirePolicy(Boolean(event.key) && Number.isFinite(Date.parse(event.at)),
    "event identity invalid");
  const next: PolicyState = state === null ? { activeId: null, entries: [] } :
    structuredClone(state);
  const action = event.action;
  if (action.type === "propose") {
    requirePolicy(validPolicy(action.policy) &&
      !next.entries.some((entry) => entry.policy.id === action.policy.id) &&
      action.policy.parentId === next.activeId, "candidate must extend active version");
    next.entries.push({ policy: structuredClone(action.policy), hash: hash(action.policy),
      stage: "candidate", comparisonHashes: [], approvalRef: null, rollbackRef: null });
    return next;
  }
  const entry = next.entries.find((item) => item.policy.id === action.id);
  requirePolicy(Boolean(entry), "policy id missing");
  if (action.type === "shadow") {
    requirePolicy(entry!.stage === "candidate" && Boolean(action.evidenceRef),
      "shadow evidence required");
    entry!.stage = "shadow";
    return next;
  }
  if (action.type === "compare") {
    requirePolicy(entry!.stage === "shadow" && Array.isArray(action.pairs) &&
      action.pairs.length >= 2 && action.pairs.length <= 100 &&
      new Set(action.pairs.map((pair) => pair.experimentId)).size === action.pairs.length &&
      new Set(action.pairs.map((pair) => pair.baseline.objectiveHash)).size === action.pairs.length &&
      new Set(action.pairs.flatMap((pair) => [pair.baseline.evidenceRef, pair.candidate.evidenceRef]))
        .size === action.pairs.length * 2,
    "two independent paired cases required");
    const deltas: number[] = [];
    for (const pair of action.pairs) {
      const fresh = comparePair(pair.experimentId, pair.baseline, pair.candidate);
      requirePolicy(fresh.evidenceHash === pair.evidenceHash &&
        JSON.stringify(fresh) === JSON.stringify(pair) && fresh.candidateEligible,
      "comparison integrity or quality failed");
      requirePolicy(fresh.candidate.profile.model === entry!.policy.model &&
        fresh.candidate.profile.effort === entry!.policy.effort &&
        JSON.stringify(fresh.baseline.profile) === JSON.stringify(action.pairs[0].baseline.profile),
      "comparison does not measure the proposed profile against one baseline");
      const delta = metricDelta(fresh, entry!.policy.metric);
      requirePolicy(delta !== null, "target metric was not observed");
      deltas.push(delta!);
    }
    requirePolicy(deltas.every((delta) => delta <= 0) &&
      deltas.some((delta) => delta < 0), "candidate did not improve target metric");
    entry!.comparisonHashes = action.pairs.map((pair) => pair.evidenceHash);
    entry!.stage = "compared";
    return next;
  }
  if (action.type === "approve") {
    requirePolicy(entry!.stage === "compared" &&
      /^user:[^\s]+$/.test(action.approvalRef), "human approval reference required");
    entry!.approvalRef = action.approvalRef;
    entry!.stage = "approved";
    return next;
  }
  if (action.type === "activate") {
    requirePolicy(entry!.stage === "approved" &&
      entry!.policy.parentId === next.activeId, "approved version is stale");
    if (next.activeId !== null) {
      const old = next.entries.find((item) => item.policy.id === next.activeId);
      requirePolicy(old !== undefined && old.stage === "active", "active parent missing");
      old.stage = "retired";
    }
    entry!.stage = "active";
    next.activeId = action.id;
    return next;
  }
  requirePolicy(action.type === "rollback" && entry!.stage === "active" &&
    next.activeId === action.id && Boolean(action.reasonRef),
  "rollback requires active version and evidence");
  entry!.stage = "retired";
  entry!.rollbackRef = action.reasonRef;
  next.activeId = entry!.policy.parentId;
  if (next.activeId !== null) {
    const previous = next.entries.find((item) => item.policy.id === next.activeId);
    requirePolicy(previous !== undefined && previous.stage === "retired" &&
      previous.rollbackRef === null, "rollback target unavailable");
    previous.stage = "active";
  }
  return next;
}

/** Selection never overrides an explicit user profile or invents a fallback model. */
export function selectReadOnlyProfile(state: PolicyState | null, input: {
  taskClass: string;
  role: ScheduledRole;
  explicitProfile: { model: string; effort: string } | null;
  catalog: Array<{ model: string; efforts: string[]; inputModalities: string[] }>;
}): { model: string; effort: string; policyId: string; policyHash: string } | null {
  if (!state?.activeId || input.explicitProfile) return null;
  const entry = state.entries.find((item) => item.policy.id === state.activeId);
  if (!entry || entry.stage !== "active" ||
      entry.hash !== hash(entry.policy) || entry.policy.taskClass !== input.taskClass ||
      entry.policy.role !== input.role) return null;
  const { model, effort } = entry.policy;
  if (!input.catalog.some((item) => item.model === model &&
      item.efforts.includes(effort) && item.inputModalities.includes("text"))) return null;
  return { model, effort, policyId: entry.policy.id, policyHash: entry.hash };
}

/** Compare and approval callbacks must use evidence outside an agent-editable log. */
export class FilePolicyLedger {
  readonly path: string;
  constructor(path: string, private readonly verifyEvidence?: PolicyEvidenceVerifier,
              private readonly verifyApproval?: PolicyApprovalVerifier) {
    this.path = resolve(path);
  }
  async read(): Promise<{ state: PolicyState | null; events: PolicyEvent[] }> {
    let data: string;
    try { data = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: null, events: [] };
      throw error;
    }
    requirePolicy(!data || data.endsWith("\n"), "incomplete log tail");
    let state: PolicyState | null = null;
    const events: PolicyEvent[] = [];
    const keys = new Set<string>();
    for (const line of data.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as PolicyEvent;
      requirePolicy(!keys.has(event.key), "duplicate event key");
      keys.add(event.key);
      if (event.action.type === "compare")
        requirePolicy(Boolean(this.verifyEvidence) && await this.verifyEvidence!(event),
          "trusted comparison evidence unavailable");
      if (event.action.type === "approve")
        requirePolicy(Boolean(this.verifyApproval) && await this.verifyApproval!(event),
          "trusted human approval unavailable");
      state = reducePolicy(state, event);
      events.push(event);
    }
    return { state, events };
  }
  async append(event: PolicyEvent): Promise<PolicyState> {
    const pinned = structuredClone(event);
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const lock = await open(lockPath, "wx");
    try {
      const current = await this.read();
      const duplicate = current.events.find((item) => item.key === pinned.key);
      if (duplicate) {
        requirePolicy(JSON.stringify(duplicate.action) === JSON.stringify(pinned.action),
          "idempotency key reused");
        return current.state!;
      }
      const next = reducePolicy(current.state, pinned);
      if (pinned.action.type === "compare")
        requirePolicy(Boolean(this.verifyEvidence) && await this.verifyEvidence!(pinned),
          "trusted comparison evidence unavailable");
      if (pinned.action.type === "approve")
        requirePolicy(Boolean(this.verifyApproval) && await this.verifyApproval!(pinned),
          "trusted human approval unavailable");
      const file = await open(this.path, "a");
      try { await file.writeFile(JSON.stringify(pinned) + "\n", "utf8");
        await file.sync(); }
      finally { await file.close(); }
      return next;
    } finally { await lock.close(); await unlink(lockPath); }
  }
}
