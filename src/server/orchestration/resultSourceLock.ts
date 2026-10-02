// Serializes supported review/Task result mutations with notification claims.
// The stable review storage root covers every lineage in a multi-result turn.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const held = new AsyncLocalStorage<{ path: string; active: boolean }>();
export class ResultSourceBusyError extends Error {}
export async function withResultSourceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const path = join(root, "result-source.lock"), parent = held.getStore();
  if (parent?.active && parent.path === path) return operation();
  const deadline = Date.now() + 2000;
  let file: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try { file = await open(path, "wx", 0o600); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const contention=code === "EEXIST" || (process.platform === "win32" && code === "EPERM");
      if(!contention)throw error;
      if(Date.now()>=deadline)throw new ResultSourceBusyError("Review result source is busy; preserve its owner record");
      await wait(10);
    }
  }
  const lease = { path, active: true };
  try {
    await file.writeFile(JSON.stringify({schema:"negi-result-source-owner/1",id:randomUUID(),pid:process.pid,
      acquiredAt:new Date().toISOString()})+"\n");await file.sync();
    return await held.run(lease, operation);
  }
  finally { lease.active = false; await file.close(); await unlink(path); }
}
