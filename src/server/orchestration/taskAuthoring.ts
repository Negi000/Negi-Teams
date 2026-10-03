import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
// Resident Astra drafts semantic work. Only an authenticated concrete approval
// compiles a Vault contract and a server-owned isolated run; recovery never sends a model turn.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";
import { setTimeout as wait } from "node:timers/promises";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import type { LocalTaskService, TaskRequestOrigin } from "./taskService.ts";
import type { VaultRunConfig } from "./vaultRunConfig.ts";
import { loadVaultTaskContract, type VaultTaskContract } from "./vaultTaskContract.ts";
import { taskDecomposition, type TaskDecompositionFields, type TaskDecompositionNode } from "./taskDecomposition.ts";
import { IntegrationBaselines, type IntegrationBase } from "./integrationBaseline.ts";
import type { IntegrationReviewOptions, IntegrationReviewManifest } from "./integrationReview.ts";
import type { LocalReviewService } from "./reviewService.ts";
import type { ConfigurationAdmission } from "./projectConfiguration.ts";

const exec = promisify(execFile), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const label = /^[a-zA-Z0-9._-]{1,100}$/, digest = /^[0-9a-f]{64}$/;
const inside = (root: string, path: string) => {
  const rel = relative(root.toLowerCase(), path.toLowerCase()); return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
};
type Source = VaultTaskContract["sourceNotes"][number];
interface References { sources: Source[]; context: string }
export interface TaskPlanFields {
  title: string; objective: string; inScope: string[]; outOfScope: string[]; allowedPaths: string[];
  invariants: string[]; acceptance: string[]; escalation: string[]; implementationPlan: string[];
  references: Array<{ id: string; version: number; sha256: string }>;
  maxAttempts: number; timeLimitMinutes: number;
}
export interface TaskExecutionProfile { id: string; title: string; project: string; repository: string; worktreeRoot: string;
  allowedPaths: string[]; maxAttempts: number; timeLimitMinutes: number; config: VaultRunConfig; hash: string; active?:boolean }
type Profile = TaskExecutionProfile;
interface Draft { schema: "negi-task-plan/1"; id: string; createdAt: string; profileId: string;
  profileHash: string; baseSha: string; sources: Source[]; fields: TaskPlanFields;
  origin: Exclude<TaskRequestOrigin, { kind: "browser" }> & { model: string; effort: string }; hash: string;
  decomposition?: TaskDecompositionNode; integrationBase?: IntegrationBase }
interface DecompositionDraft { schema: "negi-task-decomposition/1"; id: string; createdAt: string; profileId: string;
  profileHash: string; baseSha: string; sources: Source[]; fields: TaskDecompositionFields; origin: Draft["origin"]; hash: string; integrationBase?: IntegrationBase }
