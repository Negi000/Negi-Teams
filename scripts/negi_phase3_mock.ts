// Offline smoke for the Phase 3 ledger. No Codex process, model, MCP, or Jev call.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FileTaskLedger, type TaskAction } from "../src/server/orchestration/singleTask.ts";

function arg(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}
function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function safeIn(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const vault = await realpath(resolve(arg("--vault")));
const packPath = resolve(arg("--pack"));
const outputDir = resolve(arg("--out"));
if (outputDir === vault || safeIn(vault, outputDir)) throw new Error("Mock ledger must stay outside Vault");
const pack = await readFile(packPath, "utf8");
const match = pack.match(/<!-- manifest: (\{.*\}); estimated_tokens=\d+ -->/);
if (!match) throw new Error("Pack manifest missing");
const manifest = JSON.parse(match[1]) as { project: string; sources: Array<{
  id: string; kind: string; version: number; sha256: string; path: string; fidelity: string;
}> };
if (manifest.project !== "negi-teams" || !Array.isArray(manifest.sources)) {
  throw new Error("Unexpected Pack project/sources");
}
for (const source of manifest.sources) {
  const path = await realpath(resolve(vault, source.path));
  if (!safeIn(vault, path)) throw new Error(`Vault path escapes root: ${source.path}`);
  const data = await readFile(path);
  const frontmatter = data.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const field = (name: string) => frontmatter.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim();
  if (sha256(data) !== source.sha256 || field("id") !== source.id ||
      field("version") !== String(source.version) || field("status") !== "active" ||
      field("project") !== manifest.project) {
    throw new Error(`Source changed or inactive: ${source.id}`);
  }
}
const spec = manifest.sources.find((x) => x.id === "NT-SPEC-VAULT-PHASE2" &&
  x.kind === "Spec" && x.fidelity === "full");
if (!spec) throw new Error("Required active Phase 2 spec missing");
const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const runId = `mock-${randomUUID()}`;
const ledgerPath = join(outputDir, `${runId}.jsonl`);
const ledger = new FileTaskLedger(ledgerPath);
let sequence = 0;
async function record(action: TaskAction) {
  sequence += 1;
  return ledger.append({ key: `${runId}:${sequence}`, at: new Date().toISOString(), action });
}
await record({ type: "create", runId, contract: {
  vaultId: spec.id, version: spec.version, sha256: spec.sha256, project: manifest.project,
  objective: "Phase 3 offline Astra→Sol state-flow smoke",
  acceptance: ["Provider execution and code verification must be confirmed separately"],
  baseSha,
} });
await record({ type: "start_attempt", attemptId: `${runId}:astra`, role: "astra",
  requestedModel: "gpt-6-astra" });
await record({ type: "bind_provider", attemptId: `${runId}:astra`,
  threadId: "mock:astra-thread", turnId: "mock:astra-turn" });
await record({ type: "complete_attempt", attemptId: `${runId}:astra`, resolvedModel: null,
  threadId: "mock:astra-thread", turnId: "mock:astra-turn", outputRef: "mock:short-plan" });
await record({ type: "start_attempt", attemptId: `${runId}:sol`, role: "sol",
  requestedModel: "gpt-6-sol" });
await record({ type: "bind_provider", attemptId: `${runId}:sol`,
  threadId: "mock:sol-thread", turnId: "mock:sol-turn" });
await record({ type: "complete_attempt", attemptId: `${runId}:sol`, resolvedModel: null,
  threadId: "mock:sol-thread", turnId: "mock:sol-turn", outputRef: "mock:no-code-change" });
const state = await record({ type: "verify", outcome: "unknown",
  evidenceRef: "mock:real-model-and-code-verification-not-run" });
console.log(JSON.stringify({ runId, status: state.status, acceptedBy: state.acceptedBy,
  mock: true, ledgerPath }, null, 2));
