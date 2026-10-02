import type {
  ChatAttachment,
  ChatReplyRef,
  MasterChatEnvelope,
  MasterChatState,
  UsageMessage,
} from "../shared/protocol.ts";
import { taskResultDeliveryLabels, taskResultUpdateLabel } from "../shared/taskResults.ts";
import { taskStatusLabels } from "../shared/workspace.ts";
import { taskOriginHref } from "../shared/conversations.ts";
import {
  ChatTranscript,
  collectImages,
  firstUnsettledPending,
  formatBytes,
  formatContextPct,
  formatCost,
  headerMetrics,
  InputHistory,
  LARGE_PASTE_CHARS,
  MAX_CHAT_ITEMS,
  NO_RATE_LIMITS,
  oneLine,
  replyable,
  replyExcerpt,
  sendEnabled,
  settledLabel,
  stateLabel,
  stopEnabled,
  lightboxCounter,
  LightboxState,
  stringifyInput,
  summarizeToolInput,
  type ChatItem,
  type HeaderRateLimits,
} from "./chatModel.ts";
import { renderMarkdownInto } from "./viewer.ts";

/**
 * master チャットパネル（ui:"chat" の master をメイン領域に出す 1 枚）。
 *
 * 設計書: docs/design/master-chat-ui-2026-09-05.md §5.1〜§5.3（PR-M3）
 *
 * Dashboard / Viewer と同じ master-detail の 1 枚として振る舞う（setVisible()）。
 * xterm を一切使わないので、ログは**普通の DOM ブロック**（`overflow-y:auto`）。
 * スマホで指スクロールできない現行の問題は、この構造で消える（§5.3）。
 *
 * XSS 安全: assistant 本文は markdown.ts の自前パーサ経由（`textContent` 描画）で、
 * それ以外のテキストもすべて textContent。innerHTML には生コンテンツを入れない。
 *
 * 入力系（PR-M4）: ↑/↓ の入力履歴（localStorage 永続・直近 50 件）、画像のペースト/ドロップ添付
 * （サーバへ保存してから image ブロックとして送る）、大きな貼り付けのファイル誘導。
 *
 * 承認/質問（PR-M5）: pending バブルに実ボタンを出し、`chatAnswer` で応答を返す。
 * 承認は「許可 / 拒否」、質問は選択肢（複数選択は checkbox）＋「その他（自由入力）」。
 * 決着済みかどうかは `permissionSettled` イベント由来の `settled` で決まるので、
 * 再接続やサーバ再起動のあとでもボタンが復活したりしない。
 */
export class ChatPanel {
  private readonly head: HTMLElement;
  private readonly stateBadge: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly logEl: HTMLElement;
  private readonly newPill: HTMLButtonElement;
  private readonly pendingBar: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  /** 中断ボタン（PR-M11 で送信から分離。実行中だけ押せる）。 */
  private readonly stopBtn: HTMLButtonElement;
  /** 添付トレイ（送信前の画像サムネイル）。 */
  private readonly trayEl: HTMLElement;
  /** 大きな貼り付け・添付エラーの一時メッセージ。 */
  private readonly hintEl: HTMLElement;
  /** 送信待ちの添付（送信時にクリアする）。 */
  private readonly attachments: ChatAttachment[] = [];
  /** 引用プレビュー（返信先が選ばれている間だけ出す・PR-M11）。 */
  private readonly replyEl: HTMLElement;
  /** 選択中の返信先（送信でクリアする）。 */
  private replyTo: ChatReplyRef | null = null;
  /** ↑/↓ の入力履歴（localStorage 永続）。 */
  private readonly history: InputHistory;
  private hintTimer: number | null = null;

