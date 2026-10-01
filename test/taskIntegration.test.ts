import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import type { TaskSnapshot } from "../src/server/orchestration/singleTask.ts";
import { captureTaskReview } from "../src/server/orchestration/taskReviewArtifact.ts";
import { integrateVerifiedTasks, type IntegrationSource, type TaskIntegrationOptions } from "../src/server/orchestration/taskIntegration.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}
async function fixture(collision: boolean, run: (options: TaskIntegrationOptions) => Promise<void>) {
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
      sources.push({ config, configSha256: hash(name), readState: async () => { throw new Error("Not verified yet"); } });
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
      verify: async () => ({ outcome: "passed", evidenceRef: "synthetic:integration-check" }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("two isolated verified writes integrate create/edit/delete at the same base and remain unaccepted", async () => {
  await fixture(false, async (options) => {
    const result = await integrateVerifiedTasks(options);
    assert.equal(result.status, "ready_for_review"); assert.equal(result.acceptedBy, null);
    assert.equal(await readFile(join(options.checkout, "docs", "a.md"), "utf8"), "a modified\n");
    await assert.rejects(readFile(join(options.checkout, "docs", "b.md")), { code: "ENOENT" });
    for (const name of ["a", "b"]) assert.equal(await readFile(join(options.checkout, "docs", `new-${name}.md`), "utf8"), `${name} new result\n`);
    assert.equal(git(options.checkout, ["rev-parse", "HEAD"]), options.baseSha);
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "verified");
    for (const source of options.sources) assert.equal((await source.readState()).acceptedBy, null);
    await assert.rejects(integrateVerifiedTasks(options), /registered dependencies/);
  });
});
test("overlapping ownership is refused before any integration mutation", async () => {
  await fixture(true, async (options) => {
    await assert.rejects(integrateVerifiedTasks(options), /ownership overlaps/);
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "queued");
  });
});
test("a source changed after verification cannot be integrated", async () => {
  await fixture(false, async (options) => {
    await writeFile(join(options.sources[0].config.checkout, "docs", "a.md"), "Changed after verification\n");
    await assert.rejects(integrateVerifiedTasks(options), /changed after verification/);
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
  });
});
test("integration uses the current pinned revision rather than its original artifact", async () => {
  await fixture(false, async (options) => {
    const source = options.sources[0], state = await source.readState();
    await writeFile(join(source.config.checkout, "docs/a.md"), "a corrected revision\n");
    const evidencePath = join(source.config.outputDir, "verification-r1.json");
    const bytes = Buffer.from('{"synthetic":true,"revision":1,"mechanicalChecksPassed":true}\n');
    await writeFile(evidencePath, bytes);
    state.verification = { outcome: "passed", evidenceRef: `${evidencePath}#sha256=${hash(bytes)}` };
    const manifest = await captureTaskReview(source.config, source.configSha256, "Synthetic source", state,
      { revision: 1, deferLedger: true });
    source.readState = async () => structuredClone(state);
    source.readManifest = async () => structuredClone(manifest);
    await options.scheduler.append({ key: "synthetic:source-revalidate", at: new Date().toISOString(), action: {
      type: "revalidate", workId: source.config.runId, evidenceRef: state.verification.evidenceRef } });
    const result = await integrateVerifiedTasks(options);
    assert.equal(result.status, "ready_for_review");
    assert.equal(await readFile(join(options.checkout, "docs/a.md"), "utf8"), "a corrected revision\n");
  });
});
test("a verification exception after apply preserves partial-result evidence and reserves the slot", async () => {
  await fixture(false, async (options) => {
    await assert.rejects(integrateVerifiedTasks({ ...options, verify: async () => { throw new Error("Synthetic check disconnected"); } }), /check disconnected/);
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "needs_reconciliation");
    assert.match(await readFile(join(options.checkout, "docs", "new-a.md"), "utf8"), /new result/);
  });
});
test("an ignored target file is preserved even when Git reports a clean checkout", async () => {
  await fixture(false, async (options) => {
    await writeFile(join(options.checkout, ".git", "info", "exclude"), "docs/new-a.md\n");
    await writeFile(join(options.checkout, "docs", "new-a.md"), "User ignored file\n");
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
    await assert.rejects(integrateVerifiedTasks(options), /overwrite an untracked/);
    assert.equal(await readFile(join(options.checkout, "docs", "new-a.md"), "utf8"), "User ignored file\n");
  });
});
