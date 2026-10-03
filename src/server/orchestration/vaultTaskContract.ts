import { withoutControlPlaneEnv } from "../controlPlaneEnv.ts";
// Read-only bridge from the Phase 3 Task export to the single-task runner.
// No process/model is started. The exporter is the semantic validator; this
// bridge rejects a stale source snapshot or a changed/dirty Git checkout.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ContractRef } from "./singleTask.ts";
import { runSingleTask, type SingleTaskRunOptions } from "./singleTaskRunner.ts";
import { selectTaskWorkerProfile } from "./taskProfileSelection.ts";

export interface VaultTaskContract extends ContractRef {
  schemaVersion: "negi-task-contract/1";
  taskClass?: string;
  scope: { in: string[]; out: string[]; allowedPaths: string[] };
  invariants: string[];
  verification: string[];
  escalation: string[];
  limits: { maxAttempts: number; timeLimitMinutes: number };
  sourceNotes: Array<{ id: string; kind: string; version: number; sha256: string; path: string }>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 ||
      !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 1000)) {
    throw new Error(`Task Contract ${name} invalid`);
  }
  return value as string[];
}
function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function plainPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.includes(":") && !path.split("/").some((part) => !part || part === "." || part === "..");
}
function frontmatterField(data: string, key: string): string | null {
  const front = data.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) return null;
  const raw = front.match(new RegExp(`^${key}:[ \\t]*(.*?)\\r?$`, "m"))?.[1]?.trim();
  if (raw === undefined) return null;
  // Match the Vault compiler's supported scalar strings, including server-authored notes.
  if (raw.startsWith('"')) {
    try { const value:unknown=JSON.parse(raw);return typeof value==="string"?value:null; } catch { return null; }
  }
  if (raw.startsWith("'")&&raw.endsWith("'")&&raw.length>=2) return raw.slice(1,-1).replaceAll("''","'");
  return raw;
}

interface CheckoutState { head: string; dirty: boolean }
function bundledScript(name: string): string {
  for (const relativePath of [`../../../scripts/${name}`, `../../../../scripts/${name}`]) {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(`Negi-Teams bundled script is missing: ${name}`);
}
function gitCheckoutState(checkout: string): CheckoutState {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"],
    { cwd: checkout, encoding: "utf8", windowsHide: true, env: withoutControlPlaneEnv() }).trim();
  if (resolve(top).toLowerCase() !== resolve(checkout).toLowerCase()) {
    throw new Error("Task Contract cwd must be the Git checkout root");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"],
    { cwd: checkout, encoding: "utf8", windowsHide: true, env: withoutControlPlaneEnv() }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
    { cwd: checkout, encoding: "utf8", windowsHide: true, env: withoutControlPlaneEnv() }).trim().length > 0;
  return { head, dirty };
}
function currentVaultExport(vault: string, id: string, project: string): unknown {
  const exporter = bundledScript("negi_task_contract.py");
  return JSON.parse(execFileSync("python", [exporter, "--vault", vault,
    "--id", id, "--project", project, "--stdout-json"],
  { encoding: "utf8", windowsHide: true, maxBuffer: 2_000_000,
    env: { ...withoutControlPlaneEnv(), PYTHONIOENCODING: "utf-8" } }));
}
function compileContextPack(vault: string, contract: VaultTaskContract,
                            role: "astra" | "sol" | "luna", maxChars: number, knowledgeProofDirectory?: string,
                            contextCacheDirectory?: string): string {
  const script = bundledScript("negi_vault.py");
  const content = execFileSync("python", [script, "--vault", vault, "pack",
    "--project", contract.project, "--role", role, "--query", contract.objective,
    "--require", contract.vaultId, "--max-chars", String(maxChars), "--stdout",
    ...(contract.taskClass ? ["--task-class", contract.taskClass] : []),
    ...(knowledgeProofDirectory ? ["--knowledge-proof-dir", knowledgeProofDirectory] : []),
    ...(contextCacheDirectory ? ["--cache-dir", contextCacheDirectory] : [])],
  { encoding: "utf8", windowsHide: true, maxBuffer: maxChars * 4 + 4096,
    env: { ...withoutControlPlaneEnv(), PYTHONIOENCODING: "utf-8" } });
  if (content.length > maxChars) throw new Error("Context Pack exceeds configured character limit");
  const match = content.match(/<!-- manifest: (\{[^\r\n]*\}); estimated_tokens=\d+ -->\r?\n?$/);
  const manifest = match ? object(JSON.parse(match[1])) : null;
  if (manifest?.project !== contract.project || manifest.role !== role ||
      manifest.task_class !== (contract.taskClass ?? null) ||
      typeof manifest.compiler_version !== "string" || !Array.isArray(manifest.sources)) {
    throw new Error(`Context Pack manifest invalid for ${role}`);
  }
  const sources = manifest.sources.map(object);
  for (const required of contract.sourceNotes) {
    if (!sources.some((source) => source?.id === required.id && source.version === required.version &&
        source.sha256 === required.sha256 && source.path === required.path &&
        source.fidelity === "full")) {
      throw new Error(`Context Pack missing full required source: ${required.id}`);
    }
  }
  return content;
}
async function artifactDirectory(raw: string, vault: string, checkout: string): Promise<string> {
  const path = resolve(raw);
  const parent = await realpath(dirname(path));
  if (path === vault || inside(vault, path) || path === checkout || inside(checkout, path) ||
      parent === vault || inside(vault, parent) || parent === checkout || inside(checkout, parent)) {
    throw new Error("Task artifacts must be outside Vault and Git checkout");
  }
  await mkdir(path, { recursive: true });
  const actual = await realpath(path);
  if (actual === vault || inside(vault, actual) || actual === checkout || inside(checkout, actual) ||
      (await lstat(path)).isSymbolicLink()) {
    throw new Error("Task artifact directory escaped the approved local output path");
  }
  return actual;
}
async function savePack(directory: string, runId: string, role: "astra" | "sol" | "luna", content: string) {
  const bytes = Buffer.from(content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const runKey = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  const path = join(directory, `context-${runKey}-${role}-${sha256.slice(0, 16)}.md`);
  const handle = await open(path, "wx");
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { path, sha256 };
}
export function changedGitPaths(checkout: string): string[] {
  const tracked = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD"],
    { cwd: checkout, windowsHide: true, env: withoutControlPlaneEnv() }).toString("utf8");
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: checkout, windowsHide: true, env: withoutControlPlaneEnv() }).toString("utf8");
  return [...new Set((tracked + untracked).split("\0").filter(Boolean))].sort();
}
export function pathsOutsideScope(changed: string[], allowedPaths: string[]): string[] {
  return changed.filter((path) => !allowedPaths.some((allowed) =>
    path === allowed || path.startsWith(`${allowed}/`)));
}

