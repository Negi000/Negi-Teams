// Two independent read-only Codex roles and a dependency-gated local integration.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { runScheduledReadOnlyTurn } from
  "../src/server/orchestration/scheduledReadOnlyTurn.ts";

const [exeRaw, solRaw, lunaRaw, logRaw, outRaw] = process.argv.slice(2);
if (!exeRaw || !solRaw || !lunaRaw || !logRaw || !outRaw) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase4_parallel_live.ts <codex-exe> <sol-checkout> <luna-checkout> <scheduler-jsonl> <output-dir>\n");
  process.exitCode = 2;
} else {
  const exe = resolve(exeRaw), solCwd = resolve(solRaw), lunaCwd = resolve(lunaRaw);
  const out = resolve(outRaw);
  const scheduler = new FileScheduler(resolve(logRaw));
  const status = (cwd: string) => execFileSync("git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd, encoding: "utf8", windowsHide: true });
  const beforeSol = status(solCwd), beforeLuna = status(lunaCwd);
  const handles: AppServerProcess[] = [];
  let integrationClaimed = false;
  try {
    await scheduler.append({ key: "config", at: new Date().toISOString(),
      action: { type: "configure", maxConcurrent: 2, budgetUsd: 0 } });
    for (const [id, role, cwd] of [
      ["sol-read", "sol", solCwd], ["luna-read", "luna", lunaCwd],
    ] as const) {
      await scheduler.append({ key: `submit-${id}`, at: new Date().toISOString(),
        action: { type: "submit", work: { id, parentId: null,
          dependencies: [], role, checkout: cwd, checkoutMode: "read",
          resources: [{ name: "phase4-baseline-source", mode: "read" }], reserveUsd: 0 } } });
    }
    await scheduler.append({ key: "submit-integration", at: new Date().toISOString(),
      action: { type: "submit", work: { id: "integration", parentId: null,
        dependencies: ["sol-read", "luna-read"], role: "astra", checkout: solCwd,
        checkoutMode: "read", resources: [{ name: "phase4-baseline-source", mode: "read" }],
        reserveUsd: 0 } } });
    const sol = AppServerProcess.launch({ executable: exe, args: ["app-server", "--stdio"],
      cwd: solCwd, client: { transportTimeoutMs: 20_000 } });
    handles.push(sol);
    const luna = AppServerProcess.launch({ executable: exe, args: ["app-server", "--stdio"],
      cwd: lunaCwd, client: { transportTimeoutMs: 20_000 } });
    handles.push(luna);
    const lunaSource = await readFile(join(lunaCwd, "src/server/index.ts"), "utf8");
    const spawnLines = lunaSource.split(/\r?\n/).flatMap((line, index) =>
      line.includes("registry.spawn(") ? [String(index + 1)] : []);
    if (spawnLines.length < 1) throw new Error("required registry.spawn source call missing");
    const settled = await Promise.allSettled([
      runScheduledReadOnlyTurn({ scheduler, dispatchKey: "dispatch-sol", workId: "sol-read",
        client: sol.client, cwd: solCwd, model: "gpt-6.1-sol", effort: "low",
        prompt: "src/server/master/index.ts と src/server/master/session.ts だけを読み、createMasterBrainとMasterSessionの接続点を短く列挙してください。指定外を調査せず、ファイル変更やエージェント起動をせず、推測は未確認と記してください。",
        artifactDir: out, timeoutMs: 120_000,
        verify: async (text) => text.includes("createMasterBrain") &&
          text.includes("MasterSession") && text.length < 10_000 && status(solCwd) === beforeSol }),
      runScheduledReadOnlyTurn({ scheduler, dispatchKey: "dispatch-luna", workId: "luna-read",
        client: luna.client, cwd: lunaCwd, model: "gpt-6-luna", effort: "low",
        prompt: "src/server/index.ts と src/server/agent.ts だけを読み、startMasterChatSessionとregistry.spawnの接続点を短く列挙してください。registry.spawnがある行番号を必ず添えてください。指定外を調査せず、ファイル変更やエージェント起動をせず、推測は未確認と記してください。",
        artifactDir: out, timeoutMs: 120_000,
        verify: async (text) => text.includes("startMasterChatSession") &&
          text.includes("registry.spawn") &&
          spawnLines.some((line) => text.includes(line)) &&
          !text.includes("registry.spawn` の呼び出しや `startMasterChatSession` からの直接接続は確認できませんでした") &&
          text.length < 10_000 && status(lunaCwd) === beforeLuna }),
    ]);
    if (settled.some((item) => item.status === "rejected"))
      throw new Error("one read-only turn failed; inspect scheduler and provider evidence");
    const outputs = settled.map((item) => {
      if (item.status !== "fulfilled") throw new Error("unreachable read-only failure");
      return item.value;
    });
    if (outputs.some((item) => item.status !== "verified") ||
        status(solCwd) !== beforeSol || status(lunaCwd) !== beforeLuna) {
      throw new Error("a read-only work item failed verification");
    }
    // Dependencies are checked again under the scheduler lock before integration.
    await scheduler.claim("integration", "dispatch-integration");
    integrationClaimed = true;
    const body: string[] = ["# Phase 4 read-only integration", ""];
    for (const [label, item] of [["Sol", outputs[0]], ["Luna", outputs[1]]] as const) {
      const marker = "#sha256=";
      const index = item.outputRef.lastIndexOf(marker);
      if (index < 0) throw new Error("artifact hash reference missing");
      const content = await readFile(item.outputRef.slice(0, index), "utf8");
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== item.outputRef.slice(index + marker.length))
        throw new Error("artifact changed before integration");
      body.push(`## ${label} (sha256=${digest})`, "", content.trim(), "");
    }
    body.push("Source observations only; no user acceptance or write integration is claimed.", "");
    const content = body.join("\n");
    await mkdir(out, { recursive: true });
    const output = join(out, "integration.md");
    const file = await open(output, "wx");
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    const digest = createHash("sha256").update(content).digest("hex");
    await scheduler.append({ key: "dispatch-integration:verified", at: new Date().toISOString(),
      action: { type: "settle", workId: "integration", outcome: "verified",
        evidenceRef: `${output}#sha256=${digest}`, actualCostUsd: null } });
    integrationClaimed = false;
    process.stdout.write(JSON.stringify({ statuses: (await scheduler.read()).state?.entries.map(
      (entry) => ({ id: entry.work.id, status: entry.status })),
      sol: { threadId: outputs[0].threadId, turnId: outputs[0].turnId,
        lastUsage: outputs[0].observation.lastUsage },
      luna: { threadId: outputs[1].threadId, turnId: outputs[1].turnId,
        lastUsage: outputs[1].observation.lastUsage },
      integration: `${output}#sha256=${digest}` }, null, 2) + "\n");
  } catch (error) {
    if (integrationClaimed) {
      try { await scheduler.append({ key: "dispatch-integration:unknown",
        at: new Date().toISOString(), action: { type: "unknown", workId: "integration",
          reason: "local integration failed after claim; inspect output before retry" } }); }
      catch { /* preserve current scheduler state for manual inspection */ }
    }
    process.stderr.write(`Phase 4 parallel trial failed: ${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await Promise.all(handles.map((handle) => handle.stop()));
  }
}
