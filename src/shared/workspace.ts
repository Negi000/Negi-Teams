export interface TaskOverview {
  id: string; title: string; project: string | null; status: string;
  canStart: boolean; live: boolean; reviewId: string | null; approvalCount: number;
  resultRevisionCount: number; error: string | null;
}
export interface ReviewOverview {
  id: string; title: string; status: string; canAccept: boolean;
  qualityIssue: boolean; integrityError: string | null;
}
export const taskStatusLabels: Record<string, string> = {
  not_started: "開始前", queued: "実行待ち", planning: "計画中", ready_for_worker: "引継ぎ待ち",
  working: "作業中", verifying: "検証中", ready_for_review: "レビュー待ち", accepted: "受入済み",
  blocked: "保留", stopped: "停止", needs_reconciliation: "照合が必要", verified: "機械検証済み",
  failed: "失敗", cancelled: "取消済み", preflight_failed: "実行前確認に失敗", review_revoked: "受入取消",
  artifact_changed: "再検証が必要", quality_issue: "訂正が必要", unknown: "状態を確認できません",
};
export const taskNeedsAttention = (task: TaskOverview): boolean => task.approvalCount > 0 ||
  ["blocked", "needs_reconciliation", "failed", "preflight_failed", "review_revoked", "artifact_changed", "quality_issue", "unknown"].includes(task.status);
