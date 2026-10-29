import {
  agentReportSchemas,
  calculatedReportSections,
  type AgentReportKind,
} from "../contracts/agent-reports.js";
import type { ReportDraftInput } from "../host/report-draft.js";
import type { RunService } from "../services/runs.js";
import {
  materializeTargetPrice,
  materializeValuation,
  type ValuationSelection,
} from "../services/valuation-calculations.js";

export function valuationDraftInput(
  kind: AgentReportKind,
  runs: RunService,
  runId: string,
): ReportDraftInput {
  const schema = agentReportSchemas[kind];
  return {
    sections: calculatedReportSections({
      summary: schema.properties.summary,
      ...schema.properties.content.properties,
    }),
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
