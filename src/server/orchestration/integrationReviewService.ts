import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LocalTaskService, type TaskServiceStorageOptions } from "./taskService.ts";
import { LocalReviewService } from "./reviewService.ts";
import type { LocalTaskAuthoringService } from "./taskAuthoring.ts";
import { captureIntegrationReview, verifyIntegrationReview,
  type IntegrationReviewOptions, type IntegrationReviewManifest } from "./integrationReview.ts";

async function json(path: unknown): Promise<Record<string, unknown>> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Integration catalog path must be absolute");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256_000) throw new Error("Integration catalog file invalid");
  const bytes = await readFile(path);
  if (bytes.length > 256_000) throw new Error("Integration catalog changed size");
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration catalog object required");
  return value;
}
/** Startup-only registry; the browser never supplies checkouts, commands or source catalogs. */
export class LocalIntegrationReviewService {
  private constructor(private readonly contexts: LocalTaskService[]) {}
  static async open(raw: unknown, reviews: LocalReviewService, authoring?:LocalTaskAuthoringService|null,
    storageOptions: TaskServiceStorageOptions = {}): Promise<LocalIntegrationReviewService> {
    const storage = structuredClone(storageOptions);
    const row = raw as { integrations?: unknown } | null;
    if (!row || !Array.isArray(row.integrations) || !row.integrations.length || row.integrations.length > 20)
      throw new Error("Integration review registry invalid");
    const contexts = new Map<string, LocalTaskService>(), ids = new Set<string>();
    const options: IntegrationReviewOptions[] = [];
    try {
      for (const value of row.integrations) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration review entry invalid");
        const item = value as Record<string, unknown>;
        for (const key of ["id", "title", "baseSha", "evidenceSha256", "limits"])
          if (typeof item[key] !== "string" || !(item[key] as string).trim()) throw new Error(`Integration ${key} required`);
        if (ids.has(item.id as string) || !Array.isArray(item.sourceRunIds) || item.sourceRunIds.length < 2 ||
            item.sourceRunIds.length > 8 || !item.sourceRunIds.every(id => typeof id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(id)) ||
            new Set(item.sourceRunIds).size !== item.sourceRunIds.length)
          throw new Error("Integration source identities invalid");
        ids.add(item.id as string);
        for (const key of ["taskCatalog", "reviewCatalog", "checkout", "outputDir"])
          if (typeof item[key] !== "string" || !isAbsolute(item[key] as string)) throw new Error(`Integration ${key} must be absolute`);
        const taskCatalog = await realpath(item.taskCatalog as string), reviewCatalog = await realpath(item.reviewCatalog as string);
        const contextKey = taskCatalog + "\0" + reviewCatalog;
        let context = contexts.get(contextKey);
        if (!context) {
          context = await LocalTaskService.open(await json(taskCatalog), undefined, storage);
          contexts.set(contextKey, context);
          await context.connectReviews(await LocalReviewService.open(await json(reviewCatalog)));
        }
        const sources = await Promise.all((item.sourceRunIds as string[]).map(id => context!.integrationSource(id, false)));
        const checkout = await realpath(item.checkout as string), outputDir = await realpath(item.outputDir as string);
        if ((await lstat(item.checkout as string)).isSymbolicLink() || (await lstat(item.outputDir as string)).isSymbolicLink())
          throw new Error("Integration roots cannot be symlinks");
        await reviews.registerWritableRoots([checkout, ...context.knowledgeRegistrations().flatMap(source => [source.checkout, source.vault])]);
        options.push({ id: item.id as string, title: item.title as string, baseSha: item.baseSha as string,
          evidenceSha256: item.evidenceSha256 as string, limits: item.limits as string,
          checkout, outputDir, sources, scheduler: context.registeredScheduler(sources[0].config.schedulerPath) });
      }
      await this.register(options, reviews,authoring);
      return new LocalIntegrationReviewService([...contexts.values()]);
    } catch (error) { await Promise.all([...contexts.values()].map(context => context.close())); throw error; }
  }
  /** Trusted callers can supply authenticated source readers without a second catalog. */
  static async register(options: IntegrationReviewOptions[], reviews: LocalReviewService, authoring?:LocalTaskAuthoringService|null): Promise<void> {
    for (const item of options) {
      await reviews.registerWritableRoots([item.checkout, ...item.sources.flatMap(source => [source.config.checkout, source.config.vault])]);
      const path = join(item.outputDir, "integration-review-manifest.json");
      let manifest: IntegrationReviewManifest;
      try {
        manifest = await json(path) as unknown as IntegrationReviewManifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        manifest = await captureIntegrationReview(item);
      }
      if (manifest.schema !== "negi-integration-review/1" || manifest.id !== item.id || manifest.baseSha !== item.baseSha ||
          manifest.review?.id !== `integration-${createHash("sha256").update(item.id).digest("hex").slice(0, 24)}` ||
          manifest.review?.limits !== item.limits ||
          manifest.review?.evidenceSha256 !== item.evidenceSha256 || manifest.review?.title !== item.title ||
          manifest.review?.ledgerPath !== join(item.outputDir, "integration-review.jsonl") ||
          manifest.review?.artifactRoot !== item.outputDir || manifest.review?.evidencePath !== join(item.outputDir, "integration-verification.json") ||
          !Array.isArray(manifest.sourcePins) || manifest.sourcePins.length !== item.sources.length)
        throw new Error("Integration review manifest differs from its registered identity");
      const artifact = join(item.outputDir, "integration-review-result.md"), entry = await lstat(artifact);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 100_000) throw new Error("Integration artifact type/size invalid");
      const content = await readFile(artifact, "utf8");
      const block = content.split("\n\n## Mechanical verification\n\n")[1]?.split("\n\n## Git diff\n\n")[0];
      if (!block || JSON.stringify(JSON.parse(block).sourcePins) !== JSON.stringify(manifest.sourcePins) ||
          createHash("sha256").update(content).digest("hex") !== manifest.review.verifiedArtifactSha256)
        throw new Error("Integration source presentation differs from its pinned artifact");
      await reviews.registerPinnedResult(manifest.review, item.id, join(item.outputDir, "integration-review-result.md"));
      reviews.bindCurrentCheck(manifest.review.id, async () => {
        try { await verifyIntegrationReview(item, manifest); }
        catch (cause) { throw new Error("統合成果または元Taskの状態が、表示した固定版と一致しません。受入を保留しています。", { cause }); }
      });
      reviews.bindIntegrationDetails(manifest.review.id, { id: item.id, baseSha: item.baseSha,
        sources: manifest.sourcePins.map(({ runId, taskId, taskVersion, revision, artifactSha256, evidenceSha256 }) =>
          ({ runId, taskId, taskVersion, revision, artifactSha256, evidenceSha256 })) });
      await authoring?.bindIntegration(item,manifest,reviews);
    }
  }
  async close(): Promise<void> { await Promise.all(this.contexts.map(context => context.close())); }
}
