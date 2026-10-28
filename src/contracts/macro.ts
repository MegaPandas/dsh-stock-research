import type { LocalDate, ResearchScope } from "./data.js";

export type FredSeriesId = "DGS10" | "FEDFUNDS" | "CPIAUCSL";

export interface MacroObservation {
  date: LocalDate;
  value: number | null;
  availableAt: null;
}

export interface MacroData {
  seriesId: FredSeriesId;
  unit: "percent" | "index_1982_1984_100";
  frequency: "daily" | "monthly";
  seasonalAdjustment: "seasonally_adjusted" | "not_seasonally_adjusted";
  view: "current";
  observations: MacroObservation[];
}

export interface FredQuery {
  scope: ResearchScope;
  seriesId: FredSeriesId;
  startDate: LocalDate;
  endDate: LocalDate;
  maxAgeMs: number;
}
