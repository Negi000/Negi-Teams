export type TaskResultDeliveryState = "pending" | "prepared" | "dispatching" | "bound" |
  "completed" | "failed" | "interrupted" | "not_sent" | "unknown";
export interface TaskResultNotice {
  id: string; createdAt: string; runId: string; title: string; project: string;
  taskId: string; version: number; configSha256: string; sourceSha256: string;
  status: string; verificationOutcome: string | null; acceptedBy: string | null;
  reviewId: string | null; reason: string | null;
  /** Absent on historical initial notices, which remain immutable. */
  update?: { sequence: number; previousId: string | null;
    kind: "initial" | "revision" | "accepted" | "revoked" | "state";
    resultRevision: number; artifactSha256: string | null };
  origin: { kind: "browser" } | { kind: "master"; masterId: string; threadId: string; turnId: string; callId: string };
  /** Signed contract creation origin; never changes who requested execution. */
  createdBy?: Extract<TaskResultNotice["origin"], { kind: "master" }>;
}
export interface TaskResultSummary extends TaskResultNotice {
  delivery: { state: TaskResultDeliveryState; threadId: string | null; turnId: string | null };
  supersededBy?: string | null;
}
export function taskResultUpdateLabel(result: TaskResultNotice): string {
  const labels = { initial: "初回の結果", revision: "成果の修正版", accepted: "受入の記録",
    revoked: "受入取消の記録", state: "状態の更新" };
  return result.update ? `通知${result.update.sequence + 1} · ${labels[result.update.kind]}` +
    (result.update.resultRevision ? ` · 成果の修正版${result.update.resultRevision}` : "") : "初回の結果";
}
export const taskResultDeliveryLabels: Record<TaskResultDeliveryState, string> = {
  pending: "同じ会話の次の依頼で現在を照合", prepared: "投入前の記録を確認", dispatching: "投入結果を確認",
  bound: "統括の応答待ち", completed: "統括の応答を確認", failed: "統括の応答が失敗",
  interrupted: "統括の応答を中断", not_sent: "未送信・次の依頼で伝達", unknown: "伝達結果の照合が必要",
};
export function taskResultDeliveryLabel(result: TaskResultSummary): string {
  return result.origin.kind === "browser" ? "Task画面から依頼した作業の結果" +
    (result.createdBy ? " · " + taskResultDeliveryLabels[result.delivery.state] : "") : taskResultDeliveryLabels[result.delivery.state];
}
export function taskResultRecipient(result: TaskResultNotice) {
  return result.origin.kind === "master" ? result.origin : result.createdBy ?? null;
}
