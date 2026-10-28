import type { MarketData } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  IndicatorRequest,
  IndicatorResult,
} from "../contracts/indicators.js";
import { boll, ema, macd, rollingSum, rsi, sma, smooth } from "./series.js";
import type { Series } from "./series.js";

export const INDICATORS_ALGORITHM_VERSION = "1";

function positivePeriod(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Indicator periods must be positive integers.",
    );
  }
}

function validateRequests(requests: readonly IndicatorRequest[]): void {
  for (const request of requests) {
    if (request.kind === "macd") {
      positivePeriod(request.fastPeriod);
      positivePeriod(request.slowPeriod);
      positivePeriod(request.signalPeriod);
      if (request.fastPeriod >= request.slowPeriod) {
        throw new ResearchError(
          "INVALID_INPUT",
          "MACD fastPeriod must be less than slowPeriod.",
        );
      }
    } else {
      positivePeriod(request.period);
      if (
        request.kind === "boll" &&
        (!Number.isFinite(request.deviations) || request.deviations <= 0)
      ) {
        throw new ResearchError(
          "INVALID_INPUT",
          "BOLL deviations must be positive and finite.",
        );
      }
    }
  }
}

function validateMarket(data: MarketData): void {
  let previousDate = "";
  let previousTime = "";
  for (const bar of data.bars) {
    if (
      !bar.sessionComplete ||
      bar.date <= previousDate ||
      bar.asOf <= previousTime
    ) {
      throw new ResearchError(
        "INVALID_INPUT",
        "Indicators require completed bars in strictly increasing time order.",
      );
    }
    for (const value of [bar.open, bar.high, bar.low, bar.close, bar.volume]) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new ResearchError(
          "INVALID_INPUT",
          "OHLCV values must be finite, nonnegative numbers or null.",
        );
      }
    }
    if (bar.low !== null && bar.high !== null) {
      if (
        bar.low > bar.high ||
        (bar.open !== null && (bar.open < bar.low || bar.open > bar.high)) ||
        (bar.close !== null && (bar.close < bar.low || bar.close > bar.high))
      ) {
        throw new ResearchError(
          "INVALID_INPUT",
          "OHLC prices must lie within the bar's low and high.",
        );
      }
    }
    previousDate = bar.date;
    previousTime = bar.asOf;
  }
}

function atr(
  data: MarketData,
  closes: Series,
  period: number,
): (number | null)[] {
  const ranges = closes.map((close, index) => {
    if (close === null) return null;
    const bar = data.bars[index]!;
    const previous = index === 0 ? null : closes[index - 1]!;
    return previous === null
      ? bar.high! - bar.low!
      : Math.max(
          bar.high! - bar.low!,
          Math.abs(bar.high! - previous),
          Math.abs(bar.low! - previous),
        );
  });
  return smooth(ranges, period, 1 / period);
}

function vwma(
  data: MarketData,
  closes: Series,
  period: number,
): (number | null)[] {
  const volumes = closes.map((close, index) =>
    close === null ? null : data.bars[index]!.volume,
  );
  const weighted = closes.map((close, index) =>
    close === null || volumes[index] === null ? null : close * volumes[index]!,
  );
  const sums = rollingSum(weighted, period);
  const volumeSums = rollingSum(volumes, period);
  return sums.map((sum, index) =>
    sum === null || volumeSums[index] === 0 ? null : sum / volumeSums[index]!,
  );
}

function mfi(
  data: MarketData,
  closes: Series,
  period: number,
): (number | null)[] {
  const positive: (number | null)[] = [];
  const negative: (number | null)[] = [];
  let previous: number | null = null;
  for (let index = 0; index < closes.length; index++) {
    const bar = data.bars[index]!;
    const typical =
      closes[index] === null || bar.volume === null
        ? null
        : (bar.high! + bar.low! + bar.close!) / 3;
    if (typical === null || previous === null) {
      positive.push(null);
      negative.push(null);
    } else {
      const flow = typical * bar.volume!;
      positive.push(typical > previous ? flow : 0);
      negative.push(typical < previous ? flow : 0);
    }
    previous = typical;
  }
  const positives = rollingSum(positive, period);
  const negatives = rollingSum(negative, period);
  return positives.map((value, index) => {
    if (value === null) return null;
    const total = value + negatives[index]!;
    return total === 0 ? null : (value / total) * 100;
  });
}

/** Validate once, then compute each requested series without modifying its input. */
export function calculateIndicators(
  data: MarketData,
  requests: readonly IndicatorRequest[],
): IndicatorResult[] {
  validateRequests(requests);
  validateMarket(data);
  const closes = data.bars.map((bar) =>
    bar.open === null || bar.high === null || bar.low === null
      ? null
      : bar.close,
  );
  const priceUnit = `${data.currency}/share`;
  return requests.map((request): IndicatorResult => {
    switch (request.kind) {
      case "sma":
        return {
          ...request,
          unit: priceUnit,
          values: sma(closes, request.period),
        };
      case "ema":
        return {
          ...request,
          unit: priceUnit,
          values: ema(closes, request.period),
        };
      case "rsi":
        return {
          ...request,
          unit: "index",
          values: rsi(closes, request.period),
        };
      case "atr":
        return {
          ...request,
          unit: priceUnit,
          values: atr(data, closes, request.period),
        };
      case "vwma":
        return {
          ...request,
          unit: priceUnit,
          values: vwma(data, closes, request.period),
        };
      case "mfi":
        return {
          ...request,
          unit: "index",
          values: mfi(data, closes, request.period),
        };
      case "boll":
        return {
          ...request,
          unit: priceUnit,
          values: boll(closes, request.period, request.deviations),
        };
      case "macd":
        return {
          ...request,
          unit: priceUnit,
          values: macd(
            closes,
            request.fastPeriod,
            request.slowPeriod,
            request.signalPeriod,
          ),
        };
    }
  });
}
