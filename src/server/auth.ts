// アプリ層のトークン認証（スマホ/LAN外アクセス対応の多層防御の「アプリ層」担当）。
//
// 設計方針（docs/plans/mobile-access-plan.md §3 準拠）:
// - 環境変数 `EBI_AUTH_TOKEN` の共有シークレットで HTTP 入口・WS ハンドシェイク・
//   非 loopback からの制御API を一括ゲートする。
// - **二段判定**: loopback（127.0.0.1 / ::1）からのアクセスは常に無認証で通す。
//   これにより master 仲介の内部制御API 呼び（エビ間 MCP）や、母艦上のローカル利用
//   （localhost:5173 / :8787）を認証で壊さない。
// - **安全側デフォルト**: `EBI_AUTH_TOKEN` 未設定のときは、非 loopback からのアクセスを
//   すべて拒否する（bind を広げても認証が無い状態では外部に一切開かない）。
// - トークン照合は定数時間比較（timingSafeEqual）。失敗には軽いレート制限＋固定ディレイ。

import type { IncomingMessage } from "node:http";
import { material3Styles, negiBrand } from "../shared/material3.ts";
import { timingSafeEqual } from "node:crypto";

/** 認証設定。token=null は「EBI_AUTH_TOKEN 未設定」を表す。 */
export interface AuthConfig {
  /** 共有シークレット。未設定なら null（＝非 loopback は全拒否の安全側デフォルト）。 */
  token: string | null;
}

/** 環境変数から認証設定を読む。空文字は未設定扱い（null）。 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const raw = env.EBI_AUTH_TOKEN?.trim();
  return { token: raw && raw.length > 0 ? raw : null };
}

/**
 * リクエスト元が loopback（母艦ローカル）か判定する。
 * IPv4 loopback / IPv6 loopback / IPv4-mapped IPv6 を許容する。
 * remoteAddress が取得できない場合は「非 loopback」として扱う（安全側）。
 */
export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** 認証判定の結果。ok=false のとき reason で理由を区別する。 */
export type AuthOutcome =
  | { ok: true }
  | { ok: false; reason: "no-token-config" | "invalid-token" };

/**
 * 認証判定の中核（HTTP / WS 共通）。
 * - loopback → 常に許可（内部呼び・ローカル利用を壊さない）。
 * - 非 loopback かつ token 未設定 → 拒否（no-token-config・安全側デフォルト）。
 * - 非 loopback かつ token 設定あり → 提示トークンを定数時間比較。
 */
export function authorize(
  req: IncomingMessage,
  loopback: boolean,
  config: AuthConfig,
  query?: URLSearchParams,
): AuthOutcome {
  if (loopback) return { ok: true };
  if (!config.token) return { ok: false, reason: "no-token-config" };
  const provided = extractToken(req, query);
  if (provided && tokenMatches(provided, config.token)) return { ok: true };
  return { ok: false, reason: "invalid-token" };
}

/**
 * リクエストから提示トークンを抽出する。優先順:
 *  1. `Authorization: Bearer <token>`（API/curl 向け）
 *  2. Cookie `ebi_auth`（ブラウザのログイン後・WS ハンドシェイクにも自動付与される）
 *  3. クエリ `?token=`（WS で Cookie を使えない環境向けのフォールバック）
 */
export function extractToken(req: IncomingMessage, query?: URLSearchParams): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const cookie = parseCookie(req.headers["cookie"], "ebi_auth");
  if (cookie) return cookie;
  if (query) {
    const t = query.get("token");
    if (t) return t;
  }
  return null;
}

/** Cookie ヘッダから指定名の値を取り出す（最小パーサ）。 */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

