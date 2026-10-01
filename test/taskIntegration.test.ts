import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureTaskReview } from "../src/server/orchestration/taskReviewArtifact.ts";
import { integrateVerifiedTasks } from "../src/server/orchestration/taskIntegration.ts";
import { fixture, git, hash } from "./helpers/integrationFixture.ts";

test("stop before applying preserves the clean target; source edits during verification never publish a verified result",async()=>{
 await fixture(false,async options=>{
  const controller=new AbortController();
  await assert.rejects(integrateVerifiedTasks({...options,signal:controller.signal,onPhase:async phase=>{if(phase==="applying")controller.abort()}}));
  assert.equal(git(options.checkout,["status","--porcelain"]),"");assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status,"failed");
 });
 await fixture(false,async options=>{
  const verify=options.verify;
  await assert.rejects(integrateVerifiedTasks({...options,verify:async()=>{const result=await verify();await writeFile(join(options.sources[0].config.checkout,"docs/new-a.md"),"Changed during verification\n");return result}}),/changed|differs/);
  assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status,"needs_reconciliation");
  assert.equal(await readFile(join(options.checkout,"docs/new-a.md"),"utf8"),"a new result\n");
 });
});

test("two isolated verified writes integrate create/edit/delete at the same base and remain unaccepted", async () => {
  await fixture(false, async (options) => {
    const result = await integrateVerifiedTasks(options);
    assert.equal(result.status, "ready_for_review"); assert.equal(result.acceptedBy, null);
    assert.equal(await readFile(join(options.checkout, "docs", "a.md"), "utf8"), "a modified\n");
    await assert.rejects(readFile(join(options.checkout, "docs", "b.md")), { code: "ENOENT" });
    for (const name of ["a", "b"]) assert.equal(await readFile(join(options.checkout, "docs", `new-${name}.md`), "utf8"), `${name} new result\n`);
    assert.equal(git(options.checkout, ["rev-parse", "HEAD"]), options.baseSha);
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "verified");
    for (const source of options.sources) assert.equal((await source.readState()).acceptedBy, null);
    await assert.rejects(integrateVerifiedTasks(options), /registered dependencies/);
  });
});
test("verification target mutation is failed and a post-verification stop never publishes verified evidence", async () => {
  await fixture(false, async options => {
    const result = await integrateVerifiedTasks({...options, verify: async () => {
      const result = await options.verify(); await writeFile(join(options.checkout, "docs/new-a.md"), "Changed by check\n"); return result;
    }});
    assert.equal(result.status, "failed"); assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "failed");
    assert.equal(JSON.parse(await readFile(join(options.outputDir, "integration-verification.json"), "utf8")).contentPassed, false);
  });
  await fixture(false, async options => {
    await assert.rejects(integrateVerifiedTasks({...options, checkBeforePublish: async () => { throw Error("Signed external stop"); }}), /Signed external stop/);
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "needs_reconciliation");
  });
});
test("new executable file is rejected instead of silently losing its source mode", {skip: process.platform === "win32" ? "POSIX executable permissions are unavailable on Windows" : false}, async () => {
  await fixture(false, async options => {
    const source = options.sources[0], file = join(source.config.checkout, "docs/new-a.md");
    await chmod(file, 0o755);
    await assert.rejects(integrateVerifiedTasks(options), /metadata|executable/);
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "queued");
  });
});
test("overlapping ownership is refused before any integration mutation", async () => {
  await fixture(true, async (options) => {
    await assert.rejects(integrateVerifiedTasks(options), /ownership overlaps/);
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "queued");
  });
});
test("a source changed after verification cannot be integrated", async () => {
  await fixture(false, async (options) => {
    await writeFile(join(options.sources[0].config.checkout, "docs", "a.md"), "Changed after verification\n");
    await assert.rejects(integrateVerifiedTasks(options), /changed after verification/);
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
  });
});
test("integration uses the current pinned revision rather than its original artifact", async () => {
  await fixture(false, async (options) => {
    const source = options.sources[0], state = await source.readState();
    await writeFile(join(source.config.checkout, "docs/a.md"), "a corrected revision\n");
    const evidencePath = join(source.config.outputDir, "verification-r1.json");
    const bytes = Buffer.from('{"synthetic":true,"revision":1,"mechanicalChecksPassed":true}\n');
    await writeFile(evidencePath, bytes);
    state.verification = { outcome: "passed", evidenceRef: `${evidencePath}#sha256=${hash(bytes)}` };
    const manifest = await captureTaskReview(source.config, source.configSha256, "Synthetic source", state,
      { revision: 1, deferLedger: true });
    source.readState = async () => structuredClone(state);
    source.readManifest = async () => structuredClone(manifest);
    await options.scheduler.append({ key: "synthetic:source-revalidate", at: new Date().toISOString(), action: {
      type: "revalidate", workId: source.config.runId, evidenceRef: state.verification.evidenceRef } });
    const result = await integrateVerifiedTasks(options);
    assert.equal(result.status, "ready_for_review");
    assert.equal(await readFile(join(options.checkout, "docs/a.md"), "utf8"), "a corrected revision\n");
  });
});
test("a verification exception after apply preserves partial-result evidence and reserves the slot", async () => {
  await fixture(false, async (options) => {
    await assert.rejects(integrateVerifiedTasks({ ...options, verify: async () => { throw new Error("Synthetic check disconnected"); } }), /check disconnected/);
    assert.equal((await options.scheduler.read()).state?.entries.at(-1)?.status, "needs_reconciliation");
    assert.match(await readFile(join(options.checkout, "docs", "new-a.md"), "utf8"), /new result/);
  });
});
test("an ignored target file is preserved even when Git reports a clean checkout", async () => {
  await fixture(false, async (options) => {
    await writeFile(join(options.checkout, ".git", "info", "exclude"), "docs/new-a.md\n");
    await writeFile(join(options.checkout, "docs", "new-a.md"), "User ignored file\n");
    assert.equal(git(options.checkout, ["status", "--porcelain"]), "");
    await assert.rejects(integrateVerifiedTasks(options), /overwrite an untracked/);
    assert.equal(await readFile(join(options.checkout, "docs", "new-a.md"), "utf8"), "User ignored file\n");
  });
});
