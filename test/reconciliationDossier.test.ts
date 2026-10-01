import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FileTaskLedger, type TaskAction } from "../src/server/orchestration/singleTask.ts";
import { inspectUnknownAttempt } from "../src/server/orchestration/reconciliationDossier.ts";

test("uncertain attempt dossier reads provider, approvals, artifact and Git without resuming", async () => {
  const root = await mkdtemp(join(tmpdir(), "negi-reconciliation-"));
  try {
    const checkout = join(root, "checkout");
    const artifacts = join(root, "artifacts");
    await mkdir(join(checkout, "src"), { recursive: true });
    await mkdir(artifacts);
    const git = (...args: string[]) => execFileSync("git", args,
      { cwd: checkout, encoding: "utf8", windowsHide: true }).trim();
    git("init", "-q");
    await writeFile(join(checkout, "src", "allowed.ts"), "original\n");
    git("add", ".");
    git("-c", "user.name=Negi Test", "-c", "user.email=negi@example.invalid",
      "commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");
    const ledgerPath = join(root, "run.jsonl");
    const ledger = new FileTaskLedger(ledgerPath);
    const append = (key: string, action: TaskAction) => ledger.append({ key,
      at: "2026-09-30T00:00:00Z", action });
    await append("create", { type: "create", runId: "run-one", contract: {
      vaultId: "NT-TASK-ONE", version: 1, sha256: "a".repeat(64),
      project: "negi-teams", objective: "one change", acceptance: ["review"],
      baseSha, scope: { in: ["src"], out: ["other"], allowedPaths: ["src"] } } });
    await append("start", { type: "start_attempt", attemptId: "attempt-one",
      role: "astra", requestedModel: "gpt-6-astra" });
    await append("bind", { type: "bind_provider", attemptId: "attempt-one",
      threadId: "thread-one", turnId: "turn-one" });
    await append("approval", { type: "request_approval", approval: {
      id: "approval-one", attemptId: "attempt-one", threadId: "thread-one",
      turnId: "turn-one", operation: "write", target: "src/allowed.ts",
      expiresAt: "2099-01-01T00:00:00Z" } });
    await append("unknown", { type: "provider_unknown", attemptId: "attempt-one",
      reason: "connection lost" });
    await append("observe", { type: "observe_provider", attemptId: "attempt-one",
      inspection: { threadId: "thread-one", turnId: "turn-one", found: true,
        status: "completed", pagesRead: 1, completeSearch: true,
        observedAtMs: 1000, source: "thread/turns/list" } });
    await writeFile(join(checkout, "src", "allowed.ts"), "changed\n");
    await writeFile(join(checkout, "outside.txt"), "outside\n");
    await writeFile(join(checkout, " leading.txt"), "spaced path\n");
    const output = Buffer.from("orphaned answer\n");
    await writeFile(join(artifacts, "attempt-one.md"), output);
    const before = await readFile(ledgerPath);
    const dossier = await inspectUnknownAttempt(ledger, "attempt-one", checkout, artifacts);
    assert.deepEqual(await readFile(ledgerPath), before);
    assert.equal((await ledger.read()).state?.status, "needs_reconciliation");
    assert.equal(dossier.automaticResumeEligible, false);
    assert.equal(dossier.processState, "unverified");
    assert.equal(dossier.provider.observations[0]?.status, "completed");
    assert.equal(dossier.approvals[0]?.decision, "discarded");
    assert.equal(dossier.artifact.state, "present");
    assert.equal(dossier.artifact.sha256, createHash("sha256").update(output).digest("hex"));
    assert.equal(dossier.artifact.matchesRecordedRef, null);
    assert.equal(dossier.checkout.matchesBase, true);
    assert.deepEqual(dossier.checkout.changedPaths,
      [" leading.txt", "outside.txt", "src/allowed.ts"]);
    assert.deepEqual(dossier.checkout.outsideAllowedPaths, [" leading.txt", "outside.txt"]);
    assert.equal(dossier.checkout.root, await realpath(checkout));
    const script = fileURLToPath(new URL("../scripts/negi_reconciliation_dossier.ts", import.meta.url));
    const cli = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", script,
      "--ledger", ledgerPath, "--attempt", "attempt-one", "--checkout", checkout,
      "--artifacts", artifacts], { cwd: process.cwd(), encoding: "utf8",
      windowsHide: true })) as { automaticResumeEligible: boolean; checkout: {
        outsideAllowedPaths: string[] } };
    assert.equal(cli.automaticResumeEligible, false);
    assert.deepEqual(cli.checkout.outsideAllowedPaths, [" leading.txt", "outside.txt"]);
    assert.deepEqual(await readFile(ledgerPath), before);
    await assert.rejects(inspectUnknownAttempt(ledger, "../outside", checkout, artifacts),
      /unknown attempt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
