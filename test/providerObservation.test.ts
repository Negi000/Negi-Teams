import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CodexProviderTurnInspection } from "../src/server/master/appServerClient.ts";
import { FileTaskLedger, type TaskAction } from "../src/server/orchestration/singleTask.ts";
import { recordUnknownProviderTurn } from "../src/server/orchestration/providerObservation.ts";

const contract = { vaultId: "NT-TASK-OBSERVE", version: 1, sha256: "a".repeat(64),
  project: "negi-teams", objective: "Observe one attempt", acceptance: ["review evidence"],
  baseSha: "b".repeat(40) };

async function setup(bound: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "negi-provider-observation-"));
  const ledger = new FileTaskLedger(join(dir, "run.jsonl"));
  const append = (key: string, action: TaskAction) => ledger.append({ key,
    at: "2026-09-30T00:00:00Z", action });
  await append("create", { type: "create", runId: "run-observe", contract });
  await append("start", { type: "start_attempt", attemptId: "attempt-a",
    role: "astra", requestedModel: "gpt-6-astra" });
  if (bound) await append("bind", { type: "bind_provider", attemptId: "attempt-a",
    threadId: "thread-a", turnId: "turn-a" });
  await append("unknown", { type: "provider_unknown", attemptId: "attempt-a",
    reason: "provider connection lost" });
  return { dir, ledger };
}

test("provider observation is bound and durable but does not reconcile a run", async () => {
  const { dir, ledger } = await setup(true);
  try {
    let calls = 0;
    const client = { async inspectProviderTurn(threadId: string, turnId: string):
        Promise<CodexProviderTurnInspection> {
      calls++;
      assert.deepEqual([threadId, turnId], ["thread-a", "turn-a"]);
      return { threadId, turnId, found: true, status: "completed", pagesRead: 2,
        completeSearch: true, observedAtMs: 1000, source: "thread/turns/list" };
    } };
    const state = await recordUnknownProviderTurn(ledger, "attempt-a", client, "observation-1");
    assert.equal(calls, 1);
    assert.equal(state.status, "needs_reconciliation");
    assert.deepEqual(state.providerObservations, [{ attemptId: "attempt-a", inspection: {
      threadId: "thread-a", turnId: "turn-a", found: true, status: "completed",
      pagesRead: 2, completeSearch: true, observedAtMs: 1000,
      source: "thread/turns/list" } }]);
    assert.deepEqual((await ledger.read()).state?.providerObservations, state.providerObservations);
    await assert.rejects(ledger.append({ key: "retry", at: "2026-09-30T00:00:01Z",
      action: { type: "start_attempt", attemptId: "attempt-b", role: "astra",
        requestedModel: "gpt-6-astra" } }), /role or status/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown or mismatched provider identity never records a reassuring observation", async () => {
  const unbound = await setup(false);
  try {
    let called = false;
    const client = { async inspectProviderTurn(): Promise<CodexProviderTurnInspection> {
      called = true;
      throw new Error("must not be called");
    } };
    await assert.rejects(recordUnknownProviderTurn(unbound.ledger, "attempt-a", client, "obs"),
      /bound unknown attempt/);
    assert.equal(called, false);
  } finally { await rm(unbound.dir, { recursive: true, force: true }); }

  const mismatched = await setup(true);
  try {
    const client = { async inspectProviderTurn(): Promise<CodexProviderTurnInspection> {
      return { threadId: "other", turnId: "turn-a", found: true, status: "completed",
        pagesRead: 1, completeSearch: true, observedAtMs: 1000,
        source: "thread/turns/list" };
    } };
    await assert.rejects(recordUnknownProviderTurn(mismatched.ledger, "attempt-a", client, "obs"),
      /identity mismatch/);
    const malformed = { async inspectProviderTurn(): Promise<CodexProviderTurnInspection> {
      return { threadId: "thread-a", turnId: "turn-a", found: true, status: null,
        pagesRead: 1, completeSearch: true, observedAtMs: 1000,
        source: "thread/turns/list" };
    } };
    await assert.rejects(recordUnknownProviderTurn(mismatched.ledger, "attempt-a", malformed,
      "bad-status"), /observation identity or status invalid/);
    assert.equal((await mismatched.ledger.read()).state?.providerObservations.length, 0);
  } finally { await rm(mismatched.dir, { recursive: true, force: true }); }
});
