import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyConfiguredCheckout } from "../src/server/orchestration/checkoutVerification.ts";

async function fixture(operation:(options:Parameters<typeof verifyConfiguredCheckout>[0])=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"negi-readonly-verify-"));
  try{
    const checkout=join(root,"checkout"),outputDir=join(root,"output");await mkdir(checkout);await mkdir(outputDir);
    await writeFile(join(checkout,"base.txt"),"baseline\n");
    const git=(args:string[])=>execFileSync("git",args,{cwd:checkout,windowsHide:true,stdio:["ignore","pipe","pipe"]}).toString().trim();
    git(["init"]);git(["add","."]);git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
    await operation({runId:"readonly-verification",checkout,outputDir,baseSha:git(["rev-parse","HEAD"]),allowedPaths:["base.txt"],
      requiredVerification:["fixed check"],commands:[{requirement:"fixed check",program:process.execPath,args:["-e","process.exit(0)"],timeoutMs:5000}],
      taskMode:"read_only_research"});
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}

test("only explicit research verifies an unchanged checkout; legacy diff checks remain mandatory",{timeout:30_000},async()=>fixture(async options=>{
  const {taskMode,...legacy}=options;
  assert.equal((await verifyConfiguredCheckout(legacy)).outcome,"failed");
  assert.equal((await verifyConfiguredCheckout(options,undefined,"verification-r1.json")).outcome,"passed");
  const evidence=JSON.parse(await readFile(join(options.outputDir,"verification-r1.json"),"utf8"));
  assert.equal(evidence.taskMode,"read_only_research");assert.deepEqual(evidence.changedPaths,[]);assert.equal(evidence.humanAcceptance,null);
}));

test("a changed allowed file fails read-only verification even when the fixed check removes the change",{timeout:30_000},async()=>fixture(async options=>{
  await writeFile(join(options.checkout,"base.txt"),"mutation\n");
  options.commands[0].args=["-e","require('node:fs').writeFileSync('base.txt','baseline\\n')"];
  assert.equal((await verifyConfiguredCheckout(options)).outcome,"failed");
  const evidence=JSON.parse(await readFile(join(options.outputDir,"verification.json"),"utf8"));
  assert.equal(evidence.cleanAtStart,false);assert.equal(evidence.cleanAtEnd,true);assert.deepEqual(evidence.changedPaths,[]);
}));

test("fixed commands that leave a mutation cannot verify a research result",{timeout:30_000},async()=>fixture(async options=>{
  options.commands[0].args=["-e","require('node:fs').writeFileSync('base.txt','changed\\n')"];
  assert.equal((await verifyConfiguredCheckout(options)).outcome,"failed");
  const evidence=JSON.parse(await readFile(join(options.outputDir,"verification.json"),"utf8"));
  assert.equal(evidence.cleanAtStart,true);assert.equal(evidence.cleanAtEnd,false);assert.deepEqual(evidence.changedPaths,["base.txt"]);
}));

test("a clean but different baseline and an aborted verifier cannot pass research",{timeout:30_000},async()=>fixture(async options=>{
  assert.equal((await verifyConfiguredCheckout({...options,baseSha:"a".repeat(40)})).outcome,"failed");
  assert.equal((await verifyConfiguredCheckout(options,AbortSignal.abort(),"verification-r1.json")).outcome,"failed");
  const evidence=JSON.parse(await readFile(join(options.outputDir,"verification-r1.json"),"utf8"));
  assert.equal(evidence.stoppedDuringVerification,true);assert.equal(evidence.mechanicalChecksPassed,false);
}));
