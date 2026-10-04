import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileReviewChain, reduceReview, type ReviewEvent } from
  "../src/server/orchestration/reviewChain.ts";

const a = "a".repeat(64), b = "b".repeat(64);
function event(key: string, action: ReviewEvent["action"]): ReviewEvent {
  return { key, at: "2026-09-30T00:00:00Z", action };
}

test("targeted A to B correction invalidates old verification and does not imply acceptance", () => {
  let state = reduceReview(null, event("create", { type: "create", caseId: "c1",
    runId: "r1", artifact: { ref: "A.md", sha256: a, objectiveId: "map" } }));
  state = reduceReview(state, event("verify-a", { type: "verify",
    artifactSha256: a, evidenceRef: "check-a.json", outcome: "passed" }));
  state = reduceReview(state, event("praise", { type: "feedback", feedback: {
    id: "f1", source: "user", kind: "praise", targetSha256: null,
    textRef: "message:1", scope: "unspecified" } }));
  assert.equal(state.acceptance, null);
  state = reduceReview(state, event("fix", { type: "feedback", feedback: {
    id: "f2", source: "agent", kind: "correction", targetSha256: a,
    textRef: "review:wrong-attribution", scope: "current_task" } }));
  state = reduceReview(state, event("revise", { type: "revise", fromSha256: a,
    artifact: { ref: "B.md", sha256: b, objectiveId: "map" },
    feedbackIds: ["f2"], sameObjective: true }));
  assert.equal(state.verification, null);
  assert.equal(state.acceptance, null);
  assert.equal(state.revisions[0].sameObjective, true);
  assert.throws(() => reduceReview(state, event("accept-old", { type: "accept",
    artifactSha256: a, approvalRef: "user:1" })), /latest verification/);
});

test("file chain requires an authenticated approval callback and keeps revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-review-test-"));
  try {
    const path = join(dir, "review.jsonl");
    const chain = new FileReviewChain(path);
    await chain.append(event("create", { type: "create", caseId: "c1",
      runId: "r1", artifact: { ref: "A.md", sha256: a, objectiveId: "map" } }));
    await chain.append(event("verify", { type: "verify", artifactSha256: a,
      evidenceRef: "verification.json", outcome: "passed" }));
    await assert.rejects(chain.append(event("accept", { type: "accept",
      artifactSha256: a, approvalRef: "user:review-1" })), /verifier unavailable/);
    assert.equal((await chain.read()).state?.acceptance, null);
    const trusted = new FileReviewChain(path, async ({ event: incoming }) =>
      (incoming.action.type === "accept" && incoming.action.approvalRef === "user:review-1") ||
      (incoming.action.type === "revoke" && incoming.action.reasonRef === "user:withdraw-2"));
    await trusted.append(event("accept", { type: "accept", artifactSha256: a,
      approvalRef: "user:review-1" }));
    assert.equal((await trusted.read()).state?.acceptance?.artifactSha256, a);
    await assert.rejects(chain.read(), /trusted approval verifier unavailable/);
    const wrongVerifier = new FileReviewChain(path, async () => false);
    await assert.rejects(wrongVerifier.read(), /trusted approval rejected/);
    await trusted.append(event("revoke", { type: "revoke", reasonRef: "user:withdraw-2" }));
    assert.equal((await trusted.read()).state?.revoked?.reasonRef, "user:withdraw-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
