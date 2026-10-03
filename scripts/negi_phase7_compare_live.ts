// Two paired, read-only effort trials. Evidence remains local and unaccepted.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";
import { comparePair, type ComparisonArm } from
  "../src/server/orchestration/comparison.ts";
import { runScheduledReadOnlyTurn } from
  "../src/server/orchestration/scheduledReadOnlyTurn.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const [exeRaw, baselineRaw, candidateRaw, outRaw] = process.argv.slice(2);
if (!exeRaw || !baselineRaw || !candidateRaw || !outRaw) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase7_compare_live.ts <codex-exe> <baseline-checkout> <candidate-checkout> <output-dir>\n");
  process.exitCode = 2;
} else {
  const executable = resolve(exeRaw), baseline = await realpath(resolve(baselineRaw));
  const candidate = await realpath(resolve(candidateRaw)), out = resolve(outRaw);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args,
    { cwd, encoding: "utf8", windowsHide: true }).trim();
  const baseSha = git(baseline, "rev-parse", "HEAD");
  if (baseline.toLowerCase() === candidate.toLowerCase() ||
      baseSha !== git(candidate, "rev-parse", "HEAD") ||
      git(baseline, "status", "--porcelain", "--untracked-files=all") ||
      git(candidate, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("paired trials require distinct clean checkouts at one base SHA");
  }
  const cases = [
    { id: "factory-line", file: "src/server/master/index.ts",
      prompt: "src/server/master/index.ts だけを読み、createMasterBrain の宣言開始行と codex 分岐で new するクラス名を調べてください。返答は JSON 1行のみ: {\"declarationLine\":数値,\"codexClass\":文字列}。推測、他ファイルの調査、編集、エージェント起動は禁止。",
      expected: async (cwd: string) => {
        const lines = (await readFile(join(cwd, "src/server/master/index.ts"), "utf8")).split(/\r?\n/);
        return { declarationLine: lines.findIndex((line) =>
          line.startsWith("export function createMasterBrain(")) + 1,
          codexClass: "CodexHeadlessBrain" };
      } },
    { id: "spawn-lines", file: "src/server/index.ts",
      prompt: "src/server/index.ts だけを読み、registry.spawn( の呼出しがある全行番号を昇順で列挙してください。返答は JSON 1行のみ: {\"lines\":[数値,...]}。推測、他ファイルの調査、編集、エージェント起動は禁止。",
      expected: async (cwd: string) => {
        const lines = (await readFile(join(cwd, "src/server/index.ts"), "utf8")).split(/\r?\n/);
        return { lines: lines.flatMap((line, index) =>
          line.includes("registry.spawn(") ? [index + 1] : []) };
      } },
  ] as const;
  await mkdir(out, { recursive: true });
  const comparisons = [];
  for (const item of cases) {
    const caseOut = join(out, item.id);
    const expected = await item.expected(baseline);
    if (JSON.stringify(expected) !== JSON.stringify(await item.expected(candidate)))
      throw new Error("source truth changed between trial arms");
    if (("declarationLine" in expected && expected.declarationLine < 1) ||
        ("lines" in expected && expected.lines.length < 1))
      throw new Error("expected source symbol missing");
    const scheduler = new FileScheduler(join(caseOut, "scheduler.jsonl"));
    await scheduler.append({ key: "configure", at: new Date().toISOString(),
      action: { type: "configure", maxConcurrent: 2, budgetUsd: 0 } });
    for (const [label, cwd] of [["baseline", baseline], ["candidate", candidate]] as const) {
      await scheduler.append({ key: `submit-${label}`, at: new Date().toISOString(),
        action: { type: "submit", work: { id: `${item.id}-${label}`,
          parentId: null, dependencies: [], role: "luna", checkout: cwd,
          checkoutMode: "read", resources: [{ name: `${item.file}@${baseSha}`, mode: "read" }],
          reserveUsd: 0 } } });
    }
    async function runArm(label: "baseline" | "candidate", cwd: string,
                          effort: string): Promise<ComparisonArm> {
      const started = Date.now();
      const process = AppServerProcess.launch({ executable,
        args: ["app-server", "--stdio"], cwd,
        client: { transportTimeoutMs: 20_000 } });
      try {
        const workId = `${item.id}-${label}`;
        const result = await runScheduledReadOnlyTurn({ scheduler,
          dispatchKey: `dispatch-${workId}`, workId, client: process.client,
          cwd, model: "gpt-6-luna", effort, prompt: item.prompt,
          artifactDir: join(caseOut, "artifacts"), timeoutMs: 120_000,
          verify: async (text) => {
            let parsed: unknown;
            try { parsed = JSON.parse(text.trim()); } catch { return false; }
            return JSON.stringify(parsed) === JSON.stringify(expected) &&
              !git(cwd, "status", "--porcelain", "--untracked-files=all");
          } });
        return { label, profile: { model: "gpt-6-luna", effort },
          checkout: cwd, baseSha, objectiveHash: hash(item.prompt),
          acceptanceHash: hash(JSON.stringify(expected)),
          toolsHash: hash(`codex-app-server-stdio/read-only/${baseSha}`),
          evaluatorVersion: "source-line-json-v1", outputHash: hash(result.observation.finalText ?? ""),
          quality: result.status === "verified" ? "passed" : "failed",
          evidenceRef: result.outputRef, elapsedMs: Date.now() - started,
          // The App Server's last usage notification has unknown whole-turn scope.
          inputTokens: null, outputTokens: null, apiCostUsd: null };
      } finally { await process.stop(); }
    }
    const settled = await Promise.allSettled([runArm("baseline", baseline, "medium"),
      runArm("candidate", candidate, "low")]);
    if (settled.some((result) => result.status === "rejected")) {
      const failure = await open(join(caseOut, "failure.json"), "wx");
      try { await failure.writeFile(JSON.stringify({ caseId: item.id,
        outcomes: settled.map((result) => result.status === "rejected"
          ? { status: "unknown", reason: String(result.reason) }
          : { status: result.value.quality, evidenceRef: result.value.evidenceRef }) },
      null, 2), "utf8"); await failure.sync(); }
      finally { await failure.close(); }
      throw new Error("paired trial incomplete; inspect scheduler before another dispatch");
    }
    const a = settled[0]!.value;
    const b = settled[1]!.value;
    const comparison = comparePair(item.id, a, b);
    comparisons.push(comparison);
    process.stdout.write(JSON.stringify({ caseId: item.id,
      baseline: a.quality, candidate: b.quality,
      comparable: comparison.comparable,
      candidateEligible: comparison.candidateEligible,
      deltaElapsedMs: comparison.delta.elapsedMs }) + "\n");
  }
  const report = join(out, "comparison.json");
  const file = await open(report, "wx");
  try { await file.writeFile(JSON.stringify({ baseSha, model: "gpt-6-luna",
    baselineEffort: "medium", candidateEffort: "low", comparisons }, null, 2), "utf8");
    await file.sync(); }
  finally { await file.close(); }
  process.stdout.write(`Evidence: ${report}\n`);
}
