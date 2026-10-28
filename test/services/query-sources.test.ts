import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DataEnvelope,
  MarketData,
  ResearchScope,
} from "../../src/contracts/data.js";
import type { EastmoneyIncomeData } from "../../src/contracts/eastmoney-income.js";
import type { FundamentalsData } from "../../src/contracts/fundamentals.js";
import type { MacroData } from "../../src/contracts/macro.js";
import type { SourceDataset, SourceQuery } from "../../src/contracts/query.js";
import type { ResearchData } from "../../src/contracts/research.js";
import type { SinaIncomeData } from "../../src/contracts/sina-income.js";
import { EastmoneyIncomeAdapter } from "../../src/data/eastmoney-income.js";
import { EastmoneyMarketAdapter } from "../../src/data/eastmoney-market.js";
import { FredCsvAdapter } from "../../src/data/fred-csv.js";
import { HostResearchAdapter } from "../../src/data/host-research.js";
import { HttpClient } from "../../src/data/http.js";
import { SecConceptAdapter } from "../../src/data/sec-concept.js";
import { SinaIncomeAdapter } from "../../src/data/sina-income.js";
import { TencentMarketAdapter } from "../../src/data/tencent-market.js";
import { YahooMarketAdapter } from "../../src/data/yahoo-market.js";
import {
  describeSources,
  selectSource,
  type QuerySources,
} from "../../src/services/query-sources.js";

