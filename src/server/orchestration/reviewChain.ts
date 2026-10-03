// Keeps artifact revisions, feedback, verification and human acceptance distinct.
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ReviewArtifact { ref: string; sha256: string; objectiveId: string }
export interface ReviewFeedback {
  id: string;
  source: "user" | "agent";
  kind: "praise" | "correction" | "new_requirement" | "unclear";
  targetSha256: string | null;
  textRef: string;
  scope: "current_task" | "future_preference" | "unspecified";
}
export interface ReviewState {
  caseId: string;
  runId: string;
  artifacts: ReviewArtifact[];
  feedback: ReviewFeedback[];
  revisions: Array<{ fromSha256: string; toSha256: string;
    feedbackIds: string[]; sameObjective: boolean }>;
  verification: { artifactSha256: string; evidenceRef: string;
    outcome: "passed" | "failed" } | null;
  acceptance: { artifactSha256: string; approvalRef: string } | null;
  revoked: { reasonRef: string } | null;
}
export type ReviewAction =
  | { type: "create"; caseId: string; runId: string; artifact: ReviewArtifact }
  | { type: "feedback"; feedback: ReviewFeedback }
  | { type: "revise"; artifact: ReviewArtifact; fromSha256: string;
      feedbackIds: string[]; sameObjective: boolean }
  | { type: "verify"; artifactSha256: string; evidenceRef: string;
      outcome: "passed" | "failed" }
  | { type: "accept"; artifactSha256: string; approvalRef: string }
  | { type: "revoke"; reasonRef: string };
export interface ReviewEvent { key: string; at: string; action: ReviewAction }

function requireReview(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`Review transition rejected: ${reason}`);
}
function hash(value: string): boolean { return /^[a-f0-9]{64}$/i.test(value); }
function artifact(value: ReviewArtifact): boolean {
  return Boolean(value.ref && value.objectiveId && hash(value.sha256));
}
function latest(state: ReviewState): ReviewArtifact {
  return state.artifacts[state.artifacts.length - 1];
}

export function reduceReview(state: ReviewState | null, event: ReviewEvent): ReviewState {
  requireReview(Boolean(event.key) && Number.isFinite(Date.parse(event.at)), "event identity invalid");
  const action = event.action;
  if (action.type === "create") {
    requireReview(state === null && Boolean(action.caseId) && Boolean(action.runId) &&
      artifact(action.artifact), "invalid or duplicate case");
    return { caseId: action.caseId, runId: action.runId,
      artifacts: [structuredClone(action.artifact)], feedback: [], revisions: [],
      verification: null, acceptance: null, revoked: null };
  }
  requireReview(state !== null, "create first");
  const next = structuredClone(state);
  if (action.type === "feedback") {
    const f = action.feedback;
    requireReview(Boolean(f.id && f.textRef) &&
      ["user", "agent"].includes(f.source) &&
      ["praise", "correction", "new_requirement", "unclear"].includes(f.kind) &&
      ["current_task", "future_preference", "unspecified"].includes(f.scope) &&
      !next.feedback.some((item) => item.id === f.id) &&
      (f.targetSha256 === null || next.artifacts.some((item) =>
        item.sha256 === f.targetSha256)), "feedback identity or target invalid");
    next.feedback.push(structuredClone(f));
    return next;
  }
  if (action.type === "revise") {
    requireReview(next.acceptance === null && next.revoked === null &&
      artifact(action.artifact) && action.fromSha256 === latest(next).sha256 &&
      action.artifact.sha256 !== action.fromSha256 &&
      action.feedbackIds.length > 0 &&
      new Set(action.feedbackIds).size === action.feedbackIds.length &&
      action.feedbackIds.every((id) => next.feedback.some((item) =>
        item.id === id && item.kind === "correction" &&
        item.targetSha256 === action.fromSha256)) &&
      !next.artifacts.some((item) => item.sha256 === action.artifact.sha256) &&
      (action.sameObjective
        ? action.artifact.objectiveId === latest(next).objectiveId
        : action.artifact.objectiveId !== latest(next).objectiveId),
    "revision lacks a targeted correction or valid objective relation");
    next.revisions.push({ fromSha256: action.fromSha256,
      toSha256: action.artifact.sha256,
      feedbackIds: [...action.feedbackIds], sameObjective: action.sameObjective });
    next.artifacts.push(structuredClone(action.artifact));
    next.verification = null;
    return next;
  }
  if (action.type === "verify") {
    requireReview(next.acceptance === null && next.revoked === null &&
      action.artifactSha256 === latest(next).sha256 &&
      Boolean(action.evidenceRef) && ["passed", "failed"].includes(action.outcome),
    "verification must match latest artifact and evidence");
    next.verification = { artifactSha256: action.artifactSha256,
      evidenceRef: action.evidenceRef, outcome: action.outcome };
    return next;
  }
  if (action.type === "accept") {
    requireReview(next.acceptance === null && next.revoked === null &&
      action.artifactSha256 === latest(next).sha256 &&
      next.verification?.artifactSha256 === action.artifactSha256 &&
      next.verification.outcome === "passed" &&
      /^user:[^\s]+$/.test(action.approvalRef),
    "human approval reference and passing latest verification required");
    next.acceptance = { artifactSha256: action.artifactSha256,
      approvalRef: action.approvalRef };
    return next;
  }
  requireReview(action.type === "revoke" && next.acceptance !== null &&
    next.revoked === null && Boolean(action.reasonRef), "revoke requires accepted case and reason");
  next.revoked = { reasonRef: action.reasonRef };
  return next;
}

