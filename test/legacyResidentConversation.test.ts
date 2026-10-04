import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerBrain } from "../src/server/master/codexAppServerBrain.ts";
import type { MasterConversationAuthority, MasterConversationResult, MasterConversationRequest } from "../src/server/orchestration/masterConversations.ts";

const provider = String.raw`
const fs=require('node:fs');let data='';process.stdin.on('data',chunk=>{data+=chunk;let end;while((end=data.indexOf('\n'))>=0){
 const q=JSON.parse(data.slice(0,end));data=data.slice(end+1);if(q.id===undefined)continue;fs.appendFileSync(process.argv[1],JSON.stringify(q)+'\n');
 const thread=(id)=>({id,cwd:process.cwd(),model:'fixture-astra',modelProvider:'fixture',reasoningEffort:'medium',ephemeral:false,status:{type:'idle'},turns:[]});
 const response=t=>({thread:t,cwd:t.cwd,model:t.model,modelProvider:t.modelProvider,reasoningEffort:t.reasoningEffort,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 let result={};if(q.method==='initialize')result={userAgent:'legacy-settings-fixture'};
 if(q.method==='model/list')result={data:[{model:'fixture-astra',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'low'}],inputModalities:['text']}],nextCursor:null};
 if(q.method==='thread/read'&&process.argv[2]==='missing'){process.stdout.write(JSON.stringify({id:q.id,error:{code:-32600,message:'thread not loaded'}})+'\n');continue}
 if(q.method==='thread/read')result={thread:thread(q.params.threadId)};
 if(q.method==='thread/resume')result=response(thread(q.params.threadId));
 if(q.method==='thread/turns/list')result={data:[],nextCursor:null};
 if(q.method==='thread/start')result=response(thread('new-thread'));
 process.stdout.write(JSON.stringify({id:q.id,result})+'\n');
}});`;

async function fixture(mode = "saved") {
  const cwd = await mkdtemp(join(tmpdir(), "negi-legacy-resident-")), wire = join(cwd, "wire.jsonl");
  const options = { executable: process.execPath, args: ["-e", provider, wire, mode], effort: "medium", turnTimeoutMs: 5000 };
  const start = { cwd, model: "fixture-astra", resumeSessionId: null, permissionMode: "plan" as const, systemPrompt: null, mcpConfigPath: null, extraArgs: [] };
  // The pre-bootstrap hash format. The fake authority represents already
  // verified storage; this test exercises the Brain's compatibility decision.
  const legacy = createHash("sha256").update(JSON.stringify({ cwd, model: start.model, sandbox: "read-only", resident: { effort: options.effort },
    executable: options.executable, args: options.args, subscriptionOnly: false })).digest("hex");
  const original: MasterConversationResult = { request: { requestId: randomUUID(), masterId: "master", mode: "start", oldThreadId: null,
    cwd, model: start.model, effort: options.effort, provider: null, settingsSha256: legacy }, stage: "completed", reason: null,
    identity: { threadId: "legacy-thread", requestedModel: start.model, resolvedModel: start.model, modelProvider: "fixture", rerouted: false } };
  const records = [structuredClone(original)];
  const authority = {
    resident: async () => ({ current: structuredClone(records.at(-1)), turns: [] }),
    status: async (id: string) => { const found = records.find(record => record.request.requestId === id); return found ? { ...structuredClone(found), exclusionHeld: false } : null; },
    start: async (request: MasterConversationRequest, run: (mark: () => Promise<void>) => Promise<NonNullable<MasterConversationResult["identity"]>>) => {
      const identity = await run(async () => {}), record: MasterConversationResult = { request: structuredClone(request), identity, stage: "completed", reason: null };
      records.push(record); return structuredClone(record);
    },
  } as unknown as MasterConversationAuthority;
  const brain = () => new CodexAppServerBrain({ ...options, conversations: authority, masterId: "master" });
  const requests = async () => (await readFile(wire, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { cwd, wire, options, start, records, original, authority, brain, requests, close: () => rm(cwd, { recursive: true, force: true }) };
}

test("brain resumes matching legacy settings and rotates to the new history version without rewriting the old record", async () => {
  const f = await fixture(); let brain = f.brain();
  try {
    await brain.start(f.start); assert.equal(brain.sessionId(), "legacy-thread");
    assert.deepEqual(f.records, [f.original]);
    assert.equal((await f.requests()).some(q => ["thread/start", "thread/inject_items", "turn/start"].includes(q.method)), false);
    const requestId = randomUUID(); const rotated = await brain.newConversation({ requestId, oldThreadId: "legacy-thread" });
    assert.equal(rotated.newThreadId, "new-thread"); assert.notEqual(f.records.at(-1)!.request.settingsSha256, f.original.request.settingsSha256);
    assert.deepEqual(f.records[0], f.original); assert.equal((await f.requests()).filter(q => q.method === "thread/inject_items").length, 1);
    await brain.stop(); brain = f.brain(); await brain.start(f.start); assert.equal(brain.sessionId(), "new-thread");
    await brain.newConversation({ requestId, oldThreadId: "legacy-thread" });
    const requests = await f.requests(); assert.equal(requests.filter(q => q.method === "thread/start").length, 1);
    assert.equal(requests.filter(q => q.method === "thread/inject_items").length, 1); assert.equal(requests.some(q => q.method === "turn/start"), false);
    await brain.stop();
    const changed = new CodexAppServerBrain({ ...f.options, effort: "low", conversations: f.authority, masterId: "master" });
    await assert.rejects(changed.start(f.start), /保存済みの会話と担当設定が異なります/); await changed.stop();
    assert.deepEqual(await f.requests(), requests); assert.deepEqual(f.records[0], f.original);
  } finally { await brain.stop(); await f.close(); }
});

test("an unavailable legacy empty conversation stays held without a new thread or history injection", async () => {
  const f = await fixture("missing"), brain = f.brain();
  try {
    await assert.rejects(brain.start(f.start), /thread not loaded/);
    assert.equal((await f.requests()).some(q => ["thread/start", "thread/inject_items", "turn/start"].includes(q.method)), false);
    assert.deepEqual(f.records, [f.original]);
  } finally { await brain.stop(); await f.close(); }
});
