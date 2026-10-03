// Tool-bearing feature names checked with Codex CLI 0.160.0. A new CLI must be
// reviewed before this read-only contract is used with its default tool set.
export const RESEARCH_CODEX_VERSION="codex-cli 0.160.0";
export const RESEARCH_DISABLED_FEATURES=["apps","plugins","remote_plugin","hooks","browser_use",
  "browser_use_external","browser_use_full_cdp_access","computer_use","code_mode","code_mode_host",
  "code_mode_only","image_generation","skill_search","skill_mcp_dependency_install",
  "auth_elicitation","tool_call_mcp_elicitation","realtime_conversation","workspace_dependencies"] as const;
export const researchThreadConfig=()=>({web_search:"disabled",mcp_servers:{},sandbox_read_only:{network_access:false},
  features:Object.fromEntries(RESEARCH_DISABLED_FEATURES.map(name=>[name,false]))});
