import type { LocalDate } from "./data.js";

export const PRICE_RATING_POLICY = "absolute-price-6m/1";
export const PRICE_RATING_MONTHS = 6;
export const PRICE_RATING_BANDS = [
  { rating: "buy", label: "买入", interval: "r > 15%" },
  { rating: "overweight", label: "增持", interval: "5% < r <= 15%" },
  { rating: "neutral", label: "中性", interval: "-5% <= r <= 5%" },
  { rating: "underweight", label: "减持", interval: "-15% <= r < -5%" },
  { rating: "sell", label: "卖出", interval: "r < -15%" },
] as const;
export type PriceRating = (typeof PRICE_RATING_BANDS)[number]["rating"];
const PRICE_RATIO_PERCENT = 100n;
const PRICE_RATIO_BOUNDARIES = {
  buy: 115n,
  overweight: 105n,
  neutral: 95n,
  underweight: 85n,
} as const;

function decimalPrice(price: number) {
  const [coefficient, exponent = "0"] = price.toString().split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const power = Number(exponent) - fraction.length;
  return {
    numerator:
      BigInt(`${whole}${fraction}`) * 10n ** BigInt(Math.max(power, 0)),
    denominator: 10n ** BigInt(Math.max(-power, 0)),
  };
}

export function decisionPolicy(date: LocalDate) {
  const horizon = new Date(`${date}T00:00:00.000Z`);
  const day = horizon.getUTCDate();
  horizon.setUTCDate(1);
  horizon.setUTCMonth(horizon.getUTCMonth() + PRICE_RATING_MONTHS);
  const lastDay = new Date(
    Date.UTC(horizon.getUTCFullYear(), horizon.getUTCMonth() + 1, 0),
  ).getUTCDate();
  horizon.setUTCDate(Math.min(day, lastDay));
  return {
    version: PRICE_RATING_POLICY,
    basis: "absolute_price" as const,
    horizonEndDate: horizon.toISOString().slice(0, 10),
    formula: "targetPrice / referencePrice - 1",
    bands: PRICE_RATING_BANDS,
  };
}

/** Prices arrive with the positive-base/nonnegative-target contract established. */
export function priceRating(
  base: number | null,
  target: number | null,
): PriceRating | null {
  if (base === null || target === null) return null;
  // Compare the stored decimal prices exactly: 1.61 / 1.40 is a +15% endpoint.
  const basePrice = decimalPrice(base);
  const targetPrice = decimalPrice(target);
  const targetNumerator =
    targetPrice.numerator * basePrice.denominator * PRICE_RATIO_PERCENT;
  const baseNumerator = basePrice.numerator * targetPrice.denominator;
  if (targetNumerator > baseNumerator * PRICE_RATIO_BOUNDARIES.buy)
    return "buy";
  if (targetNumerator > baseNumerator * PRICE_RATIO_BOUNDARIES.overweight)
    return "overweight";
  if (targetNumerator >= baseNumerator * PRICE_RATIO_BOUNDARIES.neutral)
    return "neutral";
  if (targetNumerator >= baseNumerator * PRICE_RATIO_BOUNDARIES.underweight)
    return "underweight";
  return "sell";
}
