import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Ticket { schema: "negi-master-storage-guard/1"; root: string; pid: number; startToken: string; handles: string[]; identities: number[][] }
interface Lease { ticket?: Ticket; pending: Set<Promise<unknown>>; done: Promise<void>; finish(): void }
interface Scope { key: string; lease: Lease; active: boolean }
const context = new AsyncLocalStorage<Scope>();
const leases = new Map<string, Lease>();
// Preserve canonical casing: Windows can distinguish names in a directory.
// Noncanonical aliases must acquire independently and fail native validation.
const key = (root: string) => resolve(root);
export class MasterStorageHeldError extends Error {
  constructor(reason = "会話の保存処理が進行中か、保存状態の確認が必要です。") { super(reason); this.name = "MasterStorageHeldError"; }
}
function check(value: unknown): asserts value { if (!value) throw new MasterStorageHeldError(); }

/** Native helpers require system paths, never provider or control-plane secrets. */
export function masterStorageChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => allowed.has(name.toUpperCase())));
}
const helpers = [
  ["negi_recover_writer", "8c329091d17254155780729659a40198a6979785b723a11a3b85f73339c01069"],
  ["negi_master_storage_guard", "005e13946d157bf9a47a90a10ff60efb70d642be2125458d68deb0ff237c82cf"],
] as const;
/** Execute these verified snapshots, never re-open their paths as Python code.
 * Updating either packaged helper requires updating its source fingerprint. */
export async function masterStorageHelperSources(directory: string) {
  return Promise.all(helpers.map(async ([name, sha256]) => {
    const filename = join(directory, name + ".py"), info = await lstat(filename);
    check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 100000);
    const source = (await readFile(filename, "utf8")).replace(/\r\n/g, "\n");
    check(createHash("sha256").update(source).digest("hex") === sha256);
    return { name, filename, source };
  }));
}
const bootstrap = `import json,sys,types
rows=json.loads(sys.stdin.buffer.readline(150001))
for row in rows:
    module=sys.modules["__main__"] if row["name"]=="negi_master_storage_guard" else types.ModuleType(row["name"])
    module.__file__=row["filename"]
    sys.modules[row["name"]]=module
    exec(compile(row["source"],row["filename"],"exec"),module.__dict__)
`;

export function masterStorageTicket(root: string): Ticket | undefined {
  const current = context.getStore();
  return current?.active && current.key === key(root) && leases.get(current.key) === current.lease && current.lease.ticket ? structuredClone(current.lease.ticket) : undefined;
}

export async function invokeMasterStorage(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = JSON.stringify(request) + "\n"; check(Buffer.byteLength(input) <= 24000);
  let filename = fileURLToPath(new URL("../../../scripts/negi_master_storage_guard.py", import.meta.url));
  try { await lstat(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    filename = fileURLToPath(new URL("../../../../scripts/negi_master_storage_guard.py", import.meta.url));
  }
  const sources = JSON.stringify(await masterStorageHelperSources(dirname(filename))) + "\n";
  check(Buffer.byteLength(sources) <= 150000);
  const output = await new Promise<string>((accept, reject) => {
    const child = spawn("python", ["-I", "-B", "-c", bootstrap], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: masterStorageChildEnv() });
    let stdout = "", size = 0, failure: Error | null = null;
    const timer = setTimeout(() => { failure = new MasterStorageHeldError(); child.kill(); }, 10000);
    child.stdout.setEncoding("utf8");child.stderr.resume();
    child.stdout.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 24000) { failure = new MasterStorageHeldError(); child.kill(); } else stdout += chunk; });
    child.on("error", error => { failure = error; });child.stdin.on("error", error => { failure ??= error; });
    child.on("close", code => { clearTimeout(timer); if (failure || code !== 0) reject(failure ?? new MasterStorageHeldError()); else accept(stdout); });
    child.stdin.end(sources + input);
  });
  const result: unknown = JSON.parse(output);
  check(result && typeof result === "object" && !Array.isArray(result) && JSON.stringify(result) + "\n" === output);
  return result as Record<string, unknown>;
}

async function nested<T>(scope: Scope, run: () => Promise<T>): Promise<T> {
  const child: Scope = { ...scope, active: true };
  const pending = context.run(child, run);scope.lease.pending.add(pending);
  try { return await pending; } finally { child.active = false;scope.lease.pending.delete(pending); }
}

/** One operation, including started nested writes. No callback retry. Parent-owned
 * native handles outlive helper exit; ambiguous acquisition/release keeps this
 * process registration held (not a guarantee all native handles remain open). */
export async function withMasterStorageGuard<T>(root: string, run: () => Promise<T>, options: { createIfMissing?: boolean } = {}): Promise<T> {
  check(isAbsolute(root)); const canonical = resolve(root), registered = key(canonical);
  const current = context.getStore();
  if (current?.active && current.key === registered && leases.get(registered) === current.lease) return nested(current, run);
  const previous = leases.get(registered);
  if (previous) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([previous.done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MasterStorageHeldError()), 30000); })]); }
    finally { if (timer) clearTimeout(timer); }
    return withMasterStorageGuard(canonical, run, options);
  }
  let finish!: () => void;
  const lease: Lease = { pending: new Set(), done: new Promise<void>(accept => { finish = accept; }), finish: () => finish() };
  leases.set(registered, lease);
  // On uncertain helper output, transferred handles may already belong to Node.
  // Keep registration held until server exit; never guess a handle or steal it.
  const raw = await invokeMasterStorage({ action: "acquire", root: canonical, create: options.createIfMissing !== false });
  if (Object.keys(raw).join() === "notAcquired" && raw.notAcquired === true) {
    leases.delete(registered);lease.finish();throw new MasterStorageHeldError();
  }
  check(Object.keys(raw).sort().join() === "handles,identities,pid,root,schema,startToken" && raw.schema === "negi-master-storage-guard/1" &&
    typeof raw.root === "string" && key(raw.root) === registered && raw.pid === process.pid && typeof raw.startToken === "string" && /^[0-9]{1,30}$/.test(raw.startToken) &&
    Array.isArray(raw.handles) && raw.handles.length === 2 && new Set(raw.handles).size === 2 && raw.handles.every(value => typeof value === "string" && /^[0-9]{1,20}$/.test(value)) &&
    Array.isArray(raw.identities) && raw.identities.length === 2 && raw.identities.every(row => Array.isArray(row) && row.length === 3 && row.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)));
  lease.ticket = raw as unknown as Ticket;
  const scope: Scope = { key: registered, lease, active: true };
  try { return await context.run(scope, run); }
  finally {
    scope.active = false;
    while (lease.pending.size) await Promise.allSettled([...lease.pending]);
    const released = await invokeMasterStorage({ action: "release", ticket: lease.ticket });
    check(Object.keys(released).join() === "released" && released.released === true);
    leases.delete(registered);lease.finish();
  }
}
