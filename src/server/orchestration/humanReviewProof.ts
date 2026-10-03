// Browser review receipts are signed by the local server, outside model outputs.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { invokeMasterStorage, masterStorageTicket } from "./masterStorageGuard.ts";

export interface HumanReviewReceipt {
  schema: "negi-human-review/1";
  id: string;
  at: string;
  source: "authenticated-browser";
  action: "accept" | "feedback" | "revoke" | "operation" | "task-inspect" | "task-close";
  caseId: string;
  runId: string;
  artifactSha256: string;
  verificationRef: string | null;
  data: Record<string, string>;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isReviewRequestId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

async function writeNew(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** Publish only after the complete signed bytes have been flushed. Protected
 * Policy receipts use native no-replace rename; legacy callers use link().
 * A crash before publication leaves an ignored staging file, never partial JSON
 * at a replayable UUID name. Directory-entry durability on power loss is not
 * claimed here. */
async function writeCommitted(path: string, bytes: Buffer, protectedRoot?: string): Promise<void> {
  const pending = `${path}.pending-${randomUUID()}`;
  await writeNew(pending, bytes);
  if (protectedRoot) {
    const ticket = masterStorageTicket(protectedRoot);
    if (!ticket) throw Error("Protected proof publication requires its native operation guard");
    const result = await invokeMasterStorage({ action: "publish-proof", root: protectedRoot,
      pending: pending.slice(protectedRoot.length + 1), final: path.slice(protectedRoot.length + 1), storageTicket: ticket });
    if (result.published !== true) throw Error("Protected proof publication incomplete");
  } else {
    try { await link(pending, path); }
    finally { await unlink(pending); }
  }
}

interface ProofProtection { secret: string }
type FileIdentity = { dev: number; ino: number };
async function protectedRead(path: string, limit: number, identity?: FileIdentity) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit ||
      identity && (before.dev !== identity.dev || before.ino !== identity.ino)) throw Error("Protected proof file identity invalid");
  const file = await open(path, "r");
  try {
    const first = await file.stat();
    if (first.dev !== before.dev || first.ino !== before.ino || first.nlink !== 1 || first.size > limit) throw Error("Protected proof file changed");
    const bytes = await file.readFile(), last = await file.stat(), published = await lstat(path);
    if (bytes.length > limit || first.dev !== last.dev || first.ino !== last.ino || last.nlink !== 1 ||
        first.size !== last.size || first.mtimeMs !== last.mtimeMs || published.dev !== first.dev || published.ino !== first.ino ||
        published.nlink !== 1 || published.isSymbolicLink()) throw Error("Protected proof file changed while reading");
    return { bytes, identity: { dev: first.dev, ino: first.ino } };
  } finally { await file.close(); }
}

export class HumanReviewProofStore {
  private constructor(readonly root: string, private readonly key: Buffer,private readonly maxReceiptBytes:number,
    private readonly protectedKey?: { identity: FileIdentity; sha256: string }) {}

