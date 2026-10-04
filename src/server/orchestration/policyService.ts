// Explicit local experiment registration + signed browser decisions. No model text
// or client-supplied file path can supply evidence or authorize a transition.
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { comparePair, type PairedComparison } from "./comparison.ts";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import { reducePolicy, selectReadOnlyProfile, type PolicyAction, type PolicyEvent,
  type PolicyEntry, type PolicyState, type ReadOnlyPolicy } from "./policy.ts";
import type { ScheduledRole } from "./scheduler.ts";
import { withMasterStorageGuard } from "./masterStorageGuard.ts";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const bytesDigest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const SHA = /^[0-9a-f]{64}$/;
const emptyState = (): PolicyState => ({ activeId: null, entries: [] });
const inside = (root: string, path: string) => {
  const rel = relative(root, path); return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};
interface Candidate {
  title: string; policy: ReadOnlyPolicy; shadowRef: string;
  report: { path: string; sha256: string };
}
function canonicalDefinition(candidate: Candidate): Candidate {
  const p = candidate.policy;
  return { title: candidate.title, policy: { id: p.id, parentId: p.parentId, taskClass: p.taskClass,
    role: p.role, model: p.model, effort: p.effort, metric: p.metric, sourceRefs: [...p.sourceRefs] },
    shadowRef: candidate.shadowRef, report: { path: resolve(candidate.report.path), sha256: candidate.report.sha256 } };
}
interface Registered extends Candidate { definitionSha256: string; pairs: PairedComparison[]; evidenceError: string | null }
export interface PolicyView extends PolicyEntry {
  title: string; comparisons: PairedComparison[]; heldReasons: string[];
  canApprove: boolean; canActivate: boolean; canRollback: boolean;
}
export interface PolicySnapshot {
  sha256: string; activeId: string | null; items: PolicyView[];
  history: Array<{ id: string; at: string; op: string; policyId: string; reason: string }>;
}
export interface ReadOnlyPolicySelection {
  model: string; effort: string; policyId: string; policyHash: string; stateSha256: string;
}
export interface ReadOnlyPolicySource {
  select(input: { role: ScheduledRole; taskClass: "read_only_research";
    defaultProfile: { model: string; effort: string };
    /** Opted-in Tasks hold a matching active version if evidence/catalog is unavailable. */
    holdUnavailableActive?: true;
    catalog: Array<{ model: string; efforts: string[]; inputModalities: string[] }> }): Promise<ReadOnlyPolicySelection | null>;
}

