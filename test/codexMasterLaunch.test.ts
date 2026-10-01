import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexMasterLaunchOptions } from
  "../src/server/master/codexMasterLaunch.ts";

test("Codex chat master requires explicit read-only opt-in and a pinned executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-codex-master-"));
  try {
    const exe = join(dir, "codex.exe");
    await writeFile(exe, "synthetic executable");
    const spec = { model: "gpt-6-astra", extraArgs: [] };
    const env = { EBI_CODEX_APP_SERVER_EXE: exe,
      EBI_CODEX_MASTER_EFFORT: "low" } as NodeJS.ProcessEnv;
    assert.throws(() => codexMasterLaunchOptions(spec, env), /READ_ONLY_MASTER=1/);
    const active = { ...env, EBI_CODEX_READ_ONLY_MASTER: "1" };
    assert.deepEqual(codexMasterLaunchOptions(spec, active), {
      executable: exe, args: ["app-server", "--stdio", "--disable", "multi_agent", "--disable", "multi_agent_v2"], effort: "low",
      turnTimeoutMs: 120_000,
    });
    assert.throws(() => codexMasterLaunchOptions({ ...spec,
      extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] }, active),
    /does not accept extra/);
    assert.throws(() => codexMasterLaunchOptions(spec, { ...active,
      EBI_CODEX_APP_SERVER_EXE: "codex.exe" }), /absolute/);
    assert.throws(() => codexMasterLaunchOptions(spec, { ...active,
      EBI_CODEX_MASTER_TURN_TIMEOUT_MS: "0" }), /timeout/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
