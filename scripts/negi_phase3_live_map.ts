// One explicit subscription-backed Phase 3 vertical run in a clean checkout.
// The Task Contract, scheduler and model clients remain separate and auditable.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runScheduledVaultTask } from "../src/server/orchestration/scheduledVaultRun.ts";

const [executableArg, checkoutArg, vaultArg, snapshotArg, outArg,
  schedulerArg, runId] = process.argv.slice(2);
if (!executableArg || !checkoutArg || !vaultArg || !snapshotArg || !outArg ||
    !schedulerArg || !runId) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase3_live_map.ts <codex-exe> <clean-checkout> <vault> <contract-json> <out-dir> <scheduler-jsonl> <run-id>\n");
  process.exitCode = 2;
} else {
  const executable = resolve(executableArg);
  const checkout = resolve(checkoutArg);
  const vault = resolve(vaultArg);
  const snapshot = resolve(snapshotArg);
  const out = resolve(outArg);
  const dispatchKey = `${runId}:dispatch-1`;
  await mkdir(out, { recursive: true });
  const scheduler = new FileScheduler(resolve(schedulerArg));
  const ledger = new FileTaskLedger(join(out, "run.jsonl"));
  if ((await scheduler.read()).state === null) {
    await scheduler.append({ key: "negi-phase3-live:configure", at: new Date().toISOString(),
      action: { type: "configure", maxConcurrent: 1, budgetUsd: 0 } });
  }
  const configuration = (await scheduler.read()).state;
  if (configuration?.maxConcurrent !== 1 || configuration.budgetUsd !== 0) {
    throw new Error("live run requires the reviewed single-slot subscription scheduler");
  }
  await scheduler.append({ key: `${runId}:submit`, at: new Date().toISOString(),
    action: { type: "submit", work: { id: runId, parentId: null, dependencies: [],
      role: "sol", checkout, checkoutMode: "write", resources: [], reserveUsd: 0 } } });
  const astraProcess = AppServerProcess.launch({ executable, args: ["app-server", "--stdio"],
    cwd: checkout, client: { transportTimeoutMs: 20_000 } });
  const solProcess = AppServerProcess.launch({ executable, args: ["app-server", "--stdio"],
    cwd: checkout, client: { transportTimeoutMs: 20_000 } });
  try {
    const result = await runScheduledVaultTask({ scheduler, dispatchKey,
      run: { runId, cwd: checkout, vaultDirectory: vault, snapshotPath: snapshot,
        ledger, artifactDir: join(out, "artifacts"), turnTimeoutMs: 600_000,
        astra: { client: astraProcess.client, model: "gpt-6-astra", effort: "low" },
        sol: { client: solProcess.client, model: "gpt-6.1-sol", effort: "low" },
        verify: async () => {
          const relative = "docs/negi-teams-integration-map.md";
          const target = join(checkout, relative);
          let content: string;
          try { content = await readFile(target, "utf8"); }
          catch { return { outcome: "failed", evidenceRef: "local:expected-document-missing" }; }
          const size = (await stat(target)).size;
          const status = execFileSync("git", ["status", "--short", "--untracked-files=all"],
            { cwd: checkout, windowsHide: true, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
          const refs = ["src/server/index.ts", "src/server/master/index.ts",
            "src/server/master/session.ts", "src/server/agent.ts",
            "src/server/backends/codex.ts"];
          const allRefs = refs.every((ref) => content.includes(ref));
          const onlyExpectedPath = status.length === 1 && status[0] === `?? ${relative}`;
          const lineCount = content.split(/\r?\n/).length;
          const passed = size > 300 && size < 30_000 && lineCount <= 81 && allRefs && onlyExpectedPath &&
            !/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}/.test(content);
          const evidence = { path: relative, size, sha256: createHash("sha256").update(content).digest("hex"),
            lineCount, status, requiredCodeRefsPresent: allRefs, onlyExpectedPath,
            mechanicalCheckPassed: passed };
          const evidenceFile = join(out, "verification.json");
          const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n");
          const file = await open(evidenceFile, "wx");
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          return { outcome: passed ? "passed" : "failed",
            evidenceRef: `${evidenceFile}#sha256=${createHash("sha256").update(bytes).digest("hex")}` };
        },
      } });
    process.stdout.write(JSON.stringify({ runId, status: result.status,
      schedulerStatus: (await scheduler.read()).state?.entries.find((entry) =>
        entry.work.id === runId)?.status,
      attempts: result.attempts.map((attempt) => ({ role: attempt.role,
        state: attempt.state, requestedModel: attempt.requestedModel,
        resolvedModel: attempt.resolvedModel, threadId: attempt.threadId,
        turnId: attempt.turnId, usage: attempt.usage })),
      verification: result.verification, acceptedBy: result.acceptedBy }, null, 2) + "\n");
    if (result.status !== "ready_for_review") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Phase 3 live run stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([astraProcess.stop(), solProcess.stop()]);
  }
}
