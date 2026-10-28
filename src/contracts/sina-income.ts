import type { ISOTime, LocalDate, ResearchScope } from "./data.js";

export type SinaIncomeField =
  "revenue" | "totalOperatingRevenue" | "netIncome" | "netIncomeToParent";

export interface SinaIncomeObservation {
  periodStart: LocalDate;
  periodEnd: LocalDate;
  publishDate: LocalDate | null;
  sourceUpdatedAt: ISOTime | null;
  values: Partial<Record<SinaIncomeField, number | null>>;
  availableAt: null;
}

export interface SinaIncomeData {
  currency: "CNY";
  basis: "year_to_date";
  consolidation: "consolidated";
  fields: SinaIncomeField[];
  observations: SinaIncomeObservation[];
}

export interface SinaIncomeQuery {
  scope: ResearchScope;
  fields: readonly SinaIncomeField[];
  maxAgeMs: number;
}
