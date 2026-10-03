// Pins an already verified integration for separately authenticated human review.
// This never applies a diff, starts a model, accepts a result, commits or pushes.
import { createHash } from "node:crypto";
import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
import { execFileSync } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FileScheduler } from "./scheduler.ts";
import type { RegisteredReviewCase } from "./reviewService.ts";
import type { IntegrationSource } from "./taskIntegration.ts";
import { verifyTaskReviewCheckout, type TaskReviewManifest } from "./taskReviewArtifact.ts";
import { changedGitPaths, pathsOutsideScope } from "./vaultTaskContract.ts";
import { assertVaultRunOutputPaths } from "./vaultRunConfig.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface IntegrationReviewOptions {
  id: string; title: string; checkout: string; baseSha: string; outputDir: string;
  evidenceSha256: string; limits: string;
  sources: IntegrationSource[]; scheduler: FileScheduler;
}
export interface IntegrationSourcePin {
  runId: string; taskId: string; taskVersion: number; contractSha256: string;
  configSha256: string; manifestSha256: string; artifactSha256: string; evidenceSha256: string;
  revision: number; acceptance: string[];
}
export interface IntegrationReviewManifest {
  schema: "negi-integration-review/1";
  id: string; baseSha: string; diffSha256: string; registrationSha256: string;
  sourcePins: IntegrationSourcePin[];
  files: Array<{ path: string; sha256: string | null; runId: string; mode: number }>;
  programEvidenceSha256: string;
  review: RegisteredReviewCase;
}
function git(checkout: string, args: string[]): string {
  return execFileSync("git", args, { cwd: checkout, env: withoutControlPlaneEnv(), encoding: "utf8", windowsHide: true,
    timeout: 20_000, maxBuffer: 150_000 });
}
function patch(checkout: string): string {
  return git(checkout, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames", "HEAD"]);
}
function safePath(path: unknown): path is string {
  return typeof path === "string" && Boolean(path) && !isAbsolute(path) && !path.includes("\\") &&
    !path.includes(":") && !path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}
async function bounded(path: string, maximum: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximum) throw new Error("Integration review file type/size invalid");
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error("Integration review file changed size");
  return bytes;
}
async function fileHash(checkout: string, path: string): Promise<string | null> {
  const target = join(checkout, path);
  try {
    const actual = await realpath(target), rel = relative(checkout, actual);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Integration file escaped checkout");
    return hash(await bounded(target, 10_000_000));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function pinned(path: string, bytes: Buffer): Promise<void> {
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hash(await bounded(path, 200_000)) !== hash(bytes)) throw new Error("Existing integration review differs from its fixed version");
  }
}
function registration(options: IntegrationReviewOptions): string {
  return hash(JSON.stringify({ id: options.id, title: options.title, checkout: resolve(options.checkout),
    outputDir: resolve(options.outputDir), baseSha: options.baseSha, evidenceSha256: options.evidenceSha256,
    limits: options.limits, sourceRunIds: options.sources.map(source => source.config.runId),
    scheduler: resolve(options.scheduler.path) }));
}
async function sourceSnapshot(options: IntegrationReviewOptions) {
  const schedule = (await options.scheduler.read()).state;
  const pins: IntegrationSourcePin[] = [];
  const files: IntegrationReviewManifest["files"] = [];
  for (const source of options.sources) {
    const state = await source.readState(), entry = schedule?.entries.find(row => row.work.id === source.config.runId);
    const manifest: TaskReviewManifest = source.readManifest ? await source.readManifest() :
      JSON.parse((await bounded(join(source.config.outputDir, "review-manifest.json"), 200_000)).toString("utf8"));
    if (state.runId !== source.config.runId || !["ready_for_review", "accepted"].includes(state.status) ||
        state.verification?.outcome !== "passed" || state.contract.baseSha !== options.baseSha ||
        entry?.status !== "verified" || entry.evidenceRef !== state.verification.evidenceRef ||
        await realpath(entry.work.checkout) !== await realpath(source.config.checkout) ||
        manifest.schema !== "negi-task-review/1" || manifest.runId !== state.runId ||
        manifest.baseSha !== options.baseSha || manifest.configSha256 !== source.configSha256 ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100 ||
        manifest.files.some(file => !safePath(file.path) || (file.sha256 !== null && !/^[a-f0-9]{64}$/.test(file.sha256))) ||
        pathsOutsideScope(manifest.files.map(file => file.path), state.contract.scope?.allowedPaths ?? []).length ||
        state.verification.evidenceRef !== `${manifest.review.evidencePath}#sha256=${manifest.review.evidenceSha256}` ||
        hash(await bounded(manifest.review.evidencePath, 2_000_000)) !== manifest.review.evidenceSha256 ||
        hash(await bounded(join(source.config.outputDir, manifest.revision ? `review-result-r${manifest.revision}.md` : "review-result.md"), 100_000)) !== manifest.review.verifiedArtifactSha256)
      throw new Error("Integration source is no longer its pinned verified result");
    await verifyTaskReviewCheckout(source.config, manifest);
    if (/^(?:old mode|new mode|rename from|rename to|similarity index) /m.test(patch(source.config.checkout)))
      throw new Error("File metadata changes require separate integration");
    for (const file of manifest.files) {
      const baseEntry = git(source.config.checkout, ["ls-tree", options.baseSha, "--", file.path]).trim();
      if (baseEntry && !/^100(?:644|755) blob /.test(baseEntry)) throw new Error("Integration source base file has unsafe type");
      files.push({ ...file, runId: source.config.runId, mode: baseEntry.startsWith("100755") ? 0o755 : 0o644 });
    }
    pins.push({ runId: state.runId, taskId: state.contract.vaultId, taskVersion: state.contract.version,
      contractSha256: state.contract.sha256, configSha256: source.configSha256, manifestSha256: hash(JSON.stringify(manifest)),
      artifactSha256: manifest.review.verifiedArtifactSha256, evidenceSha256: manifest.review.evidenceSha256,
      revision: manifest.revision ?? 0, acceptance: state.contract.acceptance });
  }
  return { pins, files };
}
function sameFiles(a: IntegrationReviewManifest["files"], b: IntegrationReviewManifest["files"]): boolean {
  const normalize = (files: IntegrationReviewManifest["files"]) => files.map(({ path, sha256, runId, mode }) =>
    ({ path, sha256, runId, mode })).sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
async function safeRoots(options: IntegrationReviewOptions): Promise<void> {
  if (![options.checkout, options.outputDir, options.scheduler.path].every(isAbsolute))
    throw new Error("Integration review paths must be absolute");
  for (const source of options.sources) {
    await assertVaultRunOutputPaths({ ...source.config, checkout: options.checkout, outputDir: options.outputDir,
      schedulerPath: options.scheduler.path });
    await assertVaultRunOutputPaths({ ...source.config, outputDir: options.outputDir, schedulerPath: options.scheduler.path });
  }
}
async function evidence(options: IntegrationReviewOptions) {
  const path = join(options.outputDir, "integration-verification.json"), bytes = await bounded(path, 200_000);
  const value = JSON.parse(bytes.toString("utf8"));
  const ids = options.sources.map(source => source.config.runId);
  const entry = (await options.scheduler.read()).state?.entries.find(row => row.work.id === options.id);
  if (hash(bytes) !== options.evidenceSha256 || value.schema !== "negi-task-integration/1" || value.id !== options.id ||
      value.baseSha !== options.baseSha || value.mechanicalChecksPassed !== true || value.scopePassed !== true ||
      value.contentPassed !== true || value.humanAcceptance !== null || value.modelTurnStarted !== false ||
      JSON.stringify(value.sourceRuns) !== JSON.stringify(ids) || !Array.isArray(value.files) ||
      !value.files.length || value.files.length > 100 || !Array.isArray(value.changedPaths) ||
      value.files.some((file: { path: unknown; sha256: unknown; runId: unknown; mode: unknown }) => !safePath(file.path) ||
        (file.sha256 !== null && (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) ||
        !ids.includes(String(file.runId)) || ![0o644, 0o755].includes(Number(file.mode))) ||
      new Set(value.files.map((file: { path: string }) => file.path.toLowerCase())).size !== value.files.length ||
      JSON.stringify([...value.changedPaths].sort()) !== JSON.stringify(value.files.map((file: { path: string }) => file.path).sort()) ||
      entry?.status !== "verified" || entry.evidenceRef !== `${path}#sha256=${options.evidenceSha256}` ||
      await realpath(entry.work.checkout) !== await realpath(options.checkout) ||
      JSON.stringify([...entry.work.dependencies].sort()) !== JSON.stringify([...ids].sort()))
    throw new Error("Integration evidence or dependency state is not the registered verified version");
  const programPath = join(options.outputDir, "command-verification.json");
  const programs = await bounded(programPath, 200_000), programSha = hash(programs), checks = JSON.parse(programs.toString("utf8"));
  if (value.verification?.outcome !== "passed" ||
      resolve(value.verification.evidenceRef?.split("#sha256=")[0] ?? "") !== resolve(programPath) ||
      value.verification.evidenceRef !== `${programPath}#sha256=${programSha}` ||
      checks.mechanicalChecksPassed !== true || !Array.isArray(checks.checks) || !checks.checks.length ||
      checks.checks.length > 100 || checks.checks.some((check: { requirement: unknown; passed: unknown }) =>
        typeof check.requirement !== "string" || !check.requirement.trim() || check.passed !== true))
    throw new Error("Integration program verification is not the pinned passing evidence");
  return { path, bytes, value, programs, programSha };
}

async function integrationContent(options: IntegrationReviewOptions, files: IntegrationReviewManifest["files"],
  pins: IntegrationSourcePin[], programs: Buffer, changes: string): Promise<Buffer> {
  const sections: string[] = [];
  const untracked = new Set(git(options.checkout, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
  for (const file of files) if (untracked.has(file.path)) {
    const bytes = await bounded(join(options.checkout, file.path), 75_000);
    if (bytes.includes(0)) throw new Error("Integration binary file requires review outside the text preview");
    sections.push(`### New file: ${file.path}\n\n\`\`\`\n${bytes.toString("utf8")}\n\`\`\``);
  }
  const acceptance = pins.flatMap(pin => pin.acceptance.map(item => `- ${pin.taskId}: ${item}`));
  acceptance.push("- 統合後の差分と元Taskの固定版が一致し、記録された統合検証が成功している。");
  const content = `# ${options.title}\n\nIntegration: ${options.id}\nObjective: 検証済みTaskの統合成果を確認する\nBase SHA: ${options.baseSha}\n\n` +
    `## Acceptance criteria\n\n${acceptance.join("\n")}\n\n## Mechanical verification\n\n${JSON.stringify({ ...JSON.parse(programs.toString("utf8")), sourcePins: pins }, null, 2)}\n\n` +
    `## Git diff\n\n\`\`\`diff\n${changes}\n\`\`\`\n\n${sections.join("\n\n")}\n`;
  const bytes = Buffer.from(content);
  if (bytes.length > 100_000) throw new Error("Integration result exceeds bounded web review preview");
  return bytes;
}

export async function verifyIntegrationReview(options: IntegrationReviewOptions, manifest: IntegrationReviewManifest): Promise<void> {
  await safeRoots(options);
  const sources = await sourceSnapshot(options), changes = patch(options.checkout);
  if (manifest.schema !== "negi-integration-review/1" || manifest.id !== options.id ||
      manifest.registrationSha256 !== registration(options) || manifest.baseSha !== options.baseSha ||
      git(options.checkout, ["rev-parse", "HEAD"]).trim() !== options.baseSha ||
      hash(changes) !== manifest.diffSha256 ||
      JSON.stringify(changedGitPaths(options.checkout)) !== JSON.stringify(manifest.files.map(file => file.path).sort()) ||
      JSON.stringify(sources.pins) !== JSON.stringify(manifest.sourcePins))
    throw new Error("Reviewed integration or source revision changed");
  const current = await evidence(options);
  if (current.programSha !== manifest.programEvidenceSha256 || JSON.stringify(current.value.files) !== JSON.stringify(manifest.files) ||
      !sameFiles(sources.files, manifest.files))
    throw new Error("Reviewed integration evidence changed");
  for (const file of manifest.files) {
    if (await fileHash(options.checkout, file.path) !== file.sha256 ||
        (file.sha256 !== null && process.platform !== "win32" &&
         ((await lstat(join(options.checkout, file.path))).mode & 0o777) !== file.mode))
      throw new Error("Reviewed integration file changed");
  }
  if (hash(await integrationContent(options, manifest.files, sources.pins, current.programs, changes)) !== manifest.review.verifiedArtifactSha256)
    throw new Error("Reviewed integration preview differs from the verified content");
}

export async function captureIntegrationReview(options: IntegrationReviewOptions): Promise<IntegrationReviewManifest> {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(options.id) || !/^[a-f0-9]{40}$/.test(options.baseSha) ||
      !/^[a-f0-9]{64}$/.test(options.evidenceSha256) || !options.title.trim() || options.title.length > 200 ||
      /[\r\n]/.test(options.title) || !options.limits.trim() || options.limits.length > 2000 ||
      options.sources.length < 2 || options.sources.length > 8 ||
      new Set(options.sources.map(source => source.config.runId)).size !== options.sources.length)
    throw new Error("Integration review registration invalid");
  await safeRoots(options);
  const current = await evidence(options), { pins } = await sourceSnapshot(options), changes = patch(options.checkout);
  const bytes = await integrationContent(options, current.value.files, pins, current.programs, changes);
  const artifact = join(options.outputDir, "integration-review-result.md");
  const review: RegisteredReviewCase = { id: `integration-${hash(options.id).slice(0, 24)}`, title: options.title,
    ledgerPath: join(options.outputDir, "integration-review.jsonl"), artifactRoot: options.outputDir,
    verifiedArtifactSha256: hash(bytes), evidencePath: current.path, evidenceSha256: options.evidenceSha256,
    verificationSummary: "統合した差分と元Taskの固定版・記録された検証を照合済み。", limits: options.limits };
  const manifest: IntegrationReviewManifest = { schema: "negi-integration-review/1", id: options.id,
    baseSha: options.baseSha, registrationSha256: registration(options), diffSha256: hash(changes),
    sourcePins: pins, files: current.value.files, programEvidenceSha256: current.programSha, review };
  await verifyIntegrationReview(options, manifest);
  await pinned(artifact, bytes);
  await pinned(join(options.outputDir, "integration-review-manifest.json"), Buffer.from(JSON.stringify(manifest) + "\n"));
  return manifest;
}
