import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparePair, type ComparisonArm } from "../../src/server/orchestration/comparison.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function policyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "negi-policy-service-"));
  const checkout = join(directory, "checkout"), evidence = join(directory, "evidence");
  await mkdir(checkout); await mkdir(evidence);
  const candidates = [];
  for (const [id, parentId, baselineEffort, effort, regressed] of [
    ["v1", null, "medium", "low", false], ["v2", "v1", "low", "medium", false],
    ["regressed", null, "medium", "low", true],
  ] as const) {
    const comparisons = [];
    for (const caseId of ["one", "two"]) {
      const arms: ComparisonArm[] = [];
      for (const label of ["baseline", "candidate"] as const) {
        const output = `${id}-${caseId}-${label} verified fixture output`;
        const path = join(evidence, `${id}-${caseId}-${label}.md`); await writeFile(path, output);
        arms.push({ label, profile: { model: "gpt-6-luna", effort: label === "baseline" ? baselineEffort : effort },
          checkout: join(directory, `trial-${id}-${caseId}-${label}`), baseSha: hash("base"),
          objectiveHash: hash(caseId), acceptanceHash: hash("acceptance"), toolsHash: hash("tools"),
          evaluatorVersion: "fixture-v1", outputHash: hash(output), quality: "passed",
          evidenceRef: `${path}#sha256=${hash(output)}`, elapsedMs: label === "baseline" ? 100 : regressed && caseId === "two" ? 110 : 70,
          inputTokens: null, outputTokens: null, apiCostUsd: null });
      }
      comparisons.push(comparePair(caseId, arms[0], arms[1]));
    }
    const report = JSON.stringify({ comparisons }), path = join(evidence, `${id}-report.json`); await writeFile(path, report);
    candidates.push({ title: `検証用候補 ${id}`, policy: { id, parentId, taskClass: "read_only_research" as const,
      role: "luna" as const, model: "gpt-6-luna", effort, metric: "elapsed_ms" as const, sourceRefs: ["fixture:independent-audit"] },
      shadowRef: "fixture:shadow", report: { path, sha256: hash(report) } });
  }
  return { directory, checkout, evidence, secret: "private-policy-fixture-" + randomUUID(), config: { storageRoot: join(directory, "authority"), candidates } };
}
