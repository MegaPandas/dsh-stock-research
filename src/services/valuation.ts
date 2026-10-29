import type {
  AgentReport,
  ValuationRecord,
} from "../contracts/agent-reports.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import { parseLocalDate } from "../contracts/time.js";
import type { TaskDefinition } from "../contracts/workflow.js";

function invalid(detail: string): never {
  throw new ResearchError("INVALID_INPUT", `valuation: ${detail}`);
}

/** Business constraints for valuation dates, value objects and required sections. */
export function validateValuationRecord(record: ValuationRecord): void {
  parseLocalDate(record.valuationDate);
  parseLocalDate(record.targetDate);
  if (record.methods.length === 0)
    invalid(
      "Select at least one method and record its suitability or missing inputs.",
    );
  for (const method of record.methods) {
    const range = method.valueRange;
    if (range === null) {
      if (method.limitations.length === 0)
        invalid(
          `${method.methodId} requires a limitation explaining the unavailable value range.`,
        );
      continue;
    }
    if (
      !Number.isFinite(range.low) ||
      !Number.isFinite(range.high) ||
      range.low > range.high
    )
      invalid(`${method.methodId} requires a finite ordered value range.`);
    if (method.inputs.length === 0 || method.calculation.length === 0)
      invalid(
        `${method.methodId} requires inputs with provenance and calculation steps for a numeric range.`,
      );
  }
}

export function validateRoleValuation(
  report: AgentReport,
  requirement: TaskDefinition["valuation"],
  scope: ResearchScope,
  methodIds: readonly string[],
): void {
  if (!("valuation" in report.content) || report.content.valuation == null) {
    if (requirement !== undefined)
      invalid(
        "Write the valuation section with calculated results, assumptions and method limitations.",
      );
    return;
  }
  const record = report.content.valuation;
  if (
    record.valuationDate !== scope.date ||
    record.targetDate !== decisionPolicy(scope.date).horizonEndDate
  )
    invalid(
      "Use the research date and six-month target date supplied in context.valuationMethods.",
    );
  for (const method of record.methods) {
    if (!methodIds.includes(method.methodId))
      invalid(
        `Unknown method ${method.methodId} in this run's recorded catalogue.`,
      );
    if (method.valueRange !== null) {
      const unit =
        method.valueObject === "per_share"
          ? `${scope.security.currency}/share`
          : scope.security.currency;
      if (method.valueRange.unit !== unit)
        invalid(
          `${method.methodId} must use ${unit} for its selected value object.`,
        );
      if (method.valueObject === "per_share" && method.valueRange.low < 0)
        invalid("Common-share price ranges must be nonnegative.");
    }
  }
  if (requirement === "decision") {
    const targetPrice = (report as AgentReport<"decision_draft">).content
      .targetPrice;
    if (targetPrice === null)
      invalid(
        "A decision requires a six-month target price. Select an applicable model, justify forecast assumptions, call stock_calculate_valuation with purpose=target_price, and submit its calculationId.",
      );
    if (record.targetPriceBasis === null)
      invalid(
        "Explain the target-price scenario and the relationship between valuation-date value and target-date price in targetPriceBasis.",
      );
    if (!record.methods.some(({ valueRange }) => valueRange !== null))
      invalid("Include at least one calculated research-date value range.");
  }
}
