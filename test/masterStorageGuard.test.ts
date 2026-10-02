import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, unlink, link, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { invokeMasterStorage, masterStorageTicket, withMasterStorageGuard } from "../src/server/orchestration/masterStorageGuard.ts";

async function fixture(run: (data: { dir: string; root: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "negi-master-storage-"));
  try { await run({ dir, root: join(dir, "日本語の会話") }); } finally { await rm(dir, { recursive: true, force: true }); }
}
const windows = { skip: process.platform !== "win32" };

test("read-only acquisition never creates a missing authority or guard", windows, async () => fixture(async ({ root }) => {
  await assert.rejects(withMasterStorageGuard(root, async () => { throw Error("must not enter"); }, { createIfMissing: false }));
  await assert.rejects(readFile(root + ".storage-guard-v1.lock"), { code: "ENOENT" });
  await assert.rejects(readFile(root), { code: "ENOENT" });
  await assert.rejects(withMasterStorageGuard(root + ".", async () => { throw Error("must not enter"); }));
  await assert.rejects(readFile(root + "..storage-guard-v1.lock"), { code: "ENOENT" });
}));

test("Node-owned exclusion survives helper exit and preserves an empty sibling before authority creation", windows, async () => fixture(async ({ root, dir }) => {
  let calls = 0;
  await withMasterStorageGuard(root, async () => {
    calls++; const ticket = masterStorageTicket(root); assert.equal(ticket?.pid, process.pid);
    assert.deepEqual(await invokeMasterStorage({ action: "acquire", root }), { notAcquired: true });
    await assert.rejects(unlink(root + ".storage-guard-v1.lock"));
    await assert.rejects(rename(dir, dir + "-swapped"));
    await assert.rejects(readFile(root), { code: "ENOENT" });
    ticket!.root = "mutated copy"; assert.equal(masterStorageTicket(root)?.root, root);
  });
  assert.equal(calls, 1); assert.equal(masterStorageTicket(root), undefined);
  assert.equal((await readFile(root + ".storage-guard-v1.lock")).length, 0);
  await withMasterStorageGuard(root, async () => { calls++; }); assert.equal(calls, 2);
}));

test("same-root calls wait for exact release, while another authority can proceed", windows, async () => fixture(async ({ root, dir }) => {
  let release!: () => void, entered!: () => void;
  const pause = new Promise<void>(accept => { release = accept; }), ready = new Promise<void>(accept => { entered = accept; });
  const order: string[] = [];
  const first = withMasterStorageGuard(root, async () => { order.push("first"); entered(); await pause; order.push("first done"); });
  await ready;
  const second = withMasterStorageGuard(root, async () => { order.push("second"); });
  await withMasterStorageGuard(join(dir, "other"), async () => { order.push("other"); });
  assert.deepEqual(order, ["first", "other"]); release(); await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "other", "first done", "second"]);
}));

test("outer release joins a started nested write even when its caller did not await it", windows, async () => fixture(async ({ root }) => {
  let release!: () => void, entered!: () => void;
  const pause = new Promise<void>(accept => { release = accept; }), ready = new Promise<void>(accept => { entered = accept; });
  let nested!: Promise<void>, outerDone = false;
  const outer = withMasterStorageGuard(root, async () => {
    nested = withMasterStorageGuard(root, async () => { entered(); await pause; }); await ready;
  }).then(() => { outerDone = true; });
  await ready; assert.deepEqual(await invokeMasterStorage({ action: "acquire", root }), { notAcquired: true });
  assert.equal(outerDone, false); release(); await Promise.all([outer, nested]);
  assert.equal(outerDone, true); await withMasterStorageGuard(root, async () => {});
}));

test("foreign parent and malformed tickets cannot release an active Node-owned guard", windows, async () => fixture(async ({ root }) => {
  await withMasterStorageGuard(root, async () => {
    const ticket = masterStorageTicket(root)!;
    await assert.rejects(invokeMasterStorage({ action: "release", ticket: { ...ticket, handles: [...ticket.handles].reverse() } }));
    const child = spawn(process.execPath, ["--import", "tsx", "-e", `import(${JSON.stringify(pathToFileURL(resolve("src/server/orchestration/masterStorageGuard.ts")).href)}).then(async m => {let raw=''; for await(const c of process.stdin)raw+=c; try{await m.invokeMasterStorage({action:'release',ticket:JSON.parse(raw)});process.exitCode=2;}catch{console.log('foreign held');}});`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
    const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept); child.once("error", reject); });
    const timer = setTimeout(() => child.kill(), 5000);child.stdin.end(JSON.stringify(ticket));
    try { assert.equal(await closed, 0); } finally { clearTimeout(timer);child.kill();await closed; }
    assert.equal(output.trim(), "foreign held");
    assert.deepEqual(await invokeMasterStorage({ action: "acquire", root }), { notAcquired: true });
  });
}));

test("termination of the exact Node owner releases native handles without removing the guard file", windows, async () => fixture(async ({ root }) => {
  const module = pathToFileURL(resolve("src/server/orchestration/masterStorageGuard.ts")).href;
  const source = String.raw`import(${JSON.stringify(module)}).then(async m => {let raw='';for await(const c of process.stdin){raw+=c;if(raw.includes('\n'))break;}await m.withMasterStorageGuard(JSON.parse(raw).root,async()=>{console.log('held');await new Promise(()=>{setInterval(()=>{},1000);});});});`;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", source], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();let output = "";
  const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept);child.once("error", reject); });
  const ready = new Promise<void>(accept => { child.stdout.on("data", chunk => { output += chunk;if (output.includes("held")) accept(); }); });
  const timer = setTimeout(() => child.kill(), 5000);child.stdin.write(JSON.stringify({ root }) + "\n");
  try { await Promise.race([ready, closed.then(() => { throw Error("owner closed before admission"); })]);
    await assert.rejects(withMasterStorageGuard(root, async () => { throw Error("must not enter"); }));
  } finally { clearTimeout(timer);child.kill();await closed; }
  await withMasterStorageGuard(root, async () => {});
  assert.equal((await readFile(root + ".storage-guard-v1.lock")).length, 0);
}));

