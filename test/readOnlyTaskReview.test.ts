import assert from "node:assert/strict";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureReadOnlyTaskReview, readOnlyTaskReviewPresentation, verifyReadOnlyTaskReview } from "../src/server/orchestration/readOnlyTaskReview.ts";
import { captureTaskReview, verifyTaskReviewCheckout, type TaskReviewManifest } from "../src/server/orchestration/taskReviewArtifact.ts";
import { prepareCompletedResearch, researchFixture, researchHash } from "./helpers/readOnlyTaskFixture.ts";
import { RESEARCH_FINDINGS_BYTES } from "../src/server/orchestration/researchArtifactPolicy.ts";

test("maximum escaped findings and large command metadata remain fully reviewable",async()=>researchFixture(async data=>{
  const state=await prepareCompletedResearch(data);
  // Synthetic command metadata exercises the preview bound without exceeding
  // Windows' separate command-line limit or starting an oversized subprocess.
  data.config.verification[0].args.push("x".repeat(90_000));
  data.configSha256=researchHash(JSON.stringify({config:data.config,snapshotSha256:researchHash(await readFile(data.config.snapshot))}));
  const evidencePath=join(data.config.outputDir,"verification.json"),evidence=JSON.parse(await readFile(evidencePath,"utf8"));
  evidence.checks[0].args=data.config.verification[0].args;
  const evidenceBytes=JSON.stringify(evidence);await writeFile(evidencePath,evidenceBytes);
  state.verification!.evidenceRef=`${evidencePath}#sha256=${researchHash(evidenceBytes)}`;
  const text="\u0001".repeat(RESEARCH_FINDINGS_BYTES),path=join(data.config.outputDir,"artifacts","luna.md");
  await writeFile(path,text);state.attempts.at(-1)!.outputRef=`${path}#sha256=${researchHash(text)}`;
  const manifest=await captureReadOnlyTaskReview(data.config,data.configSha256,"Bounded findings",state);
  const preview=await readFile(join(data.config.outputDir,"review-result.md"));assert.ok(preview.length<100_000);
  assert.equal(readOnlyTaskReviewPresentation(preview.toString("utf8"))!.changes,text);
  await verifyReadOnlyTaskReview(data.config,manifest,state);
}));

test("research reviews pin the exact completed output and preserve embedded headings without accepting it",async()=>researchFixture(async data=>{
  const state=await prepareCompletedResearch(data),manifest=await captureReadOnlyTaskReview(data.config,data.configSha256,"読み取り専用の調査",state);
  assert.equal(manifest.schema,"negi-task-readonly-review/1");assert.equal(manifest.resultKind,"read-only-artifact");
  assert.equal(state.acceptedBy,null);assert.equal(manifest.attempt.id,"luna");assert.equal("files" in manifest,false);
  const content=await readFile(join(data.config.outputDir,"review-result.md"),"utf8"),presentation=readOnlyTaskReviewPresentation(content)!;
  assert.equal(presentation.kind,"read_only_research");assert.match(presentation.changes,/## Git diff[\s\S]*調査成果の一部/);
  assert.match(presentation.acceptance,/Report evidence/);assert.equal(presentation.checks.length,2);
  await verifyReadOnlyTaskReview(data.config,manifest,state);
  await assert.rejects(captureTaskReview(data.config,data.configSha256,"wrong kind",state),/artifact review/);
  await assert.rejects(verifyTaskReviewCheckout(data.config,manifest as unknown as TaskReviewManifest),/integration source/);
  const first=await readFile(join(data.config.outputDir,"review-result.md"));await unlink(join(data.config.outputDir,"review-manifest.json"));
  assert.deepEqual(await captureReadOnlyTaskReview(data.config,data.configSha256,"読み取り専用の調査",state),manifest);
  assert.deepEqual(await readFile(join(data.config.outputDir,"review-result.md")),first);
}));

test("research acceptance evidence holds source, preview, manifest, snapshot, and visible checkout changes",async()=>researchFixture(async data=>{
  const state=await prepareCompletedResearch(data),manifest=await captureReadOnlyTaskReview(data.config,data.configSha256,"読み取り専用の調査",state);
  for(const path of [join(data.config.outputDir,"artifacts","luna.md"),join(data.config.outputDir,"review-result.md"),
    join(data.config.outputDir,"review-manifest.json"),data.config.snapshot,join(data.config.checkout,"docs","base.md")]){
    const bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from("changed\n")]));
    await assert.rejects(verifyReadOnlyTaskReview(data.config,manifest,state));await writeFile(path,bytes);
  }
  await verifyReadOnlyTaskReview(data.config,manifest,state);
  await writeFile(join(data.config.checkout,"untracked.txt"),"untracked\n");
  await assert.rejects(verifyReadOnlyTaskReview(data.config,manifest,state),/checkout changed/);
}));

test("a hardlinked output, wrong attempt, foreign outputRef, and unknown result cannot become research review",async()=>researchFixture(async data=>{
  const state=await prepareCompletedResearch(data),path=join(data.config.outputDir,"artifacts","luna.md");
  await link(path,join(data.dir,"linked-output.md"));
  await assert.rejects(captureReadOnlyTaskReview(data.config,data.configSha256,"Research",state),/unsafe/);
  await unlink(join(data.dir,"linked-output.md"));
  for(const change of [(copy:typeof state)=>{copy.attempts.at(-1)!.role="sol"},
    (copy:typeof state)=>{copy.attempts.at(-1)!.outputRef=`${data.config.snapshot}#sha256=${researchHash("foreign")}`},
    (copy:typeof state)=>{copy.verification!.outcome="unknown"}]){
    const copy=structuredClone(state);change(copy);await assert.rejects(captureReadOnlyTaskReview(data.config,data.configSha256,"Research",copy));
  }
}));

test("rewritten evidence cannot self-accept, hide a dirty start, omit checks, or introduce a revision",async()=>researchFixture(async data=>{
  const state=await prepareCompletedResearch(data),path=join(data.config.outputDir,"verification.json"),original=await readFile(path);
  for(const change of [(v:Record<string,unknown>)=>{v.humanAcceptance="AI accepted"},(v:Record<string,unknown>)=>{v.cleanAtStart=false},
    (v:Record<string,unknown>)=>{v.checks=[]},(v:Record<string,unknown>)=>{v.changedPaths=["docs/base.md"]}]){
    const value=JSON.parse(original.toString()),copy=structuredClone(state);change(value);const bytes=Buffer.from(JSON.stringify(value));await writeFile(path,bytes);
    copy.verification!.evidenceRef=`${path}#sha256=${researchHash(bytes)}`;
    await assert.rejects(captureReadOnlyTaskReview(data.config,data.configSha256,"Research",copy),/fixed checks/);
  }
  await writeFile(path,original);const copy=structuredClone(state);copy.resultRevisions=[{fromEvidenceRef:"a",evidenceRef:"b",revisionRef:"c"}];
  await assert.rejects(captureReadOnlyTaskReview(data.config,data.configSha256,"Research",copy),/fixed Task/);
}));
