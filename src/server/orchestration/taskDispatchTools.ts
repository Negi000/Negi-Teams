// Planner tools dispatch the same fixed catalog and scheduler used by the Task UI.
// They cannot create roots/commands, alter contracts, approve operations or accept results.
import { createHash } from "node:crypto";
import type { CodexDynamicToolCall, CodexDynamicToolDefinition, CodexDynamicToolResult, CodexDynamicToolLimits } from "../master/appServerClient.ts";
import type { LocalTaskService, TaskRunView, TaskRequestOrigin } from "./taskService.ts";
import type { TaskResultContext } from "./taskResults.ts";
import type { LocalTaskAuthoringService } from "./taskAuthoring.ts";
import { TaskDecompositionKeyError } from "./taskDecomposition.ts";
import { taskResultRecipient } from "../../shared/taskResults.ts";

const runId = { type: "string", pattern: "^[a-zA-Z0-9._-]{1,100}$" };
const baselineId = { type: "string", pattern: "^base-[a-f0-9]{24}$" };
const configHash = { type: "string", pattern: "^[a-f0-9]{64}$" };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): CodexDynamicToolDefinition {
  return { type: "function", name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const definitions = [
  definition("negi_list_task_results", "この統括の会話から委任したTaskの固定結果通知と伝達状態を確認する。通知時点の状態と現在のTask、人間受入を区別する。", {}, []),
  definition("negi_list_tasks", "登録済みTaskの固定カタログを検索する。未登録の依頼は先にTask Contractの確定が必要。", {
    project: { type: "string", minLength: 1, maxLength: 100 }, offset: { type: "integer", minimum: 0, maximum: 100 } }, []),
  definition("negi_read_task", "Taskの固定契約、担当、現在の実行・検証・人間受入状態を確認する。再委任前に使う。", { run_id: runId }, ["run_id"]),
  definition("negi_dispatch_task", "登録済みの固定TaskだけをUIと同じschedulerへ委任する。契約、担当モデル、checkout、検証条件を変更しない。結果不明時は再委任せず現在のTaskを読む。", {
    run_id: runId, config_sha256: configHash }, ["run_id", "config_sha256"]),
];
const planText = { type:"string", minLength:1, maxLength:300 };
const planList = { type:"array", minItems:1, maxItems:20, items:planText };
const taskSchema = {type:"object",additionalProperties:false,properties:{
  title:{type:"string",minLength:1,maxLength:160},objective:{type:"string",minLength:1,maxLength:2000},
  inScope:planList,outOfScope:planList,allowedPaths:planList,invariants:planList,acceptance:planList,escalation:planList,
  implementationPlan:{...planList,items:{type:"string",minLength:1,maxLength:500}},
  references:{type:"array",minItems:1,maxItems:50,items:{type:"object",additionalProperties:false,properties:{id:runId,
    version:{type:"integer",minimum:1},sha256:configHash},required:["id","version","sha256"]}},
  maxAttempts:{type:"integer",minimum:1,maximum:3},timeLimitMinutes:{type:"integer",minimum:1,maximum:480}},
  required:["title","objective","inScope","outOfScope","allowedPaths","invariants","acceptance","escalation","implementationPlan","references","maxAttempts","timeLimitMinutes"]};
const authoringDefinitions = [
  definition("negi_list_projects", "新しい独立Taskを作れる、利用者設定済みプロジェクトと実行条件を読む。保存先・コマンド・モデル・権限は変更できない。", {}, []),
  definition("negi_read_project", "契約案を作る前に必須仕様と指定した参照の全文・版・hashを読む。未確認の仕様や依存Taskを推測せず、独立Taskだけを計画する。", {
    profile_id:runId, baseline_id:baselineId, reference_ids:{type:"array",maxItems:50,items:runId} },["profile_id"]),
  definition("negi_propose_task", "利用者の新しい依頼について、読んだ仕様に基づく短い契約案とSolへの実行計画を保存する。実装・Vault active化・worktree作成・成果受入は行わない。契約画面URLを利用者に案内する。依存Taskが必要なら案を作らずその依存を解決する。", {
    profile_id:runId, baseline_id:baselineId, task:taskSchema },["profile_id","task"]),
  definition("negi_propose_task_decomposition", "大きい依頼を2〜8件の契約案へ分解して一括保存する。独立Taskは変更範囲を分ける。依存は同じ案のnode keyで指定し、引継ぎ成果と共有条件を明記する。先行Taskがある後続は計画表示のみで確定・実行できず、先行成果の統合後に実際の基準SHAで新しい案が必要。小さい依頼はnegi_propose_taskを使う。", {
    profile_id:runId, baseline_id:baselineId, decomposition:{type:"object",additionalProperties:false,properties:{
      title:{type:"string",minLength:1,maxLength:160},objective:{type:"string",minLength:1,maxLength:2000},
      coordination:{type:"array",minItems:1,maxItems:8,items:{type:"string",minLength:1,maxLength:500}},
      nodes:{type:"array",minItems:2,maxItems:8,items:{type:"object",additionalProperties:false,properties:{
        key:{type:"string",pattern:"^[a-z][a-z0-9-]{0,39}$"},
        dependsOn:{type:"array",maxItems:7,items:{type:"string",pattern:"^[a-z][a-z0-9-]{0,39}$"}},
        handoff:{type:"string",minLength:1,maxLength:500},task:taskSchema},required:["key","dependsOn","handoff","task"]}}},
      required:["title","objective","coordination","nodes"]} },["profile_id","decomposition"]),
];
export interface RegisteredTaskTools {
  definitions: CodexDynamicToolDefinition[];
  limits?: Record<string, CodexDynamicToolLimits>;
  invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult>;
  prepareResultContext?: (threadId: string, input: string) => Promise<TaskResultContext | null>;
  authoring?: boolean;
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
    outOfScope: view.outOfScope, verification: view.verification, planner: view.astra,
    worker: view.taskMode==="read_only_research"?view.luna:view.sol,
    ...(view.taskMode?{taskMode:view.taskMode,workerRole:"luna"}:{}),
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
export function registeredTaskTools(service: LocalTaskService, masterId: string,
  authoring?: { service:LocalTaskAuthoringService; planner:{model:string;effort:string} }): RegisteredTaskTools {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(masterId)) throw new Error("Task planner identity invalid");
  return { definitions: structuredClone([...definitions,...(authoring?authoringDefinitions:[])]), ...(authoring?{authoring:true,
    limits: { negi_propose_task: { argumentBytes: 10_000, resultBytes: 24_000 },
      negi_propose_task_decomposition: { argumentBytes: 50_000, resultBytes: 24_000 },
      negi_read_project: { argumentBytes: 8000, resultBytes: 64_000 } }}:{}),
    prepareResultContext: (threadId, input) => service.prepareResultContext(masterId, threadId, input), async invoke(call) {
    try {
      const origin: TaskRequestOrigin = { kind: "master", masterId, threadId: call.threadId, turnId: call.turnId, callId: call.callId };
      if (![call.threadId, call.turnId, call.callId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id)))
        throw new Error("Planner call identity invalid");
      let value: unknown;
      if (authoring && call.tool === "negi_list_projects") {
        argumentsObject(call.arguments,[]); value = { projects:authoring.service.listProfiles() };
      } else if (authoring && ["negi_read_project","negi_propose_task","negi_propose_task_decomposition"].includes(call.tool)) {
        const args=argumentsObject(call.arguments,call.tool==="negi_read_project"?["profile_id","reference_ids","baseline_id"]:
          call.tool==="negi_propose_task_decomposition"?["profile_id","decomposition","baseline_id"]:["profile_id","task","baseline_id"]);
        if (typeof args.profile_id!=="string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(args.profile_id)) throw new Error("Project profile identity invalid");
        if(args.baseline_id!==undefined&&(typeof args.baseline_id!=="string"||!/^base-[a-f0-9]{24}$/.test(args.baseline_id)))throw Error("Integration baseline identity invalid");
        if (call.tool==="negi_read_project") {
          if (args.reference_ids!==undefined && (!Array.isArray(args.reference_ids) || args.reference_ids.some(id=>typeof id!=="string"))) throw new Error("Project references invalid");
          value=await authoring.service.readProject(args.profile_id,args.reference_ids as string[]|undefined,args.baseline_id as string|undefined);
        } else if(call.tool==="negi_propose_task_decomposition") {
          const drafts=await authoring.service.proposeDecomposition(args.profile_id,args.decomposition,{...origin,...authoring.planner},args.baseline_id as string|undefined);
          const group=drafts[0].decomposition!;
          value={decompositionId:group.id,title:group.title,hash:group.hash,url:`/task-plans?draft=${drafts[0].id}`,
            tasks:drafts.map(d=>({draftId:d.id,key:d.decomposition!.key,title:d.title,dependsOn:d.decomposition!.dependsOn,
              status:d.status,canFinalize:d.canFinalize,url:`/task-plans?draft=${d.id}`})),
            executionStarted:false,humanConfirmationRequired:true,
            successorsRequireNewPlanAfterIntegration:drafts.every(d=>d.taskMode!=="read_only_research"),
            ...(drafts.some(d=>d.taskMode==="read_only_research")?{successorsRequireNewResearchContract:true}: {})};
        } else {
          const draft=await authoring.service.propose(args.profile_id,args.task,{...origin,...authoring.planner},args.baseline_id as string|undefined);
          value={draftId:draft.id,title:draft.title,hash:draft.hash,status:draft.status,
            url:`/task-plans?draft=${draft.id}`,executionStarted:false,humanConfirmationRequired:true};
        }
      } else if (call.tool === "negi_list_task_results") {
        argumentsObject(call.arguments, []);
        value = { notifications: (await service.resultNotifications()).filter(n => {
          const recipient = taskResultRecipient(n);
          return !n.supersededBy && recipient?.masterId === masterId && recipient.threadId === call.threadId;
        }).slice(0, 8), frozenAtNotification: true };
      } else if (call.tool === "negi_list_tasks") {
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
      if (Buffer.byteLength(text) > (call.tool==="negi_read_project"?64_000:24_000)) throw new Error("Complete Task response exceeds tool limit");
      return { success: true, text };
    } catch (error) {
      if (call.tool === "negi_propose_task_decomposition" && error instanceof TaskDecompositionKeyError) {
        return { success: false, text: JSON.stringify({ code: "invalid_decomposition_key",
          error: "作業IDは小文字の英字から始め、英小文字・数字・ハイフンだけで40文字以内にしてください。依存先も同じIDを使います。例: task-counts。",
          field: `decomposition.nodes[${error.nodeIndex}].${error.field}`, saved: false, executionStarted: false,
          noAutomaticRetry: true }) };
      }
      return { success: false, text: JSON.stringify({ error: "Taskの契約・版・現在の状態を照合できません。再委任せずTask画面で確認してください。",
        nextTool: call.tool.includes("project")||call.tool.startsWith("negi_propose_task") ? "negi_read_project" : "negi_read_task", noAutomaticRetry: true }) };
    }
  } };
}
