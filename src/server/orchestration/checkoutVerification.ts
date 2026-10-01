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

const exec = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function verifyConfiguredCheckout(options: {
  runId: string; checkout: string; outputDir: string; baseSha: string;
  allowedPaths: string[]; requiredVerification: string[]; commands: VerificationCommand[];
}, signal?: AbortSignal, outputName = "verification.json") {
  if (outputName !== "command-verification.json" && !/^verification(?:-r[1-9][0-9]?)?\.json$/.test(outputName)) throw Error("Verification output name invalid");
  const checks = [];
  for (const command of [...options.commands,
    { requirement: "git diff --check", program: "git", args: ["diff", "--check"], timeoutMs: 30_000 }]) {
    try {
      const output = await exec(command.program, command.args, { cwd: options.checkout,
        encoding: "utf8", windowsHide: true, timeout: command.timeoutMs, maxBuffer: 1_000_000,
        env: appServerChildEnv(), signal });
      checks.push({ requirement: command.requirement, program: command.program, args: command.args,
        passed: true, outputSha256: hash(output.stdout), stderrSha256: hash(output.stderr) });
    } catch {
      checks.push({ requirement: command.requirement, program: command.program, args: command.args,
        passed: false, outputSha256: null, stderrSha256: null });
    }
  }
  const paths = changedGitPaths(options.checkout), foreign = pathsOutsideScope(paths, options.allowedPaths);
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: options.checkout, windowsHide: true })).stdout.trim();
  const baseMatches = head.toLowerCase() === options.baseSha.toLowerCase();
  const passed = !signal?.aborted && paths.length > 0 && !foreign.length && baseMatches && checks.every(c => c.passed);
  const bytes = Buffer.from(JSON.stringify({ runId: options.runId, baseSha: options.baseSha,
    baseMatches, changedPaths: paths, outsideScope: foreign, requiredVerification: options.requiredVerification,
    checks, stoppedDuringVerification: signal?.aborted ?? false, mechanicalChecksPassed: passed, humanAcceptance: null,
    note: "Command exit status and path scope only; human review must assess the Task acceptance criteria." }, null, 2) + "\n");
  const path = join(options.outputDir, outputName), file = await open(path, "wx");
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { outcome: passed ? "passed" as const : "failed" as const, evidenceRef: `${path}#sha256=${hash(bytes)}` };
}
