import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { LocalKnowledgeService } from "./knowledgeService.ts";
import { knowledgePageHtml } from "./knowledgePage.ts";

function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("JSON required");
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16_000) throw new Error("Knowledge request too large");
    parts.push(Buffer.from(part));
  }
  const result: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Knowledge object required");
  return result as Record<string, unknown>;
}
/** Cookie + same-origin are required even on loopback; file paths never enter HTTP. */
export function createKnowledgeHttp(service: LocalKnowledgeService | null, auth: AuthConfig) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/knowledge" && url.pathname !== "/api/knowledge" &&
        !url.pathname.startsWith("/api/knowledge/")) return false;
    if (!service || !auth.token) { json(res, 503, { error: "知識の承認は設定されていません。" }); return true; }
    const cookie = parseCookie(req.headers.cookie, "ebi_auth");
    if (!cookie || !tokenMatches(cookie, auth.token)) {
      if (url.pathname === "/knowledge" && req.method === "GET") {
        res.writeHead(302, { Location: "/login?returnTo=/knowledge", "Cache-Control": "no-store" }); res.end();
      } else json(res, 401, { error: "ログインしてから知識を確認してください。" });
      return true;
    }
    if (url.pathname === "/knowledge" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      res.end(knowledgePageHtml()); return true;
    }
    try {
      if (url.pathname === "/api/knowledge" && req.method === "GET") {
        json(res, 200, await service.list()); return true;
      }
      if (req.method !== "POST") { json(res, 405, { error: "Method not allowed" }); return true; }
      let origin: URL | null = null;
      try { origin = new URL(String(req.headers.origin)); } catch { /* reject below */ }
      if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) {
        json(res, 403, { error: "同じ画面から操作してください。" }); return true;
      }
      const input = await body(req);
      if (url.pathname === "/api/knowledge/from-feedback") {
        if (typeof input.caseId !== "string" || typeof input.feedbackId !== "string" ||
            input.caseId.length > 100 || input.feedbackId.length > 100) throw new Error("Knowledge origin invalid");
        await service.capture(input.caseId, input.feedbackId);
        json(res, 200, { saved: true }); return true;
      }
      const match = url.pathname.match(/^\/api\/knowledge\/([a-zA-Z0-9._-]+)\/(revise|activate|deprecate|retry)$/);
      if (!match) { json(res, 404, { error: "知識候補がありません。" }); return true; }
      if (match[2] === "retry") {
        json(res, 200, await service.retry(match[1], typeof input.expectedSha256 === "string" ? input.expectedSha256 : ""));
        return true;
      }
      json(res, 200, await service.decide(match[1], match[2] as "revise" | "activate" | "deprecate", {
        requestId: typeof input.requestId === "string" ? input.requestId : "",
        expectedSha256: typeof input.expectedSha256 === "string" ? input.expectedSha256 : "",
        fields: input.fields, reason: typeof input.reason === "string" ? input.reason : undefined }));
    } catch { json(res, 409, { error: "保存できませんでした。版・根拠・入力を確認して画面を更新してください。" }); }
    return true;
  };
}
