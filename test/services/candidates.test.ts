import { describe, expect, it } from "vitest";
import type { DataEnvelope, MarketData } from "../../src/contracts/data.js";
import type { FundamentalsData } from "../../src/contracts/fundamentals.js";
import type { SourceData, SourceEnvelope } from "../../src/contracts/query.js";
import { extractCandidates } from "../../src/services/candidates.js";

const AS_OF = "2024-06-28T20:00:00.000Z";
const INCOME_AS_OF = "2024-06-30T15:59:59.999Z";
function envelope<T extends SourceData>(
  data: T,
  dataset: SourceEnvelope["dataset"],
  asOf = AS_OF,
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
    retrievedAt: "2024-07-01T12:00:00.000Z",
    cutoff: "2024-06-30T20:00:00.000Z",
    ageMs: Date.parse("2024-06-30T20:00:00.000Z") - Date.parse(asOf),
    stale: true,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}
function market(currency: string): MarketData {
  return {
    currency,
    adjustment: "unadjusted",
    bars: [
      {
        date: "2024-06-27",
        asOf: "2024-06-27T20:00:00.000Z",
        availableAt: null,
        sessionComplete: true,
        open: 90,
        high: 100,
        low: 80,
        close: 95,
        volume: 999,
      },
      {
        date: "2024-06-28",
        asOf: AS_OF,
        availableAt: null,
        sessionComplete: true,
        open: 120,
        high: 130,
        low: 110,
        close: 125,
        volume: 500,
      },
    ],
  };
}
function sec(value: number | null): FundamentalsData {
  return {
    field: "netIncome",
    currency: "USD",
    concept: { taxonomy: "us-gaap", tag: "NetIncomeLoss" },
    observations: [
      {
        periodStart: "2023-01-01",
        periodEnd: "2023-03-31",
        value: 500,
        filed: "2023-05-01",
        accession: "0000000001-23-000001",
        form: "10-Q",
        filingUrl: "https://example.com/old",
        availableAt: null,
      },
      {
        periodStart: "2024-01-01",
        periodEnd: "2024-03-31",
        value,
        filed: "2024-05-01",
        accession: "0000000001-24-000002",
        form: "10-Q",
        filingUrl: "https://example.com/new",
        availableAt: null,
      },
    ],
  };
}

