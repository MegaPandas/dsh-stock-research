import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { ArtifactRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { reportMaterial } from "../report/material.js";
import { artifactKey } from "../services/run-dependencies.js";
import { researchTool } from "../tools/errors.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../tools/parameters.js";

export function createReportReader(
  reports: readonly ArtifactVersion[],
  inContext: readonly ArtifactRef[],
) {
  const included = new Set(inContext.map(artifactKey));
  const entries = reports
    .filter((report) => !included.has(artifactKey(report.ref)))
    .map((report, index) => ({
      id: `report-${index + 1}`,
      report,
    }));
  return {
    catalog: entries.map(({ id, report }) => ({
      id,
      role: report.taskId,
      kind: report.content.kind,
      title: report.content.title,
    })),
    tool: researchTool({
      name: "stock_read_report",
      description: "按目录id读取尚未直接提供在上下文中的固定版本报告。",
      parameters: objectSchema({ id: stringSchema }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value) {
        const item = object(value, ["id"]);
        const id = text(item.id, "id");
        const entry = entries.find((entry) => entry.id === id);
        if (entry === undefined)
          throw new ResearchError("INVALID_INPUT", "Unknown report id.");
        return reportMaterial(entry.report.content);
      },
    }),
  };
}
