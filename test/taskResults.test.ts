import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskResultStore } from "../src/server/orchestration/taskResults.ts";
import { taskResultRecipient, type TaskResultNotice } from "../src/shared/taskResults.ts";
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

test("browser execution keeps its origin and delivers only to its verified creation conversation without replay", async () => {
  await fixture(async (store, root) => {
    const createdBy = resultNotice().origin as NonNullable<TaskResultNotice["createdBy"]>;
    const notice = { ...resultNotice(), origin: { kind: "browser" as const }, createdBy };
    await store.publish(notice, { resultRevision: 0, artifactSha256: null });
    assert.deepEqual(taskResultRecipient((await store.list())[0]), createdBy);
    assert.equal(await store.prepareContext("another", "thread", "input", current), null);
    assert.equal(await store.prepareContext("master", "another", "input", current), null);
    const context = (await store.prepareContext("master", "thread", "user followup", current))!;
    const packed = JSON.parse(context.text.split("\n").at(-1)!)[0];
    assert.deepEqual(packed.origin, { kind: "browser" }); assert.deepEqual(packed.createdBy, createdBy);
    await context.dispatching(); await context.unknown();
    const restored = await TaskResultStore.open(root);
    assert.equal((await restored.list())[0].delivery.state, "unknown");
    assert.equal(await restored.prepareContext("master", "thread", "never replay", current), null);
    await assert.rejects(store.publish({ ...notice, createdBy: { ...createdBy, threadId: "reassigned" } },
      { resultRevision: 0, artifactSha256: null }), /origin changed/);
    await assert.rejects(store.publish({ ...notice, createdBy: undefined }, { resultRevision: 0, artifactSha256: null }), /origin changed/);
    await assert.rejects(store.publish({ ...resultNotice("invalid"), createdBy }), /creation origin/);
  });
});

test("legacy browser result gains creation provenance in a new notice without overwriting its historical bytes", async () => {
  await fixture(async (store, root) => {
    const initial = { ...resultNotice(), origin: { kind: "browser" as const } };
    await store.publish(initial); const original = await readFile(join(root, "results.jsonl"), "utf8");
    assert.equal(await store.prepareContext("master", "thread", "before upgrade", current), null);
    const next = { ...initial, sourceSha256: sha("signed creation metadata"), createdBy: resultNotice().origin as NonNullable<TaskResultNotice["createdBy"]> };
    await store.publish(next, { resultRevision: 0, artifactSha256: null });
    const notices = await store.list(); assert.equal(notices.length, 2);
    assert.equal(notices[0].createdBy, undefined); assert.equal(notices[0].supersededBy, notices[1].id);
    assert.equal((await readFile(join(root, "results.jsonl"), "utf8")).startsWith(original), true);
    assert.equal((JSON.parse(await readFile(join(root, "pre-v2-log.json"), "utf8"))).legacyLog, original);
    const context = (await store.prepareContext("master", "thread", "after upgrade", current))!;
    assert.deepEqual(JSON.parse(context.text.split("\n").at(-1)!).map((n: TaskResultNotice) => n.id), [notices[1].id]);
    await context.notSent();
  });
});

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

test("independent result stores serialize concurrent publication and context ownership without removing another lock", async () => {
  await fixture(async (store, root) => {
    const other = await TaskResultStore.open(root);
    await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? other : store).publish(resultNotice("parallel-" + i))));
    const contexts = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? other : store).prepareContext("master", "thread", "input-" + i, current)));
    const notices = contexts.filter(Boolean).flatMap(c => JSON.parse(c!.text.split("\n").at(-1)!));
    assert.equal(notices.length, 16); assert.equal(new Set(notices.map(n => n.id)).size, 16);
    assert.equal((await other.list()).length, 16);
    assert.equal((await readdir(root)).includes("results.jsonl.lock"), false);
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

