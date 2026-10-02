import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileReviewChain } from "../src/server/orchestration/reviewChain.ts";
import { createReviewHttp } from "../src/server/orchestration/reviewHttp.ts";
import { LocalReviewService, ReviewDecisionBusyError } from "../src/server/orchestration/reviewService.ts";
import { TaskResultStore } from "../src/server/orchestration/taskResults.ts";
import { appServerChildEnv } from "../src/server/master/appServerProcess.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(run: (data: {
  dir: string; artifact: string; evidence: string; ledger: string;
  artifactSha256: string; config: unknown; service: LocalReviewService;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-human-review-"));
  try {
    const checkout = join(dir, "checkout");
    const artifacts = join(checkout, "docs");
    const out = join(dir, "run");
    await mkdir(artifacts, { recursive: true });
    await mkdir(out);
    const artifact = join(artifacts, "result.md");
    const evidence = join(out, "verification.json");
    const ledger = join(out, "review.jsonl");
    const content = "# Synthetic result\nLocal test artifact.\n";
    const check = '{"syntheticCheck":true}\n';
    await writeFile(artifact, content);
    await writeFile(evidence, check);
    const artifactSha256 = sha(content);
    const chain = new FileReviewChain(ledger);
    await chain.append({ key: "create", at: new Date().toISOString(), action: {
      type: "create", caseId: "synthetic", runId: "synthetic-run", artifact: {
        ref: artifact, sha256: artifactSha256, objectiveId: "synthetic-objective" } } });
    await chain.append({ key: "verify", at: new Date().toISOString(), action: {
      type: "verify", artifactSha256, evidenceRef: evidence, outcome: "passed" } });
    const config = { storageRoot: join(dir, "human-review"), writableRoots: [checkout],
      cases: [{ id: "synthetic", title: "Synthetic review", ledgerPath: ledger,
        artifactRoot: artifacts, verifiedArtifactSha256: artifactSha256,
        evidencePath: evidence, evidenceSha256: sha(check),
        verificationSummary: "Synthetic test only", limits: "No real user acceptance" }] };
    const service = await LocalReviewService.open(config);
    await run({ dir, artifact, evidence, ledger, artifactSha256, config, service });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("natural feedback is pinned to a version and never implies acceptance", async () => {
  await fixture(async ({ service, artifactSha256, dir }) => {
    const requestId = randomUUID();
    const input = { artifactSha256, requestId, text: "いいですね。ただ最後の説明は短くしたいです。",
      kind: "unclear" as const, scope: "current_task" as const };
    const view = await service.feedback("synthetic", input);
    assert.equal(view.status, "awaiting_review");
    assert.equal(view.feedback[0].text, input.text);
    assert.equal(view.feedback[0].authenticated, true);
    assert.equal(view.feedback[0].targetSha256, artifactSha256);
    assert.equal((await service.feedback("synthetic", input)).feedback.length, 1);
    await assert.rejects(service.feedback("synthetic", { ...input, text: "different" }), /reused/);
    const receipt = JSON.parse(await readFile(join(dir, "human-review", `${requestId}.json`), "utf8"));
    assert.equal(receipt.receipt.source, "authenticated-browser");
  });
});

test("explicit signed acceptance survives reload and can be revoked with a reason", async () => {
  await fixture(async ({ service, artifactSha256, config }) => {
    assert.equal((await service.snapshot("synthetic")).status, "awaiting_review");
    const id = randomUUID();
    assert.equal((await service.accept("synthetic", artifactSha256, id)).status, "accepted");
    assert.equal((await service.accept("synthetic", artifactSha256, id)).status, "accepted");
    const reloaded = await LocalReviewService.open(config);
    assert.equal((await reloaded.snapshot("synthetic")).status, "accepted");
    assert.equal((await reloaded.revoke("synthetic", artifactSha256, randomUUID(),
      "Synthetic withdrawal")).status, "revoked");
  });
});

test("notification claim and concurrent acceptance use the same stable source lock across service instances",async()=>{
  await fixture(async({service,artifactSha256,config,dir})=>{
    const other=await LocalReviewService.open(config),store=await TaskResultStore.open(join(dir,"results"));
    await store.publish({id:sha("notice"),sourceSha256:sha("source"),configSha256:sha("config"),createdAt:new Date().toISOString(),
      runId:"synthetic-run",title:"Synthetic notice",project:"Synthetic",taskId:"TASK",version:1,status:"awaiting_review",
      verificationOutcome:"passed",acceptedBy:null,reviewId:"synthetic",reason:null,
      origin:{kind:"master",masterId:"master",threadId:"thread",turnId:"origin",callId:"call"}});
    let checks=0,acceptance:Promise<unknown>|undefined;
    const context=(await store.prepareContext("master","thread","input",async()=>{
      const current=(await service.snapshot("synthetic")).status==="awaiting_review";
      if(++checks===2)queueMicrotask(()=>{acceptance=other.accept("synthetic",artifactSha256,randomUUID())});
      return current;
    },operation=>service.withResultSource(operation)))!;
    await context.dispatching();
    assert.equal((await store.list())[0].delivery.state,"dispatching");
    await acceptance;assert.equal((await other.snapshot("synthetic")).status,"accepted");
    // The claimed input is immutable; a subsequent decision is a separate result.
    assert.equal((await store.list())[0].acceptedBy,null);
    await context.unknown();assert.equal(await store.prepareContext("master","thread","repeat",async()=>true),null);
  });
});

test("result source owner evidence is durable and an orphaned lock fails closed without deletion",async()=>{
  await fixture(async({service,artifactSha256,dir})=>{
    const path=join(dir,"human-review","result-source.lock");
    await service.withResultSource(async()=>{
      const owner=JSON.parse(await readFile(path,"utf8"));
      assert.equal(owner.schema,"negi-result-source-owner/1");assert.equal(owner.pid,process.pid);
      assert.equal(Number.isFinite(Date.parse(owner.acquiredAt)),true);
      await service.withResultSource(async()=>assert.equal(JSON.parse(await readFile(path,"utf8")).id,owner.id));
    });
    const orphan=JSON.stringify({schema:"negi-result-source-owner/1",pid:0,id:randomUUID(),acquiredAt:new Date().toISOString()})+"\n";
    await writeFile(path,orphan,{flag:"wx"});
    try{
      await assert.rejects(service.accept("synthetic",artifactSha256,randomUUID()),ReviewDecisionBusyError);
      assert.equal(await readFile(path,"utf8"),orphan);assert.equal((await service.snapshot("synthetic")).status,"awaiting_review");
    }finally{await unlink(path)} // This fixture owns the synthetic orphan file.
    assert.equal((await service.accept("synthetic",artifactSha256,randomUUID())).status,"accepted");
  });
});

test("long accepted-baseline work preserves its case while leaving the shared result source available",async()=>{
  await fixture(async({service,config,artifactSha256})=>{
    await service.accept("synthetic",artifactSha256,randomUUID());
    const other=await LocalReviewService.open(config);
    let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve}),held=new Promise<void>(resolve=>{release=resolve});
    const work=service.withCurrentAcceptance("synthetic",artifactSha256,async()=>{entered();await held;return "saved"});
    await ready;
    try{
      assert.equal(await other.withResultSource(async()=>"available"),"available");
      await assert.rejects(other.revoke("synthetic",artifactSha256,randomUUID(),"Concurrent withdrawal"),ReviewDecisionBusyError);
      assert.equal((await other.snapshot("synthetic")).status,"accepted");
    }finally{release();await work}
    assert.equal((await other.revoke("synthetic",artifactSha256,randomUUID(),"After completion")).status,"revoked");
  });
});

