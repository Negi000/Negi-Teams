// Explicit bounded parallel catalog run; all provider work shares the same scheduler.
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { parseVaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import { prepareVaultRun, submitVaultRun, executeVaultRun, type PreparedVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { captureTaskReview } from "../src/server/orchestration/taskReviewArtifact.ts";
import type { TaskSnapshot } from "../src/server/orchestration/singleTask.ts";

export async function registerParallelReview(service:LocalTaskService,
  run:{title:string;configSha256:string;task:PreparedVaultRun},result:TaskSnapshot){
  if(result.status!=="ready_for_review")throw Error("Parallel review requires a verified completed Task");
  if(run.task.config.taskMode!=="read_only_research")await captureTaskReview(run.task.config,run.configSha256,run.title,result);
  return service.registerCompletedReview(run.task.config.runId);
}

async function json(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Parallel config paths must be absolute");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256_000) throw new Error("Parallel config type/size invalid");
  return JSON.parse(await readFile(path, "utf8"));
}
async function main(){
const [taskPath, reviewPath] = process.argv.slice(2);
if (!taskPath || !reviewPath || process.argv.length !== 4)
  throw new Error("Usage: node --import tsx scripts/negi_run_parallel_tasks.ts <absolute-tasks.json> <absolute-reviews.json>");
const catalog = await json(taskPath) as { runs: Array<{ title: string; config: unknown }> };
if(catalog.runs.some(run=>parseVaultRunConfig(run.config).taskMode==="integration_resolution"))
  throw Error("Resolution must start through its restored contract/source admission service");
const service = await LocalTaskService.open(catalog);
try {
  if (catalog.runs.length < 2 || catalog.runs.length > 3) throw new Error("Parallel run requires two or three registered Tasks");
  const reviews = await LocalReviewService.open(await json(reviewPath));
  await service.connectReviews(reviews);
  const prepared = [];
  for (const run of catalog.runs) {
    const config = parseVaultRunConfig(run.config), view = await service.snapshot(config.runId);
    if (!view.canStart) throw new Error("Parallel Task was already dispatched or requires reconciliation");
    prepared.push({ title: run.title, configSha256: view.configSha256, task: await prepareVaultRun(config) });
  }
  const scheduler = new FileScheduler(prepared[0].task.config.schedulerPath);
  const state = (await scheduler.read()).state;
  if (!state) await scheduler.append({ key: "parallel:configure", at: new Date().toISOString(), action: {
    type: "configure", maxConcurrent: prepared.length, budgetUsd: 0 } });
  else if (state.maxConcurrent < prepared.length || state.entries.some((entry) =>
    ["running", "needs_reconciliation"].includes(entry.status))) throw new Error("Parallel scheduler capacity/state not ready");
  for (const run of prepared) await submitVaultRun(run.task, scheduler);
  const results = await Promise.allSettled(prepared.map(async (run) => {
    const result = await executeVaultRun(run.task, scheduler);
    const review=result.status==="ready_for_review"?await registerParallelReview(service,run,result):null;
    return { runId: run.task.config.runId, status: result.status, acceptedBy: result.acceptedBy,
      verification: result.verification?.outcome ?? null,reviewId:review?.reviewId??null };
  }));
  process.stdout.write(JSON.stringify({ results: results.map((result) => result.status === "fulfilled" ?
    result.value : { status: "requires_inspection", error: String(result.reason) }), humanAcceptance: null }) + "\n");
  if (results.some((result) => result.status !== "fulfilled" || result.value.status !== "ready_for_review")) process.exitCode = 1;
} finally { await service.close(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
