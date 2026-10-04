import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL_PLANE_ENV, withoutControlPlaneEnv } from "../src/server/controlPlaneEnv.ts";
test("all authority keys and case aliases are removed without changing provider or worker environment", () => {
  const required = { PATH: "system", EBI_ID: "worker", OPENAI_API_KEY: "caller-owned", NEGI_JOB_TOKEN: "internal-job" };
  const input = { ...required, ...Object.fromEntries(CONTROL_PLANE_ENV.flatMap(key => [[key, "private"], [key.toLowerCase(), "private"]])) };
  assert.deepEqual(withoutControlPlaneEnv(input), required);
  assert.equal(input.NEGI_POLICY_SIGNING_SECRET, "private");
});