  static async open(directory: string,maxReceiptBytes=24_000,protection?:ProofProtection): Promise<HumanReviewProofStore> {
    if(!Number.isSafeInteger(maxReceiptBytes)||maxReceiptBytes<24_000||maxReceiptBytes>2_000_000)
      throw Error("Review receipt bound invalid");
    const target = resolve(directory);
    await mkdir(target, { recursive: true });
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Review storage cannot be a symlink");
    const root = await realpath(target);
    const path = join(root, "server-signing-key");
    try { await writeNew(path, randomBytes(32)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return this.openExisting(root, maxReceiptBytes, protection);
  }

  /** Read an existing authority without creating a directory or signing key. */
  static async openExisting(directory: string,maxReceiptBytes=24_000,protection?:ProofProtection): Promise<HumanReviewProofStore> {
    if(!Number.isSafeInteger(maxReceiptBytes)||maxReceiptBytes<24_000||maxReceiptBytes>2_000_000)
      throw Error("Review receipt bound invalid");
    const target = resolve(directory), folder = await lstat(target);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("Review storage cannot be linked or missing");
    const root = await realpath(target), path = join(root, "server-signing-key");
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== 32)
      throw new Error("Review signing key is invalid");
    if (protection) {
      if (typeof protection.secret !== "string" || protection.secret.length < 16 || protection.secret.length > 4096)
        throw Error("External proof protection secret invalid");
      const raw = await protectedRead(path, 32);
      if (raw.bytes.length !== 32) throw Error("Protected proof key invalid");
      // Knowledge of the disk key alone cannot forge a policy decision. This
      // secret is supplied by the server and never written to proof storage.
      const key = createHmac("sha256", protection.secret).update("negi-policy-proofs/1\0").update(raw.bytes).digest();
      return new HumanReviewProofStore(root, key, maxReceiptBytes,
        { identity: raw.identity, sha256: createHash("sha256").update(raw.bytes).digest("hex") });
    }
    return new HumanReviewProofStore(root, await readFile(path),maxReceiptBytes);
  }

  private async assertKey(): Promise<void> {
    if (!this.protectedKey) return;
    const raw = await protectedRead(join(this.root, "server-signing-key"), 32, this.protectedKey.identity);
    if (createHash("sha256").update(raw.bytes).digest("hex") !== this.protectedKey.sha256) throw Error("Protected proof key changed");
  }

  private signature(receipt: HumanReviewReceipt): Buffer {
    return createHmac("sha256", this.key).update(JSON.stringify(receipt)).digest();
  }

  async read(id: string): Promise<HumanReviewReceipt | null> {
    if (!isReviewRequestId(id)) return null;
    await this.assertKey();
    const path = join(this.root, `${id.toLowerCase()}.json`);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try { entry = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > this.maxReceiptBytes)
      throw new Error("Review receipt file is invalid");
    const bytes=this.protectedKey ? (await protectedRead(path,this.maxReceiptBytes)).bytes : await readFile(path);
    if(bytes.length>this.maxReceiptBytes)throw Error("Review receipt grew");
    const envelope = JSON.parse(bytes.toString("utf8")) as
      { receipt?: HumanReviewReceipt; signature?: string };
    const receipt = envelope.receipt;
    if (!receipt || receipt.schema !== "negi-human-review/1" || receipt.id !== id.toLowerCase() ||
        receipt.source !== "authenticated-browser" ||
        !Number.isFinite(Date.parse(receipt.at)) ||
        typeof envelope.signature !== "string" || !/^[0-9a-f]{64}$/.test(envelope.signature))
      throw new Error("Review receipt metadata is invalid");
    const expected = this.signature(receipt);
    const provided = Buffer.from(envelope.signature, "hex");
    if (!timingSafeEqual(provided, expected)) throw new Error("Review receipt signature is invalid");
    await this.assertKey();
    return receipt;
  }

  async create(input: Omit<HumanReviewReceipt, "schema" | "at" | "source">): Promise<HumanReviewReceipt> {
    return this.createUsing(input, false);
  }
  async createCommitted(input: Omit<HumanReviewReceipt, "schema" | "at" | "source">): Promise<HumanReviewReceipt> {
    return this.createUsing(input, true);
  }
  private async createUsing(input: Omit<HumanReviewReceipt, "schema" | "at" | "source">, committed: boolean): Promise<HumanReviewReceipt> {
    await this.assertKey();
    if (!isReviewRequestId(input.id)) throw new Error("Review request ID must be a UUID");
    const id = input.id.toLowerCase();
    const existing = await this.read(id);
    if (existing) {
      const { schema: _schema, at: _at, source: _source, ...previous } = existing;
      if (JSON.stringify(previous) !== JSON.stringify({ ...input, id }))
        throw new Error("Review request ID was reused for a different operation");
      return existing;
    }
    const receipt: HumanReviewReceipt = { ...structuredClone(input), id,
      schema: "negi-human-review/1", at: new Date().toISOString(), source: "authenticated-browser" };
    const bytes = Buffer.from(JSON.stringify({ receipt,
      signature: this.signature(receipt).toString("hex") }) + "\n");
    if (bytes.length > this.maxReceiptBytes) throw new Error("Review receipt exceeds storage limit");
    try {
      if (committed) await writeCommitted(join(this.root, `${id}.json`), bytes, this.protectedKey ? this.root : undefined);
      else await writeNew(join(this.root, `${id}.json`), bytes);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Concurrent requests share the same identity only when the payload agrees.
      return this.createUsing(input, committed);
    }
    return receipt;
  }
}