const usScope: ResearchScope = {
  security: {
    id: "US:NVDA",
    market: "US",
    symbol: "NVDA",
    exchange: "NASDAQ",
    currency: "USD",
    timeZone: "America/New_York",
  },
  date: "2024-01-02",
  cutoff: "2024-01-02T21:00:00.000Z",
};
const cnScope: ResearchScope = {
  security: {
    id: "CN:600519.SH",
    market: "CN",
    symbol: "600519.SH",
    exchange: "SH",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2024-01-02",
  cutoff: "2024-01-02T07:00:00.000Z",
};
const clients: HttpClient[] = [];

function envelope<T>(
  dataset: SourceDataset,
  capability: {
    provider: string;
    adapterVersion: string;
    normalizationVersion: string;
  },
  data: T,
  scope: ResearchScope,
  asOf: string,
  stale: boolean,
): DataEnvelope<T> {
  return {
    dataset,
    data,
    source: {
      provider: capability.provider,
      url: `https://example.com/fixtures/${dataset}/${capability.provider}`,
      adapterVersion: capability.adapterVersion,
      normalizationVersion: capability.normalizationVersion,
    },
    asOf,
    availableAt: null,
    retrievedAt: scope.cutoff,
    cutoff: scope.cutoff,
    ageMs: Date.parse(scope.cutoff) - Date.parse(asOf),
    stale,
    historicalKnowledge: "unverified",
    gaps: [
      {
        code: "unverified_time",
        field: "/data",
        detail:
          "Fixed normalized routing fixture; historical availability is unverified.",
      },
    ],
  };
}
function market(scope: ResearchScope): MarketData {
  return {
    currency: scope.security.currency,
    adjustment: "unadjusted",
    bars: [
      {
        date: scope.date,
        asOf: scope.cutoff,
        availableAt: null,
        sessionComplete: true,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1000,
      },
    ],
  };
}
function setup() {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  clients.push(http);
  const getText = vi
    .spyOn(http, "getText")
    .mockRejectedValue(
      new Error("Routing tests must not issue HTTP requests."),
    );
  const sources = {
    yahoo: new YahooMarketAdapter(http),
    eastmoneyMarket: new EastmoneyMarketAdapter(http),
    tencent: new TencentMarketAdapter(http),
    sec: new SecConceptAdapter(http, "CedarResearch/0.1"),
    eastmoneyIncome: new EastmoneyIncomeAdapter(http),
    sina: new SinaIncomeAdapter(http),
    fred: new FredCsvAdapter(http),
    research: new HostResearchAdapter(async () => {
      throw new Error("Routing tests must not search the host.");
    }),
  } satisfies QuerySources;
  const fundamentals: FundamentalsData = {
    field: "netIncome",
    currency: "USD",
    concept: { taxonomy: "us-gaap", tag: "NetIncomeLoss" },
    observations: [
      {
        periodStart: "2023-01-01",
        periodEnd: "2023-12-31",
        value: 20,
        filed: "2024-01-02",
        accession: "0001045810-24-000001",
        form: "10-K",
        filingUrl: "https://example.com/fixtures/filing",
        availableAt: null,
      },
    ],
  };
  const eastmoneyIncome: EastmoneyIncomeData = {
    currency: "CNY",
    basis: "year_to_date",
    fields: ["totalOperatingRevenue", "netIncomeToParent"],
    observations: [
      {
        periodStart: "2023-01-01",
        periodEnd: "2023-09-30",
        noticeDate: "2023-10-31",
        values: { totalOperatingRevenue: 100, netIncomeToParent: 10 },
        availableAt: null,
      },
    ],
  };
  const sina: SinaIncomeData = {
    currency: "CNY",
    basis: "year_to_date",
    consolidation: "consolidated",
    fields: ["revenue", "netIncome"],
    observations: [
      {
        periodStart: "2023-01-01",
        periodEnd: "2023-09-30",
        publishDate: "2023-10-31",
        sourceUpdatedAt: "2023-11-01T00:00:00.000Z",
        values: { revenue: 100, netIncome: 10 },
        availableAt: null,
      },
    ],
  };
  const macro: MacroData = {
    seriesId: "DGS10",
    unit: "percent",
    frequency: "daily",
    seasonalAdjustment: "not_seasonally_adjusted",
    view: "current",
    observations: [{ date: usScope.date, value: 3.95, availableAt: null }],
  };
  const research: ResearchData = {
    query: "NVDA earnings",
    view: "current_search",
    truncated: false,
    items: [
      {
        url: "https://example.com/fixtures/news",
        title: "Earnings fixture",
        snippet: "Normalized source snippet.",
        providerTimestamp: null,
        publishedAt: null,
        availableAt: null,
        location: null,
      },
    ],
  };
  const results = {
    yahoo: envelope(
      "market",
      sources.yahoo.capability,
      market(usScope),
      usScope,
      usScope.cutoff,
      false,
    ),
    eastmoneyMarket: envelope(
      "market",
      sources.eastmoneyMarket.capability,
      market(cnScope),
      cnScope,
      cnScope.cutoff,
      false,
    ),
    tencent: envelope(
      "market",
      sources.tencent.capability,
      market(cnScope),
      cnScope,
      cnScope.cutoff,
      false,
    ),
    sec: envelope(
      "fundamentals",
      sources.sec.capability,
      fundamentals,
      usScope,
      "2023-12-31T23:59:59.999Z",
      true,
    ),
    eastmoneyIncome: envelope(
      "fundamentals",
      sources.eastmoneyIncome.capability,
      eastmoneyIncome,
      cnScope,
      "2023-09-30T15:59:59.999Z",
      true,
    ),
    sina: envelope(
      "fundamentals",
      sources.sina.capability,
      sina,
      cnScope,
      "2023-09-30T15:59:59.999Z",
      true,
    ),
    fred: envelope(
      "macro",
      sources.fred.capability,
      macro,
      usScope,
      "2024-01-02T00:00:00.000Z",
      true,
    ),
    research: envelope(
      "research",
      sources.research.capability,
      research,
      usScope,
      usScope.cutoff,
      false,
    ),
  };
  const spies = {
    yahoo: vi.spyOn(sources.yahoo, "query").mockResolvedValue(results.yahoo),
    eastmoneyMarket: vi
      .spyOn(sources.eastmoneyMarket, "query")
      .mockResolvedValue(results.eastmoneyMarket),
    tencent: vi
      .spyOn(sources.tencent, "query")
      .mockResolvedValue(results.tencent),
    sec: vi.spyOn(sources.sec, "query").mockResolvedValue(results.sec),
    eastmoneyIncome: vi
      .spyOn(sources.eastmoneyIncome, "query")
      .mockResolvedValue(results.eastmoneyIncome),
    sina: vi.spyOn(sources.sina, "query").mockResolvedValue(results.sina),
    fred: vi.spyOn(sources.fred, "query").mockResolvedValue(results.fred),
    research: vi
      .spyOn(sources.research, "query")
      .mockResolvedValue(results.research),
  };
  return { sources, spies, results, getText };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
});

