// A paired comparison is evidence about one bounded task, not a model ranking.
import { createHash } from "node:crypto";

export interface ComparisonArm {
  label: "baseline" | "candidate";
  profile: { model: string; effort: string };
  checkout: string;
  baseSha: string;
  objectiveHash: string;
  acceptanceHash: string;
  toolsHash: string;
  evaluatorVersion: string;
  outputHash: string;
  quality: "passed" | "failed" | "unknown";
  evidenceRef: string;
  elapsedMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  apiCostUsd: number | null;
}

export interface PairedComparison {
  experimentId: string;
  baseline: ComparisonArm;
  candidate: ComparisonArm;
  comparable: boolean;
  candidateEligible: boolean;
  reasons: string[];
  /** Deltas are candidate minus baseline; null means the measure was not observed. */
  delta: { elapsedMs: number | null; inputTokens: number | null;
    outputTokens: number | null; apiCostUsd: number | null };
  evidenceHash: string;
}

function sha(value: string): boolean { return /^[a-f0-9]{64}$/i.test(value); }
function gitSha(value: string): boolean { return /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value); }
function measure(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0);
}
function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export function comparePair(experimentId: string, baseline: ComparisonArm,
                            candidate: ComparisonArm): PairedComparison {
  const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
  if (!text(experimentId) || !baseline || !candidate || baseline.label !== "baseline" || candidate.label !== "candidate" ||
      ![baseline, candidate].every((arm) => [arm.checkout, arm.evidenceRef,
        arm.evaluatorVersion, arm.profile?.model, arm.profile?.effort].every(text) &&
        ["passed", "failed", "unknown"].includes(arm.quality) &&
        gitSha(arm.baseSha) &&
        [arm.objectiveHash, arm.acceptanceHash, arm.toolsHash, arm.outputHash].every(sha) &&
        [arm.elapsedMs, arm.inputTokens, arm.outputTokens, arm.apiCostUsd].every(measure))) {
    throw new Error("paired comparison input invalid");
  }
  const reasons: string[] = [];
  if (baseline.profile.model !== candidate.profile.model)
    reasons.push("model differs");
  if (baseline.profile.effort === candidate.profile.effort)
    reasons.push("effort did not change");
  if (baseline.checkout.toLowerCase() === candidate.checkout.toLowerCase())
    reasons.push("arms did not use separate checkouts");
  for (const field of ["baseSha", "objectiveHash", "acceptanceHash", "toolsHash",
    "evaluatorVersion"] as const) {
    if (baseline[field] !== candidate[field]) reasons.push(`${field} differs`);
  }
  const comparable = reasons.length === 0;
  if (baseline.quality !== "passed") reasons.push("baseline quality was not passed");
  if (candidate.quality !== "passed") reasons.push("candidate quality was not passed");
  const delta = {
    elapsedMs: difference(baseline.elapsedMs, candidate.elapsedMs),
    inputTokens: difference(baseline.inputTokens, candidate.inputTokens),
    outputTokens: difference(baseline.outputTokens, candidate.outputTokens),
    apiCostUsd: difference(baseline.apiCostUsd, candidate.apiCostUsd),
  };
  const evidenceHash = createHash("sha256").update(JSON.stringify({ experimentId,
    baseline, candidate, comparable, reasons, delta })).digest("hex");
  return { experimentId, baseline: structuredClone(baseline),
    candidate: structuredClone(candidate), comparable,
    candidateEligible: comparable && baseline.quality === "passed" &&
      candidate.quality === "passed", reasons, delta, evidenceHash };
}
