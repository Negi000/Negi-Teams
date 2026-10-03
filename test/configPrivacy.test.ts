import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTROL_PLANE_ENV } from "../src/server/controlPlaneEnv.ts";
import { loadFixedEbi } from "../src/server/config.ts";
test("fixed agent args and cwd cannot interpolate server secrets or case aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "negi-config-privacy-")), path = join(dir, "config.json");
  try {
    for (const key of CONTROL_PLANE_ENV) for (const placeholder of ["${" + key + "}", "$" + key.toLowerCase()]) {
      for (const item of [{ id: "fixture", cwd: dir, args: [placeholder] }, { id: "fixture", cwd: placeholder }]) {
        await writeFile(path, JSON.stringify({ fixedEbi: [item] }));
        await assert.rejects(loadFixedEbi(path, { command: "synthetic" }), /環境変数を展開できません/);
      }
    }
    await writeFile(path, JSON.stringify({ fixedEbi: [{ id: "fixture", cwd: "~", args: ["$EBI_TEAM/reference"] }] }));
    const [spec] = await loadFixedEbi(path, { command: "synthetic" });
    assert.equal(spec.launch.cwd, homedir()); assert.ok(spec.launch.args.includes(dir + "/reference"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
