import type { RoleDispatchContext } from "../../contracts/runs.js";
import type { CollectionSnapshot } from "../../contracts/collection.js";
import { valuationCalculationCatalog } from "../../services/valuation/records.js";
import {
  createValuationCalculationTool,
  createValuationCalculationReader,
} from "../../tools/valuation.js";
import {
  createValuationMethodTool,
  financialMetricContext,
  readValuationMethods,
  usesValuationMethods,
  valuationMethodContext,
} from "../valuation-methods.js";
import type { RoleServices } from "./services.js";

export function prepareRoleValuation(
  services: Pick<RoleServices, "runs" | "valuations">,
  { claim, definition, scope }: RoleDispatchContext,
  collection: CollectionSnapshot | null,
) {
  if (!usesValuationMethods(definition)) return undefined;
  const methods = readValuationMethods(services.runs, claim.runId);
  return {
    methods,
    tools: [
      createValuationMethodTool(methods),
      createValuationCalculationTool(services.valuations),
      createValuationCalculationReader(services.valuations, claim.runId),
    ],
    details: {
      valuationMethods: valuationMethodContext(methods, scope),
      ...(collection === null
        ? {}
        : { financialMetrics: financialMetricContext(collection.packets) }),
      valuationCalculations: valuationCalculationCatalog(
        services.runs,
        claim.runId,
      ),
    },
  };
}
