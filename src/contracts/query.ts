import type {
  DataEnvelope,
  ISOTime,
  LocalDate,
  MarketData,
  ResearchScope,
  SourceRef,
} from "./data.js";
import type {
  EastmoneyIncomeData,
  EastmoneyIncomeQuery,
} from "./eastmoney-income.js";
import type { FundamentalsData, SecConceptQuery } from "./fundamentals.js";
import type { MacroData, FredQuery } from "./macro.js";
import type { MarketQuery } from "./market.js";
import type {
  IndicatorRequest,
  IndicatorResult,
  ReturnPrice,
} from "./indicators.js";
import type { ResearchData, ResearchQuery } from "./research.js";
import type { SinaIncomeData, SinaIncomeQuery } from "./sina-income.js";
import type { RegisteredEvidenceRecord } from "./task-data.js";
import type { CollectedTableData } from "./collection.js";

export type MarketSourceQuery = {
  dataset: "market";
  provider: "yahoo" | "eastmoney" | "tencent";
  parameters: Omit<MarketQuery, "scope">;
};
export type SecSourceQuery = {
  dataset: "fundamentals";
  provider: "sec";
  parameters: Omit<SecConceptQuery, "scope">;
};
export type EastmoneySourceQuery = {
  dataset: "fundamentals";
  provider: "eastmoney";
  parameters: Omit<EastmoneyIncomeQuery, "scope">;
};
export type SinaSourceQuery = {
  dataset: "fundamentals";
  provider: "sina";
  parameters: Omit<SinaIncomeQuery, "scope">;
};
export type FredSourceQuery = {
  dataset: "macro";
  provider: "fred";
  parameters: Omit<FredQuery, "scope">;
};
export type ResearchSourceQuery = {
  dataset: "research";
  provider: "dsh-web";
  parameters: Omit<ResearchQuery, "scope">;
};
export type SourceQuery =
  | MarketSourceQuery
  | SecSourceQuery
  | EastmoneySourceQuery
  | SinaSourceQuery
  | FredSourceQuery
  | ResearchSourceQuery;
export type SourceDataset = SourceQuery["dataset"];
export type SourceData<Q extends SourceQuery = SourceQuery> =
  Q extends MarketSourceQuery
    ? MarketData
    : Q extends SecSourceQuery
      ? FundamentalsData
      : Q extends EastmoneySourceQuery
        ? EastmoneyIncomeData
        : Q extends SinaSourceQuery
          ? SinaIncomeData
          : Q extends FredSourceQuery
            ? MacroData
            : ResearchData;
export type SourceEnvelope = DataEnvelope<SourceData>;
export type SourceResponse<Q extends SourceQuery> = DataEnvelope<SourceData<Q>>;
export interface TaskSourceResponse<Q extends SourceQuery> {
  sourceRef: SourceRef;
  envelope: RegisteredEvidenceRecord<SourceData<Q>>["envelope"];
}
export type QueryCachePolicy = Record<SourceDataset, number>;

export interface MarketIndicatorsQuery {
  dataset: "market";
  provider: MarketSourceQuery["provider"];
  parameters: MarketSourceQuery["parameters"] & {
    indicators: readonly IndicatorRequest[];
  };
}
export interface MarketIndicatorsData extends MarketData {
  indicators: { algorithmVersion: string; series: IndicatorResult[] };
}
export interface PriceReturnsQuery {
  dataset: "returns";
  provider: MarketSourceQuery["provider"];
  parameters: {
    historyStartDate: LocalDate;
    startDate: LocalDate;
    endDate: LocalDate;
    maxAgeMs: number;
    /** Confirmed by a trusted caller using the price basis and corporate actions. */
    comparable: boolean;
  };
}
export interface ReturnObservation extends ReturnPrice {
  asOf: ISOTime;
  availableAt: ISOTime | null;
}
export interface PriceReturnsData {
  market: MarketData;
  algorithmVersion: string;
  requestedStartDate: LocalDate;
  requestedEndDate: LocalDate;
  start: ReturnObservation | null;
  end: ReturnObservation | null;
  comparable: boolean;
  value: number | null;
  unit: "ratio";
}
export type QueryRequest =
  SourceQuery | MarketIndicatorsQuery | PriceReturnsQuery;
export type QueryData<Q extends QueryRequest = QueryRequest> =
  Q extends PriceReturnsQuery
    ? PriceReturnsData
    : Q extends MarketIndicatorsQuery
      ? MarketIndicatorsData
      : Q extends SourceQuery
        ? SourceData<Q>
        : never;
export type QueryEnvelope = DataEnvelope<QueryData>;
export type EvidenceData = QueryData | CollectedTableData;
export type EvidenceEnvelope = DataEnvelope<EvidenceData>;
export type QueryResponse<Q extends QueryRequest> = DataEnvelope<QueryData<Q>>;
export interface QuerySnapshot<Q extends QueryRequest = QueryRequest> {
  scope: ResearchScope;
  request: Q;
  envelope: QueryResponse<Q>;
}
export interface TaskQueryResponse<Q extends QueryRequest> {
  sourceRef: SourceRef;
  envelope: RegisteredEvidenceRecord<QueryData<Q>>["envelope"];
}
