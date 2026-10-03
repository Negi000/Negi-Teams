// Local facts for reviewing an uncertain attempt. This does not reconcile the
// ledger, clear a client guard, start a process, or authorize another dispatch.
import { createHash } from "node:crypto";
import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FileTaskLedger, type Approval, type ProviderTurnEvidence } from "./singleTask.ts";

export interface ReconciliationDossier {
  runId: string;
  attemptId: string;
  role: "astra" | "sol";
  contract: { vaultId: string; version: number; sha256: string; baseSha: string };
  provider: { threadId: string | null; turnId: string | null;
    observations: ProviderTurnEvidence[] };
  approvals: Approval[];
  artifact: { path: string; state: "present" | "absent" | "unsafe" | "too_large";
    bytes: number | null; sha256: string | null; matchesRecordedRef: boolean | null };
  checkout: { root: string; head: string; matchesBase: boolean;
    changedPaths: string[]; outsideAllowedPaths: string[] | null };
  processState: "unverified";
  automaticResumeEligible: false;
  observedAt: string;
}

function git(checkout: string, args: string[]): string {
  return execFileSync("git", args, { cwd: checkout, env: withoutControlPlaneEnv(), windowsHide: true }).toString("utf8");
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function inspectArtifact(directory: string, attemptId: string, recordedRef: string | null):
    Promise<ReconciliationDossier["artifact"]> {
  // Attempt IDs enter the append-only ledger as data, so never use an arbitrary
  // value as a filesystem path component.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) {
    return { path: "", state: "unsafe", bytes: null, sha256: null,
      matchesRecordedRef: null };
  }
  const root = await realpath(resolve(directory));
  const path = join(root, `${attemptId}.md`);
  let entry;
  try { entry = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, state: "absent", bytes: null, sha256: null,
        matchesRecordedRef: null };
    }
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || !within(root, path) ||
      await realpath(path) !== path) {
    return { path, state: "unsafe", bytes: null, sha256: null,
      matchesRecordedRef: null };
  }
  if (entry.size > 2_000_000) {
    return { path, state: "too_large", bytes: entry.size, sha256: null,
      matchesRecordedRef: null };
  }
  const data = await readFile(path);
  if (data.length > 2_000_000) {
    return { path, state: "too_large", bytes: data.length, sha256: null,
      matchesRecordedRef: null };
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { path, state: "present", bytes: data.length, sha256,
    matchesRecordedRef: recordedRef === null ? null :
      recordedRef === `${path}#sha256=${sha256}` };
}

/** Inspect one unknown attempt. Every returned fact still needs human review. */
export async function inspectUnknownAttempt(ledger: FileTaskLedger, attemptId: string,
                                            checkoutDirectory: string,
                                            artifactDirectory: string): Promise<ReconciliationDossier> {
  const { state } = await ledger.read();
  const attempt = state?.attempts.find((item) => item.id === attemptId);
  if (!state || state.status !== "needs_reconciliation" || attempt?.state !== "unknown") {
    throw new Error("unknown attempt required for reconciliation dossier");
  }
  const checkout = await realpath(resolve(checkoutDirectory));
  const top = await realpath(git(checkout, ["rev-parse", "--show-toplevel"]).trim());
  if (top !== checkout) throw new Error("reconciliation checkout must be Git root");
  const head = git(checkout, ["rev-parse", "HEAD"]).trim();
  const tracked = git(checkout, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]);
  const untracked = git(checkout, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const changedPaths = [...new Set((tracked + untracked).split("\0").filter(Boolean))].sort();
  const allowed = state.contract.scope?.allowedPaths;
  const outsideAllowedPaths = allowed ? changedPaths.filter((path) =>
    !allowed.some((item) => path === item || path.startsWith(`${item}/`))) : null;
  return {
    runId: state.runId, attemptId, role: attempt.role,
    contract: { vaultId: state.contract.vaultId, version: state.contract.version,
      sha256: state.contract.sha256, baseSha: state.contract.baseSha },
    provider: { threadId: attempt.threadId, turnId: attempt.turnId,
      observations: state.providerObservations.filter((item) => item.attemptId === attemptId)
        .map((item) => structuredClone(item.inspection)) },
    approvals: state.approvals.filter((item) => item.attemptId === attemptId)
      .map((item) => structuredClone(item)),
    artifact: await inspectArtifact(artifactDirectory, attemptId, attempt.outputRef),
    checkout: { root: checkout, head, matchesBase: head.toLowerCase() ===
      state.contract.baseSha.toLowerCase(), changedPaths, outsideAllowedPaths },
    processState: "unverified", automaticResumeEligible: false,
    observedAt: new Date().toISOString(),
  };
}
