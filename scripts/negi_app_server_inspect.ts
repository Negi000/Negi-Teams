// Read one saved provider turn status. This never clears a reconciliation stop.
import { resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";

const [executableArg, cwdArg, threadId, turnId] = process.argv.slice(2);
if (!executableArg || !cwdArg || !threadId || !turnId) {
  process.stderr.write("Usage: node --import tsx scripts/negi_app_server_inspect.ts <codex-exe> <cwd> <thread-id> <turn-id>\n");
  process.exitCode = 2;
} else {
  const processHandle = AppServerProcess.launch({ executable: resolve(executableArg),
    args: ["app-server", "--stdio"], cwd: resolve(cwdArg),
    client: { transportTimeoutMs: 20_000 } });
  try {
    await processHandle.client.initialize();
    const observation = await processHandle.client.inspectProviderTurn(threadId, turnId);
    process.stdout.write(JSON.stringify(observation, null, 2) + "\n");
    if (!observation.completeSearch) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Provider inspection failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await processHandle.stop();
  }
}
