import { describe, expect, it } from "vitest";
import {
  calculateIndicators,
  type IndicatorRequest,
  type MarketBar,
  type MarketData,
  type PeriodIndicator,
} from "../../src/core.js";
import { MARKET_FIXTURE } from "../fixtures/market.js";

function market(closes: readonly number[], volume = 1): MarketData {
  return {
    currency: "USD",
    adjustment: "unadjusted",
    bars: closes.map((close, index) => {
      const date = `2024-01-${String(index + 1).padStart(2, "0")}`;
      return {
        date,
        asOf: `${date}T21:00:00.000Z`,
        availableAt: `${date}T21:00:00.000Z`,
        sessionComplete: true,
        open: close,
        high: close,
        low: close,
        close,
        volume,
      };
    }),
  };
}

function scalar(data: MarketData, kind: PeriodIndicator, period: number) {
  const result = calculateIndicators(data, [{ kind, period }])[0]!;
  expect(result.kind).toBe(kind);
  if (result.kind === "boll" || result.kind === "macd") {
    throw new Error("Expected a scalar indicator");
  }
  return result.values;
}

function expectSeries(
  actual: readonly (number | null)[],
  expected: readonly (number | null)[],
) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    if (value === null) expect(actual[index]).toBeNull();
    else expect(actual[index]).toBeCloseTo(value, 10);
  });
}

