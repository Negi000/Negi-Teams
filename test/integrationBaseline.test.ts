import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixture, git } from "./helpers/integrationFixture.ts";
import { integrateVerifiedTasks } from "../src/server/orchestration/taskIntegration.ts";
import { captureIntegrationReview } from "../src/server/orchestration/integrationReview.ts";
import { LocalIntegrationReviewService } from "../src/server/orchestration/integrationReviewService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { IntegrationBaselines } from "../src/server/orchestration/integrationBaseline.ts";

test("baseline binds accepted bytes and signed result, preserves index/HEAD, rejects edits/revocation and reconciles only the original intent",async()=>{
 await fixture(false,async source=>{
  const result=await integrateVerifiedTasks(source),root=dirname(source.outputDir);
  // An already staged tracked edit is part of the reviewed diff, and must remain staged.
  git(source.checkout,["add","--","docs/a.md"]);
  const options={...source,title:"Synthetic baseline",limits:"Fixture only",evidenceSha256:result.evidenceRef.split("#sha256=")[1]};
  const reviews=await LocalReviewService.open({storageRoot:join(root,"reviews"),writableRoots:[],cases:[]});
  await LocalIntegrationReviewService.register([options],reviews);
  const manifest=await captureIntegrationReview(options),profile={id:"project",repository:source.checkout,hash:"a".repeat(64)};
  const storage=join(root,"baselines"),bases=await IntegrationBaselines.open(storage),id=(await bases.bind(profile,options,manifest,reviews))!;
  assert.equal(await bases.bind({...profile,id:"foreign",repository:source.sources[0].config.checkout},options,manifest,reviews),null);
  const artifact=manifest.review.verifiedArtifactSha256,request=randomUUID();
  await assert.rejects(bases.publish(profile.id,id,artifact,request));
  await reviews.accept(manifest.review.id,artifact,randomUUID());
  await assert.rejects(bases.publish("foreign",id,artifact,request));await assert.rejects(bases.publish(profile.id,id,"f".repeat(64),request));
  const head=git(source.checkout,["rev-parse","HEAD"]),status=git(source.checkout,["status","--porcelain"]),index=git(source.checkout,["diff","--cached"]);
  const attempts=await Promise.allSettled([bases.publish(profile.id,id,artifact,request),bases.publish(profile.id,id,artifact,randomUUID())]);
  assert.equal(attempts.filter(row=>row.status==="fulfilled").length,1);assert.equal(attempts.filter(row=>row.status==="rejected").length,1);
  const published=attempts.find(row=>row.status==="fulfilled")!;if(published.status!=="fulfilled")throw Error("No checkpoint was published");
  const base=published.value;
  assert.notEqual(base.baseSha,head);assert.equal(git(source.checkout,["rev-parse","HEAD"]),head);assert.equal(git(source.checkout,["status","--porcelain"]),status);assert.equal(git(source.checkout,["diff","--cached"]),index);
  assert.match(git(source.checkout,["show",base.baseSha+":docs/new-a.md"]),/a new result/);
  assert.deepEqual(await bases.publish(profile.id,id,artifact,randomUUID()),base);
  let entered!:()=>void,release!:()=>void;
  const inside=new Promise<void>(r=>{entered=r}),pending=new Promise<void>(r=>{release=r});
  const guarded=bases.withAccepted(profile.id,id,async()=>{entered();await pending;return true});
  try{
    await inside;
    await assert.rejects(reviews.revoke(manifest.review.id,artifact,randomUUID(),"Concurrent withdrawal"),/操作が進行中/);
    await assert.rejects(bases.publish(profile.id,id,artifact,randomUUID()),/操作が進行中/);
  }finally{release();await guarded}
  const record=join(storage,id+".json"),original=await readFile(record,"utf8");
  await writeFile(record,JSON.stringify({...JSON.parse(original),treeSha:"b".repeat(40)}));await assert.rejects(bases.resolve(profile.id,id));await writeFile(record,original);
  const proof=join(storage,"approvals",base.resultRequestId+".json"),proofBytes=await readFile(proof,"utf8"),envelope=JSON.parse(proofBytes);envelope.receipt.data.record="forged";await writeFile(proof,JSON.stringify(envelope));await assert.rejects(bases.resolve(profile.id,id));await writeFile(proof,proofBytes);
  const ref=`refs/negi/baselines/${id}`;git(source.checkout,["update-ref",ref,head,base.baseSha]);await assert.rejects(bases.resolve(profile.id,id));git(source.checkout,["update-ref",ref,base.baseSha,head]);
  const file=join(source.checkout,"docs/new-a.md"),bytes=await readFile(file);await writeFile(file,"Changed after acceptance");await assert.rejects(bases.resolve(profile.id,id));await writeFile(file,bytes);
  // A crash after the ref/receipt but before publication remains a visible pending intent.
  await unlink(record);assert.equal((await bases.preview(profile.id,id)).canPublish,false);await assert.rejects(bases.publish(profile.id,id,artifact,randomUUID()));
  assert.deepEqual(await bases.publish(profile.id,id,artifact,base.requestId),base);
  const restored=await IntegrationBaselines.open(storage);await restored.bind(profile,options,manifest,reviews);assert.deepEqual(await restored.resolve(profile.id,id),base);
  await reviews.revoke(manifest.review.id,artifact,randomUUID(),"Withdraw fixture result");await assert.rejects(restored.resolve(profile.id,id));await assert.rejects(restored.publish(profile.id,id,artifact,request));
  assert.equal(git(source.checkout,["status","--porcelain"]),status);assert.equal(git(source.checkout,["diff","--cached"]),index);
 });
});
