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
          ? "Dispatch a ready task with executor.kind=role; wait for execution and cleanup, then return status and artifact references. If its stage declares dispatch=together and multiple peers are ready, use stock_dispatch_stage. Use stock_make_digest for digests and stock_decide for finalization."
          : name === "stock_followup_task"
            ? "Request revisions from the original child agent after submission, preserving its session and draft; return a new version. Rerun and review affected downstream tasks. Set resumeSearch=true when the user or primary agent decides to resume search; retain usage and require approval for each search over budget."
            : "Redo a task and affected downstream tasks in an authorized run, preserving historical versions. Wait for invalidated role executions to release before returning the receipt.",
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
        "When all roles in a stage are ready, dispatch them in parallel; wait for execution and cleanup, then return individual results for primary-agent review. Stages declaring dispatch=together require this entry for multiple ready peers; use stock_dispatch_task for a single ready revision.",
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
