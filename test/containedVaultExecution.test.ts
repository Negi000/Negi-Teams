import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { inspectTaskExecutionOwner } from "../src/server/orchestration/taskExecutionOwner.ts";
import { executeVaultRun, prepareVaultRun, submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";
import { RESEARCH_DISABLED_FEATURES } from "../src/server/master/researchToolPolicy.ts";

// Local protocol fixture, not a model or a subscription request. Exercising the
// normal runner catches gaps between its provider, verification and lease paths.
const appServer = String.raw`
using System;using System.IO;using System.Collections.Generic;using System.Web.Script.Serialization;
class Fixture {
 const bool ReadOnly=false;
 static readonly string[] Disabled=__FEATURES__;
 static JavaScriptSerializer json=new JavaScriptSerializer();
 static void Send(object message){Console.WriteLine(json.Serialize(message));Console.Out.Flush();}
 static Dictionary<string,object> Obj(object value){return (Dictionary<string,object>)value;}
 static void Complete(string thread,string model){
  string turn="turn-"+model;
  Send(new {method="item/completed",@params=new {threadId=thread,turnId=turn,item=new {id="final",type="agentMessage",phase="final_answer",text=ReadOnly?"Finding docs/base.txt:1 fixture; no changes.":model=="gpt-6-astra"?"Write the scoped result and run the configured check.":"Scoped result written."}}});
  Send(new {method="turn/completed",@params=new {threadId=thread,turn=new {id=turn,status="completed"}}});
 }
 static void Main(string[] args){
  if(args.Length>0&&args[0]=="login"){Console.WriteLine("Logged in using ChatGPT");return;}
  if(args.Length>0&&args[0]=="--version"){Console.WriteLine(File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"new-version"))?"codex-cli 0.161.0":"codex-cli 0.160.0");return;}
  if(ReadOnly)foreach(var feature in Disabled){bool found=false;for(int i=0;i<args.Length-1;i++)if(args[i]=="--disable"&&args[i+1]==feature)found=true;if(!found)throw new Exception("tool-bearing feature inherited");}
  string model=null,thread=null,line;int denied=0;
  while((line=Console.ReadLine())!=null){
   var message=Obj(json.DeserializeObject(line));if(!message.ContainsKey("id"))continue;
   if(!message.ContainsKey("method")){
    if(!ReadOnly||!message.ContainsKey("result")||(string)Obj(message["result"])["decision"]!="decline")throw new Exception("Read-only escalation was not denied");
    denied++;if(denied==2)Complete(thread,model);continue;
   }
   string method=(string)message["method"];var p=Obj(message["params"]);object result;
   File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"methods.log"),method+"\n");
   switch(method){
    case "initialize":result=new {userAgent="contained-fixture"};break;
    case "account/read":result=new {account=new {type="chatgpt"},requiresOpenaiAuth=true};break;
    case "config/read":var features=new Dictionary<string,object>();foreach(var feature in Disabled)features[feature]=false;
     result=new {config=new {web_search="disabled",mcp_servers=new Dictionary<string,object>(),features=features},origins=new {},layers=(object)null};break;
    case "mcpServerStatus/list":result=new {data=new object[]{},nextCursor=(string)null};break;
    case "model/list":result=new {data=new object[]{
     new {model="gpt-6-astra",supportedReasoningEfforts=new[]{new {reasoningEffort="low"}},inputModalities=new[]{"text"}},
     new {model="gpt-6.1-sol",supportedReasoningEfforts=new[]{new {reasoningEffort="low"}},inputModalities=new[]{"text"}},
     new {model="gpt-6-luna",supportedReasoningEfforts=new[]{new {reasoningEffort="low"}},inputModalities=new[]{"text"}}
    },nextCursor=(string)null};break;
    case "thread/start":model=(string)p["model"];thread="thread-"+model;
     if((string)p["sandbox"]!=(model=="gpt-6.1-sol"?"workspace-write":"read-only"))throw new Exception("sandbox mismatch");
     if(ReadOnly){if((string)p["approvalPolicy"]!="never"||(bool)Obj(Obj(p["config"])["sandbox_read_only"])["network_access"])throw new Exception("research policy mismatch");
      result=new {thread=new {id=thread},model=model,modelProvider="openai",approvalPolicy="never",sandbox=new {type="readOnly",networkAccess=false}};
     }else result=new {thread=new {id=thread},model=model,modelProvider="openai"};break;
    case "turn/start":
     if((string)p["threadId"]!=thread)throw new Exception("thread mismatch");
     string turn="turn-"+model;
     if(model=="gpt-6.1-sol")File.WriteAllText(Path.Combine(Environment.CurrentDirectory,"docs","result.txt"),"fixture complete\n");
     Send(new {id=message["id"],result=new {turn=new {id=turn,status="inProgress"}}});
     if(ReadOnly){
      Send(new {method="turn/started",@params=new {threadId=thread,turn=new {id=turn,status="inProgress"}}});
      Send(new {id="file",method="item/fileChange/requestApproval",@params=new {threadId=thread,turnId=turn,itemId="write-1",grantRoot=Environment.CurrentDirectory}});
      Send(new {id="command",method="item/commandExecution/requestApproval",@params=new {threadId=thread,turnId=turn,itemId="write-2",command="write protected file",cwd=Environment.CurrentDirectory}});
     }else Complete(thread,model);continue;
    default:throw new Exception("unexpected method "+method);
   }
   Send(new {id=message["id"],result=result});
  }
 }
}`;

function note(id: string, kind: string, body: string, extra = "") {
  return `---\nid: ${id}\nkind: ${kind}\nproject: negi\nscope: project\nstatus: active\n` +
    `version: 1\nupdated: 2026-10-02\nsensitivity: local\nsource_refs:\n  - user:fixture\n${extra}---\n${body}\n`;
}

for(const research of [false,true])test(research?"Vault Astra to Luna is read-only, automatically denies escalation and persists every native exit":"normal Vault Astra to Sol execution persists all Job receipts before settling its lease",
  { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "negi-contained-vault-"));
    try {
      const checkout = join(root, "checkout"), vault = join(root, "Vault"), outputDir = join(root, "output");
      await mkdir(join(checkout, "docs"), { recursive: true });
      await writeFile(join(checkout, "docs", "base.txt"), "fixture\n");
      const git = (args: string[]) => execFileSync("git", args, { cwd: checkout, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
      git(["init"]); git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
      const head = git(["rev-parse", "HEAD"]);
      await mkdir(join(vault, "10_Projects", "negi"), { recursive: true });
      await mkdir(join(vault, "80_Tasks"));
      await writeFile(join(vault, "10_Projects", "negi", "spec.md"),
        note("SPEC-ONE", "Spec", research?"Read docs/base.txt; no changes.":"Only write docs/result.txt.", "required: true\n"));
      const contract = { objective: research?"Research the local fixture":"Write a local fixture result", in_scope: [research?"Read docs/base.txt":"Write docs/result.txt"],
        out_of_scope: ["No external effects"], allowed_paths: [research?"docs/base.txt":"docs/result.txt"], invariants: ["Preserve base.txt"],
        acceptance: ["The scoped result is complete"], verification: ["check result"], escalation: ["Stop on scope drift"],
        base_sha: head, max_attempts: 1, time_limit_minutes: 1 };
      await writeFile(join(vault, "80_Tasks", "task.md"), note("TASK-ONE", "Task",
        "# Task\n\n```negi-task-contract\n" + JSON.stringify(contract) + "\n```",
        "depends_on:\n  - SPEC-ONE\napproval_ref: user:fixture\n"+(research?"task_class: read_only_research\n":"")));
      const snapshot = join(root, "contract.json");
      const exporter = fileURLToPath(new URL("../scripts/negi_task_contract.py", import.meta.url));
      execFileSync("python", [exporter, "--vault", vault, "--id", "TASK-ONE", "--project", "negi", "--out", snapshot],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const source = join(root, "Fixture.cs"), executable = join(root, "Fixture.exe");
      const fixtureSource=appServer.replace("__FEATURES__","new string[]{"+RESEARCH_DISABLED_FEATURES.map(name=>JSON.stringify(name)).join(",")+"}");
      await writeFile(source, research?fixtureSource.replace("const bool ReadOnly=false","const bool ReadOnly=true"):fixtureSource);
      const compiler = join(process.env.WINDIR!, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
      execFileSync(compiler, ["/nologo", "/target:exe", "/reference:System.Web.Extensions.dll", `/out:${executable}`, source],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const config: VaultRunConfig = { executable, checkout, vault, snapshot, outputDir,
        schedulerPath: join(root, "scheduler.jsonl"), runId: "contained-vault", resources: ["fixture:checkout"],
        astra: { model: "gpt-6-astra", effort: "low" },
        ...(research?{taskMode:"read_only_research" as const,luna:{model:"gpt-6-luna",effort:"low"}}:{sol:{model:"gpt-6.1-sol",effort:"low"}}),
        verification: [{ requirement: "check result", program: process.execPath,
          args: ["-e", research?"require('node:assert/strict').equal(require('node:fs').readFileSync('docs/base.txt','utf8'),'fixture\\n')":"require('node:assert/strict').equal(require('node:fs').readFileSync('docs/result.txt','utf8'),'fixture complete\\n')"],
          timeoutMs: 5000 }] };
      const prepared = await prepareVaultRun(config), scheduler = new FileScheduler(config.schedulerPath);
      await submitVaultRun(prepared, scheduler);
      const cache = join(root, "context-cache");
      const task = await executeVaultRun(prepared, scheduler, undefined, {
        contextCacheDirectory: cache, onApproval: () => { throw new Error("unexpected approval"); },
        verifyApproval: async () => false });
      assert.equal(task.status, "ready_for_review"); assert.equal(task.acceptedBy, null);
      assert.deepEqual(task.attempts.map(a => [a.role, a.state]), [["astra", "completed"], [research?"luna":"sol", "completed"]]);
      assert.deepEqual(Object.keys(task.contract.contextPacks!).sort(),["astra",research?"luna":"sol"]);
      if(research){assert.equal(git(["status","--porcelain","--untracked-files=all"]),"");
        const evidence=JSON.parse(await readFile(join(outputDir,"verification.json"),"utf8"));
        assert.equal(evidence.taskMode,"read_only_research");assert.equal(evidence.cleanAtStart,true);assert.equal(evidence.cleanAtEnd,true);}
      assert.equal(task.verification?.outcome, "passed");
      assert.equal((await readFile(join(cache, "cache-signing-key"))).length, 32);
      const namespace = (await readdir(cache)).find(name => /^[0-9a-f]{64}$/.test(name))!;
      const entries = await readdir(join(cache, namespace));
      assert.equal(entries.filter(name => name.startsWith("l2-")).length, 2);
      assert.equal((await scheduler.read()).state!.entries[0].status, "verified");
      assert.equal(git(["rev-parse", "HEAD"]), head);
      assert.equal(await readFile(join(checkout, "docs", "base.txt"), "utf8"), "fixture\n");
      const owner = await inspectTaskExecutionOwner(outputDir, config.runId, prepared.executionConfigSha256!, `${config.runId}:dispatch`);
      assert.equal(owner.status, "finished"); assert.equal(owner.jobExit, "confirmed"); assert.equal(owner.guardPresent, false);
      const events = (await readFile(join(outputDir, "execution-children.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const exits = events.filter(e => e.kind === "exited");
      assert.deepEqual(exits.map(e => e.role).sort(), ["astra", research?"luna":"sol", "verification-0", "verification-1"]);
      for (const exit of exits) {
        const start = events.find(e => e.kind === "started" && e.role === exit.role);
        assert.equal(exit.tree.id, start.tree.id); assert.equal(exit.tree.rootPid, start.pid);
        assert.equal(exit.tree.activeProcesses, 0);
        assert.throws(() => process.kill(start.pid, 0));
      }
      if(research){
        const countTurns=async()=>{const log=await readFile(join(root,"methods.log"),"utf8");return log.split("\n").filter(m=>m==="thread/start"||m==="turn/start").length};
        const initialCalls=await countTurns();assert.equal(initialCalls,4);
        const newer=await prepareVaultRun({...config,runId:"newer-version",outputDir:join(root,"newer-output")});
        await submitVaultRun(newer,scheduler);await writeFile(join(root,"new-version"),"fixture\n");
        await assert.rejects(executeVaultRun(newer,scheduler),/tool-authority compatibility/);
        assert.equal(await countTurns(),initialCalls);assert.equal((await scheduler.read()).state!.entries.at(-1)!.status,"failed");
        await unlink(join(root,"new-version"));
        const dirty=await prepareVaultRun({...config,runId:"dirty-after-prepare",outputDir:join(root,"dirty-output")});
        await submitVaultRun(dirty,scheduler);await writeFile(join(checkout,"docs","base.txt"),"changed after prepare\n");
        await assert.rejects(executeVaultRun(dirty,scheduler),/checkout is dirty/);
        assert.equal(await countTurns(),initialCalls);assert.equal((await scheduler.read()).state!.entries.at(-1)!.status,"failed");
        assert.equal((await readdir(dirty.config.outputDir)).includes("run.jsonl"),false);
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
