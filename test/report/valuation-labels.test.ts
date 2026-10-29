import { describe, expect, it } from "vitest";
import type {
  ValuationInputs,
  ValuationMethodId,
  ValuationOutput,
  ValuationRequest,
} from "../../src/contracts/valuation.js";
import {
  formatValuationDiagnostic,
  formatValuationStep,
} from "../../src/report/valuation-labels.js";
import { evaluateValuation } from "../../src/valuation/index.js";

const start = "2025-01-01";
const end = "2026-01-01";
const bridge = {
  excessCash: 0,
  nonOperatingAssets: 0,
  debt: 0,
  preferredEquity: 0,
  minorityInterest: 0,
  otherClaims: 0,
};
const capm = {
  kind: "capm",
  riskFreeRate: 0.02,
  equityRiskPremium: 0.06,
  beta: 1,
  countryRiskPremium: 0,
} as const;
const wacc = {
  kind: "wacc",
  costOfEquity: capm,
  preTaxCostOfDebt: 0.05,
  taxRate: 0.2,
  debtWeight: 0.3,
} as const;
const operating = {
  endDate: end,
  revenue: 100,
  operatingMargin: 0.2,
  taxRate: 0.2,
  depreciation: 1,
  capex: 2,
  workingCapital: 1,
};
function request<Method extends ValuationMethodId>(
  methodId: Method,
  inputs: ValuationInputs[Method],
): ValuationRequest {
  return {
    methodId,
    inputs,
    purpose: "valuation",
    amountUnit: "unit",
    shares: { value: 10, unit: "unit" },
    assumptions: ["Test forecast"],
    provenance: [],
    sensitivities: [],
  } as ValuationRequest;
}

const examples = [
  request("fcff_dcf", {
    forecastStartDate: start,
    openingWorkingCapital: 0,
    periods: [operating],
    discountRate: wacc,
    terminal: { kind: "gordon", growthRate: 0.02, returnOnCapital: 0.1 },
    bridge,
  }),
  request("fcfe_dcf", {
    forecastStartDate: start,
    openingWorkingCapital: 0,
    periods: [
      {
        endDate: end,
        netIncome: 20,
        depreciation: 1,
        capex: 2,
        workingCapital: 1,
        newDebt: 0,
        debtRepaid: 0,
      },
    ],
    discountRate: capm,
    terminal: { kind: "gordon", growthRate: 0.02, returnOnEquity: 0.1 },
  }),
  request("dividend_discount", {
    forecastStartDate: start,
    periods: [{ endDate: end, dividend: 10 }],
    discountRate: 0.1,
    terminal: { kind: "gordon", growthRate: 0.02 },
  }),
  request("regulatory_capital_fcfe", {
    forecastStartDate: start,
    openingRequiredCapital: 100,
    periods: [{ endDate: end, netIncome: 20, requiredCapital: 110 }],
    discountRate: 0.1,
    terminal: { kind: "gordon", growthRate: 0.02 },
  }),
  request("residual_income", {
    forecastStartDate: start,
    openingBookEquity: 100,
    periods: [
      {
        endDate: end,
        netIncome: 20,
        payoutRatio: 0.5,
        netIssuance: 0,
        otherEquityChanges: 0,
      },
    ],
    discountRate: 0.1,
    terminal: { kind: "gordon", growthRate: 0.02, returnOnEquity: 0.15 },
  }),
  request("adjusted_present_value", {
    forecastStartDate: start,
    openingWorkingCapital: 0,
    periods: [operating],
    unleveredRate: 0.1,
    terminal: { kind: "gordon", growthRate: 0.02, returnOnCapital: 0.1 },
    financingEffects: [
      { taxShield: 1, financingCost: 0, distressCost: 0, discountRate: wacc },
    ],
    terminalFinancing: {
      kind: "gordon",
      nextCashFlow: 1,
      growthRate: 0.01,
      discountRate: wacc,
    },
    bridge,
  }),
  request("comparable_multiples", {
    multipleType: "pe",
    netIncome: 10,
    multiples: [10, 15],
  }),
  request("adjusted_net_assets", {
    assets: [{ label: "Head office property", fairValue: 100, ownership: 1 }],
    liabilities: 10,
    priorityClaims: 0,
    disposalCosts: 1,
  }),
  request("scenario_dcf_rnpv", {
    kind: "project",
    forecastStartDate: start,
    initialCashFlow: -10,
    periods: [{ endDate: end, cashFlow: 100, probability: 0.5 }],
    discountRate: 0.1,
    bridge,
  }),
  request("sum_of_parts", {
    parts: [
      { label: "Head office business", ownership: 0.5, calculationId: "asset" },
    ],
    groupAssets: 10,
    groupLiabilities: 5,
    headOffice: {
      kind: "forecast",
      forecastStartDate: start,
      periods: [{ endDate: end, cost: 1 }],
      discountRate: wacc,
      terminal: { kind: "finite", recovery: 0 },
    },
  }),
  request("real_options", {
    rootNode: "Head office root",
    probabilityMeasure: "risk_neutral",
    nodes: [
      {
        id: "Head office root",
        year: 0,
        exerciseValue: 50,
        abandonmentValue: 10,
        continuationCost: 1,
        discountRate: wacc,
        transitions: [{ nodeId: "Period 1 financing", probability: 1 }],
      },
      {
        id: "Period 1 financing",
        year: 1,
        exerciseValue: 100,
        abandonmentValue: 0,
        continuationCost: 0,
        discountRate: capm,
        transitions: [],
      },
    ],
    bridge,
  }),
];