function planIdentity(origin:Draft["origin"], suffix=""):string {
  const bytes=createHash("sha256").update("negi-task-plan/1\n"+JSON.stringify(origin)+suffix).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=bytes.toString("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export interface TaskPlanView { id: string; createdAt: string; title: string; project: string; profileId: string;
  hash: string; baseSha: string; fields: TaskPlanFields; sources: Source[]; verification: string[];
  planner: VaultRunConfig["astra"]; worker: VaultRunConfig["sol"]; origin: Draft["origin"];
  status: "draft" | "registered" | "attention" | "waiting_dependencies"; canFinalize: boolean; runId: string | null; error: string | null;
  decomposition?: TaskDecompositionNode; integrationBase?: IntegrationBase }

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0") || value.includes("```")) throw new Error("Task plan text invalid");
  return value.trim();
}
function strings(value: unknown, maximum = 300): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("Task plan list invalid");
  const result = value.map(v => text(v, maximum));
  if (new Set(result).size !== result.length) throw new Error("Task plan list repeated"); return result;
}
function paths(value: unknown): string[] {
  const result = strings(value, 300);
  if (result.some(v => /[\\:*?\[\]{}\r\n]/.test(v) || v.split("/").some(p => !p || p === "." || p === "..")))
    throw new Error("Task plan relative paths invalid"); return result;
}
function fields(raw: unknown, profile: Profile): TaskPlanFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Task plan fields invalid");
  const v = raw as Record<string, unknown>, keys = ["title", "objective", "inScope", "outOfScope", "allowedPaths", "invariants", "acceptance", "escalation", "implementationPlan", "references", "maxAttempts", "timeLimitMinutes"];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) throw new Error("Task plan fields differ");
  const allowedPaths = paths(v.allowedPaths);
  if (allowedPaths.some(p => !profile.allowedPaths.some(root => p === root || p.startsWith(root + "/"))))
    throw new Error("Task plan exceeds configured project scope");
  if (!Number.isSafeInteger(v.maxAttempts) || Number(v.maxAttempts) < 1 || Number(v.maxAttempts) > profile.maxAttempts ||
      !Number.isSafeInteger(v.timeLimitMinutes) || Number(v.timeLimitMinutes) < 1 || Number(v.timeLimitMinutes) > profile.timeLimitMinutes)
    throw new Error("Task plan exceeds configured limits");
  if (!Array.isArray(v.references) || !v.references.length || v.references.length > 50) throw new Error("Task plan references required");
  const references = v.references.map(raw => {
    const r = raw as Record<string, unknown>;
    if (!r || Object.keys(r).length !== 3 || typeof r.id !== "string" || !label.test(r.id) ||
        !Number.isSafeInteger(r.version) || Number(r.version) < 1 || typeof r.sha256 !== "string" || !digest.test(r.sha256)) throw new Error("Task plan reference invalid");
    return { id: r.id, version: Number(r.version), sha256: r.sha256 };
  });
  if (new Set(references.map(r => r.id.toLowerCase())).size !== references.length) throw new Error("Task plan references repeated");
  const result = { title: text(v.title, 160), objective: text(v.objective, 2000), inScope: strings(v.inScope), outOfScope: strings(v.outOfScope),
    allowedPaths, invariants: strings(v.invariants), acceptance: strings(v.acceptance), escalation: strings(v.escalation),
    implementationPlan: strings(v.implementationPlan, 500), references, maxAttempts: Number(v.maxAttempts), timeLimitMinutes: Number(v.timeLimitMinutes) };
  if (Buffer.byteLength(JSON.stringify(result)) > 8000 || result.implementationPlan.join("\n").length > 4000)
    throw new Error("Task plan too large; decompose the work");
  return result;
}
async function directory(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("Task authoring roots must be configured absolute paths");
  const path = resolve(raw);
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Task authoring root cannot be a link"); return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const target = join(await realpath(dirname(path)), basename(path)); await mkdir(target); return await realpath(target); }
}
async function json(path: string): Promise<unknown> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 100_000) throw new Error("Task authoring file invalid");
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value) + "\n";
  try { const file = await open(path, "wx", 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!isDeepStrictEqual(await json(path), value)) throw new Error("Task authoring write conflicts with previous evidence"); }
}
function markdown(draft: Draft, profile: Profile, requestId: string): string {
  const f = draft.fields, body = { objective: f.objective, in_scope: f.inScope, out_of_scope: f.outOfScope,
    allowed_paths: f.allowedPaths, invariants: f.invariants, acceptance: f.acceptance,
    verification: profile.config.verification.map(v => v.requirement), escalation: f.escalation,
    base_sha: draft.baseSha, max_attempts: f.maxAttempts, time_limit_minutes: f.timeLimitMinutes };
  const scalar = (k: string, v: string) => k + ": " + JSON.stringify(v) + "\n";
  const taskId = `NT-TASK-${draft.id}`;
  return "---\n" + Object.entries({ id: taskId, kind: "Task", project: profile.project, scope: "project", status: "active",
    version: "1", updated: draft.createdAt.slice(0, 10), sensitivity: "local", approval_ref: `user:http-task-plan:${requestId}` })
    .map(([k,v]) => scalar(k,v)).join("") + "source_refs:\n" + [`master:${draft.origin.masterId}:${draft.origin.threadId}:${draft.origin.turnId}:${draft.origin.callId}`]
    .map(v => "  - " + JSON.stringify(v) + "\n").join("") + "depends_on:\n" + draft.sources.map(s => "  - " + JSON.stringify(s.id) + "\n").join("") +
    "---\n# " + f.title.replace(/[\r\n]/g, " ") + "\n\n```negi-task-contract\n" + JSON.stringify(body, null, 2) + "\n```\n\n## 実行計画\n" +
    f.implementationPlan.map(v => "- " + v).join("\n") + "\n\n## 依存Task\n" +
    (draft.integrationBase?`先行成果の統合を受入済み。保存した基準 ${draft.integrationBase.baseSha} から続ける。\n先行Task: ${draft.integrationBase.sourceRuns}\nレビュー: ${draft.integrationBase.reviewId}\n`:
      "なし。この契約は独立して実行する。\n") +
    (draft.decomposition ? "\n## 元の依頼と分解\n" + JSON.stringify(draft.decomposition, null, 2) + "\n" : "") +
    (draft.integrationBase ? "\n## 先行成果からの基準\n" + JSON.stringify(draft.integrationBase, null, 2) + "\n" : "");
}
function snapshot(draft: Draft, profile: Profile, content: string): VaultTaskContract {
  const f = draft.fields, taskId = `NT-TASK-${draft.id}`, hash = sha(content);
  return { schemaVersion: "negi-task-contract/1", vaultId: taskId, version: 1, sha256: hash, project: profile.project,
    objective: f.objective, acceptance: f.acceptance, baseSha: draft.baseSha,
    scope: { in: f.inScope, out: f.outOfScope, allowedPaths: f.allowedPaths }, invariants: f.invariants,
    verification: profile.config.verification.map(v => v.requirement), escalation: f.escalation,
    limits: { maxAttempts: f.maxAttempts, timeLimitMinutes: f.timeLimitMinutes },
    sourceNotes: [...draft.sources, { id: taskId, kind: "Task", version: 1, sha256: hash, path: `80_Tasks/${taskId}.md` }]
      .sort((a,b) => a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1) };
}

export class LocalTaskAuthoringService {
  private queue: Promise<unknown> = Promise.resolve();
  private admission:ConfigurationAdmission=operation=>operation();
  bindConfigurationAdmission(admission:ConfigurationAdmission){this.admission=admission;}
  assertActiveProfile(id:string){if(this.profile(id).active===false)throw Error("Project settings version is retired");}
  private constructor(private readonly root: string, private readonly profiles: Profile[],
    private readonly proofs: HumanReviewProofStore, private readonly tasks: LocalTaskService,
    private readonly baselines: IntegrationBaselines) {}
  static async open(raw: unknown, tasks: LocalTaskService): Promise<LocalTaskAuthoringService> {
    const value = raw as { storageRoot?: unknown; profiles?: unknown;strictProfileHistory?:boolean };
    if (!value || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 1280) throw new Error("Task authoring profiles invalid");
    if(value.profiles.filter(p=>p.active!==false).length>20||!value.profiles.some(p=>p.active!==false))throw Error("Active project limit invalid");
    const root = await directory(value.storageRoot), profiles: Profile[] = [];
    for (const raw of value.profiles) {
      const p = raw as Record<string, unknown>;
      if (!p || typeof p.id !== "string" || !label.test(p.id)) throw new Error("Task authoring profile identity invalid");
      const template = typeof p.templateRunId === "string" && p.config === undefined && p.project === undefined ? tasks.authoringTemplate(p.templateRunId) :
        p.templateRunId === undefined && typeof p.project === "string" && label.test(p.project) && p.config !== undefined ?
          { config:await tasks.validateAuthoringConfiguration(p.config),contract:{project:p.project} } : null;
      if (!template) throw new Error("Task authoring profile must select one trusted configuration source");
      const config = template.config;
      if (config.approvedPlan) throw new Error("Task authoring template must be a fixed trusted registration");
      config.vault = await realpath(config.vault); config.executable = await realpath(config.executable);
      const repository = await directory(p.repository), worktreeRoot = await directory(p.worktreeRoot);
      const project = String(template.contract.project), allowedPaths = paths(p.allowedPaths);
      if (!config.verification.length || !Number.isSafeInteger(p.maxAttempts) || Number(p.maxAttempts) < 1 || Number(p.maxAttempts) > 3 ||
          !Number.isSafeInteger(p.timeLimitMinutes) || Number(p.timeLimitMinutes) < 1 || Number(p.timeLimitMinutes) > 480) throw new Error("Task authoring limits/checks invalid");
      for (const writable of [...tasks.knowledgeRegistrations().flatMap(r => [r.vault,r.checkout]), repository])
        for (const evidence of [root, worktreeRoot]) if (inside(writable,evidence) || inside(evidence,writable)) throw new Error("Task authoring roots overlap writable source roots");
      if (inside(root,worktreeRoot) || inside(worktreeRoot,root)) throw new Error("Task plan storage and worktrees must be separate");
      const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: repository, env:withoutControlPlaneEnv(),windowsHide:true })).stdout.trim();
      if ((await realpath(top)).toLowerCase() !== repository.toLowerCase()) throw new Error("Project repository must be a Git root");
      const core = { id: p.id, title: text(p.title, 160), project, repository, worktreeRoot, allowedPaths,
        maxAttempts: Number(p.maxAttempts), timeLimitMinutes: Number(p.timeLimitMinutes), config };
      if(p.active!==undefined&&typeof p.active!=="boolean")throw Error("Project version activation invalid");
      profiles.push({ ...core, hash: sha(JSON.stringify(core)),...(p.active===undefined?{}:{active:p.active}) });
    }
    if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error("Task authoring profiles repeated");
    for (const a of profiles) for (const b of profiles)
      if (inside(a.repository,b.worktreeRoot) || inside(a.config.vault,b.worktreeRoot) ||
          inside(a.worktreeRoot,b.repository) || inside(a.worktreeRoot,b.config.vault)) throw new Error("Project worktree roots overlap source/Vault roots");
    await mkdir(join(root,"drafts"), { recursive:true }); await mkdir(join(root,"runs"), { recursive:true });
    await mkdir(join(root,"decompositions"), { recursive:true });
    const proofs = await HumanReviewProofStore.open(join(root,"approvals"));
    const service = new LocalTaskAuthoringService(root,profiles,proofs,tasks,await IntegrationBaselines.open(join(root,"baselines")));
    if(value.strictProfileHistory)for(const d of await service.drafts()){
      if(service.profile(d.profileId).hash!==d.profileHash)throw Error("Task history requires its exact execution profile");
      const receipt=await service.approval(d);if(receipt&&receipt.data.profileHash!==d.profileHash)throw Error("Task approval profile differs");
    }
    await service.restoreRegistrations(); return service;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const pending = this.queue.catch(() => undefined).then(fn); this.queue = pending; return pending; }
  private profile(id: string): Profile { const p = this.profiles.find(p => p.id === id); if (!p) throw new Error("Project execution profile missing"); return p; }
  private async draftWriter() {
    for(let attempt=0;attempt<20;attempt++)try{return await open(join(this.root,"draft-writer.lock"),"wx",0o600)}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;await wait(100)}
    throw new Error("Task draft writer is busy or requires reconciliation");
  }
  listProfiles() { return this.profiles.filter(p=>p.active!==false).map(p => ({ id:p.id, title:p.title, project:p.project, allowedPaths:p.allowedPaths,
    verification:p.config.verification.map(c=>c.requirement), planner:p.config.astra, worker:p.config.sol,
    maxAttempts:p.maxAttempts, timeLimitMinutes:p.timeLimitMinutes, independentTasksOnly:true,
    decomposition:{maxTasks:8, executable:"independent_roots", successors:"new_plan_after_integration"} })); }
  /** Trusted server composition only. No HTTP/tool endpoint exposes configuration mutation. */
  integrationConfiguration() { return { storageRoot:join(this.root,"integrations"), profiles:structuredClone(this.profiles) }; }
  async bindIntegration(options:IntegrationReviewOptions,manifest:IntegrationReviewManifest,reviews:LocalReviewService):Promise<void> {
    for(const path of new Set([options.checkout,...reviews.modelWritableRoots(),...options.sources.flatMap(s=>[s.config.checkout,s.config.vault])])){
      const root=await realpath(path);
      if(inside(root,this.root)||inside(this.root,root))throw Error("Integration writable root overlaps protected authoring storage");
    }
    const ids:Array<{profileId:string;id:string}>=[];
    for(const p of this.profiles){const id=await this.baselines.bind(p,options,manifest,reviews);if(id)ids.push({profileId:p.id,id})}
    if(ids.length)reviews.bindIntegrationBaselines(manifest.review.id,()=>Promise.all(ids.map(row=>this.baselines.preview(row.profileId,row.id))));
  }
  async publishIntegrationBase(profileId:string,id:string,artifactSha256:string,requestId:string) {
    return this.admission(async()=>{this.assertActiveProfile(profileId);return this.baselines.publish(profileId,id,artifactSha256,requestId)});
  }
  async integrationBase(profileId:string,id:string){this.profile(profileId);return this.baselines.resolve(profileId,id)}
  private withBase<T>(profileId:string,id:string|undefined,operation:(base?:IntegrationBase)=>Promise<T>):Promise<T> {
    return id?this.baselines.withAccepted(profileId,id,operation):operation();
  }
  private async python(profile: Profile, args: string[]): Promise<unknown> {
    const script = ["../../../scripts/negi_task_authoring.py", "../../../../scripts/negi_task_authoring.py"]
      .map(p => fileURLToPath(new URL(p,import.meta.url))).find(existsSync);
    if (!script) throw new Error("Bundled Task authoring compiler missing");
    return JSON.parse((await exec("python", [script,"--vault",profile.config.vault,...args], { windowsHide:true,
      timeout:20000,maxBuffer:300000,env:{...withoutControlPlaneEnv(),PYTHONIOENCODING:"utf-8"} })).stdout);
  }
  private async projectReferences(id:string,references:string[]=[]) {
    const p = this.profile(id);
    if (references.length > 50 || references.some(r=>!label.test(r))) throw new Error("Project references invalid");
    const context = await this.python(p,["inspect","--project",p.project,...references.flatMap(r=>["--reference",r])]) as References;
    return context;
  }
  async readProject(id: string, references: string[] = [], baselineId?:string) {
    this.assertActiveProfile(id);
    const context=await this.projectReferences(id,references);
    return { ...this.listProfiles().find(row=>row.id===id)!, ...context, integrationBases:await this.baselines.choices(id),
      ...(baselineId?{integrationBase:await this.baselines.resolve(id,baselineId)}:{}) };
  }
  async propose(profileId: string, raw: unknown, origin: Draft["origin"], baselineId?:string): Promise<TaskPlanView> {
    return this.serial(()=>this.admission(()=>this.withBase(profileId,baselineId,async(integrationBase)=>{
      this.assertActiveProfile(profileId);
      const p = this.profile(profileId), f = fields(raw,p);
      if (origin.kind !== "master" || origin.model !== p.config.astra.model || origin.effort !== p.config.astra.effort ||
          ![origin.masterId,origin.threadId,origin.turnId,origin.callId].every(id=>typeof id === "string" && id.length>0 && id.length<=200 && !/[\r\n\0]/.test(id)))
        throw new Error("Task drafts require the configured resident Astra");
      const source = await this.projectReferences(profileId,f.references.map(r=>r.id));
      for (const r of f.references) if (!source.sources.some(s=>s.id===r.id && s.version===r.version && s.sha256===r.sha256)) throw new Error("Task plan reference is stale");
      const baseSha = integrationBase?.baseSha ?? (await exec("git", ["rev-parse","HEAD"], { cwd:p.repository,env:withoutControlPlaneEnv(),windowsHide:true })).stdout.trim().toLowerCase();
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseSha)) throw new Error("Project base SHA invalid");
      const core = { schema:"negi-task-plan/1" as const,id:planIdentity(origin),createdAt:new Date().toISOString(),
        profileId,profileHash:p.hash,baseSha,sources:source.sources,fields:f,origin:structuredClone(origin),...(integrationBase?{integrationBase}:{}) };
      const draft = { ...core,hash:sha(JSON.stringify(core)) },lock=await this.draftWriter();let selected=draft;
      try {
        const drafts=await this.drafts(), previous=drafts.find(d=>isDeepStrictEqual(d.origin,origin));
        if(previous){
          if(previous.decomposition||previous.profileHash!==p.hash||!isDeepStrictEqual(previous.fields,f)||!isDeepStrictEqual(previous.integrationBase,integrationBase))throw new Error("Planner call reused for a different Task draft");
          selected=previous;
        }else{
          if(drafts.length>=100)throw new Error("Task draft catalog limit reached");
          await save(join(this.root,"drafts",`${draft.id}.json`),draft);
        }
      }finally{await lock.close();await unlink(join(this.root,"draft-writer.lock"))}
      return this.view(selected);
    })));
  }
  async proposeDecomposition(profileId: string, raw: unknown, origin: Draft["origin"], baselineId?:string): Promise<TaskPlanView[]> {
    return this.serial(()=>this.admission(()=>this.withBase(profileId,baselineId,async(integrationBase)=>{
      this.assertActiveProfile(profileId);
      const p=this.profile(profileId), f=taskDecomposition(raw,raw=>fields(raw,p));
      if(origin.kind!=="master"||origin.model!==p.config.astra.model||origin.effort!==p.config.astra.effort||
        ![origin.masterId,origin.threadId,origin.turnId,origin.callId].every(id=>typeof id==="string"&&id.length>0&&id.length<=200&&!/[\r\n\0]/.test(id)))
        throw new Error("Task decompositions require the configured resident Astra");
      const source=await this.projectReferences(profileId,[...new Set(f.nodes.flatMap(n=>n.task.references.map(r=>r.id)))]);
      for(const n of f.nodes)for(const r of n.task.references)
        if(!source.sources.some(s=>s.id===r.id&&s.version===r.version&&s.sha256===r.sha256))throw new Error("Task decomposition reference is stale");
      const baseSha=integrationBase?.baseSha??(await exec("git",["rev-parse","HEAD"],{cwd:p.repository,env:withoutControlPlaneEnv(),windowsHide:true})).stdout.trim().toLowerCase();
      if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseSha))throw new Error("Project base SHA invalid");
      const core={schema:"negi-task-decomposition/1" as const,id:planIdentity(origin,"\ndecomposition"),createdAt:new Date().toISOString(),
        profileId,profileHash:p.hash,baseSha,sources:source.sources,fields:f,origin:structuredClone(origin),...(integrationBase?{integrationBase}:{})};
      let group:DecompositionDraft={...core,hash:sha(JSON.stringify(core))};const lock=await this.draftWriter();
      try{
        const drafts=await this.drafts(), previous=drafts.filter(d=>isDeepStrictEqual(d.origin,origin));
        if(previous.length){
          const prior=await json(join(this.root,"decompositions",`${group.id}.json`)) as DecompositionDraft;
          if(!previous.every(d=>d.decomposition?.id===group.id)||prior.profileHash!==p.hash||!isDeepStrictEqual(prior.fields,f)||!isDeepStrictEqual(prior.integrationBase,integrationBase))
            throw new Error("Planner call reused for a different decomposition");
          group=prior;
        }else{
          if(drafts.length+f.nodes.length>100)throw new Error("Task draft catalog limit reached");
          // One immutable file publishes the entire graph; no partially visible child catalog.
          await save(join(this.root,"decompositions",`${group.id}.json`),group);
        }
      }finally{await lock.close();await unlink(join(this.root,"draft-writer.lock"))}
      return Promise.all(this.expand(group).map(d=>this.view(d)));
    })));
  }
  private expand(group:DecompositionDraft):Draft[] {
    return group.fields.nodes.map((n,position)=>{
      const core={schema:"negi-task-plan/1" as const,id:planIdentity(group.origin,`\n${group.id}\n${n.key}`),createdAt:group.createdAt,
        profileId:group.profileId,profileHash:group.profileHash,baseSha:group.baseSha,sources:group.sources,fields:n.task,origin:group.origin,
        ...(group.integrationBase?{integrationBase:group.integrationBase}:{}),decomposition:{id:group.id,hash:group.hash,title:group.fields.title,objective:group.fields.objective,
          coordination:group.fields.coordination,key:n.key,position,dependsOn:n.dependsOn,handoff:n.handoff}};
      return {...core,hash:sha(JSON.stringify(core))};
    });
  }
  async conversationOrigin(draftId: string) {
    const draft = (await this.drafts()).find(item => item.id === draftId);
    if (!draft) throw new Error("Task draft origin not found");
    return this.conversationOriginView(draft);
  }
  private conversationOriginView(draft: Draft) {
    const { masterId, threadId, turnId, callId } = draft.origin;
    return { draftId: draft.id, runId: `task-${draft.id}`, title: draft.fields.title,
      origin: { kind: "master" as const, masterId, threadId, turnId, callId } };
  }
  async runConversationOrigin(runId: string) {
    const draft = (await this.drafts()).find(item => `task-${item.id}` === runId);
    if (!draft) return null;
    const receipt = await this.approval(draft);
    if (!receipt || receipt.data.origin !== JSON.stringify(draft.origin) ||
        !isDeepStrictEqual(JSON.parse(receipt.data.config), this.tasks.authoringTemplate(runId).config))
      throw new Error("Authored Task origin differs from the approved configuration");
    return this.conversationOriginView(draft);
  }
  private async drafts(): Promise<Draft[]> {
    const result: Draft[] = [], entries = await readdir(join(this.root,"drafts"));
    if (entries.length > 100) throw new Error("Task draft catalog limit reached");
    for (const file of entries) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) throw new Error("Task draft file identity invalid");
      const d = await json(join(this.root,"drafts",file)) as Draft, { hash,...core } = d;
      if (d.schema!=="negi-task-plan/1" || !isReviewRequestId(d.id) || file!==d.id+".json" || hash!==sha(JSON.stringify(core))) throw new Error("Task draft integrity invalid");
      result.push(d);
    }
    const groups=await readdir(join(this.root,"decompositions"));
    if(groups.length>50)throw new Error("Task decomposition catalog limit reached");
    for(const file of groups){
      if(!/^[0-9a-f-]{36}\.json$/.test(file))throw new Error("Task decomposition file identity invalid");
      const d=await json(join(this.root,"decompositions",file)) as DecompositionDraft,{hash,...core}=d;
      if(d.schema!=="negi-task-decomposition/1"||!isReviewRequestId(d.id)||file!==d.id+".json"||hash!==sha(JSON.stringify(core))||
        d.id!==planIdentity(d.origin,"\ndecomposition"))throw new Error("Task decomposition integrity invalid");
      // Verify graph structure even when a changed profile leaves its contracts on hold.
      taskDecomposition(d.fields,raw=>raw as TaskPlanFields);
      result.push(...this.expand(d));
    }
    if(result.length>100||new Set(result.map(d=>d.id)).size!==result.length)throw new Error("Task draft catalog identity/limit invalid");
    return result;
  }
  private async approval(draft: Draft) {
    const receiptPath = join(this.root,"runs",`task-${draft.id}`,"approval.json");
    try {
      const pointer = await json(receiptPath) as { requestId:string };
      const receipt = await this.proofs.read(pointer.requestId);
      if (!receipt || receipt.data.draftHash!==draft.hash || receipt.data.draftId!==draft.id || receipt.data.domain!=="task-authoring") throw new Error("Task draft approval identity invalid");
      return receipt;
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
      // A crash may occur after signing and before writing the pointer.
      // Preserve that authorization as pending; never present the draft as unapproved.
      const names=await readdir(this.proofs.root);
      if(names.length>101)throw new Error("Task approval catalog limit reached");
      let result:Awaited<ReturnType<HumanReviewProofStore["read"]>>=null;
      for(const name of names)if(/^[0-9a-f-]{36}\.json$/.test(name)){
        const receipt=await this.proofs.read(name.slice(0,-5));
        if(receipt?.data.domain==="task-authoring"&&receipt.data.draftId===draft.id){
          if(result||receipt.data.draftHash!==draft.hash)throw new Error("Task draft approval conflict");result=receipt;
        }
      }
      return result;
    }
  }
  private async freshness(d: Draft, p: Profile): Promise<void> {
    if (d.profileHash!==p.hash || !isDeepStrictEqual(fields(d.fields,p),d.fields)) throw new Error("Task execution profile changed");
    const refs = await this.projectReferences(p.id,d.sources.map(s=>s.id));
    if (!isDeepStrictEqual(refs.sources,d.sources)) throw new Error("Task plan source references changed");
    const base=d.integrationBase?await this.baselines.resolve(p.id,d.integrationBase.id):undefined;
    if(base&&!isDeepStrictEqual(base,d.integrationBase))throw Error("Task integration baseline changed");
    const head = base?.baseSha ?? (await exec("git",["rev-parse","HEAD"],{cwd:p.repository,env:withoutControlPlaneEnv(),windowsHide:true})).stdout.trim().toLowerCase();
    if (head!==d.baseSha) throw new Error("Project base SHA changed");
  }
  private async view(d: Draft): Promise<TaskPlanView> {
    const p = this.profile(d.profileId); let error:string|null=null;
    const approval = await this.approval(d), runId = approval?.runId ?? null;
    const registered = runId && this.tasks.list().some(r=>r.id===runId);
    if (!registered) try { this.assertActiveProfile(p.id); await this.freshness(d,p); } catch { error="参照仕様・プロジェクトの版・実行設定が変わりました。統括に新しい案を依頼してください。"; }
    if(!registered&&!error)try{await lstat(join(this.root,"writer.lock"));error="契約の確定処理が進行中、または停止後の照合を待っています。状態を更新して確認してください。"}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e}
    if (approval && !registered && !error) error="契約の確定処理を照合してください。実行はまだ開始していません。";
    const waiting=Boolean(d.decomposition?.dependsOn.length);
    return { id:d.id,createdAt:d.createdAt,title:d.fields.title,project:p.project,profileId:p.id,hash:d.hash,baseSha:d.baseSha,
      fields:d.fields,sources:d.sources,verification:p.config.verification.map(v=>v.requirement),planner:p.config.astra,worker:p.config.sol,
      origin:d.origin,status:registered?"registered":error?"attention":waiting?"waiting_dependencies":"draft",canFinalize:!approval&&!error&&!waiting,runId,error,
      ...(d.decomposition?{decomposition:structuredClone(d.decomposition)}:{}),...(d.integrationBase?{integrationBase:structuredClone(d.integrationBase)}:{}) };
  }
  async list(): Promise<TaskPlanView[]> {
    const drafts=(await this.drafts()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||
      (a.decomposition?.id===b.decomposition?.id&&a.decomposition&&b.decomposition?a.decomposition.position-b.decomposition.position:a.id.localeCompare(b.id))), result:TaskPlanView[]=[];
    // Bounded compiler/Git processes even with a full draft catalog.
    for(let i=0;i<drafts.length;i+=4)result.push(...await Promise.all(drafts.slice(i,i+4).map(d=>this.view(d))));
    return result;
  }
  async finalize(id: string, expectedHash: string, requestId: string): Promise<TaskPlanView> {
    return this.serial(()=>this.admission(async () => {
      if (!isReviewRequestId(id) || !digest.test(expectedHash) || !isReviewRequestId(requestId)) throw new Error("Task approval identity invalid");
      const d = (await this.drafts()).find(d=>d.id===id); if (!d || d.hash!==expectedHash) throw new Error("Task plan version differs");
      if(d.decomposition?.dependsOn.length)throw new Error("Successor requires integrated upstream results and a new plan at the actual base");
      return this.withBase(d.profileId,d.integrationBase?.id,async()=>{
      const p=this.profile(d.profileId),lock=await open(join(this.root,"writer.lock"),"wx",0o600);
      try {
      const prior=await this.approval(d);
      if (prior) {
        if (prior.id!==requestId) throw new Error("Task draft was already approved; inspect it");
        return this.view(d); // A retry never creates or starts another worktree/provider.
      }
      this.assertActiveProfile(p.id);
      await this.freshness(d,p);
      const runId=`task-${d.id}`, out=join(this.root,"runs",runId); await mkdir(out,{recursive:true});
      const config:VaultRunConfig={...structuredClone(p.config),runId,checkout:join(p.worktreeRoot,runId),snapshot:join(out,"contract.json"),
        outputDir:join(out,"output"),approvedPlan:{proofDirectory:this.proofs.root,requestId}};
      await mkdir(config.outputDir,{recursive:true});
      if((await lstat(config.outputDir)).isSymbolicLink()||(await realpath(config.outputDir))!==config.outputDir)
        throw new Error("Task output root changed");
      const content=markdown(d,p,requestId), expected=snapshot(d,p,content);
      await this.proofs.create({id:requestId,action:"operation",caseId:`task-plan:${d.id}`,runId,artifactSha256:sha(content),verificationRef:null,
        data:{domain:"task-authoring",draftId:d.id,draftHash:d.hash,profileHash:p.hash,taskId:expected.vaultId,project:p.project,vault:p.config.vault,
          content,sources:JSON.stringify(d.sources),config:JSON.stringify(config),snapshot:JSON.stringify(expected),plan:d.fields.implementationPlan.join("\n"),origin:JSON.stringify(d.origin)}});
      await save(join(out,"approval.json"),{requestId});
      const compiled=await this.python(p,["apply","--proof-dir",this.proofs.root,"--request-id",requestId]);
      if (!isDeepStrictEqual(compiled,expected)) throw new Error("Task compiler differs from the exact approved contract");
      await save(config.snapshot,compiled);
      // Durable intent precedes Git mutation. A partial creation is held for inspection,
      // and startup deliberately refuses to run worktree add again.
        await this.freshness(d,p);
        await save(join(out,"worktree-intent.json"),{configHash:sha(JSON.stringify(config)),baseSha:d.baseSha});
        try { await lstat(config.checkout); throw new Error("Task worktree destination already exists"); }
        catch(error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
        await exec("git",["worktree","add","--detach",config.checkout,d.baseSha],{cwd:p.repository,env:withoutControlPlaneEnv(),windowsHide:true,timeout:120000,maxBuffer:100000});
        await this.assertWorktree(config,p,d.baseSha,true);
        await save(join(out,"worktree-created.json"),{configHash:sha(JSON.stringify(config)),baseSha:d.baseSha});
        await loadVaultTaskContract(config.vault,config.snapshot,config.checkout);
        await this.tasks.registerAuthoredRun(d.fields.title,config);
        this.bindAuthoredAdmission(d,config.runId);
      return this.view(d);
      } finally { await lock.close(); await unlink(join(this.root,"writer.lock")); }
      });
    }));
  }
  private bindAuthoredAdmission(d:Draft,runId:string):void {
    if(!d.decomposition&&!d.integrationBase)return;
    if(d.integrationBase)this.tasks.bindAdmissionGuard(runId,operation=>this.baselines.withAccepted(d.profileId,d.integrationBase!.id,async(base)=>{
      if(!isDeepStrictEqual(base,d.integrationBase))throw Error("Integration baseline changed before admission");return operation();
    }));
    const group=d.decomposition;
    this.tasks.bindStartCheck(runId,async()=>{
      if(d.integrationBase)try{
        if(!isDeepStrictEqual(await this.baselines.resolve(d.profileId,d.integrationBase.id),d.integrationBase))throw Error("Baseline changed");
      }catch{return "先行成果の受入・固定版・保存した基準を確認してください。後続Taskの開始を保留しています。"}
      if(!group)return null;
      const members=(await this.drafts()).filter(row=>row.decomposition?.id===group.id);
      if(!members.length||members.some(row=>row.decomposition?.hash!==group.hash))throw new Error("Task decomposition changed before admission");
      for(const root of members.filter(row=>!row.decomposition!.dependsOn.length)){
        const receipt=await this.approval(root);
        if(!receipt||!this.tasks.list().some(task=>task.id===receipt.runId))
          return "同じ依頼の独立Taskの契約をすべて確定してから開始できます。契約案の画面で残りの作業を確認してください。";
      }
      return null;
    });
  }
  private async assertWorktree(config:VaultRunConfig,p:Profile,baseSha:string,clean:boolean):Promise<void> {
    if ((await lstat(config.checkout)).isSymbolicLink() || !inside(p.worktreeRoot,await realpath(config.checkout))) throw new Error("Authored worktree root changed");
    const common=async(cwd:string)=>(await realpath((await exec("git",["rev-parse","--path-format=absolute","--git-common-dir"],{cwd,env:withoutControlPlaneEnv(),windowsHide:true})).stdout.trim())).toLowerCase();
    if (await common(config.checkout)!==await common(p.repository)) throw new Error("Authored worktree belongs to another Git repository");
    const head=(await exec("git",["rev-parse","HEAD"],{cwd:config.checkout,env:withoutControlPlaneEnv(),windowsHide:true})).stdout.trim().toLowerCase();
    if (head!==baseSha || (clean && (await exec("git",["status","--porcelain"],{cwd:config.checkout,env:withoutControlPlaneEnv(),windowsHide:true})).stdout.trim())) throw new Error("Authored worktree is not the fixed clean base");
  }
  private async restoreRegistrations():Promise<void> {
    for (const d of await this.drafts()) {
      const receipt=await this.approval(d); if (!receipt) continue;
      const p=this.profile(d.profileId),config=JSON.parse(receipt.data.config) as VaultRunConfig;
      // Changed profiles or partially created worktrees remain visible as attention.
      if (receipt.data.profileHash!==p.hash) continue;
      try {
        const created=await json(join(this.root,"runs",config.runId,"worktree-created.json")) as {configHash:string;baseSha:string};
        if (created.configHash!==sha(JSON.stringify(config)) || created.baseSha!==d.baseSha) throw new Error("Authored worktree creation record differs");
        await this.assertWorktree(config,p,d.baseSha,false);
        await this.tasks.registerAuthoredRun(d.fields.title,config);
        this.bindAuthoredAdmission(d,config.runId);
      } catch { /* signed approval remains visible; no automatic mutation or dispatch */ }
    }
  }
}
