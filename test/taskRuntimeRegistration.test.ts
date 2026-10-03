import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
import type { MasterOwner } from "../src/server/orchestration/masterConversationOwner.ts";
import { RuntimeJournalInventory } from "../src/server/orchestration/runtimeJournalInventory.ts";
import { LocalIntegrationExecutionService } from "../src/server/orchestration/integrationExecution.ts";
import { LocalIntegrationReviewService } from "../src/server/orchestration/integrationReviewService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { setup, origin, git } from "./helpers/taskAuthoringFixture.ts";

const windows = { skip: process.platform !== "win32" };
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 180_000;
  for (;;) { const value = await read();if (done(value)) return value;
    assert.ok(Date.now() < deadline, "Registered runtime did not settle");await new Promise(r => setTimeout(r, 50)); }
}
async function register(f: Awaited<ReturnType<typeof setup>>) {
  await f.tasks.close();
  const root = join(f.catalog.stateRoot, "master-conversations"), turnRoot = join(f.catalog.stateRoot, "master-turns"),
    schedulerPath = f.config.schedulerPath;
  await mkdir(turnRoot);
  await f.tasks.masterConversationAuthority("native-master").assertIdle(f.repo);
  const stage = new MasterConversationInventory({ root, masterId: "native-master", recoveryContext: { turnRoot, schedulerPath } });
  await stage.initialize();
  const inventory = new RuntimeJournalInventory({ root, turnRoot, schedulerPath }), preview = await inventory.previewBaseline();
  await inventory.adoptBaseline({ decisionId: randomUUID(), expectedProofSha256: preview.proofSha256 });
  return { root, turnRoot, stage, inventory };
}

