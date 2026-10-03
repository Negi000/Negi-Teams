// Tool-bearing feature names checked with Codex CLI 0.160.0. A new CLI must be
// reviewed before this read-only contract is used with its default tool set.
export const RESEARCH_CODEX_VERSION="codex-cli 0.160.0";
/**
 * 0.160.0 reloads user/project configuration inside thread/start, before it
 * starts MCP runtimes. Empty tables and known-name overrides merge with that
 * configuration, so preflight inspection cannot enforce an empty allowlist.
 * Keep native research dispatch closed until a process-local enforced policy
 * is available. This is code-owned; no registration or tool argument bypasses it.
 * Metadata-only inspection of an existing thread remains available.
 */
export function assertResearchDispatchIsolation():void {
  throw Error("Read-only research model dispatch is held: process-local MCP policy is not enforced by Codex 0.160.0");
}
export const RESEARCH_DISABLED_FEATURES=["apps","plugins","remote_plugin","hooks","browser_use",
  "browser_use_external","browser_use_full_cdp_access","computer_use","code_mode","code_mode_host",
  "code_mode_only","image_generation","skill_search","skill_mcp_dependency_install",
  "auth_elicitation","tool_call_mcp_elicitation","realtime_conversation","workspace_dependencies"] as const;
export const researchThreadConfig=()=>({web_search:"disabled",mcp_servers:{},sandbox_read_only:{network_access:false},
  features:Object.fromEntries(RESEARCH_DISABLED_FEATURES.map(name=>[name,false]))});
