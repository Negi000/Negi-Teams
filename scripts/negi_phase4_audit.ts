// Post-run factual audit. Retain original outputs and invalidate false verification.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { FileScheduler } from "../src/server/orchestration/scheduler.ts";

const [logRaw, lunaCheckoutRaw, integrationRaw] = process.argv.slice(2);
if (!logRaw || !lunaCheckoutRaw || !integrationRaw) {
  process.stderr.write("Usage: node --import tsx scripts/negi_phase4_audit.ts <scheduler-jsonl> <luna-checkout> <integration-md>\n");
  process.exitCode = 2;
} else {
  const log = resolve(logRaw);
  const source = join(resolve(lunaCheckoutRaw), "src/server/index.ts");
  const integration = resolve(integrationRaw);
  try {
    const [code, document] = await Promise.all([
      readFile(source, "utf8"), readFile(integration, "utf8")]);
    const lines = code.split(/\r?\n/);
    const actualLines = lines.flatMap((line, index) => line.includes("registry.spawn(")
      ? [index + 1] : []);
    if (actualLines.length < 1 || !document.includes(
      "指定範囲内では `registry.spawn` の呼び出しや")) {
      throw new Error("expected source call or false-negative claim not found");
    }
    const evidence = { source: "src/server/index.ts", actualLines,
      sourceSha256: createHash("sha256").update(code).digest("hex"),
      integrationSha256: createHash("sha256").update(document).digest("hex"),
      finding: "Luna said registry.spawn was not found within the inspected files, but src/server/index.ts contains the call.",
      implication: "mechanical token-presence verification was insufficient" };
    const path = join(dirname(log), "audit-false-negative.json");
    const bytes = JSON.stringify(evidence, null, 2) + "\n";
    await writeFile(path, bytes, "utf8");
    const ref = `${path}#sha256=${createHash("sha256").update(bytes).digest("hex")}`;
    const scheduler = new FileScheduler(log);
    const state = await scheduler.append({ key: "audit-luna-false-negative",
      at: new Date().toISOString(), action: { type: "invalidate", workId: "luna-read",
        evidenceRef: ref, reason: "false negative about registry.spawn in inspected source" } });
    process.stdout.write(JSON.stringify({ evidenceRef: ref,
      statuses: state.entries.map((item) => ({ id: item.work.id, status: item.status })) },
    null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`Phase 4 audit failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
