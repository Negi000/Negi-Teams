// Explicit synthetic benchmarks; no providers and no product authority paths.
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, writeFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
const helper = resolve("test/helpers/masterConversationInventoryFixture.py");
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== "--writes") throw Error("Expected no arguments or --writes");
const writes = args.length === 1;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function populate(root, masterId, count) {
  await new Promise((accept, reject) => {
    const child = spawn("python", ["-B", helper], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "", failure;
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(0, 500); });
    child.on("error", error => { failure = error; }); child.stdin.on("error", error => { failure ??= error; });
    child.on("close", code => failure ? reject(failure) : code === 0 ? accept() : reject(Error(stderr)));
    child.stdin.end(JSON.stringify({ root, masterId, count }));
  });
}
async function durableFixtureFile(path, bytes) {
  const file = await open(path, "wx");
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function writer(root, masterId, key, inventory, expectedCount) {
  const audit = await inventory.audit();
  if (audit.state !== "clean" || audit.artifactCount !== expectedCount) throw Error("Writer baseline not clean");
  const request = { requestId: randomUUID(), masterId, mode: "rotate", oldThreadId: "old", cwd: join(dirname(root), "checkout"),
    model: "fixture-astra", effort: "low", provider: "fixture", settingsSha256: "a".repeat(64) };
  const payload = { schema: "negi-master-conversation-owner/3", pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString(),
    masterId, kind: "thread-start", cwdSha256: hash(request.cwd), operation: { domain: "master-conversation", requestId: request.requestId,
      hash: hash(JSON.stringify(request) + "\n") }, evidenceSha256: "b".repeat(64), processIdentity: await inventory.currentProcessIdentity() };
  const owner = JSON.stringify({ ...payload, signature: createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
  const master = join(root, "masters", masterId);
  await durableFixtureFile(join(master, "owner.lock"), owner);
  return { inventory, request, key, master, owner, head: audit.head, previous: null, index: 0 };
}
async function appendPublished(writer, stage) {
  const identity = ["bound", "completed"].includes(stage) ? { threadId: "fixture-" + writer.request.requestId,
    requestedModel: "fixture-astra", resolvedModel: "fixture-astra", modelProvider: "fixture", rerouted: false } : null;
  const payload = { schemaVersion: "negi-master-conversation/1", request: writer.request, stage,
    previousSha256: writer.previous === null ? null : hash(writer.previous), identity,
    reason: stage === "cancelled" ? "Synthetic unsent benchmark; no RPC" : null, at: new Date().toISOString() };
  const bytes = JSON.stringify({ payload, signature: createHmac("sha256", writer.key).update(JSON.stringify(payload)).digest("hex") }) + "\n";
  const relativePath = `${writer.request.requestId}/0${writer.index}-${stage}.json`;
  const start = performance.now();
  // Never retry a mutation after timeout/hold. Publish files only after its ACK.
  const result = await writer.inventory.appendStageIntent({ expectedHead: writer.head, ownerSha256: hash(writer.owner), relativePath, bytes });
  const intentMilliseconds = Math.round(performance.now() - start);
  await mkdir(join(writer.master, writer.request.requestId), { recursive: true });
  await durableFixtureFile(join(writer.master, relativePath), bytes);
  writer.head = result.head; writer.previous = bytes; writer.index++;
  return { masterId: writer.request.masterId, stage, intentMilliseconds, publishedMilliseconds: Math.round(performance.now() - start) };
}
async function closeWriter(writer, count) {
  const ownerPath = join(writer.master, "owner.lock");
  if (await readFile(ownerPath, "utf8") !== writer.owner) throw Error("Fixture owner changed; preserve it");
  await unlink(ownerPath);
  const audit = await writer.inventory.audit();
  if (audit.state !== "clean" || audit.artifactCount !== count || JSON.stringify(audit.head) !== JSON.stringify(writer.head)) throw Error("Published write audit not clean");
}
async function measureWrites(root, key, inventory, count) {
  const live = await writer(root, "master", key, inventory, count * 5);
  const measurements = [];
  for (const stage of ["requested", "old_idle", "start_dispatched", "bound", "completed"]) {
    try {
      const result = await appendPublished(live, stage); measurements.push(result);
      console.log(JSON.stringify({ mode: "sequential-stage", historyOperations: count, ...result }));
    } catch (error) {
      console.log(JSON.stringify({ mode: "sequential-stage", historyOperations: count, stage, state: "held/unknown; not retried", error: String(error) }));
      throw error;
    }
  }
  await closeWriter(live, count * 5 + 5);
  const other = new MasterConversationInventory({ root, masterId: "other" });
  await mkdir(join(root, "masters", "other")); await other.registerEmptyMaster(); await populate(root, "other", count);
  // Both selected Masters now have large histories. Each helper has its own eight-reader limit.
  const a = await writer(root, "master", key, inventory, count * 5 + 5);
  const b = await writer(root, "other", key, other, count * 5);
  const concurrent = [];
  for (const stage of ["requested", "cancelled"]) {
    const results = await Promise.allSettled([appendPublished(a, stage), appendPublished(b, stage)]);
    const rows = results.map((result, index) => result.status === "fulfilled" ? { ...result.value, state: "published" } : {
      masterId: index === 0 ? "master" : "other", stage, state: "held/unknown; not retried", error: String(result.reason) });
    concurrent.push(rows); console.log(JSON.stringify({ mode: "concurrent-stage", historyOperationsPerMaster: count, results: rows }));
    if (results.some(result => result.status === "rejected")) throw Error("Cross-Master mutation held; no retry or cancellation appended");
  }
  // Sequential verification avoids injecting a concurrent writer into final read evidence.
  await closeWriter(a, count * 5 + 7); await closeWriter(b, count * 5 + 2);
  console.log(JSON.stringify({ mode: "writes-complete", sequential: measurements, concurrent, selectedMasters: 2,
    databaseBytes: (await stat(inventory.databasePath)).size, finalAudits: ["clean", "clean"], platform: process.platform, node: process.version,
    scope: "public append API after full audit; acknowledged intent then create-only/fsync fixture stage; synthetic owner/provider; concurrent helper invocation, no guaranteed simultaneous SQLite write; no RPC/scheduler/turn/UI/power-loss claim" }));
}
let timeouts = 0;
for (const count of writes ? [1000] : [500, 1000]) {
  const dir = await mkdtemp(join(tmpdir(), "negi-inventory-")), root = join(dir, "authority");
  try {
    await mkdir(join(root, "masters", "master"), { recursive: true }); await mkdir(join(dir, "checkout"));
    const key = randomBytes(32);
    await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: key.toString("hex") }) + "\n");
    const inventory = new MasterConversationInventory({ root, masterId: "master" }); await inventory.initialize();
    await populate(root, "master", count);
    const times = [], results = [];
    for (let attempt = 0; attempt < (writes ? 1 : 3); attempt++) {
      const start = performance.now();
      try {
        const result = await inventory.audit(); times.push(Math.round(performance.now() - start)); results.push("clean");
        if (result.state !== "clean" || result.artifactCount !== count * 5) throw Error("Incomplete audit benchmark");
      } catch (error) {
        if (!String(error).includes("helper timeout")) throw error;
        times.push(Math.round(performance.now() - start)); results.push("timeout; no completed audit"); timeouts++;
      }
    }
    console.log(JSON.stringify({ operations: count, stages: count * 5, databaseBytes: (await stat(inventory.databasePath)).size,
      auditMilliseconds: times, auditResults: results, platform: process.platform, node: process.version,
      scope: "first/repeated subprocess full stage audit; synthetic DB batch builder; filesystem cache not cleared; excludes scheduler/turn/RPC/append cost" }));
    if (writes && results.every(result => result === "clean")) await measureWrites(root, key, inventory, count);
  } finally {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith("negi-inventory-")) throw Error("Unexpected cleanup target");
    await rm(dir, { recursive: true, force: true });
  }
}
if (timeouts) process.exitCode = 1;
