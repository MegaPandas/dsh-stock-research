import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { authorizeRun, type SessionBindings } from "../host/bindings.js";
import type { ServiceTaskOperations } from "../host/research-operations.js";
import { researchTool } from "./errors.js";
import {
  artifactCommitOutput,
  object,
  objectSchema,
  stringSchema,
  text,
} from "./parameters.js";

const parameters = objectSchema({
  runId: stringSchema,
  taskId: stringSchema,
  requestId: stringSchema,
});

export function createServiceTaskTools(
  operations: ServiceTaskOperations,
  bindings: SessionBindings,
): ToolDefinition[] {
  return (["stock_make_digest", "stock_decide"] as const).map((name) =>
    researchTool({
      name,
      description:
        name === "stock_make_digest"
          ? "Execute an executor={kind:service,service:digest} task: combine and submit handoffs, preserving fixed numbers, risks and gaps."
          : "Execute an executor={kind:service,service:finalize} task (built-in taskId=finalize). Use the validated manager draft, preserve its rating or null and gaps, and publish decision and report together.",
      parameters,
      output: artifactCommitOutput,
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        if (caller.binding.kind !== "coordinator")
          throw new ResearchError(
            "ACCESS_DENIED",
            "Service task execution requires a coordinator binding.",
          );
        const item = object(value, ["runId", "taskId", "requestId"]);
        const runId = text(item.runId, "runId");
        authorizeRun(caller.binding, runId);
        const request = {
          runId,
          taskId: text(item.taskId, "taskId"),
          requestId: text(item.requestId, "requestId"),
        };
        return name === "stock_make_digest"
          ? operations.makeDigest(request, caller, exec.signal)
          : operations.decide(request, caller, exec.signal);
      },
    }),
  );
}
