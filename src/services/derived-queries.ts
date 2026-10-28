import type {
  DataEnvelope,
  DataGap,
  MarketBar,
  MarketData,
} from "../contracts/data.js";
import type { IndicatorRequest } from "../contracts/indicators.js";
import type {
  MarketIndicatorsData,
  PriceReturnsData,
  PriceReturnsQuery,
  ReturnObservation,
} from "../contracts/query.js";
import {
  calculateIndicators,
  INDICATORS_ALGORITHM_VERSION,
} from "../indicators/index.js";
import {
  calculatePriceReturn,
  PRICE_RETURN_ALGORITHM_VERSION,
} from "../indicators/returns.js";

export function withIndicators(
  envelope: DataEnvelope<MarketData>,
  requests: readonly IndicatorRequest[],
): DataEnvelope<MarketIndicatorsData> {
  return {
    ...envelope,
    data: {
      ...envelope.data,
      indicators: {
        algorithmVersion: INDICATORS_ALGORITHM_VERSION,
        series: calculateIndicators(envelope.data, requests),
      },
    },
  };
}

function price(
  bar: MarketBar | undefined,
  market: MarketData,
): ReturnObservation | null {
  if (bar === undefined || bar.close === null) return null;
  return {
    date: bar.date,
    asOf: bar.asOf,
    availableAt: bar.availableAt,
    price: bar.close,
    currency: market.currency,
    adjustment: market.adjustment,
  };
}

export function withPriceReturn(
  envelope: DataEnvelope<MarketData>,
  parameters: PriceReturnsQuery["parameters"],
): DataEnvelope<PriceReturnsData> {
  const market = envelope.data;
  const start = price(
    market.bars.findLast((bar) => bar.date <= parameters.startDate),
    market,
  );
  const end = price(market.bars.at(-1), market);
  const data: PriceReturnsData = {
    market,
    algorithmVersion: PRICE_RETURN_ALGORITHM_VERSION,
    requestedStartDate: parameters.startDate,
    requestedEndDate: parameters.endDate,
    start,
    end,
    comparable: parameters.comparable,
    value: null,
    unit: "ratio",
  };
  const gaps: DataGap[] = envelope.gaps.map((gap) => ({
    ...gap,
    field:
      gap.field === "/data" || gap.field.startsWith("/data/")
        ? `/data/market${gap.field.slice("/data".length)}`
        : gap.field,
  }));
  if (start === null)
    gaps.push({
      code: "missing",
      field: "/data/start",
      detail:
        "No closing price at or before the requested start within the supplied history range.",
    });
  if (end === null)
    gaps.push({
      code: "missing",
      field: "/data/end",
      detail:
        "No closing price at or before the requested end within the supplied history range.",
    });
  if (start !== null && end !== null) {
    const result = calculatePriceReturn({
      requestedStartDate: parameters.startDate,
      requestedEndDate: parameters.endDate,
      start,
      end,
      comparable: parameters.comparable,
    });
    data.value = result.value;
    gaps.push(
      ...result.gaps.map((gap) => ({ ...gap, field: `/data${gap.field}` })),
    );
  }
  return { ...envelope, dataset: "returns", data, gaps };
}
