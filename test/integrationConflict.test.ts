import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setup, origin, git } from "./helpers/taskAuthoringFixture.ts";
import { IntegrationConflictError, LocalIntegrationExecutionService } from "../src/server/orchestration/integrationExecution.ts";
import { createIntegrationHttp } from "../src/server/orchestration/integrationHttp.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";

test("overlap guidance uses all current verified sources and never starts or accepts integration", async () => {
  const f = await setup(); let service: LocalIntegrationExecutionService | null = null;
  const reviews = await LocalReviewService.open({ storageRoot: join(f.root, "reviews"), writableRoots: [], cases: [] });
  let http: ReturnType<typeof createServer> | null = null;
  try {
    await f.tasks.connectReviews(reviews);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const draft = await f.authoring.propose("docs-project", { ...f.fields, title: "同じ文書 " + i,
        allowedPaths: ["docs/shared.txt"] }, { ...origin, callId: "overlap-" + i });
      ids.push((await f.authoring.finalize(draft.id, draft.hash, randomUUID())).runId!);
    }
    for (const id of ids) {
      const before = await f.tasks.snapshot(id); await f.tasks.start(id, before.configSha256, randomUUID());
      const deadline = Date.now() + 90_000;
      for (;;) {
        const value = await f.tasks.snapshot(id);
        if (!value.live && value.status !== "queued") { assert.equal(value.status, "ready_for_review"); break; }
        assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 50));
      }
    }
    service = await LocalIntegrationExecutionService.open(f.authoring, f.tasks, reviews);
    const ledger = await readFile(f.config.schedulerPath), sourcePins = [];
    for (const id of ids) { const s = await f.tasks.integrationSource(id); sourcePins.push({ id, checkout: s.config.checkout,
      diff: git(s.config.checkout, ["diff", "HEAD"]), manifest: await s.readManifest!() }); }
    const calls = f.calls(), rootState = await readdir(join(f.root, "authoring", "integrations"));
    await assert.rejects(service.preview("docs-project", ids), (e: unknown) => {
      assert.ok(e instanceof IntegrationConflictError); assert.equal(e.conflict.kind, "overlapping_paths");
      assert.deepEqual(e.conflict.paths, ["docs/shared.txt"]); assert.equal(e.conflict.baseSha, git(f.repo, ["rev-parse", "HEAD"]));
      assert.deepEqual(e.conflict.sources.map(s => s.id), [...ids].sort());
      for (const row of e.conflict.sources) { const source = sourcePins.find(s => s.id === row.id)!;
        assert.equal(row.reviewId, source.manifest.review.id); assert.equal(row.artifactSha256, source.manifest.review.verifiedArtifactSha256);
        assert.deepEqual(row.acceptance, f.fields.acceptance); }
      return true;
    });
    const handler = createIntegrationHttp(service, { token: "overlap-cookie", allowTokenInQuery: false });
    http = createServer((req, res) => { void handler(req, res, new URL(req.url!, "http://localhost")); });
    await new Promise<void>(r => http!.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + (http.address() as { port: number }).port;
    const headers = { Cookie: "ebi_auth=overlap-cookie", Origin: url, "Content-Type": "application/json" };
    const selection = { profileId: "docs-project", sourceRunIds: ids };
    const post = (route: string, value: unknown, h = headers) => fetch(url + route, { method: "POST", headers: h, body: JSON.stringify(value) });
    assert.equal((await post("/api/integrations/preview", selection, { ...headers, Cookie: "" })).status, 401);
    assert.equal((await post("/api/integrations/preview", selection, { ...headers, Origin: "http://foreign.invalid" })).status, 403);
    const response = await post("/api/integrations/preview", selection); assert.equal(response.status, 409);
    const value = await response.json(); assert.equal(value.conflict.sources.length, 3); assert.deepEqual(value.conflict.paths, ["docs/shared.txt"]);
    const start = await post("/api/integrations/start", { ...selection, expectedHash: "a".repeat(64), requestId: randomUUID() });
    assert.equal(start.status, 409); assert.equal((await start.json()).conflict, undefined);
    assert.deepEqual(await readFile(f.config.schedulerPath), ledger); assert.deepEqual(f.calls(), calls);
    assert.deepEqual(await readdir(join(f.root, "authoring", "integrations")), rootState);
    for (const s of sourcePins) { assert.equal(git(s.checkout, ["diff", "HEAD"]), s.diff);
      const view = await f.tasks.snapshot(s.id); assert.equal(view.acceptedBy, null); }
    // Even after two valid overlapping sources, a changed final source must
    // suppress the entire guidance instead of returning a partial handoff.
    const last = sourcePins.find(s => s.id === [...ids].sort().at(-1))!;
    await writeFile(join(last.checkout, "docs/shared.txt"), "changed after verification\n");
    await assert.rejects(service.preview("docs-project", ids), e => !(e instanceof IntegrationConflictError));
    const stale = await post("/api/integrations/preview", selection); assert.equal(stale.status, 409);
    assert.equal((await stale.json()).conflict, undefined); assert.deepEqual(await readFile(f.config.schedulerPath), ledger);
  } finally { if (http) await new Promise<void>((r, j) => http!.close(e => e ? j(e) : r()));
    await service?.close(); await f.close(); }
});
