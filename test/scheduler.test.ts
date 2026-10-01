import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler, type ScheduledWork, type SchedulerAction,
  type SchedulerEvent } from "../src/server/orchestration/scheduler.ts";

function event(key: string, action: SchedulerAction): SchedulerEvent {
  return { key, at: "2026-09-30T12:00:00Z", action };
}
function work(id: string, checkout: string, overrides: Partial<ScheduledWork> = {}): ScheduledWork {
  return { id, parentId: null, dependencies: [], role: "sol", checkout,
    checkoutMode: "write", resources: [], reserveUsd: 0, ...overrides };
}
async function withScheduler(run: (scheduler: FileScheduler, path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-scheduler-"));
  const path = join(dir, "scheduler.jsonl");
  try { await run(new FileScheduler(path), path, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("global slots, dependencies and same-checkout writes are admitted centrally", async () => {
  await withScheduler(async (scheduler, _path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 2, budgetUsd: 10 }));
    await scheduler.append(event("a", { type: "submit", work: work("a", join(dir, "one")) }));
    await scheduler.append(event("b", { type: "submit", work: work("b", join(dir, "one"),
      { dependencies: ["a"], parentId: "a", role: "luna" }) }));
    await scheduler.append(event("c", { type: "submit", work: work("c", join(dir, "two")) }));
    assert.equal((await scheduler.startNext("claim-a"))?.work.id, "a");
    assert.equal((await scheduler.startNext("claim-c"))?.work.id, "c");
    assert.equal(await scheduler.startNext("no-slot"), null);
    await scheduler.append(event("a-done", { type: "settle", workId: "a", outcome: "verified",
      evidenceRef: "test:integration-a", actualCostUsd: null }));
    assert.equal((await scheduler.startNext("claim-b"))?.work.id, "b");
    assert.equal((await scheduler.read()).state?.entries.find((entry) => entry.work.id === "b")?.status,
      "running");
  });
});

test("unresolved provider outcomes keep slot and write lock across reload", async () => {
  await withScheduler(async (scheduler, path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 2, budgetUsd: 10 }));
    await scheduler.append(event("a", { type: "submit", work: work("a", join(dir, "one")) }));
    await scheduler.append(event("b", { type: "submit", work: work("b", join(dir, "one")) }));
    await scheduler.startNext("first-claim");
    await scheduler.append(event("unknown", { type: "unknown", workId: "a", reason: "provider disconnected" }));
    const reopened = new FileScheduler(path);
    assert.equal(await reopened.startNext("blocked-by-unknown"), null);
    assert.equal((await reopened.read()).state?.entries[0]?.status, "needs_reconciliation");
    await assert.rejects(reopened.append(event("premature", { type: "settle", workId: "a",
      outcome: "verified", evidenceRef: "test:wrong-route", actualCostUsd: null })),
      /matching state/);
    await reopened.append(event("reconciled", { type: "reconcile", workId: "a",
      outcome: "verified", evidenceRef: "test:provider-and-diff", actualCostUsd: null }));
    assert.equal((await reopened.startNext("second-claim"))?.work.id, "b");
    await assert.rejects(reopened.startNext("second-claim"), /claim key already used/);
  });
});

test("failed dependencies block descendants and cannot be presented as verified", async () => {
  await withScheduler(async (scheduler, _path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 3, budgetUsd: 0 }));
    await scheduler.append(event("a", { type: "submit", work: work("a", join(dir, "a")) }));
    await scheduler.append(event("b", { type: "submit", work: work("b", join(dir, "b"),
      { dependencies: ["a"] }) }));
    await scheduler.append(event("c", { type: "submit", work: work("c", join(dir, "c"),
      { dependencies: ["b"] }) }));
    await scheduler.startNext("claim-a");
    const state = await scheduler.append(event("a-failed", { type: "settle", workId: "a",
      outcome: "failed", evidenceRef: "test:failure", actualCostUsd: null }));
    assert.deepEqual(state.entries.map((entry) => entry.status), ["failed", "blocked", "blocked"]);
    assert.equal(await scheduler.startNext("nothing"), null);
    await scheduler.append(event("revalidated-a", { type: "revalidate", workId: "a", evidenceRef: "test:corrected-a" }));
    assert.deepEqual((await scheduler.read()).state?.entries.map((entry) => entry.status), ["verified", "blocked", "blocked"]);
  });
});

