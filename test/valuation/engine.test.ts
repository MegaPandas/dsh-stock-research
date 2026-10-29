import { describe, expect, it } from "vitest";
import { evaluateValuation } from "../../src/valuation/index.js";
import {
  parseValuationRequest,
  sensitivityRequest,
} from "../../src/services/valuation-inputs.js";
import type {
  ValuationInputs,
  ValuationMethodId,
  ValuationOutput,
  ValuationRequest,
} from "../../src/contracts/valuation.js";
const bridge = {
  excessCash: 0,
  nonOperatingAssets: 0,
  debt: 0,
  preferredEquity: 0,
  minorityInterest: 0,
  otherClaims: 0,
};
const start = "2025-01-01";
const end = "2026-01-01";
const end2 = "2027-01-01";
const finite = { kind: "finite", recovery: 0 } as const;
function request<M extends ValuationMethodId>(
  methodId: M,
  inputs: ValuationInputs[M],
): ValuationRequest {
  return {
    methodId,
    inputs,
    amountUnit: "unit",
    shares: { value: 1, unit: "unit" },
    purpose: "valuation",
    assumptions: ["explicit forecast"],
    provenance: [
      { path: "/inputs", kind: "assumed", basis: "forecast" },
      { path: "/shares", kind: "observed", basis: "register" },
    ],
    sensitivities: [],
  } as ValuationRequest;
}
const run = (
  r: ValuationRequest,
  date = start,
  deps = new Map<string, ValuationOutput>(),
) => evaluateValuation(r, "CNY", deps, date);
const op = (revenue: number, endDate = end) => ({
  endDate,
  revenue,
  operatingMargin: 1,
  taxRate: 0,
  depreciation: 0,
  capex: 0,
  workingCapital: 0,
});
const riPeriod = (netIncome: number, payoutRatio: number, endDate = end) => ({
  endDate,
  netIncome,
  payoutRatio,
  netIssuance: 0,
  otherEquityChanges: 0,
});
describe("valuation v2", () => {
  it("derives FCFF taxes, working capital and sustainable terminal reinvestment", () => {
    const r = request("fcff_dcf", {
      forecastStartDate: start,
      openingWorkingCapital: 10,
      periods: [
        {
          ...op(1000),
          operatingMargin: 0.2,
          taxRate: 0.25,
          depreciation: 20,
          capex: 30,
          workingCapital: 25,
        },
      ],
      discountRate: 0.1,
      terminal: { kind: "gordon", growthRate: 0.03, returnOnCapital: 0.125 },
      bridge: { ...bridge, excessCash: 8, nonOperatingAssets: 2, debt: 10 },
    });
    const out = run(r);
    expect(out.equityValues[0]).toBeCloseTo(
      (125 + (150 * 1.03 * 0.76) / 0.07) / 1.1,
    );
    expect(
      out.steps.find((s) => s.label === "Terminal reinvestment rate")!.value,
    ).toBe(0.24);
    expect(() =>
      parseValuationRequest({
        ...r,
        inputs: {
          ...r.inputs,
          terminal: { kind: "gordon", growthRate: 0.03, nextPeriod: op(100) },
        },
      }),
    ).toThrow();
  });
  it("derives FCFE changes and terminal retention", () => {
    const r = request("fcfe_dcf", {
      forecastStartDate: start,
      openingWorkingCapital: 10,
      periods: [
        {
          endDate: end,
          netIncome: 50,
          depreciation: 10,
          capex: 20,
          workingCapital: 15,
          newDebt: 12,
          debtRepaid: 7,
        },
      ],
      discountRate: 0.1,
      terminal: { kind: "gordon", growthRate: 0.02, returnOnEquity: 0.1 },
    });
    expect(run(r).equityValues[0]).toBeCloseTo((40 + (51 * 0.8) / 0.08) / 1.1);
  });
  it("derives DDM terminal dividends", () => {
    expect(
      run(
        request("dividend_discount", {
          forecastStartDate: start,
          periods: [{ endDate: end, dividend: 12 }],
          discountRate: 0.1,
          terminal: { kind: "gordon", growthRate: 0 },
        }),
      ).equityValues[0],
    ).toBeCloseTo(120);
  });
  it("derives regulatory capital changes and terminal capital needs", () => {
    expect(
      run(
        request("regulatory_capital_fcfe", {
          forecastStartDate: start,
          openingRequiredCapital: 100,
          periods: [{ endDate: end, netIncome: 30, requiredCapital: 108 }],
          discountRate: 0.1,
          terminal: { kind: "gordon", growthRate: 0.02 },
        }),
      ).equityValues[0],
    ).toBeCloseTo((22 + (30.6 - 2.16) / 0.08) / 1.1);
  });
  it("derives RI from clean surplus and recalculates terminal RI with equity cost", () => {
    const r = request("residual_income", {
      forecastStartDate: start,
      openingBookEquity: 362500,
      periods: [riPeriod(47125, 1)],
      discountRate: 0.09,
      terminal: { kind: "gordon", growthRate: 0, returnOnEquity: 0.13 },
    });
    const out = run(r);
    expect(
      out.steps.find((s) => s.label === "Terminal residual income")!.value,
    ).toBeCloseTo(14500);
    expect(out.equityValues[0]).toBeCloseTo(
      362500 + 14500 / 1.09 + 14500 / 0.09 / 1.09,
    );
    const changed = run(sensitivityRequest(r, "/inputs/discountRate", 0.1));
    expect(
      changed.steps.find((s) => s.label === "Terminal residual income")!.value,
    ).toBeCloseTo(10875);
  });
  it("rolls RI book through past and overlapping periods before charging remaining capital", () => {
    const r = request("residual_income", {
      forecastStartDate: start,
      openingBookEquity: 100,
      periods: [riPeriod(20, 0.25), riPeriod(30, 0.5, end2)],
      discountRate: 0.1,
      terminal: finite,
    });
    const date = "2026-07-01";
    const remaining = 184 / 365;

    expect(run(r, date).equityValues[0]).toBeCloseTo(
      (15 * remaining) / 1.1 ** remaining,
    );
    expect(run(r).equityValues[0]).toBeCloseTo(5 / 1.1 + 15 / 1.21);
  });
  it("values finite RI actual recovery consistently with dividend cash flows", () => {
    const ri = run(
      request("residual_income", {
        forecastStartDate: start,
        openingBookEquity: 100,
        periods: [riPeriod(0, 0)],
        discountRate: 0.1,
        terminal: { kind: "finite", recovery: 100 },
      }),
    );
    const ddm = run(
      request("dividend_discount", {
        forecastStartDate: start,
        periods: [{ endDate: end, dividend: 0 }],
        discountRate: 0.1,
        terminal: { kind: "finite", recovery: 100 },
      }),
    );
    expect(ri.equityValues[0]).toBeCloseTo(100 / 1.1);
    expect(ri.equityValues).toEqual(ddm.equityValues);
  });
  it("includes OCI in comprehensive earnings but excludes shareholder issuance", () => {
    const make = (oci: number, issuance: number) =>
      run(
        request("residual_income", {
          forecastStartDate: start,
          openingBookEquity: 100,
          periods: [
            {
              ...riPeriod(10, 1),
              otherEquityChanges: oci,
              netIssuance: issuance,
            },
          ],
          discountRate: 0.1,
          terminal: { kind: "gordon", growthRate: 0, returnOnEquity: 0.1 },
        }),
      );
    const oci = make(10, 0);
    expect(oci.equityValues[0]).toBeCloseTo((10 + 110) / 1.1);
    const ddm = run(
      request("dividend_discount", {
        forecastStartDate: start,
        periods: [{ endDate: end, dividend: 10 }],
        discountRate: 0.1,
        terminal: { kind: "finite", recovery: 110 },
      }),
    );
    expect(oci.equityValues[0]).toBeCloseTo(ddm.equityValues[0]!);
    const issuance = make(0, 10);
    expect(issuance.equityValues[0]).toBeCloseTo((10 - 10 + 110) / 1.1);
    expect(
      issuance.steps.find(
        (s) => s.label === "Period 1 closing common book equity",
      )!.value,
    ).toBe(110);
    expect(
      issuance.steps.find((s) => s.label === "Period 1 residual income")!.value,
    ).toBeCloseTo(0);
  });
  it("discounts APV operating and financing amounts at their respective rates", () => {
    const r = request("adjusted_present_value", {
      forecastStartDate: start,
      openingWorkingCapital: 0,
      periods: [op(110), op(121, end2)],
      unleveredRate: 0.1,
      terminal: finite,
      financingEffects: [
        { taxShield: 12, financingCost: 1, distressCost: 0, discountRate: 0.1 },
        {
          taxShield: 25,
          financingCost: 0,
          distressCost: 0,
          discountRate: 0.25,
        },
      ],
      terminalFinancing: { kind: "finite", amount: -3, discountRate: 0.1 },
      bridge,
    });
    expect(run(r).equityValues[0]).toBeCloseTo(226 - 3 / 1.21);
    const fraction = 184 / 365;
    expect(run(r, "2026-07-01").equityValues[0]).toBeCloseTo(
      (121 * fraction) / 1.1 ** fraction +
        (25 * fraction) / 1.25 ** fraction -
        3 / 1.1 ** fraction,
    );
  });
  it("annualizes half-year terminal income and dividends while preserving capital balances", () => {
    const halfEnd = "2025-07-02"; // 182 days after forecast start.
    const years = 182 / 365;
    const discount = 1.1 ** years;
    const terminal = { kind: "gordon", growthRate: 0.02 } as const;
    const operating = run(
      request("fcff_dcf", {
        forecastStartDate: start,
        openingWorkingCapital: 0,
        periods: [op(50, halfEnd)],
        discountRate: 0.1,
        terminal: { ...terminal, returnOnCapital: 0.1 },
        bridge,
      }),
    );
    expect(operating.equityValues[0]).toBeCloseTo(
      (50 + ((50 / years) * 1.02 * 0.8) / 0.08) / discount,
    );
    expect(
      run(
        request("fcfe_dcf", {
          forecastStartDate: start,
          openingWorkingCapital: 0,
          periods: [
            {
              endDate: halfEnd,
              netIncome: 50,
              depreciation: 0,
              capex: 0,
              workingCapital: 0,
              newDebt: 0,
              debtRepaid: 0,
            },
          ],
          discountRate: 0.1,
          terminal: { ...terminal, returnOnEquity: 0.1 },
        }),
      ).equityValues[0],
    ).toBeCloseTo((50 + ((50 / years) * 1.02 * 0.8) / 0.08) / discount);
    expect(
      run(
        request("dividend_discount", {
          forecastStartDate: start,
          periods: [{ endDate: halfEnd, dividend: 50 }],
          discountRate: 0.1,
          terminal,
        }),
      ).equityValues[0],
    ).toBeCloseTo((50 + ((50 / years) * 1.02) / 0.08) / discount);
    expect(
      run(
        request("regulatory_capital_fcfe", {
          forecastStartDate: start,
          openingRequiredCapital: 100,
          periods: [{ endDate: halfEnd, netIncome: 50, requiredCapital: 110 }],
          discountRate: 0.1,
          terminal,
        }),
      ).equityValues[0],
    ).toBeCloseTo((40 + ((50 / years) * 1.02 - 110 * 0.02) / 0.08) / discount);
  });
  it("calculates and discounts signed APV perpetual financing terminal cash flows", () => {
    const r = request("adjusted_present_value", {
      forecastStartDate: start,
      openingWorkingCapital: 0,
      periods: [op(100)],
      unleveredRate: 0.1,
      terminal: finite,
      financingEffects: [
        { taxShield: 0, financingCost: 0, distressCost: 0, discountRate: 0.1 },
      ],
      terminalFinancing: {
        kind: "gordon",
        nextCashFlow: -2,
        growthRate: 0.02,
        discountRate: 0.12,
      },
      bridge,
    });
    expect(run(r).equityValues[0]).toBeCloseTo(100 / 1.1 - 20 / 1.12);
    expect(parseValuationRequest(r)).toEqual(r);
  });
  it("binds all comparable metrics and treats PCF as direct common equity", () => {
    const cases: ValuationInputs["comparable_multiples"][] = [
      { multipleType: "pe", netIncome: 9, multiples: [15, 25] },
      { multipleType: "pb", bookEquity: 9, multiples: [15] },
      { multipleType: "ps", revenue: 9, multiples: [15] },
      { multipleType: "pcf", operatingCashFlow: 9, multiples: [15] },
      { multipleType: "ev_ebitda", ebitda: 9, multiples: [15], bridge },
      {
        multipleType: "ev_revenue",
        revenue: 9,
        multiples: [15],
        bridge: { ...bridge, excessCash: 5, debt: 10 },
      },
    ];
    cases.forEach((inputs, index) =>
      expect(run(request("comparable_multiples", inputs)).equityValues[0]).toBe(
        index === 5 ? 130 : 135,
      ),
    );
    const r = request("comparable_multiples", cases[0]!);
    r.amountUnit = "hundred_million";
    r.shares = { value: 100, unit: "million" };
    expect(run(r).perShareValues).toEqual([135, 225]);
    expect(() =>
      parseValuationRequest(
        request("comparable_multiples", {
          multipleType: "ev_revenue",
          operatingCashFlow: 9,
          multiples: [15],
          bridge,
        } as unknown as ValuationInputs["comparable_multiples"]),
      ),
    ).toThrow();
    expect(() =>
      parseValuationRequest({
        ...request("comparable_multiples", cases[3]!),
        inputs: { ...cases[3], bridge },
      }),
    ).toThrow();
  });
  it("aggregates NAV, SOTP and scenario equity without duplicate claims", () => {
    const nav = run(
      request("adjusted_net_assets", {
        assets: [{ label: "asset", fairValue: 400, ownership: 0.5 }],
        liabilities: 50,
        priorityClaims: 10,
        disposalCosts: 5,
      }),
    );
    expect(nav.equityValues).toEqual([135]);
    const deps = new Map([["nav", nav]]);
    expect(
      run(
        request("sum_of_parts", {
          parts: [{ label: "part", ownership: 0.5, calculationId: "nav" }],
          groupAssets: 10,
          groupLiabilities: 5,
          headOffice: {
            kind: "forecast",
            forecastStartDate: start,
            periods: [{ endDate: end, cost: 2.2 }],
            discountRate: 0.1,
            terminal: finite,
          },
        }),
        start,
        deps,
      ).equityValues,
    ).toEqual([70.5]);
    expect(
      run(
        request("scenario_dcf_rnpv", {
          kind: "scenarios",
          scenarios: [{ label: "nav", probability: 1, calculationId: "nav" }],
        }),
        start,
        deps,
      ).equityValues,
    ).toEqual([135]);
    nav.equityValues.push(140);
    expect(() =>
      run(
        request("scenario_dcf_rnpv", {
          kind: "scenarios",
          scenarios: [{ label: "nav", probability: 1, calculationId: "nav" }],
        }),
        start,
        deps,
      ),
    ).toThrow(/single equity/);
  });
  it("weights project flows, excludes past costs and prorates overlapping flows", () => {
    const r = request("scenario_dcf_rnpv", {
      kind: "project",
      forecastStartDate: start,
      initialCashFlow: -10,
      periods: [
        { endDate: end, cashFlow: -5, probability: 0.5 },
        { endDate: end2, cashFlow: 100, probability: 0.4 },
      ],
      discountRate: 0.1,
      bridge,
    });
    expect(run(r).equityValues[0]).toBeCloseTo(-10 - 2.5 / 1.1 + 40 / 1.21);
    expect(run(r, end).equityValues[0]).toBeCloseTo(40 / 1.1);
  });
  it("optimizes the explicit year real option tree", () => {
    expect(
      run(
        request("real_options", {
          rootNode: "root",
          probabilityMeasure: "risk_neutral",
          bridge,
          nodes: [
            {
              id: "root",
              year: 0,
              exerciseValue: 30,
              abandonmentValue: 0,
              continuationCost: 10,
              discountRate: 0.1,
              transitions: [
                { nodeId: "up", probability: 0.5 },
                { nodeId: "down", probability: 0.5 },
              ],
            },
            {
              id: "up",
              year: 2,
              exerciseValue: 121,
              abandonmentValue: 10,
              continuationCost: 0,
              discountRate: 0.1,
              transitions: [],
            },
            {
              id: "down",
              year: 2,
              exerciseValue: -20,
              abandonmentValue: 0,
              continuationCost: 0,
              discountRate: 0.1,
              transitions: [],
            },
          ],
        }),
      ).equityValues[0],
    ).toBeCloseTo(40);
  });
  it("reuses an unchanged schedule at later dates using ACT/365F", () => {
    const r = request("dividend_discount", {
      forecastStartDate: start,
      periods: [
        { endDate: end, dividend: 100 },
        { endDate: end2, dividend: 200 },
      ],
      discountRate: 0.1,
      terminal: finite,
    });
    expect(run(r).equityValues[0]).toBeCloseTo(100 / 1.1 + 200 / 1.21);
    expect(run(r, "2026-07-01").equityValues[0]).toBeCloseTo(
      (200 * 184) / 365 / 1.1 ** (184 / 365),
    );
    expect(r.inputs).toEqual({
      forecastStartDate: start,
      periods: [
        { endDate: end, dividend: 100 },
        { endDate: end2, dividend: 200 },
      ],
      discountRate: 0.1,
      terminal: finite,
    });
  });
  it("preserves signed equity residuals and dependency semantics with diagnostics", () => {
    const negative = run(
      request("fcff_dcf", {
        forecastStartDate: start,
        openingWorkingCapital: 0,
        periods: [op(1)],
        discountRate: 0,
        terminal: finite,
        bridge: { ...bridge, debt: 10 },
      }),
    );
    expect(negative.equityValues).toEqual([-9]);
    expect(negative.perShareValues).toEqual([-9]);
    expect(negative.diagnostics.join()).toMatch(/not a usable target/);
    expect(
      run(
        request("sum_of_parts", {
          parts: [
            { label: "negative", ownership: 1, calculationId: "negative" },
          ],
          groupAssets: 0,
          groupLiabilities: 0,
          headOffice: { kind: "none" },
        }),
        start,
        new Map([["negative", negative]]),
      ).equityValues,
    ).toEqual([-9]);
  });
  it("keeps over-income terminal reinvestment as an explicit financing diagnostic", () => {
    const out = run(
      request("fcff_dcf", {
        forecastStartDate: start,
        openingWorkingCapital: 0,
        periods: [op(100)],
        discountRate: 0.1,
        terminal: { kind: "gordon", growthRate: 0.04, returnOnCapital: 0.02 },
        bridge,
      }),
    );
    expect(out.equityValues[0]).toBeCloseTo((100 - 104 / 0.06) / 1.1);
    expect(out.diagnostics.join()).toMatch(/additional financing/);
  });
  it("allows distributions over income and zero payout in loss periods", () => {
    const out = run(
      request("residual_income", {
        forecastStartDate: start,
        openingBookEquity: 100,
        periods: [riPeriod(10, 2), riPeriod(-5, 0, end2)],
        discountRate: 0.1,
        terminal: finite,
      }),
    );
    expect(out.equityValues[0]).toBeCloseTo(20 / 1.1);
    expect(
      out.steps.find((s) => s.label === "Period 1 closing common book equity")!
        .value,
    ).toBe(90);
    expect(() =>
      run(
        request("residual_income", {
          forecastStartDate: start,
          openingBookEquity: 100,
          periods: [riPeriod(-5, 1)],
          discountRate: 0.1,
          terminal: finite,
        }),
      ),
    ).toThrow(/nonnegative/);
  });
  it("calculates CAPM from explicit inputs and recomputes a premium sensitivity", () => {
    const r = request("dividend_discount", {
      forecastStartDate: start,
      periods: [{ endDate: end, dividend: 110 }],
      discountRate: {
        kind: "capm",
        riskFreeRate: 0.02,
        equityRiskPremium: 0.05,
        beta: 1.4,
        countryRiskPremium: 0.01,
      },
      terminal: finite,
    });
    expect(run(r).equityValues[0]).toBeCloseTo(100);
    expect(
      run(sensitivityRequest(r, "/inputs/discountRate/equityRiskPremium", 0.06))
        .equityValues[0],
    ).toBeCloseTo(110 / 1.114);
    expect(parseValuationRequest(r)).toEqual(r);
  });
  it("calculates WACC including CAPM equity cost and recomputes debt-weight sensitivity", () => {
    const r = request("fcff_dcf", {
      forecastStartDate: start,
      openingWorkingCapital: 0,
      periods: [op(100)],
      discountRate: {
        kind: "wacc",
        costOfEquity: {
          kind: "capm",
          riskFreeRate: 0.02,
          equityRiskPremium: 0.05,
          beta: 1.4,
          countryRiskPremium: 0.01,
        },
        preTaxCostOfDebt: 0.06,
        taxRate: 0.25,
        debtWeight: 0.4,
      },
      terminal: finite,
      bridge,
    });
    expect(run(r).equityValues[0]).toBeCloseTo(100 / 1.078);
    expect(
      run(sensitivityRequest(r, "/inputs/discountRate/debtWeight", 0.5))
        .equityValues[0],
    ).toBeCloseTo(100 / 1.0725);
    expect(parseValuationRequest(r)).toEqual(r);
    expect(() =>
      run(sensitivityRequest(r, "/inputs/discountRate/debtWeight", 1.1)),
    ).toThrow();
  });
  it("rejects invalid dates, growth, terminal capital returns, probabilities and arithmetic", () => {
    const make = (endDate = end) =>
      request("dividend_discount", {
        forecastStartDate: start,
        periods: [{ endDate, dividend: 10 }],
        discountRate: 0.1,
        terminal: finite,
      });
    for (const date of ["2025-02-30", start, "2026-1-01"])
      expect(() => run(make(date))).toThrow(/date/i);
    expect(() => run(make(), "2024-12-31")).toThrow(/start/);
    expect(() => run(make(), end)).toThrow(/Last forecast/);
    expect(() =>
      run(
        request("dividend_discount", {
          forecastStartDate: start,
          periods: [{ endDate: end, dividend: 1 }],
          discountRate: 0.1,
          terminal: { kind: "gordon", growthRate: 0.1 },
        }),
      ),
    ).toThrow(/growth/);
    expect(() =>
      run(
        request("fcff_dcf", {
          forecastStartDate: start,
          openingWorkingCapital: 0,
          periods: [op(1)],
          discountRate: 0.1,
          terminal: { kind: "gordon", growthRate: 0.02, returnOnCapital: 0 },
          bridge,
        }),
      ),
    ).toThrow(/positive/);
    expect(() =>
      run(
        request("scenario_dcf_rnpv", {
          kind: "scenarios",
          scenarios: [
            { label: "missing", probability: 0.5, calculationId: "missing" },
          ],
        }),
      ),
    ).toThrow(/sum to one/);
    expect(() =>
      run(
        request("comparable_multiples", {
          multipleType: "pe",
          netIncome: Infinity,
          multiples: [2],
        }),
      ),
    ).toThrow(/non-finite/);
  });
});
