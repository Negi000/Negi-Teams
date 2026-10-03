// Register an already applied local correction; no model turn or human approval is created.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";

const [taskConfig, reviewConfig, runId, ...feedbackIds] = process.argv.slice(2);
if (!taskConfig || !reviewConfig || !runId || !isAbsolute(taskConfig) || !isAbsolute(reviewConfig) || !feedbackIds.length)
  throw new Error("Usage: node --import tsx scripts/negi_register_task_revision.ts <absolute-tasks.json> <absolute-reviews.json> <run-id> <feedback-id> [...]");
async function config(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > 256_000) throw new Error("Local configuration exceeds its size limit");
  return JSON.parse(bytes.toString("utf8"));
}
const service = await LocalTaskService.open(await config(taskConfig));
try {
  const reviews = await LocalReviewService.open(await config(reviewConfig));
  await service.connectReviews(reviews);
  const before = await service.snapshot(runId);
  const result = await service.registerResultRevision(runId, before.configSha256, feedbackIds);
  process.stdout.write(JSON.stringify({ runId, status: result.status, resultRevisionCount: result.resultRevisionCount,
    acceptedBy: result.acceptedBy, verification: result.verificationOutcome, modelTurnStarted: false }) + "\n");
} finally { await service.close(); }
