// Local integration of verified, disjoint file ownership into a clean checkout.
// No model turn, commit, push, or human acceptance is performed here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FileScheduler } from "./scheduler.ts";
import type { TaskSnapshot } from "./singleTask.ts";
import type { TaskStorageRegistration } from "./taskService.ts";
import { verifyTaskReviewCheckout, type TaskReviewManifest } from "./taskReviewArtifact.ts";
import { assertVaultRunOutputPaths, type VaultRunConfig } from "./vaultRunConfig.ts";
import { changedGitPaths, pathsOutsideScope } from "./vaultTaskContract.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", timeout: 20_000, maxBuffer: 200_000 });
}
function inside(root: string, path: string): boolean {
  const rel = relative(root.toLowerCase(), path.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function safePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.includes("\\") && !path.includes(":") &&
    !path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}
export interface IntegrationSource {
  config: VaultRunConfig;
  configSha256: string;
  // Trusted runtime metadata; never read from a Task contract or model/browser input.
  readonly resultStorage: Readonly<TaskStorageRegistration> | null;
  // The caller must use its authenticated ledger reader, including any approval verifier.
  readState: () => Promise<TaskSnapshot>;
  // Catalog services supply the latest pinned revision; legacy sources use A.
  readManifest?: () => Promise<TaskReviewManifest>;
}
export interface TaskIntegrationOptions {
  id: string;
  checkout: string;
  baseSha: string;
  outputDir: string;
  scheduler: FileScheduler;
  sources: IntegrationSource[];
  verify: () => Promise<{ outcome: "passed" | "failed"; evidenceRef: string }>;
  signal?: AbortSignal;
  onPhase?: (phase: "capturing" | "applying" | "verifying") => Promise<void>;
  checkBeforePublish?: () => Promise<void>;
  publish?: (settle: () => Promise<void>) => Promise<void>;
}
export interface TaskIntegrationResult {
  status: "ready_for_review" | "failed";
  evidenceRef: string;
  paths: string[];
  acceptedBy: null;
}
interface OwnedFile { path: string; sha256: string | null; source: IntegrationSource; mode: number }

async function writeEvidence(path: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return `${path}#sha256=${hash(bytes)}`;
}
async function optionalEntry(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function targetParents(checkout: string, path: string): Promise<void> {
  let parent = checkout;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const entry = await optionalEntry(parent);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error("Integration parent has unsafe type");
    if (!entry) await mkdir(parent);
    if (!inside(checkout, await realpath(parent))) throw new Error("Integration parent escaped checkout");
  }
}

export async function integrateVerifiedTasks(options: TaskIntegrationOptions): Promise<TaskIntegrationResult> {
  options.signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(options.id) || !/^[a-f0-9]{40}$/i.test(options.baseSha) ||
      !Array.isArray(options.sources) || options.sources.length < 2 || options.sources.length > 8)
    throw new Error("Integration identity/sources invalid");
  const checkout = await realpath(options.checkout);
  const ids = options.sources.map((source) => source.config.runId);
  if (new Set(ids).size !== ids.length) throw new Error("Integration source repeated");
  const scheduled = (await options.scheduler.read()).state;
  const entry = scheduled?.entries.find((item) => item.work.id === options.id);
  if (!scheduled || !entry || entry.status !== "queued" || entry.work.role !== "sol" ||
      entry.work.checkoutMode !== "write" || await realpath(entry.work.checkout) !== checkout ||
      JSON.stringify([...entry.work.dependencies].sort()) !== JSON.stringify([...ids].sort()))
    throw new Error("Integration does not match its registered dependencies and checkout");
  if (git(checkout, ["rev-parse", "HEAD"]).trim() !== options.baseSha || changedGitPaths(checkout).length)
    throw new Error("Integration checkout must be clean at the fixed base");
  const files: OwnedFile[] = [];
  const owners = new Set<string>();
  const manifests = new Map<IntegrationSource, TaskReviewManifest>();
  for (const source of options.sources) {
    const config = source.config;
    if (inside(checkout, await realpath(config.checkout)) || inside(await realpath(config.checkout), checkout))
      throw new Error("Integration and source checkouts must be separate");
    await assertVaultRunOutputPaths({ ...config, checkout, outputDir: options.outputDir,
      schedulerPath: options.scheduler.path });
    await assertVaultRunOutputPaths({ ...config, outputDir: options.outputDir, schedulerPath: options.scheduler.path });
    const state = await source.readState();
    const prior = scheduled.entries.find((item) => item.work.id === config.runId);
    if (state.runId !== config.runId || !["ready_for_review", "accepted"].includes(state.status) ||
        state.verification?.outcome !== "passed" || state.contract.baseSha !== options.baseSha ||
        prior?.status !== "verified" || prior.evidenceRef !== state.verification.evidenceRef ||
        await realpath(prior.work.checkout) !== await realpath(config.checkout))
      throw new Error("Integration source is not currently verified at the same base");
    const manifestPath = join(config.outputDir, "review-manifest.json");
    const manifestEntry = await lstat(manifestPath);
    if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.size > 200_000)
      throw new Error("Integration manifest type/size invalid");
    const manifest = source.readManifest ? await source.readManifest() :
      JSON.parse(await readFile(manifestPath, "utf8")) as TaskReviewManifest;
    if (manifest.schema !== "negi-task-review/1" || manifest.runId !== config.runId ||
        manifest.baseSha !== options.baseSha || manifest.configSha256 !== source.configSha256 ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100 ||
        manifest.files.some((file) => !safePath(file.path) || (file.sha256 !== null && !/^[a-f0-9]{64}$/i.test(file.sha256))) ||
        pathsOutsideScope(manifest.files.map((file) => file.path), state.contract.scope?.allowedPaths ?? []).length)
      throw new Error("Integration manifest differs from the source contract");
    const revision = manifest.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > 99)
      throw new Error("Integration revision number invalid");
    const evidencePath = join(config.outputDir, revision ? `verification-r${revision}.json` : "verification.json");
    const artifactPath = join(config.outputDir, revision ? `review-result-r${revision}.md` : "review-result.md");
    const evidenceEntry = await lstat(evidencePath), artifactEntry = await lstat(artifactPath);
    if (![evidenceEntry, artifactEntry].every((entry) => entry.isFile() && !entry.isSymbolicLink()) ||
        evidenceEntry.size > 2_000_000 || artifactEntry.size > 100_000 ||
        resolve(manifest.review.evidencePath) !== evidencePath || resolve(manifest.review.artifactRoot) !== resolve(config.outputDir) ||
        hash(await readFile(artifactPath)) !== manifest.review.verifiedArtifactSha256)
      throw new Error("Integration pinned artifact or verification type/hash invalid");
    if (state.verification.evidenceRef !== `${evidencePath}#sha256=${hash(await readFile(evidencePath))}` ||
        manifest.review.evidenceSha256 !== hash(await readFile(evidencePath)))
      throw new Error("Integration verification evidence changed");
    if (/^(?:old mode|new mode|rename from|rename to|similarity index|new file mode 100755) /m.test(
      git(config.checkout, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"])))
      throw new Error("File metadata changes require separate integration");
    await verifyTaskReviewCheckout(config, manifest);
    manifests.set(source, manifest);
    for (const file of manifest.files) {
      const key = file.path.toLowerCase();
      if ([...owners].some((owned) => owned === key || owned.startsWith(key + "/") || key.startsWith(owned + "/")))
        throw new Error("Integration file ownership overlaps");
      owners.add(key);
      const baseEntry = git(checkout, ["ls-tree", "HEAD", "--", file.path]).trim();
      if (baseEntry && !/^100(?:644|755) blob /.test(baseEntry)) throw new Error("Integration base file has unsafe type");
      const target = await optionalEntry(join(checkout, file.path));
      if (target && (!baseEntry || !target.isFile() || target.isSymbolicLink()))
        throw new Error("Integration would overwrite an untracked or unsafe target");
      if (!baseEntry && file.sha256 !== null && process.platform !== "win32" &&
          ((await lstat(join(config.checkout, file.path))).mode & 0o111))
        throw new Error("New executable files require a separate integration plan");
      files.push({ ...file, source, mode: baseEntry.startsWith("100755") ? 0o755 : 0o644 });
    }
  }
  options.signal?.throwIfAborted();
  await options.scheduler.claim(options.id, `${options.id}:integration-dispatch`);
  let mutated = false;
  try {
    await options.onPhase?.("capturing");
    await mkdir(options.outputDir);
    // Stage immutable copies before any checkout mutation. Each copy is hash checked.
    for (let i = 0; i < files.length; i++) {
      options.signal?.throwIfAborted();
      const file = files[i];
      if (file.sha256 === null) continue;
      const bytes = await readFile(join(file.source.config.checkout, file.path));
      if (hash(bytes) !== file.sha256) throw new Error("Integration source changed during capture");
      await writeEvidence(join(options.outputDir, `file-${i}.identity.json`), { path: file.path, sha256: file.sha256 });
      const staged = await open(join(options.outputDir, `file-${i}.bin`), "wx", 0o600);
      try { await staged.writeFile(bytes); await staged.sync(); } finally { await staged.close(); }
    }
    for (const [source, manifest] of manifests) await verifyTaskReviewCheckout(source.config, manifest);
    for (const source of options.sources) {
      const state = await source.readState();
      const current = (await options.scheduler.read()).state?.entries.find((item) => item.work.id === source.config.runId);
      if (!["ready_for_review", "accepted"].includes(state.status) || state.verification?.outcome !== "passed" ||
          current?.status !== "verified" || current.evidenceRef !== state.verification.evidenceRef)
        throw new Error("Integration source became invalid before apply");
    }
    if (git(checkout, ["rev-parse", "HEAD"]).trim() !== options.baseSha || changedGitPaths(checkout).length)
      throw new Error("Integration checkout changed before apply");
    options.signal?.throwIfAborted();
    await options.onPhase?.("applying");
    for (let i = 0; i < files.length; i++) {
      options.signal?.throwIfAborted();
      const file = files[i];
      // Any directory creation or file operation below may leave a partial result.
      mutated = true;
      await targetParents(checkout, file.path);
      const target = join(checkout, file.path);
      if (file.sha256 === null) await unlink(target);
      else { await copyFile(join(options.outputDir, `file-${i}.bin`), target); await chmod(target, file.mode); }
    }
    await options.onPhase?.("verifying");
    const verification = await options.verify();
    await options.checkBeforePublish?.(); options.signal?.throwIfAborted();
    // Verification may take time. Recheck the exact source versions before
    // publishing a verified result; changing/revoked sources leave this copy held.
    for (const [source, manifest] of manifests) {
      const state=await source.readState();
      if(!["ready_for_review","accepted"].includes(state.status)||state.verification?.outcome!=="passed")throw Error("Integration source changed during verification");
      if(source.readManifest&&hash(Buffer.from(JSON.stringify(await source.readManifest())))!==hash(Buffer.from(JSON.stringify(manifest))))throw Error("Integration source revision changed during verification");
      await verifyTaskReviewCheckout(source.config,manifest);
    }
    // Commands may modify the checkout even when they exit successfully. Bind
    // the result to the final bytes, paths and modes, including safe parents.
    const paths = changedGitPaths(checkout);
    const expectedPaths = files.map(file => file.path).sort();
    const scopePassed = JSON.stringify([...paths].sort()) === JSON.stringify(expectedPaths);
    let contentPassed = !/^(?:old mode|new mode|new file mode 100755) /m.test(
      git(checkout, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"]));
    for (const file of files) {
      let parent = checkout, safe = true;
      for (const part of file.path.split("/").slice(0, -1)) {
        parent = join(parent, part); const entry = await optionalEntry(parent);
        if (!entry?.isDirectory() || entry.isSymbolicLink() || !inside(checkout, await realpath(parent))) { safe = false; break; }
      }
      const target = safe ? await optionalEntry(join(checkout, file.path)) : null;
      contentPassed &&= safe && (file.sha256 === null ? target === null : Boolean(target?.isFile() &&
        !target.isSymbolicLink() && (process.platform === "win32" || (target.mode & 0o111) === (file.mode & 0o111)) &&
        hash(await readFile(join(checkout, file.path))) === file.sha256));
    }
    const passed = scopePassed && contentPassed && git(checkout, ["rev-parse", "HEAD"]).trim() === options.baseSha &&
      verification.outcome === "passed" && Boolean(verification.evidenceRef);
    const evidenceRef = await writeEvidence(join(options.outputDir, "integration-verification.json"), {
      schema: "negi-task-integration/1", id: options.id, baseSha: options.baseSha,
      sourceRuns: ids, files: files.map(({ source, ...file }) => ({ ...file, runId: source.config.runId })),
      changedPaths: paths, scopePassed, contentPassed, verification, mechanicalChecksPassed: passed,
      humanAcceptance: null, modelTurnStarted: false });
    const settle = async () => {
      await options.checkBeforePublish?.(); options.signal?.throwIfAborted();
      await options.scheduler.append({ key: `${options.id}:integration-settle`, at: new Date().toISOString(),
        action: { type: "settle", workId: options.id, outcome: passed ? "verified" : "failed", evidenceRef, actualCostUsd: null } });
    };
    if (options.publish) await options.publish(settle); else await settle();
    return { status: passed ? "ready_for_review" : "failed", evidenceRef, paths, acceptedBy: null };
  } catch (error) {
    const state = (await options.scheduler.read()).state?.entries.find((item) => item.work.id === options.id);
    if (state?.status === "running") await options.scheduler.append({ key: `${options.id}:integration-error`,
      at: new Date().toISOString(), action: mutated ? { type: "unknown", workId: options.id,
        reason: "Integration may be partial; preserve the checkout and inspect it before releasing the slot" } :
        { type: "settle", workId: options.id, outcome: "failed", evidenceRef: "local:integration-before-apply", actualCostUsd: null } });
    throw error;
  }
}
