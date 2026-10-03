// Explicit one-turn read-only App Server smoke. No repository edits requested.
import { resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";

const executable = process.argv[2];
const cwd = process.argv[3];
const model = process.argv[4] ?? "gpt-6-astra";
const effort = process.argv[5] ?? "low";
if (!executable || !cwd) {
  process.stderr.write("Usage: node --import tsx scripts/negi_app_server_smoke.ts <codex-exe> <cwd> [model] [effort]\n");
  process.exitCode = 2;
} else {
  const processHandle = AppServerProcess.launch({ executable: resolve(executable),
    args: ["app-server", "--stdio"], cwd: resolve(cwd),
    client: { transportTimeoutMs: 20_000 } });
  try {
    await processHandle.client.initialize();
    const catalog = await processHandle.client.discoverModels();
    if (!catalog.some((item) => item.model === model && item.efforts.includes(effort))) {
      throw new Error("requested model/effort unavailable in account catalog");
    }
    const thread = await processHandle.client.startThread({ cwd: resolve(cwd), model,
      sandbox: "read-only", instructions: "This is a transport smoke test. Do not use tools or edit files." });
    if (thread.rerouted) throw new Error("provider changed the requested model");
    const turnId = await processHandle.client.startTurn("Reply with exactly: NEGI_APP_SERVER_OK", effort);
    const observation = await processHandle.client.waitForTurn(turnId, 90_000);
    process.stdout.write(JSON.stringify({ threadId: thread.threadId, turnId,
      requestedModel: thread.requestedModel, resolvedModel: thread.resolvedModel,
      status: observation.status, matchedExpectedText: observation.finalText?.trim() === "NEGI_APP_SERVER_OK",
      finalTextPresent: observation.finalText !== null,
      contextInputTokens: observation.contextInputTokens,
      contextWindow: observation.contextWindow, lastUsage: observation.lastUsage }, null, 2) + "\n");
    if (observation.status !== "completed" || observation.finalText?.trim() !== "NEGI_APP_SERVER_OK") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`App Server smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await processHandle.stop();
  }
}
