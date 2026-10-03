import { lstat, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, relative } from "node:path";
import { HumanReviewProofStore } from "./humanReviewProof.ts";
import type { VaultRunConfig } from "./vaultRunConfig.ts";
import type { VaultTaskContract } from "./vaultTaskContract.ts";
import type { MasterOrigin } from "../../shared/conversations.ts";

export interface ApprovedTaskPlan { text: string; approvalRef: string; threadId: string; turnId: string; callId: string }
function inside(root: string, target: string): boolean {
  const rel = relative(root.toLowerCase(), target.toLowerCase());
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function readApprovedPlan(config: VaultRunConfig) {
  if (!config.approvedPlan) return;
  const { proofDirectory, requestId } = config.approvedPlan;
  const root = await realpath(proofDirectory);
  if ((await lstat(proofDirectory)).isSymbolicLink() ||
      inside(await realpath(config.checkout), root) || inside(await realpath(config.vault), root))
    throw new Error("Task plan signing authority must be outside model writable roots");
  const receipt = await (await HumanReviewProofStore.openExisting(root)).read(requestId);
  if (!receipt || receipt.action !== "operation" || receipt.data.domain !== "task-authoring" ||
      receipt.runId !== config.runId || receipt.data.config !== JSON.stringify(config) ||
      receipt.data.vault !== await realpath(config.vault) ||
      typeof receipt.data.plan !== "string" || !receipt.data.plan.trim() || receipt.data.plan.length > 4000)
    throw new Error("Task plan differs from its authenticated approval");
  const origin = JSON.parse(receipt.data.origin) as Record<string, unknown>;
  if (origin.kind !== "master" || origin.model !== config.astra.model || origin.effort !== config.astra.effort ||
      ![origin.masterId, origin.threadId, origin.turnId, origin.callId].every(id => typeof id === "string" &&
        id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id))) throw new Error("Astra Task plan origin invalid");
  return { receipt, origin: { kind: "master" as const, masterId: origin.masterId as string,
    threadId: origin.threadId as string, turnId: origin.turnId as string, callId: origin.callId as string } };
}
/** Only signed creation provenance; does not approve current Task quality. */
export async function loadApprovedTaskOrigin(config: VaultRunConfig): Promise<MasterOrigin | undefined> {
  return (await readApprovedPlan(config))?.origin;
}
/** Check actual signed authority again before dispatch, never trust model text. */
export async function loadApprovedTaskPlan(config: VaultRunConfig, contract: VaultTaskContract): Promise<ApprovedTaskPlan | undefined> {
  const saved = await readApprovedPlan(config); if (!saved) return;
  const { receipt, origin } = saved;
  if (receipt.data.taskId !== contract.vaultId || receipt.artifactSha256 !== contract.sha256 ||
      receipt.data.project !== contract.project || !isDeepStrictEqual(JSON.parse(receipt.data.snapshot), contract))
    throw new Error("Task plan differs from its authenticated approval");
  // The bytes in Vault are separately re-exported by loadVaultTaskContract.
  return { text: receipt.data.plan, approvalRef: `user:http-task-plan:${config.approvedPlan!.requestId}`,
    threadId: origin.threadId as string, turnId: origin.turnId as string, callId: origin.callId as string };
}
