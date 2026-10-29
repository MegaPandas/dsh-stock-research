import type { ISOTime } from "./data.js";

export const VALUATION_ENGINE_VERSION = "2";
export const DETERMINISTIC_VALUATION_PROTOCOL = "31";
export const VALUATION_METHODS_INPUT = "stock-research:valuation-methods";
export const AMOUNT_SCALES = {
  unit: 1,
  thousand: 1_000,
  million: 1_000_000,
  hundred_million: 100_000_000,
} as const;
export type AmountUnit = keyof typeof AMOUNT_SCALES;
export interface CapmInput {
  kind: "capm";
  riskFreeRate: number;
  equityRiskPremium: number;
  beta: number;
  countryRiskPremium: number;
}
export type EquityCostInput = number | CapmInput;
export interface WaccInput {
  kind: "wacc";
  costOfEquity: EquityCostInput;
  preTaxCostOfDebt: number;
  taxRate: number;
  debtWeight: number;
}
export type DiscountRateInput = EquityCostInput | WaccInput;
export interface EquityBridge {
  excessCash: number;
  nonOperatingAssets: number;
  debt: number;
  preferredEquity: number;
  minorityInterest: number;
  otherClaims: number;
}
export interface OperatingPeriod {
  endDate: string;
  revenue: number;
  operatingMargin: number;
  taxRate: number;
  depreciation: number;
  capex: number;
  workingCapital: number;
}
export interface EquityPeriod {
  endDate: string;
  netIncome: number;
  depreciation: number;
  capex: number;
  workingCapital: number;
  newDebt: number;
  debtRepaid: number;
}
export type Terminal<Parameters extends object = Record<never, never>> =
  | {
      kind: "finite";
      /** Actual total recovery at the last forecast date. */ recovery: number;
    }
  | ({ kind: "gordon"; growthRate: number } & Parameters);
export interface ValuationInputs {
  fcff_dcf: {
    forecastStartDate: string;
    openingWorkingCapital: number;
    periods: OperatingPeriod[];
    discountRate: DiscountRateInput;
    terminal: Terminal<{ returnOnCapital: number }>;
    bridge: EquityBridge;
  };
  fcfe_dcf: {
    forecastStartDate: string;
    openingWorkingCapital: number;
    periods: EquityPeriod[];
    discountRate: DiscountRateInput;
    terminal: Terminal<{ returnOnEquity: number }>;
  };
  dividend_discount: {
    forecastStartDate: string;
    periods: { endDate: string; dividend: number }[];
    discountRate: DiscountRateInput;
    terminal: Terminal;
  };
  regulatory_capital_fcfe: {
    forecastStartDate: string;
    openingRequiredCapital: number;
    periods: { endDate: string; netIncome: number; requiredCapital: number }[];
    discountRate: DiscountRateInput;
    terminal: Terminal;
  };
  residual_income: {
    forecastStartDate: string;
    openingBookEquity: number;
    periods: {
      endDate: string;
      netIncome: number;
      payoutRatio: number;
      netIssuance: number;
      otherEquityChanges: number;
    }[];
    discountRate: DiscountRateInput;
    terminal: Terminal<{ returnOnEquity: number }>;
  };
  adjusted_present_value: {
    forecastStartDate: string;
    openingWorkingCapital: number;
    periods: OperatingPeriod[];
    unleveredRate: DiscountRateInput;
    terminal: Terminal<{ returnOnCapital: number }>;
    financingEffects: {
      taxShield: number;
      financingCost: number;
      distressCost: number;
      discountRate: DiscountRateInput;
    }[];
    terminalFinancing:
      | { kind: "finite"; amount: number; discountRate: DiscountRateInput }
      | {
          kind: "gordon";
          nextCashFlow: number;
          growthRate: number;
          discountRate: DiscountRateInput;
        };
    bridge: EquityBridge;
  };
  comparable_multiples:
    | { multipleType: "pe"; netIncome: number; multiples: number[] }
    | { multipleType: "pb"; bookEquity: number; multiples: number[] }
    | { multipleType: "ps"; revenue: number; multiples: number[] }
    | { multipleType: "pcf"; operatingCashFlow: number; multiples: number[] }
    | {
        multipleType: "ev_ebitda";
        ebitda: number;
        multiples: number[];
        bridge: EquityBridge;
      }
    | {
        multipleType: "ev_revenue";
        revenue: number;
        multiples: number[];
        bridge: EquityBridge;
      };
  adjusted_net_assets: {
    assets: { label: string; fairValue: number; ownership: number }[];
    liabilities: number;
    priorityClaims: number;
    disposalCosts: number;
  };
  scenario_dcf_rnpv:
    | {
        kind: "scenarios";
        scenarios: {
          label: string;
          probability: number;
          calculationId: string;
        }[];
      }
    | {
        kind: "project";
        initialCashFlow: number;
        forecastStartDate: string;
        periods: { endDate: string; cashFlow: number; probability: number }[];
        discountRate: DiscountRateInput;
        bridge: EquityBridge;
      };
  sum_of_parts: {
    parts: { label: string; ownership: number; calculationId: string }[];
    groupAssets: number;
    groupLiabilities: number;
    headOffice:
      | { kind: "none" }
      | {
          kind: "forecast";
          forecastStartDate: string;
          periods: { endDate: string; cost: number }[];
          discountRate: DiscountRateInput;
          terminal: Terminal;
        };
  };
  real_options: {
    rootNode: string;
    probabilityMeasure: "risk_neutral" | "risk_adjusted";
    nodes: {
      id: string;
      year: number;
      exerciseValue: number | null;
      abandonmentValue: number | null;
      continuationCost: number;
      discountRate: DiscountRateInput;
      transitions: { nodeId: string; probability: number }[];
    }[];
    bridge: EquityBridge;
  };
}
export type ValuationMethodId = keyof ValuationInputs;
export interface ValuationProvenance {
  path: string;
  kind: "observed" | "normalized" | "assumed";
  basis: string;
}
export type ValuationRequest = {
  [Method in ValuationMethodId]: {
    methodId: Method;
    purpose: "valuation" | "target_price";
    amountUnit: AmountUnit;
    shares: { value: number; unit: AmountUnit };
    inputs: ValuationInputs[Method];
    assumptions: string[];
    provenance: ValuationProvenance[];
    sensitivities: {
      label: string;
      path: string;
      value: number;
      basis: string;
    }[];
  };
}[ValuationMethodId];
export interface CalculationStep {
  label: string;
  value: number;
  unit: string;
}
export interface ValuationOutput {
  diagnostics: string[];
  equityValues: number[];
  perShareValues: number[];
  shares: number;
  steps: CalculationStep[];
}
export interface ValuationCalculation {
  kind: "valuation-calculation";
  calculationId: string;
  runId: string;
  taskId: string;
  attempt: number;
  engineVersion: string;
  methodVersion: string;
  currency: string;
  valueDate: string;
  createdAt: ISOTime;
  request: ValuationRequest;
  result: ValuationOutput;
  sensitivities: {
    label: string;
    path: string;
    value: number;
    basis: string;
    result: ValuationOutput;
  }[];
}
