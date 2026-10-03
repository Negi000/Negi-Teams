import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { link, lstat, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { LocalPolicyService } from "../src/server/orchestration/policyService.ts";
import { createPolicyHttp } from "../src/server/orchestration/policyHttp.ts";
import { loginReturnTo } from "../src/server/auth.ts";
import { policyFixture } from "./helpers/policyFixture.ts";
const windows = { skip: process.platform !== "win32" };

async function decide(service: LocalPolicyService, id: string, op: "approve" | "activate" | "rollback", reason?: string) {
  return service.decide(id, op, { requestId: randomUUID(), expectedSha256: (await service.list()).sha256, reason });
}
test("browser-signed approval, activation, parent rollback and restart preserve fixed versions", windows, async () => {
  const fixture = await policyFixture();
  try {
    let service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    assert.equal((await service.list()).items.find(v => v.policy.id === "v1")!.canApprove, true);
    assert.equal((await service.list()).items.find(v => v.policy.id === "v2")!.canApprove, false);
    await assert.rejects(decide(service, "v1", "activate"), /policy id missing/);
    const initial = await service.list(), requestId = randomUUID();
    const input = { requestId, expectedSha256: initial.sha256 };
    await service.decide("v1", "approve", input);
    assert.equal((await service.list()).activeId, null);
    await assert.rejects(service.decide("v1", "activate", { requestId: randomUUID(), expectedSha256: initial.sha256 }), /version changed/);
    await decide(service, "v1", "activate");
    assert.equal((await service.decide("v1", "approve", input)).activeId, "v1");
    await assert.rejects(service.decide("v1", "activate", input), /reused/);
    const active = await service.list();
    service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    assert.deepEqual(await service.list(), active);
    assert.equal((await service.list()).items.find(v => v.policy.id === "v2")!.canApprove, true);
    await decide(service, "v2", "approve"); await decide(service, "v2", "activate");
    service = await LocalPolicyService.open({ ...fixture.config, candidates: [fixture.config.candidates[1]] }, [fixture.checkout], fixture.secret);
    assert.equal((await service.list()).activeId, "v2");
    await assert.rejects(decide(service, "v2", "rollback", "  "), /invalid/);
    await decide(service, "v2", "rollback", "品質の再確認");
    assert.equal((await service.list()).activeId, "v1");
    await assert.rejects(decide(service, "v2", "activate"), /stale/);
    await decide(service, "v1", "rollback", "既定へ戻す");
    assert.equal((await service.list()).activeId, null);
    assert.equal((await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret).then(s => s.list())).history.length, 6);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("changing the policy secret holds signed history; the original secret preserves rollback", windows, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    await decide(service, "v1", "approve"); await decide(service, "v1", "activate");
    await assert.rejects(LocalPolicyService.open(fixture.config, [fixture.checkout], "different-private-policy-secret-" + randomUUID()), /signature/);
    const reopened = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    assert.equal((await reopened.list()).activeId, "v1");
    await decide(reopened, "v1", "rollback", "署名秘密は維持して差し戻す");
    assert.equal((await reopened.list()).activeId, null);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("crash before committed receipt publication releases the native guard and preserves prior state", windows, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    const moduleUrl = pathToFileURL(resolve("src/server/orchestration/policyService.ts")).href;
    // Pause at the atomic publication boundary after the signed staging bytes
    // have been fsynced, then terminate their actual Node owner.
    const source = `const fs=require('node:fs');const originalOpen=fs.promises.open;fs.promises.open=async(...args)=>{const file=await originalOpen(...args);if(String(args[0]).includes('.pending-')){const sync=file.sync.bind(file);file.sync=async()=>{await sync();console.log('publication-held');await new Promise(()=>setInterval(()=>{},1000));};}return file;};require('node:module').syncBuiltinESMExports();
import(${JSON.stringify(moduleUrl)}).then(async m=>{let raw='';for await(const c of process.stdin)raw+=c;const input=JSON.parse(raw);const s=await m.LocalPolicyService.open(input.config,[input.checkout],input.secret);await s.decide('v1','approve',{requestId:input.requestId,expectedSha256:(await s.list()).sha256});});`;
    const child = spawn(process.execPath, ["--import", "tsx", "-e", source], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
    const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept); child.once("error", reject); });
    const ready = new Promise<void>(accept => child.stdout.on("data", chunk => { output += chunk; if (output.includes("publication-held")) accept(); }));
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdin.end(JSON.stringify({ config: fixture.config, checkout: fixture.checkout, secret: fixture.secret, requestId: randomUUID() }));
    try {
      await Promise.race([ready, closed.then(() => { throw Error(`child closed before publication: ${errors}`); })]);
      assert.equal((await readdir(service.root)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).length, 0);
      await assert.rejects(service.list(), /保存処理|確認が必要/);
    } finally { clearTimeout(timer); child.kill(); await closed; }
    const reopened = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    assert.equal((await reopened.list()).history.length, 0);
    await decide(reopened, "v1", "approve"); await decide(reopened, "v1", "activate");
    assert.equal((await reopened.list()).activeId, "v1");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("regressed evidence is visible but never approvable; altered artifacts hold selection", windows, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    const held = (await service.list()).items.find(v => v.policy.id === "regressed")!;
    assert.equal(held.stage, "shadow"); assert.equal(held.canApprove, false); assert.match(held.heldReasons[0], /did not improve/);
    await assert.rejects(decide(service, "regressed", "approve"), /did not improve/);
    await decide(service, "v1", "approve"); await decide(service, "v1", "activate");
    const input = { role: "luna" as const, taskClass: "read_only_research" as const,
      defaultProfile: { model: "gpt-6-luna", effort: "medium" },
      catalog: [{ model: "gpt-6-luna", efforts: ["medium", "low"], inputModalities: ["text"] }] };
    assert.equal((await service.select(input))!.effort, "low");
    assert.equal(await service.select({ ...input, role: "sol" }), null);
    assert.equal(await service.select({ ...input, defaultProfile: { model: "gpt-6-luna", effort: "high" } }), null);
    assert.equal(await service.select({ ...input, catalog: [] }), null);
    await writeFile(join(fixture.evidence, "v1-one-candidate.md"), "altered");
    const damaged = await service.list();
    assert.equal(damaged.items.find(v => v.policy.id === "v1")!.canRollback, true);
    assert.match(damaged.items.find(v => v.policy.id === "v1")!.heldReasons[0], /evidence/);
    assert.equal(await service.select({ ...input, defaultProfile: { model: "gpt-6-luna", effort: "high" } }), null);
    await assert.rejects(service.select(input), /evidence unavailable/);
    const reopened = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    await decide(reopened, "v1", "rollback", "根拠を確認できないため戻す");
    assert.equal((await reopened.list()).activeId, null);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("unrelated missing evidence and removed registrations do not prevent signed rollback", windows, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    await decide(service, "v1", "approve"); await decide(service, "v1", "activate");
    await rm(fixture.config.candidates[2].report.path);
    const input = { role: "luna" as const, taskClass: "read_only_research" as const,
      defaultProfile: { model: "gpt-6-luna", effort: "medium" },
      catalog: [{ model: "gpt-6-luna", efforts: ["medium", "low"], inputModalities: ["text"] }] };
    assert.equal((await service.select(input))!.policyId, "v1");
    const reopened = await LocalPolicyService.open({ ...fixture.config, candidates: [] }, [fixture.checkout], fixture.secret);
    assert.equal((await reopened.list()).items[0].canRollback, true);
    await assert.rejects(reopened.select(input), /evidence unavailable/);
    await decide(reopened, "v1", "rollback", "登録を再確認するため戻す");
    assert.equal((await reopened.list()).activeId, null);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("independent evidence and authority are required before storage creation", windows, async () => {
  const fixture = await policyFixture();
  try {
    await assert.rejects(LocalPolicyService.open({ ...fixture.config, storageRoot: join(fixture.checkout, "proofs") }, [fixture.checkout], fixture.secret), /overlaps/);
    await assert.rejects(LocalPolicyService.open(fixture.config, [fixture.directory], fixture.secret), /overlaps/);
    await assert.rejects(LocalPolicyService.open({ ...fixture.config, candidates: fixture.config.candidates.map(v => ({ ...v,
      report: { ...v.report, sha256: "0".repeat(64) } })) }, [fixture.checkout], fixture.secret), /digest/);
    await assert.rejects(lstat(fixture.config.storageRoot), /ENOENT/);
    await assert.rejects(LocalPolicyService.open(fixture.config, [fixture.evidence], fixture.secret), /independent/);
    await assert.rejects(lstat(fixture.config.storageRoot), /ENOENT/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("two service instances cannot sign competing operations against one displayed version", windows, async () => {
  const fixture = await policyFixture();
  try {
    const a = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    const b = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    const expectedSha256 = (await a.list()).sha256;
    const results = await Promise.allSettled([a.decide("v1", "approve", { requestId: randomUUID(), expectedSha256 }),
      b.decide("v1", "approve", { requestId: randomUUID(), expectedSha256 })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await a.list()).history.length, 1);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("valid config key ordering does not alter approval, replay or rollback; schema extras are rejected before writes", windows, async () => {
  const fixture = await policyFixture();
  try {
    const reordered = { ...fixture.config, candidates: fixture.config.candidates.map(c => ({
      policy: Object.fromEntries(Object.entries(c.policy).reverse()), title: c.title,
      report: { sha256: c.report.sha256, path: c.report.path }, shadowRef: c.shadowRef })) };
    const service = await LocalPolicyService.open(reordered, [fixture.checkout], fixture.secret);
    await decide(service, "v1", "approve"); await decide(service, "v1", "activate");
    const reopened = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    assert.equal((await reopened.list()).activeId, "v1");
    await decide(reopened, "v1", "rollback", "並び順を変えても同じ版");
    assert.equal((await reopened.list()).activeId, null);
    const invalid = { ...fixture.config, storageRoot: join(fixture.directory, "invalid-authority"),
      candidates: fixture.config.candidates.map(c => ({ ...c, unexpected: true })) };
    await assert.rejects(LocalPolicyService.open(invalid, [fixture.checkout], fixture.secret), /candidate invalid/);
    await assert.rejects(lstat(invalid.storageRoot), /ENOENT/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("unsigned or altered receipts cannot activate a policy on restart", windows, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    await decide(service, "v1", "approve");
    const name = (await readdir(service.root)).find(name => name.endsWith(".json"))!;
    const envelope = JSON.parse(await readFile(join(service.root, name), "utf8"));
    envelope.receipt.data.op = "activate"; await writeFile(join(service.root, name), JSON.stringify(envelope));
    await assert.rejects(service.list(), /signature/);
    await assert.rejects(LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret), /signature/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("workspace hardlinks to key/receipt are rejected and copied disk key cannot forge protected decisions", windows, async () => {
  const fixture = await policyFixture();
  try {
    const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
    await decide(service, "v1", "approve"); await decide(service, "v1", "activate");
    const displayed = await service.list(), keyPath = join(service.root, "server-signing-key"), keyLink = join(fixture.checkout, "key-alias");
    await link(keyPath, keyLink); const stolenKey = await readFile(keyLink);
    await assert.rejects(service.list(), /Protected proof file/);
    await assert.rejects(service.decide("v1", "rollback", { requestId: randomUUID(), expectedSha256: displayed.sha256, reason: "must reject" }), /Protected proof file/);
    await assert.rejects(LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret), /Protected proof file/);
    await unlink(keyLink);
    assert.equal((await service.list()).activeId, "v1");
    const receiptName = (await readdir(service.root)).find(name => /^[0-9a-f-]{36}\.json$/.test(name))!;
    const receiptPath = join(service.root, receiptName), alias = join(fixture.checkout, "receipt-alias");
    await link(receiptPath, alias); await assert.rejects(service.list(), /Protected proof file/);
    // Retain a writer handle after dropping the visible alias. nlink alone can
    // no longer see this attack; the external-secret HMAC must reject it.
    const writer = await open(alias, "r+"); await unlink(alias);
    const envelope = JSON.parse(await readFile(receiptPath, "utf8"));
    envelope.receipt.data.reason = "unauthorized rollback";
    envelope.signature = createHmac("sha256", stolenKey).update(JSON.stringify(envelope.receipt)).digest("hex");
    const bytes = Buffer.from(JSON.stringify(envelope));
    try { await writer.truncate(0); await writer.write(bytes, 0, bytes.length, 0); await writer.sync(); }
    finally { await writer.close(); }
    assert.equal((await lstat(receiptPath)).nlink, 1);
    await assert.rejects(service.list(), /signature/);
    await assert.rejects(LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret), /signature/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("HTTP requires cookie, same-origin, current version and server-registered evidence", windows, async () => {
  const fixture = await policyFixture();
  const service = await LocalPolicyService.open(fixture.config, [fixture.checkout], fixture.secret);
  const handler = createPolicyHttp(service, { token: "test-policy-token" });
  const server = createServer((req, res) => { void handler(req, res, new URL(req.url!, `http://${req.headers.host}`)).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Cookie: "ebi_auth=test-policy-token", Origin: url, "Content-Type": "application/json" };
  try {
    const redirect = await fetch(url + "/policies", { redirect: "manual" }); assert.equal(redirect.status, 302);
    const deepLink = await fetch(url + "/policies?policy=v1", { redirect: "manual" });
    assert.equal(new URL(deepLink.headers.get("location")!, url).searchParams.get("returnTo"), "/policies?policy=v1");
    assert.equal(loginReturnTo("/policies?policy=v1&returnTo=https://another.invalid"), "/");
    assert.equal(loginReturnTo("/policies?policy=v1&policy=v2"), "/");
    assert.equal((await fetch(url + "/api/policies")).status, 401);
    const page = await fetch(url + "/policies", { headers }); assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store"); assert.match(await page.text(), /実行設定の比較/);
    const input = { requestId: randomUUID(), expectedSha256: (await service.list()).sha256 };
    const post = (data: unknown, custom = headers) => fetch(url + "/api/policies/v1/approve", {
      method: "POST", headers: custom, body: JSON.stringify(data) });
    assert.equal((await post(input, { ...headers, Origin: "http://another.invalid" })).status, 403);
    assert.equal((await post({ ...input, reportPath: fixture.config.candidates[0].report.path })).status, 409);
    assert.equal((await post({ ...input, expectedSha256: "0".repeat(64) })).status, 409);
    assert.equal((await post(input)).status, 200); assert.equal((await service.list()).activeId, null);
    assert.equal((await post(input)).status, 200); assert.equal((await service.list()).history.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(fixture.directory, { recursive: true, force: true }); }
});
