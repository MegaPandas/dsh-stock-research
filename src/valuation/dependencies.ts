import type { ValuationRequest } from "../contracts/valuation.js";

export function valuationDependencyIds(request: ValuationRequest): string[] {
  if (request.methodId === "sum_of_parts")
    return request.inputs.parts.map(({ calculationId }) => calculationId);
  if (
    request.methodId === "scenario_dcf_rnpv" &&
    request.inputs.kind === "scenarios"
  )
    return request.inputs.scenarios.map(({ calculationId }) => calculationId);
  return [];
}