  private readonly transcript = new ChatTranscript();
  /** items と 1:1 で並ぶ描画済み要素（増分更新のため index で引く）。 */
  private readonly rendered: HTMLElement[] = [];
  private state: MasterChatState = "stopped";
  private codexReadOnly = false;
  private pending = 0;
  private visible = false;
  /** 最下部に張り付いているか（false のとき新着で勝手にスクロールしない）。 */
  private stuckToBottom = true;
  /** 追従を切った後に届いた新着の件数（「⬇ 新着 N 件」ピル用）。 */
  private unseen = 0;
  /** 予約中の追従スクロール（rAF ハンドル・0 なら未予約）。scrollToBottom() を参照。 */
  private scrollRaf = 0;
  /** 「これより前はログファイルにのみ残っています」の行（ログ先頭に 1 本だけ）。 */
  private moreRow: HTMLElement | null = null;
  /** master の agent id（chatState 受信で確定する）。 */
  private masterId: string | null = null;
  private disconnected = false;
  private pendingCodexSend: { requestId: string; text: string; draft: string; replyTo: ChatReplyRef | null } | null = null;
  /** アカウント枠（WS `usage` 由来・ヘッダ表示用）。未受信は「—」。 */
  private rateLimits: HeaderRateLimits = NO_RATE_LIMITS;
  /** ライトボックス（PR-M10）の状態機械。DOM 側はこの値を描画するだけ。 */
  private readonly lightbox = new LightboxState();
  /** ライトボックスの DOM（初回オープン時に作って body へ足す）。 */
  private lightboxUi: LightboxUi | null = null;
  /** ライトボックスを開く直前にフォーカスしていた要素（閉じたら戻す）。 */
  private lightboxOpener: HTMLElement | null = null;
  private newConversationDialog: HTMLDialogElement | null = null;
  private newConversationConfirm: HTMLButtonElement | null = null;
  private newConversationTarget: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly onSend: (
      id: string,
      text: string,
      attachments: ChatAttachment[],
      replyTo: ChatReplyRef | null,
      requestId?: string,
    ) => void | boolean,
    private readonly onStop: (id: string) => void,
    private readonly onNew: (id: string) => void,
    /** 承認/質問への応答（PR-M5）。WS `chatAnswer` を送る。 */
    private readonly onAnswer: (
      id: string,
      requestId: string,
      answer: { allow?: boolean; choice?: string[]; text?: string },
    ) => void = () => {},
  ) {
    this.el.classList.add("chat");

    // ---- ヘッダ（状態 / コスト・文脈 / 新しい会話）----
    this.head = div("chat-head");
    const title = span("chat-title", "統括");
    this.stateBadge = span("chat-state", stateLabel(this.state));
    this.statsEl = span("chat-stats", "");
    this.newBtn = document.createElement("button");
    this.newBtn.className = "chat-new";
    this.newBtn.textContent = "新しい会話";
    this.newBtn.title = "文脈をリセットし、画面を新しい会話へ切り替えます";
    this.newBtn.addEventListener("click", () => this.showNewConversationDialog());
    this.head.append(title, this.stateBadge, this.statsEl, this.newBtn);

    // ---- ログ ----
    this.logEl = div("chat-log");
    this.logEl.addEventListener("scroll", () => this.onScroll());

    // 追従を切っている間の新着通知ピル。押すと最下部へ戻る。
    this.newPill = document.createElement("button");
    this.newPill.className = "chat-newpill";
    this.newPill.hidden = true;
    this.newPill.addEventListener("click", () => this.scrollToBottom(true));

    // ---- 入力欄 ----
    const foot = div("chat-foot");
    this.pendingBar = document.createElement("button");
    this.pendingBar.className = "chat-pending-bar";
    this.pendingBar.hidden = true;
    this.pendingBar.title = "クリックすると未応答の承認/質問までスクロールします";
    this.pendingBar.addEventListener("click", () => this.scrollToPending());
    this.input = document.createElement("textarea");
    this.input.className = "chat-input";
    this.input.rows = 1;
    this.input.placeholder = "依頼・相談";
    this.input.title = "Enter で送信 / Shift+Enter で改行";
    this.input.setAttribute("aria-label", "統括へのメッセージ");
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", () => this.autoGrow());
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    // ドロップは入力欄だけでなくパネル全体で受ける（ログ側に落としても添付できる）。
    this.el.addEventListener("dragover", (e) => {
      if (!this.hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      this.el.classList.add("dragover");
    });
    this.el.addEventListener("dragleave", () => this.el.classList.remove("dragover"));
    this.el.addEventListener("drop", (e) => this.onDrop(e));
    // 停止は送信とは別のボタンにする（PR-M11）。同じボタンが状態で意味を変えると、
    // 走行中の master へ話しかけたつもりが中断になる（2026-09-05 の事故）。
    this.stopBtn = document.createElement("button");
    this.stopBtn.className = "chat-stop";
    this.stopBtn.textContent = "\u23f9";
    this.stopBtn.title = "実行中のターンを中断します（会話は消えません）";
    this.stopBtn.setAttribute("aria-label", "停止");
    this.stopBtn.addEventListener("click", () => this.onStopClick());
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "chat-send";
    this.sendBtn.textContent = "送信";
    this.sendBtn.addEventListener("click", () => this.onSendClick());
    const row = div("chat-input-row");
    row.append(this.input, this.stopBtn, this.sendBtn);
    this.replyEl = div("chat-reply");
    this.replyEl.hidden = true;
    this.trayEl = div("chat-tray");
    this.trayEl.hidden = true;
    this.hintEl = div("chat-hint");
    this.hintEl.setAttribute("role", "status");
    this.hintEl.setAttribute("aria-live", "polite");
    this.hintEl.hidden = true;
    foot.append(this.pendingBar, this.hintEl, this.replyEl, this.trayEl, row);

    const body = div("chat-body");
    body.append(this.logEl, this.newPill);
    this.el.append(this.head, body, foot);
    this.history = new InputHistory(safeLocalStorage());
    this.history.load();
    window.addEventListener("resize", () => { if (this.visible) this.autoGrow(); });
    this.syncControls();
  }

  /** chat モードの master が居るか（居なければ main.ts は従来の PTY ペインを出す）。 */
  get chatMasterId(): string | null {
    return this.masterId;
  }

  /** 表示/非表示（master-detail の 1 枚として）。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.el.hidden = !visible;
    // 表示に切り替えた瞬間は最下部へ寄せる（隠れている間の新着を見せる）。
    if (visible) { this.autoGrow(); this.scrollToBottom(true); }
  }

  /** WS `chatState`。chat モードの master が居ることの判定材料も兼ねる。 */
  applyState(id: string, state: MasterChatState, pending: number): void {
    this.disconnected = false;
    this.masterId = id;
    this.state = state;
    this.pending = pending;
    this.stateBadge.textContent = stateLabel(state);
    this.stateBadge.className = `chat-state state-${state}`;
    this.syncControls();
  }

  /** registry may arrive before or after chatState. */
  setCodexReadOnly(enabled: boolean): void {
    this.codexReadOnly = enabled;
    this.newBtn.title = enabled
      ? "Codexの会話切替は準備中です。現在の会話と結果の記録は保持されます。"
      : "文脈をリセットし、画面を新しい会話へ切り替えます";
    this.syncControls();
    this.updateStats();
  }

  /** WS `chatSnapshot`（接続直後・再接続時の一括復元）。 */
  applySnapshot(envelopes: readonly MasterChatEnvelope[], hasMore: boolean): void {
    if (this.pendingCodexSend && envelopes.some(({ event }) => event.kind === "user" &&
        event.requestId === this.pendingCodexSend!.requestId)) this.finishCodexSend(true);
    this.transcript.reset(envelopes);
    this.transcript.trim(MAX_CHAT_ITEMS);
    // アイテムが総入れ替えになるので、開いていたライトボックスは畳む（key が変わりうる）。
    this.closeLightbox();
    this.renderAll(hasMore);
    this.scrollToBottom(true);
  }

  /** WS `chatEvent`（live 1 件）。 */
  applyEvent(envelope: MasterChatEnvelope): void {
    if (envelope.event.kind === "user" && envelope.event.requestId === this.pendingCodexSend?.requestId &&
        this.pendingCodexSend) this.finishCodexSend(true);
    const change = this.transcript.apply(envelope);
    if (change.touched.length === 0) return;
    const wasBottom = this.stuckToBottom;
    if (change.cleared) {
      // 「新しい会話」の区切り。index が総入れ替えなので増分更新はできない。
      this.renderAll(false);
    } else {
      for (const index of change.touched) this.renderItem(index);
      this.trimOverflow();
    }
    this.updateStats();
    // 開いたまま新しい画像が届いたら送り先（と枚数表示）を更新する。
    if (this.lightbox.isOpen) this.syncLightbox();
    if (wasBottom) {
      this.scrollToBottom(false);
    } else if (change.appendedFrom >= 0) {
      this.unseen += 1;
      this.updatePill();
    }
  }

  /** 接続が切れたときの表示（再接続で snapshot が来れば戻る）。 */
  markDisconnected(): void {
    this.disconnected = true;
    this.stateBadge.textContent = "切断（再接続中…）";
    this.stateBadge.className = "chat-state state-stopped";
    if (this.pendingCodexSend) this.showHint("送信結果を確認できません。入力を保持しています。会話履歴の照合を待ち、自動再送しません。", "error");
    this.syncControls();
  }

  applySendResult(id: string, requestId: string, accepted: boolean, reason?: string): void {
    if (id !== this.masterId || requestId !== this.pendingCodexSend?.requestId) return;
    this.finishCodexSend(accepted);
    if (!accepted) this.showHint(reason ?? "送信できませんでした。入力を保持しています。", "error");
  }

  private finishCodexSend(accepted: boolean): void {
    const pending = this.pendingCodexSend;
    if (!pending) return;
    this.pendingCodexSend = null;
    if (accepted) {
      this.hintEl.hidden = true;
      if (this.hintTimer !== null) { window.clearTimeout(this.hintTimer); this.hintTimer = null; }
      this.history.push(pending.text);
      if (this.input.value === pending.draft) { this.input.value = ""; this.autoGrow(); }
      if (this.replyTo === pending.replyTo) this.setReplyTo(null);
    }
    this.syncControls();
  }

  /** 入力欄へフォーカス（広幅のみ。狭幅は勝手にソフトキーボードを出さない）。 */
  focusInput(): void {
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    this.input.focus();
  }

  // ===== 内部 =====

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return; // IME 変換中のキーはすべて変換操作（履歴も送信も動かさない）。
    // ↑/↓ の入力履歴。複数行を編集しているときの行移動を邪魔しないよう、
    // ↑ は「キャレットが先頭」、↓ は「キャレットが末尾」のときだけ履歴として振る舞う。
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey) {
      const atStart = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
      const atEnd =
        this.input.selectionStart === this.input.value.length &&
        this.input.selectionEnd === this.input.value.length;
      if (e.key === "ArrowUp" && (atStart || this.history.navigating)) {
        const text = this.history.prev(this.input.value);
        if (text !== null) {
          e.preventDefault();
          this.setInputValue(text);
        }
        return;
      }
      if (e.key === "ArrowDown" && (atEnd || this.history.navigating)) {
        const text = this.history.next();
        if (text !== null) {
          e.preventDefault();
          this.setInputValue(text);
        }
        return;
      }
      return;
    }
    // Enter 送信 / Shift+Enter 改行。
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    this.onSendClick();
  }

  /** 履歴から取り出した本文を入力欄へ入れ、キャレットを末尾に置く。 */
  private setInputValue(text: string): void {
    this.input.value = text;
    this.autoGrow();
    const end = text.length;
    this.input.setSelectionRange(end, end);
  }

  private onSendClick(): void {
    if (!this.masterId) return;
    if (this.disconnected || this.pendingCodexSend) return;
    if (this.codexReadOnly && this.state === "busy") return;
    // busy 中も送れる（走行中ターンに合流する）。送れないのは頭脳が居ないときだけ。
    if (!sendEnabled(this.state)) return;
    const text = this.input.value.trim();
    // 添付だけで送るケース（画像を貼って Enter）も許す。
    if (!text && this.attachments.length === 0) return;
    if (this.codexReadOnly && this.attachments.length > 0) {
      this.showHint("Codex master の添付ファイル入力は未対応です", "error");
      return;
    }
    if (this.codexReadOnly) {
      const requestId = crypto.randomUUID();
      this.pendingCodexSend = { requestId, text, draft: this.input.value, replyTo: this.replyTo };
      this.syncControls();
      if (this.onSend(this.masterId, text, [], this.replyTo, requestId) === false) {
        this.finishCodexSend(false);
        this.markDisconnected();
        this.showHint("接続が切れています。今回の入力は未送信で、入力欄に保持しています。", "error");
      }
      return;
    }
    if (this.onSend(this.masterId, text, [...this.attachments], this.replyTo) === false) {
      this.markDisconnected();
      this.showHint("接続が切れています。今回の入力は未送信で、入力欄に保持しています。", "error");
      return;
    }
    this.history.push(text);
    this.attachments.length = 0;
    this.setReplyTo(null);
    this.renderTray();
    this.input.value = "";
    this.autoGrow();
    this.scrollToBottom(true);
  }

  /** ⏹ の押下。実行中ターンだけを中断する（会話は殺さない）。 */
  private onStopClick(): void {
    if (!this.masterId) return;
    if (!stopEnabled(this.state)) return;
    this.onStop(this.masterId);
  }

  // ---- 添付（ペースト / ドロップ）----

  /** DataTransfer にファイルが含まれるか（ドラッグ中はまだ items しか見えない）。 */
  private hasFiles(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    if (dt.files?.length) return true;
    return Array.from(dt.items ?? []).some((i) => i.kind === "file");
  }

  /**
   * 貼り付け。
   *  - 画像が含まれていれば添付として取り込む（既定のテキスト貼り付けは行わない）
   *  - テキストが LARGE_PASTE_CHARS を超えていたらファイルに落とし、**パスを入力欄へ添える**
   *    （長文をそのまま送ると 1 ターンの入力が跳ね上がるため。設計書 §9 PR-M4）
   */
  private onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData;
    if (!dt) return;
    const images = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) {
      e.preventDefault();
      if (this.codexReadOnly) {
        this.showHint("Codex master の画像入力は未対応です", "error");
        return;
      }
      void this.attachFiles(images);
      return;
    }
    const text = dt.getData("text/plain");
    if (text.length > LARGE_PASTE_CHARS) {
      e.preventDefault();
      void this.spillLargePaste(text);
    }
  }

  private onDrop(e: DragEvent): void {
    this.el.classList.remove("dragover");
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    if (this.codexReadOnly) {
      this.showHint("Codex master の画像入力は未対応です", "error");
      return;
    }
    void this.attachFiles(files);
  }

  /** 画像をサーバへ保存し、添付トレイへ積む。 */
  private async attachFiles(files: readonly File[]): Promise<void> {
    for (const file of files) {
      try {
        const saved = await uploadAttachment(file, file.type);
        this.attachments.push(saved);
        this.renderTray();
      } catch (err) {
        this.showHint(`添付に失敗しました: ${(err as Error).message}`, "error");
      }
    }
  }

  /**
   * 大きな貼り付けをファイルへ落として、入力欄にはパスだけを残す。
   * 保存に失敗したときは**そのまま貼り付ける**（入力を失わせない）。
   */
  private async spillLargePaste(text: string): Promise<void> {
    try {
      const saved = await uploadAttachment(new Blob([text], { type: "text/plain" }), "text/plain");
      const note = `${saved.path}`;
      const cur = this.input.value;
      const sep = cur.length > 0 && !cur.endsWith("\n") ? "\n" : "";
      this.setInputValue(`${cur}${sep}${note}\n`);
      this.showHint(
        `貼り付けが長い（${text.length.toLocaleString("ja-JP")} 文字）ためファイルに保存しました。` +
          `パスを入力欄に添えたので、そのまま送ると master がファイルとして読みます（${formatBytes(saved.bytes)}）`,
        "info",
      );
    } catch (err) {
      this.setInputValue(this.input.value + text);
      this.showHint(`長文の保存に失敗したのでそのまま貼り付けました: ${(err as Error).message}`, "error");
    }
  }

  /** 添付トレイ（送信前のサムネイル）を描き直す。 */
  private renderTray(): void {
    this.trayEl.innerHTML = "";
    this.trayEl.hidden = this.attachments.length === 0;
    for (const [i, a] of this.attachments.entries()) {
      const chip = div("chat-chip");
      const img = document.createElement("img");
      img.className = "chat-chip-thumb";
      img.src = a.url;
      img.alt = a.name;
      const label = span("chat-chip-name", `${a.name}（${formatBytes(a.bytes)}）`);
      label.title = a.path;
      const del = document.createElement("button");
      del.className = "chat-chip-del";
      del.textContent = "✕";
      del.title = "この添付を外す";
      del.addEventListener("click", () => {
        this.attachments.splice(i, 1);
        this.renderTray();
      });
      chip.append(img, label, del);
      this.trayEl.appendChild(chip);
    }
  }

  /** 入力欄の上に一時メッセージを出す（大きな貼り付けの誘導・添付エラー）。 */
  private showHint(text: string, level: "info" | "error"): void {
    this.hintEl.textContent = text;
    this.hintEl.className = `chat-hint level-${level}`;
    this.hintEl.hidden = false;
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hintEl.hidden = true;
      this.hintTimer = null;
    }, 15_000);
  }

  /** 入力欄の高さを内容に合わせる（最大 6 行程度）。 */
  private autoGrow(): void {
    // 空のときは CSS 既定（1 行）へ戻す。明示 height を残すと空欄が伸びたままになる。
    if (this.input.value.length === 0) {
      this.input.style.height = "";
      return;
    }
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  /** 状態に応じて送信ボタン・入力欄・pending バーを更新する。 */
  private syncControls(): void {
    const blocked = this.disconnected || Boolean(this.pendingCodexSend) || !sendEnabled(this.state) ||
      (this.codexReadOnly && this.state === "busy");
    this.sendBtn.disabled = blocked;
    this.stopBtn.disabled = !stopEnabled(this.state);
    this.input.disabled = blocked;
    this.input.placeholder = blocked
      ? this.pendingCodexSend
        ? "送信結果を確認しています（入力は保持されます）"
        : this.codexReadOnly && this.state === "busy"
        ? "統括の応答が終わるまでお待ちください"
        : "統括が起動していません…"
      : this.state === "busy"
        ? "実行中でも送れます（Enter で送信 / 中断は ⏹）"
        : "依頼・相談";
    this.newBtn.disabled = !this.masterId || this.disconnected || this.codexReadOnly || this.state === "starting";
    if (this.newConversationConfirm) this.newConversationConfirm.disabled = this.newBtn.disabled;
    // A confirmation applies only to the Master and connection the user saw when opening it.
    if (this.newConversationDialog?.open &&
        (this.newBtn.disabled || this.newConversationTarget !== this.masterId)) {
      this.newConversationDialog.close();
    }
    if (this.pending > 0) {
      this.pendingBar.hidden = false;
      this.pendingBar.textContent =
        `未応答の承認/質問が ${this.pending} 件あります（応答するまで統括は待機します）`;
    } else {
      this.pendingBar.hidden = true;
    }
  }

  private showNewConversationDialog(): void {
    if (this.newBtn.disabled || !this.masterId) return;
    if (!this.newConversationDialog) {
      const dialog = document.createElement("dialog");
      dialog.className = "md-dialog chat-new-dialog";
      const title = document.createElement("h2");
      title.id = "chat-new-dialog-title";
      title.textContent = "新しい会話を始めますか？";
      const copy = document.createElement("p");
      copy.id = "chat-new-dialog-description";
      copy.textContent = "現在の応答と未回答の確認を終了し、新しい会話を準備します。準備が整ってから表示と使用量を切り替えます。入力中のメッセージと過去の記録は残ります。";
      dialog.setAttribute("aria-labelledby", title.id);
      dialog.setAttribute("aria-describedby", copy.id);
      const actions = div("md-actions");
      const cancel = document.createElement("button");
      cancel.className = "md-text";
      cancel.textContent = "今の会話を続ける";
      cancel.autofocus = true;
      cancel.addEventListener("click", () => dialog.close());
      const confirm = document.createElement("button");
      confirm.className = "md-primary";
      confirm.textContent = "新しい会話を始める";
      confirm.addEventListener("click", () => {
        const target = this.newConversationTarget;
        if (!target || target !== this.masterId || this.newBtn.disabled) return;
        dialog.close();
        // Only the server's cleared event resets the transcript and metrics.
        this.onNew(target);
      });
      actions.append(cancel, confirm);
      dialog.append(title, copy, actions);
      dialog.addEventListener("keydown", event => containDialogFocus(dialog, event));
      dialog.addEventListener("close", () => { this.newConversationTarget = null; });
      this.el.append(dialog);
      this.newConversationDialog = dialog;
      this.newConversationConfirm = confirm;
    }
    this.newConversationTarget = this.masterId;
    this.newConversationConfirm!.disabled = false;
    if (!this.newConversationDialog.open) this.newConversationDialog.showModal();
  }

  /** 未応答の承認/質問までスクロールする（スティッキーバーのクリック）。 */
  private scrollToPending(): void {
    const index = firstUnsettledPending(this.transcript.items);
    const el = index >= 0 ? this.rendered[index] : null;
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1200);
  }

  // ===== 返信（引用）=====

  /** 返信先を選ぶ / 解除する（null で解除）。入力欄へフォーカスを戻す。 */
  private setReplyTo(ref: ChatReplyRef | null): void {
    this.replyTo = ref;
    this.renderReplyPreview();
    if (ref) this.input.focus();
  }

  /** 入力欄の上に出す引用プレビュー（抜粋クリックで引用元へジャンプ・✕ で解除）。 */
  private renderReplyPreview(): void {
    this.replyEl.replaceChildren();
    const ref = this.replyTo;
    if (!ref) {
      this.replyEl.hidden = true;
      return;
    }
    this.replyEl.hidden = false;
    const jump = document.createElement("button");
    jump.className = "chat-reply-jump";
    jump.textContent = `↩︎ master#${ref.seq} に返信: ${ref.excerpt}`;
    jump.title = "引用元へスクロールします";
    jump.addEventListener("click", () => this.jumpToSeq(ref.seq));
    const clear = document.createElement("button");
    clear.className = "chat-reply-clear";
    clear.textContent = "✕";
    clear.title = "返信をやめる";
    clear.setAttribute("aria-label", "返信を解除");
    clear.addEventListener("click", () => this.setReplyTo(null));
    this.replyEl.append(jump, clear);
  }

  /**
   * seq で示された発言までスクロールする（引用チップ / 引用プレビューのクリック）。
   * 表示中のトランスクリプトに無い（＝ログにしか残っていない）ときは何もしない。
   */
  private jumpToSeq(seq: number): void {
    const index = this.transcript.items.findIndex((it) => it.seq === seq);
    const el = index >= 0 ? this.rendered[index] : null;
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1200);
  }

  /** 返信ボタン / 引用チップから引ける「その seq が今の画面に居るか」。 */
  private hasSeq(seq: number): boolean {
    return this.transcript.items.some((it) => it.seq === seq);
  }

  private onScroll(): void {
    // 「最下部にいる」判定は 32px の遊びを持たせる（§5.3）。
    const atBottom =
      this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 32;
    this.stuckToBottom = atBottom;
    if (atBottom) {
      this.unseen = 0;
      this.updatePill();
    }
  }

  /**
   * 最下部へ追従する。
   *
   * `scrollHeight` の読み取りは**同期の強制リフロー**なので、DOM を書き換えた直後に呼ぶと
   * ログ全体のレイアウトが再計算される。ストリーミングは 1 トークンごとにここへ来るため、
   * 素直に書くと 1 トークンのコストが「溜まったログの量」に比例して伸びる
   *（実測 3,589 アイテムで 25ms/token・docs/log-heavy-PLAN.md §3）。
   *
   * そこで実際のスクロールだけを rAF へ逃がし、**1 フレームに 1 回**へ畳む。
   * 追従フラグやピルの更新は DOM を読まないので同期のままでよい。
   */
  private scrollToBottom(force: boolean): void {
    if (!this.visible && !force) return;
    this.stuckToBottom = true;
    this.unseen = 0;
    this.updatePill();
    if (this.scrollRaf !== 0) return; // 同じフレームの重複要求は合流させる。
    this.scrollRaf = requestFrame(() => {
      this.scrollRaf = 0;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    });
  }

  private updatePill(): void {
    this.newPill.hidden = this.unseen === 0;
    this.newPill.textContent = `⬇ 新着 ${this.unseen} 件`;
  }

  /**
   * ヘッダのメトリクス（コスト / 文脈% / 5h・週次の枠）を描き直す（PR-M6）。
   * 値は要素ごとに span を分け、65/70/85% を跨いだものだけ色を付ける
   *（contextGuard の通知と同じ帯・chatModel.METRIC_THRESHOLDS）。
   */
  private updateStats(): void {
    this.statsEl.textContent = "";
    const metrics = headerMetrics(this.transcript.summary, this.rateLimits);
    metrics.forEach((m, i) => {
      if (i > 0) this.statsEl.appendChild(span("chat-stat-sep", "/"));
      const el = span(`chat-stat lv-${m.level}`, m.text);
      el.dataset.metric = m.key;
      el.title = this.codexReadOnly && m.key === "cost"
        ? "Codex App Server の金額は取得できません"
        : this.codexReadOnly && m.key === "ctx"
          ? "App Server で観測した文脈入力 / context window。新しい会話はこの統合では未対応です"
          : m.title;
      this.statsEl.appendChild(el);
    });
  }

  /**
   * WS `usage`（アカウント枠のスナップショット）を取り込む。
   * chat モードの master では `rate_limit_event` → UsageStore 経由で届く（設計書 §5.2 r3）。
   */
  applyUsage(u: UsageMessage): void {
    this.rateLimits = {
      fiveHourPct: u.rateLimits.fiveHour?.usedPct ?? null,
      sevenDayPct: u.rateLimits.sevenDay?.usedPct ?? null,
    };
    this.updateStats();
  }

  /**
   * 表示件数の上限を掛け、溢れた分の DOM を捨てる（案 1-b）。
   *
   * `rendered` は items と配列 index で 1:1 なので、`ChatTranscript.trim()` が落としたのと
   * **同じ件数だけ先頭を shift** する。ここを外すと以降の renderItem(index) が
   * 別の発言を書き換える。
   */
  private trimOverflow(): void {
    const dropped = this.transcript.trim(MAX_CHAT_ITEMS);
    if (dropped === 0) return;
    for (let i = 0; i < dropped; i += 1) this.rendered[i]?.remove();
    this.rendered.splice(0, dropped);
    this.setMoreRow(true);
  }

  /** ログ先頭の「これより前は…」行を出し入れする。 */
  private setMoreRow(show: boolean): void {
    if (!show) {
      this.moreRow?.remove();
      this.moreRow = null;
      return;
    }
    if (this.moreRow?.isConnected) return;
    // JSONL のページングは未実装。ここでは「もっと前がある」ことだけ示す。
    const more = div("chat-more");
    more.textContent = "（これより前の会話はログファイルにのみ残っています）";
    this.logEl.prepend(more);
    this.moreRow = more;
  }

  /** snapshot 適用時の全描画。 */
  private renderAll(hasMore: boolean): void {
    this.logEl.innerHTML = "";
    this.rendered.length = 0;
    this.moreRow = null;
    this.setMoreRow(hasMore || this.transcript.hasDropped);
    for (let i = 0; i < this.transcript.items.length; i += 1) this.renderItem(i);
    this.updateStats();
  }

  // ===== ライトボックス（PR-M10）=====

  /**
   * サムネイルのクリック / Enter / Space から呼ばれる。
   * 送りの対象は**トランスクリプト内の全画像**（ボス添付 + master 共有を時系列で 1 列）。
   */
  private openLightbox(key: string, opener: HTMLElement): void {
    this.lightbox.setEntries(collectImages(this.transcript.items));
    if (!this.lightbox.open(key)) return;
    this.lightboxOpener = opener;
    const ui = this.ensureLightboxUi();
    this.renderLightbox();
    if (!ui.root.open) ui.root.showModal();
  }

  /** 閉じる（Esc / 背景クリック / ×）。フォーカスは開いたサムネイルへ戻す。 */
  private closeLightbox(): void {
    if (!this.lightbox.isOpen && !this.lightboxUi) return;
    this.lightbox.close();
    if (this.lightboxUi?.root.open) this.lightboxUi.root.close();
    const opener = this.lightboxOpener;
    this.lightboxOpener = null;
    // 元のサムネイルがまだ画面にあるときだけ戻す（描き替えで消えていることがある）。
    if (opener?.isConnected) opener.focus();
  }

  /** 一覧を作り直して現在位置に追従する（開いている画像が消えていたら閉じる）。 */
  private syncLightbox(): void {
    this.lightbox.setEntries(collectImages(this.transcript.items));
    if (!this.lightbox.isOpen) this.closeLightbox();
    else this.renderLightbox();
  }

  private step(delta: 1 | -1): void {
    const moved = delta === 1 ? this.lightbox.next() : this.lightbox.prev();
    if (moved) this.renderLightbox();
  }

  /** 状態機械の現在値を DOM へ書き出す。 */
  private renderLightbox(): void {
    const ui = this.lightboxUi;
    const entry = this.lightbox.current;
    if (!ui || !entry) return;
    ui.img.src = entry.url;
    ui.img.alt = entry.title ?? entry.name;
    ui.title.textContent = entry.title ?? entry.name;
    ui.caption.textContent = entry.caption ?? "";
    ui.caption.hidden = !entry.caption;
    ui.path.textContent = entry.sourcePath ?? entry.name;
    ui.counter.textContent = lightboxCounter(this.lightbox);
    ui.prev.disabled = !this.lightbox.hasPrev;
    ui.next.disabled = !this.lightbox.hasNext;
  }

  /** ライトボックスの DOM を 1 回だけ作る（body 直下＝チャットのレイアウトに影響されない）。 */
  private ensureLightboxUi(): LightboxUi {
    if (this.lightboxUi) return this.lightboxUi;
    const root = document.createElement("dialog");
    root.className = "chat-lightbox";
    root.setAttribute("aria-label", "会話の画像を拡大表示");
    const img = document.createElement("img");
    img.className = "chat-lightbox-img";
    img.addEventListener("error", () => {
      caption.textContent = `（画像は削除されています: ${this.lightbox.current?.name ?? ""}）`;
      caption.hidden = false;
    });
    const close = document.createElement("button");
    close.className = "chat-lightbox-close";
    close.textContent = "✕";
    close.title = "閉じる（Esc）";
    close.setAttribute("aria-label", "画像を閉じる");
    close.autofocus = true;
    close.addEventListener("click", () => this.closeLightbox());
    const counter = span("chat-lightbox-counter", "");
    const prev = document.createElement("button");
    prev.className = "chat-lightbox-nav prev";
    prev.textContent = "‹";
    prev.title = "前の画像（←）";
    prev.setAttribute("aria-label", "前の画像");
    prev.addEventListener("click", (e) => {
      e.stopPropagation();
      this.step(-1);
    });
    const next = document.createElement("button");
    next.className = "chat-lightbox-nav next";
    next.textContent = "›";
    next.title = "次の画像（→）";
    next.setAttribute("aria-label", "次の画像");
    next.addEventListener("click", (e) => {
      e.stopPropagation();
      this.step(1);
    });
    const title = div("chat-lightbox-title");
    const caption = div("chat-lightbox-caption");
    const path = div("chat-lightbox-path");
    const foot = div("chat-lightbox-foot");
    foot.append(title, caption, path);
    const stage = div("chat-lightbox-stage");
    stage.appendChild(img);
    const header = div("chat-lightbox-header");
    header.append(counter, close);
    const navigation = div("chat-lightbox-controls");
    navigation.append(prev, next);
    root.append(header, stage, foot, navigation);
    // 背景（画像の外側）クリックで閉じる。画像そのもののクリックでは閉じない。
    root.addEventListener("click", (e) => {
      if (e.target === root || e.target === stage || e.target === foot) this.closeLightbox();
    });
    root.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.closeLightbox();
    });
    root.addEventListener("keydown", (e) => {
      containDialogFocus(root, e);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        this.step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.step(-1);
      }
    });
    document.body.appendChild(root);
    this.lightboxUi = { root, img, title, caption, path, counter, prev, next };
    return this.lightboxUi;
  }

  /** items[index] を描画（新規は append、既存は差し替え）。 */
  private renderItem(index: number): void {
    const item = this.transcript.items[index];
    if (!item) return;
    const next = buildItem(
      item,
      (requestId, answer) => {
        if (!this.masterId) return;
        this.onAnswer(this.masterId, requestId, answer);
      },
      (key, opener) => this.openLightbox(key, opener),
      {
        onReply: (target) => this.setReplyTo({ seq: target.seq, excerpt: replyExcerpt(target) }),
        onJump: (seq) => this.jumpToSeq(seq),
        hasSeq: (seq) => this.hasSeq(seq),
      },
    );
    const prev = this.rendered[index];
    if (prev) {
      // ツールの `<details>` は開閉状態をユーザーが持っているので引き継ぐ。
      const prevDetails = prev.querySelector("details");
      const nextDetails = next.querySelector("details");
      if (prevDetails && nextDetails && prevDetails.open) nextDetails.open = true;
      prev.replaceWith(next);
    } else {
      this.logEl.appendChild(next);
    }
    this.rendered[index] = next;
  }
}

