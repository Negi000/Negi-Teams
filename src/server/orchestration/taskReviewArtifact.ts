// A bounded, immutable review package for one verified Git result.
import { createHash } from "node:crypto";
import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
import { execFileSync } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { FileReviewChain } from "./reviewChain.ts";
import type { RegisteredReviewCase } from "./reviewService.ts";
import type { TaskSnapshot } from "./singleTask.ts";
import { changedGitPaths, pathsOutsideScope } from "./vaultTaskContract.ts";
import type { VaultRunConfig } from "./vaultRunConfig.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface TaskReviewManifest {
  schema: "negi-task-review/1";
  runId: string;
  configSha256: string;
  baseSha: string;
  diffSha256: string;
  files: Array<{ path: string; sha256: string | null }>;
  review: RegisteredReviewCase;
  revision?: number;
}
export interface TaskReviewCaptureOptions {
  revision?: number;
  // Revision metadata is replayed from a local journal by the Task service.
  deferLedger?: boolean;
}
function git(checkout: string, args: string[]): string {
  return execFileSync("git", args, { cwd: checkout, env: withoutControlPlaneEnv(), encoding: "utf8", windowsHide: true,
    timeout: 20_000, maxBuffer: 150_000 });
}
function diff(checkout: string): string {
  return git(checkout, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames", "HEAD"]);
}
async function fileHash(checkout: string, path: string): Promise<string | null> {
  const target = join(checkout, path);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try { entry = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 10_000_000)
    throw new Error("Task result file cannot be captured safely within the review limit");
  const actual = await realpath(target);
  const rel = relative(checkout, actual);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Task result path escaped checkout");
  return hash(await readFile(actual));
}
export async function taskReviewCheckoutFingerprint(config: VaultRunConfig): Promise<string> {
  const paths=changedGitPaths(config.checkout),files=[];
  for(const path of paths)files.push({path,sha256:await fileHash(config.checkout,path)});
  return hash(JSON.stringify({baseSha:git(config.checkout,["rev-parse","HEAD"]).trim(),
    diffSha256:hash(diff(config.checkout)),files}));
}
async function writePinned(path: string, bytes: Buffer): Promise<void> {
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await lstat(path)).isSymbolicLink() || hash(await readFile(path)) !== hash(bytes))
      throw new Error("Review artifact differs from an existing pinned version");
  }
}

export async function captureTaskReview(config: VaultRunConfig, configSha256: string,
  title: string, state: TaskSnapshot, options: TaskReviewCaptureOptions = {}): Promise<TaskReviewManifest> {
  const revision = options.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 99 || (revision > 0 && !options.deferLedger))
    throw new Error("Task review revision options invalid");
  if (state.runId !== config.runId || state.status !== "ready_for_review" || state.verification?.outcome !== "passed")
    throw new Error("Only a verified, unaccepted Task result can be registered for review");
  const evidenceMatch = state.verification.evidenceRef.match(/^(.+)#sha256=([0-9a-f]{64})$/i);
  const evidencePath = join(config.outputDir, revision ? `verification-r${revision}.json` : "verification.json");
  if (!evidenceMatch || await realpath(evidenceMatch[1]) !== await realpath(evidencePath))
    throw new Error("Task verification is not the registered local evidence");
  const evidence = await readFile(evidencePath);
  if (hash(evidence) !== evidenceMatch[2]) throw new Error("Task verification bytes changed");
  const paths = changedGitPaths(config.checkout);
  if (!paths.length || pathsOutsideScope(paths, state.contract.scope?.allowedPaths ?? []).length)
    throw new Error("Task review is outside its fixed scope");
  const head = git(config.checkout, ["rev-parse", "HEAD"]).trim();
  if (head !== state.contract.baseSha) throw new Error("Task base changed before result capture");
  const patch = diff(config.checkout);
  const files = [];
  const sections = [];
  const untracked = new Set(git(config.checkout, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
  for (const path of paths) {
    const sha256 = await fileHash(config.checkout, path);
    files.push({ path, sha256 });
    if (untracked.has(path)) {
      const bytes = await readFile(join(config.checkout, path));
      if (bytes.length > 75_000 || bytes.includes(0)) throw new Error("New file requires review outside the text preview");
      sections.push(`### New file: ${path}\n\n\`\`\`\n${bytes.toString("utf8")}\n\`\`\``);
    }
  }
  const content = `# ${title}\n\nTask: ${state.contract.vaultId} v${state.contract.version}\n` +
    `Objective: ${state.contract.objective}\nBase SHA: ${head}\n\n## Acceptance criteria\n\n` +
    state.contract.acceptance.map((item) => `- ${item}`).join("\n") +
    `\n\n## Mechanical verification\n\n${evidence.toString("utf8")}\n\n## Git diff\n\n\`\`\`diff\n${patch}\n\`\`\`\n\n` +
    sections.join("\n\n") + "\n";
  const bytes = Buffer.from(content);
  if (bytes.length > 100_000) throw new Error("Task result exceeds bounded web review preview");
  const artifactPath = join(config.outputDir, revision ? `review-result-r${revision}.md` : "review-result.md");
  await writePinned(artifactPath, bytes);
  const caseId = `task-${hash(config.runId).slice(0, 24)}`;
  const review: RegisteredReviewCase = { id: caseId, title, ledgerPath: join(config.outputDir, "review.jsonl"),
    artifactRoot: config.outputDir, verifiedArtifactSha256: hash(bytes), evidencePath,
    evidenceSha256: hash(evidence), verificationSummary: "固定契約の検証コマンド・基準SHA・変更範囲を確認しました。",
    limits: "コマンドの終了状態と差分の範囲の検証です。内容・受入条件の達成は利用者が確認してください。worktreeはOS sandboxではありません。" };
  if (!options.deferLedger) {
    const ledger = new FileReviewChain(review.ledgerPath);
    await ledger.append({ key: `${caseId}:create`, at: new Date().toISOString(), action: { type: "create",
      caseId, runId: config.runId, artifact: { ref: artifactPath, sha256: review.verifiedArtifactSha256,
        objectiveId: `${state.contract.vaultId}@${state.contract.version}:${state.contract.sha256}` } } });
    await ledger.append({ key: `${caseId}:verify`, at: new Date().toISOString(), action: { type: "verify",
      artifactSha256: review.verifiedArtifactSha256, evidenceRef: evidencePath, outcome: "passed" } });
  }
  const manifest: TaskReviewManifest = { schema: "negi-task-review/1", runId: config.runId,
    configSha256, baseSha: head, diffSha256: hash(patch), files, review,
    ...(revision ? { revision } : {}) };
  await verifyTaskReviewCheckout(config, manifest);
  await writePinned(join(config.outputDir, revision ? `review-manifest-r${revision}.json` : "review-manifest.json"),
    Buffer.from(JSON.stringify(manifest) + "\n"));
  return manifest;
}

export async function verifyTaskReviewCheckout(config: VaultRunConfig, manifest: TaskReviewManifest): Promise<void> {
  if (manifest.runId !== config.runId || git(config.checkout, ["rev-parse", "HEAD"]).trim() !== manifest.baseSha ||
      hash(diff(config.checkout)) !== manifest.diffSha256 ||
      JSON.stringify(changedGitPaths(config.checkout)) !== JSON.stringify(manifest.files.map((file) => file.path)))
    throw new Error("Reviewed Git result changed after verification");
  for (const file of manifest.files) if (await fileHash(config.checkout, file.path) !== file.sha256)
    throw new Error("Reviewed file changed after verification");
}
