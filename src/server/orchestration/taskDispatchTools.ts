// Planner tools dispatch the same fixed catalog and scheduler used by the Task UI.
// They cannot create roots/commands, alter contracts, approve operations or accept results.
import { createHash } from "node:crypto";
import type { CodexDynamicToolCall, CodexDynamicToolDefinition, CodexDynamicToolResult } from "../master/appServerClient.ts";
import type { LocalTaskService, TaskRunView, TaskRequestOrigin } from "./taskService.ts";

const runId = { type: "string", pattern: "^[a-zA-Z0-9._-]{1,100}$" };
const configHash = { type: "string", pattern: "^[a-f0-9]{64}$" };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): CodexDynamicToolDefinition {
  return { type: "function", name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const definitions = [
  definition("negi_list_tasks", "登録済みTaskの固定カタログを検索する。未登録の依頼は先にTask Contractの確定が必要。", {
    project: { type: "string", minLength: 1, maxLength: 100 }, offset: { type: "integer", minimum: 0, maximum: 100 } }, []),
  definition("negi_read_task", "Taskの固定契約、担当、現在の実行・検証・人間受入状態を確認する。再委任前に使う。", { run_id: runId }, ["run_id"]),
  definition("negi_dispatch_task", "登録済みの固定TaskだけをUIと同じschedulerへ委任する。契約、担当モデル、checkout、検証条件を変更しない。結果不明時は再委任せず現在のTaskを読む。", {
    run_id: runId, config_sha256: configHash }, ["run_id", "config_sha256"]),
];
export interface RegisteredTaskTools {
  definitions: CodexDynamicToolDefinition[];
  invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult>;
}
function argumentsObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Task tool arguments invalid");
  return value as Record<string, unknown>;
}
function publicView(service: LocalTaskService, view: TaskRunView) {
  return { runId: view.id, title: view.title, project: view.project, taskId: view.taskId,
    taskContract: service.dispatchContract(view.id),
    version: view.version, configSha256: view.configSha256, objective: view.objective, baseSha: view.baseSha,
    allowedPaths: view.allowedPaths, acceptance: view.acceptance, invariants: view.invariants,
    outOfScope: view.outOfScope, verification: view.verification, planner: view.astra, worker: view.sol,
    status: view.status, canStart: view.canStart, live: view.live, error: view.error,
    verificationOutcome: view.verificationOutcome, acceptedBy: view.acceptedBy, reviewId: view.reviewId,
    ...(view.requestedBy ? { requestedBy: view.requestedBy } : {}) };
}
function requestUuid(origin: TaskRequestOrigin): string {
  const bytes = createHash("sha256").update("negi-master-dispatch/1\n" + JSON.stringify(origin)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function registeredTaskTools(service: LocalTaskService, masterId: string): RegisteredTaskTools {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(masterId)) throw new Error("Task planner identity invalid");
  return { definitions: structuredClone(definitions), async invoke(call) {
    try {
      const origin: TaskRequestOrigin = { kind: "master", masterId, threadId: call.threadId, turnId: call.turnId, callId: call.callId };
      if (![call.threadId, call.turnId, call.callId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id)))
        throw new Error("Planner call identity invalid");
      let value: unknown;
      if (call.tool === "negi_list_tasks") {
        const args = argumentsObject(call.arguments, ["project", "offset"]), offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 100 ||
            (args.project !== undefined && (typeof args.project !== "string" || !args.project.trim() || args.project.length > 100)))
          throw new Error("Task list filter invalid");
        const rows = service.dispatchCatalog().filter(row => args.project === undefined || row.project === args.project);
        value = { tasks: rows.slice(Number(offset), Number(offset) + 10), total: rows.length,
          nextOffset: Number(offset) + 10 < rows.length ? Number(offset) + 10 : null };
      } else {
        const allowed = call.tool === "negi_dispatch_task" ? ["run_id", "config_sha256"] : ["run_id"];
        const args = argumentsObject(call.arguments, allowed);
        if (typeof args.run_id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(args.run_id)) throw new Error("Task identity invalid");
        if (call.tool === "negi_read_task") value = publicView(service, await service.snapshot(args.run_id));
        else if (call.tool === "negi_dispatch_task") {
          if (typeof args.config_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.config_sha256)) throw new Error("Task configuration hash required");
          // Do not queue work whose complete fixed contract cannot be returned in this bounded interface.
          if (Buffer.byteLength(JSON.stringify(publicView(service, await service.snapshot(args.run_id)))) > 20_000)
            throw new Error("Task contract exceeds planner tool limit");
          value = publicView(service, await service.start(args.run_id, args.config_sha256, requestUuid(origin), origin));
        } else throw new Error("Task tool not registered");
      }
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 24_000) throw new Error("Complete Task response exceeds tool limit");
      return { success: true, text };
    } catch {
      return { success: false, text: JSON.stringify({ error: "Taskの契約・版・現在の状態を照合できません。再委任せずTask画面で確認してください。",
        nextTool: "negi_read_task", noAutomaticRetry: true }) };
    }
  } };
}