// ===== アイテム 1 件 → DOM =====

/** ライトボックスの DOM 参照一式（ChatPanel が値を書き込む先）。 */
interface LightboxUi {
  root: HTMLDialogElement;
  img: HTMLImageElement;
  title: HTMLElement;
  caption: HTMLElement;
  path: HTMLElement;
  counter: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
}

/** Keep the dialog's controls in the Tab cycle, including Chromium's browser-chrome boundary. */
function containDialogFocus(dialog: HTMLDialogElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const targets = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']")]
    .filter(element => element.getClientRects().length > 0);
  const first = targets[0], last = targets.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/** サムネイルを押したときの通知（key = collectImages() のキー・opener = 復帰先のフォーカス）。 */
type OpenImage = (key: string, opener: HTMLElement) => void;

/** 返信（引用）まわりのフック（PR-M11）。 */
interface ReplyHooks {
  /** 「返信」ボタンの押下。ChatPanel が引用プレビューを出す。 */
  onReply: (item: ChatItem) => void;
  /** 引用チップの押下。引用元へスクロールする。 */
  onJump: (seq: number) => void;
  /** その seq が今のトランスクリプトに居るか（居なければチップは押せない）。 */
  hasSeq: (seq: number) => boolean;
}

const NO_REPLY_HOOKS: ReplyHooks = { onReply: () => {}, onJump: () => {}, hasSeq: () => false };

/** 1 アイテムを表す要素を作る（テキストはすべて textContent 経由＝XSS 安全）。 */
function buildItem(
  item: ChatItem,
  onAnswer: (requestId: string, answer: { allow?: boolean; choice?: string[]; text?: string }) => void,
  onOpenImage: OpenImage = () => {},
  reply: ReplyHooks = NO_REPLY_HOOKS,
): HTMLElement {
  switch (item.kind) {
    case "user": {
      const row = bubbleRow("user");
      const bubble = div("chat-bubble user");
      bubble.append(meta("あなた", item.ts));
      // どの発言への返答かを本文の上に出す（PR-M11）。
      if (item.replyTo) bubble.appendChild(quoteChip(item.replyTo, reply));
      if (item.text) bubble.appendChild(plain(item.text));
      if (item.attachments.length > 0) {
        bubble.appendChild(attachmentStrip(item.attachments, item.seq, onOpenImage));
      }
      row.appendChild(bubble);
      return row;
    }
    case "assistant": {
      const row = bubbleRow("assistant");
      const bubble = div("chat-bubble assistant" + (item.streaming ? " streaming" : ""));
      const body = div("chat-md");
      renderMarkdownInto(body, item.text);
      bubble.append(meta("統括", item.ts), body);
      if (item.streaming) bubble.appendChild(span("chat-caret", "▍"));
      if (replyable(item)) bubble.appendChild(replyButton(item, reply));
      row.appendChild(bubble);
      return row;
    }
    case "image": {
      // master がチャットへ共有した画像（PR-M10）。assistant 側のカードとして出す。
      const row = bubbleRow("assistant");
      const bubble = div("chat-bubble assistant image");
      bubble.append(meta("統括", item.ts));
      item.images.forEach((img, i) => {
        bubble.appendChild(imageCard(img, `${item.seq}:${i}`, onOpenImage));
      });
      if (replyable(item)) bubble.appendChild(replyButton(item, reply));
      row.appendChild(bubble);
      return row;
    }
    case "thinking": {
      const row = bubbleRow("assistant");
      const det = document.createElement("details");
      det.className = "chat-thinking";
      const sum = document.createElement("summary");
      sum.textContent = `💭 思考${item.streaming ? "中…" : ""}`;
      const body = div("chat-thinking-body");
      body.textContent = item.text;
      det.append(sum, body);
      row.appendChild(det);
      return row;
    }
    case "inbound": {
      const row = bubbleRow("inbound");
      const bubble = div(`chat-bubble inbound tag-${item.tag}`);
      const label = item.tag === "reply" ? "返信" : item.tag === "idle" ? "待機通知" : "メッセージ";
      bubble.append(meta(`${label}（${item.from}）`, item.ts));
      if (item.tag === "idle" && item.text.trim().length === 0) {
        bubble.appendChild(span("chat-idle-note", "本文なし（作業完了の合図）"));
      } else {
        const body = div("chat-md");
        renderMarkdownInto(body, item.text);
        bubble.appendChild(body);
      }
      if (replyable(item)) bubble.appendChild(replyButton(item, reply));
      row.appendChild(bubble);
      return row;
    }
    case "tool": {
      const row = bubbleRow("tool");
      const det = document.createElement("details");
      det.className = `chat-tool state-${item.state}`;
      const sum = document.createElement("summary");
      const icon = item.state === "running" ? "⏳" : item.state === "ok" ? "✅" : "❌";
      const taskLabel = ({ negi_list_task_results: "Task結果を確認", negi_list_tasks: "Task一覧を取得", negi_read_task: "Task契約を確認",
        negi_dispatch_task: "Taskを委任",negi_list_projects:"プロジェクトを確認",negi_read_project:"仕様と参照を読む",negi_propose_task:"契約案を作成",
        negi_propose_task_decomposition:"依頼をTaskに分ける" } as Record<string, string>)[item.name];
      sum.textContent = taskLabel ? `${taskLabel} ${icon}` : `🔧 ${item.name} ${icon} ${summarizeToolInput(item.input)}`.trimEnd();
      det.appendChild(sum);
      if (taskLabel) {
        const identity = document.createElement("small");
        identity.textContent = `操作: ${item.name}`;
        det.appendChild(identity);
      }
      const inputText = stringifyInput(item.input);
      if (inputText) {
        const pre = document.createElement("pre");
        pre.className = "chat-tool-input";
        pre.textContent = inputText;
        det.appendChild(pre);
      }
      if (item.result != null) {
        const pre = document.createElement("pre");
        pre.className = "chat-tool-result";
        pre.textContent = clip(item.result);
        det.appendChild(pre);
      }
      row.appendChild(det);
      if(item.name==="negi_propose_task"&&item.state==="ok"&&item.result){
        try{const result=JSON.parse(item.result) as {draftId?:string;title?:string};
          if(result.draftId&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.draftId)){
            const card=div("md-surface md-surface-tertiary"),title=document.createElement("strong"),copy=document.createElement("p"),link=document.createElement("a");
            title.textContent=result.title||"新しいTaskの契約案";copy.textContent="契約案を保存しました。内容を確認してから作業へ渡せます。";
            link.className="md-button md-primary";link.href="/task-plans?draft="+result.draftId;link.textContent="この契約案を確認";card.append(title,copy,link);row.append(card);
          }
        }catch{/* tool evidence remains visible without a fabricated link */}
      }
      if(item.name==="negi_propose_task_decomposition"&&item.state==="ok"&&item.result){
        try{const result=JSON.parse(item.result) as {title?:string;tasks?:Array<{draftId?:string;canFinalize?:boolean}>};
          const tasks=result.tasks;
          if(Array.isArray(tasks)&&tasks.length>=2&&tasks.length<=8&&tasks.every(t=>typeof t.draftId==="string"&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(t.draftId))){
            const card=div("md-surface md-surface-tertiary"),title=document.createElement("strong"),copy=document.createElement("p"),link=document.createElement("a");
            title.textContent=result.title||"依頼を分けた契約案";
            copy.textContent=tasks.length+"件の案を保存しました。独立した作業から確認でき、先行作業が必要な案は保留になります。";
            link.className="md-button md-primary";link.href="/task-plans?draft="+tasks[0].draftId;link.textContent="分けた作業を確認";card.append(title,copy,link);row.append(card);
          }
        }catch{/* retain actual tool evidence */}
      }
      return row;
    }
    case "pending": {
      const row = bubbleRow("assistant");
      const bubble = div(`chat-bubble pending${item.settled ? ` settled-${item.settled}` : ""}`);
      bubble.append(meta(item.variant === "permission" ? "⏸ 承認待ち" : "❓ 質問", item.ts));
      const t = div("chat-pending-title");
      t.textContent = item.title;
      const d = div("chat-pending-detail");
      d.textContent = oneLine(item.detail, 400);
      bubble.append(t, d);
      if (item.settled) {
        // 決着済み。結果だけを出してボタンは一切出さない（二度押しの余地を作らない）。
        const done = div("chat-pending-settled");
        done.textContent = settledLabel(item.settled, item.variant, item.answer);
        bubble.appendChild(done);
      } else if (item.variant === "permission") {
        bubble.appendChild(permissionActions(item.requestId, onAnswer));
      } else {
        bubble.appendChild(questionForm(item, onAnswer));
      }
      row.appendChild(bubble);
      return row;
    }
    case "notice": {
      const el = div(`chat-system level-${item.level}`);
      el.textContent = item.text;
      return el;
    }
    case "taskResult": {
      const result = item.result, row = div("chat-system task-result-card md-surface"), heading = document.createElement("strong");
      heading.textContent = result.title + " · " + taskResultUpdateLabel(result);
      const state = div("md-chip"); state.textContent = taskStatusLabels[result.status] ?? result.status;
      const copy = document.createElement("p");
      copy.textContent = taskResultDeliveryLabels[result.delivery.state];
      if (["unknown", "prepared", "dispatching", "failed"].includes(result.delivery.state)) copy.className = "task-result-attention";
      const note = document.createElement("small");
      note.textContent = result.supersededBy ? "この通知より新しい結果があります。Taskで現在の成果と受入を確認してください。" : ["pending", "not_sent"].includes(result.delivery.state)
        ? "通知時点の結果です。委任元と同じ会話の次の依頼で現在を照合し、有効な結果を添付します。現在のTaskと人間受入は詳細で確認できます。"
        : result.delivery.state === "completed"
        ? "通知時点の結果への統括の応答を記録しました。成果の人間受入は別に確認してください。"
        : result.delivery.state === "bound"
        ? "統括の応答を待っています。成果の人間受入は別に確認してください。"
        : "伝達記録と現在のTaskを照合してください。自動では再送しません。成果の人間受入は別に確認してください。";
      const actions = div("md-actions"), task = document.createElement("a");
      task.className = "md-button md-tonal"; task.href = "/tasks?run=" + encodeURIComponent(result.runId); task.textContent = "Taskを確認";
      actions.append(task);
      if (result.origin.kind === "master") {
        const source = document.createElement("a"); source.className = "md-button md-tonal";
        source.href = taskOriginHref(result.runId); source.textContent = "委任元の会話"; actions.append(source);
      }
      if (result.reviewId) {
        const review = document.createElement("a"); review.className = "md-button md-primary";
        review.href = "/reviews?case=" + encodeURIComponent(result.reviewId); review.textContent = "成果をレビュー"; actions.append(review);
      }
      row.append(heading, state, copy, note, actions); return row;
    }
    case "session": {
      const el = div("chat-system level-info");
      el.textContent = `🧠 セッション開始（model: ${item.model ?? "?"}）`;
      el.title = `sessionId: ${item.sessionId}`;
      return el;
    }
    case "turnEnd": {
      const el = div("chat-turnend");
      if (item.aborted) {
        el.classList.add("aborted");
        el.textContent = "⏹ 中断しました";
      } else if (!item.ok) {
        el.classList.add("error");
        el.textContent = `⚠ エラー: ${item.errorText ?? "詳細不明"}`;
      } else {
        el.textContent = `${formatCost(item.totalCostUsd)} / ctx ${formatContextPct(item.contextUsedPct)}`;
        el.title = "会話の累計コスト（推定）と文脈使用率";
      }
      return el;
    }
  }
}

