// Explicitly registered local review cases; no arbitrary file paths come from HTTP.
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { HumanReviewProofStore, type HumanReviewReceipt } from "./humanReviewProof.ts";
import { FileReviewChain, type ReviewEvent, type ReviewFeedback, type ReviewState } from "./reviewChain.ts";

export interface RegisteredReviewCase {
  id: string;
  title: string;
  ledgerPath: string;
  artifactRoot: string;
  verifiedArtifactSha256: string;
  evidencePath: string;
  evidenceSha256: string;
  verificationSummary: string;
  limits: string;
}
export interface ReviewServiceConfig {
  storageRoot: string;
  writableRoots: string[];
  cases: RegisteredReviewCase[];
}
export interface ReviewCaseView {
  id: string;
  title: string;
  runId: string;
  objectiveId: string;
  artifactSha256: string;
  previousSha256: string | null;
  content: string;
  verificationSummary: string;
  limits: string;
  integrityError: string | null;
  status: "awaiting_review" | "accepted" | "revoked";
  canAccept: boolean;
  qualityIssue: boolean;
  feedback: Array<{ id: string; kind: ReviewFeedback["kind"]; scope: ReviewFeedback["scope"];
    targetSha256: string | null; text: string | null; authenticated: boolean; source: ReviewFeedback["source"] }>;
}

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") &&
    !rel.startsWith("..\\") && !isAbsolute(rel));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review config object required");
  return value as Record<string, unknown>;
}
function string(row: Record<string, unknown>, key: string, max: number): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Review ${key} invalid`);
  return value;
}
function path(row: Record<string, unknown>, key: string): string {
  const value = string(row, key, 2048);
  if (!isAbsolute(value)) throw new Error(`Review ${key} must be absolute`);
  return resolve(value);
}
function sha(row: Record<string, unknown>, key: string): string {
  const value = string(row, key, 64);
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`Review ${key} must be SHA-256`);
  return value.toLowerCase();
}
export function parseReviewServiceConfig(value: unknown): ReviewServiceConfig {
  const row = object(value);
  if (!Array.isArray(row.writableRoots) || row.writableRoots.length > 100 ||
      !Array.isArray(row.cases) || row.cases.length > 100)
    throw new Error("Review roots/cases invalid");
  const writableRoots = row.writableRoots.map((root) => path({ root }, "root"));
  const cases = row.cases.map((entry) => {
    const item = object(entry);
    const id = string(item, "id", 100);
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Review case ID invalid");
    return { id, title: string(item, "title", 200), ledgerPath: path(item, "ledgerPath"),
      artifactRoot: path(item, "artifactRoot"), verifiedArtifactSha256: sha(item, "verifiedArtifactSha256"),
      evidencePath: path(item, "evidencePath"), evidenceSha256: sha(item, "evidenceSha256"),
      verificationSummary: string(item, "verificationSummary", 4000), limits: string(item, "limits", 4000) };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("Review case IDs repeated");
  return { storageRoot: path(row, "storageRoot"), writableRoots, cases };
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximum)
    throw new Error("Registered review file is unavailable or exceeds its limit");
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error("Registered review file grew beyond its limit");
  return bytes;
}
function receiptRef(id: string): string { return `user:http-review:${id}`; }
function receiptId(ref: string): string | null {
  return ref.match(/^user:http-review:([0-9a-f-]{36})$/i)?.[1].toLowerCase() ?? null;
}
function pendingAgentCorrection(state: ReviewState): boolean {
  const latest = state.artifacts.at(-1)!;
  return state.feedback.some((item) => item.source === "agent" && item.kind === "correction" &&
    item.targetSha256 === latest.sha256);
}

export class LocalReviewService {
  private readonly currentChecks = new Map<string, () => Promise<void>>();
  private readonly registrations = new Map<string, Promise<void>>();
  private constructor(private readonly config: ReviewServiceConfig,
                      private readonly proofs: HumanReviewProofStore) {}

  static async open(raw: unknown): Promise<LocalReviewService> {
    const config = parseReviewServiceConfig(raw);
    const writableRoots = await Promise.all(config.writableRoots.map((root) => realpath(root)));
    let storage: string;
    try {
      if ((await lstat(config.storageRoot)).isSymbolicLink()) throw new Error("Review storage cannot be a symlink");
      storage = await realpath(config.storageRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      storage = join(await realpath(dirname(config.storageRoot)), basename(config.storageRoot));
    }
    for (const item of config.cases) {
      item.artifactRoot = await realpath(item.artifactRoot);
      item.ledgerPath = await realpath(item.ledgerPath);
      item.evidencePath = await realpath(item.evidencePath);
      if (inside(item.artifactRoot, storage) ||
          writableRoots.some((root) => inside(root, storage) || inside(root, item.ledgerPath)))
        throw new Error("Review state must be outside registered model writable roots and artifacts");
    }
    const proofs = await HumanReviewProofStore.open(config.storageRoot);
    if (new Set(config.cases.map((item) => item.ledgerPath.toLowerCase())).size !== config.cases.length)
      throw new Error("Review ledgers cannot be registered under multiple cases");
    if (config.cases.some((item) => inside(item.artifactRoot, proofs.root)) ||
        writableRoots.some((root) => inside(root, proofs.root)))
      throw new Error("Review storage resolved inside a model writable root");
    const service = new LocalReviewService(config, proofs);
    await mkdir(join(proofs.root, "artifacts"), { recursive: true });
    const artifactDirectory = await lstat(join(proofs.root, "artifacts"));
    if (!artifactDirectory.isDirectory() || artifactDirectory.isSymbolicLink())
      throw new Error("Review preview directory has an unsafe type");
    for (const item of config.cases) {
      const state = (await service.chain(item).read()).state;
      if (!state || state.caseId !== item.id) throw new Error("Registered review case does not match its ledger");
      // A known content issue can remain visible after restart, with acceptance held.
      await service.checkCurrent(item, state, true);
      const latest = state.artifacts.at(-1)!;
      const bytes = await service.artifactBytes(item, latest.ref);
      if (hash(bytes) !== item.verifiedArtifactSha256) throw new Error("Review artifact changed during registration");
      const frozen = service.frozenPath(item);
      try {
        const file = await open(frozen, "wx", 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (hash(await boundedFile(frozen, 100_000)) !== item.verifiedArtifactSha256)
        throw new Error("Stored review artifact hash differs from registered version");
    }
    return service;
  }

  list(): Array<{ id: string; title: string }> {
    return this.config.cases.map(({ id, title }) => ({ id, title }));
  }
  /** Local server registration only. HTTP cannot register file paths. */
  async registerCase(item: RegisteredReviewCase): Promise<void> {
    const pending = this.registrations.get(item.id);
    if (pending) { await pending; return this.registerCase(item); }
    const operation = this.registerCaseOnce(item);
    this.registrations.set(item.id, operation);
    try { await operation; } finally { this.registrations.delete(item.id); }
  }
  private async registerCaseOnce(item: RegisteredReviewCase): Promise<void> {
    const existing = this.config.cases.find((entry) => entry.id === item.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(item)) throw new Error("Review case ID was reused");
      return;
    }
    const checked = await LocalReviewService.open({ ...this.config, cases: [item] });
    if (this.config.cases.some((entry) => entry.ledgerPath.toLowerCase() === checked.config.cases[0].ledgerPath.toLowerCase()))
      throw new Error("Review ledger already registered");
    this.config.cases.push(checked.config.cases[0]);
  }
  async registerWritableRoots(raw: string[]): Promise<void> {
    const roots = await Promise.all(raw.map((root) => realpath(root)));
    if (roots.some((root) => inside(root, this.proofs.root) ||
        this.config.cases.some((item) => inside(root, item.ledgerPath))))
      throw new Error("Review state overlaps a Task writable checkout");
    this.config.writableRoots = [...new Set([...this.config.writableRoots, ...roots])];
  }
  /** Server-local replacement after a same-objective revision and new verification. */
  async registerRevision(previousSha256: string, item: RegisteredReviewCase): Promise<void> {
    const existing = this.config.cases.find((entry) => entry.id === item.id);
    if (!existing) { await this.registerCase(item); return; }
    if (JSON.stringify(existing) === JSON.stringify(item)) return;
    if (existing.verifiedArtifactSha256 !== previousSha256 || existing.ledgerPath !== item.ledgerPath ||
        existing.artifactRoot !== item.artifactRoot || existing.title !== item.title)
      throw new Error("Review revision does not match the previous registered case");
    const state = (await this.chain(item).read()).state;
    if (!state || state.acceptance || state.revoked || !state.revisions.some((revision) =>
      revision.fromSha256 === previousSha256 && revision.toSha256 === item.verifiedArtifactSha256 && revision.sameObjective))
      throw new Error("Review replacement requires a linked, unaccepted same-objective revision");
    const checked = await LocalReviewService.open({ ...this.config, cases: [item] });
    this.config.cases[this.config.cases.indexOf(existing)] = checked.config.cases[0];
    this.currentChecks.delete(item.id);
  }
  bindCurrentCheck(id: string, check: () => Promise<void>): void {
    this.registered(id);
    this.currentChecks.set(id, check);
  }
  async readState(id: string): Promise<ReviewState> {
    const state = (await this.chain(this.registered(id)).read()).state;
    if (!state) throw new Error("Review case has no state");
    return state;
  }
  /** Local Task journal replay can inspect the next pinned case before registering it. */
  async readCandidateState(item: RegisteredReviewCase): Promise<ReviewState> {
    const state = (await this.chain(item).read()).state;
    if (!state || state.caseId !== item.id) throw new Error("Candidate review state differs from its registered identity");
    return state;
  }
  async receipt(ref: string): Promise<HumanReviewReceipt | null> {
    const id = receiptId(ref);
    return id ? this.proofs.read(id) : null;
  }
  private registered(id: string): RegisteredReviewCase {
    const item = this.config.cases.find((entry) => entry.id === id);
    if (!item) throw new Error("Review case is not registered");
    return item;
  }
  private frozenPath(item: RegisteredReviewCase): string {
    return join(this.proofs.root, "artifacts", `${item.verifiedArtifactSha256}.md`);
  }
  private chain(item: RegisteredReviewCase): FileReviewChain {
    return new FileReviewChain(item.ledgerPath, ({ event, state }) => this.verifyAcceptance(item, event, state));
  }
  private async artifactBytes(item: RegisteredReviewCase, ref: string): Promise<Buffer> {
    if (!isAbsolute(ref)) throw new Error("Review artifact path must be registered locally");
    const actual = await realpath(ref);
    if (!inside(item.artifactRoot, actual)) throw new Error("Review artifact escaped its registered root");
    return boundedFile(actual, 100_000);
  }
  private async checkCurrent(item: RegisteredReviewCase, state: ReviewState, allowQualityIssue = false): Promise<void> {
    const latest = state.artifacts.at(-1)!;
    if (state.caseId !== item.id || latest.sha256 !== item.verifiedArtifactSha256 ||
        state.verification?.artifactSha256 !== latest.sha256 || state.verification.outcome !== "passed" ||
        !isAbsolute(state.verification.evidenceRef) ||
        await realpath(state.verification.evidenceRef) !== item.evidencePath)
      throw new Error("成果の版または検証根拠が登録時から変わっています。再検証が必要です。");
    if (hash(await this.artifactBytes(item, latest.ref)) !== latest.sha256 ||
        hash(await boundedFile(item.evidencePath, 2_000_000)) !== item.evidenceSha256)
      throw new Error("成果または検証根拠の内容が更新されています。再検証が必要です。");
    await this.currentChecks.get(item.id)?.();
    if (!allowQualityIssue && pendingAgentCorrection(state))
      throw new Error("この版には未修正の訂正指摘があります。指摘と修正版を確認してから受け入れてください。");
  }
  private async verifyAcceptance(item: RegisteredReviewCase, event: ReviewEvent, state: ReviewState): Promise<boolean> {
    if (event.action.type !== "accept" && event.action.type !== "revoke") return false;
    if (event.action.type === "accept" && pendingAgentCorrection(state)) return false;
    const ref = event.action.type === "accept" ? event.action.approvalRef : event.action.reasonRef;
    const id = receiptId(ref);
    if (!id) return false;
    const receipt = await this.proofs.read(id);
    if (event.action.type === "revoke") return Boolean(receipt && receipt.action === "revoke" &&
      receipt.caseId === state.caseId && receipt.runId === state.runId && receipt.at === event.at &&
      receipt.artifactSha256 === state.acceptance?.artifactSha256 && receipt.data.reason?.trim() &&
      event.key === `http-review:${id}:revoke`);
    return Boolean(receipt && receipt.action === "accept" && receipt.caseId === state.caseId &&
      receipt.runId === state.runId && receipt.artifactSha256 === event.action.artifactSha256 &&
      receipt.artifactSha256 === item.verifiedArtifactSha256 && receipt.at === event.at &&
      event.key === `http-review:${id}:accept` && receipt.verificationRef === state.verification?.evidenceRef &&
      receipt.data.evidenceSha256 === item.evidenceSha256);
  }
  private async feedbackView(feedback: ReviewFeedback, item: RegisteredReviewCase, runId: string) {
    const id = receiptId(feedback.textRef);
    const receipt = id ? await this.proofs.read(id) : null;
    const authenticated = Boolean(receipt && receipt.action === "feedback" && receipt.caseId === item.id &&
      receipt.runId === runId && receipt.artifactSha256 === feedback.targetSha256 &&
      receipt.data.kind === feedback.kind && receipt.data.scope === feedback.scope &&
      feedback.source === "user" && feedback.id === `http-feedback:${id}`);
    let text: string | null = authenticated ? receipt!.data.text : null;
    if (feedback.source === "agent") {
      const ref = feedback.textRef.match(/^local-agent:(.+)#sha256=([0-9a-f]{64})$/i);
      if (ref && isAbsolute(ref[1])) {
        try {
          const actual = await realpath(ref[1]);
          if (inside(item.artifactRoot, actual)) {
            const bytes = await boundedFile(actual, 12_000);
            if (hash(bytes) === ref[2]) text = bytes.toString("utf8");
          }
        } catch { /* Unavailable agent notes do not become authenticated human feedback. */ }
      }
    }
    return { id: feedback.id, kind: feedback.kind, scope: feedback.scope, source: feedback.source,
      targetSha256: feedback.targetSha256,
      text, authenticated };
  }

  async snapshot(id: string): Promise<ReviewCaseView> {
    const item = this.registered(id);
    const state = (await this.chain(item).read()).state;
    if (!state) throw new Error("Review ledger is empty");
    let integrityError: string | null = null;
    try { await this.checkCurrent(item, state, true); }
    catch { integrityError = "成果の版・内容または検証根拠が更新されています。再検証が必要です。"; }
    if (!integrityError && pendingAgentCorrection(state))
      integrityError = "この版には未修正の訂正指摘があります。原文と機械検証は保存されています。修正版と再検証を確認してから受け入れてください。";
    const bytes = await boundedFile(this.frozenPath(item), 100_000);
    if (hash(bytes) !== item.verifiedArtifactSha256) throw new Error("Review preview hash is invalid");
    return { id: item.id, title: item.title, runId: state.runId,
      objectiveId: state.artifacts.at(-1)!.objectiveId,
      artifactSha256: item.verifiedArtifactSha256,
      previousSha256: state.artifacts.length > 1 ? state.artifacts.at(-2)!.sha256 : null,
      content: bytes.toString("utf8"), verificationSummary: item.verificationSummary,
      limits: item.limits, integrityError,
      status: state.revoked ? "revoked" : state.acceptance ? "accepted" : "awaiting_review",
      canAccept: !integrityError && state.acceptance === null && state.revoked === null,
      qualityIssue: pendingAgentCorrection(state),
      feedback: await Promise.all(state.feedback.map((feedback) => this.feedbackView(feedback, item, state.runId))) };
  }

  async accept(id: string, artifactSha256: string, requestId: string): Promise<ReviewCaseView> {
    const item = this.registered(id);
    const ledger = this.chain(item);
    const state = (await ledger.read()).state;
    if (!state || state.revoked || artifactSha256 !== item.verifiedArtifactSha256)
      throw new Error("受入対象の版が一致しません。画面を更新してください。");
    await this.checkCurrent(item, state);
    const receipt = await this.proofs.create({ id: requestId, action: "accept", caseId: id,
      runId: state.runId, artifactSha256, verificationRef: state.verification!.evidenceRef,
      data: { evidenceSha256: item.evidenceSha256 } });
    await ledger.append({ key: `http-review:${receipt.id}:accept`, at: receipt.at,
      action: { type: "accept", artifactSha256, approvalRef: receiptRef(receipt.id) } });
    return this.snapshot(id);
  }

  async feedback(id: string, input: { artifactSha256: string; requestId: string;
    text: string; kind: ReviewFeedback["kind"]; scope: ReviewFeedback["scope"] }): Promise<ReviewCaseView> {
    const item = this.registered(id);
    const ledger = this.chain(item);
    const state = (await ledger.read()).state;
    if (!state || input.artifactSha256 !== item.verifiedArtifactSha256 ||
        !input.text.trim() || input.text.length > 6000 ||
        !["praise", "correction", "new_requirement", "unclear"].includes(input.kind) ||
        !["current_task", "future_preference", "unspecified"].includes(input.scope))
      throw new Error("指摘の対象または内容が不正です。");
    const receipt = await this.proofs.create({ id: input.requestId, action: "feedback", caseId: id,
      runId: state.runId, artifactSha256: input.artifactSha256, verificationRef: null,
      data: { text: input.text.trim(), kind: input.kind, scope: input.scope } });
    await ledger.append({ key: `http-review:${receipt.id}:feedback`, at: receipt.at,
      action: { type: "feedback", feedback: { id: `http-feedback:${receipt.id}`, source: "user",
        kind: input.kind, scope: input.scope, targetSha256: input.artifactSha256,
        textRef: receiptRef(receipt.id) } } });
    return this.snapshot(id);
  }

  async revoke(id: string, artifactSha256: string, requestId: string, reason: string): Promise<ReviewCaseView> {
    const item = this.registered(id);
    const ledger = this.chain(item);
    const state = (await ledger.read()).state;
    if (!state?.acceptance || state.acceptance.artifactSha256 !== artifactSha256 ||
        !reason.trim() || reason.length > 2000) throw new Error("受入取消には対象の版と理由が必要です。");
    const receipt: HumanReviewReceipt = await this.proofs.create({ id: requestId, action: "revoke",
      caseId: id, runId: state.runId, artifactSha256, verificationRef: null, data: { reason: reason.trim() } });
    await ledger.append({ key: `http-review:${receipt.id}:revoke`, at: receipt.at,
      action: { type: "revoke", reasonRef: receiptRef(receipt.id) } });
    return this.snapshot(id);
  }
}
