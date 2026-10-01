import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { LocalTaskService } from "./taskService.ts";
import { isReviewRequestId } from "./humanReviewProof.ts";
import { taskPageHtml } from "./taskPage.ts";
import type { TaskOverview } from "../../shared/workspace.ts";
import { ConfigurationPendingError } from "./projectConfiguration.ts";

function json(res: ServerResponse, code: number, value: unknown) {
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
    if (bytes > 4000) throw new Error("Task request too large");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task object required");
  return value as Record<string, unknown>;
}
export function createTaskHttp(service: LocalTaskService | null, auth: AuthConfig, authoring=false,integrations=false) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/tasks" && url.pathname !== "/api/tasks" && !url.pathname.startsWith("/api/tasks/")) return false;
    if (!service || !auth.token) { json(res, 503, { error: "Task実行は設定されていません。" }); return true; }
    const cookie = parseCookie(req.headers.cookie, "ebi_auth");
    if (!cookie || !tokenMatches(cookie, auth.token)) {
      if (url.pathname === "/tasks" && req.method === "GET") {
        res.writeHead(302, { Location: "/login?returnTo=/tasks", "Cache-Control": "no-store" }); res.end();
      } else json(res, 401, { error: "ログインしてからTaskを開いてください。" });
      return true;
    }
    if (url.pathname === "/tasks" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      res.end(taskPageHtml(authoring,integrations)); return true;
    }
    if (url.pathname === "/api/tasks/capacity/summary") {
      if (req.method !== "GET") { json(res, 405, { error: "Method not allowed" }); return true; }
      try { json(res, 200, await service.capacitySnapshot()); }
      catch { json(res, 503, { error: "実行枠の状態を読み取れません。" }); }
      return true;
    }
    if (url.pathname === "/api/tasks/results/summary") {
      if (req.method !== "GET") { json(res, 405, { error: "Method not allowed" }); return true; }
      try { json(res, 200, (await service.resultNotifications()).slice(0, 20)); }
      catch { json(res, 503, { error: "結果通知を読み取れません。Taskの現在の状態を確認してください。" }); }
      return true;
    }
    if (url.pathname === "/api/tasks" && req.method === "GET") {
      if (url.searchParams.get("summary") !== "1") { json(res, 200, service.list()); return true; }
      const items = service.list(), views: TaskOverview[] = [];
      // Keep read/check concurrency bounded even for a full 100-run catalog.
      for (let offset = 0; offset < items.length; offset += 6) {
        views.push(...await Promise.all(items.slice(offset, offset + 6).map(async (item): Promise<TaskOverview> => {
          try {
            const v = await service.snapshot(item.id);
            return { id: v.id, title: v.title, project: v.project, status: v.status, canStart: v.canStart,
              live: v.live, reviewId: v.reviewId, approvalCount: v.approvals.length,
              resultRevisionCount: v.resultRevisionCount, error: v.error };
          } catch {
            return { ...item, project: null, status: "unknown", canStart: false, live: false, reviewId: null,
              approvalCount: 0, resultRevisionCount: 0, error: "現在の状態を読み取れません。詳細を確認してください。" };
          }
        })));
      }
      json(res, 200, views); return true;
    }
    const match = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9._-]+)(?:\/(start|stop|approval))?$/);
    if (!match) { json(res, 404, { error: "Taskがありません。" }); return true; }
    try {
      if (!match[2] && req.method === "GET") { json(res, 200, await service.snapshot(match[1])); return true; }
      if (req.method !== "POST" || !match[2]) { json(res, 405, { error: "Method not allowed" }); return true; }
      if (!sameOrigin(req)) { json(res, 403, { error: "同じ画面から操作してください。" }); return true; }
      const input = await body(req);
      if (!isReviewRequestId(input.requestId) || typeof input.configSha256 !== "string" ||
          !/^[0-9a-f]{64}$/i.test(input.configSha256)) throw new Error("Task identity invalid");
      if (match[2] === "approval" && (typeof input.approvalId !== "string" ||
          typeof input.approvalSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(input.approvalSha256) ||
          !["allow", "deny"].includes(input.decision as string))) throw new Error("Operation approval target invalid");
      const result = match[2] === "start" ? await service.start(match[1], input.configSha256, input.requestId) :
        match[2] === "stop" ? await service.stop(match[1], input.configSha256) :
          await service.decideApproval(match[1], input.configSha256, input.requestId,
            input.approvalId as string, input.approvalSha256 as string, input.decision as "allow" | "deny");
      json(res, 200, result);
    } catch(e) { json(res, 409, { error: e instanceof ConfigurationPendingError?e.message:"操作を確定できませんでした。再実行せず、画面を更新して現在の作業を確認してください。" }); }
    return true;
  };
}
