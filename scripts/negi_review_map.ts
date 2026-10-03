// Reproducible local A -> correction -> B review evidence for the live Phase 3 map.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { FileReviewChain, type ReviewAction } from
  "../src/server/orchestration/reviewChain.ts";

const repo = resolve(process.cwd());
const baseline = resolve(repo, "../.negi-worktrees/phase3-vertical");
const relative = "docs/negi-teams-integration-map.md";
const pathA = join(baseline, relative);
const pathB = join(repo, relative);
const evidencePath = join(repo, ".ebi-team/phase3-live/review-map-b-verification.json");
const ledger = new FileReviewChain(join(repo, ".ebi-team/phase3-live/review-map.jsonl"));
function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
async function main(): Promise<void> {
  const [a, b] = await Promise.all([readFile(pathA, "utf8"), readFile(pathB, "utf8")]);
  const aLines = a.trimEnd().split(/\r?\n/);
  const bLines = b.trimEnd().split(/\r?\n/);
  if (aLines.length !== bLines.length || bLines.length > 80 ||
      aLines.slice(0, -1).join("\n") !== bLines.slice(0, -1).join("\n") ||
      !aLines.at(-1)?.includes("ユーザー提示の未実行計画") ||
      !bLines.at(-1)?.includes("実モデル試行のAstra計画"))
    throw new Error("A and B are not the expected one-line factual correction");
  const refs: Array<[string, string]> = [
    ["src/server/index.ts", "startMasterChatSession"],
    ["src/server/master/index.ts", "createMasterBrain"],
    ["src/server/master/session.ts", "MasterSession"],
    ["src/server/agent.ts", "Agent"],
    ["src/server/backends/codex.ts", "CODEX_BACKEND"],
  ];
  for (const [file, symbol] of refs) {
    const source = await readFile(join(baseline, file), "utf8");
    if (!b.includes(file) || !b.includes(symbol) || !source.includes(symbol))
      throw new Error(`Missing code reference: ${file} ${symbol}`);
  }
  if (/(?:ghp_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{20}|C:\\Users\\)/.test(b))
    throw new Error("Potential private token or profile path in B");
  const hashA = sha(a), hashB = sha(b);
  const evidence = { runId: "negi-phase3-live-map-2", artifactA: { path: pathA,
    sha256: hashA }, artifactB: { path: pathB, sha256: hashB },
    lineCount: bLines.length, oneLineCorrection: true, codeReferencesPresent: true,
    privacyPatternCheckPassed: true, mechanicalCheckPassed: true,
    limits: "Current primary checkout is dirty; this does not verify an isolated B checkout." };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  let n = 0;
  const append = async (action: ReviewAction) => {
    n += 1;
    await ledger.append({ key: `map-review:${n}`, at: "2026-09-30T12:00:00Z", action });
  };
  await append({ type: "create", caseId: "map-review", runId: evidence.runId,
    artifact: { ref: pathA, sha256: hashA, objectiveId: "integration-map-v2" } });
  await append({ type: "feedback", feedback: { id: "agent-factual-correction",
    source: "agent", kind: "correction", targetSha256: hashA,
    textRef: "local:incorrect-attribution:last-line", scope: "current_task" } });
  await append({ type: "revise", fromSha256: hashA,
    artifact: { ref: pathB, sha256: hashB, objectiveId: "integration-map-v2" },
    feedbackIds: ["agent-factual-correction"], sameObjective: true });
  await append({ type: "verify", artifactSha256: hashB,
    evidenceRef: evidencePath, outcome: "passed" });
  const state = (await ledger.read()).state;
  process.stdout.write(JSON.stringify({ hashA, hashB, status: state?.acceptance === null
    ? "verified_unaccepted" : "accepted", evidencePath }) + "\n");
}
main().catch((error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
