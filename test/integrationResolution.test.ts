import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setup, origin, planner, git } from "./helpers/taskAuthoringFixture.ts";
import { captureIntegrationResolution, IntegrationResolutionPlanLimitError } from "../src/server/orchestration/integrationResolution.ts";
import { LocalTaskAuthoringService } from "../src/server/orchestration/taskAuthoring.ts";
import { LocalTaskService } from "../src/server/orchestration/taskService.ts";
import { LocalReviewService } from "../src/server/orchestration/reviewService.ts";
import { registeredTaskTools } from "../src/server/orchestration/taskDispatchTools.ts";
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import type { VerificationCommand } from "../src/server/orchestration/vaultRunConfig.ts";

test("source union rejects unregistrable limits before approval and normalizes shared resources",async()=>{
  const f=await setup();try{
    const profile=f.authoring.integrationConfiguration().profiles[0],baseSha=git(f.repo,["rev-parse","HEAD"]);
    const spec={id:"NT-SPEC-FIXTURE",version:1,sha256:"b".repeat(64)};
    let checks:VerificationCommand[][]=[[],[]],resources:string[][]=[[],[]],content="Fixed original",
      conditions=[["Retain first"],["Retain second"]];
    let references=[[spec],[spec]],filePaths=[["docs/base.txt"],["docs/base.txt"]];
    const command=(i:number):VerificationCommand=>({requirement:"check-"+i,program:process.execPath,args:["--version"],timeoutMs:1000});
    // Trusted reader doubles isolate config-union boundaries. The next test uses real stored sources.
    const tasks={registeredScheduler:()=>({read:async()=>({state:{entries:["first","second"].map(id=>({work:{id},status:"verified",evidenceRef:"fixture:checks"}))}})}),
      knowledgeSource:async()=>({project:"fixture"}),verifyIntegrationContract:async()=>undefined,list:()=>["first","second"].map(id=>({id,title:id})),
      integrationArtifact:async()=>({id:"review",content,artifactSha256:"c".repeat(64)}),
      integrationSource:async(id:string)=>{const i=id==="first"?0:1;return{config:{...f.config,verification:checks[i],resources:resources[i]},configSha256:"d".repeat(64),
        readState:async()=>({status:"ready_for_review",verification:{outcome:"passed",evidenceRef:"fixture:checks"},contract:{vaultId:id,version:1,
          baseSha,sha256:"e".repeat(64),acceptance:conditions[i],sourceNotes:references[i],invariants:[],scope:{out:[]}}}),
        readManifest:async()=>({baseSha,files:filePaths[i].map(path=>({path,sha256:null})),review:{id:"review",verifiedArtifactSha256:"c".repeat(64)}})}}} as unknown as LocalTaskService;
    const before=await readdir(join(f.root,"authoring","approvals"));
    checks=[Array.from({length:5},(_,i)=>command(i)),Array.from({length:4},(_,i)=>command(i+5))];
    assert.equal((await captureIntegrationResolution(profile,tasks,["first","second"])).verification.length,10);
    checks[1].push(command(9));await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/configuration limits/);
    checks=[[],[]];resources=[Array.from({length:10},(_,i)=>"r"+i),Array.from({length:10},(_,i)=>"r"+(i+10))];
    assert.equal((await captureIntegrationResolution(profile,tasks,["first","second"])).resources.length,20);
    resources[1].push("r20");await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/configuration limits/);
    resources=[["GPU"],["gpu"]];assert.deepEqual((await captureIntegrationResolution(profile,tasks,["first","second"])).resources,["GPU"]);
    conditions=[Array.from({length:10},(_,i)=>"condition "+i),Array.from({length:10},(_,i)=>"condition "+(i+10))];
    assert.equal((await captureIntegrationResolution(profile,tasks,["first","second"])).sources.flatMap(s=>s.acceptance).length,20);
    conditions[1].push("condition 20");await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/new contract limits/);
    conditions=[["x".repeat(301)],["Retain second"]];await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/new contract limits/);
    conditions=[["Retain first"],["Retain second"]];
    filePaths=[Array.from({length:10},(_,i)=>"docs/f"+i),Array.from({length:11},(_,i)=>"docs/f"+(i+9))];
    assert.equal((await captureIntegrationResolution(profile,tasks,["first","second"])).paths.length,20);
    filePaths[1].push("docs/f20");await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/new contract limits/);
    filePaths=[["docs/base.txt"],["docs/base.txt"]];
    references=[Array.from({length:25},(_,i)=>({...spec,id:"S"+i})),Array.from({length:25},(_,i)=>({...spec,id:"S"+(i+25)}))];
    assert.equal((await captureIntegrationResolution(profile,tasks,["first","second"])).sources.flatMap(s=>s.references).length,50);
    references[1].push({...spec,id:"S50"});await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/new contract limits/);
    references=[[spec],[{...spec,version:2}]];await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/different fixed versions/);
    references=[[spec],[spec]];
    checks=[[command(0)],[{...command(0),args:["different"]}]];
    await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/different fixed commands/);
    checks=[[],[]];content="x".repeat(8001);await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/Context Pack budget/);
    content="Fixed original";filePaths=[["docs/a.txt"],["docs/b.txt"]];await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/existing integration/);
    await assert.rejects(captureIntegrationResolution(profile,tasks,["first","first"]),/distinct code Tasks/);
    const limited=registeredTaskTools(f.tasks,origin.masterId,{planner,service:{readIntegrationResolution:async()=>{
      throw new IntegrationResolutionPlanLimitError("fixed source limit");}} as unknown as LocalTaskAuthoringService});
    const response=await limited.invoke({threadId:origin.threadId,turnId:origin.turnId,callId:"limit",tool:"negi_read_integration_sources",
      arguments:{profile_id:"docs-project",source_run_ids:["first","second"]}});
    assert.equal(response.success,false);assert.equal(JSON.parse(response.text).nextAction,"decompose_and_review");
    assert.equal(JSON.parse(response.text).nextTool,undefined);assert.match(JSON.parse(response.text).error,/成果を分けて計画/);
    git(f.repo,["mv","docs/base.txt","docs/renamed.txt"]);
    await assert.rejects(captureIntegrationResolution(profile,tasks,["first","second"]),/metadata changes/);
    assert.deepEqual(await readdir(join(f.root,"authoring","approvals")),before);assert.deepEqual(f.calls(),{astra:0,sol:0});
  }finally{await f.close()}
});