/** 長すぎるツール結果を丸める（全文は PR-M4 で「全部見る」を付ける）。 */
// ===== 承認 / 質問の応答 UI（PR-M5）=====

/**
 * 承認（permission）のボタン列。
 *
 * 押した瞬間にボタンを畳む（＝二度押しを構造的に潰す）。実際の「決着」表示は
 * サーバから返る `permissionSettled` で置き換わるので、ここでは押下済みを示すだけ。
 */
function permissionActions(
  requestId: string,
  onAnswer: (requestId: string, answer: { allow?: boolean; choice?: string[]; text?: string }) => void,
): HTMLElement {
  const actions = div("chat-pending-actions");
  const mk = (label: string, allow: boolean, cls: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = `chat-pending-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      for (const el of actions.querySelectorAll("button")) el.disabled = true;
      onAnswer(requestId, { allow });
    });
    return b;
  };
  actions.append(mk("✅ 許可", true, "allow"), mk("⛔ 拒否", false, "deny"));
  return actions;
}

/**
 * 質問（AskUserQuestion）の選択肢フォーム。
 *
 * 複数選択（multiSelect）は checkbox、単一選択は radio。加えて **「その他」の自由入力**を
 * 常に置く（AskUserQuestion の Other 相当）。何も選ばず自由入力だけでも送れる。
 */
function questionForm(
  item: Extract<ChatItem, { kind: "pending" }>,
  onAnswer: (requestId: string, answer: { allow?: boolean; choice?: string[]; text?: string }) => void,
): HTMLElement {
  const wrap = div("chat-question");
  const group = `q-${item.requestId}-${item.seq}`;
  const inputs: HTMLInputElement[] = [];
  item.options.forEach((label, i) => {
    const row = document.createElement("label");
    row.className = "chat-question-option";
    const box = document.createElement("input");
    box.type = item.multi ? "checkbox" : "radio";
    box.name = group;
    box.value = label;
    inputs.push(box);
    const text = span("chat-question-label", label);
    row.append(box, text);
    const note = item.optionNotes[i];
    if (note) row.appendChild(span("chat-question-desc", note));
    wrap.appendChild(row);
  });

  const other = document.createElement("input");
  other.type = "text";
  other.className = "chat-question-other";
  other.placeholder = "その他（自由入力）";

  const actions = div("chat-pending-actions");
  const submit = document.createElement("button");
  submit.className = "chat-pending-btn allow";
  submit.textContent = "回答する";
  submit.addEventListener("click", () => {
    const choice = inputs.filter((b) => b.checked).map((b) => b.value);
    const text = other.value.trim();
    if (choice.length === 0 && !text) return; // 空回答は送らない（master が空文字で困る）
    submit.disabled = true;
    for (const b of inputs) b.disabled = true;
    other.disabled = true;
    onAnswer(item.requestId, { choice, ...(text ? { text } : {}) });
  });
  actions.appendChild(submit);
  wrap.append(other, actions);
  return wrap;
}

function clip(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（${text.length - max} 文字省略）` : text;
}

/**
 * バブル右上の「返信」ボタン（PR-M11）。
 * hover / フォーカスで濃くなるだけで、タッチ端末では常時薄く出る（長押しは使わない＝
 * iOS のテキスト選択と衝突するため）。
 */
function replyButton(item: ChatItem, reply: ReplyHooks): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "chat-reply-btn";
  btn.textContent = "↩︎";
  btn.title = "このメッセージに返信する";
  btn.setAttribute("aria-label", "このメッセージに返信");
  btn.addEventListener("click", () => reply.onReply(item));
  return btn;
}