test("successive result, acceptance and revocation notices preserve immutable history and deliver only the latest version",async()=>{
  await fixture(async(store,root)=>{
    const initial=resultNotice();await store.publish(initial); // Existing v1 log.
    const original=await readFile(join(root,"results.jsonl"),"utf8");
    const revision={...initial,sourceSha256:sha("revision"),reviewId:"review-1"};
    const facts={resultRevision:1,artifactSha256:sha("artifact-1")};
    await store.publish(revision,facts);await store.publish(revision,facts);
    const archive=JSON.parse(await readFile(join(root,"pre-v2-log.json"),"utf8"));
    assert.equal(archive.legacyLog,original);assert.equal(archive.sha256,sha(original));
    const revised=(await store.list()).at(-1)!;assert.equal(revised.update?.kind,"revision");
    assert.equal(revised.update?.sequence,1);assert.equal(revised.update?.previousId,initial.id);
    const accepted={...revision,sourceSha256:sha("accept"),status:"accepted",acceptedBy:"user:proof-1"};
    await store.publish(accepted,facts);
    const revoked={...accepted,sourceSha256:sha("revoke"),status:"review_revoked",acceptedBy:null};
    await store.publish(revoked,facts);
    const history=await store.list();assert.equal(history.length,4);
    assert.deepEqual(history.map(n=>n.update?.kind??"initial"),["initial","revision","accepted","revoked"]);
    assert.equal(history[0].acceptedBy,null);assert.equal(history[2].acceptedBy,"user:proof-1");
    assert.equal(history[0].supersededBy,history[1].id);assert.equal(history[3].supersededBy,null);
    assert.equal((await readFile(join(root,"results.jsonl"),"utf8")).startsWith(original),true);
    assert.deepEqual(JSON.parse(await readFile(join(root,"pre-v2-log.json"),"utf8")),archive);
    const context=(await store.prepareContext("master","thread","read current",current))!;
    assert.deepEqual(JSON.parse(context.text.split("\n").at(-1)!).map(n=>n.id),[history[3].id]);
    await context.dispatching();await context.bind(terminal.turnId);await context.terminal(terminal);
    const reopened=await TaskResultStore.open(root);assert.equal((await reopened.list()).length,4);
    assert.equal(await reopened.prepareContext("master","thread","repeat",current),null);
    await assert.rejects(store.publish({...revoked,origin:{kind:"browser"}},facts),/origin changed/);
  });
});

test("prepared outdated results fail before dispatch, while unknown older deliveries are never replayed",async()=>{
  await fixture(async(store)=>{
    const initial=resultNotice(),facts={resultRevision:0,artifactSha256:sha("artifact")};await store.publish(initial,facts);
    const old=(await store.prepareContext("master","thread","old",current))!;
    await store.publish({...initial,sourceSha256:sha("accepted"),status:"accepted",acceptedBy:"user:proof"},facts);
    await assert.rejects(old.dispatching(),/superseded/);await old.notSent();
    const newer=(await store.prepareContext("master","thread","new",current))!;
    assert.equal(JSON.parse(newer.text.split("\n").at(-1)!)[0].status,"accepted");
    await newer.dispatching();await newer.unknown();
    assert.equal(await store.prepareContext("master","thread","repeat",current),null);
    await store.publish({...initial,sourceSha256:sha("revoked"),status:"review_revoked"},facts);
    const latest=(await store.prepareContext("master","thread","revocation",current))!;
    const notices=JSON.parse(latest.text.split("\n").at(-1)!);
    assert.equal(notices.length,1);assert.equal(notices[0].status,"review_revoked");
    assert.equal((await store.list())[1].delivery.state,"unknown");
  });
});

test("external source changes reject publication and dispatch without erasing saved evidence",async()=>{
  await fixture(async(store)=>{
    const notice=resultNotice(),facts={resultRevision:0,artifactSha256:null};
    await assert.rejects(store.publish(notice,facts,async()=>false),/source changed/);assert.equal((await store.list()).length,0);
    await store.publish(notice,facts);let valid=true;
    const context=(await store.prepareContext("master","thread","input",async()=>valid))!;valid=false;
    await assert.rejects(context.dispatching(),/source changed/);assert.equal((await store.list())[0].delivery.state,"prepared");
    await context.notSent();assert.equal((await store.list())[0].delivery.state,"not_sent");
  });
});

test("legacy unknown delivery remains non-replayable on upgrade and damaged upgrade archives fail closed",async()=>{
  await fixture(async(store,root)=>{
    const original=resultNotice();await store.publish(original);
    const delivery=(await store.prepareContext("master","thread","old input",current))!;
    await delivery.dispatching();await delivery.unknown();
    const facts={resultRevision:1,artifactSha256:sha("artifact")},next={...original,sourceSha256:sha("revision")};
    await store.publish(next,facts);assert.equal((await store.list())[0].delivery.state,"unknown");
    const revised=(await store.prepareContext("master","thread","new input",current))!;
    assert.equal(JSON.parse(revised.text.split("\n").at(-1)!)[0].update.kind,"revision");await revised.notSent();
    await writeFile(join(root,"pre-v2-log.json"),"partial upgrade archive");
    await assert.rejects(store.publish({...next,sourceSha256:sha("acceptance"),status:"accepted",acceptedBy:"user:proof"},facts));
    assert.equal((await store.list()).length,2);assert.equal((await store.list())[0].delivery.state,"unknown");
  });
});