describe("latest-observation candidate extraction", () => {
  it.each(["USD", "CNY"])(
    "extracts only the latest OHLCV with %s price and share units",
    (currency) => {
      const supplied = envelope(market(currency), "market");
      const before = structuredClone(supplied);
      expect(extractCandidates(supplied)).toEqual([
        {
          candidateId: "market.open",
          label: "2024-06-28 open",
          value: 120,
          unit: `${currency}/share`,
          asOf: AS_OF,
          selector: "/data/bars/1/open",
        },
        {
          candidateId: "market.high",
          label: "2024-06-28 high",
          value: 130,
          unit: `${currency}/share`,
          asOf: AS_OF,
          selector: "/data/bars/1/high",
        },
        {
          candidateId: "market.low",
          label: "2024-06-28 low",
          value: 110,
          unit: `${currency}/share`,
          asOf: AS_OF,
          selector: "/data/bars/1/low",
        },
        {
          candidateId: "market.close",
          label: "2024-06-28 close",
          value: 125,
          unit: `${currency}/share`,
          asOf: AS_OF,
          selector: "/data/bars/1/close",
        },
        {
          candidateId: "market.volume",
          label: "2024-06-28 volume",
          value: 500,
          unit: "shares",
          asOf: AS_OF,
          selector: "/data/bars/1/volume",
        },
      ]);
      expect(supplied).toEqual(before);
    },
  );

  it("retains latest zero values and skips nulls without using older populated bars", () => {
    const data = market("USD");
    data.bars[1] = {
      ...data.bars[1]!,
      open: null,
      high: null,
      low: null,
      close: 0,
      volume: 0,
    };
    expect(extractCandidates(envelope(data, "market"))).toEqual([
      {
        candidateId: "market.close",
        label: "2024-06-28 close",
        value: 0,
        unit: "USD/share",
        asOf: AS_OF,
        selector: "/data/bars/1/close",
      },
      {
        candidateId: "market.volume",
        label: "2024-06-28 volume",
        value: 0,
        unit: "shares",
        asOf: AS_OF,
        selector: "/data/bars/1/volume",
      },
    ]);
  });

  it("keeps a latest SEC loss with its field, currency, period and accession identity", () => {
    expect(
      extractCandidates(
        envelope(sec(-42), "fundamentals", "2024-03-31T23:59:59.999Z"),
      ),
    ).toEqual([
      {
        candidateId: "fundamentals.netIncome",
        label: "netIncome 2024-01-01–2024-03-31 0000000001-24-000002",
        value: -42,
        unit: "USD",
        asOf: "2024-03-31T23:59:59.999Z",
        selector: "/data/observations/1/value",
      },
    ]);
  });

  it("does not fall back to an earlier SEC fact when the latest value is null", () => {
    expect(
      extractCandidates(
        envelope(sec(null), "fundamentals", "2024-03-31T23:59:59.999Z"),
      ),
    ).toEqual([]);
  });

  it("labels SEC revenue with its own selected field rather than a net income identifier", () => {
    const supplied = sec(250);
    supplied.field = "revenue";
    supplied.concept.tag =
      "RevenueFromContractWithCustomerExcludingAssessedTax";
    expect(
      extractCandidates(
        envelope(supplied, "fundamentals", "2024-03-31T23:59:59.999Z"),
      ),
    ).toEqual([
      {
        candidateId: "fundamentals.revenue",
        label: "revenue 2024-01-01–2024-03-31 0000000001-24-000002",
        value: 250,
        unit: "USD",
        asOf: "2024-03-31T23:59:59.999Z",
        selector: "/data/observations/1/value",
      },
    ]);
  });

  it("preserves Eastmoney total revenue and parent income as different CNY candidates", () => {
    expect(
      extractCandidates(
        envelope(
          {
            currency: "CNY",
            basis: "year_to_date",
            fields: ["totalOperatingRevenue", "netIncomeToParent"],
            observations: [
              {
                periodStart: "2023-01-01",
                periodEnd: "2023-06-30",
                noticeDate: null,
                availableAt: null,
                values: { totalOperatingRevenue: 999, netIncomeToParent: 888 },
              },
              {
                periodStart: "2024-01-01",
                periodEnd: "2024-06-30",
                noticeDate: null,
                availableAt: null,
                values: { totalOperatingRevenue: 300, netIncomeToParent: -20 },
              },
            ],
          },
          "fundamentals",
          INCOME_AS_OF,
        ),
      ),
    ).toEqual([
      {
        candidateId: "fundamentals.totalOperatingRevenue",
        label: "totalOperatingRevenue 2024-01-01–2024-06-30",
        value: 300,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/1/values/totalOperatingRevenue",
      },
      {
        candidateId: "fundamentals.netIncomeToParent",
        label: "netIncomeToParent 2024-01-01–2024-06-30",
        value: -20,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/1/values/netIncomeToParent",
      },
    ]);
  });

  it("keeps all four Sina field meanings distinct instead of substituting totals or parent income", () => {
    expect(
      extractCandidates(
        envelope(
          {
            currency: "CNY",
            basis: "year_to_date",
            consolidation: "consolidated",
            fields: [
              "revenue",
              "totalOperatingRevenue",
              "netIncome",
              "netIncomeToParent",
            ],
            observations: [
              {
                periodStart: "2024-01-01",
                periodEnd: "2024-06-30",
                publishDate: null,
                sourceUpdatedAt: null,
                availableAt: null,
                values: {
                  revenue: 100,
                  totalOperatingRevenue: 110,
                  netIncome: 40,
                  netIncomeToParent: 35,
                },
              },
            ],
          },
          "fundamentals",
          INCOME_AS_OF,
        ),
      ),
    ).toEqual([
      {
        candidateId: "fundamentals.revenue",
        label: "revenue 2024-01-01–2024-06-30",
        value: 100,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/0/values/revenue",
      },
      {
        candidateId: "fundamentals.totalOperatingRevenue",
        label: "totalOperatingRevenue 2024-01-01–2024-06-30",
        value: 110,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/0/values/totalOperatingRevenue",
      },
      {
        candidateId: "fundamentals.netIncome",
        label: "netIncome 2024-01-01–2024-06-30",
        value: 40,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/0/values/netIncome",
      },
      {
        candidateId: "fundamentals.netIncomeToParent",
        label: "netIncomeToParent 2024-01-01–2024-06-30",
        value: 35,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/0/values/netIncomeToParent",
      },
    ]);
  });

  it("skips absent and null partial financial values while retaining zero", () => {
    expect(
      extractCandidates(
        envelope(
          {
            currency: "CNY",
            basis: "year_to_date",
            consolidation: "consolidated",
            fields: [
              "revenue",
              "totalOperatingRevenue",
              "netIncome",
              "netIncomeToParent",
            ],
            observations: [
              {
                periodStart: "2024-01-01",
                periodEnd: "2024-06-30",
                publishDate: null,
                sourceUpdatedAt: null,
                availableAt: null,
                values: { revenue: 0, netIncome: null },
              },
            ],
          },
          "fundamentals",
          INCOME_AS_OF,
        ),
      ),
    ).toEqual([
      {
        candidateId: "fundamentals.revenue",
        label: "revenue 2024-01-01–2024-06-30",
        value: 0,
        unit: "CNY",
        asOf: INCOME_AS_OF,
        selector: "/data/observations/0/values/revenue",
      },
    ]);
  });

  it.each([
    {
      seriesId: "DGS10",
      unit: "percent",
      frequency: "daily",
      seasonalAdjustment: "not_seasonally_adjusted",
      value: 4.05,
    },
    {
      seriesId: "CPIAUCSL",
      unit: "index_1982_1984_100",
      frequency: "monthly",
      seasonalAdjustment: "seasonally_adjusted",
      value: 308.417,
    },
  ] as const)(
    "keeps $seriesId values in their source unit without percent conversion",
    ({ value, ...metadata }) => {
      expect(
        extractCandidates(
          envelope(
            {
              ...metadata,
              view: "current",
              observations: [
                { date: "2024-01-01", value: 999, availableAt: null },
                { date: "2024-02-01", value, availableAt: null },
              ],
            },
            "macro",
            "2024-02-01T00:00:00.000Z",
          ),
        ),
      ).toEqual([
        {
          candidateId: `macro.${metadata.seriesId}`,
          label: `${metadata.seriesId} 2024-02-01`,
          value,
          unit: metadata.unit,
          asOf: "2024-02-01T00:00:00.000Z",
          selector: "/data/observations/1/value",
        },
      ]);
    },
  );

  it("allows empty normalized observation collections to yield no candidates", () => {
    const empty: SourceEnvelope[] = [
      envelope(
        { currency: "USD", adjustment: "unadjusted", bars: [] },
        "market",
      ),
      envelope({ ...sec(1), observations: [] }, "fundamentals"),
      envelope(
        {
          currency: "CNY",
          basis: "year_to_date",
          fields: ["totalOperatingRevenue"],
          observations: [],
        },
        "fundamentals",
      ),
      envelope(
        {
          seriesId: "DGS10",
          unit: "percent",
          frequency: "daily",
          seasonalAdjustment: "not_seasonally_adjusted",
          view: "current",
          observations: [],
        },
        "macro",
      ),
    ];
    for (const item of empty) expect(extractCandidates(item)).toEqual([]);
  });

  it("does not extract numbers from research text or provider timestamps", () => {
    const supplied = envelope(
      {
        query: "2024 outlook",
        view: "current_search",
        truncated: false,
        items: [
          {
            url: "https://example.com/2024",
            title: "Revenue up 20%",
            snippet: "Price target USD 123, volume 500.",
            providerTimestamp: "2024-06-28",
            publishedAt: null,
            availableAt: null,
            location: null,
          },
        ],
      },
      "research",
    );
    expect(extractCandidates(supplied)).toEqual([]);
  });
});