export async function loadVaultTaskContract(vaultDirectory: string, snapshotPath: string,
                                             checkoutDirectory: string,
                                             inspectCheckout = gitCheckoutState,
                                             revisionOf?: { baseSha: string; sha256: string }): Promise<VaultTaskContract> {
  const vault = await realpath(resolve(vaultDirectory));
  const snapshotFile = await realpath(resolve(snapshotPath));
  if (snapshotFile === vault || inside(vault, snapshotFile)) {
    throw new Error("Task Contract snapshot must be outside Vault");
  }
  const raw = await readFile(snapshotFile);
  if (raw.length > 2_000_000) throw new Error("Task Contract snapshot too large");
  const data = object(JSON.parse(raw.toString("utf8")));
  const scope = object(data?.scope);
  const limits = object(data?.limits);
  if (data?.schemaVersion !== "negi-task-contract/1" ||
      typeof data.vaultId !== "string" || !data.vaultId ||
      !Number.isSafeInteger(data.version) || (data.version as number) < 1 ||
      typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(data.sha256) ||
      typeof data.project !== "string" || !data.project ||
      (data.taskClass !== undefined && (typeof data.taskClass !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/.test(data.taskClass))) ||
      typeof data.objective !== "string" || !data.objective.trim() ||
      typeof data.baseSha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(data.baseSha) ||
      !scope || !limits || !Array.isArray(data.sourceNotes) || data.sourceNotes.length < 1 ||
      !Number.isSafeInteger(limits.maxAttempts) || !Number.isSafeInteger(limits.timeLimitMinutes)) {
    throw new Error("Task Contract snapshot schema mismatch");
  }
  strings(data.acceptance, "acceptance");
  strings(scope.in, "scope.in");
  strings(scope.out, "scope.out");
  const allowed = strings(scope.allowedPaths, "scope.allowedPaths");
  if (!allowed.every(plainPath)) throw new Error("Task Contract allowed path invalid");
  strings(data.invariants, "invariants");
  strings(data.verification, "verification");
  strings(data.escalation, "escalation");
  if ((limits.maxAttempts as number) < 1 || (limits.maxAttempts as number) > 3 ||
      (limits.timeLimitMinutes as number) < 1 || (limits.timeLimitMinutes as number) > 480) {
    throw new Error("Task Contract limits invalid");
  }
  const sources = data.sourceNotes as unknown[];
  const ids = new Set<string>();
  let taskFound = false;
  for (const entry of sources) {
    const source = object(entry);
    if (!source || typeof source.id !== "string" || !source.id ||
        typeof source.kind !== "string" ||
        !Number.isSafeInteger(source.version) ||
        typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(source.sha256) ||
        typeof source.path !== "string" || !plainPath(source.path) ||
        ids.has(source.id.toLowerCase())) {
      throw new Error("Task Contract source manifest invalid");
    }
    ids.add(source.id.toLowerCase());
    const file = resolve(vault, source.path);
    const actual = await realpath(file);
    if (!inside(vault, actual) || (await lstat(file)).isSymbolicLink()) {
      throw new Error(`Task Contract source path escaped Vault: ${source.id}`);
    }
    const bytes = await readFile(actual);
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
      throw new Error(`Task Contract source changed: ${source.id}`);
    }
    const text = bytes.toString("utf8");
    if (frontmatterField(text, "id") !== source.id ||
        frontmatterField(text, "kind") !== source.kind ||
        frontmatterField(text, "version") !== String(source.version) ||
        frontmatterField(text, "status") !== "active") {
      throw new Error(`Task Contract source metadata changed: ${source.id}`);
    }
    const sourceProject = frontmatterField(text, "project");
    if (sourceProject !== data.project && sourceProject !== "global") {
      throw new Error(`Task Contract source project mismatch: ${source.id}`);
    }
    if (source.id === data.vaultId) {
      taskFound = source.kind === "Task" && source.version === data.version &&
        source.sha256 === data.sha256 &&
        source.path.startsWith("80_Tasks/") &&
        frontmatterField(text, "sensitivity") === "local" &&
        frontmatterField(text, "approval_ref")?.startsWith("user:") === true;
    }
  }
  if (!taskFound) throw new Error("Task Contract active approved Task source missing");
  // Re-export through the Vault parser immediately before dispatch. This also
  // detects newly required notes and edits to the derived JSON itself.
  const current = currentVaultExport(vault, data.vaultId as string, data.project as string);
  if (!isDeepStrictEqual(data, current)) {
    throw new Error("Task Contract snapshot differs from current Vault export");
  }
  const checkout = await realpath(resolve(checkoutDirectory));
  const checkoutState = inspectCheckout(checkout);
  if (checkoutState.head.toLowerCase() !== (data.baseSha as string).toLowerCase()) {
    throw new Error("Task Contract base SHA no longer matches checkout");
  }
  if (revisionOf) {
    if (revisionOf.baseSha !== data.baseSha || revisionOf.sha256 !== data.sha256 ||
        pathsOutsideScope(changedGitPaths(checkout), allowed).length)
      throw new Error("Task revision differs from its original contract or allowed scope");
  } else if (checkoutState.dirty) throw new Error("Task Contract checkout is dirty; use a reviewed isolated checkout");
  return data as unknown as VaultTaskContract;
}