test("indexed Task registration does not bootstrap missing authority or proof roots", windows, async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-task-registration-"));
  try {
    const stateRoot = join(dir, "state"), catalog = { stateRoot, schedulerPath: join(dir, "scheduler.jsonl"), runs: [] };
    const names = await readdir(dir);
    await assert.rejects(LocalTaskService.open(catalog, undefined, { storage: "indexed" }));
    assert.deepEqual(await readdir(dir), names);await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
    await assert.rejects(LocalTaskService.open(catalog, undefined, { storage: "unknown" } as never), /registration invalid/);
    assert.deepEqual(await readdir(dir), names);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("registered Task, owner/5 Master, integration execution and restored integration review share the signed scheduler", windows, async () => {
  const f = await setup();let tasks: LocalTaskService | null = null, integrations: LocalIntegrationExecutionService | null = null,
    restored: LocalIntegrationReviewService | null = null;
  try {
    const { root, inventory } = await register(f);
    tasks = await LocalTaskService.open(f.catalog, f.runtime, { storage: "indexed" });
    const scheduler = tasks.registeredScheduler(f.config.schedulerPath);
    assert.equal(tasks.registeredScheduler(f.config.schedulerPath), scheduler);
    assert.throws(() => tasks!.registeredScheduler(join(f.root, "foreign.jsonl")), /differs/);
    await scheduler.append({ key: "fixture-one-slot", at: new Date().toISOString(), action: { type: "set_capacity",
      capacity: { maxConcurrent: 1, planners: 1, workers: 1 }, sourceRef: "user:fixture" } });
    const admission = tasks.masterTurnAdmission("native-master"), baseline = (await inventory.audit()).head;
    let owner: MasterOwner | null = null;
    const original = MasterConversationInventory.prototype.ownerBaseline;
    MasterConversationInventory.prototype.ownerBaseline = async function (digest) {
      const result = await original.call(this, digest);
      owner = JSON.parse(await readFile(join(root, "masters", "native-master", "owner.lock"), "utf8"));return result;
    };
    let lease: Awaited<ReturnType<typeof admission.reserve>>;
    try { lease = await admission.reserve({ cwd: f.repo, model: "fixture", effort: "low", threadId: "resident", text: "Coordinate two Tasks" }); }
    finally { MasterConversationInventory.prototype.ownerBaseline = original; }
    const acquired = owner as MasterOwner | null;
    assert.ok(acquired);assert.equal(acquired.schema, "negi-master-conversation-owner/5");
    if (acquired.schema !== "negi-master-conversation-owner/5") throw Error("Owner registration version");
    assert.deepEqual(acquired.runtime.head, baseline);
    await assert.rejects(admission.assertIdle!(f.repo));
    const authoring = await LocalTaskAuthoringService.open(f.authoringConfig, tasks);
    const reviewConfig = { storageRoot: join(f.root, "reviews"), writableRoots: [], cases: [] }, reviews = await LocalReviewService.open(reviewConfig);
    await tasks.connectReviews(reviews);
    const graph = await authoring.proposeDecomposition("docs-project", { title: "Two docs", objective: "Prepare independently", coordination: ["Same base"], nodes: [
      { key: "guide", dependsOn: [], handoff: "Guide", task: { ...f.fields, allowedPaths: ["docs/guide.txt"] } },
      { key: "checks", dependsOn: [], handoff: "Checks", task: { ...f.fields, allowedPaths: ["docs/checks.txt"] } },
    ] }, { ...origin, callId: "registered-decomposition" });
    const ids = [];
    for (const draft of graph) ids.push((await authoring.finalize(draft.id, draft.hash, randomUUID())).runId!);
    for (const id of ids) { const view = await tasks.snapshot(id);await tasks.start(id, view.configSha256, randomUUID()); }
    assert.deepEqual(f.calls(), { astra: 0, sol: 0 });
    assert.equal((await scheduler.read()).state?.entries.filter(e => e.status === "running").length, 1);
    await lease.cancelBeforeDispatch();
    for (const id of ids) assert.equal((await until(() => tasks!.snapshot(id), v => !v.live && v.status !== "queued")).status, "ready_for_review");
    assert.deepEqual(f.calls(), { astra: 0, sol: 2 });
    await admission.assertIdle!(f.repo);
    integrations = await LocalIntegrationExecutionService.open(authoring, tasks, reviews);
    const preview = await integrations.preview("docs-project", ids), started = await integrations.start("docs-project", ids, preview.hash, randomUUID());
    const result = await until(() => integrations!.snapshot(started.id), v => !v.live && v.status !== "queued");
    assert.equal(result.status, "ready_for_review");assert.ok(result.reviewId);
    const initialReview = await reviews.snapshot(result.reviewId);
    assert.equal(initialReview.canAccept, true, initialReview.integrityError ?? "Initial integration review unavailable");
    const outputDir = join(f.root, "authoring", "integrations", started.id, "output"), checkout = join(f.root, "worktrees", started.id);
    assert.equal((await readFile(join(checkout, "docs", "guide.txt"), "utf8")).trim(), "approved fixture result");
    assert.equal(git(f.repo, ["status", "--porcelain"]), "");
    assert.equal((await inventory.audit()).state, "clean");
    const manifest = JSON.parse(await readFile(join(outputDir, "integration-review-manifest.json"), "utf8"));
    // Restore the source order pinned by the actual integration, rather than
    // the graph creation order (UUID ordering can differ).
    const pinnedIds = manifest.sourcePins.map((pin: { runId: string }) => pin.runId);
    const taskCatalog = join(f.root, "restored-task-catalog.json"), reviewCatalog = join(f.root, "restored-review-catalog.json");
    const runs = await Promise.all(ids.map(async id => ({ title: tasks!.list().find(row => row.id === id)!.title, config: (await tasks!.integrationSource(id)).config })));
    await writeFile(taskCatalog, JSON.stringify({ ...f.catalog, runs }));await writeFile(reviewCatalog, JSON.stringify(reviewConfig));
    const before = (await inventory.audit()).head;
    restored = await LocalIntegrationReviewService.open({ integrations: [{ id: started.id, title: manifest.review.title,
      baseSha: manifest.baseSha, evidenceSha256: manifest.review.evidenceSha256, limits: manifest.review.limits,
      sourceRunIds: pinnedIds, taskCatalog, reviewCatalog, checkout, outputDir }] }, reviews, undefined, { storage: "indexed" });
    assert.deepEqual((await inventory.audit()).head, before);assert.deepEqual(f.calls(), { astra: 0, sol: 2 });
    const restoredReview = await reviews.snapshot(result.reviewId);
    assert.equal(restoredReview.canAccept, true, restoredReview.integrityError ?? "Restored integration review unavailable");
    // Integration decisions reread source Tasks under the same native root.
    const accepted=await reviews.accept(result.reviewId,restoredReview.artifactSha256,randomUUID());
    assert.equal(accepted.status,"accepted");assert.equal(accepted.integrityError,null);
    const revoked=await reviews.revoke(result.reviewId,restoredReview.artifactSha256,randomUUID(),"Synthetic callback/lock verification");
    assert.equal(revoked.status,"revoked");assert.equal(revoked.integrityError,null);
    for(const id of ids)assert.equal((await tasks.snapshot(id)).acceptedBy,null);
    assert.equal((await inventory.audit()).state,"clean");assert.deepEqual(f.calls(),{astra:0,sol:2});
    // A Task decision also runs connectReviews' listener -> publishResult -> signed scheduler read.
    const sourceReviewId=(await tasks.snapshot(ids[0])).reviewId!;
    const sourceReview=await reviews.snapshot(sourceReviewId);
    const sourceAccepted=await reviews.accept(sourceReviewId,sourceReview.artifactSha256,randomUUID());
    assert.equal(sourceAccepted.status,"accepted");assert.equal(sourceAccepted.integrityError,null);
    assert.ok((await tasks.snapshot(ids[0])).acceptedBy);
    assert.ok((await tasks.resultNotifications()).some(notice=>notice.runId===ids[0]&&notice.status==="accepted"));
    const sourceRevoked=await reviews.revoke(sourceReviewId,sourceReview.artifactSha256,randomUUID(),"Synthetic result-listener reentry");
    assert.equal(sourceRevoked.status,"revoked");assert.equal(sourceRevoked.integrityError,null);
    assert.equal((await tasks.snapshot(ids[0])).status,"review_revoked");
    assert.ok((await tasks.resultNotifications()).some(notice=>notice.runId===ids[0]&&notice.status==="review_revoked"));
    assert.equal((await inventory.audit()).state,"clean");assert.deepEqual(f.calls(),{astra:0,sol:2});
    await assert.rejects(new FileScheduler(f.config.schedulerPath).read(), /requires its journal writer/);
  } finally { await restored?.close();await integrations?.close();await tasks?.close();await f.close(); }
});

test("an indexed service and its admitted lease hold on lost runtime DB and default reopen creates no new proof store", windows, async () => {
  const f = await setup();let tasks: LocalTaskService | null = null;
  try {
    const { inventory } = await register(f);
    tasks = await LocalTaskService.open(f.catalog, f.runtime, { storage: "indexed" });
    const lease = await tasks.masterTurnAdmission("native-master").reserve({ cwd: f.repo, model: "fixture", effort: "low", threadId: "resident", text: "Pending input" });
    const request = await readFile(join(f.catalog.stateRoot, "master-turns", lease.workId, "request.json"));
    await rm(inventory.databasePath);
    await assert.rejects(lease.dispatching());await assert.rejects(tasks.capacitySnapshot());
    assert.deepEqual(await readFile(join(f.catalog.stateRoot, "master-turns", lease.workId, "request.json")), request);
    await assert.rejects(lstat(join(f.catalog.stateRoot, "master-turns", lease.workId, "dispatch.json")), { code: "ENOENT" });
    await tasks.close();tasks = null;
    await rm(join(f.catalog.stateRoot, "operation-proofs"), { recursive: true });
    const names = await readdir(f.catalog.stateRoot);
    await assert.rejects(LocalTaskService.open({ ...f.catalog, storage: "indexed" }, f.runtime));
    assert.deepEqual(await readdir(f.catalog.stateRoot), names);
    await assert.rejects(LocalTaskService.open(f.catalog, f.runtime, { storage: "indexed" }));
    assert.deepEqual(await readdir(f.catalog.stateRoot), names);assert.deepEqual(f.calls(), { astra: 0, sol: 0 });
  } finally { await tasks?.close();await f.close(); }
});

test("indexed Master snapshots its input before delayed configuration admission and uses one server request identity", windows, async () => {
  const f = await setup();let tasks: LocalTaskService | null = null, release = () => {};
  try {
    await register(f);tasks = await LocalTaskService.open(f.catalog, f.runtime, { storage: "indexed" });
    const gate = new Promise<void>(resolve => { release = resolve; });let admissions = 0;
    tasks.bindConfigurationAdmission(async operation => { admissions++;await gate;return operation(); });
    const request = { cwd: f.repo, model: "fixture", effort: "low", threadId: "original-thread", text: "Original input" };
    const pending = tasks.masterTurnAdmission("native-master").reserve(request);
    request.text = "Changed after call";request.model = "changed-model";request.threadId = "changed-thread";release();
    const lease = await pending, saved = JSON.parse(await readFile(join(f.catalog.stateRoot, "master-turns", lease.workId, "request.json"), "utf8"));
    assert.equal(admissions, 1);assert.equal(saved.text, "Original input");assert.equal(saved.model, "fixture");
    assert.equal(saved.threadId, "original-thread");assert.equal(saved.workId, lease.workId);assert.equal(saved.masterId, "native-master");
    await lease.cancelBeforeDispatch();assert.deepEqual(f.calls(), { astra: 0, sol: 0 });
  } finally { release();await tasks?.close();await f.close(); }
});
