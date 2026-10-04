import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { comparePair, type ComparisonArm } from
  "../src/server/orchestration/comparison.ts";
import { FilePolicyLedger, reducePolicy, selectReadOnlyProfile,
  type PolicyAction, type PolicyEvent, type PolicyState } from
  "../src/server/orchestration/policy.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function arm(label: "baseline" | "candidate", caseId: string,
             changes: Partial<ComparisonArm> = {}): ComparisonArm {
  return { label, profile: { model: "gpt-6-luna",
    effort: label === "baseline" ? "medium" : "low" },
    checkout: `C:/trial/${caseId}/${label}`, baseSha: digest("base"),
    objectiveHash: digest(`objective-${caseId}`), acceptanceHash: digest("acceptance"),
    toolsHash: digest("tools"), evaluatorVersion: "code-audit-v1",
    outputHash: digest(`${caseId}-${label}`), quality: "passed",
    evidenceRef: `local:${caseId}/${label}`, elapsedMs: label === "baseline" ? 100 : 70,
    inputTokens: label === "baseline" ? 1000 : 900,
    outputTokens: 20, apiCostUsd: null, ...changes };
}
function pair(caseId: string, candidate: Partial<ComparisonArm> = {}) {
  return comparePair(caseId, arm("baseline", caseId), arm("candidate", caseId, candidate));
}
function event(key: string, action: PolicyAction): PolicyEvent {
  return { key, at: "2026-09-30T00:00:00Z", action };
}
const policy = { id: "low-read-v1", parentId: null,
  taskClass: "read_only_research" as const, role: "luna" as const,
  model: "gpt-6-luna", effort: "low", metric: "elapsed_ms" as const,
  sourceRefs: ["local:experiment-plan-v1"] };

test("paired comparison refuses mismatched conditions and quality false negatives", () => {
  const same = pair("one");
  assert.equal(same.comparable, true);
  assert.equal(same.candidateEligible, true);
  assert.equal(same.delta.elapsedMs, -30);
  assert.equal(same.delta.apiCostUsd, null);
  const mismatch = pair("two", { toolsHash: digest("different-tools") });
  assert.equal(mismatch.comparable, false);
  assert.equal(mismatch.candidateEligible, false);
  const modelMismatch = pair("two-models", { profile: { model: "gpt-6.1-sol", effort: "low" } });
  assert.equal(modelMismatch.comparable, false);
  const falseNegative = pair("three", { quality: "failed" });
  assert.equal(falseNegative.candidateEligible, false);
  let state: PolicyState | null = null;
  state = reducePolicy(state, event("propose", { type: "propose", policy }));
  state = reducePolicy(state, event("shadow", { type: "shadow", id: policy.id,
    evidenceRef: "local:shadow-observation" }));
  assert.throws(() => reducePolicy(state, event("compare", { type: "compare",
    id: policy.id, pairs: [same, falseNegative] })), /quality failed/);
  assert.throws(() => reducePolicy(state, event("mismatch", { type: "compare",
    id: policy.id, pairs: [same, mismatch] })), /quality failed/);
});

test("trusted evidence and human approval gate active read-only selection and rollback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-policy-"));
  try {
    let approve = false;
    const ledger = new FilePolicyLedger(join(dir, "policy.jsonl"),
      async (item) => item.action.type === "compare" &&
        item.action.pairs.every((p) => p.evidenceHash === pair(p.experimentId).evidenceHash),
      async () => approve);
    await ledger.append(event("propose", { type: "propose", policy }));
    await ledger.append(event("shadow", { type: "shadow", id: policy.id,
      evidenceRef: "local:shadow-observation" }));
    await ledger.append(event("compare", { type: "compare", id: policy.id,
      pairs: [pair("a"), pair("b")] }));
    await assert.rejects(ledger.append(event("approve", { type: "approve",
      id: policy.id, approvalRef: "user:review-42" })), /trusted human approval/);
    assert.equal((await ledger.read()).state?.activeId, null);
    approve = true;
    await ledger.append(event("approve", { type: "approve",
      id: policy.id, approvalRef: "user:review-42" }));
    const active = await ledger.append(event("activate", { type: "activate", id: policy.id }));
    await assert.rejects(new FilePolicyLedger(join(dir, "policy.jsonl")).read(),
      /trusted comparison evidence unavailable/);
    const input = { taskClass: "read_only_research", role: "luna" as const,
      explicitProfile: null, catalog: [{ model: "gpt-6-luna", efforts: ["low"],
        inputModalities: ["text"] }] };
    assert.deepEqual(selectReadOnlyProfile(active, input), { model: "gpt-6-luna",
      effort: "low", policyId: policy.id, policyHash: active.entries[0]!.hash });
    assert.equal(selectReadOnlyProfile(active, { ...input,
      explicitProfile: { model: "gpt-6.1-sol", effort: "high" } }), null);
    assert.equal(selectReadOnlyProfile(active, { ...input, catalog: [] }), null);
    const rolledBack = await ledger.append(event("rollback", { type: "rollback",
      id: policy.id, reasonRef: "local:regression-audit" }));
    assert.equal(selectReadOnlyProfile(rolledBack, input), null);
    assert.equal((await ledger.read()).state?.activeId, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("candidate cannot be compared on an unknown or regressed target metric", () => {
  let state: PolicyState | null = null;
  state = reducePolicy(state, event("propose", { type: "propose", policy }));
  state = reducePolicy(state, event("shadow", { type: "shadow", id: policy.id,
    evidenceRef: "local:shadow-observation" }));
  const reversed = pair("worse", { elapsedMs: 150 });
  assert.throws(() => reducePolicy(state, event("compare", { type: "compare",
    id: policy.id, pairs: [pair("good"), reversed] })), /did not improve/);
  const unknown = pair("unknown", { elapsedMs: null });
  assert.throws(() => reducePolicy(state, event("unknown", { type: "compare",
    id: policy.id, pairs: [pair("good"), unknown] })), /not observed/);
});

test("comparison must measure the proposed profile, a fixed baseline and distinct cases", () => {
  let state = reducePolicy(null, event("propose", { type: "propose", policy }));
  state = reducePolicy(state, event("shadow", { type: "shadow", id: policy.id, evidenceRef: "local:shadow" }));
  const compare = (pairs: ReturnType<typeof pair>[]) => reducePolicy(state,
    event("compare", { type: "compare", id: policy.id, pairs }));
  assert.throws(() => compare([pair("one"), pair("two", { profile: { model: "gpt-6-luna", effort: "high" } })]),
    /proposed profile/);
  const changedBaseline = comparePair("two", arm("baseline", "two", {
    profile: { model: "gpt-6-luna", effort: "high" } }), arm("candidate", "two"));
  assert.throws(() => compare([pair("one"), changedBaseline]), /one baseline/);
  const repeated = comparePair("renamed", arm("baseline", "one"), arm("candidate", "one"));
  assert.throws(() => compare([pair("one"), repeated]), /independent/);
  const reusedArtifact = pair("two", { evidenceRef: "local:one/candidate" });
  assert.throws(() => compare([pair("one"), reusedArtifact]), /independent/);
  assert.equal(compare([pair("one"), pair("two")]).entries[0].stage, "compared");
});
