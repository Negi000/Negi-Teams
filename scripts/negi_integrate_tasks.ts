// Integrate registered verified Tasks into a separate clean checkout. No model turn.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { appServerChildEnv } from "../src/server/master/appServerProcess.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { integrateVerifiedTasks } from "../src/server/orchestration/taskIntegration.ts";
import { parseVaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";

const exec = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function json(path: unknown): Promise<Record<string, unknown>> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Integration config paths must be absolute");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256_000) throw new Error("Integration config type/size invalid");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration config must be an object");
  return value;
}
const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error("Usage: node --import tsx scripts/negi_integrate_tasks.ts <absolute-integration.json>");
const options = await json(path);
if (typeof options.id !== "string" || typeof options.baseSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(options.baseSha) || !Array.isArray(options.sourceRunIds) ||
    options.sourceRunIds.length < 2 || options.sourceRunIds.length > 8 ||
    !options.sourceRunIds.every((id) => typeof id === "string") ||
    new Set(options.sourceRunIds).size !== options.sourceRunIds.length ||
    !Array.isArray(options.verification) || !options.verification.length)
  throw new Error("Integration identity, sources and checks invalid");
const service = await LocalTaskService.open(await json(options.taskCatalog));
try {
  const reviews = await LocalReviewService.open(await json(options.reviewCatalog));
  await service.connectReviews(reviews);
  const sources = [];
  for (const id of options.sourceRunIds as string[]) sources.push(await service.integrationSource(id));
  const config = parseVaultRunConfig({ ...sources[0].config, runId: options.id,
    checkout: options.checkout, outputDir: options.outputDir, resources: options.resources ?? [],
    verification: options.verification });
  config.checkout = await realpath(config.checkout);
  const scheduler = new FileScheduler(config.schedulerPath);
  await scheduler.append({ key: `${config.runId}:integration-submit`, at: new Date().toISOString(), action: {
    type: "submit", work: { id: config.runId, parentId: null,
      dependencies: options.sourceRunIds as string[], role: "sol", checkout: config.checkout,
      checkoutMode: "write", resources: config.resources.map((name) => ({ name, mode: "write" })), reserveUsd: 0 } } });
  const result = await integrateVerifiedTasks({ id: config.runId, checkout: config.checkout,
    baseSha: options.baseSha, outputDir: config.outputDir, sources, scheduler, verify: async () => {
      const checks = [];
      for (const command of [...config.verification, { requirement: "git diff --check",
        program: "git", args: ["diff", "--check"], timeoutMs: 30_000 }]) {
        try {
          const output = await exec(command.program, command.args, { cwd: config.checkout,
            encoding: "utf8", windowsHide: true, timeout: command.timeoutMs, maxBuffer: 1_000_000,
            env: appServerChildEnv() });
          checks.push({ ...command, passed: true, outputSha256: hash(output.stdout), stderrSha256: hash(output.stderr) });
        } catch { checks.push({ ...command, passed: false, outputSha256: null, stderrSha256: null }); }
      }
      const passed = checks.every((check) => check.passed);
      const bytes = Buffer.from(JSON.stringify({ checks, mechanicalChecksPassed: passed,
        humanAcceptance: null, modelTurnStarted: false }, null, 2) + "\n");
      const evidencePath = join(config.outputDir, "command-verification.json"), file = await open(evidencePath, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      return { outcome: passed ? "passed" : "failed", evidenceRef: `${evidencePath}#sha256=${hash(bytes)}` };
    } });
  process.stdout.write(JSON.stringify({ id: config.runId, ...result, modelTurnStarted: false }) + "\n");
  if (result.status !== "ready_for_review") process.exitCode = 1;
} finally { await service.close(); }
