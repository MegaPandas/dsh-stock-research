import type { ResearchScope } from "./data.js";
import type {
  EastmoneySourceQuery,
  FredSourceQuery,
  MarketSourceQuery,
  ResearchSourceQuery,
  SecSourceQuery,
  SinaSourceQuery,
  SourceDataset,
  SourceQuery,
  SourceResponse,
} from "./query.js";

export interface SourceCodeVersions {
  adapterVersion: string;
  normalizationVersion: string;
}

export interface SourceCapability extends SourceCodeVersions {
  provider: string;
  dataset: SourceDataset;
  historicalVersions: false;
}

export interface QuerySource<Q extends SourceQuery> {
  readonly capability: SourceCapability;
  query(
    input: Q["parameters"] & { scope: ResearchScope },
    signal?: AbortSignal,
  ): Promise<SourceResponse<Q>>;
}

export interface QuerySources {
  yahoo?: QuerySource<MarketSourceQuery>;
  eastmoneyMarket?: QuerySource<MarketSourceQuery>;
  tencent?: QuerySource<MarketSourceQuery>;
  sec?: QuerySource<SecSourceQuery>;
  eastmoneyIncome?: QuerySource<EastmoneySourceQuery>;
  sina?: QuerySource<SinaSourceQuery>;
  fred?: QuerySource<FredSourceQuery>;
  research?: QuerySource<ResearchSourceQuery>;
}

export interface SourceDescription {
  dataset: SourceDataset;
  provider: SourceQuery["provider"];
  capability: SourceCapability | null;
}
