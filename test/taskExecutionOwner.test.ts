import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskExecutionOwner, inspectTaskExecutionOwner, releaseDeadTaskExecutionGuard } from "../src/server/orchestration/taskExecutionOwner.ts";
const sha="a".repeat(64),run="owner-test",claim=run+":dispatch";
async function fixture(operation:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),"negi-owner-"));try{await operation(root)}finally{await rm(root,{recursive:true,force:true})}}
test("owner stays live until the entire host execution and every recorded child finish",async()=>fixture(async root=>{
  const owner=await TaskExecutionOwner.acquire(root,run,sha,claim);
  assert.equal((await inspectTaskExecutionOwner(root,run,sha,claim)).status,"live");
  await assert.rejects(TaskExecutionOwner.acquire(root,run,sha,claim));
  await owner.launching("sol");await owner.started("sol",process.pid);await owner.exited("sol",process.pid);
  assert.equal((await inspectTaskExecutionOwner(root,run,sha,claim)).status,"live");
  await owner.finish();const ended=await inspectTaskExecutionOwner(root,run,sha,claim);
  assert.equal(ended.status,"finished");assert.equal(ended.guardPresent,false);
  assert.equal((await inspectTaskExecutionOwner(root,run,"b".repeat(64),claim)).status,"unknown");
  await assert.rejects(owner.launching("astra"),/closed/);
}));
test("a launch without a persisted PID keeps its durable guard after failure",async()=>fixture(async root=>{
  const owner=await TaskExecutionOwner.acquire(root,run,sha,claim);await owner.launching("sol");
  await assert.rejects(owner.finish(),/not all exited/);
  const held=await inspectTaskExecutionOwner(root,run,sha,claim);assert.equal(held.status,"unknown");assert.equal(held.guardPresent,true);
  await assert.rejects(releaseDeadTaskExecutionGuard(root,run,sha,claim,held.sha256),/not proven dead/);
}));
test("explicit stale-owner release requires an exact proven-dead owner, and never releases a reused live PID",async()=>fixture(async root=>{
  const child=spawn(process.execPath,["-e","process.exit(0)"],{windowsHide:true});const deadPid=child.pid!;
  await new Promise<void>((resolve,reject)=>{child.on("error",reject);child.on("close",()=>resolve())});
  const owner=await TaskExecutionOwner.acquire(root,run,sha,claim);await owner.hold();
  const data=JSON.parse(await readFile(join(root,"execution-owner.json"),"utf8"));data.pid=deadPid;
  const bytes=JSON.stringify(data)+"\n";await writeFile(join(root,"execution-owner.json"),bytes);await writeFile(join(root,"execution-guard.lock"),bytes);
  const observed=await inspectTaskExecutionOwner(root,run,sha,claim);assert.equal(observed.status,"dead");
  await assert.rejects(releaseDeadTaskExecutionGuard(root,run,sha,claim,"c".repeat(64)),/changed/);
  data.pid=process.pid;const live=JSON.stringify(data)+"\n";await writeFile(join(root,"execution-owner.json"),live);await writeFile(join(root,"execution-guard.lock"),live);
  const reused=await inspectTaskExecutionOwner(root,run,sha,claim);assert.equal(reused.status,"live");
  await assert.rejects(releaseDeadTaskExecutionGuard(root,run,sha,claim,reused.sha256),/not proven dead/);
  await writeFile(join(root,"execution-owner.json"),bytes);await writeFile(join(root,"execution-guard.lock"),bytes);
  await releaseDeadTaskExecutionGuard(root,run,sha,claim,observed.sha256);
  assert.equal((await inspectTaskExecutionOwner(root,run,sha,claim)).guardPresent,false);
}));
