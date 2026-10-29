import catalogue from "../valuation/methods.json" with { type: "json" };
export { VALUATION_METHODS_INPUT } from "../contracts/valuation.js";
import type { ResearchScope } from "../contracts/data.js";
import type { CollectionPacket } from "../contracts/collection.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import { VALUATION_ENGINE_VERSION } from "../contracts/valuation.js";
import { researchTool } from "../tools/errors.js";
import { valuationMethodDetail } from "../tools/valuation.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../tools/parameters.js";

export const VALUATION_METHODS = catalogue;
export type ValuationMethods = typeof catalogue;

export function usesValuationMethods(taskId: string): boolean {
  return (
    taskId === "analysis.fundamentals" ||
    taskId.startsWith("debate.") ||
    taskId === "risk.main" ||
    taskId === "risk.valuation" ||
    taskId === "manager.decision"
  );
}

export { savedValuationMethods as readValuationMethods } from "../services/valuation-calculations.js";

/** Supply the latest derived observations, retaining full history in the snapshot. */
export function financialMetricContext(packets: readonly CollectionPacket[]) {
  const packet = packets.find(({ id }) => id === "financial.metrics");
  if (packet === undefined) return undefined;
  const { data } = packet.envelope;
  const latest = (historical: boolean) =>
    data.rows
      .filter((row) =>
        Object.entries(row.values).some(
          ([field, value]) =>
            field.startsWith("HISTORY_") === historical && value !== null,
        ),
      )
      .map(({ date }) => date)
      .sort()
      .at(-1);
  const dates = new Set([latest(false), latest(true)]);
  const observations = data.rows.flatMap((row, index) =>
    dates.has(row.date)
      ? [
          {
            ...row,
            index,
            values: Object.fromEntries(
              Object.entries(row.values).filter(([, value]) => value !== null),
            ),
          },
        ]
      : [],
  );
  const fields = new Set(
    observations.flatMap(({ values }) => Object.keys(values)),
  );
  return {
    table: data.table,
    currency: data.currency,
    amountUnit: "unit",
    sharesUnit: "unit",
    columns: Object.fromEntries(
      Object.entries(data.columns).filter(([field]) => fields.has(field)),
    ),
    observations,
    attributes: data.attributes,
    historicalKnowledge: packet.envelope.historicalKnowledge,
    stale: packet.envelope.stale,
  };
}

export function valuationMethodContext(
  methods: ValuationMethods,
  scope: ResearchScope,
) {
  return {
    version: methods.version,
    calculationEngineVersion: VALUATION_ENGINE_VERSION,
    reviewedAt: methods.reviewedAt,
    valuationDate: scope.date,
    targetDate: decisionPolicy(scope.date).horizonEndDate,
    selectionBasis: methods.selectionBasis,
    methods: methods.methods.map(({ id, name }) => ({ id, name })),
    stageGuidance: methods.stageGuidance,
    typeOverlays: methods.typeOverlays.map(
      ({ feature, methodIds, constraint }) => ({
        feature,
        methodIds,
        constraint,
      }),
    ),
  };
}

export function createValuationMethodTool(methods: ValuationMethods) {
  return researchTool({
    name: "stock_read_valuation_method",
    description:
      "Read one selected valuation method's formulas, required input schema, applicability and references. Supply company data and forecast assumptions through the research.",
    parameters: objectSchema({
      methodId: { type: "string", enum: methods.methods.map(({ id }) => id) },
    }),
    output: resultOutput(
      objectSchema({
        version: stringSchema,
        calculationEngineVersion: stringSchema,
        conventions: opaqueObjectSchema,
        method: opaqueObjectSchema,
        sources: { type: "array", items: opaqueObjectSchema },
        calculationInputSchema: opaqueObjectSchema,
      }),
    ),
    async execute(value, exec) {
      exec.signal.throwIfAborted();
      const input = object(value, ["methodId"]);
      const methodId = text(input.methodId, "methodId");
      return valuationMethodDetail(methods, methodId);
    },
  });
}
