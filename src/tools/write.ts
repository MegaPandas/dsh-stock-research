import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import type { SessionBindings } from "../host/bindings.js";
import { createReportSubmission } from "../host/report-submission.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { MemoryService } from "../services/memory.js";
import { researchTool } from "./errors.js";
import {
  artifactCommitOutput,
  object,
  objectSchema,
  resultOutput,
  stringSchema,
  text,
} from "./parameters.js";
import { captureQueryPolicy } from "./query-inputs.js";
import type { QueryPolicy } from "../contracts/query.js";
import {
  memoryRefSchema,
  rememberInput,
  rememberInputSchema,
} from "./write-inputs.js";
import { saveReportParameters } from "./artifact-inputs.js";

export interface WriteToolServices {
  artifacts: Pick<ArtifactService, "submitArtifact">;
  memory: Pick<MemoryService, "remember">;
}
export function createWriteTools(
  services: WriteToolServices,
  bindings: SessionBindings,
  policy: QueryPolicy,
): ToolDefinition[] {
  const captured = captureQueryPolicy(policy);
  const submitReport = createReportSubmission(services.artifacts, bindings);
  const tools: ToolDefinition[] = [
    {
      name: "stock_save_report",
      description:
        "Submit the current role task's complete artifact array; check numbers and register atomically. Service artifacts are submitted through the digest and finalization tools.",
      parameters: saveReportParameters(),
      output: artifactCommitOutput,
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
  ];
  return tools.map(researchTool);
}