const dependency: ValuationOutput = {
  equityValues: [100],
  perShareValues: [10],
  shares: 10,
  steps: [],
  diagnostics: [],
};

describe("Chinese valuation report labels", () => {
  it.each(examples)(
    "formats $methodId steps without changing calculation output",
    (input) => {
      const result = evaluateValuation(
        input,
        "CNY",
        new Map([["asset", dependency]]),
        start,
      );
      const original = structuredClone(result);
      const lines = result.steps.map((step) =>
        formatValuationStep(step, input.methodId),
      );
      expect(lines).toHaveLength(result.steps.length);
      for (let index = 0; index < result.steps.length; index++) {
        expect(lines[index]).toMatch(/\p{Script=Han}/u);
        expect(lines[index]).toMatch(/=-?\d+(?:\.\d+)?(?:%| .+)$/u);
      }
      expect(lines.at(-1)).toBe("普通股股数=10 股");
      expect(result).toEqual(original);
      expect(result.steps.at(-1)!.label).toBe("Common shares");
    },
  );

  it("preserves asset, segment, scenario and decision-node names", () => {
    const cases = [
      [
        "adjusted_net_assets",
        "Head office property: attributable fair value",
        "Head office property：归属公允价值",
      ],
      [
        "sum_of_parts",
        "Head office business: attributable common equity",
        "Head office business：归属普通股权益",
      ],
      [
        "scenario_dcf_rnpv",
        "Downside: probability-weighted equity",
        "Downside：概率加权股权价值",
      ],
      [
        "real_options",
        "Head office root discount rate cost of equity CAPM",
        "节点Head office root折现率股权成本（CAPM）",
      ],
      [
        "real_options",
        "Period 1 financing discount rate",
        "节点Period 1 financing折现率",
      ],
      [
        "real_options",
        "Head office root: optimal continue",
        "Head office root：最优决策为继续",
      ],
    ] as const;
    for (const [method, label, translated] of cases)
      expect(
        formatValuationStep({ label, value: 2.75, unit: "USD/share" }, method),
      ).toBe(`${translated}=2.75 USD/股`);
  });

  it("formats finite APV financing, percentages and multiples", () => {
    expect(
      formatValuationStep(
        { label: "Terminal financing amount", value: -20, unit: "CNY" },
        "adjusted_present_value",
      ),
    ).toBe("期末融资净额=-20 CNY");
    expect(
      formatValuationStep(
        { label: "Discount rate", value: 0.1, unit: "ratio" },
        "fcff_dcf",
      ),
    ).toBe("折现率=10%");
    expect(
      formatValuationStep(
        { label: "Comparable multiple", value: 20, unit: "multiple" },
        "comparable_multiples",
      ),
    ).toBe("估值倍数=20 倍");
  });

  it("formats calculation amounts without floating-point tails", () => {
    const step = {
      label: "Period 2 EBIT",
      value: 773999999.9999999,
      unit: "CNY",
    };
    expect(formatValuationStep(step, "fcff_dcf")).toBe(
      "第2期息税前经营利润=7.74 亿CNY",
    );
    expect(step.value).toBe(773999999.9999999);
  });

  it("translates engine diagnostics without changing the original messages", () => {
    const diagnostics = [
      "Terminal reinvestment exceeds income; the forecast assumes additional financing.",
      "Terminal retained income exceeds net income; the forecast assumes additional financing.",
      "Negative equity residual is not a usable target share price; analyze solvency and allocation of claims.",
    ];
    expect(diagnostics.map(formatValuationDiagnostic)).toEqual([
      "终值再投资额超过收益，预测假设需要额外融资。",
      "终值留存收益超过净利润，预测假设需要额外融资。",
      "股权残值为负，不能作为目标股价；应分析偿付能力和索取权分配。",
    ]);
    expect(diagnostics[0]).toContain("Terminal reinvestment");
  });

  it("formats financing diagnostics produced by terminal valuation", () => {
    const fcff = request("fcff_dcf", {
      forecastStartDate: start,
      openingWorkingCapital: 0,
      periods: [operating],
      discountRate: 0.1,
      terminal: { kind: "gordon", growthRate: 0.04, returnOnCapital: 0.02 },
      bridge,
    });
    const residualIncome = request("residual_income", {
      forecastStartDate: start,
      openingBookEquity: 100,
      periods: [
        {
          endDate: end,
          netIncome: 20,
          payoutRatio: 0.5,
          netIssuance: 0,
          otherEquityChanges: 0,
        },
      ],
      discountRate: 0.1,
      terminal: { kind: "gordon", growthRate: 0.04, returnOnEquity: 0.02 },
    });
    const diagnostics = [fcff, residualIncome].flatMap((input) =>
      evaluateValuation(input, "CNY", new Map(), start).diagnostics.map(
        formatValuationDiagnostic,
      ),
    );
    expect(diagnostics).toContain(
      "终值再投资额超过收益，预测假设需要额外融资。",
    );
    expect(diagnostics).toContain(
      "终值留存收益超过净利润，预测假设需要额外融资。",
    );
  });
});
