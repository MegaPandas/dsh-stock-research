import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentReport } from "../contracts/agent-reports.js";
import { ResearchError } from "../contracts/errors.js";
import type { RunReadOperations } from "../host/run-reading.js";
import { reportMaterial } from "../report/material.js";
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
        "Read a fixed report and handoff for review. Set view=full only to inspect the complete stored artifact, including evidence references and numeric claims.",
      parameters: objectSchema(
        {
          ref: artifactRefSchema,
          view: { type: "string", enum: ["business", "full"] },
        },
        ["ref"],
      ),
      output: resultOutput(
        objectSchema({
          kind: { type: "string", const: "artifact" },
          artifact: opaqueObjectSchema,
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["ref", "view"]);
        if (
          item.view !== undefined &&
          item.view !== "business" &&
          item.view !== "full"
        )
          throw new ResearchError("INVALID_INPUT", "Unknown artifact view.");
        const artifact = reads.readArtifact(artifactRef(item.ref), exec);
        if (item.view === "full") return { kind: "artifact", artifact };
        const { kind, payload } = artifact.content;
        return {
          kind: "artifact",
          artifact: {
            ...artifact,
            content: {
              kind,
              ...reportMaterial(artifact.content),
              ...(payload.stageHandoff === undefined
                ? {}
                : { stageHandoff: payload.stageHandoff }),
            },
          },
        };
      },
    }),
  ];
}
