import {
  agentReportSchemas,
  calculatedReportSections,
  type AgentReportKind,
} from "../../contracts/agent-reports.js";
import type { ReportDraftInput } from "../../host/report-draft.js";
import type { RunReader } from "../../contracts/run-access.js";
import {
  materializeTargetPrice,
  materializeValuation,
  type ValuationSelection,
} from "../../services/valuation/reports.js";

export function roleReportInput(
  kind: AgentReportKind,
  runs: Pick<RunReader, "numberContext" | "inputCatalog" | "readInput">,
  runId: string,
  valuationEnabled: boolean,
): ReportDraftInput {
  const schema = agentReportSchemas[kind];
  const sections = calculatedReportSections({
    summary: schema.properties.summary,
    ...schema.properties.content.properties,
  });
  if (!valuationEnabled) delete sections.valuation;
  return {
    sections,
    resolve(input) {
      const resolved = { ...input };
      if (input.valuation !== undefined && input.valuation !== null)
        resolved.valuation = materializeValuation(
          runs,
          runId,
          input.valuation as ValuationSelection,
        );
      if (input.targetPrice !== undefined && input.targetPrice !== null)
        resolved.targetPrice = materializeTargetPrice(
          runs,
          runId,
          (input.targetPrice as { calculationId: string }).calculationId,
        );
      return resolved;
    },
  };
}
