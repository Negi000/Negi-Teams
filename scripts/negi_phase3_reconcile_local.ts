// Narrow recovery for a stopped document-only live run. This may only abandon
// an interrupted provider turn with no artifact, no approvals and a clean checkout.
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FileTaskLedger, type ReconciliationVerifier } from "../src/server/orchestration/singleTask.ts";
import { inspectUnknownAttempt, type ReconciliationDossier } from "../src/server/orchestration/reconciliationDossier.ts";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const [ledgerArg, schedulerArg, attemptId, checkoutArg, artifactsArg, evidenceArg] = process.argv.slice(2);
if (!ledgerArg || !schedulerArg || !attemptId || !checkoutArg || !artifactsArg || !evidenceArg) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase3_reconcile_local.ts <ledger> <scheduler> <attempt-id> <checkout> <artifacts> <evidence-json>\n");
  process.exitCode = 2;
} else {
  const ledgerPath = resolve(ledgerArg);
  const scheduler = new FileScheduler(resolve(schedulerArg));
  const checkout = resolve(checkoutArg);
  const artifacts = resolve(artifactsArg);
  const evidencePath = resolve(evidenceArg);
  const readOnlyLedger = new FileTaskLedger(ledgerPath);
  const safe = (dossier: ReconciliationDossier) => {
    const last = dossier.provider.observations.at(-1);
    return dossier.role === "sol" && dossier.runId === "negi-phase3-live-map-1" &&
      dossier.contract.vaultId === "NT-TASK-PHASE3-LIVE-MAP" &&
      last?.threadId === dossier.provider.threadId && last.turnId === dossier.provider.turnId &&
      last.found && last.completeSearch && last.status === "interrupted" &&
      dossier.approvals.every((approval) => approval.decision !== "pending" &&
        approval.decision !== "allow") &&
      dossier.artifact.state === "absent" && dossier.checkout.matchesBase &&
      dossier.checkout.changedPaths.length === 0 &&
      dossier.checkout.outsideAllowedPaths?.length === 0;
  };
  try {
    const dossier = await inspectUnknownAttempt(readOnlyLedger, attemptId, checkout, artifacts);
    const { state } = await readOnlyLedger.read();
    if (!safe(dossier) ||
        JSON.stringify(state?.contract.scope?.allowedPaths) !==
          JSON.stringify(["docs/negi-teams-integration-map.md"])) {
      throw new Error("terminal provider and clean document-only checkout were not proven");
    }
    const proof = { ...dossier, review: "mechanical abandonment only; no outcome acceptance",
      processCaveat: "prior App Server child exited; external side effects were not independently audited" };
    const bytes = Buffer.from(JSON.stringify(proof, null, 2) + "\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    try {
      const file = await open(evidencePath, "wx");
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !Buffer.from(await readFile(evidencePath)).equals(bytes)) throw error;
    }
    const evidenceRef = `${evidencePath}#sha256=${hash}`;
    const verifier: ReconciliationVerifier = async ({ event, state: before }) => {
      if (event.action.type !== "reconcile" || event.action.outcome !== "abandoned" ||
          event.action.attemptId !== attemptId || event.action.evidenceRef !== evidenceRef ||
          before.runId !== dossier.runId || before.status !== "needs_reconciliation") return false;
      const current = await inspectUnknownAttempt(readOnlyLedger, attemptId, checkout, artifacts);
      return safe(current) && current.checkout.head === dossier.checkout.head &&
        JSON.stringify(current.checkout.changedPaths) === JSON.stringify(dossier.checkout.changedPaths) &&
        JSON.stringify(current.provider.observations) === JSON.stringify(dossier.provider.observations);
    };
    const ledger = new FileTaskLedger(ledgerPath, Date.now, verifier);
    await ledger.append({ key: `${dossier.runId}:abandon-${attemptId}`, at: new Date().toISOString(),
      action: { type: "reconcile", attemptId, outcome: "abandoned", evidenceRef } });
    await ledger.append({ key: `${dossier.runId}:stop-after-abandon`, at: new Date().toISOString(),
      action: { type: "stop", reason: "first live run abandoned after provider interruption" } });
    await scheduler.append({ key: `${dossier.runId}:release-after-abandon`, at: new Date().toISOString(),
      action: { type: "reconcile", workId: dossier.runId, outcome: "failed",
        evidenceRef, actualCostUsd: null } });
    process.stdout.write(JSON.stringify({ runId: dossier.runId,
      taskStatus: (await ledger.read()).state?.status,
      schedulerStatus: (await scheduler.read()).state?.entries[0]?.status,
      evidenceRef }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`Local reconciliation refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
