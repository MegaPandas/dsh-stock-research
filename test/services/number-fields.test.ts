import { describe, expect, it } from "vitest";
import type { DataEnvelope, MarketData } from "../../src/contracts/data.js";
import type { FundamentalsData } from "../../src/contracts/fundamentals.js";
import type { IndicatorRequest } from "../../src/contracts/indicators.js";
import type { MacroData } from "../../src/contracts/macro.js";
import type {
  MarketIndicatorsData,
  PriceReturnsData,
  QueryEnvelope,
} from "../../src/contracts/query.js";
import type { SinaIncomeData } from "../../src/contracts/sina-income.js";
import {
  calculateIndicators,
  INDICATORS_ALGORITHM_VERSION,
} from "../../src/indicators/index.js";
import { PRICE_RETURN_ALGORITHM_VERSION } from "../../src/indicators/returns.js";
import {
  numberField,
  readPointer,
  referenceField,
  SelectorError,
} from "../../src/services/number-fields.js";

// Artificial observations with explicit dates; no provider data is used.
function envelope<T extends QueryEnvelope["data"]>(
  data: T,
  dataset: QueryEnvelope["dataset"] = "market",
  asOf = "2024-01-10T21:00:00.000Z",
): DataEnvelope<T> {
  return {
    dataset,
    data,
    source: {
      provider: "synthetic",
      url: "https://example.com",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf,
    availableAt: null,
    retrievedAt: "2024-02-01T00:00:00.000Z",
    cutoff: "2024-02-01T00:00:00.000Z",
    ageMs: Date.parse("2024-02-01T00:00:00.000Z") - Date.parse(asOf),
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}
function market(): MarketData {
  return {
    currency: "USD",
    adjustment: "split_adjusted",
    bars: Array.from({ length: 10 }, (_, index) => {
      const date = `2024-01-${String(index + 1).padStart(2, "0")}`;
      return {
        date,
        asOf: `${date}T21:00:00.000Z`,
        availableAt: `${date}T21:01:00.000Z`,
        sessionComplete: true,
        open: 10 + index,
        high: 12 + index,
        low: 9 + index,
        close: 11 + index,
        volume: 100,
      };
    }),
  };
}
function indicators(
  request: IndicatorRequest,
  gap = false,
): MarketIndicatorsData {
  const data = market();
  if (gap) data.bars[3]!.open = null;
  return {
    ...data,
    indicators: {
      algorithmVersion: INDICATORS_ALGORITHM_VERSION,
      series: calculateIndicators(data, [request]),
    },
  };
}
function dates(field: ReturnType<typeof numberField>) {
  return field.times.map((time) => time.asOf);
}
const lastThree = [
  "2024-01-08T21:00:00.000Z",
  "2024-01-09T21:00:00.000Z",
  "2024-01-10T21:00:00.000Z",
];

describe("readPointer", () => {
  it("decodes slash and tilde escapes once", () => {
    expect(readPointer({ "a/b": { "~1": 7 } }, "/a~1b/~01")).toEqual({
      value: 7,
      tokens: ["a/b", "~1"],
    });
  });
  it.each(["/01", "/-", "/1e0", "/length"])(
    "rejects noncanonical array index %s",
    (selector) => {
      expect(() => readPointer([1, 2], selector)).toThrow(SelectorError);
    },
  );
  it("reads only own properties", () => {
    expect(() =>
      readPointer(Object.create({ inherited: 1 }), "/inherited"),
    ).toThrow(SelectorError);
  });
  it.each(["field", "/bad~2", "/bad~"])(
    "rejects malformed pointer %s",
    (selector) => {
      expect(() => readPointer({}, selector)).toThrow(SelectorError);
    },
  );
});

describe("numberField observations", () => {
  it("rejects numeric envelope metadata", () => {
    expect(() => numberField(envelope(market()), "/ageMs")).toThrow(
      SelectorError,
    );
  });
  it.each(["open", "high", "low", "close", "volume"] as const)(
    "uses the selected bar's time and %s unit",
    (field) => {
      const data = market();
      const selector = `/data/bars/1/${field}`;
      expect(numberField(envelope(data), selector)).toMatchObject({
        value:
          field === "volume"
            ? 100
            : { open: 11, high: 13, low: 10, close: 12 }[field],
        unit: field === "volume" ? "shares" : "USD/share",
        times: [
          {
            asOf: "2024-01-02T21:00:00.000Z",
            availableAt: "2024-01-02T21:01:00.000Z",
            complete: true,
          },
        ],
        dependencies: expect.arrayContaining([
          selector,
          "/data/bars/1/asOf",
          "/data/bars/1/availableAt",
          "/data/bars/1/sessionComplete",
        ]),
      });
    },
  );
  it("preserves missing market observations and incomplete sessions", () => {
    const data = market();
    data.bars[0]!.close = null;
    data.bars[0]!.sessionComplete = false;
    expect(numberField(envelope(data), "/data/bars/0/close")).toMatchObject({
      value: null,
      times: [{ complete: false }],
    });
  });
  const sec: FundamentalsData = {
    field: "revenue",
    currency: "USD",
    concept: { taxonomy: "us-gaap", tag: "Revenues" },
    observations: ["2023-06-30", "2023-12-31"].map((periodEnd) => ({
      periodStart: "2023-01-01",
      periodEnd,
      value: 500,
      filed: "2024-01-20",
      accession: "synthetic",
      form: "10-K",
      filingUrl: "https://example.com",
      availableAt: "2024-01-20T16:00:00.000Z",
    })),
  };
  const cn: SinaIncomeData = {
    currency: "CNY",
    basis: "year_to_date",
    consolidation: "consolidated",
    fields: ["revenue"],
    observations: ["2023-06-30", "2023-12-31"].map((periodEnd) => ({
      periodStart: "2023-01-01",
      periodEnd,
      publishDate: null,
      sourceUpdatedAt: null,
      availableAt: null,
      values: { revenue: 600 },
    })),
  };
  const fred: MacroData = {
    seriesId: "DGS10",
    unit: "percent",
    frequency: "daily",
    seasonalAdjustment: "not_seasonally_adjusted",
    view: "current",
    observations: [
      { date: "2024-01-02", value: 4, availableAt: null },
      { date: "2024-01-03", value: 5, availableAt: null },
    ],
  };
  it.each([
    {
      data: sec,
      dataset: "fundamentals" as const,
      latestAsOf: "2023-12-31T23:59:59.999Z",
      selector: "/data/observations/0/value",
      unit: "USD",
      asOf: "2023-06-30T23:59:59.999Z",
      availableAt: "2024-01-20T16:00:00.000Z",
    },
    {
      data: cn,
      dataset: "fundamentals" as const,
      latestAsOf: "2023-12-31T15:59:59.999Z",
      selector: "/data/observations/0/values/revenue",
      unit: "CNY",
      asOf: "2023-06-30T15:59:59.999Z",
      availableAt: null,
    },
    {
      data: fred,
      dataset: "macro" as const,
      latestAsOf: "2024-01-03T00:00:00.000Z",
      selector: "/data/observations/0/value",
      unit: "percent",
      asOf: "2024-01-02T00:00:00.000Z",
      availableAt: null,
    },
  ])(
    "uses selected historical row time and unit: $unit",
    ({ data, dataset, latestAsOf, selector, unit, asOf, availableAt }) => {
      expect(
        numberField(envelope(data, dataset, latestAsOf), selector),
      ).toMatchObject({
        unit,
        times: [{ asOf, availableAt, complete: true }],
        dependencies: expect.arrayContaining([
          selector,
          "/data/observations/0/availableAt",
        ]),
      });
    },
  );
});

function returns(): PriceReturnsData {
  const data = market();
  return {
    market: data,
    algorithmVersion: PRICE_RETURN_ALGORITHM_VERSION,
    requestedStartDate: "2024-01-01",
    requestedEndDate: "2024-01-10",
    start: {
      date: "2024-01-01",
      asOf: "2024-01-01T21:00:00.000Z",
      availableAt: data.bars[0]!.availableAt,
      price: 11,
      currency: "USD",
      adjustment: "split_adjusted",
    },
    end: {
      date: "2024-01-10",
      asOf: "2024-01-10T21:00:00.000Z",
      availableAt: data.bars[9]!.availableAt,
      price: 20,
      currency: "USD",
      adjustment: "split_adjusted",
    },
    comparable: true,
    value: 20 / 11 - 1,
    unit: "ratio",
  };
}
describe("return fields", () => {
  it("uses both endpoint observations for ratio", () => {
    const result = numberField(envelope(returns(), "returns"), "/data/value");
    expect(result.unit).toBe("ratio");
    expect(dates(result)).toEqual([
      "2024-01-01T21:00:00.000Z",
      "2024-01-10T21:00:00.000Z",
    ]);
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        "/data/start/price",
        "/data/end/price",
        "/data/value",
        "/data/market/bars/0/close",
        "/data/market/bars/9/close",
      ]),
    );
    expect(result.dependencies).not.toContain("/data/market/bars/9/volume");
  });
  it.each(["start", "end"])("retains %s endpoint price basis", (point) => {
    expect(
      numberField(envelope(returns(), "returns"), `/data/${point}/price`),
    ).toMatchObject({
      unit: "USD/share",
      price: {
        adjustment: "split_adjusted",
        comparison: "returns",
        point: point === "start" ? "2024-01-01" : "2024-01-10",
      },
    });
  });
  it("supports nested raw market fields", () => {
    expect(
      numberField(envelope(returns(), "returns"), "/data/market/bars/1/volume"),
    ).toMatchObject({
      value: 100,
      unit: "shares",
      times: [{ asOf: "2024-01-02T21:00:00.000Z" }],
    });
  });
});

