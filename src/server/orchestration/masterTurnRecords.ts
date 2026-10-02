// Read the exact provider turn recorded by a trusted Task origin. No dispatch or repair.
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConversationSource, MasterOrigin } from "../../shared/conversations.ts";
import type { FileScheduler } from "./scheduler.ts";

const workIdPattern = /^master-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("Master turn evidence: " + reason);
}
function row(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "object required");
  return value as Record<string, unknown>;
}
function label(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}
async function normalDirectory(path: string): Promise<string> {
  const before = await lstat(path);
  check(before.isDirectory() && !before.isSymbolicLink(), "linked directory");
  const canonical = await realpath(path);
  check(process.platform === "win32" ? canonical.toLowerCase() === path.toLowerCase() : canonical === path, "directory alias");
  const after = await lstat(path);
  check(before.dev === after.dev && before.ino === after.ino, "directory changed");
  return `${before.dev}:${before.ino}`;
}
async function artifact(path: string, maxBytes: number): Promise<{ value: Record<string, unknown>; bytes: string } | null> {
  let before;
  try { before = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maxBytes,
    "unsafe or oversized artifact");
  const file = await open(path, "r");
  try {
    const pinned = await file.stat();
    check(pinned.isFile() && pinned.nlink === 1 && pinned.dev === before.dev && pinned.ino === before.ino &&
      pinned.size === before.size && pinned.mtimeMs === before.mtimeMs && pinned.ctimeMs === before.ctimeMs, "artifact changed before read");
    const bytes = await file.readFile("utf8"), after = await file.stat(), current = await lstat(path);
    check(Buffer.byteLength(bytes) === pinned.size && after.size === pinned.size && after.mtimeMs === pinned.mtimeMs &&
      after.ctimeMs === pinned.ctimeMs && after.nlink === 1 && current.nlink === 1 &&
      current.isFile() && !current.isSymbolicLink() && current.dev === pinned.dev && current.ino === pinned.ino &&
      current.size === pinned.size && current.mtimeMs === pinned.mtimeMs && current.ctimeMs === pinned.ctimeMs,
      "artifact changed during read");
    const value = row(JSON.parse(bytes));
    // The writer stores one canonical JSON line. This also rejects duplicate keys and partial writes.
    check(JSON.stringify(value) + "\n" === bytes, "noncanonical or incomplete artifact");
    return { value, bytes };
  } finally { await file.close(); }
}
async function inventory(root: string) {
  const names = await readdir(root, { withFileTypes: true });
  check(names.length <= 10_000, "inventory limit exceeded");
  const records = [];
  for (const name of names.sort((a, b) => a.name.localeCompare(b.name))) {
    check(workIdPattern.test(name.name) && name.isDirectory() && !name.isSymbolicLink(), "unexpected turn entry");
    const directory = join(root, name.name), identity = await normalDirectory(directory);
    const provider = await artifact(join(directory, "provider.json"), 8000);
    if (provider) {
      const p = provider.value;
      check(Object.keys(p).length === 3 && p.workId === name.name && label(p.threadId) && label(p.turnId), "provider identity");
    }
    records.push({ id: name.name, directory, identity, provider });
  }
  return records;
}
export type MasterTurnEvidence = Pick<ConversationSource, "state" | "message" | "workId" | "model" | "effort" |
  "sentAt" | "input" | "finalText" | "outcome" | "inputSha256" | "outcomeSha256">;
function absent(state: "missing" | "attention", message: string): MasterTurnEvidence {
  return { state, message, workId: null, model: null, effort: null, sentAt: null, input: null,
    finalText: null, outcome: null, inputSha256: null, outcomeSha256: null };
}