export class LocalPolicyService implements ReadOnlyPolicySource {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly root: string, private readonly proofs: HumanReviewProofStore,
    private readonly candidates: Candidate[], private readonly writableRoots: string[],
    private readonly rootIdentity: { dev: number; ino: number }) {}

  static async open(raw: unknown, writableRoots: string[], signingSecret: string): Promise<LocalPolicyService> {
    if (typeof signingSecret !== "string" || signingSecret.length < 16 || signingSecret.length > 4096)
      throw Error("Policy requires an external server signing secret");
    const value = raw as { storageRoot?: unknown; candidates?: unknown } | null;
    if (!value || typeof value.storageRoot !== "string" || !isAbsolute(value.storageRoot) ||
        !Array.isArray(value.candidates) || value.candidates.length > 100) throw Error("Policy registration invalid");
    const target = resolve(value.storageRoot);
    let canonical: string;
    try { if ((await lstat(target)).isSymbolicLink()) throw Error("Policy storage linked"); canonical = await realpath(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = join(await realpath(dirname(target)), basename(target)); }
    const roots = await Promise.all(writableRoots.map(root => realpath(root)));
    if (roots.some(root => inside(root, canonical) || inside(canonical, root))) throw Error("Policy authority overlaps model-writable storage");
    const candidates = structuredClone(value.candidates) as Candidate[];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.title !== "string" || !candidate.title.trim() || candidate.title.length > 160 ||
          typeof candidate.shadowRef !== "string" || !candidate.shadowRef.trim() || candidate.shadowRef.length > 2048 ||
          !candidate.report || typeof candidate.report.path !== "string" || !isAbsolute(candidate.report.path) ||
          candidate.report.path.length > 2048 || typeof candidate.report.sha256 !== "string" || !SHA.test(candidate.report.sha256) ||
          Object.keys(candidate).some(key => !["title", "policy", "shadowRef", "report"].includes(key)) ||
          Object.keys(candidate.report).some(key => !["path", "sha256"].includes(key)) || !candidate.policy ||
          Object.keys(candidate.policy).some(key => !["id", "parentId", "taskClass", "role", "model", "effort", "metric", "sourceRefs"].includes(key)))
        throw Error("Policy candidate invalid");
      // Validate its fixed parent as part of the definition; approval will require
      // that parent to be the actual active version at the time of the operation.
      reducePolicy({ activeId: candidate.policy?.parentId, entries: [] },
        { key: "validate", at: new Date().toISOString(), action: { type: "propose", policy: candidate.policy } });
      Object.assign(candidate, canonicalDefinition(candidate));
    }
    if (new Set(candidates.map(row => row.policy.id)).size !== candidates.length)
      throw Error("Policy versions must have unique IDs");
    // An existing authority can always reopen for rollback using its signed
    // approval snapshots, even after an external experiment file disappears.
    const probe = new LocalPolicyService(canonical, null as unknown as HumanReviewProofStore, candidates, roots, { dev: 0, ino: 0 });
    return withMasterStorageGuard(canonical, async () => {
      let proofs: HumanReviewProofStore;
      try { proofs = await HumanReviewProofStore.openExisting(target, 2_000_000, { secret: signingSecret }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Invalid first registrations must not create new signing authority.
        await probe.registrations(true); proofs = await HumanReviewProofStore.open(target, 2_000_000, { secret: signingSecret });
      }
      const info = await lstat(proofs.root);
      const service = new LocalPolicyService(proofs.root, proofs, candidates, roots, { dev: info.dev, ino: info.ino });
      await service.read(); return service;
    });
  }

  private async assertRoot(): Promise<void> {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino ||
        (await realpath(this.root)).toLowerCase() !== this.root.toLowerCase()) throw Error("Policy authority directory changed");
  }
  private async artifact(path: string, expected: string, maxBytes: number): Promise<Buffer> {
    const canonical = await realpath(path), entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maxBytes ||
        inside(this.root, canonical) || this.writableRoots.some(root => inside(root, canonical)))
      throw Error("Policy evidence must be an independent bounded local file");
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (info.dev !== entry.dev || info.ino !== entry.ino || info.size > maxBytes) throw Error("Policy evidence changed before reading");
      const data = await file.readFile();
      if (data.length > maxBytes || bytesDigest(data) !== expected) throw Error("Policy evidence digest differs");
      return data;
    } finally { await file.close(); }
  }
  private async registrations(strict = false): Promise<Registered[]> {
    const registered: Registered[] = [];
    for (const candidate of this.candidates) {
      try {
      const bytes = await this.artifact(candidate.report.path, candidate.report.sha256, 1_500_000);
      const report = JSON.parse(bytes.toString("utf8")) as { comparisons?: PairedComparison[] };
      if (!Array.isArray(report.comparisons) || report.comparisons.length < 1 || report.comparisons.length > 100)
        throw Error("Policy comparison report invalid");
      const pairs: PairedComparison[] = [];
      for (const pair of report.comparisons) {
        const fresh = comparePair(pair.experimentId, pair.baseline, pair.candidate);
        if (JSON.stringify(pair) !== JSON.stringify(fresh)) throw Error("Policy comparison was altered");
        for (const arm of [pair.baseline, pair.candidate]) {
          const match = /^(.*)#sha256=([0-9a-f]{64})$/.exec(arm.evidenceRef);
          if (!match || !isAbsolute(match[1]) || match[2] !== arm.outputHash) throw Error("Policy output reference invalid");
          await this.artifact(match[1], match[2], 1_000_000);
        }
        pairs.push(fresh);
      }
      registered.push({ ...candidate, definitionSha256: digest(candidate), pairs, evidenceError: null });
      } catch (error) {
        if (strict) throw error;
        registered.push({ ...candidate, definitionSha256: digest(candidate), pairs: [], evidenceError: "Comparison evidence is unavailable or changed" });
      }
    }
    return registered;
  }
  private recipe(state: PolicyState, candidate: Registered, id: string, at: string): PolicyEvent[] {
    if (candidate.evidenceError) throw Error(candidate.evidenceError);
    const events: PolicyEvent[] = [];
    const add = (action: PolicyAction) => { const event = { key: `${id}:${events.length}`, at, action };
      state = reducePolicy(state, event); events.push(event); };
    add({ type: "propose", policy: candidate.policy });
    if (candidate.policy.parentId !== null) {
      const parent = state.entries.find(entry => entry.policy.id === candidate.policy.parentId)!;
      const baseline = candidate.pairs[0].baseline.profile;
      if (!parent || parent.policy.role !== candidate.policy.role || parent.policy.taskClass !== candidate.policy.taskClass ||
          parent.policy.model !== baseline.model || parent.policy.effort !== baseline.effort) throw Error("Policy baseline does not match active parent");
    }
    add({ type: "shadow", id: candidate.policy.id, evidenceRef: candidate.shadowRef });
    add({ type: "compare", id: candidate.policy.id, pairs: candidate.pairs });
    return events;
  }
  private async read() {
    await this.assertRoot();
    const receipts = [];
    for (const name of await readdir(this.root)) if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
      const receipt = await this.proofs.read(name.slice(0, -5));
      if (!receipt || receipt.action !== "operation" || receipt.data.domain !== "policy") throw Error("Unexpected policy receipt");
      receipts.push(receipt);
    }
    receipts.sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
    let state = emptyState();
    const historical = new Map<string, Registered>();
    for (let index = 0; index < receipts.length; index++) {
      const receipt = receipts[index], data = receipt.data;
      const definition = JSON.parse(data.definition) as Candidate;
      const events = JSON.parse(data.events) as PolicyEvent[];
      let candidate = historical.get(data.policyId);
      if (data.op === "approve") {
        const comparison = events.find(event => event.action.type === "compare")?.action;
        if (comparison?.type !== "compare") throw Error("Signed policy comparison missing");
        candidate = { ...definition, definitionSha256: digest(definition), pairs: comparison.pairs, evidenceError: null };
      }
      if (!candidate || digest(definition) !== candidate.definitionSha256 || candidate.policy.id !== data.policyId ||
          data.sequence !== String(index + 1) || data.previousStateSha256 !== digest(state) ||
          receipt.artifactSha256 !== candidate.definitionSha256 || receipt.verificationRef !== candidate.report.sha256 ||
          receipt.caseId !== `policy:${candidate.policy.id}` || receipt.runId !== "policy" ||
          !["approve", "activate", "rollback"].includes(data.op)) throw Error("Policy receipt chain or definition changed");
      if (!Number.isFinite(Date.parse(data.eventAt))) throw Error("Policy event time invalid");
      const expected = data.op === "approve" ? [...this.recipe(state, candidate, receipt.id, data.eventAt),
        { key: `${receipt.id}:3`, at: data.eventAt, action: { type: "approve", id: candidate.policy.id,
          approvalRef: `user:http-policy:${receipt.id}` } } as PolicyEvent] :
        [{ key: `${receipt.id}:0`, at: data.eventAt, action: data.op === "activate" ?
          { type: "activate", id: candidate.policy.id } : { type: "rollback", id: candidate.policy.id,
            reasonRef: `user:http-policy:${receipt.id}` } } as PolicyEvent];
      if (JSON.stringify(events) !== JSON.stringify(expected) || data.op === "rollback" && !data.reason?.trim())
        throw Error("Policy signed action differs");
      for (const event of events) state = reducePolicy(state, event);
      if (digest(state) !== data.nextStateSha256) throw Error("Policy resulting state differs");
      historical.set(candidate.policy.id, candidate);
    }
    const registered = await this.registrations();
    const candidates = registered.map(candidate => {
      const old = historical.get(candidate.policy.id);
      if (!old) return candidate;
      return { ...old, evidenceError: old.definitionSha256 === candidate.definitionSha256 ? candidate.evidenceError : "Registered policy definition changed" };
    });
    for (const old of historical.values()) if (!candidates.some(row => row.policy.id === old.policy.id))
      candidates.push({ ...old, evidenceError: "Registered policy definition is unavailable" });
    const snapshotSha256 = digest({ state, definitions: candidates.map(row => [row.definitionSha256, row.evidenceError]),
      registrations: registered.map(row => row.definitionSha256) });
    return { state, candidates, receipts, snapshotSha256 };
  }
  private view(current: Awaited<ReturnType<LocalPolicyService["read"]>>): PolicySnapshot {
    const items = current.candidates.map(candidate => {
      let entry = current.state.entries.find(row => row.policy.id === candidate.policy.id);
      const heldReasons: string[] = [];
      if (candidate.evidenceError) heldReasons.push(candidate.evidenceError);
      if (!entry) {
        const proposed = reducePolicy({ activeId: candidate.policy.parentId, entries: [] }, {
          key: "preview", at: "2026-10-03T00:00:00Z", action: { type: "propose", policy: candidate.policy } });
        entry = proposed.entries[0]; entry.stage = "shadow";
        try { const recipe = this.recipe(current.state, candidate, "preview", "2026-10-03T00:00:00Z");
          let preview = current.state; for (const event of recipe) preview = reducePolicy(preview, event);
          entry = preview.entries.find(row => row.policy.id === candidate.policy.id)!;
        } catch (error) { heldReasons.push((error as Error).message); }
      }
      if (entry.stage === "approved" && entry.policy.parentId !== current.state.activeId) heldReasons.push("Approved parent is no longer active");
      return { ...structuredClone(entry), title: candidate.title, comparisons: structuredClone(candidate.pairs), heldReasons,
        canApprove: entry.stage === "compared" && !heldReasons.length,
        canActivate: entry.stage === "approved" && !heldReasons.length,
        canRollback: entry.stage === "active" && entry.policy.id === current.state.activeId };
    });
    return { sha256: current.snapshotSha256, activeId: current.state.activeId, items,
      history: current.receipts.map(row => ({ id: row.id, at: row.at, op: row.data.op,
        policyId: row.data.policyId, reason: row.data.reason })) };
  }
  async list(): Promise<PolicySnapshot> {
    return withMasterStorageGuard(this.root, async () => this.view(await this.read()));
  }
  async decide(id: string, op: "approve" | "activate" | "rollback", input: {
    requestId: string; expectedSha256: string; reason?: string }): Promise<PolicySnapshot> {
    const pending = this.queue.catch(() => undefined).then(async () => {
      if (!isReviewRequestId(input.requestId) || !SHA.test(input.expectedSha256) ||
          !["approve", "activate", "rollback"].includes(op) || typeof id !== "string" ||
          input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 2000) ||
          op === "rollback" && !input.reason?.trim()) throw Error("Policy operation invalid");
      await this.assertRoot();
      return withMasterStorageGuard(this.root, async () => {
        const current = await this.read(), requestId = input.requestId.toLowerCase();
        const inputHash = digest({ id, op, expectedSha256: input.expectedSha256, reason: input.reason?.trim() ?? "" });
        const duplicate = current.receipts.find(row => row.id === requestId);
        if (duplicate) { if (duplicate.data.inputHash !== inputHash) throw Error("Policy request ID reused"); return this.view(current); }
        if (current.snapshotSha256 !== input.expectedSha256) throw Error("Policy screen version changed");
        const candidate = current.candidates.find(row => row.policy.id === id);
        if (!candidate) throw Error("Policy candidate missing");
        if (op !== "rollback" && candidate.evidenceError) throw Error(candidate.evidenceError);
        const at = new Date().toISOString();
        const events: PolicyEvent[] = op === "approve" ? [...this.recipe(current.state, candidate, requestId, at),
          { key: `${requestId}:3`, at, action: { type: "approve", id, approvalRef: `user:http-policy:${requestId}` } }] :
          [{ key: `${requestId}:0`, at, action: op === "activate" ? { type: "activate", id } :
            { type: "rollback", id, reasonRef: `user:http-policy:${requestId}` } }];
        let next = current.state; for (const event of events) next = reducePolicy(next, event);
        // The receipt timestamp is part of replay; store the fixed event timestamp
        // in data rather than assuming create() preserves its caller's time.
        await this.proofs.createCommitted({ id: requestId, action: "operation", caseId: `policy:${id}`, runId: "policy",
          artifactSha256: candidate.definitionSha256, verificationRef: candidate.report.sha256,
          data: { domain: "policy", op, policyId: id, inputHash, reason: input.reason?.trim() ?? "",
            eventAt: at, definition: JSON.stringify(canonicalDefinition(candidate)),
            sequence: String(current.receipts.length + 1), previousStateSha256: digest(current.state),
            nextStateSha256: digest(next), events: JSON.stringify(events) } });
        return this.view(await this.read());
      });
    });
    this.queue = pending; return pending;
  }
  async select(input: Parameters<ReadOnlyPolicySource["select"]>[0]): Promise<ReadOnlyPolicySelection | null> {
    return withMasterStorageGuard(this.root, async () => {
      const current = await this.read();
      const entry = current.state.entries.find(row => row.policy.id === current.state.activeId);
      if(!entry || entry.policy.taskClass !== input.taskClass || entry.policy.role !== input.role) return null;
      let root = current.candidates.find(row => row.policy.id === entry.policy.id)!;
      const active = root;
      const seen = new Set<string>();
      while (root.policy.parentId !== null) {
        if (seen.has(root.policy.id)) throw Error("Policy ancestry cycle"); seen.add(root.policy.id);
        root = current.candidates.find(row => row.policy.id === root.policy.parentId)!;
      }
      const baseline = root.pairs[0].baseline.profile;
      if (baseline.model !== input.defaultProfile.model || baseline.effort !== input.defaultProfile.effort) return null;
      if (input.holdUnavailableActive && active.evidenceError)
        throw Error("Active policy evidence unavailable; inspect or roll back the policy");
      const selected = selectReadOnlyProfile(current.state, { ...input, explicitProfile: null });
      if (!selected) {
        if(input.holdUnavailableActive)throw Error("Active policy profile is unavailable in the provider catalog");
        return null;
      }
      if (active.evidenceError) throw Error("Active policy evidence unavailable; inspect or roll back the policy");
      return { ...selected, stateSha256: current.snapshotSha256 };
    });
  }
}
