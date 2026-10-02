import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import { checkedStorageDecision, type LocalStorageConsole, type StorageConsoleState, type StorageOperation } from "./storageConsole.ts";
import { storagePageHtml } from "./storagePage.ts";

export function createStorageHttp(service: LocalStorageConsole | null, auth: AuthConfig, host: () => StorageConsoleState) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/storage" && url.pathname !== "/api/storage" && !url.pathname.startsWith("/api/storage/")) return false;
    if (!auth.token) { json(res, 503, { error: "保存状態を確認するには、サーバーにアクセストークンを設定してください。" });return true; }
    const cookie = parseCookie(req.headers.cookie, "ebi_auth");
    if (!cookie || !tokenMatches(cookie, auth.token)) {
      if (req.method === "GET" && url.pathname === "/storage") { res.writeHead(302, { Location: "/login?returnTo=/storage", "Cache-Control": "no-store" });res.end(); }
      else json(res, 401, { error: "ログインして保存状態を確認してください。" });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/storage") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      res.end(storagePageHtml());return true;
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/storage") {
        json(res, 200, service ? { available: true, ...await service.status() } : { available: false, ...host() });return true;
      }
      if (req.method !== "POST" || !["/api/storage/preview", "/api/storage/apply"].includes(url.pathname)) { json(res, 405, { error: "Method not allowed" });return true; }
      let sameOrigin = false;
      try { const origin = new URL(String(req.headers.origin));sameOrigin = ["http:", "https:"].includes(origin.protocol) && origin.host === req.headers.host; } catch {}
      if (!sameOrigin) { json(res, 403, { error: "このワークスペースの画面から操作してください。" });return true; }
      if (!service || !req.headers["content-type"]?.startsWith("application/json")) throw Error("Storage registration unavailable");
      const chunks: Buffer[] = [];let size = 0;
      for await (const chunk of req) { size += chunk.length;if (size > 4000) throw Error("Storage input limit");chunks.push(Buffer.from(chunk)); }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Storage input invalid");
      const row = input as Record<string, unknown>;
      if (url.pathname.endsWith("/preview")) {
        if (Object.keys(row).join() !== "operation" || !["authority-initialize", "stage-adopt", "runtime-adopt", "database-recover"].includes(String(row.operation))) throw Error("Storage preview fields invalid");
        json(res, 200, await service.preview(row.operation as StorageOperation));
      } else {
        if (Object.keys(row).sort().join() !== "confirmed,decision" || row.confirmed !== true || !host().maintenance) throw Error("Explicit maintenance confirmation required");
        json(res, 200, await service.apply(checkedStorageDecision(row.decision)));
      }
    } catch {
      json(res, 409, { error: "保存状態を照合できません。元の記録と確認IDを保持してください。保存する内容が変わっていないか、処理が終了しているかを確認してから、同じ確認内容を使って操作を続けてください。" });
    }
    return true;
  };
}
