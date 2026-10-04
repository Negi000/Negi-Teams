// Read-only local diagnosis for one uncertain Phase 3 attempt.
import { FileTaskLedger } from "../src/server/orchestration/singleTask.ts";
import { inspectUnknownAttempt } from "../src/server/orchestration/reconciliationDossier.ts";

function args(): Record<"ledger" | "attempt" | "checkout" | "artifacts", string> {
  const values = new Map<string, string>();
  const required = ["--ledger", "--attempt", "--checkout", "--artifacts"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    const value = process.argv[i + 1];
    if (!required.includes(flag) || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error("Usage: node --import tsx scripts/negi_reconciliation_dossier.ts " +
        "--ledger <run.jsonl> --attempt <id> --checkout <Git root> --artifacts <directory>");
    }
    values.set(flag, value);
  }
  if (required.some((flag) => !values.has(flag))) throw new Error("All four arguments are required");
  return { ledger: values.get("--ledger")!, attempt: values.get("--attempt")!,
    checkout: values.get("--checkout")!, artifacts: values.get("--artifacts")! };
}

const options = args();
const result = await inspectUnknownAttempt(new FileTaskLedger(options.ledger),
  options.attempt, options.checkout, options.artifacts);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
