// Browser review receipts are signed by the local server, outside model outputs.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface HumanReviewReceipt {
  schema: "negi-human-review/1";
  id: string;
  at: string;
  source: "authenticated-browser";
  action: "accept" | "feedback" | "revoke" | "operation";
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

export class HumanReviewProofStore {
  private constructor(readonly root: string, private readonly key: Buffer) {}

  static async open(directory: string): Promise<HumanReviewProofStore> {
    const target = resolve(directory);
    await mkdir(target, { recursive: true });
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Review storage cannot be a symlink");
    const root = await realpath(target);
    const path = join(root, "server-signing-key");
    try { await writeNew(path, randomBytes(32)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== 32)
      throw new Error("Review signing key is invalid");
    return new HumanReviewProofStore(root, await readFile(path));
  }

  private signature(receipt: HumanReviewReceipt): Buffer {
    return createHmac("sha256", this.key).update(JSON.stringify(receipt)).digest();
  }

  async read(id: string): Promise<HumanReviewReceipt | null> {
    if (!isReviewRequestId(id)) return null;
    const path = join(this.root, `${id.toLowerCase()}.json`);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try { entry = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 24_000)
      throw new Error("Review receipt file is invalid");
    const envelope = JSON.parse(await readFile(path, "utf8")) as
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
    return receipt;
  }

  async create(input: Omit<HumanReviewReceipt, "schema" | "at" | "source">): Promise<HumanReviewReceipt> {
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
    if (bytes.length > 24_000) throw new Error("Review receipt exceeds storage limit");
    try { await writeNew(join(this.root, `${id}.json`), bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Concurrent requests share the same identity only when the payload agrees.
      return this.create(input);
    }
    return receipt;
  }
}