/** 定数時間のトークン比較。長さ不一致は即 false（ただし比較自体は timingSafeEqual）。 */
export function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** ログイン成功時に発行する Cookie 文字列（Set-Cookie 用）。 */
export function buildAuthCookie(token: string): string {
  // 平文 HTTP（Tailscale の WireGuard 暗号化に依存）想定のため Secure は付けない。
  // HttpOnly で JS からの窃取を防ぎ、SameSite=Lax で最低限の CSRF 耐性。
  // Max-Age は約 400 日（ブラウザ上限）。一度入れれば再入力不要にする。
  const maxAge = 400 * 24 * 60 * 60;
  return `ebi_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// ===== 軽量レート制限（ブルートフォース対策・インメモリ）=====
// IP 単位で失敗回数を数え、閾値超過で一定時間ブロックする。プロセス再起動でリセットされる
// 簡易実装（単一オーナー運用・Tailscale 閉域が前提のため軽めで十分）。

interface RateEntry {
  failures: number;
  blockedUntil: number;
}

const MAX_FAILURES = 8; // この回数連続失敗でブロック
const BLOCK_MS = 60_000; // ブロック時間
const rateMap = new Map<string, RateEntry>();

/** 失敗の固定ディレイ（総当たり速度を落とす）。呼び出し側で await する。 */
export const FAILURE_DELAY_MS = 400;

function keyOf(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * レート制限チェック。ブロック中なら { blocked:true, retryAfterMs }。
 * `now` は将来の差し替え（テスト）用に注入可能。既定は Date.now()。
 */
export function checkRateLimit(
  req: IncomingMessage,
  now: number = Date.now(),
): { blocked: boolean; retryAfterMs: number } {
  const entry = rateMap.get(keyOf(req));
  if (entry && entry.blockedUntil > now) {
    return { blocked: true, retryAfterMs: entry.blockedUntil - now };
  }
  return { blocked: false, retryAfterMs: 0 };
}

/** 認証失敗を記録する。閾値到達でブロック期間を設定する。 */
export function recordFailure(req: IncomingMessage, now: number = Date.now()): void {
  const key = keyOf(req);
  const entry = rateMap.get(key) ?? { failures: 0, blockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.blockedUntil = now + BLOCK_MS;
    entry.failures = 0; // ブロック解除後は仕切り直し
  }
  rateMap.set(key, entry);
}

/** 認証成功を記録する（失敗カウンタをリセット）。 */
export function recordSuccess(req: IncomingMessage): void {
  rateMap.delete(keyOf(req));
}

/** 指定 ms 待つ（失敗時の固定ディレイ用）。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 最小 `/login` ページ（自己完結の HTML 文字列）。
 * Vite のマルチページビルドに依存させず、本番 Node 配信・dev いずれでも同じものを返す。
 * トークンを入力→POST /login→サーバが Cookie をセット→ "/" へ遷移、の一枚。
 */
export function loginPageHtml(returnTo = "/"): string {
  const destination = ["/reviews", "/tasks", "/knowledge", "/setup", "/task-plans", "/integrations"].includes(returnTo) ? returnTo : "/";
  return `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ログイン · Negi-Teams</title><link rel="icon" type="image/svg+xml" href="/negi-icon.svg"><style>${material3Styles}
html,body{min-height:100%;}.negi-ui{min-height:100svh;display:grid;place-items:center;padding:24px max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));}.login-panel{width:100%;max-width:440px}.login-brand{margin-bottom:40px}.login-panel h1{font-size:32px;margin-bottom:12px}.login-panel .md-surface{padding:32px}.login-panel label{margin-top:24px}.login-panel input{font-size:16px}.login-panel button{width:100%;margin-top:20px}.login-panel #e{min-height:24px;margin-top:14px}
</style></head><body class="negi-ui"><main class="login-panel"><div class="login-brand">${negiBrand()}</div><form class="md-surface" id="f"><div class="md-eyebrow">WORKSPACE ACCESS</div><h1>ログイン</h1><p class="muted">アクセストークンでワークスペースを開きます。</p><label for="t">アクセストークン<input id="t" type="password" autocomplete="current-password" autofocus inputmode="text" required></label><button id="b" type="submit" class="md-primary">ワークスペースを開く</button><div id="e" class="md-message" role="alert"></div></form></main>
<script>
  var f = document.getElementById("f");
  var t = document.getElementById("t");
  var b = document.getElementById("b");
  var e = document.getElementById("e");
  // Remove credentials stored by older versions of this page.
  try { localStorage.removeItem("ebi_auth_token"); } catch (_) {}
  f.addEventListener("submit", function (ev) {
    ev.preventDefault();
    e.textContent = "";
    b.disabled = true;
    fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t.value }),
    }).then(function (r) {
      if (r.ok) {
        // The server's HttpOnly cookie persists the session. Do not copy the
        // shared secret to JavaScript-readable browser storage.
        location.href = "${destination}";
        return;
      }
      b.disabled = false;
      if (r.status === 429) { e.textContent = "試行回数が多すぎます。しばらく待って再試行してください。"; }
      else { e.textContent = "トークンが違います。"; }
    }).catch(function () {
      b.disabled = false;
      e.textContent = "通信エラーが発生しました。";
    });
  });
</script>
</body>
</html>`;
}
