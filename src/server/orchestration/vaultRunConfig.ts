// Explicit, local configuration for the reusable Vault Task CLI.
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface VerificationCommand {
  requirement: string;
  program: string;
  args: string[];
  timeoutMs: number;
}
export interface VaultRunBase {
  executable: string;
  checkout: string;
  vault: string;
  snapshot: string;
  outputDir: string;
  schedulerPath: string;
  runId: string;
  astra: { model: string; effort: string };
  verification: VerificationCommand[];
  resources: string[];
  /** Server-signed human approval of a resident Astra plan. No new planning turn. */
  approvedPlan?: { proofDirectory: string; requestId: string };
}
export type VaultRunConfig = VaultRunBase & (
  { sol: { model: string; effort: string }; taskMode?: never; luna?: never } |
  { taskMode: "read_only_research"; luna: { model: string; effort: string }; sol?: never }
);
export function vaultWorker(config: VaultRunConfig) {
  return config.taskMode === "read_only_research"
    ? { role: "luna" as const, profile: config.luna, checkoutMode: "read" as const }
    : { role: "sol" as const, profile: config.sol, checkoutMode: "write" as const };
}
export function assertVaultWorkerContract(config: VaultRunConfig, contract: { taskClass?: string }): void {
  if ((config.taskMode === "read_only_research") !== (contract.taskClass === "read_only_research"))
    throw Error("Read-only research requires its explicit Luna configuration and Vault task class");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function path(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 2048) {
    throw new Error(`Vault run ${name} must be an absolute path`);
  }
  return value;
}
function label(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value)) {
    throw new Error(`Vault run ${name} invalid`);
  }
  return value;
}
function role(value: unknown, name: string): { model: string; effort: string } {
  const row = object(value);
  return { model: label(row?.model, `${name}.model`),
    effort: label(row?.effort, `${name}.effort`) };
}

export function parseVaultRunConfig(value: unknown): VaultRunConfig {
  const row = object(value);
  if (!row) throw new Error("Vault run config must be an object");
  // No Sol alias is serialized for a read-only run. Historical parsers require
  // sol and therefore reject this registration rather than grant write access.
  const readOnly = row.taskMode === "read_only_research";
  if (row.lunaPolicy !== undefined || (readOnly ? "sol" in row :
      row.taskMode !== undefined || row.luna !== undefined))
    throw Error("Vault run worker mode invalid or ambiguous");
  const worker = readOnly ? { taskMode: "read_only_research" as const, luna: role(row.luna, "luna") } : { sol: role(row.sol, "sol") };
  if (!Array.isArray(row.verification) || row.verification.length > 10 ||
      !Array.isArray(row.resources) || row.resources.length > 20) {
    throw new Error("Vault run verification/resources invalid");
  }
  const verification = row.verification.map((entry, index) => {
    const command = object(entry);
    if (typeof command?.requirement !== "string" || !command.requirement.trim() ||
        command.requirement.length > 1000 ||
        typeof command?.program !== "string" || !command.program ||
        command.program.length > 2048 || !Array.isArray(command.args) ||
        command.args.length > 30 || !command.args.every((arg) =>
          typeof arg === "string" && arg.length <= 2048) ||
        !Number.isSafeInteger(command.timeoutMs) ||
        (command.timeoutMs as number) < 1 || (command.timeoutMs as number) > 120_000) {
      throw new Error(`Vault run verification[${index}] invalid`);
    }
    return { requirement: command.requirement, program: command.program, args: command.args as string[],
      timeoutMs: command.timeoutMs as number };
  });
  const resources = row.resources.map((item, index) => {
    if (typeof item !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(item)) {
      throw new Error(`Vault run resources[${index}] invalid`);
    }
    return item;
  });
  if (new Set(resources.map((resource) => resource.toLowerCase())).size !== resources.length) {
    throw new Error("Vault run resources repeated");
  }
  let approvedPlan: VaultRunConfig["approvedPlan"];
  if (row.approvedPlan !== undefined) {
    const plan = object(row.approvedPlan);
    if (!plan || Object.keys(plan).length !== 2 || typeof plan.requestId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(plan.requestId))
      throw new Error("Approved Task plan identity invalid");
    approvedPlan = { proofDirectory: path(plan.proofDirectory, "approvedPlan.proofDirectory"), requestId: plan.requestId };
  }
  return { executable: path(row.executable, "executable"),
    checkout: path(row.checkout, "checkout"), vault: path(row.vault, "vault"),
    snapshot: path(row.snapshot, "snapshot"), outputDir: path(row.outputDir, "outputDir"),
    schedulerPath: path(row.schedulerPath, "schedulerPath"),
    runId: label(row.runId, "runId"), astra: role(row.astra, "astra"),
    ...worker, verification, resources, ...(approvedPlan ? { approvedPlan } : {}) };
}

/** A CLI run can only claim mechanical coverage for explicitly mapped contract checks. */
export function assertVerificationCoverage(required: readonly string[],
                                           configured: readonly VerificationCommand[]): void {
  const seen = new Set<string>();
  for (const command of configured) {
    if (!required.includes(command.requirement) || seen.has(command.requirement)) {
      throw new Error(`Vault run verification requirement is unknown or repeated: ${command.requirement}`);
    }
    seen.add(command.requirement);
  }
  if (required.some((requirement) => !seen.has(requirement))) {
    throw new Error("Vault run does not map every Task Contract verification requirement");
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root.toLowerCase(), candidate.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function canonicalDestination(raw: string, kind: "file" | "directory"): Promise<string> {
  const target = resolve(raw);
  let entry: Awaited<ReturnType<typeof lstat>> | null = null;
  try { entry = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entry) {
    if (entry.isSymbolicLink() || (kind === "file" && !entry.isFile()) ||
        (kind === "directory" && !entry.isDirectory())) {
      throw new Error(`Vault run ${kind} destination has an unsafe type: ${target}`);
    }
    return realpath(target);
  }
  return join(await realpath(dirname(target)), basename(target));
}

/** Stable catalog identity, shared by CLI and GUI. Preserve the configured
 * executable spelling for historical request hashes; dereference it only at launch. */
export async function canonicalVaultRunRegistration(raw:VaultRunConfig):Promise<VaultRunConfig>{
  return {...structuredClone(raw),checkout:await realpath(raw.checkout),vault:await realpath(raw.vault),
    outputDir:await canonicalDestination(raw.outputDir,"directory"),schedulerPath:await canonicalDestination(raw.schedulerPath,"file")};
}

/** Reject local logs and generated artifacts inside the model's writable tree. */
export async function assertVaultRunOutputPaths(config: VaultRunConfig): Promise<void> {
  const checkout = await realpath(config.checkout);
  const vault = await realpath(config.vault);
  const output = await canonicalDestination(config.outputDir, "directory");
  const scheduler = await canonicalDestination(config.schedulerPath, "file");
  for (const [label, target] of [["outputDir", output], ["schedulerPath", scheduler]]) {
    if (inside(checkout, target) || inside(vault, target)) {
      throw new Error(`Vault run ${label} must be outside checkout and Vault`);
    }
  }
  if (output.toLowerCase() === scheduler.toLowerCase()) {
    throw new Error("Vault run outputDir and schedulerPath must differ");
  }
}