for(const action of ["accept","feedback"] as const)
test(`slow Knowledge ${action} details run after releasing result locks and preserve normalized receipts`,async()=>{
  await fixture(async({service,config,artifactSha256})=>{
    const other=await LocalReviewService.open(config),requestId=randomUUID().toUpperCase();
    let release!:()=>void,entered!:()=>void,captured:string|null=null;
    const ready=new Promise<void>(r=>{entered=r}),hold=new Promise<void>(r=>{release=r});
    service.connectKnowledge({links:async()=>{if(action==="accept"){entered();await hold}return{candidates:[],error:null}},
      capture:async(view,id)=>{captured=id;assert.equal(id,`http-feedback:${requestId.toLowerCase()}`);
        assert.equal(view.feedback.some(f=>f.id===id),true);entered();await hold}});
    const work=action==="accept"?service.accept("synthetic",artifactSha256,requestId):service.feedback("synthetic",{
      artifactSha256,requestId,text:"Preserve uppercase request identity",kind:"praise",scope:"current_task"});
    await ready;
    try{
      assert.equal(await other.withResultSource(async()=>"available"),"available");
      const view=await service.snapshot("synthetic",{includeRelations:false});
      assert.equal(view.status,action==="accept"?"accepted":"awaiting_review");
    }finally{release();await work}
    if(action==="feedback")assert.equal(captured,`http-feedback:${requestId.toLowerCase()}`);
  });
});

