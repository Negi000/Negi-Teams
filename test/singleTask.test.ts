import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileTaskLedger, type ReconciliationVerifier, type TaskAction,
  type TaskEvent, type AcceptanceVerifier } from "../src/server/orchestration/singleTask.ts";

const contract = {
  vaultId: "NT-TASK-ONE", version: 1, sha256: "a".repeat(64), project: "negi-teams",
  objective: "Implement one bounded change", acceptance: ["targeted check passes"],
  baseSha: "b".repeat(64),
};
function event(key: string, action: TaskAction, at = "2026-09-29T12:00:00Z"): TaskEvent {
  return { key, at, action };
}
async function withLedger(run: (ledger: FileTaskLedger, path: string) => Promise<void>,
                          verifyReconciliation?: ReconciliationVerifier,
                          verifyAcceptance?: AcceptanceVerifier) {
  const dir = await mkdtemp(join(tmpdir(), "negi-task-"));
  const path = join(dir, "run.jsonl");
  try { await run(new FileTaskLedger(path, () => Date.parse("2026-09-29T12:00:00Z"),
    verifyReconciliation, verifyAcceptance), path); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("mock Astra to Sol run remains unaccepted until evidence and explicit review", async () => {
  await withLedger(async (ledger, path) => {
    let state = await ledger.append(event("create-1", { type: "create", runId: "run-1", contract }));
    assert.equal(state.status, "queued");
    state = await ledger.append(event("plan-start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    assert.equal(state.status, "planning");
    await ledger.append(event("plan-bind", { type: "bind_provider", attemptId: "a1",
      threadId: "thread-a", turnId: "turn-a" }));
    await assert.rejects(ledger.append(event("bad-usage", { type: "complete_attempt", attemptId: "a1",
      resolvedModel: "gpt-6-astra", threadId: "thread-a", turnId: "turn-a", outputRef: "mock:plan-1",
      usage: { scope: "turn", inputTokens: 10, cachedInputTokens: 20, outputTokens: 5,
        reasoningOutputTokens: 0, billing: "unknown", costUsd: null, sourceRef: "mock:bad" } })),
      /usage fields invalid/);
    state = await ledger.append(event("plan-done", { type: "complete_attempt", attemptId: "a1",
      resolvedModel: "gpt-6-astra", threadId: "thread-a", turnId: "turn-a",
      outputRef: "mock:plan-1", usage: { scope: "turn", inputTokens: 100,
        cachedInputTokens: 90, outputTokens: 10, reasoningOutputTokens: 2,
        billing: "unknown", costUsd: null, sourceRef: "mock:usage-1" } }));
    assert.equal(state.status, "ready_for_worker");
    state = await ledger.append(event("work-start", { type: "start_attempt", attemptId: "s1",
      role: "sol", requestedModel: "gpt-6-sol" }));
    await ledger.append(event("work-bind", { type: "bind_provider", attemptId: "s1",
      threadId: "thread-s", turnId: "turn-s" }));
    state = await ledger.append(event("work-done", { type: "complete_attempt", attemptId: "s1",
      resolvedModel: "gpt-6-sol", threadId: "thread-s", turnId: "turn-s",
      outputRef: "mock:patch-1" }));
    assert.equal(state.status, "verifying");
    await assert.rejects(ledger.append(event("premature-accept", { type: "accept", reviewer: "human" })),
      /verification/);
    state = await ledger.append(event("verified", { type: "verify", outcome: "passed",
      evidenceRef: "mock:check-1" }));
    assert.equal(state.status, "ready_for_review");
    assert.equal(state.acceptedBy, null);
    state = await ledger.append(event("accepted", { type: "accept", reviewer: "human:explicit" }));
    assert.equal(state.status, "accepted");
    assert.equal(state.attempts[0].requestedModel, "gpt-6-astra");
    assert.equal(state.attempts[1].resolvedModel, "gpt-6-sol");
    assert.equal(state.attempts[0].usage?.inputTokens, 100);
    assert.equal(state.attempts[1].usage, null);
    assert.equal((await ledger.read()).events.length, 9);
    await assert.rejects(new FileTaskLedger(path).read(), /trusted human acceptance unavailable/);
    await assert.rejects(new FileTaskLedger(path, Date.now, undefined,
      async () => false).read(), /trusted human acceptance rejected/);
  }, undefined, async ({ event: approval, state }) =>
    approval.action.type === "accept" && approval.action.reviewer === "human:explicit" &&
    state.status === "ready_for_review");
});

test("idempotency key and unknown provider state do not re-dispatch", async () => {
  await withLedger(async (ledger, path) => {
    const create = event("create", { type: "create", runId: "run-2", contract });
    await ledger.append(create);
    await ledger.append(create);
    assert.equal((await ledger.read()).events.length, 1);
    await assert.rejects(ledger.append(event("create", { type: "stop", reason: "changed" })),
      /idempotency/);
    await ledger.append(event("start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    const unknown = await ledger.append(event("unknown", { type: "provider_unknown",
      attemptId: "a1", reason: "stdio disconnected after request" }));
    assert.equal(unknown.status, "needs_reconciliation");
    await assert.rejects(ledger.append(event("retry", { type: "start_attempt", attemptId: "a2",
      role: "astra", requestedModel: "gpt-6-astra" })), /role or status/);
    await assert.rejects(ledger.append(event("unsafe-resume", { type: "resume" })), /reconciliation/);
    const reconciled = await ledger.append(event("reconciled", { type: "reconcile", attemptId: "a1",
      outcome: "completed", evidenceRef: "local:provider-read-1", outputRef: "local:plan-1" }));
    assert.equal(reconciled.status, "ready_for_worker");
    assert.equal((await readFile(path, "utf8")).split("\n").filter(Boolean).length, 4);
  }, async ({ event, state }) => event.action.type === "reconcile" &&
    event.action.evidenceRef === "local:provider-read-1" && state.status === "needs_reconciliation");
});

test("thread binding cannot be silently replaced before turn binding", async () => {
  await withLedger(async (ledger) => {
    await ledger.append(event("create", { type: "create", runId: "run-thread", contract }));
    await ledger.append(event("start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    await ledger.append(event("thread", { type: "bind_thread", attemptId: "a1",
      threadId: "thread-a" }));
    await assert.rejects(ledger.append(event("other-thread", { type: "bind_thread",
      attemptId: "a1", threadId: "thread-other" })), /thread identity mismatch/);
    await assert.rejects(ledger.append(event("wrong-turn-thread", { type: "bind_provider",
      attemptId: "a1", threadId: "thread-other", turnId: "turn-a" })), /identity mismatch/);
    const unknown = await ledger.append(event("unknown", { type: "provider_unknown",
      attemptId: "a1", reason: "turn start outcome unknown" }));
    assert.equal(unknown.attempts[0].threadId, "thread-a");
    assert.equal(unknown.attempts[0].turnId, null);
    assert.equal(unknown.status, "needs_reconciliation");
  });
});

test("approval is tied to attempt, thread, turn, operation, target and expiry", async () => {
  await withLedger(async (ledger) => {
    await ledger.append(event("create", { type: "create", runId: "run-3", contract }));
    await ledger.append(event("start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    await ledger.append(event("bind", { type: "bind_provider", attemptId: "a1",
      threadId: "thread-1", turnId: "turn-1" }));
    const approval = { id: "p1", attemptId: "a1", threadId: "thread-1", turnId: "turn-1",
      operation: "write", target: "src/file.ts", expiresAt: "2026-09-29T13:00:00Z" };
    await ledger.append(event("request", { type: "request_approval", approval }));
    await assert.rejects(ledger.append(event("wrong-target", { type: "decide_approval", approvalId: "p1",
      attemptId: "a1", threadId: "thread-1", turnId: "turn-1", operation: "write",
      target: "src/other.ts", decision: "allow" })), /mismatched/);
    await assert.rejects(ledger.append(event("late", { type: "decide_approval", approvalId: "p1",
      attemptId: "a1", threadId: "thread-1", turnId: "turn-1", operation: "write",
      target: "src/file.ts", decision: "allow" }, "2026-09-29T14:00:00Z")), /stale/);
    const stopped = await ledger.append(event("stop", { type: "stop", reason: "human stop" }));
    assert.equal(stopped.status, "needs_reconciliation");
    assert.equal(stopped.approvals[0].decision, "discarded");
    await assert.rejects(ledger.append(event("old-click", { type: "decide_approval", approvalId: "p1",
      attemptId: "a1", threadId: "thread-1", turnId: "turn-1", operation: "write",
      target: "src/file.ts", decision: "allow" })), /stale/);
  });
});

test("safe stop resumes checkpoint; incomplete log is not silently repaired", async () => {
  await withLedger(async (ledger, path) => {
    await ledger.append(event("create", { type: "create", runId: "run-4", contract }));
    const stopped = await ledger.append(event("stop", { type: "stop", reason: "pause" }));
    assert.equal(stopped.status, "stopped");
    assert.equal((await ledger.append(event("resume", { type: "resume" }))).status, "queued");
    await writeFile(path, (await readFile(path, "utf8")) + "{\"key\":", "utf8");
    await assert.rejects(ledger.read(), /Incomplete ledger tail/);
    await assert.rejects(ledger.append(event("next", { type: "stop", reason: "again" })),
      /Incomplete ledger tail/);
  });
});

test("a discarded provider attempt can retry only after explicit evidence", async () => {
  await withLedger(async (ledger) => {
    await ledger.append(event("create", { type: "create", runId: "run-5", contract }));
    await ledger.append(event("start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    await ledger.append(event("unknown", { type: "provider_unknown", attemptId: "a1",
      reason: "provider disconnected" }));
    await assert.rejects(ledger.append(event("no-evidence", { type: "reconcile", attemptId: "a1",
      outcome: "abandoned", evidenceRef: "" })), /evidence/);
    const state = await ledger.append(event("evidence", { type: "reconcile", attemptId: "a1",
      outcome: "abandoned", evidenceRef: "local:confirmed-no-side-effect" }));
    assert.equal(state.status, "queued");
    assert.equal(state.attempts[0].state, "abandoned");
    assert.equal((await ledger.append(event("retry", { type: "start_attempt", attemptId: "a2",
      role: "astra", requestedModel: "gpt-6-astra" }))).status, "planning");
  }, async ({ event, state }) => event.action.type === "reconcile" &&
    event.action.evidenceRef === "local:confirmed-no-side-effect" &&
    state.status === "needs_reconciliation");
});

