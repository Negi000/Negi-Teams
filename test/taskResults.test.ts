import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskResultStore } from "../src/server/orchestration/taskResults.ts";
import type { TaskResultNotice } from "../src/shared/taskResults.ts";
import { ChatTranscript } from "../src/client/chatModel.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export function resultNotice(runId = "run-1"): TaskResultNotice {
  return { id: sha(runId), createdAt: "2026-10-01T00:00:00.000Z", runId, title: "結果 <script>",
    project: "project", taskId: "TASK-1", version: 1, configSha256: "a".repeat(64), sourceSha256: "b".repeat(64),
    status: "ready_for_review", verificationOutcome: "passed", acceptedBy: null, reviewId: null, reason: null,
    origin: { kind: "master", masterId: "master", threadId: "thread", turnId: "delegation-turn", callId: "call" } };
}
async function fixture(run: (store: TaskResultStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "negi-task-results-"));
  try { await run(await TaskResultStore.open(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const current = async () => true;
const terminal = { turnId: "reply-turn", status: "completed" as const, finalText: "Result observed; human review remains",
  contextInputTokens: null, contextWindow: null, lastUsage: null };

test("result publication freezes initial facts, deduplicates recovery and rejects reused run configuration", async () => {
  await fixture(async store => {
    const notice = resultNotice(); await store.publish(notice);
    notice.acceptedBy = "later-human"; await store.publish(notice);
    assert.equal((await store.list()).length, 1); assert.equal((await store.list())[0].acceptedBy, null);
    await assert.rejects(store.publish({ ...notice, configSha256: "c".repeat(64) }), /configuration changed/);
    await assert.rejects(store.publish({ ...resultNotice("bad"), reviewId: "\n" }), /notice shape/);
  });
});

test("only the originating conversation gets at most eight current results and concurrent sends cannot share a receipt", async () => {
  await fixture(async store => {
    for (let i = 0; i < 10; i++) await store.publish(resultNotice("run-" + i));
    await store.publish({ ...resultNotice("browser"), origin: { kind: "browser" } });
    assert.equal(await store.prepareContext("different-master", "thread", "input", current), null);
    assert.equal(await store.prepareContext("master", "new-thread", "input", current), null);
    assert.equal(await store.prepareContext("master", "thread", "input", async () => false), null);
    const contexts = await Promise.all([store.prepareContext("master", "thread", "one", current),
      store.prepareContext("master", "thread", "two", current)]);
    assert.equal(contexts.filter(Boolean).length, 2);
    const notices = contexts.map(c => JSON.parse(c!.text.split("\n").at(-1)!));
    assert.deepEqual(notices.map(n => n.length).sort(), [2, 8]);
    assert.equal(new Set(notices.flat().map(n => n.id)).size, 10);
    assert.equal(await store.prepareContext("master", "thread", "three", current), null);
    assert.equal((await store.list()).find(n => n.runId === "browser")?.delivery.state, "pending");
  });
});

test("delivery pins the exact provider input and terminal body, while reload never replays bound or unknown results", async () => {
  await fixture(async (store, root) => {
    await store.publish(resultNotice());
    const context = (await store.prepareContext("master", "thread", "summarize", current))!;
    await context.dispatching(); await context.bind("reply-turn");
    await assert.rejects(context.terminal({ ...terminal, turnId: "wrong" }), /provider differs/);
    await context.terminal(terminal);
    const restored = await TaskResultStore.open(root), row = (await restored.list())[0];
    assert.equal(row.delivery.state, "completed"); assert.equal(row.acceptedBy, null);
    assert.equal(row.delivery.turnId, terminal.turnId);
    assert.equal(await restored.prepareContext("master", "thread", "again", current), null);
    const events = (await readFile(join(root, "results.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const prepared = events.find(e => e.action.type === "prepare").action.delivery;
    assert.equal(sha(context.text), prepared.textSha256);
    assert.equal(await readFile(join(root, `input-${prepared.id}.txt`), "utf8"), context.text);
    const body = await readFile(join(root, `terminal-${prepared.id}.json`), "utf8");
    assert.equal(sha(body), events.at(-1).action.terminalSha256);
    assert.deepEqual(JSON.parse(body), terminal);
    await assert.rejects(context.unknown(), /cannot replay/);
    await writeFile(join(root, `terminal-${prepared.id}.json`), body + " ");
    await assert.rejects(restored.list(), /artifact changed/);
  });
});

test("slow source verification does not lock out a concurrently completed Task result", async () => {
  await fixture(async store => {
    await store.publish(resultNotice());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const preparing = store.prepareContext("master", "thread", "input", async () => { entered(); await gate; return true; });
    await ready;
    try {
      const publication = store.publish(resultNotice("another-run"));
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([publication, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Source check blocked result publication")), 1500);
      })]); } finally { clearTimeout(timer!); }
      assert.equal((await store.list()).length, 2);
    } finally { release(); }
    const context = await preparing; assert.ok(context);
    assert.equal(JSON.parse(context.text.split("\n").at(-1)!).length, 1);
    assert.equal((await store.list()).find(n => n.runId === "another-run")?.delivery.state, "pending");
  });
});

test("unsent input may be prepared only by a later send; incomplete and uncertain receipts survive reload without replay", async () => {
  for (const state of ["prepared", "dispatching", "bound", "unknown", "not_sent"] as const) {
    await fixture(async (store, root) => {
      await store.publish(resultNotice());
      const context = (await store.prepareContext("master", "thread", "input", current))!;
      if (["dispatching", "bound", "unknown"].includes(state)) await context.dispatching();
      if (state === "bound") await context.bind("reply-turn");
      if (state === "unknown") await context.unknown();
      if (state === "not_sent") await context.notSent();
      const restored = await TaskResultStore.open(root);
      assert.equal((await restored.list())[0].delivery.state, state);
      assert.equal(Boolean(await restored.prepareContext("master", "thread", "next input", current)), state === "not_sent");
    });
  }
});

test("oversized contexts, incomplete logs and changed input evidence fail before provider delivery", async () => {
  await fixture(async (store, root) => {
    await store.publish(resultNotice());
    await assert.rejects(store.prepareContext("master", "thread", "x".repeat(100_000), current), /context bound/);
    assert.equal((await store.list())[0].delivery.state, "pending");
    assert.equal((await readdir(root)).length, 1);
    await store.prepareContext("master", "thread", "valid", current);
    const input = (await readdir(root)).find(name => name.startsWith("input-"))!;
    await writeFile(join(root, input), "tampered"); await assert.rejects(store.list(), /input changed/);
  });
  await fixture(async (store, root) => {
    await store.publish(resultNotice()); await appendFile(join(root, "results.jsonl"), "{");
    await assert.rejects(store.list(), /incomplete log tail/);
    await assert.rejects(store.prepareContext("master", "thread", "input", current), /incomplete log tail/);
  });
});

test("result cards update in place without ending assistant streaming or altering turn statistics", () => {
  const transcript = new ChatTranscript(), notice = { ...resultNotice(), delivery: { state: "pending" as const, threadId: null, turnId: null } };
  transcript.apply({ seq: 1, ts: 1, event: { kind: "text", text: "first", partial: true } });
  transcript.apply({ seq: 2, ts: 2, event: { kind: "taskResult", result: notice } });
  transcript.apply({ seq: 3, ts: 3, event: { kind: "text", text: " second", partial: true } });
  transcript.apply({ seq: 4, ts: 4, event: { kind: "taskResult", result: { ...notice,
    delivery: { state: "completed", threadId: "thread", turnId: "reply-turn" } } } });
  assert.equal(transcript.items.length, 2);
  assert.deepEqual(transcript.items[0], { kind: "assistant", seq: 1, ts: 1, text: "first second", streaming: true });
  assert.equal(transcript.items[1].kind, "taskResult");
  assert.equal(transcript.summary.totalCostUsd, null); assert.equal(transcript.summary.contextUsedPct, null);
});
