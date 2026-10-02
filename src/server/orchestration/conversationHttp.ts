import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { LocalTaskService } from "./taskService.ts";
import type { LocalTaskAuthoringService } from "./taskAuthoring.ts";
import type { ConversationSource, MasterOrigin } from "../../shared/conversations.ts";
import { conversationTarget as target } from "../../shared/conversations.ts";
import { conversationPageHtml } from "./conversationPage.ts";

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}

export function createConversationHttp(tasks: LocalTaskService | null, authoring: LocalTaskAuthoringService | null, auth: AuthConfig) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!["/conversations", "/api/conversations/origin", "/api/conversations/origins"].includes(url.pathname)) return false;
    if (req.method !== "GET") { json(res, 405, { error: "この画面は記録の読み取り専用です。" }); return true; }
    const cookie = parseCookie(req.headers.cookie, "ebi_auth");
    if (!auth.token || !cookie || !tokenMatches(cookie, auth.token)) {
      if (url.pathname === "/conversations") {
        let destination = "/conversations";
        try { const t = target(url); destination += t.draft ? "?draft=" + t.draft : "?run=" + t.run + "&source=" + t.source; }
        catch { /* keep the invalid target empty, never choose another conversation */ }
        res.writeHead(302, { Location: "/login?returnTo=" + encodeURIComponent(destination), "Cache-Control": "no-store" }); res.end();
      } else json(res, 401, { error: "ログインして元の会話を確認してください。" });
      return true;
    }
    if (url.pathname === "/conversations") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      res.end(conversationPageHtml()); return true;
    }
    if (!tasks) { json(res, 503, { error: "Taskと会話の記録が設定されていません。" }); return true; }
    try {
      const t = target(url);
      const task = t.run ? tasks.list().find(item => item.id === t.run) : null;
      if (t.run && !task) { json(res, 404, { error: "指定されたTaskがありません。別の会話は開きません。" }); return true; }
      if (url.pathname === "/api/conversations/origins") {
        if (!t.run) throw new Error("Task source list required");
        const requested = await tasks.requestOrigin(t.run);
        const created = await authoring?.runConversationOrigin(t.run) ?? null;
        json(res, 200, { requested: requested?.kind === "master" ? requested : null, created: created?.origin ?? null }); return true;
      }
      const creation = t.draft ? await authoring?.conversationOrigin(t.draft) :
        t.source === "created" && t.run ? await authoring?.runConversationOrigin(t.run) : null;
      if (t.source === "created" && !creation) { json(res, 404, { error: "契約案を作成した会話の記録がありません。" }); return true; }
      const recorded = creation?.origin ?? (t.run ? await tasks.requestOrigin(t.run) : null);
      const origin: MasterOrigin | null = recorded?.kind === "master" ? recorded : null;
      const evidence = origin ? await tasks.originEvidence(origin) : { state: recorded?.kind === "browser" ? "browser" as const : "missing" as const,
        message: recorded?.kind === "browser" ? "このTaskは利用者がTask画面から開始しました。統括からの委任記録はありません。" : "元の会話が過去の記録に残っていません。現在の会話へ置き換えて表示しません。",
        workId: null, model: null, effort: null, sentAt: null, input: null, finalText: null, outcome: null, inputSha256: null, outcomeSha256: null };
      const result: ConversationSource = { title: task?.title ?? creation!.title, source: t.source, origin,
        taskHref: t.run ? "/tasks?run=" + encodeURIComponent(t.run) : null,
        planHref: creation ? "/task-plans?draft=" + creation.draftId : null, ...evidence };
      json(res, 200, result);
    } catch { json(res, 409, { error: "元の会話を照合できません。記録を確認してください。再実行は行っていません。" }); }
    return true;
  };
}
