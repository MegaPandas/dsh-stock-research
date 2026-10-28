import type { LocalDate, PriceAdjustment, ResearchScope } from "./data.js";

export interface MarketQuery {
  scope: ResearchScope;
  startDate: LocalDate;
  /** A completed trading date consumes 86_400_000 ms; closed/incomplete dates consume none. */
  maxAgeMs: number;
}

export interface MarketCapability {
  provider: string;
  dataset: "market";
  market: "US" | "CN";
  exchanges: readonly string[];
  fields: readonly ["open", "high", "low", "close", "volume"];
  interval: "1d";
  currency: string;
  adjustment: PriceAdjustment;
  dates: { start: LocalDate; end: LocalDate };
  historicalVersions: false;
  adapterVersion: string;
  normalizationVersion: string;
}
