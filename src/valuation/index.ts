import { ResearchError } from "../contracts/errors.js";
import {
  AMOUNT_SCALES,
  type CalculationStep,
  type DiscountRateInput,
  type EquityCostInput,
  type EquityBridge,
  type OperatingPeriod,
  type Terminal,
  type ValuationOutput,
  type ValuationRequest,
} from "../contracts/valuation.js";

const PROBABILITY_SUM_TOLERANCE = 1e-10;
const SHARE_COUNT_RELATIVE_TOLERANCE = 1e-12;

function requireCondition(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new ResearchError("INVALID_INPUT", message);
}
function validRate(rate: number): void {
  requireCondition(rate > -1, "Discount rates must exceed -100%.");
}
function probability(value: number): void {
  requireCondition(
    value >= 0 && value <= 1,
    "Probabilities must be between zero and one.",
  );
}
function completeProbabilities(values: number[]): void {
  values.forEach(probability);
  requireCondition(
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) <=
      PROBABILITY_SUM_TOLERANCE,
    "Mutually exclusive exhaustive probabilities must sum to one.",
  );
}
function ownership(value: number): void {
  requireCondition(
    value >= 0 && value <= 1,
    "Ownership must be between zero and one.",
  );
}
function nonnegative(values: number[]): void {
  requireCondition(
    values.every((value) => value >= 0),
    "Costs, claims and gross borrowing/repayment amounts must be nonnegative.",
  );
}
const DAY = 86_400_000;
function dateTime(value: string): number {
  const time = Date.parse(`${value}T00:00:00Z`);
  requireCondition(
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value,
    "Dates must be real YYYY-MM-DD dates.",
  );
  return time;
}
interface Timing {
  fullYears: number;
  fraction: number;
  years: number;
  remainingYears: number;
}
function schedule(
  startDate: string,
  periods: { endDate: string }[],
  valueTime: number,
): Timing[] {
  let start = dateTime(startDate);
  requireCondition(
    start <= valueTime,
    "Forecast start must not be later than value date.",
  );
  requireCondition(
    periods.length > 0,
    "DCF requires at least one explicit period.",
  );
  const result = periods.map((p) => {
    const end = dateTime(p.endDate);
    requireCondition(end > start, "Period end dates must strictly increase.");
    const timing = {
      fraction: Math.max(0, end - Math.max(start, valueTime)) / (end - start),
      fullYears: (end - start) / DAY / 365,
      remainingYears: Math.max(0, end - Math.max(start, valueTime)) / DAY / 365,
      years: (end - valueTime) / DAY / 365,
    };
    start = end;
    return timing;
  });
  requireCondition(
    start > valueTime,
    "Last forecast end date must be later than value date.",
  );
  return result;
}

