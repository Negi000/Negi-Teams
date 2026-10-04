// Journal for replaying local revision metadata. It never edits a checkout or dispatches a model.
import { createHash } from "node:crypto";
import { lstat, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileReviewChain, type ReviewState } from "./reviewChain.ts";
import type { RegisteredReviewCase } from "./reviewService.ts";
import type { TaskSnapshot } from "./singleTask.ts";
import type { TaskReviewManifest } from "./taskReviewArtifact.ts";
import type { VaultRunConfig } from "./vaultRunConfig.ts";
import { pathsOutsideScope } from "./vaultTaskContract.ts";

export const taskRevisionHash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface TaskRevisionJournal {
  schema: "negi-task-revision/1";
  number: number;
  runId: string;
  configSha256: string;
  contractSha256: string;
  contractVersion: number;
  baseSha: string;
  fromManifestSha256: string;
  manifestSha256: string;
  fromArtifactSha256: string;
  artifactSha256: string;
  objectiveId: string;
  feedbackIds: string[];
  fromEvidenceRef: string;
  evidenceRef: string;
  at: string;
  modelTurnStarted: false;
  validationWorkId: string;
}
export interface PinnedTaskRevision {
  journal: TaskRevisionJournal;
  revisionRef: string;
  previous: TaskReviewManifest;
  manifest: TaskReviewManifest;
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
export function taskManifestName(number: number): string { return number ? `review-manifest-r${number}.json` : "review-manifest.json"; }
async function boundedBytes(path: string, limit: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) throw new Error("Task revision file type/size invalid");
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error("Task revision file grew beyond its limit");
  return bytes;
}
function assertManifest(config: VaultRunConfig, configSha256: string, manifest: TaskReviewManifest, number: number) {
  const output = config.outputDir, caseId = `task-${taskRevisionHash(config.runId).slice(0, 24)}`;
  if (manifest.schema !== "negi-task-review/1" || manifest.runId !== config.runId ||
      manifest.configSha256 !== configSha256 || (manifest.revision ?? 0) !== number ||
      manifest.review?.id !== caseId || resolve(manifest.review.artifactRoot) !== resolve(output) ||
      resolve(manifest.review.ledgerPath) !== join(output, "review.jsonl") ||
      resolve(manifest.review.evidencePath) !== join(output, number ? `verification-r${number}.json` : "verification.json") ||
      !sha(manifest.diffSha256) || !sha(manifest.review.verifiedArtifactSha256) || !sha(manifest.review.evidenceSha256) ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100 ||
      manifest.files.some((file) => typeof file.path !== "string" || file.path.includes("\\") || file.path.includes(":") ||
        file.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        (file.sha256 !== null && !sha(file.sha256)))) throw new Error("Task revision manifest differs from registered output");
}
export async function readTaskRevision(config: VaultRunConfig, configSha256: string, number: number): Promise<PinnedTaskRevision> {
  if (!Number.isSafeInteger(number) || number < 1 || number > 99) throw new Error("Task revision number invalid");
  const output = config.outputDir;
  const bytes = await boundedBytes(join(output, `revision-${number}.json`), 100_000);
  const journal = JSON.parse(bytes.toString("utf8")) as TaskRevisionJournal;
  if (journal.schema !== "negi-task-revision/1" || journal.number !== number || journal.runId !== config.runId ||
      journal.configSha256 !== configSha256 || !sha(journal.contractSha256) ||
      !Number.isSafeInteger(journal.contractVersion) || !sha(journal.fromManifestSha256) || !sha(journal.manifestSha256) ||
      !sha(journal.fromArtifactSha256) || !sha(journal.artifactSha256) ||
      typeof journal.baseSha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(journal.baseSha) ||
      !journal.objectiveId || !Array.isArray(journal.feedbackIds) || !journal.feedbackIds.length ||
      journal.feedbackIds.length > 20 || new Set(journal.feedbackIds).size !== journal.feedbackIds.length ||
      !journal.feedbackIds.every((id) => typeof id === "string" && id.length > 0 && id.length < 200) ||
      !Number.isFinite(Date.parse(journal.at)) || journal.modelTurnStarted !== false ||
      journal.validationWorkId !== `${config.runId}:local-revision-${number}`)
    throw new Error("Task revision journal invalid");
  const priorBytes = await boundedBytes(join(output, taskManifestName(number - 1)), 200_000);
  const nextBytes = await boundedBytes(join(output, taskManifestName(number)), 200_000);
  if (taskRevisionHash(priorBytes) !== journal.fromManifestSha256 || taskRevisionHash(nextBytes) !== journal.manifestSha256)
    throw new Error("Task revision manifest bytes changed");
  const previous = JSON.parse(priorBytes.toString("utf8")) as TaskReviewManifest;
  const manifest = JSON.parse(nextBytes.toString("utf8")) as TaskReviewManifest;
  assertManifest(config, configSha256, previous, number - 1); assertManifest(config, configSha256, manifest, number);
  if (previous.baseSha !== journal.baseSha || manifest.baseSha !== journal.baseSha ||
      previous.review.verifiedArtifactSha256 !== journal.fromArtifactSha256 ||
      manifest.review.verifiedArtifactSha256 !== journal.artifactSha256 || journal.artifactSha256 === journal.fromArtifactSha256 ||
      journal.fromEvidenceRef !== `${previous.review.evidencePath}#sha256=${previous.review.evidenceSha256}` ||
      journal.evidenceRef !== `${manifest.review.evidencePath}#sha256=${manifest.review.evidenceSha256}`)
    throw new Error("Task revision journal does not bind both artifacts and verification records");
  for (const [item, version] of [[previous, number - 1], [manifest, number]] as const) {
    const artifact = join(output, version ? `review-result-r${version}.md` : "review-result.md");
    if (taskRevisionHash(await boundedBytes(artifact, 100_000)) !== item.review.verifiedArtifactSha256 ||
        taskRevisionHash(await boundedBytes(item.review.evidencePath, 2_000_000)) !== item.review.evidenceSha256)
      throw new Error("Task revision artifact or evidence bytes changed");
  }
  return { journal, previous, manifest, revisionRef: `local:task-revision:${number}:sha256=${taskRevisionHash(bytes)}` };
}
export function revisionMatchesTask(pinned: PinnedTaskRevision, state: TaskSnapshot): boolean {
  const j = pinned.journal;
  return state.runId === j.runId && state.contract.sha256 === j.contractSha256 &&
    state.contract.version === j.contractVersion && state.contract.baseSha === j.baseSha &&
    `${state.contract.vaultId}@${state.contract.version}:${state.contract.sha256}` === j.objectiveId &&
    !pathsOutsideScope(pinned.manifest.files.map((file) => file.path), state.contract.scope?.allowedPaths ?? []).length;
}
export async function writeTaskRevisionPointer(config: VaultRunConfig, pinned: PinnedTaskRevision): Promise<void> {
  const bytes = Buffer.from(JSON.stringify({ schema: "negi-task-review-current/1", number: pinned.journal.number,
    revisionRef: pinned.revisionRef }) + "\n");
  const temp = join(config.outputDir, `review-current-r${pinned.journal.number}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !Buffer.from(await boundedBytes(temp, 1000)).equals(bytes)) throw error;
  }
  const target = join(config.outputDir, "review-current.json");
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Task revision pointer has unsafe type"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(temp, target);
}
/** Replays only recorded local metadata; provider/model execution is never retried. */
export async function replayRevisionReview(pinned: PinnedTaskRevision,
  readState: (item: RegisteredReviewCase) => Promise<ReviewState>): Promise<void> {
  const { journal: j, manifest } = pinned;
  let state = await readState(manifest.review);
  const ledger = new FileReviewChain(manifest.review.ledgerPath);
  if (state.artifacts.at(-1)?.sha256 === j.fromArtifactSha256) {
    if (state.acceptance || state.revoked || !j.feedbackIds.every((id) => state.feedback.some((f) =>
      f.id === id && f.kind === "correction" && f.targetSha256 === j.fromArtifactSha256)))
      throw new Error("Task revision no longer matches unaccepted targeted corrections");
    await ledger.append({ key: `task-revision:${j.number}:review`, at: j.at, action: { type: "revise",
      fromSha256: j.fromArtifactSha256, feedbackIds: j.feedbackIds, sameObjective: true,
      artifact: { ref: join(manifest.review.artifactRoot, `review-result-r${j.number}.md`),
        sha256: j.artifactSha256, objectiveId: j.objectiveId } } });
    state = await readState(manifest.review);
  }
  if (state.artifacts.at(-1)?.sha256 !== j.artifactSha256 || !state.revisions.some((r) =>
    r.fromSha256 === j.fromArtifactSha256 && r.toSha256 === j.artifactSha256 && r.sameObjective &&
    JSON.stringify(r.feedbackIds) === JSON.stringify(j.feedbackIds))) throw new Error("Task revision chain changed");
  if (state.verification?.artifactSha256 !== j.artifactSha256 || state.verification.evidenceRef !== manifest.review.evidencePath ||
      state.verification.outcome !== "passed") {
    if (state.acceptance || state.revoked) throw new Error("Accepted/revoked revision cannot be reverified automatically");
    await ledger.append({ key: `task-revision:${j.number}:verify`, at: j.at, action: { type: "verify",
      artifactSha256: j.artifactSha256, evidenceRef: manifest.review.evidencePath, outcome: "passed" } });
  }
}