test("reconciliation cannot be persisted without an approving trusted verifier", async () => {
  await withLedger(async (ledger, path) => {
    await ledger.append(event("create", { type: "create", runId: "run-guard", contract }));
    await ledger.append(event("start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    await ledger.append(event("unknown", { type: "provider_unknown", attemptId: "a1",
      reason: "outcome unknown" }));
    const decision = event("reconcile", { type: "reconcile", attemptId: "a1",
      outcome: "abandoned", evidenceRef: "local:review" });
    await assert.rejects(ledger.append(decision), /trusted reconciliation review unavailable/);
    const denied = new FileTaskLedger(path, Date.now, async () => false);
    await assert.rejects(denied.append(decision), /trusted reconciliation review rejected/);
    assert.equal((await ledger.read()).events.length, 3);
    assert.equal((await ledger.read()).state?.status, "needs_reconciliation");
  });
});

test("asynchronous review cannot change the event that is persisted", async () => {
  await withLedger(async (ledger, path) => {
    await ledger.append(event("create", { type: "create", runId: "run-review-snapshot", contract }));
    await ledger.append(event("start", { type: "start_attempt", attemptId: "a1",
      role: "astra", requestedModel: "gpt-6-astra" }));
    await ledger.append(event("unknown", { type: "provider_unknown", attemptId: "a1",
      reason: "outcome unknown" }));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reviewed = new FileTaskLedger(path, Date.now, async ({ event: review }) => {
      if (review.action.type !== "reconcile") return false;
      assert.equal(review.action.evidenceRef, "local:original");
      review.action.evidenceRef = "local:hook-mutation";
      enter();
      await gate;
      return true;
    });
    const decision = event("reconciled", { type: "reconcile", attemptId: "a1",
      outcome: "abandoned", evidenceRef: "local:original" });
    const pending = reviewed.append(decision);
    await entered;
    if (decision.action.type !== "reconcile") throw new Error("unexpected action");
    decision.action.evidenceRef = "local:caller-mutation";
    release();
    await pending;
    const stored = (await ledger.read()).events.at(-1)?.action;
    assert.equal(stored?.type, "reconcile");
    if (stored?.type === "reconcile") assert.equal(stored.evidenceRef, "local:original");
  });
});