/**
 * ボスの発話に付く引用チップ（PR-M11）。押すと引用元へスクロールする。
 * 引用元が画面に残っていない（ログにしか無い）ときは押せないようにして理由を出す。
 */
function quoteChip(ref: ChatReplyRef, reply: ReplyHooks): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "chat-quote";
  btn.textContent = `↩︎ master#${ref.seq}: ${ref.excerpt}`;
  const known = reply.hasSeq(ref.seq);
  btn.disabled = !known;
  btn.title = known
    ? "引用元へスクロールします"
    : "引用元はこれより前の会話（ログファイルにのみ残っています）";
  if (known) btn.addEventListener("click", () => reply.onJump(ref.seq));
  return btn;
}

function bubbleRow(variant: string): HTMLElement {
  return div(`chat-row ${variant}`);
}

function meta(label: string, ts: number): HTMLElement {
  const el = div("chat-meta");
  el.textContent = `${label} · ${new Date(ts).toLocaleTimeString("ja-JP")}`;
  return el;
}

function plain(text: string): HTMLElement {
  const el = div("chat-plain");
  el.textContent = text;
  return el;
}

function div(cls: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

/**
 * 送信済みメッセージに付いた添付のサムネイル列。
 * 画像はクリック（Enter / Space）で master 共有画像と**同じライトボックス**へ載る（PR-M10）。
 */
function attachmentStrip(
  attachments: readonly ChatAttachment[],
  seq: number,
  onOpenImage: OpenImage,
): HTMLElement {
  const strip = div("chat-attachments");
  attachments.forEach((a, i) => {
    const cell = div("chat-attachment");
    if (a.mediaType.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "chat-attachment-thumb";
      img.src = a.url;
      img.alt = a.name;
      img.title = `${a.path}（クリックで拡大）`;
      makeZoomable(img, `${seq}:${i}`, onOpenImage);
      cell.appendChild(img);
    }
    const name = span("chat-attachment-name", a.name);
    name.title = a.path;
    cell.appendChild(name);
    strip.appendChild(cell);
  });
  return strip;
}

/**
 * master が共有した画像 1 枚のカード（見出し + サムネイル + 説明文）。
 * サムネイルの寸法は CSS（max 320x240・object-fit: contain）で決める。
 */
function imageCard(
  image: {
    name: string;
    url: string;
    sourcePath: string;
    title: string | null;
    caption: string | null;
    bytes: number;
  },
  key: string,
  onOpenImage: OpenImage,
): HTMLElement {
  const card = div("chat-image-card");
  if (image.title) {
    const t = div("chat-image-title");
    t.textContent = image.title;
    card.appendChild(t);
  }
  const img = document.createElement("img");
  img.className = "chat-image-thumb";
  img.src = image.url;
  img.alt = image.title ?? image.name;
  img.title = `${image.sourcePath}（${formatBytes(image.bytes)}・クリックで拡大）`;
  img.loading = "lazy";
  img.decoding = "async";
  makeZoomable(img, key, onOpenImage);
  // 保管庫を掃除したあとは 404 になる。吹き出しごと消さず、その旨だけ出す。
  img.addEventListener("error", () => {
    const gone = div("chat-image-missing");
    gone.textContent = `（画像は削除されています: ${image.name}）`;
    img.replaceWith(gone);
  });
  card.appendChild(img);
  if (image.caption) {
    const c = div("chat-image-caption");
    c.textContent = image.caption;
    card.appendChild(c);
  }
  return card;
}

/** サムネイルを「押せる」ようにする（マウス・キーボードの両方）。 */
function makeZoomable(img: HTMLImageElement, key: string, onOpenImage: OpenImage): void {
  img.classList.add("zoomable");
  img.setAttribute("role", "button");
  img.tabIndex = 0;
  img.addEventListener("click", () => onOpenImage(key, img));
  img.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpenImage(key, img);
  });
}

/**
 * チャット添付を保存する（`POST /control/chat-attach`）。
 * Content-Type が MIME、ボディが生バイト列。保存先はサーバが決める（クライアントは
 * パスを指定できない）ので、返ってきた絶対パスをそのまま master への提示に使う。
 */
async function uploadAttachment(
  body: Blob,
  mediaType: string,
): Promise<ChatAttachment> {
  const res = await fetch("/control/chat-attach", {
    method: "POST",
    headers: { "Content-Type": mediaType },
    body,
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => null)) as (ChatAttachment & { error?: string }) | null;
  if (!res.ok || !json || typeof json.name !== "string") {
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/** localStorage（使えない環境では null）。プライベートモードで例外を投げる実装がある。 */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 次フレームへ処理を遅らせる（追従スクロールの合流用）。
 * `requestAnimationFrame` が無い環境（テスト・非表示タブの一部実装）では setTimeout で代替する。
 */
function requestFrame(fn: () => void): number {
  if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(fn);
  return window.setTimeout(fn, 16);
}
