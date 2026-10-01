import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { evaluateJevShadow, validateJevRequest, type JevProvider,
  type JevRequest, type JevShadowResult } from "./jevShadow.ts";

interface Reserved { type: "reserved"; key: string; at: string; reserveUsd: number }
interface Settled { type: "settled"; key: string; at: string;
  result: JevShadowResult }
interface Failed { type: "failed"; key: string; at: string; reason: string }
type Event = Reserved | Settled | Failed;

const PER_CALL_RESERVE_USD = 0.01;
function now(): string { return new Date().toISOString(); }

/** Local, single-writer shadow ledger. A failed/unknown dispatch is never retried automatically. */
export class JevShadowLedger {
  readonly path: string;
  constructor(path: string, private readonly budgetUsd: number) {
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 5)
      throw new Error("Jev shadow budget must be between $0 and $5");
    this.path = resolve(path);
  }

  async read(): Promise<Event[]> {
    let data: string;
    try { data = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (data && !data.endsWith("\n")) throw new Error("Jev ledger has incomplete tail");
    return data.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
  }

  private async append(event: Event): Promise<void> {
    const file = await open(this.path, "a");
    try { await file.writeFile(JSON.stringify(event) + "\n", "utf8"); await file.sync(); }
    finally { await file.close(); }
  }

  async evaluate(request: JevRequest, provider: JevProvider): Promise<JevShadowResult> {
    const key = validateJevRequest(request);
    if (request.mode !== "shadow" || !request.reviewedForExternalTransmission)
      return evaluateJevShadow(request, provider);
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 2_000;
    let lock: Awaited<ReturnType<typeof open>>;
    for (;;) {
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
          throw error;
        await wait(10);
      }
    }
    try {
      const events = await this.read();
      const old = events.find((event) => event.key === key && event.type === "reserved");
      if (old) {
        const settled = events.find((event) => event.key === key && event.type === "settled") as
          Settled | undefined;
        return settled?.result ?? { status: "held", gate: request.gate, key,
          reason: "prior dispatch is unresolved or failed; reconcile before retry",
          response: null, estimatedUsd: null, elapsedMs: null };
      }
      const spent = events.filter((event): event is Reserved =>
        event.type === "reserved").reduce((sum, event) => sum + event.reserveUsd, 0);
      if (spent + PER_CALL_RESERVE_USD > this.budgetUsd + 1e-9)
        return { status: "held", gate: request.gate, key,
          reason: "local Jev dispatch budget exhausted", response: null,
          estimatedUsd: null, elapsedMs: null };
      await this.append({ type: "reserved", key, at: now(),
        reserveUsd: PER_CALL_RESERVE_USD });
      try {
        const result = await evaluateJevShadow(request, provider);
        await this.append({ type: "settled", key, at: now(), result });
        return result;
      } catch (error) {
        // Avoid recording provider response bodies or request text in the ledger.
        await this.append({ type: "failed", key, at: now(),
          reason: "provider or response failed" });
        throw error;
      }
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