describe("indicator fields", () => {
  it.each(["sma", "boll", "vwma"] as const)(
    "limits %s dependence to the selected finite window",
    (kind) => {
      const request: IndicatorRequest =
        kind === "boll"
          ? { kind, period: 3, deviations: 2 }
          : { kind, period: 3 };
      const selector = `/data/indicators/series/0/values/9${kind === "boll" ? "/upper" : ""}`;
      const field = numberField(envelope(indicators(request)), selector);
      expect(dates(field)).toEqual(lastThree);
      expect(field.dependencies).toContain("/data/bars/7/open");
      expect(field.dependencies).not.toContain("/data/bars/6/close");
      expect(field.dependencies.includes("/data/bars/9/volume")).toBe(
        kind === "vwma",
      );
    },
  );
  it("MFI includes the preceding observation for its period changes", () => {
    const field = numberField(
      envelope(indicators({ kind: "mfi", period: 3 })),
      "/data/indicators/series/0/values/9",
    );
    expect(dates(field)).toEqual(["2024-01-07T21:00:00.000Z", ...lastThree]);
    expect(field.unit).toBe("index");
    expect(field.dependencies).toContain("/data/bars/6/volume");
  });
  it.each(["ema", "atr", "rsi", "macd"] as const)(
    "%s retains the continuous segment and restarts after OHLC gaps",
    (kind) => {
      const request: IndicatorRequest =
        kind === "macd"
          ? { kind, fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 }
          : { kind, period: 3 };
      const selector = `/data/indicators/series/0/values/9${kind === "macd" ? "/histogram" : ""}`;
      expect(
        numberField(envelope(indicators(request)), selector).times,
      ).toHaveLength(10);
      expect(
        dates(numberField(envelope(indicators(request, true)), selector)),
      ).toEqual([
        "2024-01-05T21:00:00.000Z",
        "2024-01-06T21:00:00.000Z",
        "2024-01-07T21:00:00.000Z",
        ...lastThree,
      ]);
    },
  );
  it("resolves an earlier indicator position without later bars", () => {
    expect(
      dates(
        numberField(
          envelope(indicators({ kind: "sma", period: 3 })),
          "/data/indicators/series/0/values/2",
        ),
      ),
    ).toEqual([
      "2024-01-01T21:00:00.000Z",
      "2024-01-02T21:00:00.000Z",
      "2024-01-03T21:00:00.000Z",
    ]);
  });
  it("rejects parameter metadata as an observed value", () => {
    expect(() =>
      numberField(
        envelope(indicators({ kind: "sma", period: 3 })),
        "/data/indicators/series/0/period",
      ),
    ).toThrow(SelectorError);
  });
  it.each(["middle", "upper", "lower"])(
    "accepts BOLL %s components",
    (component) => {
      expect(
        numberField(
          envelope(indicators({ kind: "boll", period: 3, deviations: 2 })),
          `/data/indicators/series/0/values/9/${component}`,
        ).unit,
      ).toBe("USD/share");
    },
  );
  it.each(["macd", "signal", "histogram"])(
    "accepts MACD %s components",
    (component) => {
      expect(
        numberField(
          envelope(
            indicators({
              kind: "macd",
              fastPeriod: 2,
              slowPeriod: 3,
              signalPeriod: 2,
            }),
          ),
          `/data/indicators/series/0/values/9/${component}`,
        ).unit,
      ).toBe("USD/share");
    },
  );
  it("rejects a component name from another indicator", () => {
    expect(() =>
      numberField(
        envelope(indicators({ kind: "boll", period: 3, deviations: 2 })),
        "/data/indicators/series/0/values/9/macd",
      ),
    ).toThrow(SelectorError);
  });
  it("rejects unknown indicator and return calculation versions", () => {
    const data = indicators({ kind: "sma", period: 3 });
    data.indicators.algorithmVersion = "unknown";
    expect(() =>
      numberField(envelope(data), "/data/indicators/series/0/values/9"),
    ).toThrow(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
    const returned = returns();
    returned.algorithmVersion = "unknown";
    expect(() =>
      numberField(envelope(returned, "returns"), "/data/value"),
    ).toThrow(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
  });
});

describe("referenceField", () => {
  it("references the entire envelope or business data", () => {
    const source = envelope(market());
    for (const selector of ["", "/data"])
      expect(referenceField(source, selector)).toEqual({
        times: source.data.bars.map((bar) => ({
          asOf: bar.asOf,
          availableAt: bar.availableAt,
          complete: true,
        })),
        dependencies: [selector],
      });
  });
  it("references an individual market row", () => {
    expect(referenceField(envelope(market()), "/data/bars/0")).toEqual({
      times: [
        {
          asOf: "2024-01-01T21:00:00.000Z",
          availableAt: "2024-01-01T21:01:00.000Z",
          complete: true,
        },
      ],
      dependencies: ["/data/bars/0"],
    });
  });
  it("references a structured indicator point with its input window", () => {
    const field = referenceField(
      envelope(indicators({ kind: "boll", period: 3, deviations: 2 })),
      "/data/indicators/series/0/values/9",
    );
    expect(field.times.map((time) => time.asOf)).toEqual(lastThree);
    expect(field.dependencies).toContain("/data/bars/7/close");
  });
  it("rejects references into envelope metadata", () => {
    expect(() => referenceField(envelope(market()), "/source")).toThrow(
      SelectorError,
    );
  });
});
