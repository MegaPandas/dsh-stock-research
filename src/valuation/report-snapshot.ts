import type { ValuationCalculationSnapshot } from "../contracts/agent-reports.js";
import type { JsonValue } from "../contracts/json.js";
import type { ValuationCalculation } from "../contracts/valuation.js";
import { valuationInputAt } from "./requests.js";

/** Detach report data from the immutable calculation without rounding or translation. */
export function valuationCalculationSnapshot(
  record: ValuationCalculation,
): ValuationCalculationSnapshot {
  return structuredClone({
    calculationId: record.calculationId,
    engineVersion: record.engineVersion,
    amountUnit: record.request.amountUnit,
    shareUnit: record.request.shares.unit,
    inputs: record.request.provenance.map((entry) => ({
      ...entry,
      value: valuationInputAt(record.request, entry.path) as JsonValue,
    })),
    assumptions: record.request.assumptions,
    steps: record.result.steps,
    perShareValues: record.result.perShareValues,
    sensitivities: record.sensitivities.map(({ result, ...scenario }) => ({
      ...scenario,
      perShareValues: result.perShareValues,
    })),
    diagnostics: record.result.diagnostics,
  });
}
