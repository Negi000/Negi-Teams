// Fixed stdin-only read-only verifier used by the native indexed receipt boundary.
import { access, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
async function modulePath(name) {
  const source = new URL("../src/server/orchestration/" + name + ".ts", import.meta.url);
  try { await access(source);return source.href; } catch (error) { if (error.code !== "ENOENT") throw error; }
  return new URL("../dist/server/server/orchestration/" + name + ".js", import.meta.url).href;
}
try {
  let text = "";
  for await (const part of process.stdin) { text += part;if (Buffer.byteLength(text) > 100000) throw Error("Verifier input bound"); }
  const input = JSON.parse(text);
  const fields = "cwd,expectedProofSha256,masterId,ownerBytes,ownerPresent,root,schedulerPath,turnRoot";
  if (!input || ![fields, "cwd,expectedProofSha256,masterId,ownerBytes,ownerPresent,root,runtimeSnapshot,schedulerPath,turnRoot"].includes(Object.keys(input).sort().join()) ||
    typeof input.ownerPresent !== "boolean") throw Error("Verifier fields invalid");
  const { MasterConversationAuthority } = await import(await modulePath("masterConversations"));
  const { FileScheduler } = await import(await modulePath("scheduler"));
  const owner = JSON.parse(input.ownerBytes), snapshot = input.runtimeSnapshot;
  let journal;
  if (owner.schema === "negi-master-conversation-owner/5") {
    if (!snapshot || Object.keys(snapshot).sort().join() !== "bytes,present,sha256" || !/^[0-9a-f]{64}$/.test(snapshot.sha256) ||
      !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0 || snapshot.bytes > 64000000 || typeof snapshot.present !== "boolean" ||
      owner.runtime?.context.turnRoot !== input.turnRoot || owner.runtime?.context.schedulerPath !== input.schedulerPath) throw Error("Verifier runtime snapshot invalid");
    journal = Object.freeze({ withStorage: run => run(), audit: async current => {
      let present = true;
      try { await lstat(input.schedulerPath); } catch (error) { if (error.code !== "ENOENT") throw error;present = false; }
      if (current.path !== input.schedulerPath || Buffer.byteLength(current.bytes) !== snapshot.bytes || present !== snapshot.present ||
        createHash("sha256").update(current.bytes).digest("hex") !== snapshot.sha256) throw Error("Verifier runtime snapshot changed");
    }, appendIntent: async () => { throw Error("Recovery verifier is read only"); } });
  } else if (snapshot !== undefined) throw Error("Unexpected runtime snapshot");
  await new MasterConversationAuthority({ root: input.root, turnRoot: input.turnRoot, masterId: input.masterId,
    scheduler: new FileScheduler(input.schedulerPath, journal ? { journal } : {}) })
    .assertRecoveryEvidence(input.cwd, input.ownerBytes, input.expectedProofSha256, input.ownerPresent);
  process.stdout.write('{"verified":true}\n');
} catch (error) {
  process.stderr.write(String(error?.message ?? error).slice(0, 500) + "\n");process.exitCode = 1;
}