export async function readMasterTurnOrigin(root: string, scheduler: FileScheduler, origin: MasterOrigin): Promise<MasterTurnEvidence> {
  try {
    check([origin.masterId, origin.threadId, origin.turnId, origin.callId].every(label), "origin identity");
    let rootIdentity: string;
    try { rootIdentity = await normalDirectory(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent("missing", "元の送信・応答の記録がありません。別の会話へ置き換えて表示しません。");
      throw error;
    }
    const initialInventory = await inventory(root);
    const matches = initialInventory.filter(item => item.provider?.value.threadId === origin.threadId && item.provider.value.turnId === origin.turnId);
    if (!matches.length) return absent("missing", "委任元のturnに一致する送信・応答の記録がありません。過去の記録や欠測を現在の会話で補いません。");
    check(matches.length === 1, "ambiguous provider turn");
    const { id, directory } = matches[0]!;
    const before = (await scheduler.read()).state?.entries.find(entry => entry.work.id === id);
    check(before, "scheduler registration missing");
    const request = await artifact(join(directory, "request.json"), 1_000_000);
    const dispatch = await artifact(join(directory, "dispatch.json"), 8000);
    check(request && dispatch, "dispatch intent missing");
    const r = request.value, d = dispatch.value;
    check(Object.keys(r).length === 10 && r.schemaVersion === "negi-master-turn/1" && r.workId === id &&
      r.masterId === origin.masterId && r.threadId === origin.threadId && typeof r.text === "string" &&
      r.text.length <= 200_000 && hash(r.text) === r.inputSha256 && label(r.model) && label(r.effort) &&
      typeof r.cwd === "string" && typeof r.at === "string" && Number.isFinite(Date.parse(r.at)), "request identity/hash");
    check(Object.keys(d).length === 3 && d.workId === id && d.threadId === origin.threadId &&
      typeof d.at === "string" && Number.isFinite(Date.parse(d.at)), "dispatch identity");
    check(before.work.role === "astra" && before.work.checkout === r.cwd && before.work.checkoutMode === "read", "scheduler owner");
    const terminal = await artifact(join(directory, "outcome.json"), 2_000_000);
    let finalText: string | null = null, outcomeSha256: string | null = null;
    if (terminal) {
      const t = terminal.value;
      check(Object.keys(t).length === 10 && t.workId === id && t.threadId === origin.threadId && t.turnId === origin.turnId &&
        ["completed", "failed", "interrupted"].includes(String(t.status)) &&
        (t.finalText === null || typeof t.finalText === "string") && (t.status !== "completed" || typeof t.finalText === "string") &&
        t.humanAcceptance === null && t.verification === "provider terminal response only; not Task quality or human acceptance", "terminal identity");
      const expectedStatus = t.status === "completed" ? "verified" : "failed";
      check(before.status === expectedStatus && before.evidenceRef === join(directory, "outcome.json") + "#sha256=" + hash(terminal.bytes),
        "terminal differs from scheduler evidence");
      finalText = t.finalText as string | null; outcomeSha256 = hash(terminal.bytes);
    } else check(["running", "needs_reconciliation"].includes(before.status), "terminal evidence missing");
    check(isDeepStrictEqual(initialInventory, await inventory(root)), "provider inventory changed during read");
    for (const [name, original, bound] of [["request.json", request, 1_000_000], ["dispatch.json", dispatch, 8000],
      ["outcome.json", terminal, 2_000_000]] as const)
      check(original?.bytes === (await artifact(join(directory, name), bound))?.bytes, "turn artifact changed during read");
    const after = (await scheduler.read()).state?.entries.find(entry => entry.work.id === id);
    check(isDeepStrictEqual(before, after), "scheduler changed during read");
    check(rootIdentity === await normalDirectory(root), "root replaced during read");
    check(matches[0]!.identity === await normalDirectory(directory), "turn directory replaced during read");
    return { state: terminal ? "available" : before.status === "running" ? "waiting" : "attention",
      message: terminal ? "記録された送信・応答です。Taskの機械検証や人間による受入とは別の記録です。" :
        before.status === "running" ? "元の送信内容を表示しています。統括の応答の確定を待っています。" :
          "元の送信内容は確認できましたが、統括の応答は不明です。自動では再送しません。",
      workId: id, model: r.model as string, effort: r.effort as string, sentAt: d.at as string,
      input: r.text, finalText, outcome: terminal ? String(terminal.value.status) : before.status,
      inputSha256: r.inputSha256 as string, outcomeSha256 };
  } catch {
    return absent("attention", "委任元の記録が部分的・不一致・変更中のため、送信と応答を表示できません。記録を確認してください。再実行は行っていません。");
  }
}
