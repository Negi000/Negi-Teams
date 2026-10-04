import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileScheduler } from "../../src/server/orchestration/scheduler.ts";
import type { TaskSnapshot } from "../../src/server/orchestration/singleTask.ts";
import { captureTaskReview } from "../../src/server/orchestration/taskReviewArtifact.ts";
import { integrateVerifiedTasks, type IntegrationSource, type TaskIntegrationOptions } from "../../src/server/orchestration/taskIntegration.ts";
import type { VaultRunConfig } from "../../src/server/orchestration/vaultRunConfig.ts";

export const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}
export async function fixture(collision: boolean, run: (options: TaskIntegrationOptions) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "negi-integration-"));
  try {
    const baseline = join(root, "baseline"), vault = join(root, "vault");
    await mkdir(baseline); await mkdir(vault); await mkdir(join(baseline, "docs"));
    git(baseline, ["init", "--quiet"]); git(baseline, ["config", "user.name", "Synthetic Integration"]);
    git(baseline, ["config", "user.email", "synthetic@example.invalid"]);
    git(baseline, ["config", "core.autocrlf", "false"]);
    for (const name of ["a", "b", "shared"]) await writeFile(join(baseline, "docs", `${name}.md`), `${name} baseline\n`);
    git(baseline, ["add", "."]); git(baseline, ["commit", "--quiet", "-m", "synthetic integration baseline"]);
    const baseSha = git(baseline, ["rev-parse", "HEAD"]), checkout = join(root, "integration");
    git(root, ["clone", "--quiet", "--shared", baseline, checkout]);
    const scheduler = new FileScheduler(join(root, "scheduler.jsonl"));
    let seq = 0;
    const append = (action: Parameters<FileScheduler["append"]>[0]["action"]) =>
      scheduler.append({ key: `synthetic-${seq++}`, at: new Date().toISOString(), action });
    await append({ type: "configure", maxConcurrent: 2, budgetUsd: 0 });
    const sources: IntegrationSource[] = [];
    for (const name of ["a", "b"]) {
      const sourceCheckout = join(root, `source-${name}`), output = join(root, `output-${name}`);
      git(root, ["clone", "--quiet", "--shared", baseline, sourceCheckout]); await mkdir(output);
      const config: VaultRunConfig = { runId: name, checkout: sourceCheckout, outputDir: output.replaceAll("\\", "/"),
        executable: process.execPath, vault, snapshot: join(root, `${name}-contract.json`), schedulerPath: scheduler.path,
        astra: { model: "synthetic-astra", effort: "low" }, sol: { model: "synthetic-sol", effort: "low" },
        resources: [], verification: [] };
      await append({ type: "submit", work: { id: name, parentId: null, dependencies: [], role: "sol",
        checkout: sourceCheckout, checkoutMode: "write", resources: [], reserveUsd: 0 } });
      await scheduler.claim(name, `${name}:synthetic-dispatch`);
      sources.push({ config, configSha256: hash(name), resultStorage:null,readState: async () => { throw new Error("Not verified yet"); } });
    }
    assert.equal((await scheduler.read()).state?.entries.filter((item) => item.status === "running").length, 2);
    await Promise.all(sources.map(async (source) => {
      const name = source.config.runId;
      if (collision) await writeFile(join(source.config.checkout, "docs", "shared.md"), `${name} synthetic edit\n`);
      else {
        if (name === "a") await writeFile(join(source.config.checkout, "docs", "a.md"), "a modified\n");
        else await unlink(join(source.config.checkout, "docs", "b.md"));
        await writeFile(join(source.config.checkout, "docs", `new-${name}.md`), `${name} new result\n`);
      }
      const bytes = Buffer.from(JSON.stringify({ synthetic: true, mechanicalChecksPassed: true }) + "\n");
      const evidencePath = join(source.config.outputDir, "verification.json"); await writeFile(evidencePath, bytes);
      const state: TaskSnapshot = { runId: name, contract: { vaultId: `NT-SYNTHETIC-${name}`, version: 1,
        sha256: hash(name + "contract"), objective: "Synthetic disjoint file integration", acceptance: ["Explicit review"],
        baseSha, scope: { allowedPaths: collision ? ["docs/shared.md"] : [`docs/${name}.md`, `docs/new-${name}.md`] } },
        status: "ready_for_review", attempts: [], approvals: [], providerObservations: [], stoppedFrom: null,
        verification: { outcome: "passed", evidenceRef: `${evidencePath}#sha256=${hash(bytes)}` }, stopReason: null, acceptedBy: null };
      source.readState = async () => structuredClone(state);
      await captureTaskReview(source.config, source.configSha256, "Synthetic source", state);
      await append({ type: "settle", workId: name, outcome: "verified", evidenceRef: state.verification!.evidenceRef, actualCostUsd: null });
    }));
    await append({ type: "submit", work: { id: "integration", parentId: null, dependencies: ["a", "b"], role: "sol",
      checkout, checkoutMode: "write", resources: [], reserveUsd: 0 } });
    await run({ id: "integration", checkout, baseSha, scheduler, outputDir: join(root, "integration-output"), sources,
      verify: async () => {
        const path = join(root, "integration-output", "command-verification.json");
        const bytes = Buffer.from(JSON.stringify({ synthetic: true, mechanicalChecksPassed: true,
          checks: [{ requirement: "Synthetic combined result check", passed: true }] }) + "\n");
        await writeFile(path, bytes);
        return { outcome: "passed", evidenceRef: `${path}#sha256=${hash(bytes)}` };
      } });
  } finally { await rm(root, { recursive: true, force: true }); }
}
