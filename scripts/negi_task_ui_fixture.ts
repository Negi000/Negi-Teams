// Disposable browser QA. Uses synthetic turns only; never starts a model.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { buildAuthCookie, loginPageHtml, tokenMatches } from "../src/server/auth.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { createTaskHttp } from "../src/server/orchestration/taskHttp.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { createReviewHttp } from "../src/server/orchestration/reviewHttp.ts";
import { FileTaskLedger, type TaskAction } from "../src/server/orchestration/singleTask.ts";
import { submitVaultRun, type PreparedVaultRun, type TaskExecutionHooks,
  type TaskOperationApproval } from "../src/server/orchestration/vaultTaskExecution.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import type { VaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";
import type { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const [root, portArg] = process.argv.slice(2), port = Number(portArg);
if (!root || !isAbsolute(root) || !Number.isSafeInteger(port) || port < 1024 || port > 65535 || process.argv.length !== 4)
  throw new Error("Usage: node --import tsx scripts/negi_task_ui_fixture.ts <new-absolute-QA-root> <local-port>");
await mkdir(root);
const checkout = join(root, "synthetic-checkout"), vault = join(root, "synthetic-vault");
await mkdir(checkout); await mkdir(vault); await mkdir(join(checkout, "docs"));
const git = (args: string[]) => execFileSync("git", args,
  { cwd: checkout, encoding: "utf8", windowsHide: true }).trim();
git(["init", "--quiet"]); git(["config", "user.name", "Synthetic QA"]);
git(["config", "user.email", "synthetic@example.invalid"]); git(["config", "core.autocrlf", "false"]);
await writeFile(join(checkout, "docs", "base.md"), "Synthetic browser QA baseline\n");
git(["add", "."]); git(["commit", "--quiet", "-m", "synthetic QA baseline"]);
const contract: VaultTaskContract = { schemaVersion: "negi-task-contract/1", vaultId: "NT-TASK-UI-QA",
  version: 1, sha256: "a".repeat(64), project: "画面試験専用", objective: "合成Taskの確認・承認・受入・取消の画面を通す",
  acceptance: ["合成結果を表示できる", "実作業の受入として扱わない"], baseSha: git(["rev-parse", "HEAD"]),
  scope: { in: ["合成fixture"], out: ["実モデル起動", "外部送信", "実作業の受入"], allowedPaths: ["docs/result.md"] },
  invariants: ["既存ユーザーの作業を変更しない"], verification: ["合成ファイルのhashが一致"],
  escalation: ["実作業へ混同しない"], limits: { maxAttempts: 1, timeLimitMinutes: 5 }, sourceNotes: [] };
const snapshot = join(root, "synthetic-task.json"); await writeFile(snapshot, JSON.stringify(contract));
const config: VaultRunConfig = { executable: process.execPath, checkout, vault, snapshot,
  outputDir: join(root, "synthetic-output"), schedulerPath: join(root, "scheduler.jsonl"), runId: "synthetic-ui-task",
  astra: { model: "gpt-6-astra", effort: "low" }, sol: { model: "gpt-6.1-sol", effort: "low" }, resources: [],
  verification: [{ requirement: contract.verification[0], program: "node", args: ["--version"], timeoutMs: 5000 }] };
const catalog = { stateRoot: join(root, "task-state"), runs: [{ title: "画面試験専用の合成Task", config }] };
const service = await LocalTaskService.open(catalog, { prepare: async (config) => ({ config, contract }),
  submit: submitVaultRun, execute: async (prepared: PreparedVaultRun, scheduler: FileScheduler,
    signal?: AbortSignal, hooks?: TaskExecutionHooks) => {
    if (!hooks) throw new Error("Synthetic approval handler missing");
    await scheduler.claim(config.runId, `${config.runId}:synthetic-dispatch`);
    const ledger = new FileTaskLedger(join(config.outputDir, "run.jsonl"), Date.now, undefined, undefined, hooks.verifyApproval);
    let sequence = 0;
    const append = (action: TaskAction) => ledger.append({ key: `synthetic-${sequence++}`, at: new Date().toISOString(), action });
    await append({ type: "create", runId: config.runId, contract });
    await append({ type: "start_attempt", role: "astra", attemptId: "synthetic-astra", requestedModel: config.astra.model });
    await append({ type: "bind_provider", attemptId: "synthetic-astra", threadId: "synthetic-thread-a", turnId: "synthetic-turn-a" });
    await append({ type: "complete_attempt", attemptId: "synthetic-astra", resolvedModel: config.astra.model,
      threadId: "synthetic-thread-a", turnId: "synthetic-turn-a", outputRef: "synthetic:no-model-plan" });
    await append({ type: "start_attempt", role: "sol", attemptId: "synthetic-sol", requestedModel: config.sol.model });
    await append({ type: "bind_provider", attemptId: "synthetic-sol", threadId: "synthetic-thread-s", turnId: "synthetic-turn-s" });
    const approval: TaskOperationApproval = { id: "synthetic-operation", attemptId: "synthetic-sol", threadId: "synthetic-thread-s",
      turnId: "synthetic-turn-s", operation: "item/fileChange/requestApproval", target: join(checkout, "docs", "result.md"),
      targetKnown: true, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    await append({ type: "request_approval", approval });
    let release!: () => void, decision: "allow" | "deny" | null = null;
    const response = new Promise<void>((resolve) => { release = resolve; });
    signal?.addEventListener("abort", () => release(), { once: true });
    hooks.onApproval(approval, async (allow, approvalRef, at, id) => {
      await ledger.append({ key: `task-operation:${id}`, at, action: { type: "decide_approval", approvalId: approval.id,
        attemptId: approval.attemptId, threadId: approval.threadId, turnId: approval.turnId,
        operation: approval.operation, target: approval.target, decision: allow ? "allow" : "deny", approvalRef } });
      decision = allow ? "allow" : "deny"; release();
    });
    await response;
    if (signal?.aborted) throw new Error("Synthetic Task interrupted");
    const content = "# 画面試験専用の合成成果\n\n実モデルは起動していません。実ユーザーの実作業受入ではありません。\n";
    await writeFile(join(checkout, "docs", "result.md"), content);
    await append({ type: "complete_attempt", attemptId: "synthetic-sol", resolvedModel: prepared.config.sol.model,
      threadId: "synthetic-thread-s", turnId: "synthetic-turn-s", outputRef: "synthetic:no-model-result" });
    const bytes = Buffer.from(JSON.stringify({ synthetic: true, operationDecision: decision, modelTurnStarted: false,
      resultSha256: createHash("sha256").update(content).digest("hex"), mechanicalChecksPassed: true }) + "\n");
    const evidencePath = join(config.outputDir, "verification.json"); await writeFile(evidencePath, bytes);
    const evidenceRef = `${evidencePath}#sha256=${createHash("sha256").update(bytes).digest("hex")}`;
    const result = await append({ type: "verify", outcome: "passed", evidenceRef });
    await scheduler.append({ key: "synthetic-settle", at: new Date().toISOString(), action: {
      type: "settle", workId: config.runId, outcome: "verified", evidenceRef, actualCostUsd: null } });
    return result;
  } });
const reviews = await LocalReviewService.open({ storageRoot: join(root, "human-reviews"), writableRoots: [checkout], cases: [] });
await service.connectReviews(reviews);
const token = "synthetic-task-browser-qa-only", taskApi = createTaskHttp(service, { token }), reviewApi = createReviewHttp(reviews, { token });
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(loginPageHtml(url.searchParams.get("returnTo") ?? "/")); return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!tokenMatches(value.token ?? "", token)) { res.writeHead(403); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": buildAuthCookie(token, false) }); res.end("{}"); return;
    }
    if (await taskApi(req, res, url) || await reviewApi(req, res, url)) return;
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<h1>画面試験専用のチーム入口</h1><p>実モデル・実作業はありません。</p><a href="/tasks">Task実行</a> <a href="/reviews">成果レビュー</a>');
  } catch { res.writeHead(500); res.end("Synthetic fixture request failed"); }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${port}/tasks`,
  syntheticToken: token, root, modelTurnStarted: false }) + "\n"));
async function stop() { await service.close(); server.close(() => process.exit(0)); }
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
