// Fixed source data for a new, explicitly confirmed, single-writer Task.
// This module never applies patches, dispatches a model, or accepts a result.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
import type { TaskExecutionProfile } from "./taskAuthoring.ts";
import type { LocalTaskService } from "./taskService.ts";
import { parseVaultRunConfig, type VerificationCommand } from "./vaultRunConfig.ts";
import { pathsOutsideScope } from "./vaultTaskContract.ts";

const exec = promisify(execFile);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["--no-replace-objects", ...args], { cwd, env: withoutControlPlaneEnv(), windowsHide: true,
    timeout: 20_000, maxBuffer: 200_000 })).stdout.trim();
}
async function common(cwd: string) { const path = await realpath(await git(cwd,
  ["rev-parse", "--path-format=absolute", "--git-common-dir"])); return process.platform === "win32" ? path.toLowerCase() : path; }
export interface IntegrationResolution {
  schema: "negi-integration-resolution/1"; hash: string; profileId: string; profileHash: string; baseSha: string;
  paths: string[]; overlappingPaths: string[]; resources: string[]; verification: VerificationCommand[];
  sources: Array<{ runId: string; title: string; configSha256: string; manifestSha256: string;
    taskId: string; version: number; revision: number; contractSha256: string; artifactSha256: string;
    reviewId: string; verificationRef: string; acceptance: string[]; invariants: string[]; outOfScope: string[];
    references: Array<{ id: string; version: number; sha256: string }>; content: string }>;
}
export class IntegrationResolutionPlanLimitError extends Error {}
/** Caller holds the Task/review source guard through capture and its operation. */
export async function captureIntegrationResolution(profile: TaskExecutionProfile, tasks: LocalTaskService,
  ids: string[]): Promise<IntegrationResolution> {
  if (profile.config.taskMode === "read_only_research" || !Array.isArray(ids) || ids.length < 2 || ids.length > 8 ||
    new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(id)))
    throw Error("Resolution requires two to eight distinct code Tasks");
  const scheduler = (await tasks.registeredScheduler(profile.config.schedulerPath).read()).state;
  if (!scheduler) throw Error("Resolution scheduler unavailable");
  const paths: string[] = [], overlapping = new Set<string>(), resources = new Map<string, string>();
  const addResource = (resource: string) => {
    if (!resources.has(resource.toLowerCase())) resources.set(resource.toLowerCase(), resource);
  };
  profile.config.resources.forEach(addResource);
  const commands = new Map<string, VerificationCommand>();
  function addCommand(command: VerificationCommand) {
    const previous = commands.get(command.requirement);
    if (previous && hash(previous) !== hash(command)) throw Error("Verification labels select different fixed commands");
    commands.set(command.requirement, structuredClone(command));
  }
  profile.config.verification.forEach(addCommand);
  const sources: IntegrationResolution["sources"] = []; let baseSha: string | undefined;
  for (const id of [...ids].sort()) {
    const source = await tasks.integrationSource(id), state = await source.readState(), manifest = await source.readManifest!();
    const project = await tasks.knowledgeSource(id), entry = scheduler.entries.find(e => e.work.id === id);
    if (project.project !== profile.project || await realpath(source.config.vault) !== await realpath(profile.config.vault) ||
      await common(source.config.checkout) !== await common(profile.repository) ||
      await realpath(source.config.schedulerPath) !== await realpath(profile.config.schedulerPath) ||
      !["ready_for_review", "accepted"].includes(state.status) || state.verification?.outcome !== "passed" ||
      entry?.status !== "verified" || entry.evidenceRef !== state.verification.evidenceRef ||
      manifest.baseSha !== state.contract.baseSha || (baseSha && baseSha !== manifest.baseSha))
      throw Error("Resolution sources must be current verified results in the same project, repository and base");
    baseSha = manifest.baseSha;
    if (!state.contract.sourceNotes?.length) throw Error("Resolution source specification references unavailable");
    await tasks.verifyIntegrationContract(id);
    if (/^\s*(?:rename|copy|mode change) /m.test(await git(source.config.checkout,
      ["diff", "--no-ext-diff", "--no-textconv", "--summary", "--find-renames", "HEAD"])))
      throw Error("File metadata changes need a separate resolution plan");
    if (/^(?:old mode|new mode|rename from|rename to|similarity index|new file mode 100755) /m.test(await git(source.config.checkout,
      ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"]))) throw Error("File metadata changes need a separate resolution plan");
    if (pathsOutsideScope(manifest.files.map(f => f.path), profile.allowedPaths).length)
      throw Error("Resolution exceeds configured project scope");
    for (const file of manifest.files) {
      if (file.sha256 !== null && process.platform !== "win32" && !await git(profile.repository,
        ["ls-tree", manifest.baseSha, "--", file.path]) && ((await lstat(join(source.config.checkout, file.path))).mode & 0o111))
        throw Error("New executable files need a separate resolution plan");
      const key = file.path.toLowerCase();
      for (const prior of paths) { const other = prior.toLowerCase();
        if (other === key || other.startsWith(key + "/") || key.startsWith(other + "/")) { overlapping.add(prior); overlapping.add(file.path); }
      }
      paths.push(file.path);
    }
    const artifact = await tasks.integrationArtifact(id, manifest.review.verifiedArtifactSha256);
    sources.push({ runId: id, title: tasks.list().find(t => t.id === id)!.title, configSha256: source.configSha256,
      manifestSha256: hash(manifest), taskId: state.contract.vaultId, version: state.contract.version, revision: manifest.revision ?? 0,
      contractSha256: state.contract.sha256, artifactSha256: artifact.artifactSha256, reviewId: artifact.id,
      verificationRef: state.verification.evidenceRef, acceptance: [...state.contract.acceptance],
      invariants: [...(state.contract.invariants ?? [])], outOfScope: [...(state.contract.scope?.out ?? [])],
      references: state.contract.sourceNotes.filter(s => s.id !== state.contract.vaultId).map(({ id, version, sha256 }) => ({ id, version, sha256 })),
      content: artifact.content });
    source.config.verification.forEach(addCommand); source.config.resources.forEach(addResource);
  }
  if (!overlapping.size) throw Error("Disjoint results use the existing integration flow");
  const acceptance = [...new Set(sources.flatMap(source => source.acceptance))];
  const references = new Map<string, { version: number; sha256: string }>();
  for (const reference of sources.flatMap(source => source.references)) {
    const previous = references.get(reference.id);
    if (previous && (previous.version !== reference.version || previous.sha256 !== reference.sha256))
      throw Error("Source specification references select different fixed versions; review the source results");
    references.set(reference.id, reference);
  }
  if (acceptance.length > 20 || acceptance.some(condition => condition.length > 300 || condition !== condition.trim() ||
      condition.includes("```") || condition.includes("\0")) || references.size > 50 || new Set(paths).size > 20)
    throw new IntegrationResolutionPlanLimitError("Combined source conditions/references/paths exceed the new contract limits; decompose and review the work");
  const core = { schema: "negi-integration-resolution/1" as const, profileId: profile.id, profileHash: profile.hash, baseSha: baseSha!,
    paths: [...new Set(paths)].sort(), overlappingPaths: [...overlapping].sort(), resources: [...resources.values()].sort(),
    verification: [...commands.values()], sources };
  // Reject an unregistrable union before any approval, Vault write or worktree.
  try { parseVaultRunConfig({ ...profile.config, resources: core.resources, verification: core.verification }); }
  catch { throw new IntegrationResolutionPlanLimitError("Combined verification/resources exceed the execution configuration limits; decompose and review the work"); }
  // Preserve every original artifact. Oversized input must be decomposed, never truncated.
  if (JSON.stringify(core).length > 8_000 || Buffer.byteLength(JSON.stringify(core)) > 24_000)
    throw new IntegrationResolutionPlanLimitError("Resolution sources exceed the fixed Context Pack budget; decompose and review the work");
  return { ...core, hash: hash(core) };
}
