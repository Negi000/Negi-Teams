import assert from "node:assert/strict";
import { test } from "node:test";
import { clearVersionCache, probeVersion, runPreflight } from "../src/server/backendPreflight.ts";
import { CODEX_BACKEND } from "../src/server/backends/index.ts";
const fixture = `const privateNames=Object.keys(process.env).filter(k=>['EBI_AUTH_TOKEN','NEGI_POLICY_SIGNING_SECRET','NEGI_POLICY_CONFIG'].includes(k.toUpperCase()));if(privateNames.length)process.exit(1);console.log(process.env.REQUIRED_FIXTURE||'safe');`;
test("CLI preflight uses the caller environment with all control credentials removed", async () => {
  clearVersionCache();
  const env = { REQUIRED_FIXTURE: "safe", EBI_AUTH_TOKEN: "private", negi_policy_signing_secret: "private", NEGI_POLICY_CONFIG: "private" };
  const backend = { ...CODEX_BACKEND, preflight: { ...CODEX_BACKEND.preflight, requiredFiles: [], requiredEnv: ["REQUIRED_FIXTURE"],
    verifiedVersion: null, versionArgs: ["-e", fixture], loginCheck: { args: ["-e", fixture], okPattern: /^safe$/ } } };
  assert.equal((await runPreflight(backend, { command: process.execPath, env })).ok, true);
  assert.equal(env.negi_policy_signing_secret, "private");
});
test("version cache distinguishes args and effective environment; default environment never leaks policy secret", async () => {
  clearVersionCache();
  assert.equal(await probeVersion(process.execPath, ["-e", fixture], { REQUIRED_FIXTURE: "one" }), "one");
  assert.equal(await probeVersion(process.execPath, ["-e", fixture], { REQUIRED_FIXTURE: "two" }), "two");
  assert.equal(await probeVersion(process.execPath, ["-e", "console.log('other args')"], { REQUIRED_FIXTURE: "two" }), "other args");
  const old = process.env.NEGI_POLICY_SIGNING_SECRET;
  try { process.env.NEGI_POLICY_SIGNING_SECRET = "synthetic-private"; assert.equal(await probeVersion(process.execPath, ["-e", fixture]), "safe"); }
  finally { if (old === undefined) delete process.env.NEGI_POLICY_SIGNING_SECRET; else process.env.NEGI_POLICY_SIGNING_SECRET = old; }
});
