import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedAppServerArgs, researchAppServerArgs, subscriptionChildEnv } from "../src/server/master/boundedAppServer.ts";
import { RESEARCH_DISABLED_FEATURES } from "../src/server/master/researchToolPolicy.ts";

test("bounded Task process disables internal agents and pins the subscription route", () => {
  assert.deepEqual(boundedAppServerArgs(true), ["app-server", "--stdio", "--disable", "multi_agent",
    "--disable", "multi_agent_v2", "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"']);
  const env = { PATH: "fixture", OPENAI_API_KEY: "synthetic-key", CODEX_API_KEY: "synthetic-key",
    EBI_AUTH_TOKEN: "synthetic-browser-secret", NEGI_TASK_CONFIG: "local-private-catalog", OTHER: "retained" };
  assert.deepEqual(subscriptionChildEnv(env), { PATH: "fixture", OTHER: "retained" });
  assert.equal(env.OPENAI_API_KEY, "synthetic-key");
});
test("research process disables tool-bearing features without changing ordinary process defaults",()=>{
  const args=researchAppServerArgs();
  assert.deepEqual(args.slice(0,boundedAppServerArgs(true).length),boundedAppServerArgs(true));
  for(const feature of RESEARCH_DISABLED_FEATURES){const at=args.indexOf(feature);assert.ok(at>0);assert.equal(args[at-1],"--disable")}
  for(const override of ['web_search="disabled"','mcp_servers={}','sandbox_read_only.network_access=false'])assert.ok(args.includes(override));
});
