import type { IncomingMessage, ServerResponse } from "node:http";
import { loginReturnTo, parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { LocalPolicyService } from "./policyService.ts";
import { policyPageHtml } from "./policyPage.ts";

function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value));
}
export function createPolicyHttp(service: LocalPolicyService | null, auth: AuthConfig, availability: "unconfigured" | "held" = "unconfigured") {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/policies" && url.pathname !== "/api/policies" && !url.pathname.startsWith("/api/policies/")) return false;
    const cookie = parseCookie(req.headers.cookie, "ebi_auth");
    if (!auth.token || !cookie || !tokenMatches(cookie, auth.token)) {
      if (auth.token && url.pathname === "/policies" && req.method === "GET") {
        res.writeHead(302, { Location: "/login?returnTo=" + encodeURIComponent(loginReturnTo(url.pathname + url.search)), "Cache-Control": "no-store" }); res.end();
      } else json(res, 401, { error: "ログインしてから比較を確認してください。" }); return true;
    }
    if (url.pathname === "/policies" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" }); res.end(policyPageHtml()); return true;
    }
    if (!service) { json(res, 503, { error: availability === "held" ? "比較の保存状態を確認できません。管理設定を確認してから画面を更新してください。" : "比較結果はまだ登録されていません。登録後に画面を更新してください。" }); return true; }
    try {
      if (url.pathname === "/api/policies" && req.method === "GET") { json(res, 200, await service.list()); return true; }
      if (req.method !== "POST") { json(res, 405, { error: "Method not allowed" }); return true; }
      let origin: URL | null = null; try { origin = new URL(String(req.headers.origin)); } catch { /* reject */ }
      if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) {
        json(res, 403, { error: "同じ画面から操作してください。" }); return true;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) throw Error("JSON required");
      const parts: Buffer[] = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 6000) throw Error("Policy request too large"); parts.push(Buffer.from(part)); }
      const input: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Policy object required");
      const data = input as Record<string, unknown>;
      const match = /^\/api\/policies\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/(approve|activate|rollback)$/.exec(url.pathname);
      if (!match) { json(res, 404, { error: "設定候補がありません。" }); return true; }
      if (Object.keys(data).some(key => !["requestId", "expectedSha256", "reason"].includes(key)) ||
          typeof data.requestId !== "string" || typeof data.expectedSha256 !== "string" ||
          data.reason !== undefined && typeof data.reason !== "string") throw Error("Policy input invalid");
      json(res, 200, await service.decide(match[1], match[2] as "approve" | "activate" | "rollback", {
        requestId: data.requestId, expectedSha256: data.expectedSha256, reason: data.reason as string | undefined }));
    } catch { json(res, 409, { error: "保存できませんでした。比較結果と対象の版を確認して画面を更新してください。" }); }
    return true;
  };
}