export type ApprovalVerifier = (input: { event: ReviewEvent;
  state: ReviewState }) => Promise<boolean>;

/** Local append-only record. Acceptance requires a trusted external approval verifier. */
export class FileReviewChain {
  readonly path: string;
  constructor(path: string, private readonly verifyApproval?: ApprovalVerifier) {
    this.path = resolve(path);
  }
  async read(): Promise<{ state: ReviewState | null; events: ReviewEvent[] }> {
    let data: string;
    try { data = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { state: null, events: [] };
      throw error;
    }
    requireReview(!data || data.endsWith("\n"), "incomplete log tail");
    let state: ReviewState | null = null;
    const events: ReviewEvent[] = [];
    const keys = new Set<string>();
    for (const line of data.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as ReviewEvent;
      requireReview(!keys.has(event.key), "duplicate event key");
      keys.add(event.key);
      const next = reduceReview(state, event);
      if (event.action.type === "accept" || event.action.type === "revoke") {
        requireReview(Boolean(this.verifyApproval) && state !== null,
          "trusted approval verifier unavailable");
        requireReview(await this.verifyApproval!({ event,
          state: structuredClone(state!) }), "trusted approval rejected");
      }
      state = next;
      events.push(event);
    }
    return { state, events };
  }
  async append(event: ReviewEvent): Promise<ReviewState> {
    const pinned = structuredClone(event);
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const lock = await open(lockPath, "wx");
    try {
      const current = await this.read();
      const duplicate = current.events.find((item) => item.key === pinned.key);
      if (duplicate) {
        requireReview(JSON.stringify(duplicate.action) === JSON.stringify(pinned.action),
          "idempotency key reused");
        return current.state!;
      }
      const next = reduceReview(current.state, pinned);
      if (pinned.action.type === "accept" || pinned.action.type === "revoke") {
        requireReview(Boolean(this.verifyApproval), "trusted approval verifier unavailable");
        requireReview(await this.verifyApproval!({ event: pinned,
          state: structuredClone(current.state!) }), "trusted approval rejected");
      }
      const file = await open(this.path, "a");
      try { await file.writeFile(JSON.stringify(pinned) + "\n", "utf8");
        await file.sync(); }
      finally { await file.close(); }
      return next;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
