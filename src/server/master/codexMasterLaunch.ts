// Explicit opt-in settings for the read-only Codex chat master.
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CodexAppServerBrainOptions } from "./codexAppServerBrain.ts";
import { boundedAppServerArgs } from "./boundedAppServer.ts";

export interface CodexMasterLaunchSpec {
  model: string | null;
  extraArgs: readonly string[];
}

export function codexMasterLaunchOptions(spec: CodexMasterLaunchSpec,
                                         env: NodeJS.ProcessEnv = process.env):
    CodexAppServerBrainOptions {
  if (env.EBI_CODEX_READ_ONLY_MASTER !== "1")
    throw new Error("Codex chat master requires EBI_CODEX_READ_ONLY_MASTER=1");
  const rawExe = env.EBI_CODEX_APP_SERVER_EXE;
  if (!rawExe || !isAbsolute(rawExe))
    throw new Error("Codex chat master requires an absolute EBI_CODEX_APP_SERVER_EXE");
  const executable = resolve(rawExe);
  let executableExists = false;
  try { executableExists = statSync(executable).isFile(); } catch { /* explicit failure below */ }
  if (!executableExists) throw new Error("Codex App Server executable is not a regular file");
  const effort = env.EBI_CODEX_MASTER_EFFORT;
  if (!spec.model || !effort || !/^[a-z]+$/.test(effort))
    throw new Error("Codex chat master model and EBI_CODEX_MASTER_EFFORT required");
  if (spec.extraArgs.length !== 0)
    throw new Error("Codex read-only chat master does not accept extra CLI arguments");
  const timeoutMs = Number(env.EBI_CODEX_MASTER_TURN_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)
    throw new Error("Codex master turn timeout must be 1000..600000 ms");
  return { executable, args: boundedAppServerArgs(), effort,
    turnTimeoutMs: timeoutMs };
}
