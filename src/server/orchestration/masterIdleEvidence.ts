// No repair, dispatch, cancellation or capacity release. A partial record is a hold.
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readMasterTurnArtifact as artifact, verifyMasterTurnDirectory as directory } from "./masterTurnRecords.ts";
import type { FileScheduler } from "./scheduler.ts";

const workId = /^master-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function check(value: unknown, reason: string): asserts value { if (!value) throw Error("Master idle evidence: " + reason); }
async function schedulerIdentity(path: string) {
  await directory(dirname(path));
  try {
    const stat = await lstat(path);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "unsafe scheduler file");
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** A server-owned Master ID must have no unresolved claims, including pre-submit orphans. */
export async function assertMasterIdleEvidence(root: string, masterId: string, scheduler: FileScheduler): Promise<void> {
  const schedulerBefore = await schedulerIdentity(scheduler.path);
  const before = await scheduler.read();
  // Legacy resident Masters were always Astra/read. Valid Sol Tasks can have the
  // same ID shape; their registration must not invent a missing Master journal.
  const entries = before.state?.entries.filter(e => e.work.masterOwner !== undefined ||
    (workId.test(e.work.id) && e.work.role === "astra" && e.work.checkoutMode === "read")) ?? [];
  let rootIdentity: string | null = null;
  try { rootIdentity = await directory(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const names = rootIdentity ? await readdir(root, { withFileTypes: true }) : [];
  check(names.length <= 10_000, "inventory limit exceeded");
  const ids = new Set<string>();
  const pinned: Array<{ path: string; bytes: string | null; bound: number }> = [];
  const directories: Array<{ path: string; identity: string }> = [];
  for (const name of names) {
    check(workId.test(name.name) && name.isDirectory() && !name.isSymbolicLink(), "unexpected turn entry");
    ids.add(name.name);
    const path = join(root, name.name);
    directories.push({ path, identity: await directory(path) });
    const request = await artifact(join(path, "request.json"), 1_000_000);
    check(request, "request missing");
    const r = request.value;
    check(Object.keys(r).length === 10 && r.schemaVersion === "negi-master-turn/1" && r.workId === name.name &&
      token(r.masterId) && /^[a-zA-Z0-9_-]{1,100}$/.test(r.masterId) && token(r.threadId) && token(r.model) && token(r.effort) &&
      typeof r.cwd === "string" && typeof r.text === "string" && r.text.length > 0 && r.text.length <= 200_000 &&
      r.inputSha256 === hash(r.text) && date(r.at), "request identity");
    pinned.push({ path: join(path, "request.json"), bytes: request.bytes, bound: 1_000_000 });
    const entry = entries.find(e => e.work.id === name.name);
    check(entry && entry.work.role === "astra" && entry.work.checkoutMode === "read" && entry.work.checkout === r.cwd, "scheduler owner missing/mismatched");
    if (entry.work.masterOwner) {
      check(entry.work.masterOwner.masterId === r.masterId && entry.work.masterOwner.requestSha256 === hash(request.bytes), "Master owner/request binding changed");
      if (entry.work.masterOwner.masterId !== masterId) continue;
    }
    // Legacy ownership cannot be inferred from an editable request. Hold all unresolved
    // legacy Masters; verify complete terminal evidence even for a different Master ID.
    check(!["queued", "running", "needs_reconciliation", "blocked"].includes(entry.status), "Master claim unresolved");
    const allowed = ["request.json", "dispatch.json", "provider.json", "outcome.json", "not-sent.json"];
    const files = await readdir(path);
    check(files.every(file => allowed.includes(file)), "unexpected Master artifact");
    const dispatch = await artifact(join(path, "dispatch.json"), 8000);
    const provider = await artifact(join(path, "provider.json"), 8000);
    const terminal = await artifact(join(path, "outcome.json"), 2_000_000);
    const unsent = await artifact(join(path, "not-sent.json"), 8000);
    for (const [name, record, bound] of [["dispatch.json", dispatch, 8000], ["provider.json", provider, 8000],
      ["outcome.json", terminal, 2_000_000], ["not-sent.json", unsent, 8000]] as const)
      pinned.push({ path: join(path, name), bytes: record?.bytes ?? null, bound });
    if (entry.status === "cancelled") {
      check(!dispatch && !provider && !terminal && !unsent && entry.claimKey === null && entry.evidenceRef === null, "cancelled turn has dispatch evidence");
    } else if (unsent) {
      const n = unsent.value;
      check(entry.status === "failed" && entry.claimKey && !dispatch && !provider && !terminal && Object.keys(n).length === 3 &&
        n.workId === name.name && n.reason === "Master stopped before turn/start" && date(n.at) &&
        entry.evidenceRef === join(path, "not-sent.json") + "#sha256=" + hash(unsent.bytes), "unsent evidence mismatch");
    } else {
      check(dispatch && provider && terminal && entry.claimKey, "terminal evidence missing");
      const d = dispatch.value, p = provider.value, t = terminal.value;
      check(Object.keys(d).length === 3 && d.workId === name.name && d.threadId === r.threadId && date(d.at), "dispatch mismatch");
      check(Object.keys(p).length === 3 && p.workId === name.name && p.threadId === r.threadId && token(p.turnId), "provider mismatch");
      check(Object.keys(t).length === 10 && t.workId === name.name && t.threadId === r.threadId && t.turnId === p.turnId &&
        ["completed", "failed", "interrupted"].includes(String(t.status)) && (t.finalText === null || typeof t.finalText === "string") &&
        (t.status !== "completed" || typeof t.finalText === "string") && t.humanAcceptance === null &&
        t.verification === "provider terminal response only; not Task quality or human acceptance" &&
        entry.status === (t.status === "completed" ? "verified" : "failed") &&
        entry.evidenceRef === join(path, "outcome.json") + "#sha256=" + hash(terminal.bytes), "terminal mismatch");
    }
  }
  // An unowned scheduler record cannot be attributed safely by inventing a Master ID.
  check(entries.every(e => ids.has(e.work.id)), "orphan scheduler Master entry");
  for (const record of pinned) check((await artifact(record.path, record.bound))?.bytes === (record.bytes ?? undefined), "artifact changed");
  for (const record of directories) check(await directory(record.path) === record.identity, "turn directory changed");
  if (rootIdentity) {
    check(await directory(root) === rootIdentity, "turn root changed");
    check(isDeepStrictEqual((await readdir(root)).sort(), names.map(n => n.name).sort()), "turn inventory changed");
  } else {
    try { await lstat(root); throw Error("Master idle evidence: turn root appeared"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  check(isDeepStrictEqual(before, await scheduler.read()) && isDeepStrictEqual(schedulerBefore, await schedulerIdentity(scheduler.path)), "scheduler changed");
}
