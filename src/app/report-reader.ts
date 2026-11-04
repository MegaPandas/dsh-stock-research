import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { ArtifactRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { reportMaterial, reportSectionNames } from "../report/material.js";
import { artifactKey } from "../contracts/artifact-identity.js";
import { researchTool } from "../host/tool-protocol/errors.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  sectionSelectionSchema,
  selectedSections,
  stringSchema,
  text,
} from "../host/tool-protocol/parameters.js";

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
      sections: reportSectionNames(report.content),
    })),
    tool: researchTool({
      name: "stock_read_report",
      description:
        "Read fixed report sections by catalog id. Use catalog section names; sections=[] lists them without the body, sections=null explicitly reads the complete report.",
      parameters: objectSchema({
        id: stringSchema,
        sections: sectionSelectionSchema,
      }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["id", "sections"]);
        const id = text(item.id, "id");
        const entry = entries.find((entry) => entry.id === id);
        if (entry === undefined)
          throw new ResearchError("INVALID_INPUT", "Unknown report id.");
        const availableSections = reportSectionNames(entry.report.content);
        const selected = selectedSections(item.sections, availableSections);
        if (selected.length === 0)
          return { title: entry.report.content.title, availableSections };
        const material = reportMaterial(entry.report.content);
        if (material.body !== undefined)
          return { ...material, availableSections };
        const { content, summary, ...metadata } = material;
        return {
          ...metadata,
          availableSections,
          ...(selected.includes("summary") ? { summary } : {}),
          content: structuredClone(
            Object.fromEntries(
              selected
                .filter((section) => Object.hasOwn(content, section))
                .map((section) => [
                  section,
                  (content as Record<string, unknown>)[section],
                ]),
            ),
          ),
        };
      },
    }),
  };
}
