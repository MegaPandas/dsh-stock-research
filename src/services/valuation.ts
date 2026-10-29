import type {
  AgentReport,
  ValuationRecord,
} from "../contracts/agent-reports.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import { parseLocalDate } from "../contracts/time.js";

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
  taskId: string,
  scope: ResearchScope,
  methodIds: readonly string[],
): void {
  const ownsValuation =
    taskId === "analysis.fundamentals" || taskId === "manager.decision";
  if (!("valuation" in report.content) || report.content.valuation == null) {
    if (ownsValuation)
      invalid(
        "Write the valuation section, retaining missing inputs and null value ranges when quantification is unsupported.",
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
  if (taskId === "manager.decision") {
    const targetPrice = (report as AgentReport<"decision_draft">).content
      .targetPrice;
    if (targetPrice !== null) {
      if (record.targetPriceBasis === null)
        invalid(
          "Explain the target-price scenario and the relationship between valuation-date value and target-date price in targetPriceBasis.",
        );
      if (!record.methods.some(({ valueRange }) => valueRange !== null))
        invalid(
          "A numeric target price requires at least one supported value range; otherwise retain targetPrice=null.",
        );
    } else if (record.targetPriceBasis !== null)
      invalid("Keep targetPriceBasis=null when targetPrice is null.");
  }
}
