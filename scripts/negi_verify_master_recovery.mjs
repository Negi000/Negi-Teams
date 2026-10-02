// Fixed stdin-only read-only verifier used by the native indexed receipt boundary.
import { access } from "node:fs/promises";
async function modulePath(name) {
  const source = new URL("../src/server/orchestration/" + name + ".ts", import.meta.url);
  try { await access(source);return source.href; } catch (error) { if (error.code !== "ENOENT") throw error; }
  return new URL("../dist/server/server/orchestration/" + name + ".js", import.meta.url).href;
}
try {
  let text = "";
  for await (const part of process.stdin) { text += part;if (Buffer.byteLength(text) > 100000) throw Error("Verifier input bound"); }
  const input = JSON.parse(text);
  if (!input || Object.keys(input).sort().join() !== "cwd,expectedProofSha256,masterId,ownerBytes,ownerPresent,root,schedulerPath,turnRoot" ||
    typeof input.ownerPresent !== "boolean") throw Error("Verifier fields invalid");
  const { MasterConversationAuthority } = await import(await modulePath("masterConversations"));
  const { FileScheduler } = await import(await modulePath("scheduler"));
  await new MasterConversationAuthority({ root: input.root, turnRoot: input.turnRoot, masterId: input.masterId, scheduler: new FileScheduler(input.schedulerPath) })
    .assertRecoveryEvidence(input.cwd, input.ownerBytes, input.expectedProofSha256, input.ownerPresent);
  process.stdout.write('{"verified":true}\n');
} catch (error) {
  process.stderr.write(String(error?.message ?? error).slice(0, 500) + "\n");process.exitCode = 1;
}
