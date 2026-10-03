import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setup, origin, planner } from "./helpers/taskAuthoringFixture.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { registeredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import { loadApprovedTaskOrigin } from "../src/server/orchestration/approvedTaskPlan.ts";

test("Task UI start returns the authored result to its signed creation conversation and survives restart without a model turn", async () => {
  const f = await setup();
  try {
    const draft = await f.authoring.propose("docs-project", f.fields, origin);
    const approved = await f.authoring.finalize(draft.id, draft.hash, randomUUID());
    const initial = await f.tasks.snapshot(approved.runId!);
    await f.tasks.start(initial.id, initial.configSha256, randomUUID(), { kind: "browser" });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const view = await f.tasks.snapshot(initial.id);
      if (!view.live && view.status === "ready_for_review") break;
      assert.ok(Date.now() < deadline, "Authored fixture did not settle"); await new Promise(resolve => setTimeout(resolve, 20));
    }
    const notice = (await f.tasks.resultNotifications()).find(n => n.runId === initial.id)!;
    assert.deepEqual(notice.origin, { kind: "browser" });
    const createdBy = { kind: "master", masterId: origin.masterId, threadId: origin.threadId, turnId: origin.turnId, callId: origin.callId };
    assert.deepEqual(notice.createdBy, createdBy); assert.equal(notice.acceptedBy, null);
    const tools = registeredTaskTools(f.tasks, origin.masterId, { service: f.authoring, planner });
    const result = await tools.invoke({ threadId: origin.threadId, turnId: "followup", callId: "results", tool: "negi_list_task_results", arguments: {} });
    assert.equal(result.success, true); assert.match(JSON.stringify(result), new RegExp(initial.id));
    assert.equal(await f.tasks.prepareResultContext(origin.masterId, "other-thread", "input"), null);
    const context = (await f.tasks.prepareResultContext(origin.masterId, origin.threadId, "結果を確認してください"))!;
    assert.ok(context); assert.equal(JSON.parse(context.text.split("\n").at(-1)!)[0].id, notice.id);
    await context.dispatching(); await context.bind("followup-turn");
    await context.terminal({ turnId: "followup-turn", status: "completed", finalText: "fixed result observed",
      contextInputTokens: null, contextWindow: null, lastUsage: null });
    const config = f.tasks.authoringTemplate(initial.id).config;
    const signingKey = join(config.approvedPlan!.proofDirectory, "server-signing-key"), key = await readFile(signingKey);
    await unlink(signingKey);
    await assert.rejects(loadApprovedTaskOrigin(config));
    assert.equal((await readdir(config.approvedPlan!.proofDirectory)).includes("server-signing-key"), false);
    await writeFile(signingKey, key);
    await f.tasks.close(); const restored = await LocalTaskService.open(f.catalog, f.runtime);
    try {
      await LocalTaskAuthoringService.open(f.authoringConfig, restored);
      assert.deepEqual((await restored.resultNotifications()).find(n => n.runId === initial.id)!.origin, { kind: "browser" });
      assert.equal(await restored.prepareResultContext(origin.masterId, origin.threadId, "do not replay"), null);
      assert.deepEqual(f.calls(), { astra: 0, sol: 1 });
      const receiptPath = join(config.approvedPlan!.proofDirectory, config.approvedPlan!.requestId + ".json");
      const original = await readFile(receiptPath, "utf8"), logPath = join(f.catalog.stateRoot, "task-results", "results.jsonl");
      const log = await readFile(logPath, "utf8"), changed = JSON.parse(original);
      changed.receipt.data.origin = JSON.stringify({ ...origin, threadId: "untrusted-thread" });
      await writeFile(receiptPath, JSON.stringify(changed));
      await assert.rejects(restored.resultNotifications(), /requires inspection/);
      assert.equal(await readFile(logPath, "utf8"), log);
      await writeFile(receiptPath, original);
    } finally { await restored.close(); }
  } finally { await f.close(); }
});
