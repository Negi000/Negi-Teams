import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyConfiguredCheckout } from "../src/server/orchestration/checkoutVerification.ts";
import { TaskExecutionOwner, inspectTaskExecutionOwner } from "../src/server/orchestration/taskExecutionOwner.ts";

const windows=process.platform==="win32",sha="a".repeat(64),run="contained-check",claim=run+":dispatch";
const dead=(pid:number)=>{try{process.kill(pid,0);return false}catch(e){return (e as NodeJS.ErrnoException).code==="ESRCH"}};
async function fixture(operation:(f:{root:string;checkout:string;outputDir:string;baseSha:string;owner:TaskExecutionOwner})=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"negi-check-tree-")),checkout=join(root,"checkout"),outputDir=join(root,"output");
  await mkdir(checkout);await mkdir(join(checkout,"docs"));await writeFile(join(checkout,"docs/base.txt"),"fixture\n");
  const git=(args:string[])=>execFileSync("git",args,{cwd:checkout,windowsHide:true,stdio:["ignore","pipe","pipe"]}).toString().trim();
  git(["init"]);git(["add","."]);git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
  const owner=await TaskExecutionOwner.acquire(outputDir,run,sha,claim);
  try{await operation({root,checkout,outputDir,baseSha:git(["rev-parse","HEAD"]),owner})}finally{await owner.hold();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}
for(const timeout of [false,true])test(timeout?"timed-out verification stops detached children and records termination without passing":
  "verification commands and diff-check each persist an empty-job receipt",{skip:!windows},async()=>fixture(async f=>{
  const childPath=join(f.checkout,"docs/child.txt"),code=`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();writeFileSync(process.argv[1],String(child.pid));${timeout?"setInterval(()=>{},1000)":"process.exit(0)"};`;
  const result=await verifyConfiguredCheckout({...f,runId:run,allowedPaths:["docs"],requiredVerification:["fixture"],
    commands:[{requirement:"fixture",program:process.execPath,args:["-e",code,childPath],timeoutMs:timeout?500:5000}],processOwner:f.owner});
  assert.equal(result.outcome,timeout?"failed":"passed");const pid=Number(await readFile(childPath,"utf8"));assert.equal(dead(pid),true);
  await f.owner.finish();const view=await inspectTaskExecutionOwner(f.outputDir,run,sha,claim);
  assert.equal(view.status,"finished");assert.equal(view.jobExit,"confirmed");assert.equal(view.childPids.length,2);
  const path=join(f.outputDir,"execution-children.jsonl"),bytes=await readFile(path,"utf8"),events=bytes.trim().split("\n").map(line=>JSON.parse(line));
  events.find(e=>e.kind==="exited").tree.rootPid++;
  await writeFile(path,events.map(e=>JSON.stringify(e)).join("\n")+"\n");
  assert.equal((await inspectTaskExecutionOwner(f.outputDir,run,sha,claim)).status,"unknown");
}));

test("revision verification creates and finishes its own durable owner epoch",{skip:!windows},async()=>fixture(async f=>{
  await writeFile(join(f.checkout,"docs/revision.txt"),"revision fixture\n");
  const result=await verifyConfiguredCheckout({runId:run,checkout:f.checkout,outputDir:f.outputDir,baseSha:f.baseSha,
    allowedPaths:["docs"],requiredVerification:["fixture"],commands:[{requirement:"fixture",program:process.execPath,args:["--version"],timeoutMs:5000}]},undefined,"verification-r1.json");
  assert.equal(result.outcome,"passed");
  const root=join(f.outputDir,"verification-owners","verification-r1.json"),owner=JSON.parse(await readFile(join(root,"execution-owner.json"),"utf8"));
  const view=await inspectTaskExecutionOwner(root,run,owner.configSha256,`${run}:verification-r1.json:verification`);
  assert.equal(view.status,"finished");assert.equal(view.jobExit,"confirmed");assert.equal(view.guardPresent,false);
  assert.equal(view.childPids.length,2);
  const parent=await inspectTaskExecutionOwner(f.outputDir,run,sha,claim);
  assert.equal(parent.status,"live");assert.equal(parent.jobExit,"none");assert.equal(parent.childPids.length,0);
}));
