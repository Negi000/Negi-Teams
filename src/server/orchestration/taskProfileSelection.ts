// A trusted opt-in changes only Luna's effort for a fixed research contract.
// The selection is copied into the run ledger before either model turn.
import type { ReadOnlyPolicySource } from "./policyService.ts";
import type { SingleTaskClient } from "./singleTaskRunner.ts";

export interface TaskWorkerProfileSelection {
  role: "luna";
  source: "default" | "approved-policy";
  defaultProfile: { model: string; effort: string };
  model: string;
  effort: string;
  policyId: string | null;
  policyHash: string | null;
  stateSha256: string | null;
}
const label = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function validTaskWorkerProfileSelection(value: TaskWorkerProfileSelection): boolean {
  return Boolean(value && Object.keys(value).sort().join() ===
    "defaultProfile,effort,model,policyHash,policyId,role,source,stateSha256" &&
    value.role === "luna" && value.defaultProfile &&
    Object.keys(value.defaultProfile).sort().join() === "effort,model" &&
    label(value.model) && label(value.effort) && label(value.defaultProfile.model) && label(value.defaultProfile.effort) &&
    value.model === value.defaultProfile.model &&
    (value.source === "approved-policy" ? label(value.policyId) && sha(value.policyHash) && sha(value.stateSha256) :
      value.source === "default" && value.effort === value.defaultProfile.effort &&
      value.policyId === null && value.policyHash === null && value.stateSha256 === null));
}
export async function selectTaskWorkerProfile(source: ReadOnlyPolicySource,
  client: Pick<SingleTaskClient, "initialize" | "discoverModels">,
  profile: { model: string; effort: string }): Promise<TaskWorkerProfileSelection> {
  const defaultProfile = { model: profile.model, effort: profile.effort };
  await client.initialize();
  const catalog = await client.discoverModels();
  const selection = await source.select({ role: "luna", taskClass: "read_only_research", defaultProfile: { ...defaultProfile },
    catalog: structuredClone(catalog), holdUnavailableActive: true });
  const selected = selection ? structuredClone(selection) : null;
  const pinned: TaskWorkerProfileSelection = { role: "luna", source: selected ? "approved-policy" : "default",
    defaultProfile, model: selected?.model ?? defaultProfile.model, effort: selected?.effort ?? defaultProfile.effort,
    policyId: selected?.policyId ?? null, policyHash: selected?.policyHash ?? null, stateSha256: selected?.stateSha256 ?? null };
  if (!validTaskWorkerProfileSelection(pinned) || !catalog.some(item => item.model === pinned.model &&
      item.efforts.includes(pinned.effort) && item.inputModalities.includes("text")))
    throw Error("Research Task policy profile is invalid or unavailable");
  return pinned;
}