test("later factual defect invalidates verified integration and holds active dependents", async () => {
  await withScheduler(async (scheduler, _path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 3, budgetUsd: 0 }));
    for (const [id, dependencies] of [["luna", []], ["integration", ["luna"]],
      ["later", ["integration"]]] as const) {
      await scheduler.append(event(`submit-${id}`, { type: "submit",
        work: work(id, join(dir, id), { dependencies: [...dependencies] }) }));
    }
    await scheduler.claim("luna", "claim-luna");
    await scheduler.append(event("luna-done", { type: "settle", workId: "luna",
      outcome: "verified", evidenceRef: "artifact:luna", actualCostUsd: null }));
    await scheduler.claim("integration", "claim-integration");
    await scheduler.append(event("integration-done", { type: "settle", workId: "integration",
      outcome: "verified", evidenceRef: "artifact:integration", actualCostUsd: null }));
    await scheduler.claim("later", "claim-later");
    const state = await scheduler.append(event("audit-defect", { type: "invalidate",
      workId: "luna", evidenceRef: "source:index.ts:1221",
      reason: "model missed a visible call" }));
    assert.deepEqual(state.entries.map((entry) => entry.status),
      ["failed", "failed", "needs_reconciliation"]);
    assert.equal(state.entries[1].evidenceRef, "artifact:integration");
    await assert.rejects(scheduler.append(event("settle-later", { type: "settle",
      workId: "later", outcome: "verified", evidenceRef: "bad", actualCostUsd: null })),
    /matching state/);
  });
});

test("planning budget reserves capacity without inventing actual billing", async () => {
  await withScheduler(async (scheduler, _path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 2, budgetUsd: 3 }));
    await scheduler.append(event("a", { type: "submit", work: work("a", join(dir, "a"),
      { reserveUsd: 2 }) }));
    await scheduler.append(event("b", { type: "submit", work: work("b", join(dir, "b"),
      { reserveUsd: 2 }) }));
    await scheduler.startNext("claim-a");
    assert.equal(await scheduler.startNext("budget-full"), null);
    await scheduler.append(event("a-done", { type: "settle", workId: "a", outcome: "verified",
      evidenceRef: "test:a", actualCostUsd: 1 }));
    assert.equal((await scheduler.startNext("claim-b"))?.work.id, "b");
    const state = await scheduler.append(event("b-done", { type: "settle", workId: "b",
      outcome: "verified", evidenceRef: "test:b", actualCostUsd: null }));
    assert.equal(state.entries[1]?.actualCostUsd, null);
    await scheduler.append(event("c", { type: "submit", work: work("c", join(dir, "c"),
      { reserveUsd: 1 }) }));
    assert.equal(await scheduler.startNext("conservative-budget"), null);
  });
});

test("concurrent claim attempts cannot exceed one slot", async () => {
  await withScheduler(async (scheduler, _path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    await scheduler.append(event("a", { type: "submit", work: work("a", join(dir, "a")) }));
    await scheduler.append(event("b", { type: "submit", work: work("b", join(dir, "b")) }));
    const results = await Promise.all([scheduler.startNext("claim-1"), scheduler.startNext("claim-2")]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await scheduler.read()).state?.entries.filter((entry) => entry.status === "running").length, 1);
  });
});

test("invalid identity, resource and truncated logs fail closed", async () => {
  await withScheduler(async (scheduler, path, dir) => {
    await scheduler.append(event("config", { type: "configure", maxConcurrent: 1, budgetUsd: 0 }));
    await assert.rejects(scheduler.append(event("bad-parent", { type: "submit",
      work: work("a", join(dir, "a"), { parentId: "missing" }) })), /parent/);
    await assert.rejects(scheduler.append(event("astra-write", { type: "submit",
      work: work("a", join(dir, "a"), { role: "astra" }) })), /invalid or duplicate work/);
    await assert.rejects(scheduler.append(event("relative-checkout", { type: "submit",
      work: work("a", "relative-checkout") })), /invalid or duplicate work/);
    await assert.rejects(scheduler.append(event("bad-claims", { type: "submit",
      work: work("a", join(dir, "a"), { resources: [
        { name: "shared-db", mode: "write" }, { name: "SHARED-DB", mode: "read" }] }) })),
      /resource claims/);
    await scheduler.append(event("a", { type: "submit", work: work("a", join(dir, "a")) }));
    await scheduler.startNext("claim-a");
    await assert.rejects(scheduler.append(event("unknown-action", {
      type: "invented", workId: "a", reason: "bad" } as unknown as SchedulerAction)), /only queued/);
    await assert.rejects(scheduler.append(event("unknown-outcome", {
      type: "settle", workId: "a", outcome: "accepted", evidenceRef: "fake",
      actualCostUsd: null } as unknown as SchedulerAction)), /valid cost/);
    await assert.rejects(scheduler.append(event("a", { type: "submit", work: work("different", join(dir, "b")) })),
      /idempotency key/);
    const intact = await readFile(path, "utf8");
    await writeFile(path, intact + '{"key":"partial"', "utf8");
    await assert.rejects(scheduler.read(), /incomplete event log tail/);
    assert.equal(await readFile(path, "utf8"), intact + '{"key":"partial"');
  });
});
