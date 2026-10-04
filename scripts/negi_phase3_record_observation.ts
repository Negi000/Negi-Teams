// Record a read-only provider turn inspection for a stopped local run.
import { resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { recordUnknownProviderTurn } from "../src/server/orchestration/providerObservation.ts";

const [executableArg, cwdArg, ledgerArg, attemptId, eventKey] = process.argv.slice(2);
if (!executableArg || !cwdArg || !ledgerArg || !attemptId || !eventKey) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase3_record_observation.ts <codex-exe> <cwd> <ledger> <attempt-id> <event-key>\n");
  process.exitCode = 2;
} else {
  const ledger = new FileTaskLedger(resolve(ledgerArg));
  const processHandle = AppServerProcess.launch({ executable: resolve(executableArg),
    args: ["app-server", "--stdio"], cwd: resolve(cwdArg),
    client: { transportTimeoutMs: 20_000 } });
  try {
    await processHandle.client.initialize();
    const result = await recordUnknownProviderTurn(ledger, attemptId,
      processHandle.client, eventKey);
    process.stdout.write(JSON.stringify(result.providerObservations.at(-1), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`Provider observation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await processHandle.stop();
  }
}
