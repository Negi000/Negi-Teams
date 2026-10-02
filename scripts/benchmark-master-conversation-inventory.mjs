// Explicit synthetic audit benchmark; no providers and no product authority paths.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MasterConversationInventory } from "../src/server/orchestration/masterConversationInventory.ts";
const helper = resolve("test/helpers/masterConversationInventoryFixture.py");
let timeouts = 0;
for (const count of [500, 1000]) {
  const dir = await mkdtemp(join(tmpdir(), "negi-inventory-")), root = join(dir, "authority");
  try {
    await mkdir(join(root, "masters", "master"), { recursive: true }); await mkdir(join(dir, "checkout"));
    await writeFile(join(root, "signing-key.json"), JSON.stringify({ schemaVersion: "negi-master-conversation-key/1", key: randomBytes(32).toString("hex") }) + "\n");
    const inventory = new MasterConversationInventory({ root, masterId: "master" }); await inventory.initialize();
    await new Promise((accept, reject) => {
      const child = spawn("python", ["-B", helper], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; }); child.on("error", reject);
      child.on("close", code => code === 0 ? accept() : reject(Error(stderr))); child.stdin.end(JSON.stringify({ root, masterId: "master", count }));
    });
    const times = [], results = [];
    for (let attempt = 0; attempt < 3; attempt++) {
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
  } finally { await rm(dir, { recursive: true, force: true }); }
}
if (timeouts) process.exitCode = 1;
