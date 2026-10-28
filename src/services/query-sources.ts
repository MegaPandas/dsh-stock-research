import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  SourceDataset,
  SourceEnvelope,
  SourceQuery,
} from "../contracts/query.js";
import type { EastmoneyIncomeAdapter } from "../data/eastmoney-income.js";
import type { EastmoneyMarketAdapter } from "../data/eastmoney-market.js";
import type { FredCsvAdapter } from "../data/fred-csv.js";
import type { HostResearchAdapter } from "../data/host-research.js";
import type { SecConceptAdapter } from "../data/sec-concept.js";
import type { SinaIncomeAdapter } from "../data/sina-income.js";
import type { TencentMarketAdapter } from "../data/tencent-market.js";
import type { YahooMarketAdapter } from "../data/yahoo-market.js";

type Adapter<A extends { capability: unknown; query: unknown }> = Pick<
  A,
  "capability" | "query"
>;
export interface QuerySources {
  yahoo?: Adapter<YahooMarketAdapter>;
  eastmoneyMarket?: Adapter<EastmoneyMarketAdapter>;
  tencent?: Adapter<TencentMarketAdapter>;
  sec?: Adapter<SecConceptAdapter>;
  eastmoneyIncome?: Adapter<EastmoneyIncomeAdapter>;
  sina?: Adapter<SinaIncomeAdapter>;
  fred?: Adapter<FredCsvAdapter>;
  research?: Adapter<HostResearchAdapter>;
}
type ConfiguredAdapter = NonNullable<QuerySources[keyof QuerySources]>;
export type SourceCapability = ConfiguredAdapter["capability"];
export interface SourceDescription {
  dataset: SourceDataset;
  provider: SourceQuery["provider"];
  capability: SourceCapability | null;
}
export interface SourceSelection {
  capability: SourceCapability;
  fetch(signal: AbortSignal): Promise<SourceEnvelope>;
}
function configured<A>(adapter: A | undefined, request: SourceQuery): A {
  if (adapter === undefined)
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      `${request.dataset}/${request.provider} is not configured.`,
    );
  return adapter;
}

export function selectSource(
  sources: QuerySources,
  scope: ResearchScope,
  request: SourceQuery,
): SourceSelection {
  switch (request.dataset) {
    case "market": {
      const adapter = configured(
        request.provider === "yahoo"
          ? sources.yahoo
          : request.provider === "eastmoney"
            ? sources.eastmoneyMarket
            : sources.tencent,
        request,
      );
      return {
        capability: adapter.capability,
        fetch: (signal) =>
          adapter.query({ ...request.parameters, scope }, signal),
      };
    }
    case "fundamentals": {
      if (request.provider === "sec") {
        const adapter = configured(sources.sec, request);
        return {
          capability: adapter.capability,
          fetch: (signal) =>
            adapter.query({ ...request.parameters, scope }, signal),
        };
      }
      if (request.provider === "eastmoney") {
        const adapter = configured(sources.eastmoneyIncome, request);
        return {
          capability: adapter.capability,
          fetch: (signal) =>
            adapter.query({ ...request.parameters, scope }, signal),
        };
      }
      const adapter = configured(sources.sina, request);
      return {
        capability: adapter.capability,
        fetch: (signal) =>
          adapter.query({ ...request.parameters, scope }, signal),
      };
    }
    case "macro": {
      const adapter = configured(sources.fred, request);
      return {
        capability: adapter.capability,
        fetch: (signal) =>
          adapter.query({ ...request.parameters, scope }, signal),
      };
    }
    case "research": {
      const adapter = configured(sources.research, request);
      return {
        capability: adapter.capability,
        fetch: (signal) =>
          adapter.query({ ...request.parameters, scope }, signal),
      };
    }
  }
}

export function describeSources(sources: QuerySources): SourceDescription[] {
  return [
    {
      dataset: "market",
      provider: "yahoo",
      capability: sources.yahoo?.capability ?? null,
    },
    {
      dataset: "market",
      provider: "eastmoney",
      capability: sources.eastmoneyMarket?.capability ?? null,
    },
    {
      dataset: "market",
      provider: "tencent",
      capability: sources.tencent?.capability ?? null,
    },
    {
      dataset: "fundamentals",
      provider: "sec",
      capability: sources.sec?.capability ?? null,
    },
    {
      dataset: "fundamentals",
      provider: "eastmoney",
      capability: sources.eastmoneyIncome?.capability ?? null,
    },
    {
      dataset: "fundamentals",
      provider: "sina",
      capability: sources.sina?.capability ?? null,
    },
    {
      dataset: "macro",
      provider: "fred",
      capability: sources.fred?.capability ?? null,
    },
    {
      dataset: "research",
      provider: "dsh-web",
      capability: sources.research?.capability ?? null,
    },
  ];
}
