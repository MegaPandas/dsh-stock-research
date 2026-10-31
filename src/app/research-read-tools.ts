import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentReport } from "../contracts/agent-reports.js";
import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { RunReader } from "../contracts/run-access.js";
import type { RunView } from "../contracts/runs.js";
import { opaqueObjectSchema, resultOutput } from "../tools/parameters.js";

export function createResearchReadTools(
  runs: Pick<RunReader, "readArtifact">,
  tools: readonly ToolDefinition[],
): ToolDefinition[] {
  return tools.flatMap((tool): ToolDefinition[] => {
    if (tool.name === "stock_read_artifact")
      return [
        {
          ...tool,
          description:
            "Read a fixed artifact for review. Final reports return the rendered body; source details remain in the saved artifact.",
          execute: async (value, exec) => {
            const result = (await tool.execute(value, exec)) as {
              kind: "artifact";
              artifact: ArtifactVersion;
            };
            const { artifact } = result;
            if (artifact.content.kind !== "report") return result;
            const { kind, title, body } = artifact.content;
            return {
              ...result,
              artifact: { ...artifact, content: { kind, title, body } },
            };
          },
        },
      ];
    if (tool.name === "stock_read_run")
      return [
        {
          ...tool,
          output: resultOutput(opaqueObjectSchema),
          execute: async (value, exec) => {
            const result = (await tool.execute(value, exec)) as {
              kind: string;
              view?: RunView;
            };
            if (result.kind !== "run_view") return result;
            return {
              ...result,
              reportCatalog: result.view!.tasks.flatMap(({ outputRefs }) =>
                outputRefs.map((ref) => {
                  const artifact = runs.readArtifact(ref);
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
        },
      ];
    return [];
  });
}