test("concurrent services preserve acceptance and revocation notices before releasing each decision's source gate",async()=>{
  await fixture(async({service,config,artifactSha256,dir})=>{
    const other=await LocalReviewService.open(config),store=await TaskResultStore.open(join(dir,"results"));
    const notice={id:sha("notice"),sourceSha256:sha("initial"),configSha256:sha("config"),createdAt:new Date().toISOString(),
      runId:"synthetic-run",title:"Synthetic notice",project:"Synthetic",taskId:"TASK",version:1,status:"awaiting_review",
      verificationOutcome:"passed",acceptedBy:null,reviewId:"synthetic",reason:null,origin:{kind:"browser" as const}};
    await store.publish(notice,{resultRevision:0,artifactSha256});
    let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>{entered=r}),hold=new Promise<void>(r=>{release=r});
    const publish=async(reader:LocalReviewService)=>{
      const state=await reader.readState("synthetic");
      if(state.acceptance&&!state.revoked){entered();await hold}
      await store.publish({...notice,sourceSha256:sha(JSON.stringify(state)),status:state.revoked?"review_revoked":"accepted",
        acceptedBy:state.revoked?null:state.acceptance!.approvalRef},{resultRevision:0,artifactSha256});
    };
    service.subscribeResultChanges(()=>publish(service));other.subscribeResultChanges(()=>publish(other));
    const accepted=service.accept("synthetic",artifactSha256,randomUUID());await ready;
    const revoked=other.revoke("synthetic",artifactSha256,randomUUID(),"Concurrent withdrawal");release();
    await Promise.all([accepted,revoked]);
    assert.deepEqual((await store.list()).map(n=>n.update?.kind),["initial","accepted","revoked"]);
    assert.equal((await store.list())[1].acceptedBy!==null,true);assert.equal((await store.list())[2].acceptedBy,null);
  });
});

test("a changed artifact or verification evidence blocks acceptance and preserves the displayed version", async () => {
  await fixture(async ({ service, artifactSha256, artifact, evidence }) => {
    await writeFile(artifact, "# Changed after review\n");
    const view = await service.snapshot("synthetic");
    assert.equal(view.canAccept, false);
    assert.match(view.content, /Local test artifact/);
    assert.ok(view.integrityError);
    await assert.rejects(service.accept("synthetic", artifactSha256, randomUUID()), /更新/);
    await writeFile(artifact, view.content);
    await writeFile(evidence, '{"modified":true}\n');
    assert.equal((await service.snapshot("synthetic")).canAccept, false);
  });
});

test("acceptance cannot be invented by editing the review ledger or its signed receipt", async () => {
  await fixture(async ({ service, artifactSha256, dir }) => {
    const id = randomUUID();
    await service.accept("synthetic", artifactSha256, id);
    const path = join(dir, "human-review", `${id}.json`);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.receipt.runId = "forged-run";
    await writeFile(path, JSON.stringify(data) + "\n");
    await assert.rejects(service.snapshot("synthetic"), /signature/);
  });
  await fixture(async ({ service, artifactSha256, ledger }) => {
    const id = randomUUID();
    await appendFile(ledger, JSON.stringify({ key: `http-review:${id}:accept`,
      at: new Date().toISOString(), action: { type: "accept", artifactSha256,
        approvalRef: `user:http-review:${id}` } }) + "\n");
    await assert.rejects(service.snapshot("synthetic"), /trusted approval rejected/);
  });
});

test("review signing storage is rejected inside a model writable checkout before creating a key", async () => {
  await fixture(async ({ config, dir }) => {
    const storageRoot = join(dir, "checkout", "human-review");
    await assert.rejects(LocalReviewService.open({ ...(config as object), storageRoot }), /outside/);
    await assert.rejects(access(join(storageRoot, "server-signing-key")));
  });
});

