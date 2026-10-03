import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixture, git, hash } from "./helpers/integrationFixture.ts";
import { integrateVerifiedTasks } from "../src/server/orchestration/taskIntegration.ts";
import { captureIntegrationReview, verifyIntegrationReview, type IntegrationReviewOptions } from "../src/server/orchestration/integrationReview.ts";
import { LocalIntegrationReviewService } from "../src/server/orchestration/integrationReviewService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { FileReviewChain } from "../src/server/orchestration/reviewChain.ts";
import { createReviewHttp } from "../src/server/orchestration/reviewHttp.ts";
import { captureTaskReview } from "../src/server/orchestration/taskReviewArtifact.ts";

async function reviewFixture(run: (data: { options: IntegrationReviewOptions; service: LocalReviewService;
  config: { storageRoot: string; writableRoots: string[]; cases: [] }; id: string; sha: string }) => Promise<void>) {
  await fixture(false, async source => {
    const result = await integrateVerifiedTasks(source);
    const options: IntegrationReviewOptions = { ...source, title: "Synthetic combined review", limits: "Synthetic test only",
      evidenceSha256: result.evidenceRef.split("#sha256=")[1] };
    const config = { storageRoot: join(dirname(source.outputDir), "human-review"), writableRoots: [], cases: [] as [] };
    const service = await LocalReviewService.open(config);
    await LocalIntegrationReviewService.register([options], service);
    const id = service.list()[0].id, sha = (await service.snapshot(id)).artifactSha256;
    await run({ options, service, config, id, sha });
  });
}

