import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";
import { inspectTaskExecutionOwner } from "../src/server/orchestration/taskExecutionOwner.ts";
import { executeVaultRun, prepareVaultRun, submitVaultRun } from "../src/server/orchestration/vaultTaskExecution.ts";
import type { VaultRunConfig } from "../src/server/orchestration/vaultRunConfig.ts";

// Local protocol fixture, not a model or a subscription request. Exercising the
// normal runner catches gaps between its provider, verification and lease paths.
const appServer = String.raw`
using System;using System.IO;using System.Collections.Generic;using System.Web.Script.Serialization;
class Fixture {
 static JavaScriptSerializer json=new JavaScriptSerializer();
 static void Send(object message){Console.WriteLine(json.Serialize(message));Console.Out.Flush();}
 static Dictionary<string,object> Obj(object value){return (Dictionary<string,object>)value;}
 static void Main(string[] args){
  if(args.Length>0&&args[0]=="login"){Console.WriteLine("Logged in using ChatGPT");return;}
  string model=null,thread=null,line;
  while((line=Console.ReadLine())!=null){
   var message=Obj(json.DeserializeObject(line));if(!message.ContainsKey("id"))continue;
   string method=(string)message["method"];var p=Obj(message["params"]);object result;
   switch(method){
    case "initialize":result=new {userAgent="contained-fixture"};break;
    case "account/read":result=new {account=new {type="chatgpt"},requiresOpenaiAuth=true};break;
    case "model/list":result=new {data=new object[]{
     new {model="gpt-6-astra",supportedReasoningEfforts=new[]{new {reasoningEffort="low"}},inputModalities=new[]{"text"}},
     new {model="gpt-6.1-sol",supportedReasoningEfforts=new[]{new {reasoningEffort="low"}},inputModalities=new[]{"text"}}
    },nextCursor=(string)null};break;
    case "thread/start":model=(string)p["model"];thread="thread-"+model;
     if((string)p["sandbox"]!=(model=="gpt-6-astra"?"read-only":"workspace-write"))throw new Exception("sandbox mismatch");
     result=new {thread=new {id=thread},model=model,modelProvider="openai"};break;
    case "turn/start":
     if((string)p["threadId"]!=thread)throw new Exception("thread mismatch");
     string turn="turn-"+model;
     if(model=="gpt-6.1-sol")File.WriteAllText(Path.Combine(Environment.CurrentDirectory,"docs","result.txt"),"fixture complete\n");
     Send(new {id=message["id"],result=new {turn=new {id=turn,status="inProgress"}}});
     Send(new {method="item/completed",@params=new {threadId=thread,turnId=turn,item=new {id="final",type="agentMessage",phase="final_answer",text=model=="gpt-6-astra"?"Write the scoped result and run the configured check.":"Scoped result written."}}});
     Send(new {method="turn/completed",@params=new {threadId=thread,turn=new {id=turn,status="completed"}}});continue;
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

test("normal Vault Astra to Sol execution persists all Job receipts before settling its lease",
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
        note("SPEC-ONE", "Spec", "Only write docs/result.txt.", "required: true\n"));
      const contract = { objective: "Write a local fixture result", in_scope: ["Write docs/result.txt"],
        out_of_scope: ["No external effects"], allowed_paths: ["docs/result.txt"], invariants: ["Preserve base.txt"],
        acceptance: ["The scoped result is complete"], verification: ["check result"], escalation: ["Stop on scope drift"],
        base_sha: head, max_attempts: 1, time_limit_minutes: 1 };
      await writeFile(join(vault, "80_Tasks", "task.md"), note("TASK-ONE", "Task",
        "# Task\n\n```negi-task-contract\n" + JSON.stringify(contract) + "\n```",
        "depends_on:\n  - SPEC-ONE\napproval_ref: user:fixture\n"));
      const snapshot = join(root, "contract.json");
      const exporter = fileURLToPath(new URL("../scripts/negi_task_contract.py", import.meta.url));
      execFileSync("python", [exporter, "--vault", vault, "--id", "TASK-ONE", "--project", "negi", "--out", snapshot],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const source = join(root, "Fixture.cs"), executable = join(root, "Fixture.exe");
      await writeFile(source, appServer);
      const compiler = join(process.env.WINDIR!, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
      execFileSync(compiler, ["/nologo", "/target:exe", "/reference:System.Web.Extensions.dll", `/out:${executable}`, source],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const config: VaultRunConfig = { executable, checkout, vault, snapshot, outputDir,
        schedulerPath: join(root, "scheduler.jsonl"), runId: "contained-vault", resources: ["fixture:checkout"],
        astra: { model: "gpt-6-astra", effort: "low" }, sol: { model: "gpt-6.1-sol", effort: "low" },
        verification: [{ requirement: "check result", program: process.execPath,
          args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('docs/result.txt','utf8'),'fixture complete\\n')"],
          timeoutMs: 5000 }] };
      const prepared = await prepareVaultRun(config), scheduler = new FileScheduler(config.schedulerPath);
      await submitVaultRun(prepared, scheduler);
      const task = await executeVaultRun(prepared, scheduler);
      assert.equal(task.status, "ready_for_review"); assert.equal(task.acceptedBy, null);
      assert.deepEqual(task.attempts.map(a => [a.role, a.state]), [["astra", "completed"], ["sol", "completed"]]);
      assert.equal(task.verification?.outcome, "passed");
      assert.equal((await scheduler.read()).state!.entries[0].status, "verified");
      assert.equal(git(["rev-parse", "HEAD"]), head);
      assert.equal(await readFile(join(checkout, "docs", "base.txt"), "utf8"), "fixture\n");
      const owner = await inspectTaskExecutionOwner(outputDir, config.runId, prepared.executionConfigSha256!, `${config.runId}:dispatch`);
      assert.equal(owner.status, "finished"); assert.equal(owner.jobExit, "confirmed"); assert.equal(owner.guardPresent, false);
      const events = (await readFile(join(outputDir, "execution-children.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const exits = events.filter(e => e.kind === "exited");
      assert.deepEqual(exits.map(e => e.role).sort(), ["astra", "sol", "verification-0", "verification-1"]);
      for (const exit of exits) {
        const start = events.find(e => e.kind === "started" && e.role === exit.role);
        assert.equal(exit.tree.id, start.tree.id); assert.equal(exit.tree.rootPid, start.pid);
        assert.equal(exit.tree.activeProcesses, 0);
        assert.throws(() => process.kill(start.pid, 0));
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
