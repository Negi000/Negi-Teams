import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runSingleTask } from "../src/server/orchestration/singleTaskRunner.ts";

// A local Node child speaks only the synthetic App Server subset used here.
// No Codex executable, credentials, model, or network endpoint is invoked.
const fixture = String.raw`
const fail = process.argv[1] === "fail";
const model = process.argv[2] || "gpt-6-astra";
process.stderr.write("fixture-started\n");
let buffer = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") result = { userAgent: "synthetic-app-server" };
    else if (message.method === "model/list") result = { data: [{ model,
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }], inputModalities: ["text"] }], nextCursor: null };
    else if (message.method === "thread/start") result = {
      thread: { id: "fixture-thread" }, model, modelProvider: "fixture" };
    else if (message.method === "turn/start") result = { turn: { id: "fixture-turn", status: "inProgress" } };
    else result = {};
    send({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "turn/start") {
      if (fail) {
        process.stderr.write("x".repeat(512));
        setTimeout(() => process.exit(7), 5);
      } else {
        send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "fixture-thread",
          turnId: "fixture-turn", item: { type: "agentMessage", phase: "final_answer",
          text: model === "gpt-6-astra" ? "fixture plan" : "fixture work" } } });
        send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "fixture-thread",
          turn: { id: "fixture-turn", status: "completed" } } });
      }
    }
  }
});
`;

async function begin(mode: "ok" | "fail") {
  const host = AppServerProcess.launch({ executable: process.execPath,
    args: ["-e", fixture, mode], cwd: process.cwd(), stderrLimitBytes: 32,
    client: { transportTimeoutMs: 5000 } });
  try {
    await host.client.initialize();
    const models = await host.client.discoverModels();
    assert.equal(models[0].model, "gpt-6-astra");
    await host.client.startThread({ cwd: process.cwd(), model: "gpt-6-astra", sandbox: "read-only" });
    const turnId = await host.client.startTurn("synthetic plan", "medium");
    return { host, turnId };
  } catch (error) {
    // A setup timeout must not leave a live child holding the entire test runner open.
    await host.stop(); throw error;
  }
}

test("owned local fixture process completes a turn without model execution", async () => {
  const { host, turnId } = await begin("ok");
  try {
    const observation = await host.client.waitForTurn(turnId, 1000);
    assert.equal(observation.status, "completed");
    assert.equal(observation.finalText, "fixture plan");
    assert.equal(host.pid !== null, true);
    assert.match(host.stderr.tail, /fixture-started/);
  } finally {
    await host.stop();
  }
});

test("abnormal fixture exit leaves outcome unknown and bounds stderr", async () => {
  const { host, turnId } = await begin("fail");
  try {
    await assert.rejects(host.client.waitForTurn(turnId, 1000));
    const exit = await host.exited;
    assert.equal(exit.code, 7);
    assert.equal(host.client.dispatchBlocked, true);
    await assert.rejects(host.client.waitForTurn(turnId, 1000));
    assert.equal(host.stderr.bytes > 512, true);
    assert.equal(Buffer.byteLength(host.stderr.tail) <= 32, true);
  } finally { await host.stop(); }
});

test("missing executable reports a terminal spawn error", async () => {
  const host = AppServerProcess.launch({ executable: join(tmpdir(), "missing-negi-fixture-executable"),
    args: [], cwd: process.cwd() });
  const exit = await host.exited;
  assert.equal(exit.error !== null, true);
  await assert.rejects(host.client.initialize());
});

test("two owned synthetic processes drive one unaccepted Astra-to-Sol run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-owned-run-"));
  const launch = (model: string) => AppServerProcess.launch({ executable: process.execPath,
    args: ["-e", fixture, "ok", model], cwd: dir,
    client: { transportTimeoutMs: 5000 } });
  const astra = launch("gpt-6-astra");
  const sol = launch("gpt-6-sol");
  try {
    const state = await runSingleTask({ runId: "synthetic-owned-run", cwd: dir,
      contract: { vaultId: "NT-TASK-FIXTURE", version: 1, sha256: "a".repeat(64),
        project: "negi-teams", objective: "local fixture only",
        acceptance: ["local fixture completes"], baseSha: "b".repeat(40) },
      astra: { client: astra.client, model: "gpt-6-astra", effort: "medium" },
      sol: { client: sol.client, model: "gpt-6-sol", effort: "medium" },
      ledger: new FileTaskLedger(join(dir, "run.jsonl")), artifactDir: join(dir, "artifacts"),
      turnTimeoutMs: 1000,
      verify: async () => ({ outcome: "passed", evidenceRef: "synthetic:fixture-only" }),
    });
    assert.equal(state.status, "ready_for_review");
    assert.equal(state.acceptedBy, null);
    assert.deepEqual(state.attempts.map((attempt) => attempt.resolvedModel),
      ["gpt-6-astra", "gpt-6-sol"]);
    assert.equal(state.attempts.every((attempt) => attempt.outputRef?.includes("#sha256=")), true);
  } finally {
    await Promise.all([astra.stop(), sol.stop()]);
    await rm(dir, { recursive: true, force: true });
  }
});
