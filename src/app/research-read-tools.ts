import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentReport } from "../contracts/agent-reports.js";
import type { RunReadOperations } from "../host/run-reading.js";
import { researchTool } from "../host/tool-protocol/errors.js";
import {
  artifactRef,
  artifactRefSchema,
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../host/tool-protocol/parameters.js";

export function createResearchReadTools(
  reads: RunReadOperations,
): ToolDefinition[] {
  return [
    researchTool({
      name: "stock_read_run",
      description: "Read an authorized run's status, tasks and artifact index.",
      parameters: objectSchema({ runId: stringSchema }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["runId"]);
        const view = reads.readRun(text(item.runId, "runId"), exec);
        return {
          kind: "run_view",
          view,
          reportCatalog: view.tasks.flatMap(({ outputRefs }) =>
            outputRefs.map((ref) => {
              const artifact = reads.readArtifact(ref, exec);
              const report = artifact.content.payload.report as
                AgentReport | undefined;
              return {
                ref,
                taskId: artifact.taskId,
                kind: artifact.content.kind,
                title: artifact.content.title,
                summary: report?.summary ?? null,
              };
            }),
          ),
        };
      },
    }),
    researchTool({
      name: "stock_read_artifact",
      description:
        "Read a fixed artifact for review. Final reports return the rendered body; source details remain in the saved artifact.",
      parameters: objectSchema({ ref: artifactRefSchema }),
      output: resultOutput(
        objectSchema({
          kind: { type: "string", const: "artifact" },
          artifact: opaqueObjectSchema,
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["ref"]);
        const artifact = reads.readArtifact(artifactRef(item.ref), exec);
        if (artifact.content.kind !== "report")
          return { kind: "artifact", artifact };
        const { kind, title, body } = artifact.content;
        return {
          kind: "artifact",
          artifact: { ...artifact, content: { kind, title, body } },
        };
      },
    }),
  ];
}
