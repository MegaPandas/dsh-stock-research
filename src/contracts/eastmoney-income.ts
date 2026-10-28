import type { LocalDate, ResearchScope } from "./data.js";

export type EastmoneyIncomeField =
  "totalOperatingRevenue" | "netIncomeToParent";

export interface EastmoneyIncomeObservation {
  periodStart: LocalDate;
  periodEnd: LocalDate;
  noticeDate: LocalDate | null;
  values: Partial<Record<EastmoneyIncomeField, number | null>>;
  availableAt: null;
}

export interface EastmoneyIncomeData {
  currency: "CNY";
  basis: "year_to_date";
  fields: EastmoneyIncomeField[];
  observations: EastmoneyIncomeObservation[];
}

export interface EastmoneyIncomeQuery {
  scope: ResearchScope;
  fields: readonly EastmoneyIncomeField[];
  periodEndFrom: LocalDate;
  periodEndTo: LocalDate;
  maxAgeMs: number;
}