test("verified integration is fully presented, remains unaccepted, and source Tasks are preserved", async () => {
  await reviewFixture(async ({ options, service, id }) => {
    const view = await service.snapshot(id);
    assert.equal(view.status, "awaiting_review"); assert.equal(view.canAccept, true);
    assert.equal(view.integration?.sources.length, 2);
    assert.equal(view.integration?.baseSha, options.baseSha);
    assert.match(view.presentation?.acceptance ?? "", /NT-SYNTHETIC-a/);
    assert.ok(view.presentation?.checks[0].passed);
    assert.match(view.content, /a modified/); assert.match(view.content, /new-a.md/);
    const manifest = await captureIntegrationReview(options);
    await assert.rejects(verifyIntegrationReview(options, { ...manifest,
      review: { ...manifest.review, verifiedArtifactSha256: hash("Synthetic counterfeit preview") } }), /preview differs/);
    assert.equal(git(options.checkout, ["rev-parse", "HEAD"]), options.baseSha);
    for (const source of options.sources) assert.equal((await source.readState()).acceptedBy, null);
    await LocalIntegrationReviewService.register([options], service);
    assert.equal(service.list().length, 1);
    assert.equal((await readFile(join(options.outputDir, "integration-review.jsonl"), "utf8")).trim().split("\n").length, 2);
  });
});
test("signed integration acceptance and revocation survive startup without reapplying the diff", async () => {
  await reviewFixture(async ({ options, service, config, id, sha }) => {
    const before = git(options.checkout, ["diff", "HEAD"]), request = randomUUID();
    await service.accept(id, sha, request);
    assert.equal((await service.accept(id, sha, request)).status, "accepted");
    const restarted = await LocalReviewService.open(config);
    await LocalIntegrationReviewService.register([options], restarted);
    assert.equal((await restarted.snapshot(id)).status, "accepted");
    assert.equal((await restarted.revoke(id, sha, randomUUID(), "Synthetic withdrawal")).status, "revoked");
    const again = await LocalReviewService.open(config);
    await LocalIntegrationReviewService.register([options], again);
    assert.equal((await again.snapshot(id)).status, "revoked");
    assert.equal(git(options.checkout, ["diff", "HEAD"]), before);
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "verified");
  });
});
test("source version changes hold both live and restarted integration acceptance while preserving the preview", async () => {
  await reviewFixture(async ({ options, service, config, id, sha }) => {
    const old = (await service.snapshot(id)).content, source = options.sources[0], state = await source.readState();
    state.contract.version++; state.contract.sha256 = hash("synthetic new contract");
    source.readState = async () => structuredClone(state);
    assert.equal((await service.snapshot(id)).canAccept, false);
    await assert.rejects(service.accept(id, sha, randomUUID()), /受入を保留/);
    const restarted = await LocalReviewService.open(config);
    await LocalIntegrationReviewService.register([options], restarted);
    const view = await restarted.snapshot(id);
    assert.equal(view.canAccept, false); assert.equal(view.content, old);
  });
});
test("changed target files, extra paths and altered program evidence each block acceptance", async () => {
  await reviewFixture(async ({ options, service, id, sha }) => {
    const path = join(options.checkout, "docs/new-a.md"), original = await readFile(path);
    await writeFile(path, "Synthetic changed target\n");
    assert.equal((await service.snapshot(id)).canAccept, false);
    await assert.rejects(service.accept(id, sha, randomUUID()));
    await writeFile(path, original);
    const extra = join(options.checkout, "extra.md"); await writeFile(extra, "Synthetic extra\n");
    assert.equal((await service.snapshot(id)).canAccept, false); await unlink(extra);
    assert.equal((await service.snapshot(id)).canAccept, true);
    await writeFile(join(options.outputDir, "command-verification.json"), '{"mechanicalChecksPassed":true,"checks":[]}\n');
    assert.equal((await service.snapshot(id)).canAccept, false);
  });
});
test("a no longer verified source cannot be accepted as part of the integration", async () => {
  await reviewFixture(async ({ options, service, id, sha }) => {
    const source = options.sources[0], state = await source.readState();
    state.status = "stopped"; source.readState = async () => structuredClone(state);
    assert.equal((await service.snapshot(id)).canAccept, false);
    await assert.rejects(service.accept(id, sha, randomUUID()));
  });
});
test("new review capture rejects a changed source even if its newest pinned files are individually valid", async () => {
  await reviewFixture(async ({ options }) => {
    const source = options.sources[0], state = await source.readState();
    await writeFile(join(source.config.checkout, "docs/a.md"), "a valid newer source result\n");
    const evidencePath = join(source.config.outputDir, "verification-r1.json"), bytes = Buffer.from('{"synthetic":true}\n');
    await writeFile(evidencePath, bytes);
    state.verification = { outcome: "passed", evidenceRef: `${evidencePath}#sha256=${hash(bytes)}` };
    const manifest = await captureTaskReview(source.config, source.configSha256, "Synthetic source", state,
      { revision: 1, deferLedger: true });
    source.readState = async () => structuredClone(state);
    source.readManifest = async () => manifest;
    await options.scheduler.append({ key: "synthetic-new-source", at: new Date().toISOString(), action: {
      type: "revalidate", workId: source.config.runId, evidenceRef: state.verification.evidenceRef } });
    await assert.rejects(captureIntegrationReview(options), /integration evidence changed/);
  });
});
test("integration review state cannot be created in a source checkout or Vault", async () => {
  await reviewFixture(async ({ options }) => {
    for (const outputDir of [options.sources[0].config.checkout, options.sources[0].config.vault, options.checkout]) {
      await assert.rejects(captureIntegrationReview({ ...options, outputDir }), /outside/);
      await assert.rejects(access(join(outputDir, "integration-review-result.md")));
    }
  });
});
test("partial review ledger creation is recoverable and missing fixed artifacts are never recaptured", async () => {
  await reviewFixture(async ({ options, config, id }) => {
    const ledger = join(options.outputDir, "integration-review.jsonl"), lines = (await readFile(ledger, "utf8")).split("\n");
    await writeFile(ledger, lines[0] + "\n");
    const restarted = await LocalReviewService.open(config);
    await LocalIntegrationReviewService.register([options], restarted);
    assert.equal((await restarted.snapshot(id)).canAccept, true);
    await unlink(join(options.outputDir, "integration-review-result.md"));
    await assert.rejects(LocalIntegrationReviewService.register([options], restarted), { code: "ENOENT" });
  });
});
test("integration acceptance cannot be forged by writing a ledger approval", async () => {
  await reviewFixture(async ({ options, service, id, sha }) => {
    const chain = new FileReviewChain(join(options.outputDir, "integration-review.jsonl"));
    await assert.rejects(chain.append({ key: "synthetic-forged", at: new Date().toISOString(), action: {
      type: "accept", artifactSha256: sha, approvalRef: `user:http-review:${randomUUID()}` } }));
    assert.equal((await service.snapshot(id)).status, "awaiting_review");
  });
});
test("integration HTTP uses the normal cookie and same-origin human review path", async () => {
  await reviewFixture(async ({ service, id, sha }) => {
    const handler = createReviewHttp(service, { token: "synthetic-integration-login" });
    const server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url!, "http://localhost"))) res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const path = `${origin}/api/reviews/${id}/accept`, body = JSON.stringify({ artifactSha256: sha, requestId: randomUUID() });
      assert.equal((await fetch(path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body })).status, 401);
      const headers = { Cookie: "ebi_auth=synthetic-integration-login", "Content-Type": "application/json" };
      assert.equal((await fetch(path, { method: "POST", headers, body })).status, 403);
      assert.equal((await fetch(path, { method: "POST", headers: { ...headers, Origin: origin }, body })).status, 200);
      assert.equal((await service.snapshot(id)).status, "accepted");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
