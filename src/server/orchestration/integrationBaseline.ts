// A reviewed integration becomes a separate, reachable Git checkpoint. The
// reviewed checkout, its index, HEAD and branch remain the review's original version.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import { verifyIntegrationReview, type IntegrationReviewOptions, type IntegrationReviewManifest } from "./integrationReview.ts";
import type { LocalReviewService } from "./reviewService.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, args: string[], env = process.env, input?: Buffer | string): string {
  return execFileSync("git", ["--no-replace-objects", ...args], { cwd, env, input, encoding: "utf8", windowsHide: true,
    timeout: 20_000, maxBuffer: 200_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
async function common(cwd: string): Promise<string> {
  const path=await realpath(git(cwd,["rev-parse","--path-format=absolute","--git-common-dir"]));
  return process.platform==="win32"?path.toLowerCase():path;
}
async function read(path: string): Promise<Record<string, string> | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 10_000) throw Error("Baseline record invalid");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function save(path: string, value: Record<string, string>): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
}
export interface IntegrationBase {
  id: string; profileId: string; reviewId: string; artifactSha256: string;
  parentSha: string; baseSha: string; treeSha: string; requestId: string; resultRequestId: string;
  sourceRuns:string; integrationManifestSha256:string;
}
export interface IntegrationBaseChoice {
  id: string; profileId: string; projectTitle:string; title: string; reviewId: string;
  artifactSha256: string; baseSha: string | null; canPublish: boolean; error: string | null;
}
interface Registration {
  id: string; profileId: string; projectTitle:string; repository: string; profileHash: string;
  options: IntegrationReviewOptions; manifest: IntegrationReviewManifest; reviews: LocalReviewService;
  active:boolean;
}
export class IntegrationBaselines {
  private readonly entries = new Map<string, Registration>();
  private constructor(private readonly root: string, private readonly proofs: HumanReviewProofStore) {}
  static async open(root: string): Promise<IntegrationBaselines> {
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw Error("Baseline storage cannot be a link");
    return new IntegrationBaselines(await realpath(root), await HumanReviewProofStore.open(join(root, "approvals")));
  }
  async bind(profile: { id: string; title?:string; repository: string; hash: string;project?:string;config?:{vault:string};allowedPaths?:string[];active?:boolean }, options: IntegrationReviewOptions,
    manifest: IntegrationReviewManifest, reviews: LocalReviewService): Promise<string | null> {
    if (await common(profile.repository) !== await common(options.checkout)) return null;
    if(profile.project!==undefined){
      for(const source of options.sources){const state=await source.readState();
        if(state.contract.project!==profile.project||!profile.config||await realpath(source.config.vault)!==await realpath(profile.config.vault))return null;
      }
      if(!profile.allowedPaths||manifest.files.some(f=>!profile.allowedPaths!.some(p=>f.path===p||f.path.startsWith(p+"/"))))return null;
    }
    const id = `base-${hash(profile.id + "\n" + manifest.review.id + "\n" + manifest.review.verifiedArtifactSha256).slice(0, 24)}`;
    reviews.bindCurrentCheck(manifest.review.id,()=>verifyIntegrationReview(options,manifest));
    this.entries.set(id, { id, profileId: profile.id, projectTitle:profile.title??profile.id, repository: profile.repository, profileHash: profile.hash, options, manifest, reviews,active:profile.active!==false });
    return id;
  }
  private entry(profileId: string, id: string): Registration {
    const entry = this.entries.get(id);
    if (!entry || entry.profileId !== profileId) throw Error("Integration baseline is not registered for this project");
    return entry;
  }
  private async current(entry: Registration): Promise<void> {
    if (await common(entry.repository) !== await common(entry.options.checkout)) throw Error("Integration repository changed");
    const view = await entry.reviews.snapshot(entry.manifest.review.id);
    if (view.status !== "accepted" || view.integrityError || view.artifactSha256 !== entry.manifest.review.verifiedArtifactSha256)
      throw Error("統合成果の受入と固定版を確認してください。受入取消後は後続Taskを開始できません。");
  }
  async choices(profileId: string): Promise<IntegrationBaseChoice[]> {
    const rows: IntegrationBaseChoice[] = [];
    for (const entry of this.entries.values()) if (entry.profileId === profileId) {
      let error: string | null = null, baseSha: string | null = null;
      try {
        await this.current(entry);
        if (await read(join(this.root, `${entry.id}.json`))) baseSha = (await this.record(entry)).baseSha;
        else if (await read(join(this.root, `${entry.id}.intent.json`))) error = "基準の保存が途中で止まりました。保存操作の照合が必要です。";
      } catch { error = "統合成果の受入・版・保存状態を確認してください。"; }
      rows.push({ id: entry.id, profileId, projectTitle:entry.projectTitle, title: entry.options.title, reviewId: entry.manifest.review.id,
        artifactSha256: entry.manifest.review.verifiedArtifactSha256, baseSha, canPublish: entry.active && !error && !baseSha, error });
    }
    return rows;
  }
  async resolve(profileId: string, id: string): Promise<IntegrationBase> {
    const entry = this.entry(profileId, id); await this.current(entry);
    return this.record(entry);
  }
  async withAccepted<T>(profileId:string,id:string,operation:(base:IntegrationBase)=>Promise<T>):Promise<T> {
    const entry=this.entry(profileId,id);
    return entry.reviews.withCurrentAcceptance(entry.manifest.review.id,entry.manifest.review.verifiedArtifactSha256,
      async()=>operation(await this.resolve(profileId,id)));
  }
  async preview(profileId: string, id: string): Promise<IntegrationBaseChoice> {
    const entry = this.entry(profileId, id);
    let baseSha: string | null = null, error: string | null = null;
    try {
      if (await read(join(this.root, `${id}.json`))) baseSha = (await this.record(entry)).baseSha;
      else if (await read(join(this.root, `${id}.intent.json`))) error = "基準の保存が途中で止まりました。保存操作の照合が必要です。";
    } catch { error = "保存した基準の版を照合できません。"; }
    return { id, profileId, projectTitle:entry.projectTitle, title: entry.options.title, reviewId: entry.manifest.review.id,
      artifactSha256: entry.manifest.review.verifiedArtifactSha256, baseSha, canPublish: entry.active && !error && !baseSha, error };
  }
  private async record(entry: Registration): Promise<IntegrationBase> {
    const { id, profileId } = entry;
    const record = await read(join(this.root, `${id}.json`));
    if (!record || !isReviewRequestId(record.requestId)) throw Error("Integration baseline has not been saved");
    const receipt = await this.proofs.read(record.requestId);
    const result = await this.proofs.read(record.resultRequestId);
    if (!receipt || receipt.action !== "operation" || receipt.data.domain !== "integration-baseline" ||
        !result || result.action !== "operation" || result.data.domain !== "integration-baseline-result" ||
        result.data.record !== JSON.stringify(record) || result.artifactSha256 !== receipt.artifactSha256 ||
        receipt.data.profileHash !== entry.profileHash || receipt.data.manifestHash !== hash(JSON.stringify(entry.manifest)) ||
        receipt.data.id !== id || receipt.artifactSha256 !== entry.manifest.review.verifiedArtifactSha256 ||
        record.profileId !== profileId || record.reviewId !== entry.manifest.review.id ||
        record.artifactSha256 !== receipt.artifactSha256 || record.parentSha !== entry.options.baseSha ||
        record.integrationManifestSha256 !== receipt.data.manifestHash ||
        record.sourceRuns !== entry.manifest.sourcePins.map(pin=>pin.runId).join(",") ||
        !/^[a-f0-9]{40}$/.test(record.baseSha) || !/^[a-f0-9]{40}$/.test(record.treeSha) ||
        git(entry.repository, ["rev-parse", `refs/negi/baselines/${id}`]) !== record.baseSha ||
        git(entry.repository, ["rev-parse", `${record.baseSha}^{tree}`]) !== record.treeSha ||
        git(entry.repository, ["rev-list", "--parents", "-n", "1", record.baseSha]) !== `${record.baseSha} ${record.parentSha}`)
      throw Error("Integration baseline proof or Git checkpoint changed");
    return record as unknown as IntegrationBase;
  }
  private commit(entry: Registration, treeSha: string, at: string): string {
    return git(entry.repository, ["-c", "commit.gpgSign=false", "commit-tree", treeSha, "-p", entry.options.baseSha],
      { ...process.env, GIT_AUTHOR_NAME: "Negi Teams", GIT_AUTHOR_EMAIL: "checkpoint@negi.invalid",
        GIT_COMMITTER_NAME: "Negi Teams", GIT_COMMITTER_EMAIL: "checkpoint@negi.invalid", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      `Negi reviewed integration ${entry.options.id}\nReview: ${entry.manifest.review.id}\nArtifact: ${entry.manifest.review.verifiedArtifactSha256}\n`);
  }
  async publish(profileId: string, id: string, artifactSha256: string, requestId: string): Promise<IntegrationBase> {
    const entry=this.entry(profileId,id);
    if(!entry.active)throw Error("Project settings version is retired");
    return entry.reviews.withCurrentAcceptance(entry.manifest.review.id,artifactSha256,
      ()=>this.publishAccepted(profileId,id,artifactSha256,requestId));
  }
  private async publishAccepted(profileId: string, id: string, artifactSha256: string, requestId: string): Promise<IntegrationBase> {
    const entry = this.entry(profileId, id);
    if (!isReviewRequestId(requestId) || artifactSha256 !== entry.manifest.review.verifiedArtifactSha256) throw Error("Baseline approval target invalid");
    const lockPath = join(this.root, "writer.lock"), lock = await open(lockPath, "wx", 0o600);
    const index = join(this.root, `${id}.index`); let indexOwned = false;
    try {
      await this.current(entry);
      const input = { id: requestId, action: "operation" as const, caseId: entry.manifest.review.id, runId: entry.options.id,
        artifactSha256, verificationRef: entry.manifest.review.evidencePath,
        data: { domain: "integration-baseline", id, profileId, profileHash: entry.profileHash, manifestHash: hash(JSON.stringify(entry.manifest)) } };
      // A reused browser request may never authorize a different checkpoint.
      const previous = await this.proofs.read(requestId);
      if (previous) await this.proofs.create(input);
      if (await read(join(this.root, `${id}.json`))) return this.resolve(profileId, id);
      const intent = await read(join(this.root, `${id}.intent.json`));
      if (intent && intent.requestId !== requestId) throw Error("Baseline creation requires reconciliation of its original request");
      const receipt = await this.proofs.create(input);
      if (!intent) await save(join(this.root, `${id}.intent.json`), { requestId });
      try { await lstat(index); throw Error("Baseline index requires reconciliation"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const env = { ...process.env, GIT_INDEX_FILE: index };
      indexOwned = true; git(entry.repository, ["read-tree", entry.options.baseSha], env);
      for (const file of entry.manifest.files) {
        if (file.sha256 === null) { git(entry.repository, ["update-index", "--force-remove", "--", file.path], env); continue; }
        const bytes = await readFile(join(entry.options.checkout, file.path));
        if (hash(bytes) !== file.sha256) throw Error("Reviewed file changed while creating checkpoint");
        const blob = git(entry.repository, ["hash-object", "-w", "--stdin"], env, bytes);
        git(entry.repository, ["update-index", "--add", "--cacheinfo", `${file.mode === 0o755 ? "100755" : "100644"},${blob},${file.path}`], env);
      }
      const treeSha = git(entry.repository, ["write-tree"], env), baseSha = this.commit(entry, treeSha, receipt.at);
      await this.current(entry);
      const h = hash(requestId + "\nresult"), resultRequestId = `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
      const record = { id, profileId, reviewId: entry.manifest.review.id, artifactSha256,
        parentSha: entry.options.baseSha, baseSha, treeSha, requestId: receipt.id, resultRequestId,
        sourceRuns:entry.manifest.sourcePins.map(pin=>pin.runId).join(","),integrationManifestSha256:hash(JSON.stringify(entry.manifest)) };
      await this.proofs.create({ ...input, id: resultRequestId, data: { domain: "integration-baseline-result", record: JSON.stringify(record) } });
      const ref = `refs/negi/baselines/${id}`;
      let existing: string | null = null;
      try { existing = git(entry.repository, ["rev-parse", "--verify", ref]); } catch { /* a new checkpoint */ }
      if (existing && existing !== baseSha) throw Error("Baseline ref already points to another commit");
      if (!existing) git(entry.repository, ["update-ref", ref, baseSha, "0".repeat(40)]);
      await save(join(this.root, `${id}.json`), record);
      return this.resolve(profileId, id);
    } finally {
      if (indexOwned) await unlink(index).catch(() => undefined);
      await lock.close(); await unlink(lockPath);
    }
  }
}
