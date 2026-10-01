import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Script } from "node:vm";
import { FileReviewChain } from "../src/server/orchestration/reviewChain.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalKnowledgeService } from "../src/server/orchestration/knowledgeService.ts";
import { createKnowledgeHttp } from "../src/server/orchestration/knowledgeHttp.ts";
import { knowledgePageHtml } from "../src/server/orchestration/knowledgePage.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { runSingleTaskFromVault, type VaultTaskContract } from "../src/server/orchestration/vaultTaskContract.ts";
import { submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import { appServerChildEnv } from "../src/server/master/appServerProcess.ts";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const exporter = fileURLToPath(new URL("../scripts/negi_task_contract.py", import.meta.url));
const compiler = fileURLToPath(new URL("../scripts/negi_vault.py", import.meta.url));
const learned = { title: "説明の根拠を残す", taskClass: "code-attribution", recommendation: "根拠として関数とファイルを記す。",
  nonApplicability: "コードを調べない文章作業には適用しない。", counterexample: "短い創作文ではコード位置の注記を増やさない。" };
function note(id: string, kind: string, body: string, extra = "") {
  return `---\nid: ${id}\nkind: ${kind}\nproject: fixture\nscope: project\nstatus: active\nversion: 1\n` +
    `updated: 2026-10-01\nsensitivity: local\nsource_refs:\n  - user:synthetic\n${extra}---\n${body}\n`;
}
async function fixture(run: (data: {
  dir: string; vault: string; checkout: string; proof: string; service: LocalKnowledgeService;
  tasks: LocalTaskService; reviews: LocalReviewService; reviewConfig: unknown; catalog: unknown;
  artifactSha256: string; pack: (taskClass?: string, authority?: boolean) => string;
  prompts: string[]; nextSnapshot: string;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-knowledge-"));
  let tasks: LocalTaskService | undefined;
  try {
    const vault = join(dir, "Vault"), checkout = join(dir, "checkout"), proof = join(dir, "knowledge");
    await mkdir(join(vault, "10_Projects"), { recursive: true }); await mkdir(join(vault, "80_Tasks"));
    await mkdir(checkout);
    execFileSync("git", ["init", "-q"], { cwd: checkout, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
      "commit", "--allow-empty", "-qm", "synthetic fixture"], { cwd: checkout, windowsHide: true });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", windowsHide: true }).trim();
    await writeFile(join(vault, "10_Projects", "spec.md"), note("SPEC-FIXTURE", "Spec", "必須の検証条件を省略しない。", "required: true\n"));
    const contractBody = "```negi-task-contract\n" + JSON.stringify({ objective: "根拠としてコードを説明する",
      in_scope: ["説明を作る"], out_of_scope: ["公開しない"], allowed_paths: ["docs/result.md"],
      invariants: ["検証条件を維持する"], acceptance: ["別の明示受入が必要"], verification: ["合成検証"],
      escalation: ["不明なら停止"], base_sha: base, max_attempts: 1, time_limit_minutes: 5 }) + "\n```";
    const snapshots = [];
    for (const id of ["TASK-ORIGIN", "TASK-NEXT"]) {
      await writeFile(join(vault, "80_Tasks", `${id}.md`), note(id, "Task", contractBody,
        "task_class: code-attribution\napproval_ref: user:synthetic\ndepends_on:\n  - SPEC-FIXTURE\n"));
      const snapshot = join(dir, `${id}.json`);
      execFileSync("python", [exporter, "--vault", vault, "--id", id, "--project", "fixture", "--out", snapshot],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      snapshots.push(snapshot);
    }
    const runs = snapshots.map((snapshot, i) => ({ title: i ? "次の合成Task" : "根拠となる合成Task", config: {
      executable: process.execPath, checkout, vault, snapshot, outputDir: join(dir, `run-${i}`),
      schedulerPath: join(dir, "scheduler.jsonl"), runId: i ? "next-run" : "origin-run",
      astra: { model: "gpt-6-astra", effort: "low" }, sol: { model: "gpt-6.1-sol", effort: "low" }, resources: [],
      verification: [{ requirement: "synthetic", program: process.execPath, args: ["--version"], timeoutMs: 5000 }] } }));
    const catalog = { stateRoot: join(dir, "task-state"), runs };
    const prompts: string[] = [];
    const fake = (model: string) => ({ initialize: async () => {},
      discoverModels: async () => [{ model, efforts: ["low"], inputModalities: ["text"] }],
      startThread: async () => ({ threadId: `thread-${model}`, requestedModel: model, resolvedModel: model,
        modelProvider: "mock", rerouted: false }),
      startTurn: async (text: string) => { prompts.push(text); return `turn-${model}`; },
      waitForTurn: async (turnId: string) => ({ turnId, status: "completed" as const, finalText: "Synthetic result",
        contextInputTokens: null, contextWindow: null, lastUsage: null }) });
    tasks = await LocalTaskService.open(catalog, {
      prepare: async config => ({ config, contract: JSON.parse(await readFile(config.snapshot, "utf8")) as VaultTaskContract }),
      submit: submitVaultRun,
      execute: async (prepared, scheduler, _signal, hooks) => {
        const { config } = prepared;
        await scheduler.claim(config.runId, `${config.runId}:dispatch`);
        const result = await runSingleTaskFromVault({ runId: config.runId, vaultDirectory: vault,
          snapshotPath: config.snapshot, cwd: checkout, artifactDir: join(config.outputDir, "artifacts"),
          ledger: new FileTaskLedger(join(config.outputDir, "run.jsonl")), turnTimeoutMs: 1000,
          astra: { client: fake(config.astra.model), ...config.astra }, sol: { client: fake(config.sol.model), ...config.sol },
          knowledgeProofDirectory: hooks?.knowledgeProofDirectory,
          verify: async () => ({ outcome: "passed", evidenceRef: "synthetic:next-context" }) });
        await scheduler.append({ key: `${config.runId}:settle`, at: new Date().toISOString(), action: {
          type: "settle", workId: config.runId, outcome: "verified", evidenceRef: "synthetic:next-context", actualCostUsd: null } });
        return result;
      } });
    const artifactRoot = join(dir, "artifacts"); await mkdir(artifactRoot);
    const artifact = join(artifactRoot, "result.md"), evidence = join(dir, "verification.json"), ledger = join(dir, "review.jsonl");
    const content = "# 合成成果\n根拠としてコードを説明する。\n", check = '{"synthetic":true}\n';
    await writeFile(artifact, content); await writeFile(evidence, check);
    const artifactSha256 = hash(content), chain = new FileReviewChain(ledger);
    await chain.append({ key: "create", at: new Date().toISOString(), action: { type: "create", caseId: "synthetic",
      runId: "origin-run", artifact: { ref: artifact, sha256: artifactSha256, objectiveId: "TASK-ORIGIN" } } });
    await chain.append({ key: "verify", at: new Date().toISOString(), action: { type: "verify", artifactSha256,
      evidenceRef: evidence, outcome: "passed" } });
    const reviewConfig = { storageRoot: join(dir, "human-review"), writableRoots: [checkout], cases: [{ id: "synthetic",
      title: "合成の根拠説明", ledgerPath: ledger, artifactRoot, verifiedArtifactSha256: artifactSha256,
      evidencePath: evidence, evidenceSha256: hash(check), verificationSummary: "合成検証のみ", limits: "実際の人の受入ではない" }] };
    const reviews = await LocalReviewService.open(reviewConfig);
    const service = await LocalKnowledgeService.open({ storageRoot: proof }, tasks, reviews);
    const pack = (taskClass?: string, authority = true) => execFileSync("python", [compiler, "--vault", vault,
      "pack", "--project", "fixture", "--role", "sol", "--query", "根拠", "--require", "TASK-NEXT", "--stdout",
      ...(taskClass ? ["--task-class", taskClass] : []), ...(authority ? ["--knowledge-proof-dir", proof] : [])],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    await run({ dir, vault, checkout, proof, service, tasks, reviews, reviewConfig, catalog, artifactSha256, pack, prompts,
      nextSnapshot: snapshots[1] });
  } finally { await tasks?.close(); await rm(dir, { recursive: true, force: true }); }
}
async function candidate(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const requestId = randomUUID();
  const view = await f.reviews.feedback("synthetic", { artifactSha256: f.artifactSha256, requestId,
    text: "良い説明です。ただ、コードの根拠も書いてください。<script>alert(1)</script>", kind: "unclear", scope: "future_preference" });
  assert.equal(view.status, "awaiting_review"); assert.equal(view.knowledge?.candidates.length, 1);
  let row = (await f.service.list())[0];
  row = await f.service.decide(row.id, "revise", { requestId: randomUUID(), expectedSha256: row.sha256, fields: learned });
  return row;
}

test("signed feedback becomes a scoped candidate, explicit knowledge approval reaches the next scheduled Task", async () => {
  await fixture(async f => {
    let row = await candidate(f);
    assert.equal(row.status, "candidate"); assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    row = await f.service.decide(row.id, "activate", { requestId: randomUUID(), expectedSha256: row.sha256 });
    const pack = f.pack("code-attribution");
    assert.match(pack, /必須の検証条件を省略しない/); assert.match(pack, /TASK-NEXT/);
    assert.match(pack, /短い創作文/); assert.match(pack, /効果は未測定/);
    assert.match(pack, /<script>alert\(1\)<\/script>/); // literal evidence, never HTML
    for (const className of [undefined, "other"]) assert.doesNotMatch(f.pack(className), /NT-LESSON-/);
    assert.doesNotMatch(f.pack("code-attribution", false), /NT-LESSON-/);
    assert.equal((await f.reviews.snapshot("synthetic")).status, "awaiting_review");
    const next = await f.tasks.snapshot("next-run");
    await f.tasks.start(next.id, next.configSha256, randomUUID());
    const deadline = Date.now() + 15_000;
    while (true) {
      const state = await f.tasks.snapshot(next.id);
      if (!state.live && state.status === "ready_for_review") break;
      if (Date.now() > deadline) throw new Error(`Next Task did not settle: ${state.status} / ${state.error}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(f.prompts.length, 2); for (const prompt of f.prompts) assert.match(prompt, /根拠として関数とファイルを記す/);
    assert.equal((await f.tasks.snapshot(next.id)).acceptedBy, null);
    const refs = (await new FileTaskLedger(join(f.dir, "run-1", "run.jsonl")).read()).state!.contract.contextPacks!;
    const preserved = await readFile(refs.sol.path);
    await f.service.decide(row.id, "deprecate", { requestId: randomUUID(), expectedSha256: row.sha256, reason: "合成テストで失効" });
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    assert.deepEqual(await readFile(refs.sol.path), preserved);
  });
});

test("active edits require reapproval; source edits, old-byte rollback, forged receipts and concurrent CAS fail closed", async () => {
  await fixture(async f => {
    let row = await candidate(f);
    const request = { requestId: randomUUID(), expectedSha256: row.sha256 };
    row = await f.service.decide(row.id, "activate", request);
    assert.equal((await f.service.decide(row.id, "activate", request)).sha256, row.sha256);
    await assert.rejects(f.service.decide(row.id, "deprecate", { ...request, reason: "other operation" }), /reused/);
    const old = row.content, path = join(f.vault, "40_Lessons", `${row.id}.md`);
    const outcomes = await Promise.allSettled([1, 2].map(i => f.service.decide(row.id, "revise", {
      requestId: randomUUID(), expectedSha256: row.sha256, fields: { ...learned, title: `改訂${i}` } })));
    assert.equal(outcomes.filter(v => v.status === "fulfilled").length, 1);
    row = (await f.service.list())[0]; assert.equal(row.status, "candidate");
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    row = await f.service.decide(row.id, "activate", { requestId: randomUUID(), expectedSha256: row.sha256 });
    const source = join(f.vault, "10_Projects", "spec.md"), bytes = await readFile(source);
    await writeFile(source, bytes.toString("utf8") + "手編集\n");
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    assert.equal((await f.service.list())[0].sourcesCurrent, false);
    await writeFile(source, bytes);
    row = await f.service.decide(row.id, "deprecate", { requestId: randomUUID(), expectedSha256: row.sha256, reason: "古い希望" });
    await writeFile(path, old.replace(/^approval_ref:.*$/m, 'approval_ref: "user:manual"')
      .replace(/^  - "negi-knowledge:.*\n/m, ""));
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    assert.doesNotMatch(f.pack("code-attribution", false), /NT-LESSON-/);
    assert.equal((await f.service.list())[0].exact, false);
    const receipt = join(f.proof, `${row.history.at(-1)!.id}.json`);
    const data = JSON.parse(await readFile(receipt, "utf8")); data.receipt.data.op = "activate";
    await writeFile(receipt, JSON.stringify(data));
    assert.throws(() => f.pack("code-attribution"), /Knowledge/);
  });
});

test("signed pending write recovers on restart, hand edits are preserved, agent feedback and unsafe storage are rejected", async () => {
  await fixture(async f => {
    let row = await candidate(f);
    const before = row.content;
    row = await f.service.decide(row.id, "activate", { requestId: randomUUID(), expectedSha256: row.sha256 });
    const path = join(f.vault, "40_Lessons", `${row.id}.md`);
    await writeFile(path, before); // simulate receipt fsynced but note not replaced
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    const reopened = await LocalKnowledgeService.open({ storageRoot: f.proof }, f.tasks, f.reviews);
    assert.equal((await reopened.list())[0].exact, true); assert.match(f.pack("code-attribution"), /NT-LESSON-/);
    await writeFile(path, row.content + "手編集を保持する\n");
    await LocalKnowledgeService.open({ storageRoot: f.proof }, f.tasks, f.reviews);
    assert.match(await readFile(path, "utf8"), /手編集を保持する/);
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    await assert.rejects(reopened.capture("synthetic", "agent-feedback:fake"), /Authenticated/);
    await assert.rejects(LocalKnowledgeService.open({ storageRoot: join(f.vault, "signing") }, f.tasks, f.reviews), /separate/);
    await assert.rejects(LocalKnowledgeService.open({ storageRoot: join(f.checkout, "signing") }, f.tasks, f.reviews), /separate/);
  });
});

test("knowledge HTTP requires cookie, same-origin and bounded JSON; page scripts parse and secrets stay out of model env", async () => {
  const html = knowledgePageHtml();
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(match[1]));
  for (const match of html.matchAll(/pattern="([^"]+)"/g)) assert.doesNotThrow(() => new RegExp(match[1], "v"));
  assert.match(html, /この範囲で参照を許可/); assert.match(html, /safe-area-inset/);
  assert.equal(appServerChildEnv({ NEGI_KNOWLEDGE_CONFIG: "private", EBI_AUTH_TOKEN: "secret" }).NEGI_KNOWLEDGE_CONFIG, undefined);
  await fixture(async f => {
    const api = createKnowledgeHttp(f.service, { token: "synthetic-only-token" });
    const server = createServer(async (req, res) => {
      if (!await api(req, res, new URL(req.url!, "http://localhost"))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(base + "/api/knowledge")).status, 401);
      assert.equal((await fetch(base + "/knowledge", { redirect: "manual" })).status, 302);
      const cookie = "ebi_auth=synthetic-only-token";
      assert.equal((await fetch(base + "/api/knowledge", { headers: { cookie } })).status, 200);
      const post = (origin: string, text: string) => fetch(base + "/api/knowledge/from-feedback", {
        method: "POST", headers: { cookie, origin, "Content-Type": "application/json" }, body: text });
      assert.equal((await post("https://other.invalid", "{}")).status, 403);
      assert.equal((await post(base, JSON.stringify({ text: "x".repeat(17000) }))).status, 409);
      assert.equal((await post(base, JSON.stringify({ caseId: "synthetic", feedbackId: "agent:fake" }))).status, 409);
      let row = await candidate(f);
      const r = await fetch(base + `/api/knowledge/${row.id}/activate`, { method: "POST",
        headers: { cookie, origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: randomUUID(), expectedSha256: row.sha256 }) });
      assert.equal(r.status, 200); row = await r.json() as typeof row; assert.equal(row.status, "active");
      assert.equal((await f.reviews.snapshot("synthetic")).status, "awaiting_review");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test("a signed approval interrupted by a writer lock withholds old bytes and can be explicitly deprecated", async () => {
  await fixture(async f => {
    let row = await candidate(f);
    const before = row.content;
    const lock = join(f.vault, ".negi-writer.lock");
    await writeFile(lock, "synthetic-owned-lock\n");
    await assert.rejects(f.service.decide(row.id, "activate", { requestId: randomUUID(), expectedSha256: row.sha256 }), /Writer|lock/);
    row = (await f.service.list())[0];
    assert.equal(row.exact, false); assert.equal(row.status, "active");
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    await unlink(lock); // only this test's lock; no stale-lock guessing
    await assert.rejects(f.service.retry(row.id, "f".repeat(64)), /version changed/);
    const recovered = await f.service.retry(row.id, row.sha256);
    assert.equal(recovered.exact, true); assert.equal(recovered.history.length, row.history.length);
    await writeFile(join(f.vault, "40_Lessons", `${row.id}.md`), before);
    row = await f.service.decide(row.id, "deprecate", { requestId: randomUUID(), expectedSha256: row.sha256,
      reason: "保存途中の承認を取り消す" });
    assert.equal(row.status, "deprecated"); assert.equal(row.exact, true);
    assert.doesNotMatch(f.pack("code-attribution"), /NT-LESSON-/);
    const feedbackId = randomUUID();
    await writeFile(lock, "synthetic-owned-lock\n");
    const view = await f.reviews.feedback("synthetic", { requestId: feedbackId, artifactSha256: f.artifactSha256,
      text: "次の候補も原文を保存する。", kind: "unclear", scope: "current_task" });
    assert.equal(view.status, "awaiting_review"); assert.ok(view.knowledge?.error);
    const pending = (await f.service.list()).find(v => v.id === `NT-LESSON-${feedbackId}`)!;
    assert.equal(pending.exact, false);
    await unlink(lock);
    assert.equal((await f.service.retry(pending.id, pending.sha256)).exact, true);
  });
});