test("CLOSE_SOURCE false status after native close still attempts both validated sources", windows, async () => fixture(async ({ root }) => {
  const module = pathToFileURL(resolve("src/server/orchestration/masterStorageGuard.ts")).href;
  const python = `import json,sys\nsys.path.insert(0,sys.argv[1])\nimport negi_master_storage_guard as m\nticket=json.loads(sys.stdin.buffer.read().decode('utf-8'))\nk=m.native()\noriginal=k.DuplicateHandle\nclosed=[]\ndef injected(*args):\n result=original(*args)\n if args[-1]==1:\n  closed.append(int(args[1]));return 0\n return result\nk.DuplicateHandle=injected\nm.native=lambda:k\nm.release(ticket)\nassert closed==list(map(int,ticket['handles']))\nprint('closed 2')\n`;
  const source = String.raw`import(${JSON.stringify(module)}).then(async m=>{
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);
const ticket=await m.invokeMasterStorage({action:'acquire',root:input.root});if(!ticket.handles)throw Error('acquisition failed');
const child=require('node:child_process').spawn('python',['-B','-c',${JSON.stringify(python)},input.scripts],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-1000);});
const closed=new Promise((accept,reject)=>{child.once('close',accept);child.once('error',reject);});child.stdin.end(JSON.stringify(ticket));
const code=await closed;if(code!==0||output.trim()!=='closed 2')throw Error('close fault not handled: '+code+' '+errors);
const next=await m.invokeMasterStorage({action:'acquire',root:input.root});if(!next.handles)throw Error('sources still held');
await m.invokeMasterStorage({action:'release',ticket:next});console.log('closed 2 and reacquired');
}).catch(error=>{console.error(String(error).slice(0,1000));process.exitCode=1;});`;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", source], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";child.stdout.on("data", chunk => { output += chunk; });child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-1000); });
  const closed = new Promise<number | null>((accept, reject) => { child.once("close", accept);child.once("error", reject); });
  const timer = setTimeout(() => child.kill(), 10000);child.stdin.end(JSON.stringify({ root, scripts: resolve("scripts") }));
  try { assert.equal(await closed, 0, errors);assert.equal(output.trim(), "closed 2 and reacquired"); }
  finally { clearTimeout(timer);child.kill();await closed; }
  await withMasterStorageGuard(root, async () => {});
}));

test("case changes cannot borrow or release a sibling lease", windows, async () => fixture(async ({ dir }) => {
  const root = join(dir, "Root"), other = join(dir, "root");let entered = false;
  await withMasterStorageGuard(root, async () => {
    assert.equal(masterStorageTicket(other), undefined);
    await assert.rejects(withMasterStorageGuard(other, async () => { entered = true; }));
    await assert.rejects(invokeMasterStorage({ action: "release", ticket: { ...masterStorageTicket(root)!, root: other } }));
    assert.deepEqual(await invokeMasterStorage({ action: "acquire", root }), { notAcquired: true });
  });assert.equal(entered, false);
}));

test("distinct roots under a case-sensitive Windows directory keep independent leases", windows, async t => fixture(async ({ dir }) => {
  try { execFileSync("fsutil", ["file", "setCaseSensitiveInfo", dir, "enable"], { windowsHide: true, stdio: "ignore", timeout: 5000 }); }
  catch { t.skip("case-sensitive directory feature unavailable for this owned fixture");return; }
  const root = join(dir, "Root"), other = join(dir, "root");await mkdir(root);await mkdir(other);
  await withMasterStorageGuard(root, async () => {
    assert.equal(masterStorageTicket(other), undefined);
    await withMasterStorageGuard(other, async () => {
      assert.notDeepEqual(masterStorageTicket(root)?.identities, masterStorageTicket(other)?.identities);
      assert.deepEqual(await invokeMasterStorage({ action: "acquire", root }), { notAcquired: true });
      assert.deepEqual(await invokeMasterStorage({ action: "acquire", root: other }), { notAcquired: true });
    });
  });
}));

test("partial guard, hardlink and redirected parent preserve evidence and never enter callback", windows, async () => fixture(async ({ root, dir }) => {
  const path = root + ".storage-guard-v1.lock";let calls = 0;
  await writeFile(path, "partial evidence");await assert.rejects(withMasterStorageGuard(root, async () => { calls++; }));
  assert.equal(await readFile(path, "utf8"), "partial evidence");await unlink(path);
  const retained = join(dir, "retained");await writeFile(retained, "");await link(retained, path);
  await assert.rejects(withMasterStorageGuard(root, async () => { calls++; }));assert.equal(calls, 0);
  await unlink(path);assert.equal((await readFile(retained)).length, 0);
  const actual = join(dir, "actual"), alias = join(dir, "alias");await mkdir(actual);await symlink(actual, alias, "junction");
  await writeFile(join(actual, "keep.txt"), "retained");await assert.rejects(withMasterStorageGuard(join(alias, "conversations"), async () => { calls++; }));
  assert.equal(await readFile(join(actual, "keep.txt"), "utf8"), "retained");assert.equal(calls, 0);
  await withMasterStorageGuard(root, async () => { calls++; });assert.equal(calls, 1);
}));
