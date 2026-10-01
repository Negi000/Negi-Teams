// Authenticated review feedback -> candidate -> explicit, separately signed use.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HumanReviewProofStore, isReviewRequestId } from "./humanReviewProof.ts";
import type { LocalReviewService } from "./reviewService.ts";
import type { LocalTaskService } from "./taskService.ts";

const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = /^[0-9a-f]{64}$/;
export interface LessonFields { title: string; taskClass: string; recommendation: string;
  nonApplicability: string; counterexample: string }
export interface KnowledgeView {
  id: string; project: string; status: "candidate" | "active" | "deprecated"; version: number;
  sha256: string; content: string; fields: LessonFields;
  origin: { caseId: string; feedbackId: string; artifactSha256: string; text: string; kind: string; scope: string };
  sourceVersions: string[]; sourceRefs: string[]; runId: string; exact: boolean;
  sourcesCurrent: boolean; canActivate: boolean;
  history: Array<{ id: string; at: string; op: string; version: number; reason: string; sha256: string }>;
}
interface Entry extends KnowledgeView { vault: string }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
function fields(value: unknown, draft = false): LessonFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge fields required");
  const v = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries({ title: 160, taskClass: 80, recommendation: 2000,
    nonApplicability: 2000, counterexample: 2000 })) {
    if (typeof v[key] !== "string" || (v[key] as string).length > max ||
        (!draft && !(v[key] as string).trim())) throw new Error(`Knowledge ${key} invalid`);
    result[key] = (v[key] as string).trim();
  }
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(result.taskClass) || !result.title)
    throw new Error("Knowledge task class/title invalid");
  return result as unknown as LessonFields;
}
function markdown(entry: Pick<Entry, "id" | "project" | "version" | "status" | "sourceVersions" | "sourceRefs" | "origin" | "fields">,
  requestId: string): string {
  const p: Record<string, string | string[]> = { id: entry.id, kind: "Lesson", project: entry.project,
    scope: "project", status: entry.status, version: String(entry.version),
    updated: new Date().toISOString().slice(0, 10), title: entry.fields.title,
    summary: entry.fields.recommendation.slice(0, 300) || "利用者の指摘から作成した未承認の候補",
    sensitivity: "local", verification_status: "observed", task_classes: [entry.fields.taskClass],
    source_versions: entry.sourceVersions, source_refs: entry.sourceRefs, roles: ["astra", "sol", "luna"] };
  if (entry.status === "active") p.approval_ref = `user:http-knowledge:${requestId}`;
  return "---\n" + Object.entries(p).map(([key, value]) => Array.isArray(value)
    ? `${key}:\n${value.map(item => "  - " + JSON.stringify(item)).join("\n")}`
    : `${key}: ${JSON.stringify(value)}`).join("\n") + "\n---\n" +
    `# ${entry.fields.title}\n\n## 適用範囲\nproject=${entry.project} / task_class=${entry.fields.taskClass}\n` +
    `必須Spec/Task・権限・検証条件を優先する。今回の指摘一件からの限定的な希望であり、一般的な品質向上は未測定。\n` +
    `\n## 次回の推奨\n${entry.fields.recommendation || "（未記入。承認前に確認する）"}\n` +
    `\n## 適用しない条件\n${entry.fields.nonApplicability || "（未記入）"}\n` +
    `\n## 反例\n${entry.fields.counterexample || "（未記入）"}\n` +
    `\n## 指摘原文\n${entry.origin.text}\n\n分類=${entry.origin.kind} / 範囲=${entry.origin.scope}\n` +
    `対象成果SHA-256=${entry.origin.artifactSha256}\n\n## 検証と限界\n` +
    "指摘の保存と対象の版を確認した。別のTaskでの有効性・速度・品質への効果は未測定。成果の受入とは別に参照を承認する。\n";
}

