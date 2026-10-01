import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { ReviewFeedback } from "./reviewChain.ts";
import type { LocalReviewService } from "./reviewService.ts";
import { isReviewRequestId } from "./humanReviewProof.ts";
import { reviewPageHtml } from "./reviewPage.ts";
import type { ReviewOverview } from "../../shared/workspace.ts";

function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
function sameOrigin(req: IncomingMessage): boolean {
  try {
    const origin = typeof req.headers.origin === "string" ? new URL(req.headers.origin) : null;
    return Boolean(origin && ["http:", "https:"].includes(origin.protocol) && origin.host === req.headers.host);
  } catch { return false; }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("JSON required");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_000) throw new Error("Review request too large");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review object required");
  return value as Record<string, unknown>;
}

/** Cookie authentication remains mandatory for reviews, including loopback. */
export function createReviewHttp(service: LocalReviewService | null, auth: AuthConfig) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/reviews" && url.pathname !== "/api/reviews" &&
        !url.pathname.startsWith("/api/reviews/")) return false;
    if (!service || !auth.token) { json(res, 503, { error: "成果レビューは設定されていません。" }); return true; }
    const cookie = parseCookie(req.headers.cookie, "ebi_auth");
    if (!cookie || !tokenMatches(cookie, auth.token)) {
      if (url.pathname === "/reviews" && req.method === "GET") {
        res.writeHead(302, { Location: "/login?returnTo=/reviews", "Cache-Control": "no-store" }); res.end();
      } else json(res, 401, { error: "ログインしてから成果レビューを開いてください。" });
      return true;
    }
    if (url.pathname === "/reviews" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      res.end(reviewPageHtml()); return true;
    }
    if (url.pathname === "/api/reviews" && req.method === "GET") {
      if (url.searchParams.get("summary") !== "1") { json(res, 200, service.list()); return true; }
      const items = service.list(), views: ReviewOverview[] = [];
      for (let offset = 0; offset < items.length; offset += 6) {
        views.push(...await Promise.all(items.slice(offset, offset + 6).map(async (item): Promise<ReviewOverview> => {
          try {
            const v = await service.snapshot(item.id);
            return { id: v.id, title: v.title, status: v.status, canAccept: v.canAccept,
              qualityIssue: v.qualityIssue, integrityError: v.integrityError };
          } catch {
            return { ...item, status: "unknown", canAccept: false, qualityIssue: false,
              integrityError: "現在の版を読み取れません。詳細を確認してください。" };
          }
        })));
      }
      json(res, 200, views); return true;
    }
    const match = url.pathname.match(/^\/api\/reviews\/([a-zA-Z0-9._-]+)(?:\/(accept|feedback|revoke))?$/);
    if (!match) { json(res, 404, { error: "レビュー対象がありません。" }); return true; }
    try {
      if (!match[2] && req.method === "GET") { json(res, 200, await service.snapshot(match[1])); return true; }
      if (req.method !== "POST" || !match[2]) { json(res, 405, { error: "Method not allowed" }); return true; }
      if (!sameOrigin(req)) { json(res, 403, { error: "同じ画面から操作してください。" }); return true; }
      const input = await body(req);
      if (!isReviewRequestId(input.requestId) || typeof input.artifactSha256 !== "string" ||
          !/^[0-9a-f]{64}$/i.test(input.artifactSha256)) throw new Error("Review identity invalid");
      const result = match[2] === "accept" ? await service.accept(match[1], input.artifactSha256, input.requestId) :
        match[2] === "feedback" ? await service.feedback(match[1], {
          artifactSha256: input.artifactSha256, requestId: input.requestId,
          text: typeof input.text === "string" ? input.text : "",
          kind: input.kind as ReviewFeedback["kind"], scope: input.scope as ReviewFeedback["scope"] }) :
          await service.revoke(match[1], input.artifactSha256, input.requestId,
            typeof input.reason === "string" ? input.reason : "");
      json(res, 200, result);
    } catch { json(res, 409, { error: "保存できませんでした。対象の版・入力・検証状態を確認して画面を更新してください。" }); }
    return true;
  };
}
