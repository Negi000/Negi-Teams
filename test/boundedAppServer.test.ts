import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedAppServerArgs, subscriptionChildEnv } from "../src/server/master/boundedAppServer.ts";

test("bounded Task process disables internal agents and pins the subscription route", () => {
  assert.deepEqual(boundedAppServerArgs(true), ["app-server", "--stdio", "--disable", "multi_agent",
    "--disable", "multi_agent_v2", "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"']);
  const env = { PATH: "fixture", OPENAI_API_KEY: "synthetic-key", CODEX_API_KEY: "synthetic-key",
    EBI_AUTH_TOKEN: "synthetic-browser-secret", NEGI_TASK_CONFIG: "local-private-catalog", OTHER: "retained" };
  assert.deepEqual(subscriptionChildEnv(env), { PATH: "fixture", OTHER: "retained" });
  assert.equal(env.OPENAI_API_KEY, "synthetic-key");
});
