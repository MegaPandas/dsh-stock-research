import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import {
  authorizeRun,
  taskOperation,
  type SessionBindings,
} from "../host/bindings.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { DecisionService } from "../services/decisions.js";
import type { DigestService } from "../services/digests.js";
import type { MemoryService } from "../services/memory.js";
import { researchTool } from "./errors.js";
import {
  artifactRefSchema,
  object,
  objectSchema,
  resultOutput,
  stringSchema,
  text,
} from "./parameters.js";
import { captureQueryPolicy, type QueryToolPolicy } from "./query-inputs.js";
import {
  memoryRefSchema,
  rememberInput,
  rememberInputSchema,
} from "./write-inputs.js";
import { saveReportParameters } from "./artifact-inputs.js";

export interface WriteToolServices {
  artifacts: ArtifactService;
  memory: MemoryService;
  digests: Pick<DigestService, "makeDigest">;
  decisions: DecisionService;
}
const serviceParameters = objectSchema({
  runId: stringSchema,
  taskId: stringSchema,
  requestId: stringSchema,
});
const commitOutput = resultOutput(
  objectSchema({
    runId: stringSchema,
    taskId: stringSchema,
    attempt: { type: "integer" },
    refs: { type: "array", items: artifactRefSchema },
  }),
);
export function createWriteTools(
  services: WriteToolServices,
  bindings: SessionBindings,
  policy: QueryToolPolicy,
): ToolDefinition[] {
  const captured = captureQueryPolicy(policy);
  const serviceTools: ToolDefinition[] = (
    ["stock_make_digest", "stock_decide"] as const
  ).map((name): ToolDefinition => ({
    name,
    description:
      name === "stock_make_digest"
        ? "仅执行executor={kind:service,service:digest}的摘要任务，保留固定数字、风险与缺口并提交。"
        : "执行executor={kind:service,service:finalize}的定档任务（内置taskId为finalize）。消费已验证经理稿，保留评级或空值、缺口，成对发布decision与report；此任务不能用stock_dispatch_task。",
    parameters: serviceParameters,
    output: commitOutput,
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
      const operation = { runId, identity: caller.agent.id };
      const taskId = text(item.taskId, "taskId");
      const requestId = text(item.requestId, "requestId");
      return name === "stock_make_digest"
        ? services.digests.makeDigest(operation, taskId, requestId, exec.signal)
        : services.decisions.decide(operation, taskId, requestId, exec.signal);
    },
  }));
  const tools: ToolDefinition[] = [
    {
      name: "stock_save_report",
      description:
        "提交当前角色任务声明的完整产物数组，经一次核数门禁原子登记；不允许提交服务专用产物。",
      parameters: saveReportParameters(),
      output: commitOutput,
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const operation = taskOperation(bindings.require(exec.agent));
        const item = object(value, ["requestId", "contents"]);
        const requestId = text(item.requestId, "requestId");
        if (Array.isArray(item.contents))
          for (const content of item.contents) {
            const kind = (content as { kind?: unknown } | null)?.kind;
            if (kind === "digest" || kind === "decision" || kind === "report")
              throw new ResearchError(
                "ACCESS_DENIED",
                "Service artifacts cannot be written through stock_save_report.",
              );
          }
        return services.artifacts.submitArtifact(
          operation,
          item.contents,
          requestId,
        );
      },
    },
    {
      name: "stock_remember",
      description:
        "为绑定的历史运行写独立复盘记忆或修订。收益须明确请求，取不到时可提交带明确缺口的笔记。",
      parameters: objectSchema({
        requestId: stringSchema,
        input: rememberInputSchema,
      }),
      output: resultOutput(memoryRefSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        if (caller.binding.kind !== "review")
          throw new ResearchError(
            "ACCESS_DENIED",
            "Memory writes require a review binding.",
          );
        const item = object(value, ["requestId", "input"]);
        const input = rememberInput(item.input, caller.binding.scope, captured);
        return services.memory.remember(
          {
            runId: caller.binding.runId,
            identity: caller.agent.id,
            scope: caller.binding.scope,
          },
          input,
          text(item.requestId, "requestId"),
          exec.signal,
        );
      },
    },
    ...serviceTools,
  ];
  return tools.map(researchTool);
}
