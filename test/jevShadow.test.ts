import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateJevShadow, type JevRequest } from
  "../src/server/orchestration/jevShadow.ts";
import { JevShadowLedger } from "../src/server/orchestration/jevShadowLedger.ts";

function request(version = "v1"): JevRequest {
  return { gate: "scope", mode: "shadow", state: {
    request: "見出しの色を青にして", extra: "認証APIを変更する" },
    questions: { scope: { type: "choice", instructions: "Is extra work in scope?",
      criteria: { in_scope: "Required", separate: "Separate proposal", unclear: "Unknown" } } },
    reviewedForExternalTransmission: true, taskVersion: version, rubricVersion: "r1" };
}
const answer = { model: "jev-1.13.0", answers: { scope: { type: "choice",
  choice: "separate", confidence: 0.9,
  probabilities: { in_scope: 0.05, separate: 0.9, unclear: 0.05 } } },
  usage: { input_tokens: 447, output_tokens: 30 } };

test("shadow holds unreviewed and active input without sending it", async () => {
  let calls = 0;
  const provider = async () => { calls++; return answer; };
  const unreviewed = await evaluateJevShadow({ ...request(),
    reviewedForExternalTransmission: false }, provider);
  const active = await evaluateJevShadow({ ...request(), mode: "active" }, provider);
  assert.equal(unreviewed.status, "held");
  assert.equal(active.status, "held");
  assert.equal(calls, 0);
});

test("shadow validates provider shape and reports usage without changing work", async () => {
  const result = await evaluateJevShadow(request(), async () => answer);
  assert.equal(result.status, "shadow");
  assert.equal(result.response?.answers.scope &&
    (result.response.answers.scope as { choice: string }).choice, "separate");
  assert.equal(result.estimatedUsd, 447 * 0.042 / 1_000_000);
  const invalidLabel = { ...answer, answers: { scope: { type: "choice",
    choice: "not_an_option", confidence: 1,
    probabilities: { in_scope: 0, separate: 1, unclear: 0 } } } };
  const invalidDistribution = { ...answer, answers: { scope: { type: "choice",
    choice: "separate", confidence: 1,
    probabilities: { in_scope: 0.7, separate: 0.9, unclear: 0 } } } };
  await assert.rejects(evaluateJevShadow(request(), async () => invalidLabel), /invalid/);
  await assert.rejects(evaluateJevShadow(request(), async () => invalidDistribution), /invalid/);
});

test("ledger dispatches once, persists result, and holds failed attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-jev-test-"));
  try {
    const path = join(dir, "shadow.jsonl");
    const ledger = new JevShadowLedger(path, 0.02);
    let calls = 0;
    const provider = async () => { calls++; return answer; };
    assert.equal((await ledger.evaluate(request(), provider)).status, "shadow");
    assert.equal((await ledger.evaluate(request(), provider)).status, "shadow");
    assert.equal(calls, 1);
    await assert.rejects(ledger.evaluate(request("v2"), async () => {
      calls++; throw new Error("synthetic provider failure with private payload");
    }), /synthetic provider failure/);
    assert.equal((await ledger.evaluate(request("v2"), provider)).status, "held");
    assert.equal(calls, 2);
    assert.equal((await ledger.evaluate(request("v3"), provider)).status, "held");
    assert.equal(calls, 2);
    const log = await readFile(path, "utf8");
    assert.ok(!log.includes("private payload"));
    assert.ok(!log.includes("認証API"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
