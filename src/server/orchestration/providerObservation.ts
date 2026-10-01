// A read-only provider check recorded in the local run ledger. It never
// reconciles an attempt or permits another dispatch.
import type { CodexAppServerClient } from "../master/appServerClient.ts";
import { FileTaskLedger, type TaskSnapshot } from "./singleTask.ts";

export async function recordUnknownProviderTurn(
  ledger: FileTaskLedger,
  attemptId: string,
  client: Pick<CodexAppServerClient, "inspectProviderTurn">,
  eventKey: string,
  maxPages = 20,
): Promise<TaskSnapshot> {
  const { state } = await ledger.read();
  const attempt = state?.attempts.find((item) => item.id === attemptId);
  if (!eventKey || state?.status !== "needs_reconciliation" ||
      attempt?.state !== "unknown" || !attempt.threadId || !attempt.turnId) {
    throw new Error("bound unknown attempt required for provider observation");
  }
  const inspection = await client.inspectProviderTurn(attempt.threadId, attempt.turnId, maxPages);
  if (inspection.threadId !== attempt.threadId || inspection.turnId !== attempt.turnId) {
    throw new Error("provider observation identity mismatch");
  }
  return ledger.append({ key: eventKey, at: new Date().toISOString(),
    action: { type: "observe_provider", attemptId, inspection } });
}