const routes = [
  {
    slot: "yahoo",
    scope: usScope,
    request: {
      dataset: "market",
      provider: "yahoo",
      parameters: { startDate: "2024-01-01", maxAgeMs: 101 },
    },
  },
  {
    slot: "eastmoneyMarket",
    scope: cnScope,
    request: {
      dataset: "market",
      provider: "eastmoney",
      parameters: { startDate: "2024-01-01", maxAgeMs: 202 },
    },
  },
  {
    slot: "tencent",
    scope: cnScope,
    request: {
      dataset: "market",
      provider: "tencent",
      parameters: { startDate: "2024-01-01", maxAgeMs: 303 },
    },
  },
  {
    slot: "sec",
    scope: usScope,
    request: {
      dataset: "fundamentals",
      provider: "sec",
      parameters: {
        cik: "0001045810",
        field: "netIncome",
        periodEndFrom: "2023-01-01",
        maxAgeMs: 404,
      },
    },
  },
  {
    slot: "eastmoneyIncome",
    scope: cnScope,
    request: {
      dataset: "fundamentals",
      provider: "eastmoney",
      parameters: {
        fields: ["totalOperatingRevenue", "netIncomeToParent"],
        periodEndFrom: "2023-03-31",
        periodEndTo: "2023-12-31",
        maxAgeMs: 505,
      },
    },
  },
  {
    slot: "sina",
    scope: cnScope,
    request: {
      dataset: "fundamentals",
      provider: "sina",
      parameters: { fields: ["revenue", "netIncome"], maxAgeMs: 606 },
    },
  },
  {
    slot: "fred",
    scope: usScope,
    request: {
      dataset: "macro",
      provider: "fred",
      parameters: {
        seriesId: "DGS10",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        maxAgeMs: 707,
      },
    },
  },
  {
    slot: "research",
    scope: usScope,
    request: {
      dataset: "research",
      provider: "dsh-web",
      parameters: { query: "NVDA earnings", maxResults: 3 },
    },
  },
] satisfies {
  slot: keyof QuerySources;
  scope: ResearchScope;
  request: SourceQuery;
}[];

describe("explicit query source routing", () => {
  it.each(routes)(
    "selects only $slot and forwards its complete query and signal",
    async ({ slot, scope, request }) => {
      const { sources, spies, results, getText } = setup();
      const signal = new AbortController().signal;
      const selected = selectSource(sources, scope, request);
      expect(selected.capability).toBe(sources[slot].capability);
      for (const spy of Object.values(spies))
        expect(spy).not.toHaveBeenCalled();
      expect(await selected.fetch(signal)).toBe(results[slot]);
      for (const [name, spy] of Object.entries(spies))
        expect(spy).toHaveBeenCalledTimes(name === slot ? 1 : 0);
      const call = spies[slot].mock.calls[0]!;
      expect(call).toEqual([{ ...request.parameters, scope }, signal]);
      expect(call[0].scope).toBe(scope);
      expect(call[1]).toBe(signal);
      expect(getText).not.toHaveBeenCalled();
    },
  );

  it("describes all eight configured capabilities and absent profiles without fetching", () => {
    const { sources, spies, getText } = setup();
    const profiles = [
      {
        dataset: "market",
        provider: "yahoo",
        capability: sources.yahoo.capability,
      },
      {
        dataset: "market",
        provider: "eastmoney",
        capability: sources.eastmoneyMarket.capability,
      },
      {
        dataset: "market",
        provider: "tencent",
        capability: sources.tencent.capability,
      },
      {
        dataset: "fundamentals",
        provider: "sec",
        capability: sources.sec.capability,
      },
      {
        dataset: "fundamentals",
        provider: "eastmoney",
        capability: sources.eastmoneyIncome.capability,
      },
      {
        dataset: "fundamentals",
        provider: "sina",
        capability: sources.sina.capability,
      },
      {
        dataset: "macro",
        provider: "fred",
        capability: sources.fred.capability,
      },
      {
        dataset: "research",
        provider: "dsh-web",
        capability: sources.research.capability,
      },
    ];
    const configured = describeSources(sources);
    expect(configured).toHaveLength(8);
    expect(configured).toEqual(expect.arrayContaining(profiles));
    const partial = describeSources({ yahoo: sources.yahoo });
    expect(partial).toHaveLength(8);
    expect(partial).toEqual(
      expect.arrayContaining(
        profiles.map((profile) => ({
          ...profile,
          capability:
            profile.provider === "yahoo" ? sources.yahoo.capability : null,
        })),
      ),
    );
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured income source without using the same provider's market adapter", () => {
    const { sources, spies, getText } = setup();
    const configured: QuerySources = { ...sources };
    delete configured.eastmoneyIncome;
    expect(() =>
      selectSource(configured, cnScope, {
        dataset: "fundamentals",
        provider: "eastmoney",
        parameters: {
          fields: ["netIncomeToParent"],
          periodEndFrom: "2023-03-31",
          periodEndTo: "2023-12-31",
          maxAgeMs: 505,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_UNAVAILABLE" }));
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(getText).not.toHaveBeenCalled();
  });
});