export class LocalKnowledgeService {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly proofDirectory: string, private readonly proofs: HumanReviewProofStore,
    private readonly vaults: string[], private readonly tasks: LocalTaskService,
    private readonly reviews: LocalReviewService) {}

  static async open(raw: unknown, tasks: LocalTaskService, reviews: LocalReviewService): Promise<LocalKnowledgeService> {
    const value = raw as { storageRoot?: unknown } | null;
    if (!value || typeof value.storageRoot !== "string" || !isAbsolute(value.storageRoot))
      throw new Error("Knowledge storageRoot must be an explicitly configured absolute path");
    const target = resolve(value.storageRoot);
    let canonical: string;
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error("Knowledge storage cannot be a symlink");
      canonical = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = join(await realpath(dirname(target)), basename(target));
    }
    const registrations = tasks.knowledgeRegistrations();
    const roots = await Promise.all([...registrations.flatMap(row => [row.vault, row.checkout]),
      ...reviews.knowledgeWritableRoots()].map(root => realpath(root)));
    if (roots.some(root => inside(root, canonical) || inside(canonical, root)))
      throw new Error("Knowledge signing storage must be separate from all Vaults, checkouts and review artifacts");
    const proofs = await HumanReviewProofStore.open(target);
    const vaults = [...new Set(await Promise.all(registrations.map(row => realpath(row.vault))))];
    const service = new LocalKnowledgeService(proofs.root, proofs, vaults, tasks, reviews);
    // Signed pending writes can resume after a crash; conflicting hand edits remain held.
    for (const item of await service.entries()) if (!item.exact) {
      await service.python(item.vault, "apply", item.history.at(-1)!.id).catch(() => undefined);
    }
    tasks.connectKnowledge(proofs.root);
    reviews.connectKnowledge({ capture: (view, id) => service.capture(view.id, id),
      links: async caseId => ({ candidates: (await service.list()).filter(v => v.origin.caseId === caseId)
        .map(v => ({ id: v.id, title: v.fields.title, status: v.status })), error: null }) });
    return service;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => undefined).then(operation);
    this.queue = pending;
    return pending;
  }
  private async python(vault: string, command: "list" | "apply", requestId?: string): Promise<unknown> {
    const script = ["../../../scripts/negi_knowledge.py", "../../../../scripts/negi_knowledge.py"]
      .map(path => fileURLToPath(new URL(path, import.meta.url))).find(existsSync);
    if (!script) throw new Error("Bundled Knowledge writer missing");
    const result = await exec("python", [script, "--vault", vault, "--proof-dir", this.proofDirectory, command,
      ...(requestId ? ["--request-id", requestId] : [])], { windowsHide: true, timeout: 20_000,
      maxBuffer: 4_000_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    return JSON.parse(result.stdout);
  }
  private async entries(): Promise<Entry[]> {
    const result: Entry[] = [];
    for (const vault of this.vaults) result.push(...(await this.python(vault, "list") as KnowledgeView[])
      .map(row => ({ ...row, vault })));
    if (new Set(result.map(row => row.id.toLowerCase())).size !== result.length)
      throw new Error("Knowledge IDs must be unique across registered Vaults");
    return result;
  }
  async list(): Promise<KnowledgeView[]> {
    return (await this.entries()).map(({ vault: _vault, ...view }) => view);
  }
  async retry(id: string, expectedSha256: string): Promise<KnowledgeView> {
    return this.serial(async () => {
      const entry = (await this.entries()).find(row => row.id === id);
      if (!entry || !sha.test(expectedSha256) || entry.sha256 !== expectedSha256)
        throw new Error("Knowledge recovery version changed");
      await this.python(entry.vault, "apply", entry.history.at(-1)!.id);
      return (await this.list()).find(row => row.id === id)!;
    });
  }
  private async write(entry: Entry, op: string, requestId: string, previousSha256: string,
    inputHash: string, reason = ""): Promise<void> {
    const content = markdown(entry, requestId);
    if (Buffer.byteLength(content) > 17_000) throw new Error("Knowledge note exceeds signed storage limit");
    await this.proofs.create({ id: requestId, action: "operation", caseId: `knowledge:${entry.id}`,
      runId: entry.runId, artifactSha256: hash(content), verificationRef: null,
      data: { domain: "knowledge", op, vaultRoot: entry.vault, noteId: entry.id,
        notePath: `40_Lessons/${entry.id}.md`, project: entry.project, previousSha256,
        content, fields: JSON.stringify(entry.fields), origin: JSON.stringify(entry.origin), inputHash, reason } });
    await this.python(entry.vault, "apply", requestId);
  }
  async capture(caseId: string, feedbackId: string): Promise<void> {
    return this.serial(async () => {
      const view = await this.reviews.snapshot(caseId);
      const feedback = view.feedback.find(row => row.id === feedbackId);
      const requestId = feedbackId.replace(/^http-feedback:/, "").toLowerCase();
      if (!feedback?.authenticated || feedback.source !== "user" || !feedback.text ||
          !feedback.targetSha256 || !isReviewRequestId(requestId)) throw new Error("Authenticated feedback required");
      const source = await this.tasks.knowledgeSource(view.runId);
      const existing = await this.proofs.read(requestId);
      if (existing) {
        if (existing.data.domain !== "knowledge" || existing.data.op !== "candidate" ||
            JSON.parse(existing.data.origin).feedbackId !== feedbackId) throw new Error("Knowledge origin identity differs");
        // A candidate already revised/activated must never be rolled back by a retry.
        const latest = (await this.entries()).find(row => row.id === existing.data.noteId);
        if (latest?.history.at(-1)?.id === requestId) await this.python(source.vault, "apply", requestId);
        return;
      }
      const id = `NT-LESSON-${requestId}`;
      const entry = { id, vault: await realpath(source.vault), project: source.project,
        version: 1, status: "candidate", runId: view.runId,
        sourceVersions: source.sourceNotes.map(row => `${row.id}@${row.version}:${row.sha256}`),
        sourceRefs: [`negi-knowledge:${id}`, `review:${caseId}:sha256=${feedback.targetSha256}`, feedbackId,
          ...source.sourceNotes.map(row => row.id)],
        origin: { caseId, feedbackId, artifactSha256: feedback.targetSha256, text: feedback.text,
          kind: feedback.kind, scope: feedback.scope },
        fields: { title: `指摘からの候補: ${view.title}`.slice(0, 160), taskClass: source.taskClass,
          recommendation: "", nonApplicability: "", counterexample: "" } } as Entry;
      await this.write(entry, "candidate", requestId, "0".repeat(64), hash(feedbackId));
    });
  }
  async decide(id: string, op: "revise" | "activate" | "deprecate", input: {
    requestId: string; expectedSha256: string; fields?: unknown; reason?: string }): Promise<KnowledgeView> {
    return this.serial(async () => {
      if (!isReviewRequestId(input.requestId) || !sha.test(input.expectedSha256)) throw new Error("Knowledge identity invalid");
      const inputHash = hash(JSON.stringify({ id, op, ...input }));
      const prior = await this.proofs.read(input.requestId);
      const entry = (await this.entries()).find(row => row.id === id);
      if (!entry) throw new Error("Knowledge candidate not found");
      if (prior) {
        if (prior.data.inputHash !== inputHash || prior.data.noteId !== id || prior.data.op !== op)
          throw new Error("Knowledge request ID reused for another operation");
        if (entry.history.at(-1)?.id === input.requestId) await this.python(entry.vault, "apply", input.requestId);
        return (await this.list()).find(row => row.id === id)!;
      }
      if ((!entry.exact && op !== "deprecate") || entry.sha256 !== input.expectedSha256 || entry.status === "deprecated")
        throw new Error("Knowledge changed or is already deprecated");
      if (op === "activate") {
        fields(entry.fields);
        if (!entry.canActivate) throw new Error("Knowledge classification or sources are not current");
      } else if (op === "revise") entry.fields = fields(input.fields, true);
      else if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000)
        throw new Error("Knowledge deprecation requires a reason");
      entry.version++;
      entry.status = op === "activate" ? "active" : op === "deprecate" ? "deprecated" : "candidate";
      await this.write(entry, op, input.requestId.toLowerCase(), input.expectedSha256, inputHash, input.reason?.trim());
      return (await this.list()).find(row => row.id === id)!;
    });
  }
}
