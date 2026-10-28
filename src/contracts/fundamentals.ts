import type { ISOTime, LocalDate, ResearchScope } from "./data.js";

export type FundamentalField = "revenue" | "netIncome";

export interface FundamentalObservation {
  periodStart: LocalDate;
  periodEnd: LocalDate;
  value: number | null;
  filed: LocalDate;
  accession: string;
  form: string;
  filingUrl: string;
  availableAt: ISOTime | null;
}

export interface FundamentalsData {
  field: FundamentalField;
  currency: string;
  concept: { taxonomy: string; tag: string };
  observations: FundamentalObservation[];
}

export interface SecConceptQuery {
  scope: ResearchScope;
  cik: string;
  field: FundamentalField;
  periodEndFrom: LocalDate;
  maxAgeMs: number;
}
