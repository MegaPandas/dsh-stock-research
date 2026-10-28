import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { authorizeRun, type SessionBindings } from "../host/bindings.js";
import type { DispatchBridge } from "../host/dispatch.js";
import { researchTool } from "./errors.js";
import {
  artifactRefSchema,
  object,
  objectSchema,
  resultOutput,
  stringSchema,
  text,
} from "./parameters.js";

const fields = {
  runId: stringSchema,
  taskId: stringSchema,
  requestId: stringSchema,
};
const dispatchResultSchema = objectSchema({
  runId: stringSchema,
  taskId: stringSchema,
  attempt: { type: "integer" },
  status: {
    type: "string",
    enum: ["running", "succeeded", "failed", "invalidated", "cancelled"],
  },
  sessionId: { oneOf: [stringSchema, { type: "null" }] },
  refs: { type: "array", items: artifactRefSchema },
  failure: {
    oneOf: [
      objectSchema({ code: stringSchema, message: stringSchema }),
      { type: "null" },
    ],
  },
});
const dispatchOutput = resultOutput(dispatchResultSchema);
const redoOutput = resultOutput(
  objectSchema({
    runId: stringSchema,
    taskId: stringSchema,
    status: { type: "string", enum: ["active", "blocked"] },
    affectedTasks: { type: "array", items: stringSchema },
    stopAttempts: {
      type: "array",
      items: objectSchema({
        taskId: stringSchema,
        attempt: { type: "integer" },
      }),
    },
    invalidatedRefs: { type: "array", items: artifactRefSchema },
  }),
);

export function createControlTools(
  bridge: DispatchBridge,
  bindings: SessionBindings,
): ToolDefinition[] {
  const controls = (
    ["stock_dispatch_task", "stock_redo_task", "stock_followup_task"] as const
  ).map((name): ToolDefinition =>
    researchTool({
      name,
      description:
        name === "stock_dispatch_task"
          ? "仅派发executor.kind=role的就绪角色任务。digest服务用stock_make_digest，finalize服务必须用stock_decide。等待执行和清理，以登记产物判定完成。"
          : name === "stock_followup_task"
            ? "向已经提交结果的同一个研究子Agent继续发送修改或补充要求，保留原会话和报告草稿，返回修订版本；受影响下游须重新推进和验收。resumeSearch仅在用户或主Agent明确决定恢复搜索时设为true，恢复不会重置搜索额度，超额仍需用户审批。"
            : "重做获准运行中的任务及受影响下游，保留历史版本，等待失效角色执行释放后返回回执。",
      parameters:
        name === "stock_dispatch_task"
          ? objectSchema(fields)
          : name === "stock_followup_task"
            ? objectSchema(
                {
                  ...fields,
                  message: stringSchema,
                  resumeSearch: { type: "boolean" },
                },
                [...Object.keys(fields), "message"],
              )
            : objectSchema(
                { ...fields, reason: stringSchema },
                Object.keys(fields),
              ),
      output: name === "stock_redo_task" ? redoOutput : dispatchOutput,
      // Attempts and children are isolated; the host manages their shared capacity.
      isConcurrencySafe: () => name === "stock_dispatch_task",
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        if (caller.binding.kind !== "coordinator")
          throw new ResearchError(
            "ACCESS_DENIED",
            "Research control requires a coordinator binding.",
          );
        const item = object(
          value,
          name === "stock_dispatch_task"
            ? Object.keys(fields)
            : name === "stock_followup_task"
              ? [...Object.keys(fields), "message", "resumeSearch"]
              : [...Object.keys(fields), "reason"],
        );
        const runId = text(item.runId, "runId");
        authorizeRun(caller.binding, runId);
        const taskId = text(item.taskId, "taskId");
        const requestId = text(item.requestId, "requestId");
        if (name === "stock_followup_task") {
          if (
            item.resumeSearch !== undefined &&
            typeof item.resumeSearch !== "boolean"
          )
            throw new ResearchError(
              "INVALID_INPUT",
              "resumeSearch must be boolean.",
            );
          return bridge.followup(
            caller.agent,
            runId,
            taskId,
            text(item.message, "message"),
            requestId,
            item.resumeSearch === true,
            exec.signal,
          );
        }
        return name === "stock_dispatch_task"
          ? bridge.dispatch(caller.agent, runId, taskId, requestId, exec.signal)
          : bridge.redo(
              { runId, identity: caller.agent.id },
              taskId,
              requestId,
              item.reason === undefined ? null : text(item.reason, "reason"),
            );
      },
    }),
  );
  return [
    ...controls,
    researchTool({
      name: "stock_dispatch_stage",
      description:
        "并行派发所选阶段的全部角色；阶段内所有角色都须就绪。等待各子任务执行与清理后返回逐项结果。独立多空同时就绪时必须使用本工具；单侧返工使用stock_dispatch_task。阶段验收仍由主Agent完成，不自动推进下游。",
      parameters: objectSchema({
        runId: stringSchema,
        stageId: stringSchema,
        requestId: stringSchema,
      }),
      output: resultOutput(
        objectSchema({
          runId: stringSchema,
          stageId: stringSchema,
          results: { type: "array", items: dispatchResultSchema },
        }),
      ),
      isConcurrencySafe: () => true,
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        if (caller.binding.kind !== "coordinator")
          throw new ResearchError(
            "ACCESS_DENIED",
            "Research control requires a coordinator binding.",
          );
        const item = object(value, ["runId", "stageId", "requestId"]);
        const runId = text(item.runId, "runId");
        authorizeRun(caller.binding, runId);
        return bridge.dispatchStage(
          caller.agent,
          runId,
          text(item.stageId, "stageId"),
          text(item.requestId, "requestId"),
          exec.signal,
        );
      },
    }),
  ];
}
