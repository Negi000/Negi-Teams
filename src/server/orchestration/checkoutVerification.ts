// Shared mechanical verification of a configured checkout. Commands are trusted
// startup configuration; neither browser input nor model output supplies them.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appServerChildEnv } from "../master/appServerProcess.ts";
import { changedGitPaths, pathsOutsideScope } from "./vaultTaskContract.ts";
import type { VerificationCommand } from "./vaultRunConfig.ts";
import { WindowsProcessTree, resolveWindowsCommand } from "../master/windowsProcessTree.ts";
import { TaskExecutionOwner } from "./taskExecutionOwner.ts";

const exec = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
class UncertainProcessTree extends Error {}
async function containedCheck(command:VerificationCommand,checkout:string,owner:TaskExecutionOwner,index:number,signal?:AbortSignal){
  if(signal?.aborted)return {passed:false,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};
  const role=`verification-${index}` as const,env=appServerChildEnv();
  const executable=await resolveWindowsCommand(command.program,checkout,env);
  await owner.launching(role);
  let tree:WindowsProcessTree|undefined;
  try{tree=await WindowsProcessTree.launch({executable,args:command.args,cwd:checkout,env,trustedRoot:owner.processTreeRoot});
    await owner.started(role,tree.identity.rootPid,tree.identity);
  }catch{try{await tree?.stop()}catch{/* keep an unconfirmed guard */}throw new UncertainProcessTree("Verification process containment startup unconfirmed")}
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let count=0,interrupted=false;
  const stop=()=>{interrupted=true;void tree.stop().catch(()=>{})};
  const collect=(chunks:Buffer[])=>(chunk:Buffer|string)=>{const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);count+=b.length;
    if(count>1_000_000)stop();else chunks.push(b)};
  tree.child.stdout.on("data",collect(stdout));tree.child.stderr.on("data",collect(stderr));
  const timer=setTimeout(stop,command.timeoutMs);signal?.addEventListener("abort",stop,{once:true});if(signal?.aborted)stop();
  try{const result=await tree.exited;if(!result.receipt)throw new UncertainProcessTree("Verification process tree exit unconfirmed");
    await owner.exited(role,tree.identity.rootPid,result.receipt);
    return {passed:!interrupted&&result.receipt.rootCode===0,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)};
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",stop)}
}
interface CheckoutVerificationOptions {
  runId: string; checkout: string; outputDir: string; baseSha: string;
  allowedPaths: string[]; requiredVerification: string[]; commands: VerificationCommand[];
  processOwner?:TaskExecutionOwner;
  /** Explicit research mode; legacy/write callers still require a diff. */
  taskMode?: "read_only_research";
}
export async function verifyConfiguredCheckout(options:CheckoutVerificationOptions, signal?: AbortSignal, outputName = "verification.json") {
  if (outputName !== "command-verification.json" && !/^verification(?:-r[1-9][0-9]?)?\.json$/.test(outputName)) throw Error("Verification output name invalid");
  // Revision/integration callers have distinct scheduler leases. Each gets an
  // immutable owner epoch; they must not silently reuse the main Task's owner.
  const localOwner=process.platform==="win32"&&!options.processOwner?await TaskExecutionOwner.acquire(
    join(options.outputDir,"verification-owners",outputName),options.runId,
    hash(JSON.stringify({runId:options.runId,checkout:options.checkout,baseSha:options.baseSha,
      allowedPaths:options.allowedPaths,requiredVerification:options.requiredVerification,commands:options.commands,
      ...(options.taskMode?{taskMode:options.taskMode}:{})})),
    `${options.runId}:${outputName}:verification`):undefined;
  try{const result=await verifyOwnedCheckout({...options,processOwner:options.processOwner??localOwner},signal,outputName);
    await localOwner?.finish();return result;
  }catch(error){await localOwner?.hold();throw error}
}
async function verifyOwnedCheckout(options:CheckoutVerificationOptions,signal:AbortSignal|undefined,outputName:string){
  const research=options.taskMode==="read_only_research";
  const cleanAtStart=!research||(!changedGitPaths(options.checkout).length&&
    !(await exec("git",["status","--porcelain","--untracked-files=all"],{cwd:options.checkout,windowsHide:true,env:appServerChildEnv()})).stdout.trim());
  const checks = [];
  const commands=[...options.commands,{ requirement: "git diff --check", program: "git", args: ["diff", "--check"], timeoutMs: 30_000 }];
  for (const [index,command] of commands.entries()) {
    try {
      if(options.processOwner&&process.platform==="win32"){
        const output=await containedCheck(command,options.checkout,options.processOwner,index,signal);
        checks.push({requirement:command.requirement,program:command.program,args:command.args,passed:output.passed,
          outputSha256:hash(output.stdout),stderrSha256:hash(output.stderr)});continue;
      }
      const output = await exec(command.program, command.args, { cwd: options.checkout,
        encoding: "utf8", windowsHide: true, timeout: command.timeoutMs, maxBuffer: 1_000_000,
        env: appServerChildEnv(), signal });
      checks.push({ requirement: command.requirement, program: command.program, args: command.args,
        passed: true, outputSha256: hash(output.stdout), stderrSha256: hash(output.stderr) });
    } catch(error) {
      if(error instanceof UncertainProcessTree)throw error;
      checks.push({ requirement: command.requirement, program: command.program, args: command.args,
        passed: false, outputSha256: null, stderrSha256: null });
    }
  }
  const paths = changedGitPaths(options.checkout), foreign = pathsOutsideScope(paths, options.allowedPaths);
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: options.checkout, windowsHide: true, env: appServerChildEnv() })).stdout.trim();
  const baseMatches = head.toLowerCase() === options.baseSha.toLowerCase();
  const cleanAtEnd=!research||(!paths.length&&
    !(await exec("git",["status","--porcelain","--untracked-files=all"],{cwd:options.checkout,windowsHide:true,env:appServerChildEnv()})).stdout.trim());
  const passed = !signal?.aborted && (research ? cleanAtStart&&cleanAtEnd : paths.length > 0) &&
    !foreign.length && baseMatches && checks.every(c => c.passed);
  const bytes = Buffer.from(JSON.stringify({ runId: options.runId, baseSha: options.baseSha,
    baseMatches, changedPaths: paths, outsideScope: foreign, requiredVerification: options.requiredVerification,
    checks, stoppedDuringVerification: signal?.aborted ?? false, mechanicalChecksPassed: passed, humanAcceptance: null,
    ...(research?{taskMode:"read_only_research",cleanAtStart,cleanAtEnd}:{}),
    ...(options.processOwner?{processOwnership:{directory:options.processOwner.root,scope:"Windows Job membership; external brokers are not contained"}}:{}),
    note: "Command exit status and path scope only; human review must assess the Task acceptance criteria." }, null, 2) + "\n");
  const path = join(options.outputDir, outputName), file = await open(path, "wx");
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { outcome: passed ? "passed" as const : "failed" as const, evidenceRef: `${path}#sha256=${hash(bytes)}` };
}
