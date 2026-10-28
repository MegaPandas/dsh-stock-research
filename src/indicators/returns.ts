import { ResearchError } from "../contracts/errors.js";
import type {
  PriceReturnInput,
  PriceReturnResult,
} from "../contracts/indicators.js";

export const PRICE_RETURN_ALGORITHM_VERSION = "1";

export function calculatePriceReturn(
  input: PriceReturnInput,
): PriceReturnResult {
  const { start, end, requestedStartDate, requestedEndDate } = input;
  if (
    !Number.isFinite(start.price) ||
    start.price <= 0 ||
    !Number.isFinite(end.price) ||
    end.price < 0
  ) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Return prices must be finite; start must be positive and end nonnegative.",
    );
  }
  if (
    requestedStartDate > requestedEndDate ||
    start.date > end.date ||
    start.date > requestedStartDate ||
    end.date > requestedEndDate
  ) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Return dates must be ordered and actual prices cannot be after their requested dates.",
    );
  }
  let reason: string | null = null;
  if (start.currency !== end.currency) reason = "Price currencies differ.";
  else if (start.adjustment !== end.adjustment)
    reason = "Price adjustments differ.";
  else if (start.adjustment === "total_return_adjusted")
    reason = "Total-return prices do not represent a price-only return.";
  else if (!input.comparable)
    reason =
      "A common price basis, including corporate actions, has not been verified.";
  return {
    ...input,
    unit: "ratio",
    value: reason === null ? end.price / start.price - 1 : null,
    gaps:
      reason === null
        ? []
        : [{ code: "incomparable", field: "/value", detail: reason }],
  };
}
