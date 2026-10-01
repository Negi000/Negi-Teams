// Authenticated selection -> separate worktree -> the existing scheduler and
// integration verifier. No model turn, branch update, push or human acceptance.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import { FileScheduler, schedulerWorkEligible } from "./scheduler.ts";
import { integrateVerifiedTasks, type IntegrationSource } from "./taskIntegration.ts";
import { LocalIntegrationReviewService } from "./integrationReviewService.ts";
import { verifyConfiguredCheckout } from "./checkoutVerification.ts";
import { changedGitPaths, pathsOutsideScope } from "./vaultTaskContract.ts";
import type { LocalTaskService } from "./taskService.ts";
import type { LocalReviewService } from "./reviewService.ts";
import type { LocalTaskAuthoringService, TaskExecutionProfile } from "./taskAuthoring.ts";
import type { VerificationCommand } from "./vaultRunConfig.ts";
import type { IntegrationReviewOptions } from "./integrationReview.ts";

const exec = promisify(execFile), hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const idPattern = /^integration-[a-f0-9-]{36}$/;
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["--no-replace-objects", ...args], { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 200_000 })).stdout.trim();
}
async function common(cwd: string) {
  const path = await realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function inside(root: string, target: string) {
  if (process.platform === "win32") { root = root.toLowerCase(); target = target.toLowerCase(); }
  const rel = relative(root, target); return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function json<T>(path: string): Promise<T> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 500_000) throw Error("Integration record invalid");
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
}
interface SourcePin { runId: string; configSha256: string; manifestSha256: string }
interface Selection {
  profileId: string; profileHash: string; baseSha: string; pins: SourcePin[];
  paths: string[]; commandsSha256: string; resources: string[];
}
interface Setup { schema: "negi-integration-execution/1"; id: string; requestId: string; selection: Selection; hash: string }
interface Result { evidenceRef: string; status: "ready_for_review" | "failed"; resultRequestId: string }
export interface IntegrationPreview {
  hash: string; profileId: string; projectTitle: string; baseSha: string; paths: string[]; verification: string[];
  sources: Array<{ id: string; title: string; taskId: string; version: number; revision: number; artifactSha256: string; acceptance: string[] }>;
}
export interface IntegrationExecutionView {
  id: string; hash: string; projectTitle: string; sourceRunIds: string[]; baseSha: string;
  status: "preparing" | "queued" | "integrating" | "verifying" | "ready_for_review" | "failed" | "cancelled" | "needs_reconciliation";
  live: boolean; canStop: boolean; canResume: boolean; reviewId: string | null; error: string | null;
}
export class LocalIntegrationExecutionService {
  private readonly pending = new Set<string>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private closing = false;
  private constructor(private readonly root: string, private readonly profiles: TaskExecutionProfile[],
    private readonly tasks: LocalTaskService, private readonly reviews: LocalReviewService,
    private readonly authoring: LocalTaskAuthoringService, private readonly proofs: HumanReviewProofStore) {}
  static async open(authoring: LocalTaskAuthoringService, tasks: LocalTaskService, reviews: LocalReviewService) {
    const configuration = authoring.integrationConfiguration();
    await mkdir(configuration.storageRoot, { recursive: true });
    if ((await lstat(configuration.storageRoot)).isSymbolicLink()) throw Error("Integration storage cannot be a link");
    const root = await realpath(configuration.storageRoot);
    for (const writable of [...reviews.modelWritableRoots(), ...tasks.knowledgeRegistrations().flatMap(s => [s.checkout, s.vault])]) {
      const path = await realpath(writable);
      if (inside(root, path) || inside(path, root)) throw Error("Integration storage overlaps a model writable root");
    }
    await mkdir(join(root, "no-hooks"), { recursive: true });
    const service = new LocalIntegrationExecutionService(root, configuration.profiles, tasks, reviews, authoring,
      await HumanReviewProofStore.open(join(root, "approvals")));
    // Only immutable completed results are registered on restart. No queued or
    // uncertain write/verification command is replayed without another human action.
    for (const id of await service.ids()) try {
      const setup = await service.setup(id), result = await service.result(setup);
      if (result?.status === "ready_for_review") await service.register(setup, result);
    } catch { /* the operation remains visible for reconciliation */ }
    return service;
  }
  private profile(id: string) { const p = this.profiles.find(p => p.id === id); if (!p) throw Error("Integration project missing"); return p; }
  private dir(id: string) { if (!idPattern.test(id)) throw Error("Integration identity invalid"); return join(this.root, id); }
  private async ids() { return (await readdir(this.root)).filter(id => idPattern.test(id)).sort(); }
  private async setup(id: string) {
    const directory=await lstat(this.dir(id));if(!directory.isDirectory()||directory.isSymbolicLink())throw Error("Integration operation directory invalid");
    const setup = await json<Setup>(join(this.dir(id), "setup.json")), receipt = await this.proofs.read(setup.requestId);
    if (setup.schema !== "negi-integration-execution/1" || setup.id !== id || id !== "integration-" + setup.requestId ||
      setup.hash !== hash(setup.selection) || !receipt || receipt.action !== "operation" ||
      receipt.data.domain !== "integration-execution" || receipt.data.setupSha256 !== hash(setup) ||
      receipt.artifactSha256 !== setup.hash || receipt.runId !== id ||
      this.profile(setup.selection.profileId).hash !== setup.selection.profileHash) throw Error("Integration authorization changed");
    return setup;
  }
  private scheduler(setup: Setup) { return new FileScheduler(this.profile(setup.selection.profileId).config.schedulerPath); }
  private checkout(setup: Setup) { return join(this.profile(setup.selection.profileId).worktreeRoot, setup.id); }
  private async selected(profileId: string, ids: string[]) {
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(id))) throw Error("Select two to eight distinct Tasks");
    const p = this.profile(profileId), sources: IntegrationSource[] = [], pins: SourcePin[] = [], paths: string[] = [];
    const rows: IntegrationPreview["sources"] = [], commands: VerificationCommand[] = [...p.config.verification];
    let baseSha: string | null = null;
    const scheduler = (await new FileScheduler(p.config.schedulerPath).read()).state;
    if (!scheduler) throw Error("Integration scheduler unavailable");
    for (const id of [...ids].sort()) {
      const source = await this.tasks.integrationSource(id), state = await source.readState(), manifest = await source.readManifest!();
      const project = await this.tasks.knowledgeSource(id), entry = scheduler.entries.find(e => e.work.id === id);
      if (project.project !== p.project || await common(source.config.checkout) !== await common(p.repository) ||
        await realpath(source.config.schedulerPath) !== await realpath(p.config.schedulerPath) ||
        !["ready_for_review", "accepted"].includes(state.status) || state.verification?.outcome !== "passed" ||
        entry?.status !== "verified" || entry.evidenceRef !== state.verification.evidenceRef ||
        (baseSha && baseSha !== manifest.baseSha)) throw Error("Tasks must be current verified results in the same repository and base");
      baseSha = manifest.baseSha;
      if(/^(?:old mode|new mode|rename from|rename to|similarity index|new file mode 100755) /m.test(await git(source.config.checkout,["diff","--no-ext-diff","--no-textconv","--no-renames","HEAD"])))throw Error("File metadata changes need a separate integration plan");
      if (pathsOutsideScope(manifest.files.map(f => f.path), p.allowedPaths).length) throw Error("Integration exceeds configured project scope");
      for (const file of manifest.files) {
        if (file.sha256 !== null && process.platform !== "win32" &&
          !(await git(p.repository, ["ls-tree", manifest.baseSha, "--", file.path])) &&
          ((await lstat(join(source.config.checkout, file.path))).mode & 0o111)) throw Error("New executable files need a separate integration plan");
        const key = file.path.toLowerCase();
        if (paths.some(path => { const prior = path.toLowerCase(); return prior === key || prior.startsWith(key + "/") || key.startsWith(prior + "/"); }))
          throw Error("変更範囲が重なっています。統括に競合の解決を依頼してください。");
        paths.push(file.path);
      }
      pins.push({ runId: id, configSha256: source.configSha256, manifestSha256: hash(manifest) }); sources.push(source);
      rows.push({ id, title: this.tasks.list().find(t => t.id === id)!.title, taskId: state.contract.vaultId,
        version: state.contract.version, revision: manifest.revision ?? 0, artifactSha256: manifest.review.verifiedArtifactSha256,
        acceptance: [...(state.contract.acceptance ?? [])] });
      commands.push(...source.config.verification);
    }
    const uniqueCommands = [...new Map(commands.map(c => [JSON.stringify(c), c])).values()];
    const resources = [...new Set([p.config, ...sources.map(s => s.config)].flatMap(c => c.resources))].sort();
    const selection: Selection = { profileId, profileHash: p.hash, baseSha: baseSha!, pins, paths: paths.sort(), commandsSha256: hash(uniqueCommands), resources };
    const preview: IntegrationPreview = { hash: hash(selection), profileId, projectTitle: p.title, baseSha: selection.baseSha,
      paths: selection.paths, verification: uniqueCommands.map(c => c.requirement), sources: rows };
    return { selection, preview, sources, commands: uniqueCommands };
  }
  async preview(profileId: string, ids: string[]) { return (await this.selected(profileId, ids)).preview; }
  async overview(profileId?: string) {
    const p = this.profile(profileId ?? this.profiles[0].id), sources = [];
    for (const item of this.tasks.list()) {
      if ((await this.tasks.knowledgeSource(item.id)).project !== p.project) continue;
      const view = await this.tasks.snapshot(item.id);
      let eligible = false;
      try { const source = await this.tasks.integrationSource(item.id); eligible = ["ready_for_review", "accepted"].includes(view.status) && await common(source.config.checkout) === await common(p.repository); } catch { /* not ready */ }
      sources.push({ id: item.id, title: item.title, status: view.status, eligible, baseSha: view.baseSha,
        reviewId: view.reviewId, error: eligible ? null : "固定成果と検証を確認してから統合できます。" });
    }
    const runs = []; for (const id of await this.ids()) runs.push(await this.snapshot(id));
    return { profiles: this.profiles.map(p => ({ id: p.id, title: p.title })), profileId: p.id, sources, runs };
  }
  private async worktree(setup: Setup, clean = false) {
    const checkout = this.checkout(setup), p = this.profile(setup.selection.profileId);
    if ((await lstat(checkout)).isSymbolicLink() || await realpath(checkout) !== checkout ||
      await common(checkout) !== await common(p.repository) || await git(checkout, ["rev-parse", "HEAD"]) !== setup.selection.baseSha ||
      (clean && changedGitPaths(checkout).length)) throw Error("Integration worktree changed or is incomplete");
    const created = await json<{ setupHash: string }>(join(this.dir(setup.id), "worktree-created.json"));
    if (created.setupHash !== hash(setup)) throw Error("Integration worktree creation is not confirmed");
  }
  async start(profileId: string, ids: string[], expectedHash: string, requestId: string) {
    if (this.closing || !isReviewRequestId(requestId) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw Error("Integration approval invalid");
    requestId = requestId.toLowerCase(); const id = "integration-" + requestId;
    const lockPath = join(this.root, "writer.lock"), lock = await open(lockPath, "wx", 0o600);
    try {
      if (await exists(this.dir(id))) {
        const prior = await this.setup(id);
        if (prior.hash !== expectedHash || prior.selection.profileId !== profileId ||
          !isDeepStrictEqual(prior.selection.pins.map(p => p.runId), [...ids].sort())) throw Error("Request reused for another integration");
        return this.snapshot(id);
      }
      if (await this.proofs.read(requestId)) throw Error("Integration intent requires reconciliation");
      const { selection } = await this.selected(profileId, ids);
      if (hash(selection) !== expectedHash) throw Error("Selected Task versions changed; preview them again");
      const priorIds = await this.ids(); if (priorIds.length >= 100) throw Error("Integration catalog limit reached");
      for (const priorId of priorIds) { const prior = await this.setup(priorId); if (prior.hash === expectedHash) {
        const view=await this.snapshot(priorId);
        if(view.status!=="cancelled"||await exists(join(this.dir(priorId),"phase-capturing.json"))||view.error)return view;
      } }
      const setup: Setup = { schema: "negi-integration-execution/1", id, requestId, selection, hash: expectedHash };
      await this.proofs.create({ id: requestId, action: "operation", caseId: id, runId: id, artifactSha256: expectedHash,
        verificationRef: "local:fixed-task-integration", data: { domain: "integration-execution", setupSha256: hash(setup) } });
      await mkdir(this.dir(id)); await save(join(this.dir(id), "setup.json"), setup);
      const p = this.profile(profileId), checkout = this.checkout(setup);
      if (await exists(checkout)) throw Error("Integration target already exists; preserve and reconcile it");
      await git(p.repository, ["-c", `core.hooksPath=${join(this.root, "no-hooks")}`, "worktree", "add", "--detach", checkout, selection.baseSha]);
      await save(join(this.dir(id), "worktree-created.json"), { setupHash: hash(setup) }); await this.worktree(setup, true);
      await this.scheduler(setup).append({ key: `${id}:integration-submit`, at: new Date().toISOString(), action: { type: "submit",
        work: { id, parentId: null, dependencies: selection.pins.map(p => p.runId), role: "sol", checkout, checkoutMode: "write",
          resources: selection.resources.map(name => ({ name, mode: "write" as const })), reserveUsd: 0 } } });
      this.pending.add(id); void this.pump().catch(() => undefined); return this.snapshot(id);
    } finally { await lock.close(); await unlink(lockPath); }
  }
  private async options(setup: Setup): Promise<IntegrationReviewOptions> {
    const sources = await Promise.all(setup.selection.pins.map(p => this.tasks.integrationSource(p.runId, false)));
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i], read = source.readManifest!, pin = setup.selection.pins[i];
      if (source.configSha256 !== pin.configSha256) throw Error("Integration source configuration changed");
      source.readManifest = async () => { const manifest = await read(); if (hash(manifest) !== pin.manifestSha256) throw Error("Integration source version changed"); return manifest; };
      const readState = source.readState;
      source.readState = async () => { const state = await readState(); await source.readManifest!(); return state; };
    }
    return { id: setup.id, title: this.profile(setup.selection.profileId).title + "の統合成果", checkout: this.checkout(setup),
      outputDir: join(this.dir(setup.id), "output"), baseSha: setup.selection.baseSha, scheduler: this.scheduler(setup), sources,
      limits: "固定版の変更と設定済み検証を照合しました。内容と受入条件は利用者が確認してください。worktreeはOS sandboxではありません。",
      evidenceSha256: "" };
  }
  private async result(setup: Setup) {
    const path = join(this.dir(setup.id), "result.json"); if (!await exists(path)) return null;
    const result = await json<Result>(path), receipt = await this.proofs.read(result.resultRequestId);
    const evidence = join(this.dir(setup.id), "output", "integration-verification.json"), bytes = await readFile(evidence);
    const evidenceRef = `${evidence}#sha256=${createHash("sha256").update(bytes).digest("hex")}`;
    if (!receipt || receipt.action !== "operation" || receipt.data.domain !== "integration-execution-result" ||
      receipt.data.resultSha256 !== hash(result) || receipt.data.setupSha256 !== hash(setup) ||
      result.evidenceRef !== evidenceRef || receipt.artifactSha256 !== setup.hash || receipt.runId !== setup.id ||
      (await this.scheduler(setup).read()).state?.entries.find(e => e.work.id === setup.id)?.evidenceRef !== evidenceRef) throw Error("Integration result evidence changed");
    return result;
  }
  private async register(setup: Setup, result: Result) {
    const options = await this.options(setup); options.evidenceSha256 = result.evidenceRef.split("#sha256=")[1];
    await this.worktree(setup);
    await LocalIntegrationReviewService.register([options], this.reviews, this.authoring);
  }
  private async execute(setup: Setup, controller: AbortController) {
    const lockPath = join(this.dir(setup.id), "dispatch.lock"); let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") { this.pending.delete(setup.id); return; } throw e; }
    try {
      await this.worktree(setup, true);
      const current = await this.selected(setup.selection.profileId, setup.selection.pins.map(p => p.runId));
      if (!isDeepStrictEqual(current.selection, setup.selection)) throw Error("Integration selection changed before dispatch");
      const options = await this.options(setup), signal = AbortSignal.any([controller.signal,
        AbortSignal.timeout(this.profile(setup.selection.profileId).timeLimitMinutes * 60_000)]);
      const result = await integrateVerifiedTasks({ ...options, signal,
        publish: settle => this.withDecision(setup, settle),
        checkBeforePublish: async () => { if (await this.stopRequested(setup)) controller.abort(); signal.throwIfAborted(); },
        onPhase: async phase => { if (await this.stopRequested(setup)) controller.abort(); signal.throwIfAborted();
          await save(join(this.dir(setup.id), `phase-${phase}.json`), { at: new Date().toISOString() }); },
        verify: () => verifyConfiguredCheckout({ runId: setup.id, checkout: options.checkout, outputDir: options.outputDir,
          baseSha: setup.selection.baseSha, allowedPaths: setup.selection.paths, requiredVerification: current.commands.map(c => c.requirement),
          commands: current.commands }, signal, "command-verification.json") });
      const digest = hash({ requestId: setup.requestId, result: true }), resultRequestId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const record: Result = { evidenceRef: result.evidenceRef, status: result.status, resultRequestId };
      await this.proofs.create({ id: resultRequestId, action: "operation", caseId: setup.id, runId: setup.id, artifactSha256: setup.hash,
        verificationRef: result.evidenceRef, data: { domain: "integration-execution-result", setupSha256: hash(setup), resultSha256: hash(record) } });
      // Persist the signed result before exposing it in the review registry so
      // restart can finish registration. The link remains hidden while active.
      await save(join(this.dir(setup.id), "result.json"), record);
      if (record.status === "ready_for_review") await this.register(setup, record);
      this.pending.delete(setup.id);
    } catch (cause) {
      const state = (await this.scheduler(setup).read()).state, entry = state?.entries.find(e => e.work.id === setup.id);
      if (entry?.status === "queued" && !controller.signal.aborted && !this.closing && !schedulerWorkEligible(state!, entry)) return;
      this.pending.delete(setup.id);
      if (entry?.status === "cancelled" && await this.stopRequested(setup) &&
          !await exists(join(this.dir(setup.id), "phase-capturing.json"))) return;
      if (entry?.status === "queued") await this.scheduler(setup).append({ key: `${setup.id}:preflight-held`, at: new Date().toISOString(),
        action: { type: "cancel_queued", workId: setup.id, reason: "Integration source or preflight no longer matches the approved selection" } });
      if (!await exists(join(this.dir(setup.id), "error.json"))) await save(join(this.dir(setup.id), "error.json"),
        { error: "統合を確定できませんでした。差分を保ったまま、元Task・作業場所・実行記録を照合してください。",
          reason: cause instanceof Error ? cause.message.slice(0, 1000) : "Unknown execution failure" });
    } finally { await lock.close(); await unlink(lockPath); }
  }
  private async pump() {
    if (this.closing || this.pumping) return; this.pumping = true;
    try { for (const id of this.pending) {
      if (this.active.has(id)) { const setup = await this.setup(id); if (await this.stopRequested(setup)) this.active.get(id)!.controller.abort(); continue; }
      const setup = await this.setup(id), state = (await this.scheduler(setup).read()).state, entry = state?.entries.find(e => e.work.id === id);
      if (!entry || entry.status !== "queued") { this.pending.delete(id); continue; }
      if (!schedulerWorkEligible(state!, entry)) continue;
      const controller = new AbortController(), promise = Promise.resolve().then(() => this.execute(setup, controller));
      this.active.set(id, { controller, promise });
      void promise.catch(() => { this.pending.delete(id); }).finally(() => { this.active.delete(id); void this.pump().catch(() => undefined); });
    } } finally {
      this.pumping = false;
      if (this.pending.size && !this.closing && !this.timer) { this.timer = setTimeout(() => { this.timer = null; void this.pump().catch(() => undefined); }, 500); this.timer.unref(); }
    }
  }
  async snapshot(id: string): Promise<IntegrationExecutionView> {
    const setup = await this.setup(id), live = this.pending.has(id) || this.active.has(id);
    const entry = (await this.scheduler(setup).read()).state?.entries.find(e => e.work.id === id);
    let error: string | null = null, reviewId: string | null = null;
    let status: IntegrationExecutionView["status"] = !entry ? live ? "preparing" : "needs_reconciliation" :
      entry.status === "queued" ? "queued" : entry.status === "verified" ? "ready_for_review" :
      entry.status === "failed" ? "failed" : entry.status === "cancelled" ? "cancelled" :
      entry.status === "running" && live ? await exists(join(this.dir(id), "phase-verifying.json")) ? "verifying" : "integrating" : "needs_reconciliation";
    try {
      if (await exists(join(this.dir(id), "error.json"))) error = (await json<{ error: string }>(join(this.dir(id), "error.json"))).error;
      if (entry?.status === "verified" && this.active.has(id)) status = "verifying";
      else if (entry?.status === "verified") {
        const result = await this.result(setup); if (!result || result.status !== "ready_for_review") throw Error("Integration publication not confirmed");
        const candidate = `integration-${createHash("sha256").update(id).digest("hex").slice(0,24)}`;
        const review = await this.reviews.snapshot(candidate); reviewId = candidate; if (review.integrityError) error = review.integrityError;
      }
    } catch { reviewId = null;
      if (entry?.status === "verified" && this.active.has(id) && !error) status = "verifying";
      else { status = "needs_reconciliation"; error = "統合結果の版・検証・レビュー登録を照合してください。"; }
    }
    let canResume = false;
    if (entry?.status === "queued" && !live && !this.closing && !await exists(join(this.dir(id), "dispatch.lock"))) try {
      await this.worktree(setup, true); canResume = isDeepStrictEqual((await this.selected(setup.selection.profileId, setup.selection.pins.map(p => p.runId))).selection, setup.selection);
    } catch { error = "待機中に元Taskまたは作業場所が変わりました。開始を保留しています。"; }
    return { id, hash: setup.hash, projectTitle: this.profile(setup.selection.profileId).title, sourceRunIds: setup.selection.pins.map(p => p.runId),
      baseSha: setup.selection.baseSha, status, live, canStop: !this.closing && (entry?.status === "queued" || entry?.status === "running"), canResume, reviewId, error };
  }
  async stop(id: string, expectedHash: string, requestId: string) {
    const setup = await this.setup(id); if (setup.hash !== expectedHash || !isReviewRequestId(requestId)) throw Error("Stop target changed");
    await this.withDecision(setup, async () => {
    const prior = (await this.scheduler(setup).read()).state?.entries.find(e => e.work.id === id);
    if (prior?.status === "cancelled" && await this.stopRequested(setup)) return;
    if (!prior || !["queued", "running"].includes(prior.status)) throw Error("Integration has already settled; refresh its result");
    await this.proofs.create({ id: requestId, action: "operation", caseId: id, runId: id, artifactSha256: expectedHash,
      verificationRef: null, data: { domain: "integration-stop", setupSha256: hash(setup) } });
    const marker=join(this.dir(id),"stop-request.json");if(!await exists(marker))await save(marker,{requestId});
    this.pending.delete(id); this.active.get(id)?.controller.abort();
    const entry = (await this.scheduler(setup).read()).state?.entries.find(e => e.work.id === id);
    if (entry?.status === "queued") try { await this.scheduler(setup).append({ key: `${id}:user-stop`, at: new Date().toISOString(),
      action: { type: "cancel_queued", workId: id, reason: "Authenticated user stopped integration before claim" } }); }
    catch { if ((await this.scheduler(setup).read()).state?.entries.find(e=>e.work.id===id)?.status==="queued") throw Error("Stop is not confirmed"); }
    });
    return this.snapshot(id);
  }
  private async withDecision<T>(setup: Setup, fn: () => Promise<T>): Promise<T> {
    const path = join(this.dir(setup.id), "decision.lock"), deadline = Date.now() + 2000;
    let lock: Awaited<ReturnType<typeof open>>;
    for (;;) try { lock = await open(path, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try { return await fn(); } finally { await lock.close(); await unlink(path); }
  }
  async resume(id: string, expectedHash: string, requestId: string) {
    const setup = await this.setup(id); if (setup.hash !== expectedHash || !isReviewRequestId(requestId) || !(await this.snapshot(id)).canResume) throw Error("Integration cannot resume");
    await this.proofs.create({ id: requestId, action: "operation", caseId: id, runId: id, artifactSha256: expectedHash,
      verificationRef: null, data: { domain: "integration-resume", setupSha256: hash(setup) } });
    this.pending.add(id); void this.pump().catch(() => undefined); return this.snapshot(id);
  }
  private async stopRequested(setup:Setup) {
    const marker=join(this.dir(setup.id),"stop-request.json");if(!await exists(marker))return false;
    const request=await json<{requestId:string}>(marker),receipt=await this.proofs.read(request.requestId);
    if(!receipt||receipt.data.domain!=="integration-stop"||receipt.runId!==setup.id||receipt.artifactSha256!==setup.hash||receipt.data.setupSha256!==hash(setup))throw Error("Integration stop proof changed");
    return true;
  }
  async close() { this.closing = true; if (this.timer) clearTimeout(this.timer); this.pending.clear();
    for (const active of this.active.values()) active.controller.abort(); await Promise.allSettled([...this.active.values()].map(a => a.promise)); }
}
