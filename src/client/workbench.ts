import { materialIcon } from "../shared/material3.ts";
import { taskNeedsAttention, taskStatusLabels, type TaskOverview, type ReviewOverview } from "../shared/workspace.ts";
import type { AgentRecord, MasterChatState } from "../shared/protocol.ts";
import { stateLabel } from "./chatModel.ts";
import { taskResultDeliveryLabel, taskResultUpdateLabel, type TaskResultSummary } from "../shared/taskResults.ts";
import { taskOriginHref } from "../shared/conversations.ts";

export class Workbench {
  private capabilities: { tasks: boolean; reviews: boolean; taskAuthoring?: boolean;projectSetup?:boolean } | null = null;
  private tasks: TaskOverview[] | null = null;
  private reviews: ReviewOverview[] | null = null;
  private taskError: string | null = null;
  private reviewError: string | null = null;
  private results: TaskResultSummary[] | null = null;
  private resultError: string | null = null;
  private resultRevision = 0;
  private agents: AgentRecord[] = [];
  private masterState: { id: string; state: MasterChatState | null } | null = null;
  private timer: number | null = null;
  private visible = false;
  private loading = false;
  private fingerprint = "";
  private readonly project: HTMLSelectElement;
  private readonly search: HTMLInputElement;

  constructor(private readonly el: HTMLElement, private readonly openTeam: () => void) {
    this.el.innerHTML = `<div class="md-page-heading"><div><div class="md-eyebrow">WORKSPACE</div><h1>作業一覧</h1><p>現在の作業と、判断を待っている成果を確認します。</p></div><div class="md-actions"><a id="wb-setup" class="md-button md-tonal" href="/setup" hidden>プロジェクト設定</a><a id="wb-new-task" class="md-button md-primary" href="/task-plans" hidden>新しいTask</a><button id="wb-refresh" class="md-icon-button" aria-label="作業一覧を更新" title="作業一覧を更新">${materialIcon("refresh")}</button></div></div>
<div class="wb-summary"><div class="wb-decision md-surface md-surface-tonal"><div class="wb-summary-copy"><span class="wb-summary-label">要確認の成果</span><div id="wb-review-count" class="wb-summary-number">—</div><p id="wb-review-hint">接続を確認しています。</p></div><div class="wb-summary-shape" aria-hidden="true">${materialIcon("review")}</div><a id="wb-review-action" class="md-button md-primary" href="/reviews" hidden>成果を確認</a></div>
<div class="wb-activity"><div><span class="wb-summary-label">実行中</span><strong id="wb-running-count">—</strong></div><div><span class="wb-summary-label">登録されたTask</span><strong id="wb-task-count">—</strong></div><p id="wb-freshness" class="muted">状態を取得してから表示します。</p></div></div>
<p id="wb-error" class="md-message" role="status" aria-live="polite"></p>
<div class="wb-content"><div>
<section class="md-section" id="wb-attention-section"><div class="md-section-heading"><h2>確認が必要</h2></div><div id="wb-attention" class="md-list"></div></section>
<section class="md-section"><div class="md-section-heading"><h2>作業からの結果</h2></div><p id="wb-result-error" class="md-message" role="status"></p><div id="wb-results" class="md-list"></div><small class="muted">通知時点の状態です。現在のTaskと成果は詳細で確認できます。</small></section>
<section class="md-section"><div class="md-section-heading"><h2>Task</h2><a id="wb-all-tasks" href="/tasks" hidden>すべて開く</a></div>
<div class="wb-filters"><label>プロジェクト<select id="wb-project"><option value="">すべて</option></select></label><label>作業を検索<input id="wb-search" type="search" placeholder="作業名・プロジェクト"></label></div><div id="wb-tasks" class="md-list"></div></section></div>
<aside class="wb-team md-section"><div class="md-section-heading"><h2>チーム</h2><button id="wb-open-team" class="md-text">開く</button></div><div id="wb-team-list" class="md-list"></div><p class="muted">会話と端末はチーム画面で確認できます。</p></aside></div>`;
    this.project = this.el.querySelector("#wb-project")!;
    this.search = this.el.querySelector("#wb-search")!;
    this.project.addEventListener("change", () => this.renderTasks());
    this.search.addEventListener("input", () => this.renderTasks());
    this.node("wb-refresh").addEventListener("click", () => void this.load());
    this.node("wb-open-team").addEventListener("click", openTeam);
    this.render();
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      void this.load();
      this.timer = window.setInterval(() => { if (!document.hidden) void this.load(); }, 15_000);
    } else if (this.timer !== null) {
      clearInterval(this.timer); this.timer = null;
    }
  }
  setCapabilities(value: { tasks: boolean; reviews: boolean; taskAuthoring?: boolean;projectSetup?:boolean }): void {
    this.capabilities = value;
    this.render();
    if (this.visible) void this.load();
  }
  updateAgents(agents: AgentRecord[]): void {
    this.agents = agents;
    this.renderTeam();
  }
  updateMasterState(id: string, state: MasterChatState): void {
    this.masterState = { id, state }; this.renderTeam();
  }
  markDisconnected(): void {
    if (this.masterState) { this.masterState.state = null; this.renderTeam(); }
  }
  private node(id: string): HTMLElement { return this.el.querySelector(`#${id}`)!; }
  private text(id: string, value: string): void { this.node(id).textContent = value; }
  private async get<T>(path: string): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) throw new Error("ログインして状態を確認してください。");
    if (!response.ok) throw new Error("状態を取得できません。更新して再確認してください。");
    return response.json() as Promise<T>;
  }
  updateResults(results: TaskResultSummary[]): void { this.resultRevision++; this.results = results; this.resultError = null; this.render(); }
  private async load(): Promise<void> {
    if (this.loading || !this.capabilities) return;
    this.loading = true;
    (this.node("wb-refresh") as HTMLButtonElement).disabled = true;
    const resultRevision = this.resultRevision;
    const results = await Promise.allSettled([
      this.capabilities.tasks ? this.get<TaskOverview[]>("/api/tasks?summary=1") : Promise.resolve(null),
      this.capabilities.reviews ? this.get<ReviewOverview[]>("/api/reviews?summary=1") : Promise.resolve(null),
      this.capabilities.tasks ? this.get<TaskResultSummary[]>("/api/tasks/results/summary") : Promise.resolve(null),
    ]);
    this.tasks = results[0].status === "fulfilled" ? results[0].value : null;
    this.reviews = results[1].status === "fulfilled" ? results[1].value : null;
    this.taskError = results[0].status === "rejected" ? String(results[0].reason.message) : null;
    this.reviewError = results[1].status === "rejected" ? String(results[1].reason.message) : null;
    if (resultRevision === this.resultRevision) {
      this.results = results[2].status === "fulfilled" ? results[2].value : null;
      this.resultError = results[2].status === "rejected" ? "結果通知を確認できません。Taskの現在の状態を確認してください。" : null;
    }
    this.loading = false;
    (this.node("wb-refresh") as HTMLButtonElement).disabled = false;
    this.text("wb-freshness", this.taskError || this.reviewError ? "状態の取得に失敗しました。更新して再確認してください。" : `最終確認 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} · 15秒ごとに更新`);
    this.render();
  }
  private empty(container: HTMLElement, title: string, detail: string): void {
    const block = document.createElement("div"), heading = document.createElement("strong"), copy = document.createElement("span");
    block.className = "md-empty"; heading.textContent = title; copy.textContent = detail;
    block.append(heading, copy); container.append(block);
  }
  private row(title: string, detail: string, href: string, kind: string, state?: string, warning = false): HTMLAnchorElement {
    const a = document.createElement("a"), icon = document.createElement("span"), copy = document.createElement("span"), strong = document.createElement("strong"), small = document.createElement("small"), arrow = document.createElement("span");
    a.className = "md-list-item"; a.href = href; icon.className = "md-list-symbol"; icon.innerHTML = materialIcon(kind);
    copy.className = "md-list-copy"; strong.textContent = title; small.textContent = detail; copy.append(strong, small);
    arrow.className = "md-list-arrow"; arrow.innerHTML = materialIcon("arrow"); a.append(icon, copy);
    if (state) { const chip = document.createElement("span"); chip.className = "md-chip" + (warning ? " md-chip-warning" : ""); chip.textContent = state; a.append(chip); }
    a.append(arrow); return a;
  }
  private render(): void {
    const pending = this.reviews?.filter(r => r.status === "awaiting_review" || r.status === "unknown" || r.status === "revoked" || r.qualityIssue || r.integrityError);
    this.text("wb-review-count", pending ? String(pending.length) : "—");
    this.text("wb-review-hint", this.reviewError ?? (!this.capabilities ? "接続を確認しています。" : !this.capabilities.reviews ? "成果レビューが未設定です。" : pending ? pending.length ? "成果と検証結果を確認してください。" : "判断を待っている成果はありません。" : "状態を取得しています。"));
    this.node("wb-review-action").hidden = !pending?.length;
    this.text("wb-running-count", this.tasks && !this.tasks.some(t => t.status === "unknown") ? String(this.tasks.filter(t => t.live).length) : "—");
    this.text("wb-task-count", this.tasks ? String(this.tasks.length) : "—");
    this.node("wb-all-tasks").hidden = !this.capabilities?.tasks;
    this.node("wb-new-task").hidden = !this.capabilities?.taskAuthoring;
    this.node("wb-setup").hidden=!this.capabilities?.projectSetup;
    this.text("wb-error", [this.taskError, this.reviewError].filter(Boolean).filter((v,i,a) => a.indexOf(v) === i).join(" "));
    const signature = JSON.stringify({ tasks: this.tasks, reviews: this.reviews, results: this.results, capabilities: this.capabilities, taskError: this.taskError, reviewError: this.reviewError, resultError: this.resultError });
    if (signature === this.fingerprint) return;
    this.fingerprint = signature;
    this.text("wb-result-error", this.resultError ?? "");
    const resultList = this.node("wb-results"); resultList.replaceChildren();
    for (const result of this.results?.filter(n=>!n.supersededBy).slice(0, 8) ?? []) {
      const group = document.createElement("div"); group.className = "md-result-group";
      group.append(this.row(result.title, [result.project,taskResultUpdateLabel(result),taskResultDeliveryLabel(result)].join(" · "),
        `/tasks?run=${encodeURIComponent(result.runId)}`, "task", taskStatusLabels[result.status] ?? result.status,
        ["unknown", "dispatching", "prepared", "failed"].includes(result.delivery.state)));
      if (result.origin.kind === "master" || result.createdBy) {
        const source = document.createElement("a"); source.className = "md-button md-text";
        source.href = taskOriginHref(result.runId, result.origin.kind === "master" ? "requested" : "created");
        source.textContent = result.origin.kind === "master" ? "委任元の会話" : "契約案を作った会話";
        source.setAttribute("aria-label", result.title + "の" + source.textContent); group.append(source);
      }
      resultList.append(group);
    }
    if (!resultList.children.length) this.empty(resultList, this.resultError ? "結果通知を確認できません" : this.capabilities && !this.capabilities.tasks ? "Taskが未設定です" : this.results ? "新しい結果通知はありません" : "結果通知を確認しています", "完了・停止・照合が必要なTaskの結果をここに表示します。");
    const attention = this.node("wb-attention"); attention.replaceChildren();
    for (const r of pending ?? []) {
      const warning = r.qualityIssue || Boolean(r.integrityError) || r.status === "revoked";
      attention.append(this.row(r.title, r.integrityError ?? (r.qualityIssue ? "内容の訂正が必要です。" : r.status === "revoked" ? "受入が取り消されています。" : "成果と検証結果をレビューできます。"), `/reviews?case=${encodeURIComponent(r.id)}`, "review", warning ? "確認が必要" : "レビュー待ち", warning));
    }
    for (const t of this.tasks?.filter(taskNeedsAttention) ?? []) {
      attention.append(this.row(t.title, t.approvalCount ? `${t.approvalCount}件の操作確認` : t.status === "review_revoked" ? "受入が取り消されています。成果を確認してください。" : t.error ?? t.project ?? "状態を確認してください。", `/tasks?run=${encodeURIComponent(t.id)}`, "task", taskStatusLabels[t.status] ?? t.status, true));
    }
    const awaitingData = this.capabilities && ((this.capabilities.tasks && !this.tasks && !this.taskError) || (this.capabilities.reviews && !this.reviews && !this.reviewError));
    if (!attention.children.length) this.empty(attention, this.taskError || this.reviewError ? "状態を確認できません" : !this.capabilities ? "接続待ち" : awaitingData ? "状態を確認しています" : "今すぐ必要な判断はありません", this.taskError || this.reviewError ? "ログインや接続を確認し、作業一覧を更新してください。" : awaitingData ? "取得が完了すると、必要な判断を表示します。" : "新しい成果や操作確認はここに表示されます。");
    if (this.taskError || this.reviewError) {
      const login = document.createElement("a"); login.className = "md-button md-tonal"; login.href = "/login"; login.textContent = "ログインを開く"; attention.append(login);
    }
    const previousProject = this.project.value;
    this.project.replaceChildren(new Option("すべて", ""));
    for (const project of [...new Set(this.tasks?.map(t => t.project).filter((v): v is string => Boolean(v)) ?? [])].sort()) this.project.append(new Option(project, project));
    if ([...this.project.options].some(o => o.value === previousProject)) this.project.value = previousProject;
    this.renderTasks();
  }
  private renderTasks(): void {
    const container = this.node("wb-tasks"); container.replaceChildren();
    if (!this.tasks) {
      this.empty(container, this.taskError ? "Taskの状態を確認できません" : !this.capabilities ? "接続待ち" : this.capabilities.tasks ? "読み込み中" : "Taskが未設定です", "登録された契約と作業がここに表示されます。"); return;
    }
    const query = this.search.value.trim().toLocaleLowerCase();
    const rows = this.tasks.filter(t => (!this.project.value || t.project === this.project.value) &&
      (!query || `${t.title} ${t.project ?? ""} ${t.id}`.toLocaleLowerCase().includes(query)))
      .sort((a,b) => Number(taskNeedsAttention(b)) - Number(taskNeedsAttention(a)) || Number(a.status === "accepted") - Number(b.status === "accepted"));
    for (const t of rows) container.append(this.row(t.title, [t.project, t.resultRevisionCount ? `修正版 ${t.resultRevisionCount}` : null].filter(Boolean).join(" · "), `/tasks?run=${encodeURIComponent(t.id)}`, "task", taskStatusLabels[t.status] ?? t.status, taskNeedsAttention(t)));
    if (!rows.length) this.empty(container, this.tasks.length ? "該当する作業はありません" : "登録されたTaskはありません", this.tasks.length ? "検索条件を変更してください。" : this.capabilities?.taskAuthoring ? "新しいTaskから依頼と条件を確認してください。統括チャットでも相談できます。" : "VaultのTask契約と実行カタログを登録してください。");
  }
  private renderTeam(): void {
    const container = this.node("wb-team-list"); container.replaceChildren();
    for (const a of this.agents) {
      const master = this.masterState?.id === a.id && a.kind === "master" ? this.masterState : null;
      const status = master ? master.state ? stateLabel(master.state) : "接続を確認" :
        ({ idle: "待機", busy: "実行中", stopped: "停止", exited: "終了" } as Record<string,string>)[a.status] ?? a.status;
      const row = this.row(a.kind === "master" ? "統括" : a.kind === "supervisor" ? "監督" : a.id,
        [a.backend, a.model, a.mode === "isolated" ? "単独" : "接続"].filter(Boolean).join(" · "), "/?view=workspace", "workspace", status,
        Boolean(master && (master.state === "stopped" || master.state === null)));
      row.addEventListener("click", event => { event.preventDefault(); this.openTeam(); }); container.append(row);
    }
    if (!this.agents.length) this.empty(container, "接続した担当はいません", "チーム画面で接続を確認できます。");
  }
}