async function settled(tasks:LocalTaskService,id:string){const deadline=Date.now()+120_000;for(;;){const v=await tasks.snapshot(id);
  if(!v.live&&v.status!=="queued")return v;assert.ok(Date.now()<deadline,"Fixture Task did not settle");await new Promise(r=>setTimeout(r,40))}}

test("fixed conflicting code results become an explicit single-Sol contract, verified review and restored source guard",async()=>{
  const originals=["export const sum=(a,b)=>a+b;\nexport const product=(a,b)=>a*b;\n// ORIGINAL_A\n",
    "export function sum(a,b){return [a,b].reduce((n,x)=>n+x,0)}\nexport function product(a,b){return [a,b].reduce((n,x)=>n*x,1)}\n// ORIGINAL_B\n"];
  const combined="export const sum=(a,b)=>a+b;\nexport function product(a,b){return [a,b].reduce((n,x)=>n*x,1)}\n// RESOLVED\n";
  let sabotageCheckout:string|undefined;
  const f=await setup(()=>[{requirement:"runtime available",program:process.execPath,timeoutMs:5000,
    args:["--input-type=module","-e","import('./docs/shared.mjs').then(m=>{if(m.sum(2,3)!==5||m.product(2,3)!==6)throw Error('calculation failed')})"]}],{
    thread:async prepared=>{if(sabotageCheckout&&prepared.contract.objective==="Resolve the fixed code")await writeFile(join(sabotageCheckout,"docs/shared.mjs"),"changed between thread and turn\n")},
    write:async(prepared,prompt)=>{const index=prepared.contract.objective==="First code"?0:prepared.contract.objective==="Second code"?1:-1;
      if(index<0){assert.match(prompt,/ORIGINAL_A/);assert.match(prompt,/ORIGINAL_B/);assert.match(prompt,/negi-integration-resolution/);
        assert.match(prompt,/統合対象の元成果を固定して解決/);assert.doesNotMatch(prompt,/なし。この契約は独立して実行する/)}
      await writeFile(join(prepared.config.checkout,"docs/shared.mjs"),index<0?combined:originals[index])}
  });
  const reviews=await LocalReviewService.open({storageRoot:join(f.root,"reviews"),writableRoots:[],cases:[]});
  try{
    await f.tasks.connectReviews(reviews);const ids:string[]=[],pins:Array<{checkout:string;diff:string;content:string;reviewId:string}>=[];
    for(let i=0;i<2;i++){
      const draft=await f.authoring.propose("docs-project",{...f.fields,title:"計算の元成果 "+i,objective:i?"Second code":"First code",
        allowedPaths:["docs/shared.mjs"],acceptance:[i?"product(2,3) returns 6":"sum(2,3) returns 5"]},{...origin,callId:"source-"+i});
      const run=await f.authoring.finalize(draft.id,draft.hash,randomUUID()),v=await f.tasks.snapshot(run.runId!);ids.push(v.id);
      await f.tasks.start(v.id,v.configSha256,randomUUID());assert.equal((await settled(f.tasks,v.id)).status,"ready_for_review");
      const source=await f.tasks.integrationSource(v.id),manifest=await source.readManifest!(),artifact=await f.tasks.integrationArtifact(v.id,manifest.review.verifiedArtifactSha256);
      pins.push({checkout:source.config.checkout,diff:git(source.config.checkout,["diff","HEAD"]),content:artifact.content,reviewId:artifact.id});
    }
    const calls=f.calls(),tools=registeredTaskTools(f.tasks,origin.masterId,{service:f.authoring,planner});
    const call=(tool:string,args:unknown,id=tool)=>tools.invoke({threadId:origin.threadId,turnId:origin.turnId,callId:id,tool,arguments:args});
    const read=await call("negi_read_integration_sources",{profile_id:"docs-project",source_run_ids:ids});assert.equal(read.success,true);
    const selection=JSON.parse(read.text);assert.deepEqual(selection.overlappingPaths,["docs/shared.mjs"]);
    for(const pin of pins)assert.ok(selection.sources.some((s:{content:string})=>s.content===pin.content));
    assert.deepEqual(f.calls(),calls);
    const fields={...f.fields,title:"固定成果を解決",objective:"Resolve the fixed code",allowedPaths:selection.paths,
      acceptance:selection.sources.flatMap((s:{acceptance:string[]})=>s.acceptance),implementationPlan:["Read both fixed original code results","Combine sum and product in the one approved file","Run all fixed checks and leave review pending"]};
    const args={profile_id:"docs-project",source_run_ids:ids,source_selection_sha256:selection.hash,task:fields};
    for(const bad of [{...args,source_selection_sha256:"f".repeat(64)},{...args,task:{...fields,acceptance:[fields.acceptance[0]]}},
      {...args,task:{...fields,allowedPaths:["docs"]}},{...args,checkout:f.repo}]){
      const response=await call("negi_propose_resolution_task",bad,randomUUID());assert.equal(response.success,false);
      assert.equal(JSON.parse(response.text).nextTool,"negi_read_integration_sources");
    }
    const proposed=await call("negi_propose_resolution_task",args,"resolve");assert.equal(proposed.success,true);
    assert.equal(JSON.parse((await call("negi_propose_resolution_task",args,"resolve")).text).draftId,JSON.parse(proposed.text).draftId);
    const draft=(await f.authoring.list()).find(v=>v.id===JSON.parse(proposed.text).draftId)!;assert.deepEqual(draft.integrationResolution,selection);
    const originalSpec=await readFile(f.spec,"utf8");await writeFile(f.spec,originalSpec+"\nChanged after selection\n");
    await assert.rejects(f.authoring.readIntegrationResolution("docs-project",ids));await writeFile(f.spec,originalSpec);
    await writeFile(join(pins[0].checkout,"docs/shared.mjs"),"changed before confirmation\n");
    const vaultBefore=await readdir(join(f.vault,"80_Tasks")),treesBefore=await readdir(join(f.root,"worktrees"));
    await assert.rejects(f.authoring.finalize(draft.id,draft.hash,randomUUID()));
    assert.deepEqual(await readdir(join(f.vault,"80_Tasks")),vaultBefore);assert.deepEqual(await readdir(join(f.root,"worktrees")),treesBefore);
    await writeFile(join(pins[0].checkout,"docs/shared.mjs"),originals[0]);
    const approved=await f.authoring.finalize(draft.id,draft.hash,randomUUID()),v=await f.tasks.snapshot(approved.runId!);
    assert.equal(f.tasks.authoringTemplate(v.id).config.taskMode,"integration_resolution");
    assert.equal(JSON.parse(await readFile(join(f.root,"authoring","drafts",draft.id+".json"),"utf8")).schema,"negi-task-plan/2");
    assert.notEqual(v.checkout,pins[0].checkout);assert.equal(git(v.checkout,["status","--porcelain"]),"");assert.equal(v.acceptedBy,null);
    await f.tasks.start(v.id,v.configSha256,randomUUID());const result=await settled(f.tasks,v.id);
    assert.equal(result.status,"ready_for_review");assert.equal(result.verificationOutcome,"passed");assert.equal(result.acceptedBy,null);
    assert.deepEqual(f.calls(),{astra:0,sol:3});assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].role,"sol");
    assert.equal(await readFile(join(result.checkout,"docs/shared.mjs"),"utf8"),combined);
    const reviewed=await reviews.snapshot(result.reviewId!,{includeRelations:false});assert.match(reviewed.content,/RESOLVED/);
    for(let i=0;i<2;i++){assert.equal(git(pins[i].checkout,["diff","HEAD"]),pins[i].diff);assert.equal((await f.tasks.snapshot(ids[i])).acceptedBy,null)}
    assert.equal(git(f.repo,["status","--porcelain"]),"");
    // A source write between thread/start and turn/start must suppress the turn.
    const held=await f.authoring.proposeResolution("docs-project",ids,selection.hash,fields,{...origin,callId:"held-at-turn"});
    const heldRun=await f.authoring.finalize(held.id,held.hash,randomUUID()),beforePrompts=f.prompts.length;
    sabotageCheckout=pins[0].checkout;const h=await f.tasks.snapshot(heldRun.runId!);await f.tasks.start(h.id,h.configSha256,randomUUID());
    const stopped=await settled(f.tasks,h.id);assert.equal(stopped.status,"blocked");assert.equal(f.prompts.length,beforePrompts);assert.equal(stopped.acceptedBy,null);
    const ledger=await new FileTaskLedger(join(f.tasks.authoringTemplate(h.id).config.outputDir,"run.jsonl")).read();
    assert.ok(ledger.events.some(e=>e.action.type==="fail_attempt"&&/before turn\/start/.test(e.action.reason)));
    assert.ok(!ledger.events.some(e=>e.action.type==="provider_unknown"));sabotageCheckout=undefined;
    await writeFile(join(pins[0].checkout,"docs/shared.mjs"),originals[0]);
    // Explicit fixture acceptance lets the real revoke API exercise cancellation;
    // no result is accepted automatically by the resolution flow.
    await reviews.accept(pins[0].reviewId,selection.sources.find((s:{runId:string})=>s.runId===ids[0]).artifactSha256,randomUUID());
    const acceptedSelection=await f.authoring.readIntegrationResolution("docs-project",ids);
    const waiting=await f.authoring.proposeResolution("docs-project",ids,acceptedSelection.hash,fields,{...origin,callId:"restore-guard"});
    const waitingRun=await f.authoring.finalize(waiting.id,waiting.hash,randomUUID());
    const waitingConfig=f.tasks.authoringTemplate(waitingRun.runId!).config;await f.tasks.close();
    // An explicit signed registration can be read without authoring, but cannot
    // run. The ordinary boot then restores authored registrations itself.
    const withoutAuthoring=await LocalTaskService.open({...f.catalog,runs:[...f.catalog.runs,{title:waiting.title,config:waitingConfig}]},f.runtime);
    try{const absentGuard=await withoutAuthoring.snapshot(waitingRun.runId!);assert.equal(absentGuard.canStart,false);
      await assert.rejects(withoutAuthoring.start(absentGuard.id,absentGuard.configSha256,randomUUID()));
    }finally{await withoutAuthoring.close()}
    const recovered=await LocalTaskService.open(f.catalog,f.runtime);try{
      await recovered.connectReviews(reviews);await LocalTaskAuthoringService.open(f.authoringConfig,recovered);const count=f.calls();
      await reviews.revoke(pins[0].reviewId,selection.sources.find((s:{runId:string})=>s.runId===ids[0]).artifactSha256,randomUUID(),"Withdraw fixed source");
      const heldView=await recovered.snapshot(waitingRun.runId!);assert.equal(heldView.canStart,false);
      await assert.rejects(recovered.start(heldView.id,heldView.configSha256,randomUUID()));assert.deepEqual(f.calls(),count);
      assert.equal((await recovered.snapshot(result.id)).status,"ready_for_review");
    }finally{await recovered.close()}
  }finally{await f.close()}
});
