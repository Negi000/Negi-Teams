import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dotenvKeys, loadDotenv } from "../src/server/env.ts";
test("dotenv authority declarations are detected even when process environment wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "negi-dotenv-")), path = join(root, ".env");
  const previous = process.env.NEGI_POLICY_SIGNING_SECRET;
  try {
    process.env.NEGI_POLICY_SIGNING_SECRET = "explicit-private";
    await writeFile(path, "# comment\nexport NEGI_POLICY_SIGNING_SECRET=readable-private\nnegi_policy_signing_secret=alias\ninvalid-name=value\n");
    assert.deepEqual(dotenvKeys(path), ["NEGI_POLICY_SIGNING_SECRET", "negi_policy_signing_secret"]);
    assert.ok(!loadDotenv(path).includes("NEGI_POLICY_SIGNING_SECRET"));
    assert.equal(process.env.NEGI_POLICY_SIGNING_SECRET, "explicit-private");
    assert.deepEqual(dotenvKeys(join(root, "missing")), []);
  } finally {
    delete process.env.negi_policy_signing_secret;
    if (previous === undefined) delete process.env.NEGI_POLICY_SIGNING_SECRET; else process.env.NEGI_POLICY_SIGNING_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});