/** Fail-closed entry point for a Vault-backed run; clients remain injected. */
export async function runSingleTaskFromVault(options: Omit<SingleTaskRunOptions, "contract"> & {
  vaultDirectory: string;
  snapshotPath: string;
  maxContextChars?: number;
  knowledgeProofDirectory?: string;
  contextCacheDirectory?: string;
  approvedResearchPolicy?: import("./policyService.ts").ReadOnlyPolicySource;
}) {
  const contract = await loadVaultTaskContract(options.vaultDirectory, options.snapshotPath, options.cwd);
  const research = contract.taskClass === "read_only_research";
  const workerRole = research ? "luna" : "sol";
  if (research ? !options.luna || options.sol !== undefined : !options.sol || options.luna !== undefined)
    throw Error("Vault worker differs from its fixed Task class");
  if (options.approvedResearchPolicy && !research) throw Error("Policy selection requires a read-only research Task");
  if ((await options.ledger.read()).state !== null) throw Error("run ledger already exists; inspect before resuming");
  const workerProfileSelection = options.approvedResearchPolicy ? await selectTaskWorkerProfile(
    options.approvedResearchPolicy, options.luna!.client, options.luna!) : undefined;
  const vault = await realpath(resolve(options.vaultDirectory));
  const checkout = await realpath(resolve(options.cwd));
  let contextCacheDirectory: string | undefined;
  if (options.contextCacheDirectory) {
    const raw = resolve(options.contextCacheDirectory);
    const parent = await realpath(dirname(raw));
    const actual = existsSync(raw) ? await realpath(raw) : join(parent, basename(raw));
    if ((existsSync(raw) && (await lstat(raw)).isSymbolicLink()) ||
        actual === vault || actual === checkout || inside(vault, actual) || inside(actual, vault) ||
        inside(checkout, actual) || inside(actual, checkout))
      throw new Error("Context cache must be separate from Vault and model checkout");
    contextCacheDirectory = raw;
  }
  if (options.knowledgeProofDirectory) {
    const raw = resolve(options.knowledgeProofDirectory), proof = await realpath(raw);
    if ((await lstat(raw)).isSymbolicLink() || proof === vault || inside(vault, proof) ||
        proof === checkout || inside(checkout, proof))
      throw new Error("Knowledge authority must be outside Vault and model checkout");
  }
  const maxChars = options.maxContextChars ?? 16_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000 || maxChars > 64_000) {
    throw new Error("Context Pack character limit invalid");
  }
  const compile = (role: "astra" | "sol" | "luna") => compileContextPack(vault, contract, role, maxChars,
    options.knowledgeProofDirectory, contextCacheDirectory);
  const astraContext = compile("astra");
  const workerContext = compile(workerRole);
  const out = await artifactDirectory(options.artifactDir, vault, checkout);
  const astraPack = await savePack(out, options.runId, "astra", astraContext);
  const workerPack = await savePack(out, options.runId, workerRole, workerContext);
  const runContract: ContractRef = { ...contract, contextPacks: { astra: astraPack, [workerRole]: workerPack },
    ...(workerProfileSelection ? { workerProfileSelection } : {}) };
  const checkpoint=async()=>{
      if(research)await options.beforeWorker?.();else await options.beforeSol?.();
      const current = await loadVaultTaskContract(options.vaultDirectory, options.snapshotPath, options.cwd);
      if (!isDeepStrictEqual(current, contract)) throw new Error("Vault Task Contract changed before worker");
      if (compile("astra") !== astraContext || compile(workerRole) !== workerContext) {
        throw new Error("Context Pack changed before worker");
      }
    };
  return runSingleTask({ ...options, contract: runContract, artifactDir: out,
    ...(workerProfileSelection ? { luna: { ...options.luna!, model: workerProfileSelection.model,
      effort: workerProfileSelection.effort } } : {}),
    astraContext, ...(research ? { lunaContext: workerContext, beforeWorker:checkpoint } : { solContext: workerContext, beforeSol:checkpoint }),
    verify: async (evidence) => {
      try {
        if (!isDeepStrictEqual(currentVaultExport(vault, contract.vaultId, contract.project), contract)) {
          return { outcome: "unknown" as const, evidenceRef: `vault:task-contract-changed-after-${workerRole}` };
        }
        if (compile("astra") !== astraContext || compile(workerRole) !== workerContext) {
          return { outcome: "unknown" as const, evidenceRef: `vault:context-pack-changed-after-${workerRole}` };
        }
        if (gitCheckoutState(checkout).head.toLowerCase() !== contract.baseSha.toLowerCase()) {
          return { outcome: "unknown" as const, evidenceRef: `git:base-sha-changed-after-${workerRole}` };
        }
        const changed = changedGitPaths(checkout);
        const foreign = research ? changed : pathsOutsideScope(changed, contract.scope.allowedPaths);
        if (foreign.length) {
          return { outcome: "failed" as const,
            evidenceRef: `git:outside-allowed-paths:${JSON.stringify(foreign.slice(0, 10))}` };
        }
      } catch {
        return { outcome: "unknown" as const, evidenceRef: "local:contract-or-git-scope-check-failed" };
      }
      return options.verify(evidence);
    },
    turnTimeoutMs: Math.min(options.turnTimeoutMs, contract.limits.timeLimitMinutes * 60_000),
    deadlineAtMs: Math.min(options.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
      Date.now() + contract.limits.timeLimitMinutes * 60_000) });
}
