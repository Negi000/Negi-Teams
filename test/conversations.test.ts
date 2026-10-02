import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { scheduledMasterTurns } from "../src/server/orchestration/masterTurnAdmission.ts";
import { readMasterTurnOrigin } from "../src/server/orchestration/masterTurnRecords.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { createConversationHttp } from "../src/server/orchestration/conversationHttp.ts";
import { conversationPageHtml } from "../src/server/orchestration/conversationPage.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { createTaskAuthoringHttp } from "../src/server/orchestration/taskAuthoringHttp.ts";
import { loginPageHtml, loginReturnTo } from "../src/server/auth.ts";
import { setup, origin, requestOrigin } from "./helpers/taskAuthoringFixture.ts";

const terminal = { turnId: "master-turn", status: "completed" as const, finalText: "計画しました。<script>bad()</script>",
  contextInputTokens: null, contextWindow: null, lastUsage: null };
const canonical = (value: unknown) => JSON.stringify(value) + "\n";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

async function recordFixture(run: (f: { root: string; scheduler: FileScheduler; workId: string;
  lease: Awaited<ReturnType<ReturnType<typeof scheduledMasterTurns>["reserve"]>> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-source-")), root = join(dir, "records"), cwd = join(dir, "checkout");
  await mkdir(cwd);
  const scheduler = new FileScheduler(join(dir, "scheduler.jsonl"));
  try {
    const lease = await scheduledMasterTurns({ root, scheduler, masterId: origin.masterId }).reserve({
      cwd, model: origin.model, effort: origin.effort, threadId: origin.threadId, text: "元の依頼 <img src=x onerror=bad()>" });
    await lease.dispatching(); await lease.bind(origin.turnId);
    await run({ root, scheduler, lease, workId: lease.workId });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("recorded source reads the exact turn across reopening without changing scheduler or dispatch evidence", async () => {
  await recordFixture(async f => {
    await f.lease.complete(terminal);
    const schedulerBytes = await readFile(f.scheduler.path, "utf8"), path = join(f.root, f.workId);
    const requestBytes = await readFile(join(path, "request.json"), "utf8"), outcomeBytes = await readFile(join(path, "outcome.json"), "utf8");
    const source = await readMasterTurnOrigin(f.root, new FileScheduler(f.scheduler.path), requestOrigin);
    assert.equal(source.state, "available"); assert.equal(source.workId, f.workId);
    assert.equal(source.input, JSON.parse(requestBytes).text); assert.equal(source.finalText, terminal.finalText);
    assert.equal(source.inputSha256, hash(source.input!)); assert.equal(source.outcomeSha256, hash(outcomeBytes));
    assert.match(source.message, /人間による受入とは別/);
    assert.equal(await readFile(f.scheduler.path, "utf8"), schedulerBytes);
    assert.equal(await readFile(join(path, "request.json"), "utf8"), requestBytes);
    assert.equal(await readFile(join(path, "outcome.json"), "utf8"), outcomeBytes);
    const missing = await readMasterTurnOrigin(f.root, f.scheduler, { ...requestOrigin, threadId: "different-conversation" });
    assert.equal(missing.state, "missing"); assert.equal(missing.input, null); assert.equal(missing.finalText, null);
    assert.equal((await readMasterTurnOrigin(f.root, f.scheduler, { ...requestOrigin, masterId: "wrong-owner" })).state, "attention");
  });
});

test("waiting and unknown responses never become completed or release their execution slot through a read", async () => {
  await recordFixture(async f => {
    const waiting = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(waiting.state, "waiting"); assert.equal(waiting.outcome, "running"); assert.equal(waiting.finalText, null);
    await f.lease.unknown("provider disconnected");
    const bytes = await readFile(f.scheduler.path, "utf8"), unknown = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(unknown.state, "attention"); assert.equal(unknown.outcome, "needs_reconciliation"); assert.ok(unknown.input); assert.equal(unknown.finalText, null);
    assert.equal((await f.scheduler.read()).state?.entries[0].status, "needs_reconciliation");
    assert.equal(await readFile(f.scheduler.path, "utf8"), bytes);
  });
});

test("source timestamps describe dispatch preparation rather than earlier request creation", async () => {
  await recordFixture(async f => {
    await f.lease.complete(terminal);
    const directory = join(f.root, f.workId), requestPath = join(directory, "request.json"), dispatchPath = join(directory, "dispatch.json");
    const request = JSON.parse(await readFile(requestPath, "utf8")), dispatch = JSON.parse(await readFile(dispatchPath, "utf8"));
    request.at = "2026-10-02T00:00:00.000Z"; dispatch.at = "2026-10-02T00:01:00.000Z";
    await writeFile(requestPath, canonical(request)); await writeFile(dispatchPath, canonical(dispatch));
    const source = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(source.state, "available"); assert.equal(source.sentAt, dispatch.at); assert.notEqual(source.sentAt, request.at);
  });
});

test("failed and interrupted sources retain their known terminal status without fabricating a final response", async () => {
  for (const status of ["failed", "interrupted"] as const) await recordFixture(async f => {
    await f.lease.complete({ ...terminal, status, finalText: null });
    const source = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(source.state, "available"); assert.equal(source.outcome, status); assert.equal(source.finalText, null);
  });
});

test("ambiguous provider bindings do not choose a conversation", async () => {
  await recordFixture(async f => {
    await f.lease.complete(terminal);
    const next = await scheduledMasterTurns({ root: f.root, scheduler: f.scheduler, masterId: origin.masterId }).reserve({
      cwd: (await f.scheduler.read()).state!.entries[0].work.checkout, model: origin.model, effort: origin.effort, threadId: origin.threadId, text: "second" });
    await next.dispatching(); await next.bind(origin.turnId);
    const source = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(source.state, "attention"); assert.equal(source.input, null); assert.equal(source.finalText, null);
  });
});

test("partial JSON, duplicate keys, changed hashes, and changed scheduler terminal references fail closed", async () => {
  for (const mutation of ["partial", "duplicate", "hash", "outcome"] as const) await recordFixture(async f => {
    await f.lease.complete(terminal);
    const path = join(f.root, f.workId, mutation === "outcome" ? "outcome.json" : "request.json");
    const bytes = await readFile(path, "utf8"), value = JSON.parse(bytes);
    if (mutation === "partial") await writeFile(path, bytes.slice(0, -5));
    if (mutation === "duplicate") await writeFile(path, bytes.replace('{', '{"masterId":"forged",'));
    if (mutation === "hash") await writeFile(path, canonical({ ...value, text: "changed" }));
    if (mutation === "outcome") await writeFile(path, canonical({ ...value, finalText: "changed" }));
    const source = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(source.state, "attention", mutation); assert.equal(source.input, null); assert.equal(source.finalText, null);
  });
});

test("linked evidence files and aliased record directories are not read", async () => {
  await recordFixture(async f => {
    await f.lease.complete(terminal);
    const request = join(f.root, f.workId, "request.json");
    await link(request, join(f.root, f.workId, "linked-copy.json"));
    assert.equal((await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin)).state, "attention");
  });
  await recordFixture(async f => {
    const alias = f.root + "-alias"; await symlink(f.root, alias, "junction");
    try { assert.equal((await readMasterTurnOrigin(alias, f.scheduler, requestOrigin)).state, "attention"); }
    finally { await rm(alias); }
  });
});

test("provider binding changes during inspection hide the previously read content", async () => {
  await recordFixture(async f => {
    await f.lease.complete(terminal);
    const read = f.scheduler.read.bind(f.scheduler); let calls = 0;
    f.scheduler.read = async () => {
      const state = await read();
      if (++calls === 1) await writeFile(join(f.root, f.workId, "provider.json"), canonical({ workId: f.workId, threadId: origin.threadId, turnId: "changed" }));
      return state;
    };
    const source = await readMasterTurnOrigin(f.root, f.scheduler, requestOrigin);
    assert.equal(source.state, "attention"); assert.equal(source.input, null); assert.equal(source.finalText, null);
  });
});

async function httpFixture(run: (f: Awaited<ReturnType<typeof setup>>, base: string) => Promise<void>) {
  const f = await setup();
  const sources = createConversationHttp(f.tasks, f.authoring, { token: "fixture-token" });
  const plans = createTaskAuthoringHttp(f.authoring, { token: "fixture-token" });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (await sources(req, res, url) || await plans(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(f, `http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
}
const cookie = { Cookie: "ebi_auth=fixture-token" };

test("source HTTP requires cookie authentication, validates its target and cannot dispatch through other methods", async () => {
  await httpFixture(async (f, base) => {
    const path = "/api/conversations/origin?run=template";
    for (const headers of [undefined, { Authorization: "Bearer fixture-token" }, { Cookie: "ebi_auth=%GG" }])
      assert.equal((await fetch(base + path, { headers })).status, 401);
    assert.equal((await fetch(base + path + "&token=fixture-token")).status, 401);
    assert.equal((await fetch(base + "/conversations?run=template&source=created", { redirect: "manual" })).headers.get("location"),
      "/login?returnTo=" + encodeURIComponent("/conversations?run=template&source=created"));
    for (const query of ["run=../private", "run=template&run=other", "run=template&draft=", "draft=bad", "run=template&path=request.json", "run=template&source=unknown"])
      assert.equal((await fetch(base + "/api/conversations/origin?" + query, { headers: cookie })).status, 409, query);
    assert.equal((await fetch(base + "/api/conversations/origin?run=absent", { headers: cookie })).status, 404);
    assert.equal((await fetch(base + path, { headers: cookie, method: "POST" })).status, 405);
    const missing = await (await fetch(base + path, { headers: cookie })).json();
    assert.equal(missing.state, "missing"); assert.equal(missing.origin, null); assert.equal(missing.input, null);
    assert.deepEqual(f.calls(), { astra: 0, sol: 0 }); assert.equal(f.tasks.list().length, 1);
  });
});

test("draft creation, browser execution and historical source identity remain distinct across reopening", async () => {
  await httpFixture(async (f, base) => {
    const lease = await f.tasks.masterTurnAdmission(origin.masterId).reserve({ cwd: f.repo, model: origin.model,
      effort: origin.effort, threadId: origin.threadId, text: "契約案を作ってください。" });
    await lease.dispatching(); await lease.bind(origin.turnId); await lease.complete(terminal);
    const d = await f.authoring.propose("docs-project", f.fields, origin);
    const draftSource = await (await fetch(base + "/api/conversations/origin?draft=" + d.id, { headers: cookie })).json();
    assert.deepEqual(draftSource.origin, requestOrigin); assert.equal(draftSource.source, "created");
    assert.equal(draftSource.state, "available"); assert.equal(draftSource.taskHref, null); assert.equal(draftSource.finalText, terminal.finalText);
    const redirect = await fetch(base + "/task-plans?draft=" + d.id, { redirect: "manual" });
    assert.equal(redirect.headers.get("location"), "/login?returnTo=" + encodeURIComponent("/task-plans?draft=" + d.id));
    const approved = await f.authoring.finalize(d.id, d.hash, randomUUID()), run = approved.runId!;
    let metadata = await (await fetch(base + "/api/conversations/origins?run=" + run, { headers: cookie })).json();
    assert.deepEqual(metadata.created, requestOrigin); assert.equal(metadata.requested, null);
    const state = await f.tasks.snapshot(run); await f.tasks.start(run, state.configSha256, randomUUID(), { kind: "browser" });
    const until = Date.now() + 10000;
    while ((await f.tasks.snapshot(run)).live) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 20)); }
    const calls = f.calls(), schedulerBytes = await readFile(f.config.schedulerPath, "utf8");
    const requested = await (await fetch(base + "/api/conversations/origin?run=" + run, { headers: cookie })).json();
    const created = await (await fetch(base + "/api/conversations/origin?run=" + run + "&source=created", { headers: cookie })).json();
    assert.equal(requested.state, "browser"); assert.equal(requested.origin, null); assert.equal(requested.input, null);
    assert.deepEqual(created.origin, requestOrigin); assert.equal(created.state, "available"); assert.equal(created.planHref, "/task-plans?draft=" + d.id);
    metadata = await (await fetch(base + "/api/conversations/origins?run=" + run, { headers: cookie })).json();
    assert.deepEqual(metadata.created, requestOrigin); assert.equal(metadata.requested, null);
    assert.equal(await readFile(f.config.schedulerPath, "utf8"), schedulerBytes); assert.deepEqual(f.calls(), calls);
    await f.tasks.close(); const reopened = await LocalTaskService.open(f.catalog, f.runtime);
    try {
      const authoring = await LocalTaskAuthoringService.open(f.authoringConfig, reopened);
      assert.deepEqual((await authoring.runConversationOrigin(run))?.origin, requestOrigin);
      assert.deepEqual(await reopened.requestOrigin(run), { kind: "browser" });
      assert.equal((await reopened.originEvidence(requestOrigin)).finalText, terminal.finalText);
      assert.deepEqual(f.calls(), calls);
    } finally { await reopened.close(); }
  });
});

test("altered signed creation authority does not expose a substituted creation source", async () => {
  await httpFixture(async (f, base) => {
    const d = await f.authoring.propose("docs-project", f.fields, origin), approved = await f.authoring.finalize(d.id, d.hash, randomUUID());
    const config = f.tasks.authoringTemplate(approved.runId!).config;
    const path = join(config.approvedPlan!.proofDirectory, config.approvedPlan!.requestId + ".json"), value = JSON.parse(await readFile(path, "utf8"));
    value.receipt.data.origin = JSON.stringify({ ...origin, threadId: "substituted" }); await writeFile(path, JSON.stringify(value));
    for (const suffix of ["origins?run=", "origin?source=created&run="])
      assert.equal((await fetch(base + "/api/conversations/" + suffix + approved.runId, { headers: cookie })).status, 409);
    assert.deepEqual(f.calls(), { astra: 0, sol: 0 });
  });
});

test("login preserves only bounded local source and Task-plan targets; source page renders recorded strings as text", () => {
  const draft = randomUUID();
  for (const path of ["/conversations?run=task.1&source=created", "/conversations?draft=" + draft, "/task-plans?draft=" + draft,
    "/task-plans?baseline=base-" + "a".repeat(24) + "&profile=docs-project&draft=" + draft]) {
    assert.equal(loginReturnTo(path), path); assert.ok(loginPageHtml(path).includes("location.href = " + JSON.stringify(path)));
  }
  for (const path of ["//outside/conversations?run=x", "/conversations?run=x&next=//outside", "/conversations?run=x&run=y",
    "/conversations?run=x&draft=", "/conversations?run=x#other", "/task-plans?draft=bad", "/task-plans?profile=x", "/task-plans?draft=" + draft + "&next=//outside"])
    assert.equal(loginReturnTo(path), "/", path);
  const html = conversationPageHtml(), script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
  assert.doesNotThrow(() => new Script(script)); assert.doesNotMatch(script, /innerHTML|fetch\([^\n]*method|localStorage.*token/);
  assert.match(script, /textContent=value\.input/); assert.match(script, /generation!==request/);
});