export function evaluateValuation(
  request: ValuationRequest,
  currency: string,
  dependencies: ReadonlyMap<string, ValuationOutput>,
  valueDate: string,
): ValuationOutput {
  const valueTime = dateTime(valueDate);
  const scale = AMOUNT_SCALES[request.amountUnit];
  const shares = request.shares.value * AMOUNT_SCALES[request.shares.unit];
  requireCondition(shares > 0, "Common shares must be positive.");
  const steps: CalculationStep[] = [];
  const step = (label: string, value: number, unit = currency): number => {
    steps.push({ label, value, unit });
    return value;
  };
  const diagnostics: string[] = [];
  const equityCost = (input: EquityCostInput, label: string): number => {
    if (typeof input === "number") return step(label, input, "ratio");
    const premium = step(
      `${label} beta times equity risk premium`,
      input.beta * input.equityRiskPremium,
      "ratio",
    );
    return step(
      `${label} CAPM`,
      input.riskFreeRate + premium + input.countryRiskPremium,
      "ratio",
    );
  };
  const resolveRate = (input: DiscountRateInput, label: string): number => {
    let rate: number;
    if (typeof input === "number" || input.kind === "capm")
      rate = equityCost(input, label);
    else {
      probability(input.taxRate);
      probability(input.debtWeight);
      const ke = equityCost(input.costOfEquity, `${label} cost of equity`);
      const equityContribution = step(
        `${label} weighted equity cost`,
        ke * (1 - input.debtWeight),
        "ratio",
      );
      const debtContribution = step(
        `${label} weighted after-tax debt cost`,
        input.preTaxCostOfDebt * (1 - input.taxRate) * input.debtWeight,
        "ratio",
      );
      rate = step(
        `${label} WACC`,
        equityContribution + debtContribution,
        "ratio",
      );
    }
    validRate(rate);
    return rate;
  };
  const amount = (label: string, value: number): number =>
    step(label, value * scale);
  const bridge = (value: number, b: EquityBridge): number => {
    nonnegative([
      b.excessCash,
      b.nonOperatingAssets,
      b.debt,
      b.preferredEquity,
      b.minorityInterest,
      b.otherClaims,
    ]);
    return (
      value +
      amount("Excess cash", b.excessCash) +
      amount("Non-operating assets", b.nonOperatingAssets) -
      amount("Debt", b.debt) -
      amount("Preferred equity", b.preferredEquity) -
      amount("Minority interest", b.minorityInterest) -
      amount("Other claims", b.otherClaims)
    );
  };
  const dcf = (
    flows: number[],
    timings: Timing[],
    rateInput: DiscountRateInput,
    terminal: Terminal<object>,
    nextFlow: () => number,
    initialValue = 0,
  ): number => {
    const rate = resolveRate(rateInput, "Discount rate");
    step("Discount rate", rate, "ratio");
    let value = initialValue;
    flows.forEach((cf, index) => {
      const t = timings[index]!;
      if (t.fraction === 0) return;
      step(`Period ${index + 1} remaining fraction`, t.fraction, "ratio");
      step(`Period ${index + 1} discount years`, t.years, "year");
      const cash = amount(
        `Period ${index + 1} remaining cash flow`,
        cf * t.fraction,
      );
      value += step(
        `Period ${index + 1} cash flow present value`,
        cash / (1 + rate) ** t.years,
      );
    });
    let terminalValue: number;
    if (terminal.kind === "finite")
      terminalValue = amount("Terminal recovery", terminal.recovery);
    else {
      requireCondition(
        terminal.growthRate < rate && terminal.growthRate > -1,
        "Perpetual growth must exceed -100% and be below the discount rate.",
      );
      step("Terminal growth rate", terminal.growthRate, "ratio");
      terminalValue =
        amount("Next-period cash flow", nextFlow()) /
        (rate - terminal.growthRate);
      step("Terminal value", terminalValue);
    }
    const terminalPV = step(
      "Terminal present value",
      terminalValue / (1 + rate) ** timings.at(-1)!.years,
    );
    value += terminalPV;
    if (value !== 0)
      step(
        "Terminal present value / total present value",
        terminalPV / value,
        "ratio",
      );
    return value;
  };
  const operatingFlows = (
    periods: OperatingPeriod[],
    opening: number,
  ): number[] =>
    periods.map((p, index) => {
      nonnegative([p.revenue, p.depreciation, p.capex]);
      probability(p.taxRate);
      const ebit =
        amount(`Period ${index + 1} EBIT`, p.revenue * p.operatingMargin) /
        scale;
      const tax =
        amount(`Period ${index + 1} operating tax`, ebit * p.taxRate) / scale;
      amount(`Period ${index + 1} NOPAT`, ebit - tax);
      const change =
        amount(
          `Period ${index + 1} working capital increase`,
          p.workingCapital - opening,
        ) / scale;
      opening = p.workingCapital;
      return (
        amount(
          `Period ${index + 1} FCFF`,
          ebit - tax + p.depreciation - p.capex - change,
        ) / scale
      );
    });
  const annualize = (label: string, total: number, timing: Timing): number => {
    step("Terminal base full period years", timing.fullYears, "year");
    return (
      amount(`Terminal annualized ${label}`, total / timing.fullYears) / scale
    );
  };
  const sustainable = (
    income: number,
    growth: number,
    returnRate: number,
    label: string,
  ): number => {
    requireCondition(
      returnRate > 0,
      "Terminal return on capital/equity must be positive.",
    );
    const reinvestment = step(
      "Terminal reinvestment rate",
      growth / returnRate,
      "ratio",
    );
    if (reinvestment > 1)
      diagnostics.push(
        "Terminal reinvestment exceeds income; the forecast assumes additional financing.",
      );
    const next =
      amount(`Terminal next ${label}`, income * (1 + growth)) / scale;
    amount("Terminal reinvestment", next * reinvestment);
    return (
      amount("Terminal sustainable cash flow", next * (1 - reinvestment)) /
      scale
    );
  };
  const dependency = (id: string, sameShares: boolean): number => {
    const result = dependencies.get(id);
    requireCondition(result !== undefined, `Missing dependency: ${id}`);
    requireCondition(
      result.equityValues.length === 1 && result.perShareValues.length === 1,
      `Dependency ${id} must have a single equity value; ranges cannot be implicitly selected or averaged.`,
    );
    if (sameShares)
      requireCondition(
        Math.abs(result.shares - shares) <=
          Math.max(result.shares, shares) * SHARE_COUNT_RELATIVE_TOLERANCE,
        `Scenario ${id} must use the same common share count.`,
      );
    return result.equityValues[0]!;
  };
  let values: number[];
  switch (request.methodId) {
    case "fcff_dcf":
    case "adjusted_present_value": {
      const i = request.inputs;
      const times = schedule(i.forecastStartDate, i.periods, valueTime);
      const last = i.periods.at(-1)!;
      const rate = "discountRate" in i ? i.discountRate : i.unleveredRate;
      let value = dcf(
        operatingFlows(i.periods, i.openingWorkingCapital),
        times,
        rate,
        i.terminal,
        () =>
          i.terminal.kind === "gordon"
            ? sustainable(
                annualize(
                  "NOPAT",
                  last.revenue * last.operatingMargin * (1 - last.taxRate),
                  times.at(-1)!,
                ),
                i.terminal.growthRate,
                i.terminal.returnOnCapital,
                "NOPAT",
              )
            : 0,
      );
      if ("financingEffects" in i) {
        requireCondition(
          i.financingEffects.length === i.periods.length,
          "APV financing effects must correspond to each explicit operating period.",
        );
        i.financingEffects.forEach((p, index) => {
          const rate = resolveRate(
            p.discountRate,
            `Period ${index + 1} financing discount rate`,
          );
          nonnegative([p.taxShield, p.financingCost, p.distressCost]);
          const t = times[index]!;
          if (t.fraction > 0)
            value += amount(
              `Period ${index + 1} financing present value`,
              ((p.taxShield - p.financingCost - p.distressCost) * t.fraction) /
                (1 + rate) ** t.years,
            );
        });
        const terminal = i.terminalFinancing;
        const financingRate = resolveRate(
          terminal.discountRate,
          "Terminal financing discount rate",
        );
        let terminalValue: number;
        if (terminal.kind === "finite")
          terminalValue = amount("Terminal financing amount", terminal.amount);
        else {
          requireCondition(
            terminal.growthRate > -1 && terminal.growthRate < financingRate,
            "Perpetual growth must exceed -100% and be below the discount rate.",
          );
          terminalValue =
            amount(
              "Terminal next annual financing cash flow",
              terminal.nextCashFlow,
            ) /
            (financingRate - terminal.growthRate);
        }
        step("Terminal financing value", terminalValue);
        value += step(
          "Terminal financing present value",
          terminalValue / (1 + financingRate) ** times.at(-1)!.years,
        );
      }
      values = [bridge(value, i.bridge)];
      break;
    }
    case "fcfe_dcf": {
      const i = request.inputs;
      const times = schedule(i.forecastStartDate, i.periods, valueTime);
      let working = i.openingWorkingCapital;
      const flows = i.periods.map((p, index) => {
        nonnegative([p.depreciation, p.capex, p.newDebt, p.debtRepaid]);
        const change =
          amount(
            `Period ${index + 1} working capital increase`,
            p.workingCapital - working,
          ) / scale;
        working = p.workingCapital;
        return (
          p.netIncome +
          p.depreciation -
          p.capex -
          change +
          p.newDebt -
          p.debtRepaid
        );
      });
      values = [
        dcf(flows, times, i.discountRate, i.terminal, () =>
          i.terminal.kind === "gordon"
            ? sustainable(
                annualize(
                  "net income",
                  i.periods.at(-1)!.netIncome,
                  times.at(-1)!,
                ),
                i.terminal.growthRate,
                i.terminal.returnOnEquity,
                "net income",
              )
            : 0,
        ),
      ];
      break;
    }
    case "dividend_discount": {
      const i = request.inputs;
      nonnegative(i.periods.map((p) => p.dividend));
      const times = schedule(i.forecastStartDate, i.periods, valueTime);
      values = [
        dcf(
          i.periods.map((p) => p.dividend),
          times,
          i.discountRate,
          i.terminal,
          () =>
            i.terminal.kind === "gordon"
              ? annualize(
                  "dividend",
                  i.periods.at(-1)!.dividend,
                  times.at(-1)!,
                ) *
                (1 + i.terminal.growthRate)
              : 0,
        ),
      ];
      break;
    }
    case "regulatory_capital_fcfe": {
      const i = request.inputs;
      const times = schedule(i.forecastStartDate, i.periods, valueTime);
      let capital = i.openingRequiredCapital;
      const flows = i.periods.map((p, index) => {
        const change =
          amount(
            `Period ${index + 1} required capital increase`,
            p.requiredCapital - capital,
          ) / scale;
        capital = p.requiredCapital;
        return p.netIncome - change;
      });
      values = [
        dcf(flows, times, i.discountRate, i.terminal, () => {
          if (i.terminal.kind !== "gordon") return 0;
          const last = i.periods.at(-1)!;
          const next =
            amount(
              "Terminal next net income",
              annualize("net income", last.netIncome, times.at(-1)!) *
                (1 + i.terminal.growthRate),
            ) / scale;
          return (
            next -
            amount(
              "Terminal required capital increase",
              last.requiredCapital * i.terminal.growthRate,
            ) /
              scale
          );
        }),
      ];
      break;
    }
    case "residual_income": {
      const i = request.inputs;
      const rate = resolveRate(i.discountRate, "Discount rate");
      requireCondition(
        i.openingBookEquity > 0,
        "Residual income requires positive opening common book equity.",
      );
      const times = schedule(i.forecastStartDate, i.periods, valueTime);
      let book = i.openingBookEquity;
      const flows = i.periods.map((p, index) => {
        nonnegative([p.payoutRatio, p.netIncome * p.payoutRatio]);
        const dividend =
          amount(`Period ${index + 1} dividends`, p.netIncome * p.payoutRatio) /
          scale;
        const change =
          p.netIncome - dividend + p.netIssuance + p.otherEquityChanges;
        const t = times[index]!;
        book += change * (1 - t.fraction);
        if (t.fraction === 0) return 0;
        const residual =
          (p.netIncome + p.otherEquityChanges) * t.fraction -
          book * ((1 + rate) ** t.remainingYears - 1);
        amount(`Period ${index + 1} opening common book equity`, book);
        book += change * t.fraction;
        amount(`Period ${index + 1} closing common book equity`, book);
        amount(`Period ${index + 1} residual income`, residual);
        // Residual is already calculated for the remaining portion.
        return residual / t.fraction;
      });
      // Book at the valuation date precedes all remaining clean-surplus changes.
      let dateBook = i.openingBookEquity;
      i.periods.forEach((p, index) => {
        dateBook +=
          (p.netIncome * (1 - p.payoutRatio) +
            p.netIssuance +
            p.otherEquityChanges) *
          (1 - times[index]!.fraction);
      });
      values = [
        dcf(
          flows,
          times,
          i.discountRate,
          i.terminal.kind === "finite"
            ? { kind: "finite", recovery: i.terminal.recovery - book }
            : i.terminal,
          () => {
            if (i.terminal.kind !== "gordon") return 0;
            requireCondition(
              i.terminal.returnOnEquity > 0,
              "Terminal return on equity must be positive.",
            );
            const next =
              amount(
                "Terminal next net income",
                i.terminal.returnOnEquity * book,
              ) / scale;
            const retained =
              amount("Terminal retained income", i.terminal.growthRate * book) /
              scale;
            step(
              "Terminal payout ratio",
              1 - i.terminal.growthRate / i.terminal.returnOnEquity,
              "ratio",
            );
            if (i.terminal.growthRate > i.terminal.returnOnEquity)
              diagnostics.push(
                "Terminal retained income exceeds net income; the forecast assumes additional financing.",
              );
            amount("Terminal dividend", next - retained);
            return (
              amount(
                "Terminal residual income",
                (i.terminal.returnOnEquity - rate) * book,
              ) / scale
            );
          },
          amount("Opening common book equity at value date", dateBook),
        ),
      ];
      break;
    }
    case "comparable_multiples": {
      const i = request.inputs;
      const rawMetric =
        "netIncome" in i
          ? i.netIncome
          : "bookEquity" in i
            ? i.bookEquity
            : "revenue" in i
              ? i.revenue
              : "operatingCashFlow" in i
                ? i.operatingCashFlow
                : i.ebitda;
      requireCondition(
        rawMetric > 0 &&
          i.multiples.length > 0 &&
          i.multiples.every((m) => m > 0),
        "Comparable valuation requires a positive economic metric and positive multiples.",
      );
      const metric = amount("Comparable metric", rawMetric);
      values = i.multiples.map((m) => {
        step("Comparable multiple", m, "multiple");
        const value = step("Metric times multiple", metric * m);
        return "bridge" in i ? bridge(value, i.bridge) : value;
      });
      break;
    }
    case "adjusted_net_assets": {
      const i = request.inputs;
      requireCondition(i.assets.length > 0, "NAV requires at least one asset.");
      nonnegative([i.liabilities, i.priorityClaims, i.disposalCosts]);
      values = [
        i.assets.reduce((sum, a) => {
          ownership(a.ownership);
          nonnegative([a.fairValue]);
          return (
            sum +
            amount(
              `${a.label}: attributable fair value`,
              a.fairValue * a.ownership,
            )
          );
        }, 0) -
          amount("Liabilities", i.liabilities) -
          amount("Priority claims", i.priorityClaims) -
          amount("Disposal costs", i.disposalCosts),
      ];
      break;
    }
    case "scenario_dcf_rnpv": {
      const i = request.inputs;
      if (i.kind === "scenarios") {
        completeProbabilities(i.scenarios.map((s) => s.probability));
        const ids = i.scenarios.map((s) => s.calculationId);
        requireCondition(
          new Set(ids).size === ids.length,
          "Scenario dependencies must be unique.",
        );
        values = [
          i.scenarios.reduce(
            (sum, s) =>
              sum +
              step(
                `${s.label}: probability-weighted equity`,
                dependency(s.calculationId, true) * s.probability,
              ),
            0,
          ),
        ];
      } else {
        const rate = resolveRate(i.discountRate, "Discount rate");
        const times = schedule(i.forecastStartDate, i.periods, valueTime);
        let value =
          i.forecastStartDate === valueDate
            ? amount("Initial project cash flow", i.initialCashFlow)
            : 0;
        i.periods.forEach((p, index) => {
          probability(p.probability);
          const t = times[index]!;
          if (t.fraction === 0) return;
          value +=
            amount(
              `Year ${index + 1} probability-weighted cash flow`,
              p.cashFlow * p.probability * t.fraction,
            ) /
            (1 + rate) ** t.years;
        });
        values = [bridge(value, i.bridge)];
      }
      break;
    }
    case "sum_of_parts": {
      const i = request.inputs;
      requireCondition(i.parts.length > 0, "SOTP requires at least one part.");
      requireCondition(
        new Set(i.parts.map((p) => p.calculationId)).size === i.parts.length,
        "SOTP must not count a dependency twice.",
      );
      nonnegative([i.groupAssets, i.groupLiabilities]);
      let headOfficeValue = 0;
      if (i.headOffice.kind === "forecast") {
        const h = i.headOffice;
        nonnegative(h.periods.map((p) => p.cost));
        const times = schedule(h.forecastStartDate, h.periods, valueTime);
        const firstCostStep = steps.length;
        headOfficeValue = dcf(
          h.periods.map((p) => p.cost),
          times,
          h.discountRate,
          h.terminal,
          () =>
            h.terminal.kind === "gordon"
              ? (h.periods.at(-1)!.cost / times.at(-1)!.fullYears) *
                (1 + h.terminal.growthRate)
              : 0,
        );
        for (const costStep of steps.slice(firstCostStep))
          costStep.label = `Head office ${costStep.label}`;
      }
      values = [
        i.parts.reduce((sum, p) => {
          ownership(p.ownership);
          return (
            sum +
            step(
              `${p.label}: attributable common equity`,
              dependency(p.calculationId, false) * p.ownership,
            )
          );
        }, 0) +
          amount("Unallocated group assets", i.groupAssets) -
          amount("Unallocated group liabilities", i.groupLiabilities) -
          step("Head office present value", headOfficeValue),
      ];
      break;
    }
    case "real_options": {
      const i = request.inputs;
      const nodes = new Map(i.nodes.map((n) => [n.id, n]));
      requireCondition(
        nodes.size === i.nodes.length,
        "Decision node IDs must be unique.",
      );
      const root = nodes.get(i.rootNode);
      requireCondition(
        root !== undefined && root.year === 0,
        "The decision root must exist at valuation year zero.",
      );
      const calculated = new Map<string, number>();
      const visit = (id: string): number => {
        const cached = calculated.get(id);
        if (cached !== undefined) return cached;
        const n = nodes.get(id);
        requireCondition(n !== undefined, `Missing decision node ${id}.`);
        const rate = resolveRate(n.discountRate, `${id} discount rate`);
        nonnegative([n.continuationCost]);
        const actions: { label: string; value: number }[] = [];
        if (n.exerciseValue !== null)
          actions.push({ label: "exercise", value: n.exerciseValue * scale });
        if (n.abandonmentValue !== null)
          actions.push({ label: "abandon", value: n.abandonmentValue * scale });
        if (n.transitions.length > 0) {
          completeProbabilities(n.transitions.map((t) => t.probability));
          requireCondition(
            new Set(n.transitions.map((t) => t.nodeId)).size ===
              n.transitions.length,
            "A decision node cannot repeat a successor.",
          );
          const future = n.transitions.reduce((sum, t) => {
            const child = nodes.get(t.nodeId);
            requireCondition(
              child !== undefined && child.year > n.year,
              "Decision transitions must lead to an existing strictly later year; cycles are unsupported.",
            );
            return (
              sum +
              (t.probability * visit(child.id)) /
                (1 + rate) ** (child.year - n.year)
            );
          }, 0);
          actions.push({
            label: "continue",
            value: future - n.continuationCost * scale,
          });
        } else
          requireCondition(
            n.continuationCost === 0,
            "Terminal nodes cannot incur a continuation cost.",
          );
        requireCondition(
          actions.length > 0,
          "Each decision node needs an explicit available action.",
        );
        actions.forEach((a) => step(`${id}: ${a.label} value`, a.value));
        const best = actions.reduce((a, b) => (a.value >= b.value ? a : b));
        calculated.set(id, best.value);
        step(`${id}: optimal ${best.label}`, best.value);
        return best.value;
      };
      const value = visit(root.id);
      requireCondition(
        calculated.size === nodes.size,
        "Every supplied decision node must be reachable from the root.",
      );
      values = [bridge(value, i.bridge)];
      break;
    }
  }
  const perShareValues = values.map((v, index) => {
    step(`Common equity value ${index + 1}`, v);
    return step(
      `Common value per share ${index + 1}`,
      v / shares,
      `${currency}/share`,
    );
  });
  step("Common shares", shares, "share");
  requireCondition(
    [...values, ...perShareValues, ...steps.map((s) => s.value)].every(
      Number.isFinite,
    ),
    "Valuation arithmetic produced a non-finite result.",
  );
  if (values.some((v) => v < 0))
    diagnostics.push(
      "Negative equity residual is not a usable target share price; analyze solvency and allocation of claims.",
    );
  return { equityValues: values, perShareValues, shares, steps, diagnostics };
}
