import type { DataGap, LocalDate, PriceAdjustment } from "./data.js";

export type PeriodIndicator = "sma" | "ema" | "rsi" | "atr" | "vwma" | "mfi";

export type IndicatorRequest =
  | { kind: PeriodIndicator; period: number }
  | { kind: "boll"; period: number; deviations: number }
  | {
      kind: "macd";
      fastPeriod: number;
      slowPeriod: number;
      signalPeriod: number;
    };

export interface BollValue {
  middle: number;
  upper: number;
  lower: number;
}

export interface MacdValue {
  macd: number;
  signal: number | null;
  histogram: number | null;
}

export type IndicatorResult =
  | {
      kind: PeriodIndicator;
      period: number;
      unit: string;
      values: (number | null)[];
    }
  | {
      kind: "boll";
      period: number;
      deviations: number;
      unit: string;
      values: (BollValue | null)[];
    }
  | {
      kind: "macd";
      fastPeriod: number;
      slowPeriod: number;
      signalPeriod: number;
      unit: string;
      values: (MacdValue | null)[];
    };

export interface ReturnPrice {
  date: LocalDate;
  price: number;
  currency: string;
  adjustment: PriceAdjustment;
}

export interface PriceReturnInput {
  requestedStartDate: LocalDate;
  requestedEndDate: LocalDate;
  start: ReturnPrice;
  end: ReturnPrice;
  /** The data adapter confirms a common basis, including intervening splits. */
  comparable: boolean;
}

export interface PriceReturnResult extends PriceReturnInput {
  value: number | null;
  unit: "ratio";
  gaps: DataGap[];
}
