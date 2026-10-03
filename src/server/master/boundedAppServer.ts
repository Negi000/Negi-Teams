// Per-process overrides, checked with the installed Codex CLI. Global config is retained.
import { appServerChildEnv } from "./appServerProcess.ts";
import { RESEARCH_DISABLED_FEATURES } from "./researchToolPolicy.ts";

export function boundedAppServerArgs(subscriptionOnly = false): string[] {
  return ["app-server", "--stdio", "--disable", "multi_agent", "--disable", "multi_agent_v2",
    ...(subscriptionOnly ? ["-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'] : [])];
}
/** Explicit process overrides; the client also checks effective config and inventory. */
export function researchAppServerArgs():string[]{
  return [...boundedAppServerArgs(true),...RESEARCH_DISABLED_FEATURES.flatMap(name=>["--disable",name]),
    "-c",'web_search="disabled"',"-c","mcp_servers={}","-c","sandbox_read_only.network_access=false"];
}
export function subscriptionChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(appServerChildEnv(env)).filter(([key]) =>
    !["OPENAI_API_KEY", "CODEX_API_KEY"].includes(key.toUpperCase())));
}
