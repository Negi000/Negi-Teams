import type { TaskResultNotice } from "./taskResults.ts";

export type MasterOrigin = Extract<TaskResultNotice["origin"], { kind: "master" }>;
export interface ConversationSource {
  title: string;
  taskHref: string | null;
  planHref: string | null;
  origin: MasterOrigin | null;
  source: "requested" | "created";
  state: "available" | "waiting" | "missing" | "attention" | "browser";
  message: string;
  workId: string | null;
  model: string | null;
  effort: string | null;
  sentAt: string | null;
  input: string | null;
  finalText: string | null;
  outcome: string | null;
  inputSha256: string | null;
  outcomeSha256: string | null;
}

export function taskOriginHref(runId: string, source: "requested" | "created" = "requested"): string {
  return "/conversations?run=" + encodeURIComponent(runId) + "&source=" + source;
}

export function conversationTarget(url: URL) {
  const run = url.searchParams.get("run"), draft = url.searchParams.get("draft");
  const source = url.searchParams.get("source") ?? (draft ? "created" : "requested");
  if ((run === null) === (draft === null) || (run !== null && !/^[a-zA-Z0-9._-]{1,128}$/.test(run)) ||
      (draft !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(draft)) ||
      !["created", "requested"].includes(source) || (draft && source !== "created") ||
      [...url.searchParams.keys()].some(key => !["run", "draft", "source"].includes(key)) ||
      ["run", "draft", "source"].some(key => url.searchParams.getAll(key).length > 1))
    throw new Error("Conversation source target invalid");
  return { run, draft, source: source as "created" | "requested" };
}
