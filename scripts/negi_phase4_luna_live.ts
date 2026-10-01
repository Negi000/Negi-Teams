// One bounded Luna read-only survey through the shared scheduler.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { runScheduledReadOnlyTurn } from
  "../src/server/orchestration/scheduledReadOnlyTurn.ts";

const [executableRaw, checkoutRaw, ledgerRaw, outputRaw] = process.argv.slice(2);
if (!executableRaw || !checkoutRaw || !ledgerRaw || !outputRaw) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase4_luna_live.ts <codex-exe> <checkout> <scheduler-jsonl> <output-dir>\n");
  process.exitCode = 2;
} else {
  const executable = resolve(executableRaw);
  const checkout = resolve(checkoutRaw);
  const scheduler = new FileScheduler(resolve(ledgerRaw));
  const workId = "negi-phase4-luna-read-1";
  const gitStatus = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
    { cwd: checkout, encoding: "utf8", windowsHide: true });
  let processHandle: AppServerProcess | null = null;
  try {
    const before = gitStatus();
    await scheduler.append({ key: "config", at: new Date().toISOString(),
      action: { type: "configure", maxConcurrent: 2, budgetUsd: 0 } });
    await scheduler.append({ key: "submit-luna", at: new Date().toISOString(),
      action: { type: "submit", work: { id: workId, parentId: null,
        dependencies: [], role: "luna", checkout, checkoutMode: "read",
        resources: [{ name: "source:master-brain-map", mode: "read" }], reserveUsd: 0 } } });
    processHandle = AppServerProcess.launch({ executable,
      args: ["app-server", "--stdio"], cwd: checkout,
      client: { transportTimeoutMs: 20_000 } });
    const result = await runScheduledReadOnlyTurn({ scheduler,
      dispatchKey: "dispatch-luna-1", workId, client: processHandle.client,
      cwd: checkout, model: "gpt-6-luna", effort: "low",
      prompt: "次の2ファイルだけを読み、Codex App Server接続に関係する既存のシンボルを短く列挙してください: src/server/master/index.ts と src/server/master/session.ts。createMasterBrainとMasterSessionに触れ、推測は未確認と記してください。ファイル変更やエージェント起動は禁止。",
      artifactDir: resolve(outputRaw), timeoutMs: 120_000,
      verify: async (text) => text.includes("createMasterBrain") &&
        text.includes("MasterSession") && text.length < 10_000 && gitStatus() === before });
    process.stdout.write(JSON.stringify({ workId, status: result.status,
      threadId: result.threadId, turnId: result.turnId,
      outputRef: result.outputRef, lastUsage: result.observation.lastUsage,
      checkoutUnchanged: gitStatus() === before }, null, 2) + "\n");
    if (result.status !== "verified") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Phase 4 Luna trial failed: ${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (processHandle) await processHandle.stop();
  }
}
