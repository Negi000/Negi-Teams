// Reusable, explicit Astra -> Sol or read-only Luna Task Contract entry point.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { parseVaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import { executeVaultRun, prepareVaultRun, submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";

const path = process.argv[2];
if (!path || !isAbsolute(path) || process.argv.length !== 3) {
  process.stderr.write("Usage: node --import tsx scripts/negi_run_vault_task.ts <absolute-config.json>\n");
  process.exitCode = 2;
} else {
  const config = parseVaultRunConfig(JSON.parse(await readFile(path, "utf8")));
  if(config.taskMode==="integration_resolution")throw Error("Resolution must start through its restored contract/source admission service");
  const prepared = await prepareVaultRun(config);
  const scheduler = new FileScheduler(config.schedulerPath);
  await submitVaultRun(prepared, scheduler);
  const result = await executeVaultRun(prepared, scheduler);
  process.stdout.write(JSON.stringify({ runId: config.runId, taskId: prepared.contract.vaultId,
    ...(config.taskMode==="read_only_research"?{taskMode:config.taskMode,resultKind:"read-only-artifact",reviewAvailability:"not-registered"}:{}),
    status: result.status, schedulerStatus: (await scheduler.read()).state?.entries.find((entry) =>
      entry.work.id === config.runId)?.status, verification: result.verification, acceptedBy: result.acceptedBy,
    attempts: result.attempts.map((attempt) => ({ role: attempt.role,
      requestedModel: attempt.requestedModel, resolvedModel: attempt.resolvedModel,
      threadId: attempt.threadId, turnId: attempt.turnId, usage: attempt.usage })) }, null, 2) + "\n");
  if (result.status !== "ready_for_review") process.exitCode = 1;
}
