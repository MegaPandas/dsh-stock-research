import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { authorizeRun, type SessionBindings } from "../host/bindings.js";
import { createReportSubmission } from "../host/report-submission.js";
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
  const submitReport = createReportSubmission(services.artifacts, bindings);
  const serviceTools: ToolDefinition[] = (
    ["stock_make_digest", "stock_decide"] as const
  ).map((name): ToolDefinition => ({
    name,
    description:
      name === "stock_make_digest"
        ? "Execute an executor={kind:service,service:digest} task: combine and submit handoffs, preserving fixed numbers, risks and gaps."
        : "Execute an executor={kind:service,service:finalize} task (built-in taskId=finalize). Use the validated manager draft, preserve its rating or null and gaps, and publish decision and report together.",
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
        "Submit the current role task's complete artifact array; check numbers and register atomically. Service artifacts are submitted through the digest and finalization tools.",
      parameters: saveReportParameters(),
      output: commitOutput,
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["requestId", "contents"]);
        const requestId = text(item.requestId, "requestId");
        return submitReport(item.contents, requestId, exec);
      },
    },
    {
      name: "stock_remember",
      description:
        "Write or revise independent review memory for the bound historical run. Request returns explicitly; if unavailable, submit a note identifying the gaps.",
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
