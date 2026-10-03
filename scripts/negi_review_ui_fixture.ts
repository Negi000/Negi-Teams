// Creates one disposable UI review case. It never reads a real task or calls a model.
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { FileReviewChain } from "../src/server/orchestration/reviewChain.ts";

const raw = process.argv[2];
if (!raw || !isAbsolute(raw) || process.argv.length !== 3) throw new Error("Absolute new QA directory required");
const root = resolve(raw);
await mkdir(root);
const checkout = join(root, "synthetic-checkout");
await mkdir(checkout);
const artifact = join(checkout, "synthetic-result.md");
const content = "# レビュー画面の合成成果\n\nこの文書は画面試験専用です。実作業の受入ではありません。\n";
const evidence = join(root, "synthetic-verification.json");
const check = JSON.stringify({ synthetic: true, mechanicalCheckPassed: true }) + "\n";
await writeFile(artifact, content);
await writeFile(evidence, check);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ledgerPath = join(root, "synthetic-review.jsonl");
const ledger = new FileReviewChain(ledgerPath);
await ledger.append({ key: "qa-create", at: new Date().toISOString(), action: {
  type: "create", caseId: "qa-review", runId: "synthetic-ui-run", artifact: {
    ref: artifact, sha256: sha(content), objectiveId: "synthetic-ui-objective" } } });
await ledger.append({ key: "qa-verify", at: new Date().toISOString(), action: {
  type: "verify", artifactSha256: sha(content), evidenceRef: evidence, outcome: "passed" } });
const config = { storageRoot: join(root, "human-review"), writableRoots: [checkout], cases: [{
  id: "qa-review", title: "画面試験専用の合成成果", ledgerPath, artifactRoot: checkout,
  verifiedArtifactSha256: sha(content), evidencePath: evidence, evidenceSha256: sha(check),
  verificationSummary: "合成fixtureの機械検証", limits: "画面試験だけ。実作業・実ユーザーの受入ではありません。" }] };
const reviewConfig = join(root, "reviews.json");
const handle = await open(reviewConfig, "wx");
try { await handle.writeFile(JSON.stringify(config, null, 2) + "\n"); } finally { await handle.close(); }
const serverConfig = join(root, "server-config.json");
await writeFile(serverConfig, JSON.stringify({ fixedEbi: [] }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ reviewConfig, serverConfig, artifact, artifactSha256: sha(content),
  note: "Use a synthetic login token and a separate localhost port. This case is disposable QA only." }) + "\n");