const ALL_REQUESTS: IndicatorRequest[] = [
  { kind: "sma", period: 3 },
  { kind: "ema", period: 3 },
  { kind: "rsi", period: 3 },
  { kind: "atr", period: 3 },
  { kind: "vwma", period: 3 },
  { kind: "mfi", period: 3 },
  { kind: "boll", period: 3, deviations: 2 },
  { kind: "macd", fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
];

describe("indicator numerical contracts", () => {
  it("uses close prices, aligned windows and an SMA seed for EMA", () => {
    expectSeries(scalar(MARKET_FIXTURE.data, "sma", 3), [
      null,
      null,
      11,
      37 / 3,
      38 / 3,
    ]);
    expectSeries(scalar(MARKET_FIXTURE.data, "ema", 3), [
      null,
      null,
      11,
      12.5,
      12.75,
    ]);
  });

  it("seeds RSI from three price changes, then applies Wilder smoothing", () => {
    // Changes +2,-1,+3 seed gains=5/3, losses=1/3; the next -1 gives 10/9 and 5/9.
    expectSeries(scalar(MARKET_FIXTURE.data, "rsi", 3), [
      null,
      null,
      null,
      250 / 3,
      200 / 3,
    ]);
  });

  it("includes the first high-low range in the ATR seed", () => {
    // True ranges are 3,4,4,4,4; Wilder averages are 11/3,34/9,104/27.
    expectSeries(scalar(MARKET_FIXTURE.data, "atr", 3), [
      null,
      null,
      11 / 3,
      34 / 9,
      104 / 27,
    ]);
  });

  it("weights each close by its own volume", () => {
    // Window totals are 5050/450,8250/650,9100/700.
    expectSeries(scalar(MARKET_FIXTURE.data, "vwma", 3), [
      null,
      null,
      101 / 9,
      165 / 13,
      13,
    ]);
  });

  it("uses typical-price direction for MFI even when the close falls", () => {
    // Typical prices 29/3,34/3,35/3,40/3,41/3 increase on every bar.
    expectSeries(scalar(MARKET_FIXTURE.data, "mfi", 3), [
      null,
      null,
      null,
      100,
      100,
    ]);
  });

  it("computes MFI from both positive and negative money flows", () => {
    const data = market([10, 12, 11, 14, 13]);
    data.bars.forEach((bar, index) => {
      bar.volume = index + 1;
    });
    // Directed flows +24,-33,+56,-65 give 80/(80+33), then 56/(56+98).
    expectSeries(scalar(data, "mfi", 3), [
      null,
      null,
      null,
      8000 / 113,
      400 / 11,
    ]);
  });

  it("uses population variance for BOLL", () => {
    const result = calculateIndicators(MARKET_FIXTURE.data, [
      { kind: "boll", period: 3, deviations: 2 },
    ])[0]!;
    expect(result.kind).toBe("boll");
    if (result.kind !== "boll") throw new Error("Expected BOLL");
    expect(result.values.slice(0, 2)).toEqual([null, null]);
    const means = [11, 37 / 3, 38 / 3];
    const widths = [
      2 * Math.sqrt(2 / 3),
      (2 * Math.sqrt(14)) / 3,
      (2 * Math.sqrt(14)) / 3,
    ];
    means.forEach((middle, index) => {
      const value = result.values[index + 2]!;
      expect(value.middle).toBeCloseTo(middle, 10);
      expect(value.upper).toBeCloseTo(middle + widths[index]!, 10);
      expect(value.lower).toBeCloseTo(middle - widths[index]!, 10);
    });
  });

  it("keeps BOLL variance accurate with a large constant price offset", () => {
    const result = calculateIndicators(
      market([1_000_000_001, 1_000_000_002, 1_000_000_003, 1_000_000_004]),
      [{ kind: "boll", period: 2, deviations: 2 }],
    )[0]!;
    expect(result.values).toEqual([
      null,
      {
        middle: 1_000_000_001.5,
        upper: 1_000_000_002.5,
        lower: 1_000_000_000.5,
      },
      {
        middle: 1_000_000_002.5,
        upper: 1_000_000_003.5,
        lower: 1_000_000_001.5,
      },
      {
        middle: 1_000_000_003.5,
        upper: 1_000_000_004.5,
        lower: 1_000_000_002.5,
      },
    ]);
  });

  it("uses zero width for a one-bar BOLL window", () => {
    const result = calculateIndicators(market([3, 7]), [
      { kind: "boll", period: 1, deviations: 2 },
    ])[0]!;
    expect(result.values).toEqual([
      { middle: 3, upper: 3, lower: 3 },
      { middle: 7, upper: 7, lower: 7 },
    ]);
  });

  it("seeds the MACD signal only after enough MACD values exist", () => {
    const result = calculateIndicators(MARKET_FIXTURE.data, [
      { kind: "macd", fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
    ])[0]!;
    expect(result.kind).toBe("macd");
    if (result.kind !== "macd") throw new Error("Expected MACD");
    expect(result.values).toEqual([
      null,
      null,
      { macd: 0, signal: null, histogram: null },
      { macd: 0.5, signal: 0.25, histogram: 0.25 },
      { macd: 0.25, signal: 0.25, histogram: 0 },
    ]);
  });
});

describe("indicator windows and gaps", () => {
  it("returns empty series for empty input and preserves request order and units", () => {
    const results = calculateIndicators(market([]), ALL_REQUESTS);
    expect(results.map((result) => result.kind)).toEqual(
      ALL_REQUESTS.map((request) => request.kind),
    );
    expect(results.map((result) => result.values)).toEqual(
      ALL_REQUESTS.map(() => []),
    );
    expect(results.map((result) => result.unit)).toEqual([
      "USD/share",
      "USD/share",
      "index",
      "USD/share",
      "USD/share",
      "index",
      "USD/share",
      "USD/share",
    ]);
  });

  it("keeps every under-warmed result aligned with the input", () => {
    const results = calculateIndicators(market([1, 2]), ALL_REQUESTS);
    results.forEach((result) => expect(result.values).toEqual([null, null]));
  });

  it("defines flat, rising and falling RSI without NaN", () => {
    expectSeries(scalar(market([10, 10, 10, 10, 10]), "rsi", 3), [
      null,
      null,
      null,
      50,
      50,
    ]);
    expectSeries(scalar(market([1, 2, 3, 4, 5]), "rsi", 3), [
      null,
      null,
      null,
      100,
      100,
    ]);
    expectSeries(scalar(market([5, 4, 3, 2, 1]), "rsi", 3), [
      null,
      null,
      null,
      0,
      0,
    ]);
  });

  it("defines one-sided MFI and leaves zero total flow undefined", () => {
    expectSeries(scalar(market([1, 2, 3, 4, 5]), "mfi", 3), [
      null,
      null,
      null,
      100,
      100,
    ]);
    expectSeries(scalar(market([5, 4, 3, 2, 1]), "mfi", 3), [
      null,
      null,
      null,
      0,
      0,
    ]);
    expectSeries(scalar(market([10, 10, 10, 10, 10]), "mfi", 3), [
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("accepts zero volume without inventing a VWMA value", () => {
    const data = market([10, 10, 10, 10], 0);
    data.bars[3]!.volume = 1;
    expectSeries(scalar(data, "vwma", 2), [null, null, null, 10]);
    expectSeries(scalar(data, "mfi", 2), [null, null, null, null]);
  });

  it("returns to undefined when a fractional-volume window becomes entirely zero", () => {
    const data = market([0.5, 1, 2, 3, 4, 5], 0);
    data.bars.slice(0, 3).forEach((bar) => {
      bar.volume = 0.1;
    });
    // VWMA windows weigh 0.5+1, 1+2, then only 2; the remaining windows have no volume.
    expectSeries(scalar(data, "vwma", 2), [null, 0.75, 1.5, 2, null, null]);
    // Directed money flows are +0.1,+0.2,0,0,0; no flow remains from index 4.
    expectSeries(scalar(data, "mfi", 2), [null, null, 100, 100, null, null]);
  });

  it("restarts windows and smoothing after an OHLC gap", () => {
    const data = market([1, 2, 3, 4, 6, 8, 10]);
    data.bars[2]!.open = null;
    const requests: IndicatorRequest[] = ALL_REQUESTS.map((request) =>
      request.kind === "macd"
        ? { kind: "macd", fastPeriod: 1, slowPeriod: 2, signalPeriod: 2 }
        : { ...request, period: 2 },
    );
    const results = calculateIndicators(data, requests);
    results.forEach((result) => {
      expect(result.values[2]).toBeNull();
      expect(result.values[3]).toBeNull();
    });
    expectSeries(scalar(data, "sma", 2), [null, 1.5, null, null, 5, 7, 9]);
    expectSeries(scalar(data, "ema", 2), [null, 1.5, null, null, 5, 7, 9]);
    expectSeries(scalar(data, "rsi", 2), [
      null,
      null,
      null,
      null,
      null,
      100,
      100,
    ]);
    expectSeries(scalar(data, "atr", 2), [null, 0.5, null, null, 1, 1.5, 1.75]);
  });

  it("limits a volume gap to volume-based indicators", () => {
    const data = market([1, 2, 3, 4, 5, 6, 7]);
    data.bars[2]!.volume = null;
    expectSeries(scalar(data, "sma", 2), [null, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5]);
    expectSeries(scalar(data, "vwma", 2), [
      null,
      1.5,
      null,
      null,
      4.5,
      5.5,
      6.5,
    ]);
    expectSeries(scalar(data, "mfi", 2), [
      null,
      null,
      null,
      null,
      null,
      100,
      100,
    ]);
  });

  it("does not modify the bars or requests", () => {
    const data = structuredClone(MARKET_FIXTURE.data);
    const requests = structuredClone(ALL_REQUESTS);
    const before = structuredClone({ data, requests });
    calculateIndicators(data, requests);
    expect({ data, requests }).toEqual(before);
  });
});

describe("indicator public input boundary", () => {
  it.each<IndicatorRequest>([
    { kind: "sma", period: 0 },
    { kind: "ema", period: 1.5 },
    { kind: "rsi", period: Number.NaN },
    { kind: "atr", period: Number.POSITIVE_INFINITY },
    { kind: "macd", fastPeriod: 3, slowPeriod: 3, signalPeriod: 2 },
    { kind: "macd", fastPeriod: 2, slowPeriod: 3, signalPeriod: 0 },
    { kind: "boll", period: 3, deviations: 0 },
    { kind: "boll", period: 3, deviations: Number.POSITIVE_INFINITY },
  ])("rejects an invalid indicator request: %j", (request) => {
    expect(() =>
      calculateIndicators(MARKET_FIXTURE.data, [request]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it.each<Partial<MarketBar>>([
    { close: Number.NaN },
    { volume: -1 },
    { high: 9 },
    { sessionComplete: false },
  ])("rejects invalid OHLCV or an unfinished session: %j", (changes) => {
    const data = structuredClone(MARKET_FIXTURE.data);
    Object.assign(data.bars[0]!, changes);
    expect(() =>
      calculateIndicators(data, [{ kind: "sma", period: 2 }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects bars that are not in strictly increasing order", () => {
    const data = structuredClone(MARKET_FIXTURE.data);
    data.bars.reverse();
    expect(() =>
      calculateIndicators(data, [{ kind: "sma", period: 2 }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects duplicate observation times even when the dates increase", () => {
    const data = structuredClone(MARKET_FIXTURE.data);
    data.bars[1]!.asOf = data.bars[0]!.asOf;
    expect(() =>
      calculateIndicators(data, [{ kind: "sma", period: 2 }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
