// Audit the initial live paired trial without dispatching another model turn.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { comparePair, type ComparisonArm, type PairedComparison } from
  "../src/server/orchestration/comparison.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const [reportRaw, outputRaw] = process.argv.slice(2);
if (!reportRaw || !outputRaw) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase7_audit.ts <initial-comparison-json> <audited-output-json>\n");
  process.exitCode = 2;
} else {
  const reportPath = resolve(reportRaw), output = resolve(outputRaw);
  const bytes = await readFile(reportPath);
  const original = JSON.parse(bytes.toString("utf8")) as {
    baseSha: string; model: string; baselineEffort: string; candidateEffort: string;
    comparisons: Array<Omit<PairedComparison, "baseline" | "candidate"> & {
      baseline: Omit<ComparisonArm, "profile">;
      candidate: Omit<ComparisonArm, "profile">;
    }>;
  };
  const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  if (!Array.isArray(original.comparisons) || original.comparisons.length !== 2 ||
      original.model !== "gpt-6-luna" || original.baselineEffort !== "medium" ||
      original.candidateEffort !== "low") throw new Error("unexpected trial report");
  const audited: PairedComparison[] = [];
  for (const old of original.comparisons) {
    const oldHash = hash(JSON.stringify({ experimentId: old.experimentId,
      baseline: old.baseline, candidate: old.candidate,
      comparable: old.comparable, reasons: old.reasons, delta: old.delta }));
    if (oldHash !== old.evidenceHash) throw new Error("original report evidence hash mismatch");
    const scheduler = new FileScheduler(join(dirname(reportPath),
      old.experimentId, "scheduler.jsonl"));
    const entries = (await scheduler.read()).state?.entries;
    if (entries?.length !== 2 || entries.some((entry) => entry.status !== "verified"))
      throw new Error("trial scheduler did not verify both arms");
    const baseline = { ...old.baseline, profile: { model: original.model,
      effort: original.baselineEffort } };
    const candidate = { ...old.candidate, profile: { model: original.model,
      effort: original.candidateEffort } };
    for (const arm of [baseline, candidate]) {
      const marker = "#sha256=";
      const index = arm.evidenceRef.lastIndexOf(marker);
      if (index < 0) throw new Error("artifact reference lacks digest");
      const data = await readFile(arm.evidenceRef.slice(0, index));
      if (hash(data) !== arm.evidenceRef.slice(index + marker.length) ||
          hash(data) !== arm.outputHash) throw new Error("artifact hash mismatch");
      const currentSha = execFileSync("git", ["rev-parse", "HEAD"],
        { cwd: arm.checkout, encoding: "utf8", windowsHide: true }).trim();
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
        { cwd: arm.checkout, encoding: "utf8", windowsHide: true }).trim();
      if (currentSha !== original.baseSha || status)
        throw new Error("checkout changed after trial");
    }
    const current = comparePair(old.experimentId, baseline, candidate);
    if (!current.candidateEligible || current.delta.elapsedMs !== old.delta.elapsedMs)
      throw new Error("quality or timing evidence differs from initial report");
    audited.push(current);
  }
  const promotionHeld = audited.some((pair) => pair.delta.elapsedMs === null ||
    pair.delta.elapsedMs > 0) ||
    !audited.some((pair) => pair.delta.elapsedMs !== null && pair.delta.elapsedMs < 0);
  const file = await open(output, "wx");
  try { await file.writeFile(JSON.stringify({ originalReportRef: `${reportPath}#sha256=${hash(bytes)}`,
    auditedAt: new Date().toISOString(), comparisons: audited,
    promotionHeld, reason: promotionHeld
      ? "low effort did not improve elapsed time in every comparable case"
      : null }, null, 2), "utf8"); await file.sync(); }
  finally { await file.close(); }
  process.stdout.write(JSON.stringify({ auditedPairs: audited.length,
    promotionHeld, outputRef: `${output}#sha256=${hash(await readFile(output))}` }) + "\n");
}
