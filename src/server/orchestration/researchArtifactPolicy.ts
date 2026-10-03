import type { ContractRef } from "./singleTask.ts";

// Even control characters take at most six JSON bytes per UTF-8 input byte.
// Fixed metadata + full findings therefore fit the existing 100KB web preview.
export const RESEARCH_FINDINGS_BYTES=12_000;
export function researchReviewMetadata(contract:ContractRef,requirements=contract.verification??[]) {
  const value={schema:"negi-task-readonly-artifact/1",task:{vaultId:contract.vaultId,version:contract.version,
    sha256:contract.sha256,baseSha:contract.baseSha},acceptance:contract.acceptance,
    verification:{checks:[...requirements,"git diff --check"].map(requirement=>({requirement,passed:true}))}};
  if(Buffer.byteLength(JSON.stringify(value,null,2))>20_000)throw Error("Research contract exceeds bounded review metadata; split it before dispatch");
  return value;
}