test("review HTTP requires a browser cookie and same-origin mutation even on loopback", async () => {
  await fixture(async ({ service, artifactSha256 }) => {
    const token = "synthetic-review-login";
    const handler = createReviewHttp(service, { token });
    const server = createServer(async (req, res) => {
      if (!await handler(req, res, new URL(req.url ?? "/", "http://localhost"))) {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const cookie = { Cookie: `ebi_auth=${token}` };
    try {
      assert.equal((await fetch(`${url}/api/reviews`)).status, 401);
      assert.equal((await fetch(`${url}/api/reviews?summary=1`)).status, 401);
      assert.equal((await fetch(`${url}/api/reviews`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
      assert.equal((await fetch(`${url}/reviews`, { redirect: "manual" })).headers.get("location"), "/login?returnTo=/reviews");
      assert.equal((await fetch(`${url}/reviews`, { headers: cookie })).status, 200);
      const summary = await (await fetch(`${url}/api/reviews?summary=1`, { headers: cookie })).json();
      assert.equal(summary[0].status, "awaiting_review"); assert.equal(summary[0].canAccept, true);
      assert.equal(summary[0].content, undefined); assert.equal(summary[0].artifactSha256, undefined);
      const input = { artifactSha256, requestId: randomUUID() };
      for (const origin of [null, "https://outside.example"]) {
        const headers = { ...cookie, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) };
        assert.equal((await fetch(`${url}/api/reviews/synthetic/accept`, { method: "POST",
          headers, body: JSON.stringify(input) })).status, 403);
      }
      const result = await fetch(`${url}/api/reviews/synthetic/accept`, { method: "POST",
        headers: { ...cookie, "Content-Type": "application/json", Origin: url }, body: JSON.stringify(input) });
      assert.equal(result.status, 200);
      assert.equal((await result.json()).status, "accepted");
      const acceptedSummary = await (await fetch(`${url}/api/reviews?summary=1`, { headers: cookie })).json();
      assert.equal(acceptedSummary[0].status, "accepted"); assert.equal(acceptedSummary[0].canAccept, false);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});

test("model process environment omits browser login and review configuration", () => {
  assert.deepEqual(appServerChildEnv({ PATH: "synthetic", EBI_AUTH_TOKEN: "do-not-inherit",
    NEGI_REVIEW_CONFIG: "private-config", OPENAI_API_KEY: "caller-owned" }),
  { PATH: "synthetic", OPENAI_API_KEY: "caller-owned" });
});

test("a targeted agent correction is visible, stays separate from human feedback, and holds acceptance after reload", async () => {
  await fixture(async ({ service, artifactSha256, config, ledger, dir }) => {
    const note = join(dir, "checkout", "docs", "agent-note.md"), text = "Synthetic factual correction.\n";
    await writeFile(note, text);
    const chain = new FileReviewChain(ledger);
    await chain.append({ key: "agent-correction", at: new Date().toISOString(), action: { type: "feedback", feedback: {
      id: "agent-correction", source: "agent", kind: "correction", scope: "current_task", targetSha256: artifactSha256,
      textRef: `local-agent:${note}#sha256=${sha(text)}` } } });
    let view = await service.snapshot("synthetic");
    assert.equal(view.qualityIssue, true); assert.equal(view.canAccept, false);
    assert.match(view.integrityError!, /原文と機械検証は保存/);
    assert.equal(view.feedback[0].source, "agent"); assert.equal(view.feedback[0].authenticated, false);
    assert.equal(view.feedback[0].text, text);
    await assert.rejects(service.accept("synthetic", artifactSha256, randomUUID()), /訂正指摘/);
    const outside = join(dir, "unrelated-private-note.txt"); await writeFile(outside, "synthetic-private-marker");
    await chain.append({ key: "outside-note", at: new Date().toISOString(), action: { type: "feedback", feedback: {
      id: "outside-note", source: "agent", kind: "praise", scope: "current_task", targetSha256: artifactSha256,
      textRef: `local-agent:${outside}#sha256=${sha("synthetic-private-marker")}` } } });
    const reloaded = await LocalReviewService.open(config); view = await reloaded.snapshot("synthetic");
    assert.equal(view.canAccept, false); assert.equal(view.feedback[1].text, null);
  });
});

test("a corrected and reverified new artifact is not held by an agent correction targeting the old version", async () => {
  await fixture(async ({ artifactSha256, config, ledger, dir, evidence }) => {
    const chain = new FileReviewChain(ledger), revised = join(dir, "checkout", "docs", "revised.md");
    const text = "# Synthetic corrected result\n"; await writeFile(revised, text);
    await chain.append({ key: "correction", at: new Date().toISOString(), action: { type: "feedback", feedback: {
      id: "correction", source: "agent", kind: "correction", scope: "current_task", targetSha256: artifactSha256,
      textRef: "synthetic:correction" } } });
    await chain.append({ key: "revise", at: new Date().toISOString(), action: { type: "revise", fromSha256: artifactSha256,
      artifact: { ref: revised, sha256: sha(text), objectiveId: "synthetic-objective" }, feedbackIds: ["correction"], sameObjective: true } });
    await chain.append({ key: "reverify", at: new Date().toISOString(), action: { type: "verify", artifactSha256: sha(text), evidenceRef: evidence, outcome: "passed" } });
    const next = structuredClone(config) as { cases: Array<{ verifiedArtifactSha256: string }> };
    next.cases[0].verifiedArtifactSha256 = sha(text);
    const reloaded = await LocalReviewService.open(next);
    const view = await reloaded.snapshot("synthetic");
    assert.equal(view.qualityIssue, false); assert.equal(view.canAccept, true); assert.equal(view.previousSha256, artifactSha256);
  });
});
